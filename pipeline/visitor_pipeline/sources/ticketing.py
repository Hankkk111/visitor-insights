"""Third-party ticketing integration.

`TicketingClient` is written the way you'd integrate a real vendor reporting API:
cursor pagination, retries on transient failures, and no assumptions that the
payload is clean. `SimulatedTicketingVendor` stands in for the vendor. It
produces realistic daily sales driven by weekday, season, holidays and weather,
and deliberately reproduces the messiness real vendor feeds have:

* inconsistent `ticketType` casing/whitespace ("ADULT", " adult", "Adult")
* `grossAmount` sometimes a number, sometimes a string like "NZD 1,234.50"
* `salesDate` sometimes a date, sometimes a timestamp with an offset
* overlapping pages that repeat a record (so the warehouse must de-duplicate)
* intermittent 503s (so the client must retry)

The clean-up happens in SQL staging, where it is visible and testable.
"""

from __future__ import annotations

import base64
import json
import logging
import math
import random
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import date, timedelta

from ..config import Venue

log = logging.getLogger(__name__)

TICKET_MIX = {"adult": 0.52, "child": 0.30, "senior": 0.10, "annual_pass": 0.08}
BASE_PRICE_NZD = {"adult": 42.0, "child": 22.0, "senior": 32.0, "annual_pass": 0.0}
CHANNELS = ("online", "walk_up", "partner")
# Tourist-heavy venues sell more tickets ahead of time.
ONLINE_BASE_SHARE = {"ZQN-AP": 0.55, "AKL-AQ": 0.45, "WLG-SM": 0.36, "CHC-BG": 0.30}


class TransientVendorError(RuntimeError):
    """Stands in for an HTTP 503 from the vendor."""


@dataclass(frozen=True)
class DaySignals:
    temp_max_c: float | None
    precipitation_mm: float | None
    is_holiday: bool


SignalLookup = Callable[[str, date], DaySignals]


def expected_visitors(venue: Venue, d: date, sig: DaySignals, rng: random.Random) -> int:
    dow_factor = (0.78, 0.78, 0.8, 0.85, 1.05, 1.6, 1.45)[d.weekday()]
    doy = d.timetuple().tm_yday
    season = 1 + 0.28 * math.cos(2 * math.pi * (doy - 15) / 365.25)  # summer peak
    holiday = 1.45 if sig.is_holiday else 1.0

    rain = sig.precipitation_mm or 0.0
    temp = sig.temp_max_c if sig.temp_max_c is not None else 18.0
    if venue.setting == "outdoor":
        weather = 0.5 if rain >= 5 else 0.8 if rain >= 1 else 1.0
        weather *= 1 + max(min((temp - 18) * 0.015, 0.15), -0.3)
    else:
        weather = 1.25 if rain >= 5 else 1.1 if rain >= 1 else 1.0
        weather *= 1 + max(min((temp - 22) * -0.01, 0.05), -0.1)  # hot days pull people outside

    noise = rng.lognormvariate(0, 0.08)
    visitors = venue.base_daily_visitors * dow_factor * season * holiday * weather * noise
    return max(0, min(int(visitors), venue.capacity))


