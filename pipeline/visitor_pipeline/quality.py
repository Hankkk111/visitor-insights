"""Data-quality checks, run after every transform.

Each check is a SQL query returning a single failure count. Results are written to
`ops.dq_results` so quality is observable over time, and any `error` check above
its threshold fails the run before bad data reaches the dashboard.
"""

from __future__ import annotations

from dataclasses import dataclass

import duckdb


@dataclass(frozen=True)
class Check:
    name: str
    description: str
    sql: str
    severity: str = "error"  # "error" fails the run, "warn" is recorded only
    threshold: int = 0


@dataclass(frozen=True)
class CheckResult:
    check: Check
    failures: int

    @property
    def passed(self) -> bool:
        return self.failures <= self.check.threshold


CHECKS: tuple[Check, ...] = (
    Check(
        "fct_daily_venue_unique_grain",
        "One row per venue per day",
        """SELECT count(*) FROM (
               SELECT venue_id, date FROM marts.fct_daily_venue GROUP BY ALL HAVING count(*) > 1)""",
    ),
    Check(
        "ticket_sales_unparseable_amount",
        "Every vendor grossAmount parses to a number",
        "SELECT count(*) FROM staging.stg_ticket_sales WHERE gross_amount_nzd IS NULL",
    ),
    Check(
        "ticket_sales_unparseable_date",
        "Every vendor salesDate parses to a date",
        "SELECT count(*) FROM staging.stg_ticket_sales WHERE sales_date IS NULL",
    ),
    Check(
        "ticket_sales_unknown_venue",
        "Every sale maps to a known venue",
        """SELECT count(*) FROM staging.stg_ticket_sales s
           WHERE NOT EXISTS (SELECT 1 FROM marts.dim_venue v WHERE v.venue_id = s.venue_id)""",
    ),
    Check(
        "ticket_sales_unknown_ticket_type",
        "Ticket types are in the agreed list",
        """SELECT count(*) FROM staging.stg_ticket_sales
           WHERE ticket_type NOT IN ('adult', 'child', 'senior', 'annual_pass')""",
    ),
    Check(
        "ticket_sales_negative_values",
        "No negative quantities or revenue",
        """SELECT count(*) FROM staging.stg_ticket_sales
           WHERE quantity < 0 OR gross_amount_nzd < 0""",
    ),
    Check(
        "daily_venue_missing_days",
        "Every venue has sales for every day in the window",
        """SELECT count(*) FROM marts.dim_venue v CROSS JOIN marts.dim_date d
           WHERE NOT EXISTS (SELECT 1 FROM marts.fct_daily_venue f
                             WHERE f.venue_id = v.venue_id AND f.date = d.date)""",
    ),
    Check(
        "daily_venue_missing_weather",
        "Weather joined for (almost) every venue-day",
        "SELECT count(*) FROM marts.fct_daily_venue WHERE temp_max_c IS NULL",
        severity="warn",
        threshold=5,
    ),
    Check(
        "daily_venue_over_capacity",
        "Visitors never exceed venue capacity",
        "SELECT count(*) FROM marts.fct_daily_venue WHERE utilisation > 1",
    ),
)


class DataQualityError(RuntimeError):
    def __init__(self, failed: list[CheckResult]):
        names = ", ".join(f"{r.check.name} ({r.failures})" for r in failed)
        super().__init__(f"Data-quality checks failed: {names}")
        self.failed = failed


def run_checks(
    con: duckdb.DuckDBPyConnection, checks: tuple[Check, ...] = CHECKS
) -> list[CheckResult]:
    return [CheckResult(c, int(con.execute(c.sql).fetchone()[0])) for c in checks]


def record_results(
    con: duckdb.DuckDBPyConnection, run_id: str, results: list[CheckResult]
) -> None:
    """Persist results outside the load transaction so failures survive a rollback."""
    con.executemany(
        "INSERT INTO ops.dq_results VALUES (?, ?, ?, ?, ?, ?, ?, now())",
        [
            [run_id, r.check.name, r.check.severity, r.failures, r.check.threshold, r.passed,
             r.check.description]
            for r in results
        ],
    )


def assert_passed(results: list[CheckResult]) -> None:
    failed = [r for r in results if not r.passed and r.check.severity == "error"]
    if failed:
        raise DataQualityError(failed)
