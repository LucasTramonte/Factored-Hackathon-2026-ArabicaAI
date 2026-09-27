#!/usr/bin/env python3
"""
Silver build entrypoint.

Usage:
    python run_silver.py                          # build every specced Silver table
    python run_silver.py --tables customers,products
    python run_silver.py --log-level DEBUG

Exit code is 0 only if every specced table succeeded (tables not yet given a TableSpec, see
table_specs.py's PLANNED_NOT_YET_IMPLEMENTED, are reported and skipped -- they don't count as a
failure). Non-zero means at least one SPECCED table's build actually failed, so a scheduler can
detect and alert on that the same way run_ingestion.py's exit code works for Bronze.
"""
from __future__ import annotations

import argparse
import logging
import sys
from typing import List, Optional

from config import resolve_duckdb_path
from db import get_connection
from silver import FX_TABLE_NAME, SilverResult, build_fx_rates_table, build_silver_table
from table_specs import ALL_SPECS, PLANNED_NOT_YET_IMPLEMENTED

logger = logging.getLogger(__name__)


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Silver tables from Bronze.")
    parser.add_argument(
        "--tables", type=str, default=None,
        help="Comma-separated Silver table names to build, instead of all specced tables.",
    )
    parser.add_argument(
        "--log-level", type=str, default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    return parser.parse_args(argv)


def run(con, tables_filter: Optional[List[str]]) -> List[SilverResult]:
    specs = ALL_SPECS if not tables_filter else [s for s in ALL_SPECS if s.name in tables_filter]

    if tables_filter:
        known = {s.name for s in ALL_SPECS} | set(PLANNED_NOT_YET_IMPLEMENTED)
        missing = set(tables_filter) - known
        if missing:
            raise ValueError(f"Unknown table name(s) in --tables: {', '.join(sorted(missing))}")

    results: List[SilverResult] = []

    # fx_rates must exist before products/transactions run (their extra_joins reference
    # silver.fx_rates / silver.v_fx_latest_to_usd) -- built unconditionally, even when --tables
    # narrows the run to something that doesn't need it, since it's cheap (13,164 rows) and every
    # currency-bearing spec added later can then assume it's already there without each one having
    # to re-check.
    try:
        results.append(build_fx_rates_table(con))
    except Exception as e:  # noqa: BLE001 -- a failure here shouldn't silently skip every
                             # downstream table that depends on it; surface it and keep going so
                             # non-currency tables in the same run still get a chance to build.
        logger.exception("[fx_rates] build FAILED")
        results.append(SilverResult(table_name=FX_TABLE_NAME, rows=0, status="failed", error=str(e)))

    for spec in specs:
        try:
            results.append(build_silver_table(con, spec))
        except Exception as e:  # noqa: BLE001 -- one table's failure must not stop the rest.
            logger.exception("[%s] silver build FAILED", spec.name)
            results.append(SilverResult(table_name=spec.name, rows=0, status="failed", error=str(e)))

    requested_planned = (
        (set(tables_filter) & set(PLANNED_NOT_YET_IMPLEMENTED)) if tables_filter
        else set(PLANNED_NOT_YET_IMPLEMENTED)
    )
    for name in sorted(requested_planned):
        logger.warning("[%s] not yet implemented in table_specs.py -- skipped", name)
        results.append(SilverResult(table_name=name, rows=0, status="not_implemented"))

    return results


def print_summary(results: List[SilverResult]) -> None:
    print(f"\n{'table':30s} {'rows':>12s} {'status':16s}")
    print("-" * 62)
    for r in results:
        rows_str = f"{r.rows:,}" if r.status == "ok" else "-"
        print(f"{r.table_name:30s} {rows_str:>12s} {r.status:16s}")
        if r.error:
            print(f"    error: {r.error}")


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)-8s %(name)s: %(message)s")

    duckdb_path = resolve_duckdb_path()
    if not duckdb_path.exists():
        logger.error(
            "No .duckdb file at %s -- run the bronze ingestion pipeline first, or set "
            "PROJECT_ROOT/DATA_DIR/DUCKDB_PATH if it lives somewhere else.",
            duckdb_path,
        )
        return 1

    logger.info("duckdb_path=%s", duckdb_path)

    tables_filter = args.tables.split(",") if args.tables else None

    try:
        with get_connection(duckdb_path) as con:
            results = run(con, tables_filter)
    except ValueError as e:
        logger.error(str(e))
        return 1

    print_summary(results)

    failures = [r for r in results if r.status == "failed"]
    if failures:
        logger.error("%d table(s) failed", len(failures))
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
