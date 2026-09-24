"""Command-line entry point.

    visitor-pipeline run --start 2025-01-01 --end 2025-12-31 --mode offline
    visitor-pipeline run --mode live --publish        # real APIs + push to MotherDuck
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import date

from . import pipeline
from .config import warehouse_path
from .quality import DataQualityError


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
    run.add_argument("--db", default=None, help="DuckDB file (default: $DUCKDB_PATH or data/)")
    run.add_argument("--publish", action="store_true", help="copy marts to MotherDuck")
    run.add_argument("-v", "--verbose", action="store_true")

    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    try:
        summary = pipeline.run(
            args.start, args.end, mode=args.mode, db_path=args.db or warehouse_path(),
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
