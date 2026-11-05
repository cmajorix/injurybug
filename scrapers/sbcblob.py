from typing import Any

import requests

from .base import BaseScraper, InjuryRecord, ParseResult, StatusUpdate, TeamReport

FEED_URL = "https://sbcautostorage.blob.core.windows.net/availability-reports/{feed}/prod/report.json"

# game["notes"] -> report label used across sources (base.REPORT_LABELS).
# Only these have been seen; unknown notes pass through unchanged.
NOTES_LABELS = {"Advance Report": "Initial", "Initial Report": "Initial", "Game Day Report": "Game Day"}

NAME_SUFFIXES = {"Jr", "Jr.", "Sr", "Sr.", "II", "III", "IV", "V"}


def clean_name(name: str) -> str:
    """Collapses whitespace and flips "Barnes, Brian" to "Brian Barnes"."""
    name = " ".join(name.split())
    last, sep, first = name.partition(",")
    if sep and "," not in first and first.strip() not in NAME_SUFFIXES:
        name = f"{first.strip()} {last.strip()}"
    return name


class SBCBlobScraper(BaseScraper):
    """Static report.json feeds hosted on the Sun Belt's blob storage (Sun Belt, Pac-12)."""

    def __init__(self, conference: str, feed: str):
        self.conference = conference
        self.source_url = FEED_URL.format(feed=feed)

    def fetch(self) -> Any:
        res = requests.get(self.source_url, timeout=30)
        res.raise_for_status()
        return res.json()

    def parse(self, raw: Any) -> ParseResult:
        # Only players with a status are listed (no full roster) and there are no jersey numbers.
        # TODO: an empty players list may mean "posted on the school's site" (config.emptyPlayerMessage)
        # rather than "no injuries"; check one when it happens before trusting its team report.
        result = ParseResult()
        for game in raw["games"]:
            label = NOTES_LABELS.get(game["notes"], game["notes"])
            released = game.get("updatedAtUTC")
            for side, other in (("away", "home"), ("home", "away")):
                team = game[side]
                result.team_reports.append(TeamReport(
                    conference=self.conference,
                    team=team["name"],
                    opponent=game[other]["name"],
                    game_date=game["dateISO"],
                    label=label,
                    released_at=f"{released[:19]}Z" if released else None,
                ))
                for player in team["players"]:
                    result.records.append(InjuryRecord(
                        conference=self.conference,
                        team=team["name"],
                        player=clean_name(player["name"]),
                        number=None,
                        position=player["position"].strip() or None,
                        opponent=game[other]["name"],
                        game_date=game["dateISO"],
                        week=None,
                        updates=[StatusUpdate(label=label, status=player["status"])],
                        source_url=self.source_url,
                    ))
        return result
