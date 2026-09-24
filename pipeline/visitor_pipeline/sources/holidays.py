"""NZ public holidays, including regional anniversary days.

Live mode calls the Nager.Date API (free, no key). Offline mode reads a bundled
fixture in the same response format.
"""

from __future__ import annotations

import json
import logging
from datetime import date
from typing import Any

from ..config import COUNTRY_CODE, FIXTURES_DIR
from ..http import get_json

log = logging.getLogger(__name__)

NAGER_URL = "https://date.nager.at/api/v3/PublicHolidays/{year}/{country}"


def fetch_live(start: date, end: date, **http_kwargs: Any) -> list[dict]:
    raw: list[dict] = []
    for year in range(start.year, end.year + 1):
        raw.extend(get_json(NAGER_URL.format(year=year, country=COUNTRY_CODE), **http_kwargs))
    return normalise(raw, start, end, source="nager.date")


def load_fixture(start: date, end: date) -> list[dict]:
    raw: list[dict] = []
    for year in range(start.year, end.year + 1):
        path = FIXTURES_DIR / f"holidays_{COUNTRY_CODE.lower()}_{year}.json"
        if not path.exists():
            log.warning("No holiday fixture for %s; holiday flags will be empty that year", year)
            continue
        raw.extend(json.loads(path.read_text()))
    return normalise(raw, start, end, source="fixture")


def normalise(raw: list[dict], start: date, end: date, *, source: str) -> list[dict]:
    rows = []
    for h in raw:
        d = date.fromisoformat(h["date"])
        if not start <= d <= end:
            continue
        rows.append(
            {
                "date": h["date"],
                "local_name": h.get("localName") or h.get("name"),
                "name": h.get("name"),
                "is_national": bool(h.get("global", True)),
                # Nager uses null for national holidays, a list of region codes otherwise.
                "regions": list(h.get("counties") or []),
                "source": source,
            }
        )
    return rows
