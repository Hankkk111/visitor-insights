"""Command-line entry point.

    visitor-pipeline run --start 2025-01-01 --end 2025-12-31 --mode offline
    visitor-pipeline run --mode live --publish        # real APIs + push to MotherDuck
    visitor-pipeline run --mode live --rolling-days 365 --publish   # scheduled refresh
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import date, timedelta

from . import pipeline
from .config import warehouse_path
from .quality import DataQualityError

ARCHIVE_LAG_DAYS = 3  # Open-Meteo's historical archive trails today by ~2 days


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="visitor-pipeline")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="extract, load, transform and check one date window")
    run.add_argument("--start", type=date.fromisoformat, default=date(2025, 1, 1))
    run.add_argument("--end", type=date.fromisoformat, default=date(2025, 12, 31))
    run.add_argument(
        "--mode", choices=("offline", "live"), default="offline",
        help="live = Open-Meteo + Nager.Date APIs; offline = synthetic weather + bundled holidays",
    )
    run.add_argument(
        "--rolling-days", type=int, default=None,
        help="ignore --start/--end and load the last N days (ending a few days ago, "
             "because the weather archive lags behind real time)",
    )
    run.add_argument("--db", default=None, help="DuckDB file (default: $DUCKDB_PATH or data/)")
    run.add_argument("--publish", action="store_true", help="copy marts to MotherDuck")
    run.add_argument("-v", "--verbose", action="store_true")

    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    start, end = args.start, args.end
    if args.rolling_days:
        end = date.today() - timedelta(days=ARCHIVE_LAG_DAYS)
        start = end - timedelta(days=args.rolling_days - 1)

    try:
        summary = pipeline.run(
            start, end, mode=args.mode, db_path=args.db or warehouse_path(),
            publish=args.publish,
        )
    except DataQualityError as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 2

    print(f"run {summary.run_id}: weather={summary.rows_weather} "
          f"holidays={summary.rows_holidays} sales={summary.rows_sales}")
    for r in summary.dq_results:
        status = "PASS" if r.passed else ("WARN" if r.check.severity == "warn" else "FAIL")
        print(f"  [{status}] {r.check.name}: {r.failures} failing rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
