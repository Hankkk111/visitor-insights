"""Source-level tests: no network, no database."""

from datetime import date

import pytest

from visitor_pipeline.config import VENUES, VENUES_BY_ID
from visitor_pipeline.sources import holidays, weather
from visitor_pipeline.sources.ticketing import (
    DaySignals,
    SimulatedTicketingVendor,
    TicketingClient,
    TransientVendorError,
    expected_visitors,
)


def dry(_venue_id, _d):
    return DaySignals(temp_max_c=20.0, precipitation_mm=0.0, is_holiday=False)


# --- weather -----------------------------------------------------------------

def test_parse_open_meteo_turns_columns_into_rows():
    payload = {
        "daily": {
            "time": ["2025-01-01", "2025-01-02"],
            "temperature_2m_max": [24.1, 22.0],
            "temperature_2m_min": [16.0, 15.2],
            "precipitation_sum": [0.0, 12.4],
        }
    }
    rows = weather.parse_open_meteo("AKL-AQ", payload)
    assert rows == [
        {"venue_id": "AKL-AQ", "date": "2025-01-01", "temp_max_c": 24.1, "temp_min_c": 16.0,
         "precipitation_mm": 0.0, "source": "open-meteo"},
        {"venue_id": "AKL-AQ", "date": "2025-01-02", "temp_max_c": 22.0, "temp_min_c": 15.2,
         "precipitation_mm": 12.4, "source": "open-meteo"},
    ]


def test_parse_open_meteo_rejects_ragged_columns():
    payload = {"daily": {"time": ["2025-01-01", "2025-01-02"], "temperature_2m_max": [20.0],
                         "temperature_2m_min": [1, 2], "precipitation_sum": [0, 0]}}
    with pytest.raises(ValueError):
        weather.parse_open_meteo("AKL-AQ", payload)


def test_synthetic_weather_is_deterministic_and_seasonal():
    venue = VENUES_BY_ID["ZQN-AP"]
    jan = weather.synthesise(venue, date(2025, 1, 1), date(2025, 1, 31))
    jul = weather.synthesise(venue, date(2025, 7, 1), date(2025, 7, 31))
    assert jan == weather.synthesise(venue, date(2025, 1, 1), date(2025, 1, 31))
    assert len(jan) == 31
    mean = lambda rows: sum(r["temp_max_c"] for r in rows) / len(rows)  # noqa: E731
    assert mean(jan) > mean(jul) + 8  # southern-hemisphere summer is warmer


# --- holidays ----------------------------------------------------------------

def test_holiday_fixture_filters_window_and_keeps_regions():
    rows = holidays.load_fixture(date(2025, 1, 1), date(2025, 1, 31))
    names = {r["name"] for r in rows}
    assert "Auckland Anniversary Day" in names
    assert "Waitangi Day" not in names  # 6 Feb is outside the window
    akl = next(r for r in rows if r["name"] == "Auckland Anniversary Day")
    assert akl["is_national"] is False and "NZ-AUK" in akl["regions"]


def test_holiday_normalise_handles_nager_nulls():
    raw = [{"date": "2025-02-06", "localName": "Waitangi Day", "name": "Waitangi Day",
            "global": True, "counties": None}]
    [row] = holidays.normalise(raw, date(2025, 1, 1), date(2025, 12, 31), source="test")
    assert row["regions"] == [] and row["is_national"] is True


# --- ticketing vendor + client -------------------------------------------------

def test_client_follows_cursor_pagination_to_the_end():
    vendor = SimulatedTicketingVendor(VENUES, dry, failure_rate=0.0)
    client = TicketingClient(vendor, page_size=50)
    rows = client.fetch_daily_sales(date(2025, 3, 1), date(2025, 3, 7))
    unique_ids = {r["recordId"] for r in rows}
    total = vendor.get_daily_sales(date(2025, 3, 1), date(2025, 3, 7))["total"]
    assert len(unique_ids) == total
    assert vendor.calls > total // 50  # really paged


def test_vendor_pages_can_overlap_so_duplicates_reach_the_warehouse():
    vendor = SimulatedTicketingVendor(VENUES, dry, failure_rate=0.0)
    rows = TicketingClient(vendor, page_size=20).fetch_daily_sales(date(2025, 3, 1),
                                                                     date(2025, 3, 14))
    assert len(rows) > len({r["recordId"] for r in rows})


def test_client_retries_transient_failures():
    vendor = SimulatedTicketingVendor(VENUES, dry, failure_rate=0.4)
    client = TicketingClient(vendor, backoff_seconds=0, max_attempts=20, page_size=100)
    rows = client.fetch_daily_sales(date(2025, 3, 1), date(2025, 3, 3))
    assert rows


def test_client_gives_up_after_max_attempts():
    vendor = SimulatedTicketingVendor(VENUES, dry, failure_rate=1.0)
    client = TicketingClient(vendor, backoff_seconds=0, max_attempts=3)
    with pytest.raises(TransientVendorError):
        client.fetch_daily_sales(date(2025, 3, 1), date(2025, 3, 1))
    assert vendor.calls == 3


def test_vendor_payload_is_messy_like_a_real_feed():
    vendor = SimulatedTicketingVendor(VENUES, dry, failure_rate=0.0)
    rows = TicketingClient(vendor).fetch_daily_sales(date(2025, 3, 1), date(2025, 3, 31))
    assert any(isinstance(r["grossAmount"], str) and "NZD" in r["grossAmount"] for r in rows)
    assert any("T" in r["salesDate"] for r in rows)
    assert len({r["ticketType"] for r in rows}) > 4  # same types, different casing


def test_rain_hurts_outdoor_but_helps_indoor_demand():
    import random

    def avg(venue_id, rain):
        venue = VENUES_BY_ID[venue_id]
        sig = DaySignals(temp_max_c=18.0, precipitation_mm=rain, is_holiday=False)
        d = date(2025, 3, 5)
        return sum(expected_visitors(venue, d, sig, random.Random(i)) for i in range(200))

    assert avg("CHC-BG", 10) < avg("CHC-BG", 0) * 0.7   # outdoor gardens
    assert avg("AKL-AQ", 10) > avg("AKL-AQ", 0) * 1.1   # indoor aquarium


def test_allocation_never_overshoots_the_daily_total():
    from visitor_pipeline.sources.ticketing import _allocate

    shares = {("a", "x"): 0.335, ("a", "y"): 0.335, ("b", "x"): 0.33}
    for total in (0, 1, 7, 999, 2500):
        assert sum(_allocate(total, shares).values()) == total
