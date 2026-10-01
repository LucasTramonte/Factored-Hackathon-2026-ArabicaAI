"""
Tests run entirely against local files, standing in for S3 -- `read_csv`/`glob` behave identically
on local paths and `s3://` paths, so this exercises the real ingestion SQL without any network
dependency or S3 credentials. This is why every ingestion function takes `base_path` as a parameter
instead of constructing it internally.
"""
import os
import sys

import duckdb
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ingestion import (
    IngestResult,
    _safe_identifier,
    get_last_loaded_date,
    ingest_dimension,
    ingest_fact,
    list_available_partition_dates,
)


@pytest.fixture
def con(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    connection = duckdb.connect(":memory:")
    connection.execute("CREATE SCHEMA IF NOT EXISTS bronze;")
    yield connection
    connection.close()


def _write_csv(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(rows)


# --------------------------------------------------------------------------------------
# Dimension ingestion
# --------------------------------------------------------------------------------------

def test_ingest_dimension_reads_flat_csv(con, tmp_path):
    _write_csv(tmp_path / "source/customers.csv", "customer_id,segment\nC1,Premium\nC2,Basic\n")

    result = ingest_dimension(con, str(tmp_path / "source"), "customers")

    assert result.rows == 2
    assert result.status == "ok"
    result_rows = con.execute("SELECT customer_id, _source_table FROM bronze.customers ORDER BY customer_id").fetchall()
    assert result_rows == [("C1", "customers"), ("C2", "customers")]
    assert con.execute("SELECT COUNT(*) FROM bronze.customers WHERE _ingested_at IS NULL").fetchone()[0] == 0


def test_ingest_dimension_full_overwrite_on_rerun(con, tmp_path):
    _write_csv(tmp_path / "source/branches.csv", "branch_id\nB1\nB2\n")
    ingest_dimension(con, str(tmp_path / "source"), "branches")

    # source shrinks -- a real full-refresh dimension load should reflect that, not accumulate
    _write_csv(tmp_path / "source/branches.csv", "branch_id\nB1\n")
    result = ingest_dimension(con, str(tmp_path / "source"), "branches")

    assert result.rows == 1


# --------------------------------------------------------------------------------------
# Fact ingestion: full load, incremental, idempotency
# --------------------------------------------------------------------------------------

def test_ingest_fact_first_run_loads_all_available_partitions(con, tmp_path):
    base = tmp_path / "source"
    _write_csv(base / "transactions/year=2024/month=01/day=01/t.csv", "transaction_id,amount\nT1,100\nT2,200\n")
    _write_csv(base / "transactions/year=2024/month=01/day=02/t.csv", "transaction_id,amount\nT3,300\n")

    result = ingest_fact(con, str(base), "transactions")

    assert result.rows == 3
    assert result.partitions_added == 2
    assert get_last_loaded_date(con, "transactions").isoformat() == "2024-01-02"


def test_ingest_fact_incremental_run_only_reads_new_partition(con, tmp_path):
    base = tmp_path / "source"
    _write_csv(base / "transactions/year=2024/month=01/day=01/t.csv", "transaction_id,amount\nT1,100\nT2,200\n")
    _write_csv(base / "transactions/year=2024/month=01/day=02/t.csv", "transaction_id,amount\nT3,300\n")
    ingest_fact(con, str(base), "transactions")

    # Add a new day, then delete the OLD source files entirely -- if the incremental step needs
    # them, this test fails; it should only need the new day's file.
    _write_csv(base / "transactions/year=2024/month=01/day=03/t.csv", "transaction_id,amount\nT4,400\nT5,500\n")
    import shutil
    shutil.rmtree(base / "transactions/year=2024/month=01/day=01")
    shutil.rmtree(base / "transactions/year=2024/month=01/day=02")

    result = ingest_fact(con, str(base), "transactions")

    assert result.partitions_added == 1
    assert result.rows == 5  # 2 + 1 + 2 -- old partitions preserved from local Parquet
    assert get_last_loaded_date(con, "transactions").isoformat() == "2024-01-03"


def test_ingest_fact_rerun_with_no_new_partitions_is_a_noop(con, tmp_path):
    base = tmp_path / "source"
    _write_csv(base / "complaints/year=2024/month=01/day=01/c.csv", "complaint_id\nX1\n")
    ingest_fact(con, str(base), "complaints")

    result = ingest_fact(con, str(base), "complaints")

    assert result.partitions_added == 0
    assert result.rows == 1


def test_ingest_fact_full_refresh_flag_rereads_everything(con, tmp_path):
    base = tmp_path / "source"
    _write_csv(base / "complaints/year=2024/month=01/day=01/c.csv", "complaint_id\nX1\n")
    _write_csv(base / "complaints/year=2024/month=01/day=02/c.csv", "complaint_id\nX2\n")
    ingest_fact(con, str(base), "complaints")

    result = ingest_fact(con, str(base), "complaints", full_refresh=True)

    assert result.partitions_added == 2  # re-read both, not just anything "new"
    assert result.rows == 2


def test_ingest_fact_incremental_batches_new_dates_across_months(con, tmp_path):
    """New dates spanning two different months should still all be picked up -- this is the case
    the year/month batching (added after a real full-refresh run on 1,097 daily partitions turned
    out to be issuing one S3 read per day) has to get right: grouping by month must not silently
    drop a month with only one new date in it."""
    base = tmp_path / "source"
    _write_csv(base / "complaints/year=2024/month=01/day=31/c.csv", "complaint_id\nX1\n")
    ingest_fact(con, str(base), "complaints")

    # New data lands in two different months -- Jan (one more day) and Feb (one day)
    _write_csv(base / "complaints/year=2024/month=02/day=01/c.csv", "complaint_id\nX2\n")
    _write_csv(base / "complaints/year=2024/month=02/day=02/c.csv", "complaint_id\nX3\n")
    result = ingest_fact(con, str(base), "complaints")

    assert result.partitions_added == 2  # two new dates, even though they land in one month-batch
    assert result.rows == 3  # 1 old + 2 new
    assert get_last_loaded_date(con, "complaints").isoformat() == "2024-02-02"


class _CountingConnectionProxy:
    """Wraps a real DuckDB connection to count COPY (...) calls, since duckdb's own connection
    object doesn't allow monkeypatching .execute directly (it's a read-only C-extension attribute).
    ingest_fact only needs .execute() and .fetchone()-via-.execute() chains, both delegated as-is."""

    def __init__(self, real_con):
        self._real_con = real_con
        self.copy_call_count = 0

    def execute(self, sql, *args, **kwargs):
        if sql.strip().startswith("COPY ("):
            self.copy_call_count += 1
        return self._real_con.execute(sql, *args, **kwargs)


def test_ingest_fact_full_refresh_on_many_daily_partitions_is_one_call_not_one_per_day(con, tmp_path):
    """Regression test for the real slowdown this was built to fix: a full refresh used to issue
    one COPY/read_csv per partition date. For a table with many daily partitions (1,097 in the
    case that surfaced this), that meant over a thousand sequential S3 round trips. Full refresh
    should now be a single glob covering the whole table instead."""
    base = tmp_path / "source"
    for day in range(1, 6):
        _write_csv(base / f"complaints/year=2024/month=01/day={day:02d}/c.csv", f"complaint_id\nX{day}\n")

    proxy = _CountingConnectionProxy(con)
    result = ingest_fact(proxy, str(base), "complaints", full_refresh=True)

    assert proxy.copy_call_count == 1  # one COPY for all 5 days, not five
    assert result.rows == 5
    assert result.partitions_added == 5


def test_ingest_fact_with_no_data_found_does_not_crash(con, tmp_path):
    base = tmp_path / "source"
    os.makedirs(base, exist_ok=True)  # empty -- no partitions at all

    result = ingest_fact(con, str(base), "campaign_sends")

    assert result.status == "no_data_found"
    assert result.rows == 0


# --------------------------------------------------------------------------------------
# Partition discovery
# --------------------------------------------------------------------------------------

def test_list_available_partition_dates_parses_correctly(con, tmp_path):
    base = tmp_path / "source"
    _write_csv(base / "digital_events/year=2023/month=06/day=17/d.csv", "event_id\nE1\n")
    _write_csv(base / "digital_events/year=2024/month=12/day=05/d.csv", "event_id\nE2\n")

    dates = list_available_partition_dates(con, str(base), "digital_events")

    assert [d.isoformat() for d in dates] == ["2023-06-17", "2024-12-05"]


# --------------------------------------------------------------------------------------
# Safety
# --------------------------------------------------------------------------------------

@pytest.mark.parametrize("bad_name", ["x; DROP TABLE bronze.customers", "table-with-dash", "1_leading_digit", ""])
def test_safe_identifier_rejects_unsafe_names(bad_name):
    with pytest.raises(ValueError):
        _safe_identifier(bad_name)


def test_safe_identifier_accepts_normal_names():
    assert _safe_identifier("digital_events") == "digital_events"
    assert _safe_identifier("_load_watermarks") == "_load_watermarks"


def test_full_refresh_replaces_changed_and_removed_source_partitions(con, tmp_path):
    """A rebuild reflects the current source snapshot, including corrected old days."""
    base = tmp_path / "source"
    first = base / "transactions/year=2024/month=01/day=01/t.csv"
    second = base / "transactions/year=2024/month=01/day=02/t.csv"
    _write_csv(first, "transaction_id,amount\nT1,100\n")
    _write_csv(second, "transaction_id,amount\nT2,200\n")
    ingest_fact(con, str(base), "transactions", data_dir=str(tmp_path / "out"))
    _write_csv(first, "transaction_id,amount\nT1,150\nT3,300\n")
    second.unlink()
    result = ingest_fact(con, str(base), "transactions", full_refresh=True, data_dir=str(tmp_path / "out"))
    assert result.rows == 2
    assert con.execute("SELECT transaction_id, amount FROM bronze.transactions ORDER BY transaction_id").fetchall() == [("T1", "150"), ("T3", "300")]


def test_refresh_rename_failure_keeps_old_table_and_files(con, tmp_path, monkeypatch):
    from ingestion import os as ingestion_os
    base = tmp_path / "source"
    out = tmp_path / "out"
    file = base / "transactions/year=2024/month=01/day=01/t.csv"
    _write_csv(file, "transaction_id,amount\nT1,100\n")
    ingest_fact(con, str(base), "transactions", data_dir=str(out))
    _write_csv(file, "transaction_id,amount\nT1,200\n")
    real_replace = ingestion_os.replace
    def fail_stage(src, dst):
        if ".stage-" in str(src):
            raise OSError("simulated rename failure")
        return real_replace(src, dst)
    monkeypatch.setattr(ingestion_os, "replace", fail_stage)
    with pytest.raises(OSError, match="simulated rename failure"):
        ingest_fact(con, str(base), "transactions", full_refresh=True, data_dir=str(out))
    assert con.execute("SELECT amount FROM bronze.transactions").fetchone()[0] == "100"
    assert con.execute(f"SELECT amount FROM read_parquet('{out}/bronze/transactions/**/*.parquet')").fetchone()[0] == "100"


def test_restart_reconciles_swapped_snapshot_before_source_lookup(con, tmp_path):
    from ingestion import _rebuild_fact_table
    base = tmp_path / "source"
    out = tmp_path / "out"
    file = base / "transactions/year=2024/month=01/day=01/t.csv"
    _write_csv(file, "transaction_id,amount\nT1,100\n")
    ingest_fact(con, str(base), "transactions", data_dir=str(out))
    live = out / "bronze" / "transactions"
    backup = out / "bronze" / "transactions.old"
    os.replace(live, backup)
    _write_csv(file, "transaction_id,amount\nT1,200\n")
    ingest_fact(con, str(base), "transactions", full_refresh=True, data_dir=str(tmp_path / "new"))
    os.replace(tmp_path / "new" / "bronze" / "transactions", live)
    # Simulate the persisted database from before the swap.
    _rebuild_fact_table(con, "transactions", str(backup))
    file.unlink()
    result = ingest_fact(con, str(base), "transactions", data_dir=str(out))
    assert result.status == "no_data_found"
    assert con.execute("SELECT amount FROM bronze.transactions").fetchone()[0] == "200"
    assert not backup.exists()


def test_restart_restores_backup_when_live_directory_is_missing(con, tmp_path):
    base = tmp_path / "source"
    out = tmp_path / "out"
    _write_csv(base / "transactions/year=2024/month=01/day=01/t.csv",
               "transaction_id,amount\nT1,100\n")
    ingest_fact(con, str(base), "transactions", data_dir=str(out))
    live = out / "bronze" / "transactions"
    backup = out / "bronze" / "transactions.old"
    os.replace(live, backup)
    result = ingest_fact(con, str(base), "transactions", data_dir=str(out))
    assert result.rows == 1
    assert live.exists()
    assert not backup.exists()
    assert con.execute("SELECT amount FROM bronze.transactions").fetchone()[0] == "100"


def test_scoped_fact_load_uses_only_selected_day_and_rejects_mixed_refresh(con, tmp_path):
    from datetime import date
    base = tmp_path / "source"
    _write_csv(base / "transactions/year=2026/month=02/day=26/t.csv", "transaction_id,amount\nT1,10\n")
    _write_csv(base / "transactions/year=2026/month=02/day=27/t.csv", "transaction_id,amount\nT2,20\n")
    selected = date(2026, 2, 26)
    result = ingest_fact(con, str(base), "transactions", partition_date=selected)
    assert result.rows == 1
    assert con.execute("SELECT transaction_id FROM bronze.transactions").fetchall() == [("T1",)]
    assert ingest_fact(con, str(base), "transactions", partition_date=selected).partitions_added == 0
    with pytest.raises(ValueError, match="isolated one-day"):
        ingest_fact(con, str(base), "transactions", partition_date=date(2026, 2, 27))
    with pytest.raises(ValueError, match="discard"):
        ingest_fact(con, str(base), "transactions", partition_date=date(2026, 2, 27), full_refresh=True)


def test_scoped_load_never_replaces_a_parquet_history_it_does_not_own(con, tmp_path):
    """A fresh DuckDB pointed at a DATA_DIR that already holds other days must refuse, not overwrite."""
    from datetime import date
    base = tmp_path / "source"
    for day, tx in (("25", "T0"), ("26", "T1"), ("27", "T2")):
        _write_csv(base / f"transactions/year=2026/month=02/day={day}/t.csv", f"transaction_id,amount\n{tx},10\n")
    assert ingest_fact(con, str(base), "transactions").partitions_added == 3
    live = tmp_path / "data/bronze/transactions"
    before = sorted(p.relative_to(live).as_posix() for p in live.rglob("*.parquet"))
    fresh = duckdb.connect(":memory:")
    fresh.execute("CREATE SCHEMA bronze")
    with pytest.raises(ValueError, match="isolated DATA_DIR"):
        ingest_fact(fresh, str(base), "transactions", partition_date=date(2026, 2, 26))
    assert sorted(p.relative_to(live).as_posix() for p in live.rglob("*.parquet")) == before


def test_incremental_run_reads_partitions_whose_paths_are_not_zero_padded(con, tmp_path):
    # The path contract is year=/month=/day= without a padding rule: discovery accepts day=1, so the
    # incremental read must use the discovered directory, not a rebuilt day=01 that matches no file.
    base = tmp_path / "source"
    _write_csv(base / "transactions/year=2024/month=1/day=1/t.csv", "transaction_id,amount\nT1,100\n")
    ingest_fact(con, str(base), "transactions")
    _write_csv(base / "transactions/year=2024/month=1/day=2/t.csv", "transaction_id,amount\nT2,200\n")
    _write_csv(base / "transactions/year=2024/month=1/day=15/t.csv", "transaction_id,amount\nT3,300\n")

    result = ingest_fact(con, str(base), "transactions")

    assert result.partitions_added == 2
    assert result.rows == 3
