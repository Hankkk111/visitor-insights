"""Publish the marts to MotherDuck (DuckDB in the cloud) so the deployed dashboard
can query them without shipping a database file.

Requires MOTHERDUCK_TOKEN in the environment. The local file stays the source of truth.
"""

from __future__ import annotations

import logging
import os
import re

import duckdb

log = logging.getLogger(__name__)

PUBLISHED_TABLES = (
    ("marts", "dim_venue"),
    ("marts", "dim_date"),
    ("marts", "fct_ticket_sales"),
    ("marts", "fct_daily_venue"),
    # run history + DQ results, so the deployed dashboard can show data freshness
    ("ops", "pipeline_runs"),
    ("ops", "dq_results"),
)


def publish_to_motherduck(con: duckdb.DuckDBPyConnection, database: str = "visitor_insights") -> None:
    if not os.environ.get("MOTHERDUCK_TOKEN"):
        raise RuntimeError("MOTHERDUCK_TOKEN is not set; cannot publish to MotherDuck")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", database):
        raise ValueError(f"invalid MotherDuck database name: {database!r}")

    local_db = con.execute("SELECT current_database()").fetchone()[0]
    con.execute("ATTACH IF NOT EXISTS 'md:'")
    con.execute(f"CREATE DATABASE IF NOT EXISTS {database}")
    for schema in sorted({s for s, _ in PUBLISHED_TABLES}):
        con.execute(f"CREATE SCHEMA IF NOT EXISTS {database}.{schema}")
    for schema, table in PUBLISHED_TABLES:
        con.execute(
            f'CREATE OR REPLACE TABLE {database}.{schema}.{table} AS '
            f'SELECT * FROM "{local_db}".{schema}.{table}'
        )
        log.info("published %s.%s to md:%s", schema, table, database)
