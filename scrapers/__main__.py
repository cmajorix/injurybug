"""python -m scrapers [--backfill] [conference ...]  — runs all scrapers when none are given.

--backfill pulls past weeks from sources that publish them separately (HD Intelligence's archive)
and skips sources that don't.
"""

import sys

from . import SCRAPERS


def main(argv: list[str]) -> int:
    backfill = "--backfill" in argv
    names = [a for a in argv if a != "--backfill"] or list(SCRAPERS)
    failed = []
    for name in names:
        scraper = SCRAPERS[name]
        if backfill and not scraper.supports_backfill:
            continue
        try:
            result = scraper.run(backfill=backfill)
            print(f"{name}: {len(result.records)} records, {len(result.team_reports)} team reports")
        except Exception as e:  # one broken source shouldn't block the others
            print(f"{name}: FAILED - {e!r}", file=sys.stderr)
            failed.append(name)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
