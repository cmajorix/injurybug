from .base import BaseScraper
from .hdintel import HDIntelScraper
from .sbcblob import SBCBlobScraper

# Conference codes as HD Intelligence expects them in the request.
HDINTEL_CONFERENCES = ["B10", "ACC", "SEC", "B12", "American", "MAC"]

# Conference code -> feed name in the report.json URL.
SBCBLOB_CONFERENCES = {"SunBelt": "sunbelt-football", "Pac12": "pac12-football"}

# Add each conference here as its scraper is written.
SCRAPERS: dict[str, BaseScraper] = {
    **{code: HDIntelScraper(code) for code in HDINTEL_CONFERENCES},
    **{code: SBCBlobScraper(code, feed) for code, feed in SBCBLOB_CONFERENCES.items()},
}
