"""End-to-end tests against a real (temporary) DuckDB warehouse."""

from datetime import date

import pytest

duckdb = pytest.importorskip("duckdb")

from visitor_pipeline import pipeline, quality  # noqa: E402

START, END = date(2025, 1, 25), date(2025, 2, 10)  # covers Auckland Anniversary + Waitangi Day


@pytest.fixture()
def warehouse(tmp_path):
    db = tmp_path / "wh.duckdb"
    summary = pipeline.run(START, END, mode="offline", db_path=db, landing_dir=tmp_path,
                           vendor_failure_rate=0.2)
    con = duckdb.connect(str(db))
    yield con, summary, tmp_path
    con.close()


def q(con, sql, *params):
    return con.execute(sql, list(params)).fetchall()


def test_run_succeeds_and_all_error_checks_pass(warehouse):
    con, summary, _ = warehouse
    assert summary.rows_sales > 0
    assert all(r.passed for r in summary.dq_results if r.check.severity == "error")
    assert q(con, "SELECT status FROM ops.pipeline_runs WHERE run_id = ?", summary.run_id) == [
        ("success",)
    ]


def test_grain_is_one_row_per_venue_per_day(warehouse):
    con, *_ = warehouse
    days = (END - START).days + 1
    [(n,)] = q(con, "SELECT count(*) FROM marts.fct_daily_venue")
    assert n == 4 * days


def test_overlapping_vendor_pages_are_deduplicated(warehouse):
    con, *_ = warehouse
    [(raw, distinct)] = q(con, "SELECT count(*), count(DISTINCT record_id) FROM raw.ticket_sales")
    [(clean,)] = q(con, "SELECT count(*) FROM marts.fct_ticket_sales")
    assert raw >= distinct == clean


def test_messy_amounts_and_casing_are_normalised(warehouse):
    con, *_ = warehouse
    types = {t for (t,) in q(con, "SELECT DISTINCT ticket_type FROM marts.fct_ticket_sales")}
    assert types == {"adult", "child", "senior", "annual_pass"}
    [(nulls,)] = q(con, "SELECT count(*) FROM staging.stg_ticket_sales WHERE gross_amount_nzd IS NULL")
    assert nulls == 0


def test_regional_holidays_only_apply_to_their_region(warehouse):
    con, *_ = warehouse
    rows = dict(q(con, """SELECT venue_id, is_public_holiday FROM marts.fct_daily_venue
                          WHERE date = DATE '2025-01-27'"""))
    assert rows["AKL-AQ"] is True       # Auckland Anniversary Day
    assert rows["WLG-SM"] is False
    national = q(con, """SELECT bool_and(is_public_holiday) FROM marts.fct_daily_venue
                         WHERE date = DATE '2025-02-06'""")
    assert national == [(True,)]         # Waitangi Day everywhere


def test_rerun_is_idempotent(warehouse):
    con, _, landing = warehouse
    before = q(con, "SELECT sum(visitors), sum(revenue_nzd) FROM marts.fct_daily_venue")
    db = con.execute("SELECT file FROM pragma_database_list WHERE name = current_database()").fetchone()[0]
    con.close()
    pipeline.run(START, END, mode="offline", db_path=db, landing_dir=landing, vendor_failure_rate=0)
    con2 = duckdb.connect(db)
    after = q(con2, "SELECT sum(visitors), sum(revenue_nzd) FROM marts.fct_daily_venue")
    [(runs,)] = q(con2, "SELECT count(*) FROM ops.pipeline_runs WHERE status = 'success'")
    con2.close()
    assert before == after and runs == 2


def test_landing_zone_keeps_raw_extracts(warehouse):
    _, summary, landing = warehouse
    for source in ("weather", "holidays", "ticket_sales"):
        assert (landing / "landing" / source / f"{summary.run_id}.ndjson").exists()


def test_failed_quality_check_rolls_back_and_is_recorded(tmp_path, monkeypatch):
    db = tmp_path / "wh.duckdb"
    pipeline.run(START, END, mode="offline", db_path=db, landing_dir=tmp_path,
                 vendor_failure_rate=0)

    always_fails = quality.Check("always_fails", "test", "SELECT 1")
    monkeypatch.setattr(quality, "CHECKS", quality.CHECKS + (always_fails,))
    with pytest.raises(quality.DataQualityError):
        pipeline.run(date(2025, 3, 1), date(2025, 3, 5), mode="offline", db_path=db,
                     landing_dir=tmp_path, vendor_failure_rate=0)

    con = duckdb.connect(str(db))
    [(max_date,)] = q(con, "SELECT max(date) FROM marts.fct_daily_venue")
    [(status,)] = q(con, "SELECT status FROM ops.pipeline_runs ORDER BY started_at DESC LIMIT 1")
    [(recorded,)] = q(con, "SELECT count(*) FROM ops.dq_results WHERE check_name = 'always_fails'")
    con.close()
    assert max_date == END          # March load was rolled back
    assert status == "failed" and recorded == 1
