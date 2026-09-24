"""Orchestrates one pipeline run: extract -> land -> load raw -> transform -> DQ -> (publish)."""

from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path

from . import quality, warehouse
from .config import SQL_DIR, VENUES, data_dir
from .sources import holidays, weather
from .sources.ticketing import DaySignals, SimulatedTicketingVendor, TicketingClient

log = logging.getLogger(__name__)


@dataclass
class RunSummary:
    run_id: str
    rows_weather: int
    rows_holidays: int
    rows_sales: int
    dq_results: list[quality.CheckResult]


def extract(mode: str, start: date, end: date, *, vendor_failure_rate: float = 0.1):
    if mode == "live":
        weather_rows = [r for v in VENUES for r in weather.fetch_live(v, start, end)]
        holiday_rows = holidays.fetch_live(start, end)
    elif mode == "offline":
        weather_rows = [r for v in VENUES for r in weather.synthesise(v, start, end)]
        holiday_rows = holidays.load_fixture(start, end)
    else:
        raise ValueError(f"unknown mode {mode!r}")

    # Demand in the simulated vendor responds to the same weather/holidays we ingested.
    by_venue_day = {(r["venue_id"], r["date"]): r for r in weather_rows}
    holiday_days: dict[str, set[str]] = defaultdict(set)
    region_of = {v.venue_id: v.region_code for v in VENUES}
    for h in holiday_rows:
        for v in VENUES:
            if h["is_national"] or region_of[v.venue_id] in h["regions"]:
                holiday_days[v.venue_id].add(h["date"])

    def signals(venue_id: str, d: date) -> DaySignals:
        w = by_venue_day.get((venue_id, d.isoformat()), {})
        return DaySignals(
            temp_max_c=w.get("temp_max_c"),
            precipitation_mm=w.get("precipitation_mm"),
            is_holiday=d.isoformat() in holiday_days[venue_id],
        )

    vendor = SimulatedTicketingVendor(VENUES, signals, failure_rate=vendor_failure_rate)
    client = TicketingClient(vendor, backoff_seconds=0.05)
    sales_rows = client.fetch_daily_sales(start, end)
    return weather_rows, holiday_rows, sales_rows


def transform(con) -> None:
    for sql_file in sorted(SQL_DIR.glob("*.sql")):
        log.info("running %s", sql_file.name)
        con.execute(sql_file.read_text())


def run(
    start: date,
    end: date,
    *,
    mode: str = "offline",
    db_path: Path | str,
    landing_dir: Path | None = None,
    publish: bool = False,
    vendor_failure_rate: float = 0.1,
) -> RunSummary:
    if end < start:
        raise ValueError("end date must be on or after start date")
    run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]
    con = warehouse.connect(db_path)
    con.execute(
        "INSERT INTO ops.pipeline_runs (run_id, mode, window_start, window_end, started_at, status) "
        "VALUES (?, ?, ?, ?, now(), 'running')",
        [run_id, mode, start, end],
    )
    try:
        weather_rows, holiday_rows, sales_rows = extract(
            mode, start, end, vendor_failure_rate=vendor_failure_rate
        )
        base = landing_dir or data_dir()
        paths = {
            name: warehouse.write_landing(name, run_id, rows, base)
            for name, rows in (
                ("weather", weather_rows), ("holidays", holiday_rows), ("ticket_sales", sales_rows)
            )
        }

        con.execute("BEGIN TRANSACTION")
        warehouse.load_venues(con)
        n_weather = warehouse.load_weather(con, paths["weather"], run_id, start, end)
        n_holidays = (
            warehouse.load_holidays(con, paths["holidays"], run_id, start, end)
            if holiday_rows else 0
        )
        n_sales = warehouse.load_ticket_sales(con, paths["ticket_sales"], run_id, start, end)
        transform(con)
        results = quality.run_checks(con, quality.CHECKS)
        try:
            quality.assert_passed(results)
        except quality.DataQualityError:
            con.execute("ROLLBACK")  # marts stay at their last good state
            quality.record_results(con, run_id, results)
            raise
        con.execute("COMMIT")
        quality.record_results(con, run_id, results)

        con.execute(
            """UPDATE ops.pipeline_runs SET finished_at = now(), status = 'success',
                   rows_weather = ?, rows_holidays = ?, rows_sales = ? WHERE run_id = ?""",
            [n_weather, n_holidays, n_sales, run_id],
        )
        if publish:
            from .publish import publish_to_motherduck

            # A publish failure flips the run to 'failed' below; the local marts stay valid.
            publish_to_motherduck(con)
        return RunSummary(run_id, n_weather, n_holidays, n_sales, results)
    except Exception as exc:
        try:
            con.execute("ROLLBACK")
        except Exception:  # no open transaction
            pass
        con.execute(
            "UPDATE ops.pipeline_runs SET finished_at = now(), status = 'failed', error = ? "
            "WHERE run_id = ?",
            [str(exc)[:1000], run_id],
        )
        raise
    finally:
        con.close()
