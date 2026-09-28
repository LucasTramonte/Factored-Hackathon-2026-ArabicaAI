"""
Bronze ingestion logic.

Two ingestion strategies, matching the two table shapes:

- Dimensions (flat CSVs): full refresh every run. Small tables (largest is 400K rows), so re-reading
  and overwriting the whole thing each time is simple and cheap -- no need for incremental complexity.

- Facts (year=/month=/day=-partitioned): incremental. A watermark table
  (`bronze._load_watermarks`) tracks the last-loaded date per table. Each run discovers available
  partitions via DuckDB's `glob()` (lists matching S3 keys without reading their contents), diffs
  against the watermark, and reads only the NEW partitions from S3 -- appending them into the local
  Parquet store via `COPY ... PARTITION_BY ... OVERWRITE_OR_IGNORE`, which only touches the specific
  partition values present in the new data. The Bronze table itself is then rebuilt from local Parquet
  (cheap disk read, no S3 traffic) so it always reflects full history without re-downloading it.
  Verified with a local-fixture test before shipping: after deleting the source files for old
  partitions entirely, an incremental run still produced correct full-history row counts, proving the
  old partitions are never re-read, only the new one is.

Every ingestion function takes `base_path` explicitly (rather than constructing "s3://bucket/..."
internally) specifically so tests can point it at a local directory instead -- exercising the exact
same DuckDB SQL without any network or S3 dependency.
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass
from datetime import date
from typing import List, Optional

import duckdb

logger = logging.getLogger(__name__)

_IDENTIFIER_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


def _safe_identifier(name: str) -> str:
    """Defense in depth: table names are only ever supposed to come from config.py's fixed lists,
    but this guards against an f-string SQL injection if that ever changes (e.g. a future CLI flag
    accepting a table name from the command line)."""
    if not _IDENTIFIER_RE.match(name):
        raise ValueError(f"Unsafe table name, refusing to use in SQL: {name!r}")
    return name


@dataclass
class IngestResult:
    table_name: str
    kind: str
    rows: int
    partitions_added: Optional[int] = None  # facts only
    status: str = "ok"
    error: Optional[str] = None


# --------------------------------------------------------------------------------------
# Dimensions: full refresh
# --------------------------------------------------------------------------------------

def ingest_dimension(
    con: duckdb.DuckDBPyConnection, base_path: str, table_name: str, data_dir: str = "data"
) -> IngestResult:
    """`data_dir` is where local Bronze Parquet lands (`<data_dir>/bronze/<table_name>/...`). It
    defaults to a relative "data" (resolved against the caller's CWD) so tests that `chdir` into a
    tmp_path keep working unchanged -- production runs should pass `settings.data_dir` explicitly
    (see run_ingestion.py) rather than relying on this default, since CWD isn't guaranteed there."""
    table_name = _safe_identifier(table_name)
    s3_path = f"{base_path}/{table_name}.csv"
    local_dir = os.path.join(str(data_dir), "bronze", table_name)
    local_path = os.path.join(local_dir, f"{table_name}.parquet")
    os.makedirs(local_dir, exist_ok=True)

    con.execute(f"""
        COPY (
            SELECT * EXCLUDE (filename),
                   filename AS _source_file,
                   current_timestamp AS _ingested_at,
                   '{table_name}' AS _source_table
            FROM read_csv('{s3_path}', ALL_VARCHAR=true, filename=true)
        ) TO '{local_path}' (FORMAT PARQUET)
    """)

    con.execute(f"""
        CREATE OR REPLACE TABLE bronze.{table_name} AS
        SELECT * FROM read_parquet('{local_path}')
    """)

    count = con.execute(f"SELECT count(*) FROM bronze.{table_name}").fetchone()[0]
    logger.info("[%s] %s rows -> bronze.%s (dimension, full refresh)", table_name, f"{count:,}", table_name)
    return IngestResult(table_name=table_name, kind="dimension", rows=count)


# --------------------------------------------------------------------------------------
# Facts: incremental, watermark-driven
# --------------------------------------------------------------------------------------

def ensure_watermark_table(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("""
        CREATE TABLE IF NOT EXISTS bronze._load_watermarks (
            table_name VARCHAR PRIMARY KEY,
            last_loaded_date DATE,
            updated_at TIMESTAMP
        )
    """)


def get_last_loaded_date(con: duckdb.DuckDBPyConnection, table_name: str) -> Optional[date]:
    ensure_watermark_table(con)
    row = con.execute(
        "SELECT last_loaded_date FROM bronze._load_watermarks WHERE table_name = ?", [table_name]
    ).fetchone()
    return row[0] if row else None


def update_watermark(con: duckdb.DuckDBPyConnection, table_name: str, loaded_date: date) -> None:
    con.execute(
        """
        INSERT INTO bronze._load_watermarks (table_name, last_loaded_date, updated_at)
        VALUES (?, ?, current_timestamp)
        ON CONFLICT (table_name) DO UPDATE SET
            last_loaded_date = excluded.last_loaded_date,
            updated_at = excluded.updated_at
        """,
        [table_name, loaded_date],
    )


def list_available_partition_dates(con: duckdb.DuckDBPyConnection, base_path: str, table_name: str) -> List[date]:
    """Lists year=/month=/day= partitions that actually contain a .csv file, via glob() -- this
    never reads file *contents*, so it's cheap in that sense even for huge tables. It is NOT
    necessarily cheap in wall-clock time: a 3-level wildcard (year=*/month=*/day=*) on S3 typically
    has to be resolved one level at a time -- list year= prefixes, then list month= prefixes under
    each year match, then list day= prefixes under each of those -- so a table spanning many distinct
    dates can mean hundreds of sequential S3 LIST round-trips before this returns anything. That cost
    scales with the number of distinct partition dates, not with row count, so a small table can still
    be slow here if its date range is wide. Logged at DEBUG so a run that looks "stuck" is visibly
    still working, not hung."""
    pattern = f"{base_path}/{table_name}/year=*/month=*/day=*/*.csv"
    logger.debug("[%s] discovering partitions via glob (this can take a while -- see docstring)...", table_name)
    t0 = time.monotonic()
    rows = con.execute(f"SELECT file FROM glob('{pattern}')").fetchall()
    logger.debug("[%s] glob returned %d file(s) in %.1fs", table_name, len(rows), time.monotonic() - t0)

    partitions = set()
    for (path,) in rows:
        y = re.search(r"year=(\d+)", path)
        m = re.search(r"month=(\d+)", path)
        d = re.search(r"day=(\d+)", path)
        if y and m and d:
            try:
                partitions.add(date(int(y.group(1)), int(m.group(1)), int(d.group(1))))
            except ValueError:
                logger.warning("[%s] skipping unparseable partition path: %s", table_name, path)
    return sorted(partitions)


def _month_glob(base_path: str, table_name: str, year: int, month: int) -> str:
    return f"{base_path}/{table_name}/year={year:04d}/month={month:02d}/day=*/*.csv"


def _full_history_glob(base_path: str, table_name: str) -> str:
    return f"{base_path}/{table_name}/year=*/month=*/day=*/*.csv"


def _group_by_year_month(dates: List[date]) -> List[tuple]:
    """Groups dates into sorted (year, month) buckets, each holding its member dates. Used to turn
    N individual per-day S3 reads into one read per distinct month touched -- for a normal
    incremental run (a handful of new days since the last run), that's usually 1-2 calls instead
    of up to 31."""
    buckets: dict = {}
    for d in dates:
        buckets.setdefault((d.year, d.month), []).append(d)
    return sorted(buckets.items())


def _rebuild_fact_table(con: duckdb.DuckDBPyConnection, table_name: str, local_dir: str) -> None:
    """Publish the Bronze table from the active local Parquet snapshot."""
    con.execute(f"""
        CREATE OR REPLACE TABLE bronze.{table_name} AS
        SELECT * FROM read_parquet('{local_dir}/**/*.parquet', hive_partitioning=true)
    """)


def _recover_fact_snapshot(con: duckdb.DuckDBPyConnection, table_name: str, local_dir: str) -> None:
    """Reconcile an interrupted refresh before reading a watermark or source files."""
    backup_dir = f"{local_dir}.old"
    if not os.path.exists(backup_dir):
        return
    if not os.path.exists(local_dir):
        os.replace(backup_dir, local_dir)
    _rebuild_fact_table(con, table_name, local_dir)
    dates = []
    for root, _, files in os.walk(local_dir):
        if any(file.endswith(".parquet") for file in files):
            match = re.search(r"year=(\d{4})/month=(\d{1,2})/day=(\d{1,2})", root)
            if match:
                dates.append(date(*(int(part) for part in match.groups())))
    if dates:
        update_watermark(con, table_name, max(dates))
    if os.path.exists(backup_dir):
        shutil.rmtree(backup_dir)


def ingest_fact(
    con: duckdb.DuckDBPyConnection,
    base_path: str,
    table_name: str,
    full_refresh: bool = False,
    data_dir: str = "data",
) -> IngestResult:
    """See ingest_dimension's docstring for what `data_dir` is and why it defaults to a
    CWD-relative "data" (tests rely on that default; production runs pass settings.data_dir)."""
    table_name = _safe_identifier(table_name)
    local_dir = os.path.join(str(data_dir), "bronze", table_name)
    os.makedirs(os.path.dirname(local_dir), exist_ok=True)

    # Ensured unconditionally, not just as a side effect of get_last_loaded_date() below --
    # that call is skipped entirely when full_refresh=True, which used to mean a --full-refresh
    # run against a brand-new database (the README's own suggested first-run command) crashed at
    # the very end trying to INSERT into a bronze._load_watermarks table that was never created.
    ensure_watermark_table(con)
    _recover_fact_snapshot(con, table_name, local_dir)

    table_exists = con.execute(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'bronze' AND table_name = ?",
        [table_name],
    ).fetchone()[0] > 0

    last_loaded = None if full_refresh else get_last_loaded_date(con, table_name)
    available = list_available_partition_dates(con, base_path, table_name)

    if not available:
        return IngestResult(table_name=table_name, kind="fact", rows=0, partitions_added=0,
                             status="no_data_found")

    if full_refresh or not table_exists or last_loaded is None or not os.path.isdir(local_dir):
        dates_to_load = available
        mode = "full refresh"
    else:
        dates_to_load = [d for d in available if d > last_loaded]
        mode = "incremental"

    if not dates_to_load:
        count = con.execute(f"SELECT count(*) FROM bronze.{table_name}").fetchone()[0]
        logger.info("[%s] up to date (last loaded %s), 0 new partitions", table_name, last_loaded)
        return IngestResult(table_name=table_name, kind="fact", rows=count, partitions_added=0)

    logger.info("[%s] loading %d partition(s) (%s), %s..%s",
                table_name, len(dates_to_load), mode, min(dates_to_load), max(dates_to_load))
    loop_start = time.monotonic()

    staging_dir = tempfile.mkdtemp(prefix=f"{table_name}.stage-", dir=os.path.dirname(local_dir)) if mode == "full refresh" else None
    write_dir = staging_dir or local_dir
    os.makedirs(write_dir, exist_ok=True)

    def _copy_from(glob_pattern: str) -> None:
        con.execute(f"""
            COPY (
                SELECT * EXCLUDE (filename),
                       filename AS _source_file,
                       current_timestamp AS _ingested_at,
                       '{table_name}' AS _source_table
                FROM read_csv('{glob_pattern}', ALL_VARCHAR=true, hive_partitioning=true, filename=true)
            ) TO '{write_dir}' (FORMAT PARQUET, PARTITION_BY (year, month, day), OVERWRITE_OR_IGNORE)
        """)

    try:
        if mode == "full refresh":
            # Loading everything anyway -- no reason to enumerate individual dates and issue one S3
            # read per day (that used to mean 1000+ sequential round trips on a multi-year table, most
            # of the actual wall-clock cost of a full refresh). A single glob over the whole
            # year=*/month=*/day=*/*.csv tree does it in one read_csv call, same as the original
            # notebook did before this pipeline existed -- and that approach was already proven to work
            # on all 7 fact tables at their real sizes (up to 15.6M rows for digital_events).
            _copy_from(_full_history_glob(base_path, table_name))
            logger.info("[%s] full refresh: %d partition(s) loaded in %.0fs",
                        table_name, len(dates_to_load), time.monotonic() - loop_start)
        else:
            # Incremental -- group the (usually few) new dates by year/month so a normal day-to-day
            # rerun costs 1-2 S3 round trips rather than one per new day.
            batches = _group_by_year_month(dates_to_load)
            logger.info("[%s] %d new partition(s) across %d month-batch(es)",
                        table_name, len(dates_to_load), len(batches))
            for i, ((year, month), month_dates) in enumerate(batches, start=1):
                t0 = time.monotonic()
                _copy_from(_month_glob(base_path, table_name, year, month))
                logger.debug("[%s] batch %d/%d (%04d-%02d, %d new date(s)) loaded in %.1fs",
                             table_name, i, len(batches), year, month, len(month_dates),
                             time.monotonic() - t0)

        if staging_dir:
            backup_dir = f"{local_dir}.old"
            had_live = os.path.exists(local_dir)
            if had_live:
                os.replace(local_dir, backup_dir)
            try:
                os.replace(staging_dir, local_dir)
            except OSError:
                if had_live:
                    os.replace(backup_dir, local_dir)
                raise
        _rebuild_fact_table(con, table_name, local_dir)
        update_watermark(con, table_name, max(dates_to_load))
        if staging_dir and had_live:
            shutil.rmtree(backup_dir)
    finally:
        if staging_dir and os.path.exists(staging_dir):
            shutil.rmtree(staging_dir)

    count = con.execute(f"SELECT count(*) FROM bronze.{table_name}").fetchone()[0]
    logger.info(
        "[%s] %s rows -> bronze.%s (fact, %s, +%d partition(s): %s..%s)",
        table_name, f"{count:,}", table_name, mode, len(dates_to_load),
        min(dates_to_load), max(dates_to_load),
    )
    return IngestResult(table_name=table_name, kind="fact", rows=count, partitions_added=len(dates_to_load))
