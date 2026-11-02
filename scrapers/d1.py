"""Writes scraped records to Cloudflare D1 over the REST API (used from GitHub Actions)."""

from __future__ import annotations

import json
import os
from dataclasses import asdict
from datetime import UTC, datetime

import requests

from .base import REPORT_LABELS, STATUS_RANKS, ParseResult

API = "https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{db}/query"

# Statements per request. D1 documents no batch cap, but each request must finish in 30s.
BATCH_SIZE = 100

# The WHERE on each DO UPDATE skips rows that haven't changed, so re-scraping the same
# report costs no free-tier row writes. Sources that omit a field (the archive has no
# positions) leave the stored value alone.
INJURY_SQL = """
INSERT INTO injuries (conference, team, player, number, position, opponent,
                      game_date, week, injury, source_url, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (conference, team, player, game_date) DO UPDATE SET
    number = coalesce(excluded.number, number),
    position = coalesce(excluded.position, position),
    opponent = coalesce(excluded.opponent, opponent),
    week = coalesce(excluded.week, week),
    injury = coalesce(excluded.injury, injury),
    source_url = excluded.source_url,
    updated_at = excluded.updated_at
WHERE (excluded.number IS NOT NULL AND number IS NOT excluded.number)
   OR (excluded.position IS NOT NULL AND position IS NOT excluded.position)
   OR (excluded.opponent IS NOT NULL AND opponent IS NOT excluded.opponent)
   OR (excluded.week IS NOT NULL AND week IS NOT excluded.week)
   OR (excluded.injury IS NOT NULL AND injury IS NOT excluded.injury)
   OR source_url IS NOT excluded.source_url
"""

# Only attaches to an injury row that already exists, so an Available-only record updates a
# tracked player without creating a new one.
STATUS_SQL = """
INSERT INTO status_updates (injury_id, seq, label, status, status_raw, status_rank)
SELECT id, ?, ?, ?, ?, ? FROM injuries
WHERE conference = ? AND team = ? AND player = ? AND game_date = ?
ON CONFLICT (injury_id, label) DO UPDATE SET
    status = excluded.status,
    status_raw = excluded.status_raw,
    status_rank = excluded.status_rank
WHERE status IS NOT excluded.status OR status_raw IS NOT excluded.status_raw
"""

TEAM_REPORT_SQL = """
INSERT INTO team_reports (conference, team, opponent, game_date, label, seq, released_at, first_seen_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (conference, team, game_date, label) DO UPDATE SET
    opponent = coalesce(excluded.opponent, opponent),
    released_at = coalesce(excluded.released_at, released_at)
WHERE (excluded.opponent IS NOT NULL AND opponent IS NOT excluded.opponent)
   OR (excluded.released_at IS NOT NULL AND released_at IS NOT excluded.released_at)
"""

# A tracked player missing from their team's released report is presumed Available for that
# label (status_raw NULL marks it as presumed). Runs after the report's listed players, and an
# explicit listing in a later scrape overwrites it via STATUS_SQL.
PRESUMED_AVAILABLE_SQL = """
INSERT INTO status_updates (injury_id, seq, label, status, status_raw, status_rank)
SELECT id, ?, ?, 'Available', NULL, ? FROM injuries
WHERE conference = ? AND team = ? AND game_date = ?
ON CONFLICT (injury_id, label) DO NOTHING
"""


# Fills position/number on rows that lack them (archive backfills) from the current roster.
# One statement per ROSTER_CHUNK players, passed as JSON; only rows actually filled are written.
ROSTER_SQL = """
UPDATE injuries SET
    position = coalesce(injuries.position, r.value ->> '$.position'),
    number = coalesce(injuries.number, r.value ->> '$.number')
FROM json_each(?) AS r
WHERE injuries.conference = ?
  AND injuries.team = r.value ->> '$.team'
  AND injuries.player = r.value ->> '$.player'
  AND ((injuries.position IS NULL AND r.value ->> '$.position' IS NOT NULL)
    OR (injuries.number IS NULL AND r.value ->> '$.number' IS NOT NULL))
"""

ROSTER_CHUNK = 250  # keeps each JSON parameter around 20 KB


def configured() -> bool:
    return all(os.environ.get(k) for k in ("CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID", "CLOUDFLARE_API_TOKEN"))


def _post(body: dict) -> list[dict]:
    url = API.format(account=os.environ["CLOUDFLARE_ACCOUNT_ID"], db=os.environ["D1_DATABASE_ID"])
    res = requests.post(
        url,
        json=body,
        headers={"Authorization": f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}"},
        timeout=30,
    )
    res.raise_for_status()
    data = res.json()
    if not data.get("success"):
        raise RuntimeError(f"D1 query failed: {data.get('errors')}")
    return data["result"]


def query(sql: str, params: list | None = None) -> list[dict]:
    return _post({"sql": sql, "params": params or []})


def batch(statements: list[tuple[str, list]]) -> list[dict]:
    """Runs statements in order as one transaction; returns one result per statement."""
    return _post({"batch": [{"sql": sql, "params": params} for sql, params in statements]})


def seq(label: str) -> int:
    return REPORT_LABELS.index(label) + 1  # validate() guarantees the label is known


def upsert(result: ParseResult) -> int:
    """Writes a scrape in batches; returns D1's rows_written total (free tier: 100k/day)."""
    now = datetime.now(UTC).isoformat()
    groups: list[list[tuple[str, list]]] = []
    for r in result.records:
        # A record's injury row and its status rows stay in one batch, since the status
        # inserts look up the injury row and a failed batch rolls back as a unit.
        group = []
        if r.is_injury:
            group.append((INJURY_SQL, [
                r.conference, r.team, r.player, r.number, r.position, r.opponent,
                r.game_date, r.week, r.injury, r.source_url, now,
            ]))
        for u in r.updates:
            group.append((STATUS_SQL, [
                seq(u.label), u.label, u.status, u.status_raw, u.rank,
                r.conference, r.team, r.player, r.game_date,
            ]))
        groups.append(group)
    if result.team_reports:  # every roster comes from a released team report
        conference = result.team_reports[0].conference
        for i in range(0, len(result.roster), ROSTER_CHUNK):
            chunk = [asdict(e) for e in result.roster[i:i + ROSTER_CHUNK]]
            groups.append([(ROSTER_SQL, [json.dumps(chunk), conference])])
    # Team reports go last so presumed-Available never runs ahead of the players a report lists.
    for t in result.team_reports:
        groups.append([
            (TEAM_REPORT_SQL, [t.conference, t.team, t.opponent, t.game_date, t.label, seq(t.label), t.released_at, now]),
            (PRESUMED_AVAILABLE_SQL, [seq(t.label), t.label, STATUS_RANKS["Available"], t.conference, t.team, t.game_date]),
        ])

    chunks: list[list[tuple[str, list]]] = [[]]
    for group in groups:
        if chunks[-1] and len(chunks[-1]) + len(group) > BATCH_SIZE:
            chunks.append([])
        chunks[-1].extend(group)

    written = 0
    for chunk in filter(None, chunks):
        written += sum(r["meta"]["rows_written"] for r in batch(chunk))
    return written
