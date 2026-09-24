"""Daily weather per venue.

Live mode calls the Open-Meteo historical archive API (free, no key).
Offline mode synthesises a deterministic, seasonally plausible series so the
pipeline, tests and CI run without network access.
"""

from __future__ import annotations

import math
import random
from datetime import date, timedelta
from typing import Any

from ..config import TIMEZONE, Venue
from ..http import get_json

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
DAILY_FIELDS = ("temperature_2m_max", "temperature_2m_min", "precipitation_sum")


def fetch_live(venue: Venue, start: date, end: date, **http_kwargs: Any) -> list[dict]:
    payload = get_json(
        ARCHIVE_URL,
        params={
            "latitude": venue.latitude,
            "longitude": venue.longitude,
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "daily": ",".join(DAILY_FIELDS),
            "timezone": TIMEZONE,
        },
        **http_kwargs,
    )
    return parse_open_meteo(venue.venue_id, payload)


def parse_open_meteo(venue_id: str, payload: dict) -> list[dict]:
    """Turn Open-Meteo's column-oriented `daily` block into one row per day."""
    daily = payload.get("daily") or {}
    days = daily.get("time") or []
    columns = {f: daily.get(f) or [None] * len(days) for f in DAILY_FIELDS}
    for field, values in columns.items():
        if len(values) != len(days):
            raise ValueError(f"Open-Meteo field {field} has {len(values)} values for {len(days)} days")
    return [
        {
            "venue_id": venue_id,
            "date": d,
            "temp_max_c": columns["temperature_2m_max"][i],
            "temp_min_c": columns["temperature_2m_min"][i],
            "precipitation_mm": columns["precipitation_sum"][i],
            "source": "open-meteo",
        }
        for i, d in enumerate(days)
    ]


# Rough climate normals used only for the offline generator.
_CLIMATE = {
    "Auckland": (19.5, 4.5, 0.38),  # annual mean max C, seasonal amplitude, rain-day probability
    "Queenstown": (15.5, 7.5, 0.30),
    "Wellington": (16.5, 4.0, 0.36),
    "Christchurch": (17.5, 5.5, 0.27),
}


def synthesise(venue: Venue, start: date, end: date) -> list[dict]:
    mean_max, amplitude, rain_prob = _CLIMATE.get(venue.city, (17.0, 5.0, 0.3))
    rows = []
    d = start
    while d <= end:
        rng = random.Random(f"weather|{venue.venue_id}|{d.isoformat()}")
        doy = d.timetuple().tm_yday
        seasonal = amplitude * math.cos(2 * math.pi * (doy - 25) / 365.25)  # NZ peak late Jan
        t_max = mean_max + seasonal + rng.gauss(0, 2.2)
        t_min = t_max - rng.uniform(6, 10)
        wet = rng.random() < rain_prob
        precip = round(rng.expovariate(1 / 7.0), 1) if wet else 0.0
        if wet:
            t_max -= 1.5
        rows.append(
            {
                "venue_id": venue.venue_id,
                "date": d.isoformat(),
                "temp_max_c": round(t_max, 1),
                "temp_min_c": round(t_min, 1),
                "precipitation_mm": precip,
                "source": "synthetic",
            }
        )
        d += timedelta(days=1)
    return rows
