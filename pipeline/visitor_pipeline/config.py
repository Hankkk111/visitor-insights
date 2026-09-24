"""Static configuration: the venues we track and where data lives.

Venue names are fictional. Each venue is tied to real NZ coordinates (for weather)
and an ISO 3166-2 region code (for regional anniversary holidays).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Venue:
    venue_id: str
    name: str
    city: str
    region_code: str  # ISO 3166-2, matches Nager.Date "counties"
    latitude: float
    longitude: float
    setting: str  # "indoor" | "outdoor" -- drives how weather affects demand
    capacity: int
    base_daily_visitors: int


VENUES: tuple[Venue, ...] = (
    Venue("AKL-AQ", "Harbourview Aquarium", "Auckland", "NZ-AUK",
          -36.8485, 174.7633, "indoor", 3000, 1400),
    Venue("ZQN-AP", "Southern Alps Adventure Park", "Queenstown", "NZ-OTA",
          -45.0312, 168.6626, "outdoor", 2500, 1100),
    Venue("WLG-SM", "Capital Science Museum", "Wellington", "NZ-WGN",
          -41.2865, 174.7762, "indoor", 2200, 950),
    Venue("CHC-BG", "Garden City Botanic Gardens", "Christchurch", "NZ-CAN",
          -43.5321, 172.6362, "outdoor", 4000, 1250),
)

VENUES_BY_ID = {v.venue_id: v for v in VENUES}

TIMEZONE = "Pacific/Auckland"
COUNTRY_CODE = "NZ"

PACKAGE_DIR = Path(__file__).resolve().parent
FIXTURES_DIR = PACKAGE_DIR / "fixtures"
SQL_DIR = PACKAGE_DIR / "sql"


def data_dir() -> Path:
    return Path(os.environ.get("VISITOR_DATA_DIR", Path.cwd() / "data"))


def warehouse_path() -> Path:
    return Path(os.environ.get("DUCKDB_PATH", data_dir() / "warehouse.duckdb"))
