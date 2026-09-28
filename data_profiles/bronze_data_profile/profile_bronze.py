#!/usr/bin/env python3
"""
Bronze profiler -- the first step in designing Silver, not Silver itself.

Bronze is raw VARCHAR by design (see the bronze pipeline's README), so before writing a single
Silver CREATE TABLE or CASE WHEN, this answers the questions that actually determine what Silver's
cleaning/typing rules need to handle:

  - Which columns have blank/null values, and how many?
  - How many distinct values does each column actually have -- and for low-cardinality columns
    (product_type, country, status, ...), what ARE those values, verbatim? This project already
    found the data dictionary wrong three separate times (Spanish vs. English product_type values,
    unaccented vs. accented "México", documented vs. actual row counts) by checking this directly
    instead of trusting documentation -- this script makes that check the default first step,
    not something you remember to do after a bug shows up.
  - What fraction of a column's values would survive TRY_CAST to DOUBLE or DATE? A column that's
    95% numeric-parseable with 5% failures needs a documented Silver-layer decision (drop those
    rows? coerce to NULL? investigate first?) -- this surfaces that gap before Silver hides it
    behind a silent TRY_CAST.

Output is a single Markdown report (one table per Bronze table) meant to sit next to you while you
write Silver DDL, not something you re-read afterward.

Usage:
    python profile_bronze.py                               # profile every bronze.* table
    python profile_bronze.py --tables customers,products    # just a subset
    python profile_bronze.py --max-distinct 30              # show full value breakdown up to 30
                                                              # distinct values (default 20) before
                                                              # falling back to a 5-value sample
    python profile_bronze.py --output silver_notes.md       # change the report's file name

Deliberately NOT part of the bronze_pipeline package: this only ever READS the local .duckdb file
(read_only=True, see get_connection() below), needs no AWS credentials, and isn't meant to run on a
schedule -- it's a manual exploration tool you run again whenever Bronze changes.
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import List, Optional

import duckdb

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------------------
# Path resolution -- same convention as data_pipelines/bronze/config.py (PROJECT_ROOT /
# DATA_DIR / DUCKDB_PATH env var overrides, anchored to this script's own location rather than
# CWD), so both packages agree on where the .duckdb file lives without importing from one
# another. Deliberately does NOT reuse bronze/config.py's Settings.from_env(), since that
# requires AWS credentials this script never needs -- profiling is local-file-only.
# --------------------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent


def resolve_duckdb_path() -> Path:
    # Mirrors config.py: <project_root>/data_pipelines/<this folder>/profile_bronze.py -- two
    # levels up lands on the project root the same way it does for the bronze package.
    default_root = SCRIPT_DIR.parent.parent
    project_root = Path(os.environ.get("PROJECT_ROOT", default_root)).resolve()
    data_dir = Path(os.environ.get("DATA_DIR", project_root / "data")).resolve()
    return Path(os.environ.get("DUCKDB_PATH", data_dir / "latam_bank.duckdb"))


_IDENTIFIER_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


def _safe_identifier(name: str) -> str:
    """Same defense-in-depth check as bronze/ingestion.py's _safe_identifier: table/column names
    here come from information_schema (trusted), but this is cheap insurance against ever
    f-string-injecting something unexpected into a query."""
    if not _IDENTIFIER_RE.match(name):
        raise ValueError(f"Unsafe identifier, refusing to use in SQL: {name!r}")
    return name


# Columns that are pipeline metadata, not source data -- not useful for Silver schema design, so
# excluded from profiling rather than cluttering the report with columns everyone already knows.
LINEAGE_COLUMNS = {"_source_file", "_ingested_at", "_source_table"}

# Case-insensitive, trim-matched strings that mean "missing" in plain English/Spanish source data
# but are NOT caught by an IS NULL / blank check, since they're non-empty text. Two of these are a
# specific, verified trap: TRY_CAST follows IEEE 754, so DuckDB accepts 'NaN' as a genuinely valid
# DOUBLE, and 'Infinity' as BOTH a valid DOUBLE *and* a valid DATE (it becomes 9999-12-31) --
# without this list, a column full of "NaN" placeholders would report as 100% numeric-parseable,
# and an "Infinity" placeholder would silently pass as a real date. Extend this list if a table's
# report turns up a source-specific placeholder not covered here (e.g. a literal "-1" used as a
# missing-value code, which this can't distinguish from a real -1 without column-specific context).
NULL_LIKE_SENTINELS = {
    "nan", "null", "none", "nil", "n/a", "na", "#n/a", "#na",
    "undefined", "unknown", "missing", "-", "--", "?",
    "inf", "infinity", "-inf", "-infinity",
}


@dataclass
class ColumnProfile:
    name: str
    bronze_type: str  # the column's ACTUAL on-disk type -- Bronze is supposed to be all-VARCHAR by
                       # design, but a real run turned up a BIGINT column, so this is shown rather
                       # than assumed; anything other than VARCHAR is flagged in the report.
    null_or_blank_pct: float
    null_like_pct: float
    distinct_count: int
    numeric_parse_pct: float
    date_parse_pct: float
    sample_values: List[str]
    is_full_value_counts: bool  # True: sample_values covers every distinct value (with counts).
                                 # False: sample_values is a handful of non-null examples only.


@dataclass
class TableProfile:
    table_name: str
    row_count: int
    columns: List[ColumnProfile] = field(default_factory=list)


def get_bronze_tables(con: duckdb.DuckDBPyConnection) -> List[str]:
    """All bronze.* tables except internal pipeline state (bronze._load_watermarks)."""
    rows = con.execute(
        """
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'bronze' AND table_name NOT LIKE '\\_%' ESCAPE '\\'
        ORDER BY table_name
        """
    ).fetchall()
    return [r[0] for r in rows]


def get_columns(con: duckdb.DuckDBPyConnection, table_name: str) -> List[tuple]:
    """Returns (column_name, data_type) pairs -- data_type is the column's ACTUAL type on disk,
    not an assumption, since Bronze turned out not to be uniformly VARCHAR in practice."""
    rows = con.execute(
        """
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'bronze' AND table_name = ?
        ORDER BY ordinal_position
        """,
        [table_name],
    ).fetchall()
    return [(r[0], r[1]) for r in rows]


def profile_column(
    con: duckdb.DuckDBPyConnection, table_name: str, column_name: str, bronze_type: str, max_distinct: int
) -> ColumnProfile:
    table_name = _safe_identifier(table_name)
    column_name = _safe_identifier(column_name)

    # Bronze is SUPPOSED to be all-VARCHAR by design, but a real run turned up a BIGINT column
    # (branches.year) -- likely ingested before ALL_VARCHAR=true was consistently applied, or via
    # an earlier version of a notebook/script. Rather than trust the design intent, every text
    # operation here (trim, lower, sentinel matching) goes through an explicit CAST(... AS VARCHAR)
    # so this works regardless of what type a column actually turns out to be on disk -- trim()/
    # lower() error out on non-VARCHAR input otherwise (confirmed: "No function matches trim(BIGINT)").
    col_text = f"CAST({column_name} AS VARCHAR)"

    # NULL_LIKE_SENTINELS is a fixed, hardcoded constant (not user/DB input), so interpolating it
    # into the SQL text is safe -- same trust boundary as the rest of this file's f-strings, which
    # only ever carry identifiers already validated by _safe_identifier.
    sentinel_list = ", ".join(f"'{s}'" for s in sorted(NULL_LIKE_SENTINELS))
    is_sentinel = f"lower(trim({col_text})) IN ({sentinel_list})"

    n, n_blank, n_null_like, n_distinct, n_numeric, n_date = con.execute(
        f"""
        SELECT
            count(*) AS n,
            sum(CASE WHEN {column_name} IS NULL OR trim({col_text}) = '' THEN 1 ELSE 0 END) AS n_blank,
            sum(CASE WHEN {column_name} IS NOT NULL AND trim({col_text}) != ''
                     AND {is_sentinel} THEN 1 ELSE 0 END) AS n_null_like,
            count(DISTINCT {column_name}) AS n_distinct,
            -- Sentinels excluded here on purpose: TRY_CAST follows IEEE 754, so 'NaN' is a valid
            -- DOUBLE and 'Infinity' is a valid DOUBLE *and* DATE (9999-12-31) to DuckDB. Without
            -- this exclusion, a column full of "NaN" placeholders would misreport as 100%
            -- numeric-parseable instead of surfacing as the missing-value marker it actually is.
            sum(CASE WHEN NOT {is_sentinel}
                     AND TRY_CAST({col_text} AS DOUBLE) IS NOT NULL THEN 1 ELSE 0 END) AS n_numeric,
            sum(CASE WHEN NOT {is_sentinel}
                     AND TRY_CAST({col_text} AS DATE) IS NOT NULL THEN 1 ELSE 0 END) AS n_date
        FROM bronze.{table_name}
        """
    ).fetchone()

    null_pct = round(100.0 * n_blank / n, 2) if n else 0.0
    null_like_pct = round(100.0 * n_null_like / n, 2) if n else 0.0
    numeric_pct = round(100.0 * n_numeric / n, 2) if n else 0.0
    date_pct = round(100.0 * n_date / n, 2) if n else 0.0

    if n_distinct <= max_distinct:
        # Small enough to just show every value verbatim, ranked by frequency -- this is the
        # check that has caught every "documentation doesn't match reality" bug in this project
        # so far (Spanish vs. English product_type, accented vs. unaccented country names).
        rows = con.execute(
            f"""
            SELECT {column_name} AS v, count(*) AS cnt
            FROM bronze.{table_name}
            GROUP BY {column_name}
            ORDER BY cnt DESC
            """
        ).fetchall()
        samples = [f"{v!r} ({c:,})" for v, c in rows]
        is_full = True
    else:
        rows = con.execute(
            f"""
            SELECT DISTINCT {column_name} FROM bronze.{table_name}
            WHERE {column_name} IS NOT NULL AND trim({col_text}) != ''
            LIMIT 5
            """
        ).fetchall()
        samples = [repr(v) for (v,) in rows]
        is_full = False

    return ColumnProfile(
        name=column_name,
        bronze_type=bronze_type,
        null_or_blank_pct=null_pct,
        null_like_pct=null_like_pct,
        distinct_count=n_distinct,
        numeric_parse_pct=numeric_pct,
        date_parse_pct=date_pct,
        sample_values=samples,
        is_full_value_counts=is_full,
    )


def profile_table(con: duckdb.DuckDBPyConnection, table_name: str, max_distinct: int) -> TableProfile:
    table_name = _safe_identifier(table_name)
    row_count = con.execute(f"SELECT count(*) FROM bronze.{table_name}").fetchone()[0]

    columns = [(name, dtype) for name, dtype in get_columns(con, table_name) if name not in LINEAGE_COLUMNS]
    profile = TableProfile(table_name=table_name, row_count=row_count)

    for column_name, bronze_type in columns:
        t0 = time.monotonic()
        profile.columns.append(profile_column(con, table_name, column_name, bronze_type, max_distinct))
        logger.debug("[%s.%s] profiled in %.1fs", table_name, column_name, time.monotonic() - t0)

    return profile


def write_report(profiles: List[TableProfile], output_path: Path) -> None:
    lines = [
        "# Bronze profile -- inputs for Silver schema design",
        "",
        f"Generated {datetime.now().isoformat(timespec='seconds')}",
        "",
        "Bronze is DESIGNED to be all-VARCHAR (raw ingest, no typing/cleaning yet), but a real run of",
        "this script found a table with a BIGINT column already -- so `type` below is each column's",
        "ACTUAL type on disk, not an assumption. Anything other than VARCHAR is flagged **⚠** and worth",
        "a quick look: it may just mean that table happened to get typed correctly already (fine), or",
        "it may mean an earlier/different ingestion path wrote it inconsistently with the rest of",
        "Bronze (worth knowing before Silver builds on top of it either way).",
        "",
        "`numeric %` / `date %`",
        "below are the share of non-null, non-sentinel values that would survive",
        "`TRY_CAST(... AS DOUBLE)` / `TRY_CAST(... AS DATE)` -- useful for spotting columns that are",
        "*almost* clean (worth a Silver-layer decision on the exceptions) vs. columns that were never",
        "meant to be numeric/date in the first place (ignore those two columns for that row).",
        "",
        "`null-like %` catches non-empty text that MEANS missing but isn't NULL or blank --",
        f"case-insensitive matches against: {', '.join(sorted(repr(s) for s in NULL_LIKE_SENTINELS))}.",
        "This matters because DuckDB's TRY_CAST follows IEEE 754: `'NaN'` casts to a valid DOUBLE, and",
        "`'Infinity'` casts to a valid DOUBLE *and* a valid DATE (`9999-12-31`) -- both are excluded",
        "from `numeric %` / `date %` above so a column full of \"NaN\" placeholders doesn't misreport as",
        "clean. A high `null-like %` on a column also needs its OWN Silver rule (coalesce to true",
        "NULL), separate from whatever handles real blanks.",
        "",
        "`sample values` shows every distinct value with its row count when there are few enough",
        "(**all shown**), or up to 5 non-null examples otherwise (**sample**) -- check the **all",
        "shown** columns against the data dictionary before trusting either one; this project has",
        "found the dictionary wrong on exactly this kind of column three times already.",
        "",
    ]

    for tp in profiles:
        non_varchar = [c.name for c in tp.columns if c.bronze_type.upper() != "VARCHAR"]
        lines.append(f"## `bronze.{tp.table_name}` -- {tp.row_count:,} rows")
        if non_varchar:
            lines.append(f"⚠ non-VARCHAR column(s): {', '.join(non_varchar)}")
        lines.append("")
        lines.append("| column | type | null/blank % | null-like % | distinct | numeric % | date % | sample values |")
        lines.append("|---|---|---:|---:|---:|---:|---:|---|")
        for c in tp.columns:
            tag = "all shown" if c.is_full_value_counts else "sample"
            sample_str = "; ".join(c.sample_values[:12])
            if len(c.sample_values) > 12:
                sample_str += f"; ... (+{len(c.sample_values) - 12} more)"
            type_flag = " **⚠**" if c.bronze_type.upper() != "VARCHAR" else ""
            null_like_flag = " **⚠**" if c.null_like_pct > 0 else ""
            lines.append(
                f"| {c.name} | {c.bronze_type}{type_flag} | {c.null_or_blank_pct} | "
                f"{c.null_like_pct}{null_like_flag} | {c.distinct_count:,} | "
                f"{c.numeric_parse_pct} | {c.date_parse_pct} | {sample_str} ({tag}) |"
            )
        lines.append("")

    output_path.write_text("\n".join(lines), encoding="utf-8")


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Profile bronze.* tables to inform Silver schema design.")
    parser.add_argument(
        "--tables", type=str, default=None,
        help="Comma-separated bronze table names to profile, instead of all of them.",
    )
    parser.add_argument(
        "--max-distinct", type=int, default=20,
        help="Show the full value breakdown for columns with at most this many distinct values "
             "(default 20); columns above this get a 5-value sample instead.",
    )
    parser.add_argument(
        "--output", type=str, default=None,
        help="Report file path (default: bronze_profile.md next to this script).",
    )
    parser.add_argument(
        "--log-level", type=str, default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    return parser.parse_args(argv)


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

    output_path = Path(args.output).resolve() if args.output else SCRIPT_DIR / "bronze_profile.md"

    logger.info("duckdb_path=%s  output=%s", duckdb_path, output_path)

    # read_only=True: this script only ever queries, and it means it can run safely even if
    # another process (or a forgotten kernel) still holds the file open for writing -- no lock
    # contention, unlike the ingestion pipeline's own connection.
    con = duckdb.connect(str(duckdb_path), read_only=True)
    try:
        table_filter = set(args.tables.split(",")) if args.tables else None
        tables = get_bronze_tables(con)
        if table_filter:
            missing = table_filter - set(tables)
            if missing:
                logger.error("Unknown table name(s) in --tables: %s", ", ".join(sorted(missing)))
                return 1
            tables = [t for t in tables if t in table_filter]

        if not tables:
            logger.error("No bronze tables found -- has ingestion been run yet?")
            return 1

        profiles = []
        for table_name in tables:
            t0 = time.monotonic()
            profile = profile_table(con, table_name, args.max_distinct)
            logger.info(
                "[%s] %s rows, %d column(s) profiled in %.1fs",
                table_name, f"{profile.row_count:,}", len(profile.columns), time.monotonic() - t0,
            )
            profiles.append(profile)
    finally:
        con.close()

    write_report(profiles, output_path)
    logger.info("Report written to %s", output_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
