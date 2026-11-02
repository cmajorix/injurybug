import re
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any
from zoneinfo import ZoneInfo

import requests

from .base import (
    REPORT_LABELS,
    BaseScraper,
    InjuryRecord,
    ParseResult,
    RosterEntry,
    StatusUpdate,
    TeamReport,
)

API = "https://app.hdintelligence.com/api"

# "DB #0 Alijah Jones" -> position, number, name; number is sometimes missing ("S CJ Christian")
NAME_RE = re.compile(r"^(?P<position>\S+)\s+(?:#(?P<number>\d+)\s+)?(?P<player>.+)$")

# More unparsed names than this means the name format changed, not a one-off.
MAX_UNPARSED_NAMES = 0.05

# conferenceTimeZone -> zone used to turn publishDate + postedTime into UTC.
TIME_ZONES = {
    "ET": "America/New_York",
    "CT": "America/Chicago",
    "MT": "America/Denver",
    "PT": "America/Los_Angeles",
}

# Not reported on (scout team, walk-ons); never shown on the public report.
EXEMPT = "Exempt"

# ReportType for an upcoming game whose first report isn't out yet.
PENDING = "Report Pending"

# Archive cell values meaning "not listed in this report" (or the report wasn't issued).
NO_STATUS = {"", "-"}


def released_at(date: str | None, time: str | None, tz: str | None) -> str | None:
    if not (date and time and tz in TIME_ZONES):
        return None
    try:  # strptime, not fromisoformat: some conferences post unpadded hours ("9:00:00")
        local = datetime.strptime(f"{date} {time}", "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    return local.replace(tzinfo=ZoneInfo(TIME_ZONES[tz])).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class HDIntelScraper(BaseScraper):
    """One scraper for every conference HD Intelligence hosts."""

    supports_backfill = True

    def __init__(self, conference: str):
        self.conference = conference
        self.source_url = f"{API}/get-publish-public"

    def _post(self, endpoint: str) -> Any:
        payload = {
            "sport": "Football",
            "organization": self.conference,
            "conference": self.conference,
        }
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        res = requests.post(f"{API}/{endpoint}", json=payload, headers=headers, timeout=30)
        res.raise_for_status()
        return res.json()

    def fetch(self) -> Any:
        return self._post("get-publish-public")

    def fetch_backfill(self) -> Any:
        return self._post("get-archive-public")

    def parse(self, raw: Any) -> ParseResult:
        # {game_id: game}; each game lists both teams' full rosters for one report (ReportType).
        result = ParseResult()
        rows_seen = unparsed = 0
        for game_id, game in raw.items():
            if game["ReportType"] == PENDING:
                continue  # not released: no team report, so its players aren't presumed available
            teams = game["games"]
            if len(teams) != 2:
                raise ValueError(f"game {game_id} has {len(teams)} teams")
            label = game["ReportType"]
            game_date = game["footer"]["date"]
            released = released_at(game.get("publishDate"), game.get("postedTime"), game.get("conferenceTimeZone"))
            if released is None:
                result.warnings.append(
                    f"game {game_id}: no release time from {game.get('publishDate')!r} "
                    f"{game.get('postedTime')!r} {game.get('conferenceTimeZone')!r}"
                )

            for team, other in ((teams[0], teams[1]), (teams[1], teams[0])):
                team_name, opponent = team["teamName"], other["teamName"]
                result.team_reports.append(TeamReport(
                    conference=self.conference,
                    team=team_name,
                    opponent=opponent,
                    game_date=game_date,
                    label=label,
                    released_at=released,
                ))
                for row in team["rows"]:
                    rows_seen += 1
                    match = NAME_RE.match(row["name"])
                    if match:
                        position, number, name = match["position"], match["number"], match["player"]
                        result.roster.append(RosterEntry(team_name, name, position, number))
                    else:  # unknown format: keep the whole string rather than guess
                        unparsed += 1
                        result.warnings.append(f"unparsed name {row['name']!r} ({team_name})")
                        position, number, name = None, None, row["name"].strip()
                    # Available players are implied by the team report; Exempt ones aren't reported on.
                    if row["status"] in ("Available", EXEMPT):
                        continue
                    # The public page files exemptStatus "Out" under OUT (SEASON).
                    status = "Out for Season" if row.get("exemptStatus") == "Out" else row["status"]
                    result.records.append(InjuryRecord(
                        conference=self.conference,
                        team=team_name,
                        player=name,
                        number=number,
                        position=position,
                        opponent=opponent,
                        game_date=game_date,
                        updates=[StatusUpdate(label=label, status=status, status_raw=row["status"])],
                        source_url=self.source_url,
                    ))

        if rows_seen and unparsed / rows_seen > MAX_UNPARSED_NAMES:
            raise ValueError(f"{unparsed}/{rows_seen} names didn't match NAME_RE; has the format changed?")
        return result

    def parse_backfill(self, raw: Any) -> ParseResult:
        # {"data": [row]}; one row per listed player per game, one column per report label.
        # Only listed players appear, so team reports cover teams with at least one listing.
        result = ParseResult()
        source_url = f"{API}/get-archive-public"
        reports: dict[tuple[str, str, str], TeamReport] = {}
        for row in raw["data"]:
            game_date = parsedate_to_datetime(row["Week"]).date().isoformat()
            opponent = re.sub(r"^(at|vs\.?)\s+", "", row["Opponent"]).strip() or None
            updates = [
                StatusUpdate(label=label, status=row[label])
                for label in REPORT_LABELS
                if (row.get(label) or "").strip() not in NO_STATUS | {EXEMPT}
            ]
            if not updates:
                continue
            for u in updates:
                key = (row["Team"], game_date, u.label)
                reports.setdefault(key, TeamReport(
                    conference=self.conference,
                    team=row["Team"],
                    opponent=opponent,
                    game_date=game_date,
                    label=u.label,
                ))
            result.records.append(InjuryRecord(
                conference=self.conference,
                team=row["Team"],
                player=row["Player"].strip(),
                number=(row.get("Number") or "").lstrip("#") or None,
                opponent=opponent,
                game_date=game_date,
                week=row.get("WeekNum"),
                updates=updates,
                source_url=source_url,
            ))
        result.team_reports = list(reports.values())
        return result
