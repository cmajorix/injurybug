"""Shared scraper contract. Each conference source subclasses BaseScraper."""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# Canonical statuses, least to most severe. Ranks are spaced so one can be inserted later.
STATUS_RANKS = {
    "Available": 10,
    "Probable": 20,
    "Game Time Decision": 30,
    "Questionable": 40,
    "Doubtful": 50,
    "Out (1st Half)": 60,
    "Out": 70,
    "Out for Season": 80,
}

# Source spellings -> canonical status. Matched case-insensitively with whitespace collapsed,
# so only genuinely different wordings need an entry.
STATUS_ALIASES = {
    "Out - (1st Half)": "Out (1st Half)",
    "Out (Season)": "Out for Season",
}

# Reports within a game week, in release order.
REPORT_LABELS = ("Initial", "Update 1", "Update 2", "Game Day")


def _status_key(status: str) -> str:
    return " ".join(status.split()).casefold()


_STATUS_LOOKUP = {_status_key(s): s for s in STATUS_RANKS} | {
    _status_key(alias): canonical for alias, canonical in STATUS_ALIASES.items()
}


def normalize_status(raw: str) -> str | None:
    """Canonical status for a source string, or None if it isn't recognized."""
    return _STATUS_LOOKUP.get(_status_key(raw))


@dataclass
class StatusUpdate:
    label: str  # one of REPORT_LABELS
    status: str  # canonical (STATUS_RANKS) after normalize(); the source string before
    status_raw: str | None = None  # source wording; defaults to `status` as parsed

    @property
    def rank(self) -> int | None:
        return STATUS_RANKS.get(self.status)


@dataclass
class InjuryRecord:
    """Normalized row, independent of conference source format."""

    conference: str
    team: str
    player: str
    number: str | None
    opponent: str | None
    game_date: str | None  # ISO 8601 date
    week: int | None = None
    updates: list[StatusUpdate] = field(default_factory=list)
    position: str | None = None
    injury: str | None = None  # body part / description, if the source publishes it
    source_url: str | None = None

    @property
    def current_status(self) -> str | None:
        return self.updates[-1].status if self.updates else None

    @property
    def is_injury(self) -> bool:
        """False when every update is Available: worth recording only for a player already tracked."""
        return any(u.status != "Available" for u in self.updates)


@dataclass
class TeamReport:
    """A team appeared in a released report, even if it listed no injured players.

    Absence of a TeamReport means no conference report (bye, non-conference game, or not out yet);
    a player missing from a team that *does* have one is presumed available.
    """

    conference: str
    team: str
    opponent: str | None
    game_date: str
    label: str
    released_at: str | None = None  # ISO 8601 UTC, when the source gives it


@dataclass
class ParseResult:
    records: list[InjuryRecord] = field(default_factory=list)
    team_reports: list[TeamReport] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class ValidationError(Exception):
    pass


class BaseScraper(ABC):
    conference: str
    source_url: str
    supports_backfill = False

    def run(self, backfill: bool = False) -> ParseResult:
        if backfill:
            result = self.parse_backfill(self.fetch_backfill())
        else:
            result = self.parse(self.fetch())
        self.normalize(result)
        self.validate(result)
        for warning in result.warnings:
            print(f"{self.conference}: warning: {warning}")
        self.write(result, suffix=".backfill" if backfill else "")
        self.store(result)
        return result

    @abstractmethod
    def fetch(self) -> Any:
        """Retrieve the current report's raw payload (HTML, JSON, PDF bytes...)."""

    @abstractmethod
    def parse(self, raw: Any) -> ParseResult:
        """Turn the raw payload into records, with source status strings left as-is."""

    def fetch_backfill(self) -> Any:
        """Retrieve past weeks, for sources that publish them separately (supports_backfill)."""
        raise NotImplementedError

    def parse_backfill(self, raw: Any) -> ParseResult:
        raise NotImplementedError

    def normalize(self, result: ParseResult) -> None:
        for record in result.records:
            for update in record.updates:
                if update.status_raw is None:
                    update.status_raw = update.status
                update.status = normalize_status(update.status) or update.status

    def validate(self, result: ParseResult) -> None:
        """Raises on anything that means the source format changed; an empty result is fine
        (non-conference weeks, byes and the off-season all legitimately return nothing)."""
        problems = []

        unknown_statuses = Counter(
            u.status for r in result.records for u in r.updates if u.status not in STATUS_RANKS
        )
        if unknown_statuses:
            problems.append(f"unmapped statuses (add to STATUS_ALIASES): {dict(unknown_statuses)}")

        labels = [u.label for r in result.records for u in r.updates] + [t.label for t in result.team_reports]
        unknown_labels = Counter(label for label in labels if label not in REPORT_LABELS)
        if unknown_labels:
            problems.append(f"unknown report labels (add to REPORT_LABELS or the source's map): {dict(unknown_labels)}")

        undated = sum(1 for r in result.records if not r.game_date)
        if undated:
            problems.append(f"{undated} records without a game_date")

        record_keys = Counter((r.team, r.player, r.game_date) for r in result.records)
        if dupes := [k for k, n in record_keys.items() if n > 1]:
            problems.append(f"duplicate records: {dupes[:5]}")

        report_keys = Counter((t.team, t.game_date, t.label) for t in result.team_reports)
        if dupes := [k for k, n in report_keys.items() if n > 1]:
            problems.append(f"duplicate team reports: {dupes[:5]}")

        if problems:
            raise ValidationError(f"{self.conference}: " + "; ".join(problems))

    def store(self, result: ParseResult) -> None:
        from . import d1  # local import: d1 imports from this module

        if d1.configured():
            print(f"{self.conference}: {d1.upsert(result)} D1 rows written")

    def write(self, result: ParseResult, suffix: str = "") -> None:
        # Sorted and timestamp-free, so a run that finds nothing new leaves no git diff.
        DATA_DIR.mkdir(exist_ok=True)
        out = {
            "conference": self.conference,
            "source_url": self.source_url,
            "records": sorted(
                (asdict(r) for r in result.records),
                key=lambda r: (r["game_date"] or "", r["team"], r["player"]),
            ),
            "team_reports": sorted(
                (asdict(t) for t in result.team_reports),
                key=lambda t: (t["game_date"], t["team"], REPORT_LABELS.index(t["label"])),
            ),
        }
        path = DATA_DIR / f"{self.conference}{suffix}.json"
        path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
