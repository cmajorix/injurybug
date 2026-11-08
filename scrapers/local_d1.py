"""python -m scrapers.local_d1  — loads data/*.json into the local D1 that `wrangler dev` serves.

Runs d1.upsert's SQL against the local SQLite file, so `npm run db:migrate:local` in api/ must
have created it first. Archive backfills load before current reports, as the scheduled runs do.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

from . import d1
from .base import DATA_DIR, InjuryRecord, ParseResult, StatusUpdate, TeamReport

LOCAL_D1 = Path(__file__).resolve().parent.parent / "api" / ".wrangler" / "state" / "v3" / "d1"


def load(path: Path) -> ParseResult:
    raw = json.loads(path.read_text(encoding="utf-8"))
    records = [
        InjuryRecord(**{**r, "updates": [StatusUpdate(**u) for u in r["updates"]]}) for r in raw["records"]
    ]
    return ParseResult(
        records=records,
        team_reports=[TeamReport(**t) for t in raw["team_reports"]],
        from_archive=path.name.endswith(".backfill.json"),
    )


def main() -> int:
    dbs = [p for p in LOCAL_D1.glob("*/*.sqlite") if p.name != "metadata.sqlite"]
    if len(dbs) != 1:
        print(f"expected one local D1 database under {LOCAL_D1}, found {len(dbs)}", file=sys.stderr)
        return 1
    conn = sqlite3.connect(dbs[0])

    def batch(statements: list[tuple[str, list]]) -> list[dict]:
        with conn:
            return [{"meta": {"rows_written": conn.execute(sql, params).rowcount}} for sql, params in statements]

    d1.batch = batch
    files = sorted(DATA_DIR.glob("*.json"), key=lambda p: (not p.name.endswith(".backfill.json"), p.name))
    for path in files:
        print(f"{path.name}: {d1.upsert(load(path))} rows written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
