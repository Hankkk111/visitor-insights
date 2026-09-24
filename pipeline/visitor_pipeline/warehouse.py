"""Landing zone + raw layer.

Each extract is written to newline-delimited JSON under `landing/<source>/<run_id>.ndjson`
(an auditable copy of exactly what the source returned), then loaded into the `raw`
schema. Loads are idempotent: rows for the same date window are replaced, so a
re-run or backfill never double-counts.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import date
from pathlib import Path

import duckdb

from .config import VENUES, data_dir

RAW_DDL = """
CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS raw.weather_daily (
    venue_id          VARCHAR NOT NULL,
    date              DATE    NOT NULL,
    temp_max_c        DOUBLE,
    temp_min_c        DOUBLE,
    precipitation_mm  DOUBLE,
    source            VARCHAR,
    _run_id           VARCHAR NOT NULL,
    _loaded_at        TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS raw.public_holidays (
    date         DATE NOT NULL,
    local_name   VARCHAR,
    name         VARCHAR,
    is_national  BOOLEAN,
    regions      VARCHAR[],
    source       VARCHAR,
    _run_id      VARCHAR NOT NULL,
    _loaded_at   TIMESTAMP NOT NULL
);

-- Kept deliberately loose: vendor fields land as text and are cleaned in staging.
CREATE TABLE IF NOT EXISTS raw.ticket_sales (
    record_id         VARCHAR,
    venue_code        VARCHAR,
    sales_date_raw    VARCHAR,
    ticket_type_raw   VARCHAR,
    channel_raw       VARCHAR,
    quantity          INTEGER,
    gross_amount_raw  VARCHAR,
    currency          VARCHAR,
    _run_id           VARCHAR NOT NULL,
    _loaded_at        TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS ops.pipeline_runs (
    run_id        VARCHAR PRIMARY KEY,
    mode          VARCHAR,
    window_start  DATE,
    window_end    DATE,
    started_at    TIMESTAMP,
    finished_at   TIMESTAMP,
    status        VARCHAR,
    rows_weather  INTEGER,
    rows_holidays INTEGER,
    rows_sales    INTEGER,
    error         VARCHAR
);

CREATE TABLE IF NOT EXISTS ops.dq_results (
    run_id        VARCHAR,
    check_name    VARCHAR,
    severity      VARCHAR,
    failures      BIGINT,
    threshold     BIGINT,
    passed        BOOLEAN,
    description   VARCHAR,
    checked_at    TIMESTAMP
);
"""


def connect(path: Path | str) -> duckdb.DuckDBPyConnection:
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(path))
    con.execute(RAW_DDL)
    return con


def _sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def write_landing(source: str, run_id: str, rows: list[dict], base: Path | None = None) -> Path:
    folder = (base or data_dir()) / "landing" / source
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{run_id}.ndjson"
    with path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    return path


def load_venues(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("""
        CREATE OR REPLACE TABLE raw.venues (
            venue_id VARCHAR PRIMARY KEY, name VARCHAR, city VARCHAR, region_code VARCHAR,
            latitude DOUBLE, longitude DOUBLE, setting VARCHAR, capacity INTEGER,
            base_daily_visitors INTEGER
        )
    """)
    con.executemany(
        "INSERT INTO raw.venues VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [tuple(asdict(v).values()) for v in VENUES],
    )


def load_weather(con, path: Path, run_id: str, start: date, end: date) -> int:
    con.execute("DELETE FROM raw.weather_daily WHERE date BETWEEN ? AND ?", [start, end])
    con.execute(f"""
        INSERT INTO raw.weather_daily
        SELECT venue_id, date, temp_max_c, temp_min_c, precipitation_mm, source,
               {_sql_literal(run_id)}, now()
        FROM read_json({_sql_literal(str(path))}, format = 'newline_delimited', columns = {{
            venue_id: 'VARCHAR', date: 'DATE', temp_max_c: 'DOUBLE', temp_min_c: 'DOUBLE',
            precipitation_mm: 'DOUBLE', source: 'VARCHAR'
        }})
    """)
    return _count(con, "raw.weather_daily", run_id)


def load_holidays(con, path: Path, run_id: str, start: date, end: date) -> int:
    con.execute("DELETE FROM raw.public_holidays WHERE date BETWEEN ? AND ?", [start, end])
    con.execute(f"""
        INSERT INTO raw.public_holidays
        SELECT date, local_name, name, is_national, regions, source, {_sql_literal(run_id)}, now()
        FROM read_json({_sql_literal(str(path))}, format = 'newline_delimited', columns = {{
            date: 'DATE', local_name: 'VARCHAR', name: 'VARCHAR', is_national: 'BOOLEAN',
            regions: 'VARCHAR[]', source: 'VARCHAR'
        }})
    """)
    return _count(con, "raw.public_holidays", run_id)


def load_ticket_sales(con, path: Path, run_id: str, start: date, end: date) -> int:
    con.execute(
        """DELETE FROM raw.ticket_sales
           WHERE try_cast(left(trim(sales_date_raw), 10) AS DATE) BETWEEN ? AND ?""",
        [start, end],
    )
    con.execute(f"""
        INSERT INTO raw.ticket_sales
        SELECT recordId, venueCode, salesDate, ticketType, channel, quantity, grossAmount,
               currency, {_sql_literal(run_id)}, now()
        FROM read_json({_sql_literal(str(path))}, format = 'newline_delimited', columns = {{
            recordId: 'VARCHAR', venueCode: 'VARCHAR', salesDate: 'VARCHAR',
            ticketType: 'VARCHAR', channel: 'VARCHAR', quantity: 'INTEGER',
            grossAmount: 'VARCHAR', currency: 'VARCHAR'
        }})
    """)
    return _count(con, "raw.ticket_sales", run_id)


def _count(con, table: str, run_id: str) -> int:
    return con.execute(f"SELECT count(*) FROM {table} WHERE _run_id = ?", [run_id]).fetchone()[0]
