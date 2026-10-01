#!/usr/bin/env python3
"""
Bronze ingestion entrypoint.

Usage:
    python run_ingestion.py                          # incremental run, all tables
    python run_ingestion.py --full-refresh            # re-read all history for every fact table
    python run_ingestion.py --tables transactions,customers
    python run_ingestion.py --log-level DEBUG

Exit code is 0 only if every table succeeded -- non-zero means at least one table failed, so a
scheduler (cron, Airflow, Databricks Jobs, etc.) can detect and alert on a bad run rather than
silently continuing on partial data, which the original notebook's silent try/except did not do.
"""
from __future__ import annotations

import argparse
from datetime import date
import logging
import sys
from typing import List

from dotenv import load_dotenv

from config import ALL_TABLES, Settings
from db import get_connection
from ingestion import IngestResult, ingest_dimension, ingest_fact


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest LATAM Bank tables from S3 or local CSVs into Bronze.")
    parser.add_argument("--partition-date", type=date.fromisoformat, help="Load exactly one fact partition (YYYY-MM-DD) into an isolated DuckDB.")
    parser.add_argument("--local-source", type=str, help="Root containing the supplied local CSV tables; no S3 or AWS credentials needed.")
    parser.add_argument(
        "--full-refresh", action="store_true",
        help="Re-read all available history for fact tables instead of only new partitions.",
    )
    parser.add_argument(
        "--tables", type=str, default=None,
        help="Comma-separated table names to run, instead of all configured tables.",
    )
    parser.add_argument(
        "--log-level", type=str, default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    return parser.parse_args(argv)


def run(settings: Settings, tables_filter: List[str] | None, full_refresh: bool, local_source: str | None = None, partition_date: date | None = None) -> List[IngestResult]:
    """Ingest selected tables from S3 or local CSVs into the configured Bronze store."""
    tables = ALL_TABLES if not tables_filter else [t for t in ALL_TABLES if t.name in tables_filter]

    if tables_filter:
        missing = set(tables_filter) - {t.name for t in tables}
        if missing:
            raise ValueError(f"Unknown table name(s) in --tables: {', '.join(sorted(missing))}")

    results: List[IngestResult] = []
    base_path = local_source or settings.base_s3_path()
    data_dir = str(settings.data_dir)

    with get_connection(settings, use_s3=local_source is None) as con:
        for table in tables:
            try:
                if table.kind == "dimension":
                    result = ingest_dimension(con, base_path, table.name, data_dir=data_dir)
                else:
                    result = ingest_fact(
                        con, base_path, table.name, full_refresh=full_refresh, data_dir=data_dir, partition_date=partition_date
                    )
            except Exception as e:  # noqa: BLE001 -- intentionally broad: one table's failure
                                     # must not stop the rest, but must be visible in the summary.
                logging.getLogger(__name__).exception("[%s] ingestion FAILED", table.name)
                result = IngestResult(table_name=table.name, kind=table.kind, rows=0,
                                       status="failed", error=str(e))
            results.append(result)

    return results


def print_summary(results: List[IngestResult]) -> None:
    print(f"\n{'table':30s} {'kind':10s} {'rows':>12s} {'status':10s}")
    print("-" * 66)
    for r in results:
        rows_str = f"{r.rows:,}" if r.status != "failed" else "-"
        print(f"{r.table_name:30s} {r.kind:10s} {rows_str:>12s} {r.status:10s}")
        if r.late_partitions:
            print(f"    late partitions loaded: {r.late_partitions} (older than the watermark, never loaded before)")
        if r.error:
            print(f"    error: {r.error}")


def main(argv: List[str] | None = None) -> int:
    load_dotenv()
    args = parse_args(argv if argv is not None else sys.argv[1:])
    logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)-8s %(name)s: %(message)s")

    tables_filter = args.tables.split(",") if args.tables else None

    try:
        settings = Settings.from_env(require_s3=args.local_source is None)
    except RuntimeError as e:
        logging.getLogger(__name__).error(str(e))
        return 1

    # Resolved paths are logged every run -- since they now depend on where the script lives
    # rather than the launching shell's CWD, this is the quickest way to confirm the pipeline
    # picked the folder layout you expect (or to spot a bad PROJECT_ROOT/DATA_DIR override).
    logging.getLogger(__name__).info(
        "project_root=%s  data_dir=%s  duckdb_path=%s",
        settings.project_root, settings.data_dir, settings.duckdb_path,
    )

    results = run(settings, tables_filter, args.full_refresh, args.local_source, args.partition_date)
    print_summary(results)

    failures = [r for r in results if r.status in {"failed", "no_data_found"}]
    if failures:
        logging.getLogger(__name__).error("%d of %d tables failed", len(failures), len(results))
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
