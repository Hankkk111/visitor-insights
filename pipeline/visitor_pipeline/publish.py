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

# Marts are replaced wholesale on every publish.
MART_TABLES = ("dim_venue", "dim_date", "fct_ticket_sales", "fct_daily_venue")

# Run history is appended, so MotherDuck keeps a record of every scheduled run
# (each CI run starts from an empty local warehouse).
OPS_TABLES = ("pipeline_runs", "dq_results")


def publish_to_motherduck(con: duckdb.DuckDBPyConnection, database: str = "visitor_insights") -> None:
    if not os.environ.get("MOTHERDUCK_TOKEN"):
        raise RuntimeError("MOTHERDUCK_TOKEN is not set; cannot publish to MotherDuck")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", database):
        raise ValueError(f"invalid MotherDuck database name: {database!r}")

    con.execute("ATTACH IF NOT EXISTS 'md:'")
    con.execute(f"CREATE DATABASE IF NOT EXISTS {database}")
    publish_into(con, database)


def publish_into(con: duckdb.DuckDBPyConnection, database: str) -> None:
    """Copy marts (replace) and run history (append) into an attached database."""
    local_db = con.execute("SELECT current_database()").fetchone()[0]
    con.execute(f"CREATE SCHEMA IF NOT EXISTS {database}.marts")
    con.execute(f"CREATE SCHEMA IF NOT EXISTS {database}.ops")

    # One transaction, so the dashboard never reads a half-published set of marts.
    con.execute("BEGIN TRANSACTION")
    try:
        for table in MART_TABLES:
            con.execute(
                f"CREATE OR REPLACE TABLE {database}.marts.{table} AS "
                f'SELECT * FROM "{local_db}".marts.{table}'
            )
        for table in OPS_TABLES:
            con.execute(
                f"CREATE TABLE IF NOT EXISTS {database}.ops.{table} AS "
                f'SELECT * FROM "{local_db}".ops.{table} LIMIT 0'
            )
            con.execute(
                f"INSERT INTO {database}.ops.{table} "
                f'SELECT * FROM "{local_db}".ops.{table} '
                f"WHERE run_id NOT IN (SELECT run_id FROM {database}.ops.{table})"
            )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    log.info("published marts + run history to md:%s", database)
