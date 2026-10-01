#!/usr/bin/env python3
"""
Gold build entrypoint.

Usage:
    python -m data_pipelines.gold.run_gold                          # build every Gold table
    python -m data_pipelines.gold.run_gold --tables customers       # build a subset (comma-separated)
    python -m data_pipelines.gold.run_gold --quality-report data/quality_runs/<run>/quality_results.json
    python -m data_pipelines.gold.run_gold --silver-db <file> --gold-db <file>
    python -m data_pipelines.gold.run_gold --list                   # list the Gold tables; build nothing
    python -m data_pipelines.gold.run_gold --last                   # show the last committed build; build nothing
    python -m data_pipelines.gold.run_gold --log-level DEBUG

``python data_pipelines/gold/run_gold.py ...`` works too. Paths default to ``DUCKDB_PATH`` and
``GOLD_DUCKDB_PATH``, or to ``latam_bank.duckdb`` and ``latam_bank_gold.duckdb`` under ``DATA_DIR``
(default ``<repo>/data``). Without ``--quality-report`` the newest quality run written for the
Silver file is used; the gate still checks it in full.

Exit code is 0 only if the quality gate passed and every check of every requested table passed.
Any failure rolls the whole build back, so the previous Gold tables stay in place and a scheduler
can alert on the nonzero exit, as for Bronze and Silver.
"""
from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path
import sys
from typing import List, Optional

import duckdb

if __package__:
    from . import build_gold as gb
else:  # direct script execution
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from data_pipelines.gold import build_gold as gb

logger = logging.getLogger(__name__)
REPO_ROOT = Path(__file__).resolve().parents[2]


def default_paths() -> tuple[Path, Path]:
    """Silver and Gold DuckDB paths from the environment, as the Makefile and Silver use them."""
    data_dir = Path(os.environ.get("DATA_DIR") or REPO_ROOT / "data")
    silver = Path(os.environ.get("DUCKDB_PATH") or data_dir / "latam_bank.duckdb")
    gold = Path(os.environ.get("GOLD_DUCKDB_PATH") or data_dir / "latam_bank_gold.duckdb")
    return silver, gold


def parse_args(argv: List[str]) -> argparse.Namespace:
    silver, gold = default_paths()
    parser = argparse.ArgumentParser(description="Build Gold serving tables from quality-gated Silver.")
    parser.add_argument("--tables", type=str, default=None,
                        help=f"Comma-separated Gold tables to build, instead of all: {','.join(gb.BUILDERS)}.")
    parser.add_argument("--silver-db", type=Path, default=silver, help=f"Silver DuckDB, read-only (default {silver}).")
    parser.add_argument("--gold-db", type=Path, default=gold, help=f"Gold DuckDB to write (default {gold}).")
    parser.add_argument("--quality-report", type=Path, default=None,
                        help="quality_results.json to gate on (default: newest run for --silver-db).")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--list", action="store_true", help="List the Gold tables and what they need; build nothing.")
    mode.add_argument("--last", action="store_true", help="Show the last committed build and its checks; build nothing.")
    parser.add_argument("--log-level", type=str, default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    return parser.parse_args(argv)


def resolve_tables(tables_arg: Optional[str]) -> tuple[str, ...]:
    """Requested tables in build order; unknown names are an error, not a silent skip."""
    if not tables_arg:
        return tuple(gb.BUILDERS)
    requested = [t.strip() for t in tables_arg.split(",") if t.strip()]
    unknown = sorted(set(requested) - gb.BUILDERS.keys())
    if unknown:
        raise ValueError(f"Unknown table name(s) in --tables: {', '.join(unknown)}")
    return tuple(t for t in gb.BUILDERS if t in requested)


def print_tables() -> None:
    """Each Gold table, its grain and the quality-run tables it is gated on."""
    print(f"\n{'table':20s} {'gated on':34s} grain")
    print("-" * 100)
    for name, (builder, needs) in gb.BUILDERS.items():
        print(f"{name:20s} {','.join(sorted(needs)):34s} {builder.__doc__.strip().splitlines()[0]}")


def print_last(gold_db: Path) -> int:
    """The newest committed build: its inputs, current row counts and every check."""
    if not gold_db.exists():
        logger.error("No Gold DuckDB at %s -- run a build first.", gold_db)
        return 1
    with duckdb.connect(str(gold_db), read_only=True) as con:
        last = con.execute("SELECT build_id, silver_database, quality_generated_at_utc, tables FROM gold.builds "
                           "ORDER BY build_id DESC LIMIT 1").fetchone()
        if last is None:
            logger.error("No committed Gold build in %s.", gold_db)
            return 1
        build_id, silver, quality_at, tables = last
        print(f"build_id={build_id}\nsilver={silver}\nquality_generated_at_utc={quality_at}")
        print_summary(con, tables, con.execute(
            "SELECT table_name, check_name, expected, actual FROM gold.reconciliation WHERE build_id = ? "
            "ORDER BY table_name, check_name", [build_id]).fetchall(), verbose=True)
    return 0


def print_summary(con, tables, checks, verbose: bool = False) -> None:
    """Rows and passed checks per table; with ``verbose``, every check's expected and actual value."""
    print(f"\n{'table':20s} {'rows':>12s} {'checks':>8s}")
    print("-" * 42)
    for table in tables:
        own = [c for c in checks if c[0] == table]
        rows = con.execute(f"SELECT count(*) FROM gold.{table}").fetchone()[0]
        passed = sum(1 for c in own if c[2] == c[3])
        print(f"{table:20s} {rows:>12,} {passed:>4}/{len(own):<3}")
        if verbose:
            for _, name, expected, actual in own:
                print(f"    {name:40s} expected {expected:>10,}  actual {actual:>10,}")


def run(silver_db: Path, gold_db: Path, tables: tuple[str, ...], quality_report: Optional[Path]) -> int:
    """Gate, build atomically and print the summary; 1 on any failure (Gold left as it was)."""
    if not silver_db.exists():
        logger.error("No Silver DuckDB at %s -- run the Silver build and quality gate first.", silver_db)
        return 1
    report = quality_report or gb.latest_quality_report(silver_db, silver_db.parent / "quality_runs")
    needed = set().union(*(gb.BUILDERS[t][1] for t in tables))
    logger.info("silver=%s gold=%s quality_report=%s tables=%s", silver_db, gold_db, report, ",".join(tables))
    quality = gb.check_quality(silver_db, report, needed)
    with gb.connect(gold_db, silver_db) as con:
        build_id, checks = gb.build(con, tables, silver_db, quality)
        logger.info("committed build %s", build_id)
        print_summary(con, tables, [(c.table, c.name, c.expected, c.actual) for c in checks])
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)-8s %(name)s: %(message)s")
    if args.list:
        print_tables()
        return 0
    if args.last:
        return print_last(args.gold_db)
    try:
        return run(args.silver_db, args.gold_db, resolve_tables(args.tables), args.quality_report)
    except gb.GoldCheckError as e:
        for c in e.failed:
            logger.error("check failed: %s.%s expected %s, actual %s", c.table, c.name, c.expected, c.actual)
        logger.error("Gold build rolled back; the previous Gold tables are unchanged")
        return 1
    except (ValueError, duckdb.Error) as e:
        logger.error("Gold build failed: %s", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