class SimulatedTicketingVendor:
    def __init__(
        self,
        venues: tuple[Venue, ...],
        signals: SignalLookup,
        *,
        seed: int = 42,
        failure_rate: float = 0.1,
    ) -> None:
        self.venues = venues
        self.signals = signals
        self.seed = seed
        self.failure_rate = failure_rate
        self.calls = 0
        self._cache: dict[tuple[date, date], list[dict]] = {}

    # --- record generation -------------------------------------------------
    def _records(self, start: date, end: date) -> list[dict]:
        records: list[dict] = []
        d = start
        while d <= end:
            for venue in self.venues:
                rng = random.Random(f"{self.seed}|{venue.venue_id}|{d.isoformat()}")
                sig = self.signals(venue.venue_id, d)
                visitors = expected_visitors(venue, d, sig, rng)
                base_online = ONLINE_BASE_SHARE.get(venue.venue_id, 0.42)
                online_share = base_online + (0.12 if sig.is_holiday or d.weekday() >= 5 else 0)
                channel_mix = {
                    "online": online_share,
                    "partner": 0.08,
                    "walk_up": 1 - online_share - 0.08,
                }
                price_scale = venue.capacity / 3000 * 0.25 + 0.9
                shares = {
                    (t, c): t_share * channel_mix[c]
                    for t, t_share in TICKET_MIX.items()
                    for c in CHANNELS
                }
                for (ticket_type, channel), qty in _allocate(visitors, shares).items():
                    if qty == 0:
                        continue
                    unit = BASE_PRICE_NZD[ticket_type] * price_scale
                    if channel == "online":
                        unit *= 0.9  # online discount
                    records.append(
                        self._messy_record(venue, d, ticket_type, channel, qty, qty * unit, rng)
                    )
            d += timedelta(days=1)
        return records

    @staticmethod
    def _messy_record(
        venue: Venue, d: date, ticket_type: str, channel: str, qty: int, gross: float,
        rng: random.Random,
    ) -> dict:
        casing = rng.choice([str.upper, str.lower, str.title, lambda s: f" {s} "])
        amount_style = rng.random()
        if amount_style < 0.6:
            gross_amount: float | str = round(gross, 2)
        elif amount_style < 0.85:
            gross_amount = f"NZD {gross:,.2f}"
        else:
            gross_amount = f"{gross:.2f}"
        sales_date = d.isoformat() if rng.random() < 0.7 else f"{d.isoformat()}T00:00:00+13:00"
        return {
            "recordId": f"{venue.venue_id}|{d.isoformat()}|{ticket_type}|{channel}",
            "venueCode": venue.venue_id,
            "salesDate": sales_date,
            "ticketType": casing(ticket_type),
            "channel": channel.upper() if rng.random() < 0.2 else channel,
            "quantity": qty,
            "grossAmount": gross_amount,
            "currency": "NZD",
        }

    # --- the "endpoint" ----------------------------------------------------
    def get_daily_sales(
        self, start: date, end: date, cursor: str | None = None, page_size: int = 500
    ) -> dict:
        self.calls += 1
        fail_rng = random.Random(f"fail|{self.seed}|{cursor}|{self.calls}")
        if fail_rng.random() < self.failure_rate:
            raise TransientVendorError("503 Service Unavailable")

        key = (start, end)
        if key not in self._cache:
            self._cache[key] = self._records(start, end)
        records = self._cache[key]
        offset = _decode_cursor(cursor)
        page_start = offset
        # Vendor quirk: pages sometimes overlap by one record.
        if offset > 0 and random.Random(f"overlap|{offset}").random() < 0.35:
            page_start -= 1
        page = records[page_start : offset + page_size]
        next_offset = offset + page_size
        return {
            "data": page,
            "next_cursor": _encode_cursor(next_offset) if next_offset < len(records) else None,
            "total": len(records),
        }


def _allocate(total: int, shares: dict) -> dict:
    """Split an integer total by shares so the parts sum exactly to the total
    (largest-remainder method; plain rounding can overshoot venue capacity)."""
    exact = {k: total * s for k, s in shares.items()}
    parts = {k: int(v) for k, v in exact.items()}
    leftover = total - sum(parts.values())
    for k in sorted(exact, key=lambda k: exact[k] - parts[k], reverse=True)[:leftover]:
        parts[k] += 1
    return parts


def _encode_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(json.dumps({"o": offset}).encode()).decode()


def _decode_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    return int(json.loads(base64.urlsafe_b64decode(cursor.encode()))["o"])


class TicketingClient:
    def __init__(
        self,
        vendor: SimulatedTicketingVendor,
        *,
        max_attempts: int = 5,
        backoff_seconds: float = 0.2,
        page_size: int = 500,
    ) -> None:
        self.vendor = vendor
        self.max_attempts = max_attempts
        self.backoff_seconds = backoff_seconds
        self.page_size = page_size

    def _get_page(self, start: date, end: date, cursor: str | None) -> dict:
        for attempt in range(1, self.max_attempts + 1):
            try:
                return self.vendor.get_daily_sales(start, end, cursor, self.page_size)
            except TransientVendorError as exc:
                if attempt == self.max_attempts:
                    raise
                delay = self.backoff_seconds * 2 ** (attempt - 1)
                log.warning("ticketing page failed (%s); retry %d in %.2fs", exc, attempt, delay)
                time.sleep(delay)
        raise AssertionError("unreachable")

    def iter_daily_sales(self, start: date, end: date) -> Iterator[dict]:
        cursor: str | None = None
        while True:
            page = self._get_page(start, end, cursor)
            yield from page["data"]
            cursor = page["next_cursor"]
            if cursor is None:
                return

    def fetch_daily_sales(self, start: date, end: date) -> list[dict]:
        return list(self.iter_daily_sales(start, end))
