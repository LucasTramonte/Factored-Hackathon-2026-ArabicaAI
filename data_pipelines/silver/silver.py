"""
Silver build engine.

Reads a declarative TableSpec (table_specs.py) and executes a single `CREATE OR REPLACE TABLE
silver.<name> AS SELECT ...` statement built from it, with a QUALIFY-based dedup by primary key.

Design choice: Silver is a FULL REBUILD every run, not incremental like Bronze. Bronze's
incremental watermark logic exists because ingestion is bottlenecked on S3 network round trips
(the whole reason the bronze pipeline's ingest_fact() batches by partition instead of reading day
by day). Silver only reads/writes the local .duckdb file -- no network involved -- and DuckDB is a
fast local columnar engine, so re-deriving even the largest table (digital_events, 15.6M rows)
from Bronze is a matter of seconds, not the minutes an S3-bound full refresh costs. Full rebuild
is also simpler and strictly correct: it can never drift from what Bronze currently holds. If this
ever proves too slow in practice (it hasn't, see README), the fix is a Silver-side watermark
mirroring Bronze's, not a workaround here.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from typing import List, Optional

import duckdb

from transforms import as_boolean, as_country, as_date, as_double, as_integer, as_string, as_time, as_timestamp

logger = logging.getLogger(__name__)

_IDENTIFIER_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")

# Dispatch table for ColumnSpec.transform -- "raw" passes the source through unchanged (for a
# column that's already the right type, e.g. one built entirely via `expr` elsewhere). Column
# TARGET names and table names are validated by _safe_identifier below since they land directly in
# SQL text; a column's `source`/`expr` is developer-authored SQL from table_specs.py, not runtime
# input, so it is trusted the same way the rest of this file's f-strings are.
_TRANSFORMS = {
    "string": as_string,
    "integer": as_integer,
    "double": as_double,
    "date": as_date,
    "timestamp": as_timestamp,
    "time": as_time,
    "boolean": as_boolean,
    "country": as_country,
    "raw": lambda s: s,
}


def _safe_identifier(name: str) -> str:
    if not _IDENTIFIER_RE.match(name):
        raise ValueError(f"Unsafe identifier, refusing to use in SQL: {name!r}")
    return name


@dataclass(frozen=True)
class ColumnSpec:
    source: str                    # bronze column reference, e.g. "customer_id" or "t.amount" (aliased)
    target: Optional[str] = None   # silver column name; defaults to source's last dotted segment
    transform: str = "string"      # key into _TRANSFORMS; ignored when `expr` is set
    expr: Optional[str] = None     # full SQL expression override (joins, COALESCE, custom logic)

    def target_name(self) -> str:
        name = self.target or self.source.split(".")[-1]
        return _safe_identifier(name)

    def to_sql(self) -> str:
        body = self.expr if self.expr is not None else _TRANSFORMS[self.transform](self.source)
        return f"{body} AS {self.target_name()}"


# Silver table naming convention: every table is prefixed by its kind, so `silver.customers`
# becomes `silver.dim_customers` and `silver.transactions` becomes `silver.fact_transactions`.
# `name` and `bronze_table` stay UNPREFIXED throughout this package (they're used to look up the
# unprefixed bronze.<name> source table and to match --tables filters) -- only the final CREATE
# TABLE target gets prefixed, via TableSpec.silver_table_name().
_KIND_PREFIX = {"dimension": "dim", "fact": "fact"}


@dataclass(frozen=True)
class TableSpec:
    name: str                                  # unprefixed table name, e.g. "customers"
    kind: str                                  # "dimension" or "fact" -- determines the dim_/fact_ prefix
    primary_key: List[str]                     # used for QUALIFY dedup; not DB-enforced
    columns: List[ColumnSpec]
    bronze_table: Optional[str] = None          # defaults to `name` if the source table is named the same
    source_alias: Optional[str] = None          # set when extra_joins need to reference the bronze table
    extra_joins: List[str] = None               # raw SQL join clauses, e.g. FX rate lookups
    dedup_order_by: str = "_ingested_at DESC"   # bronze lineage column; prefix with the alias if one is set

    def __post_init__(self):
        if self.extra_joins is None:
            object.__setattr__(self, "extra_joins", [])
        if self.kind not in _KIND_PREFIX:
            raise ValueError(f"TableSpec {self.name!r}: kind must be 'dimension' or 'fact', got {self.kind!r}")

    def silver_table_name(self) -> str:
        return f"{_KIND_PREFIX[self.kind]}_{self.name}"


@dataclass
class SilverResult:
    table_name: str
    rows: int
    status: str = "ok"
    error: Optional[str] = None


def build_silver_table(con: duckdb.DuckDBPyConnection, spec: TableSpec) -> SilverResult:
    silver_table = _safe_identifier(spec.silver_table_name())
    bronze_table = _safe_identifier(spec.bronze_table or spec.name)
    pk_list = ", ".join(_safe_identifier(k) for k in spec.primary_key)

    select_list = ",\n        ".join(c.to_sql() for c in spec.columns)

    from_clause = f"bronze.{bronze_table}"
    if spec.source_alias:
        from_clause += f" {spec.source_alias}"
    for join in spec.extra_joins:
        from_clause += f"\n        {join}"

    sql = f"""
        CREATE OR REPLACE TABLE silver.{silver_table} AS
        SELECT
        {select_list}
        FROM {from_clause}
        QUALIFY row_number() OVER (PARTITION BY {pk_list} ORDER BY {spec.dedup_order_by}) = 1
    """

    t0 = time.monotonic()
    con.execute(sql)
    elapsed = time.monotonic() - t0
    row_count = con.execute(f"SELECT count(*) FROM silver.{silver_table}").fetchone()[0]
    logger.info("[%s] %s rows -> silver.%s in %.1fs", spec.name, f"{row_count:,}", silver_table, elapsed)
    return SilverResult(table_name=silver_table, rows=row_count)


FX_TABLE_NAME = "dim_fx_rates"          # daily_exchange_rates is a reference/dimension table
FX_LATEST_VIEW_NAME = "v_fx_latest_to_usd"  # a derived VIEW, not a base table -- not dim_/fact_
                                             # prefixed, since that convention is for the tables
                                             # table_specs.py builds, not helper views on top of them


def build_fx_rates_table(con: duckdb.DuckDBPyConnection) -> SilverResult:
    """Builds silver.dim_fx_rates (typed daily_exchange_rates) plus a
    silver.v_fx_latest_to_usd convenience view (latest available USD rate per source currency),
    used by table specs that need currency conversion without a natural "as of" date to join on
    (e.g. products, a snapshot dimension, vs. transactions, which joins dim_fx_rates by exact date
    instead -- see table_specs.py). Must run BEFORE any spec whose extra_joins reference
    silver.dim_fx_rates or silver.v_fx_latest_to_usd; run_silver.py sequences this first for that
    reason."""
    t0 = time.monotonic()
    con.execute(
        f"""
        CREATE OR REPLACE TABLE silver.{FX_TABLE_NAME} AS
        SELECT
            TRY_CAST(date AS DATE) AS rate_date,
            trim(source_currency) AS source_currency,
            trim(target_currency) AS target_currency,
            TRY_CAST(exchange_rate AS DOUBLE) AS exchange_rate,
            TRY_CAST(buy_rate AS DOUBLE) AS buy_rate,
            TRY_CAST(sell_rate AS DOUBLE) AS sell_rate,
            trim(source) AS rate_source
        FROM bronze.daily_exchange_rates
        QUALIFY row_number() OVER (
            PARTITION BY TRY_CAST(date AS DATE), trim(source_currency), trim(target_currency)
            ORDER BY _ingested_at DESC
        ) = 1
        """
    )
    con.execute(
        f"""
        CREATE OR REPLACE VIEW silver.{FX_LATEST_VIEW_NAME} AS
        SELECT source_currency, exchange_rate AS rate_to_usd, rate_date
        FROM silver.{FX_TABLE_NAME}
        WHERE target_currency = 'USD'
        QUALIFY row_number() OVER (PARTITION BY source_currency ORDER BY rate_date DESC) = 1
        """
    )
    elapsed = time.monotonic() - t0
    row_count = con.execute(f"SELECT count(*) FROM silver.{FX_TABLE_NAME}").fetchone()[0]
    logger.info("[fx_rates] %s rows -> silver.%s (+%s view) in %.1fs",
                f"{row_count:,}", FX_TABLE_NAME, FX_LATEST_VIEW_NAME, elapsed)
    return SilverResult(table_name=FX_TABLE_NAME, rows=row_count)
