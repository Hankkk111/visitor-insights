"""Publishing logic, exercised against a local DuckDB file standing in for MotherDuck."""

from datetime import date

import pytest

duckdb = pytest.importorskip("duckdb")

from visitor_pipeline import pipeline  # noqa: E402
from visitor_pipeline.publish import publish_into  # noqa: E402


def test_publish_replaces_marts_and_appends_run_history(tmp_path):
    target = tmp_path / "target.duckdb"
    for i, window in enumerate([(date(2025, 3, 1), date(2025, 3, 7)),
                                (date(2025, 3, 1), date(2025, 3, 14))]):
        db = tmp_path / f"local{i}.duckdb"  # each scheduled run starts from an empty warehouse
        pipeline.run(*window, mode="offline", db_path=db, landing_dir=tmp_path,
                     vendor_failure_rate=0)
        con = duckdb.connect(str(db))
        con.execute(f"ATTACH '{target}' AS published")
        publish_into(con, "published")
        con.close()

    con = duckdb.connect(str(target), read_only=True)
    [(days,)] = con.execute("SELECT count(DISTINCT date) FROM marts.fct_daily_venue").fetchall()
    [(runs,)] = con.execute("SELECT count(*) FROM ops.pipeline_runs").fetchall()
    [(checks,)] = con.execute("SELECT count(DISTINCT run_id) FROM ops.dq_results").fetchall()
    con.close()
    assert days == 14            # marts reflect the latest run only
    assert runs == 2 and checks == 2  # history accumulates across runs
