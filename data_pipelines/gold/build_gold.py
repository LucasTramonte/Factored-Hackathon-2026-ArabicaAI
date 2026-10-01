"""Build the Gold serving tables from a quality-gated Silver DuckDB (library; run ``run_gold.py``).

Gold covers the whole population; which rows reach D1 is decided later by a publish step. It
lives in its own DuckDB file (default ``data/latam_bank_gold.duckdb``) and attaches Silver read-only, so a
Gold build never changes the Silver file and never invalidates its quality run.

Each run rebuilds its tables and their reconciliation checks in one transaction. If any check
fails, the transaction rolls back and the previous Gold tables stay as they were.

Memory model: all work runs as DuckDB SQL with a memory limit and disk spill next to the Gold
file. Only check aggregates reach Python.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path

import duckdb

from data_pipelines.gold.intake_slice import AMOUNT, CURRENCY

SOURCE ="lake"  # alias of the attached, read-only Silver database
# DuckDB names a file's catalog after its stem, so these stems would make ``gold.x`` or
# ``silver.x`` ambiguous between a catalog and a schema.
RESERVED_STEMS = {"gold", "silver", SOURCE}

# Provisional: the picker label is not decided yet. It is the only place the name is built.
DISPLAY_NAME = "trim(c.first_name) || ' ' || upper(left(trim(c.last_name), 1)) || '.'"

CONTROL_DDL = """
CREATE SCHEMA IF NOT EXISTS gold;
CREATE TABLE IF NOT EXISTS gold.builds (
  build_id VARCHAR PRIMARY KEY, silver_database VARCHAR NOT NULL,
  quality_generated_at_utc VARCHAR NOT NULL, tables VARCHAR[] NOT NULL);
CREATE TABLE IF NOT EXISTS gold.reconciliation (
  build_id VARCHAR NOT NULL, table_name VARCHAR NOT NULL, check_name VARCHAR NOT NULL,
  expected BIGINT NOT NULL, actual BIGINT NOT NULL, passed BOOLEAN NOT NULL);
"""


@dataclass(frozen=True)
class Check:
    """One reconciliation result; a build commits only when every check passes."""

    table: str
    name: str
    expected: int
    actual: int

    @property
    def passed(self) -> bool:
        return self.expected == self.actual


class GoldCheckError(ValueError):
    """Raised when a reconciliation check fails; the build has been rolled back."""

    def __init__(self, failed: list[Check]):
        self.failed = failed
        super().__init__("Gold checks failed: " + "; ".join(
            f"{c.table}.{c.name} expected {c.expected}, got {c.actual}" for c in failed))


def check_quality(silver_db: Path, quality_path: Path, tables: set[str]) -> dict:
    """Require a ready, error-free quality run of this exact Silver file, taken after its last change."""
    meta = json.loads(quality_path.read_text(encoding="utf-8"))["metadata"]
    if not meta.get("ready") or meta.get("errors"):
        raise ValueError("Quality run is not ready or has errors")
    missing = tables - set(meta.get("tables", []))
    if missing:
        raise ValueError(f"Quality run does not cover {sorted(missing)}")
    if Path(meta["database"]).resolve() != silver_db.resolve():
        raise ValueError("Quality run belongs to another DuckDB")
    checked_at = datetime.fromisoformat(meta["generated_at_utc"])
    if checked_at.tzinfo is None:
        raise ValueError("Quality timestamp has no timezone")
    if silver_db.stat().st_mtime > checked_at.timestamp():
        raise ValueError("Silver DuckDB changed after its quality run")
    return meta


def latest_quality_report(silver_db: Path, runs_dir: Path) -> Path:
    """The newest quality report written for ``silver_db``; the gate still checks it in full."""
    for path in sorted(runs_dir.glob("*/quality_results.json"), reverse=True):
        meta = json.loads(path.read_text(encoding="utf-8")).get("metadata", {})
        if meta.get("database") and Path(meta["database"]).resolve() == silver_db.resolve():
            return path
    raise ValueError(f"No quality run for {silver_db} under {runs_dir}")


def connect(gold_db: Path, silver_db: Path) -> duckdb.DuckDBPyConnection:
    """Open Gold for writing with Silver attached read-only as ``lake``."""
    clashing = sorted({p.stem for p in (gold_db, silver_db)} & RESERVED_STEMS)
    if clashing:
        raise ValueError(f"DuckDB file name {clashing[0]!r} clashes with a schema name; rename the file")
    gold_db.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = gold_db.parent / "duckdb_tmp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(gold_db))
    con.execute("SET memory_limit='2GB'")
    con.execute("SET threads=4")
    con.execute("SET temp_directory=?", [str(temp_dir)])
    con.execute(f"ATTACH '{str(silver_db.resolve()).replace(chr(39), chr(39) * 2)}' AS {SOURCE} (READ_ONLY)")
    con.execute(CONTROL_DDL)
    return con


def build_customers(con: duckdb.DuckDBPyConnection) -> list[Check]:
    """One row per Silver customer; ``row_hash`` covers only the columns published to D1.

    Grain: ``customer_id``, 1:1 with ``silver.dim_customers`` (a current snapshot, so country
    and segment are today's values, never history). Country and segment are kept for publish
    scopes, not served.
    """
    con.execute(f"""
        CREATE OR REPLACE TABLE gold.customers AS
        SELECT c.customer_id,
               {DISPLAY_NAME} AS display_name,
               c.country,
               c.segment,
               sha256(CAST(json_array(c.customer_id, {DISPLAY_NAME}) AS VARCHAR)) AS row_hash
        FROM {SOURCE}.silver.dim_customers c
        ORDER BY c.customer_id
    """)
    silver, gold, duplicates, null_ids, blank_names, unscoped, missing = con.execute(f"""
        SELECT (SELECT count(*) FROM {SOURCE}.silver.dim_customers),
               (SELECT count(*) FROM gold.customers),
               (SELECT count(customer_id) - count(DISTINCT customer_id) FROM gold.customers),
               (SELECT count(*) FROM gold.customers WHERE customer_id IS NULL),
               (SELECT count(*) FROM gold.customers WHERE display_name IS NULL OR trim(display_name) = ''),
               (SELECT count(*) FROM gold.customers WHERE country IS NULL OR segment IS NULL),
               (SELECT count(*) FROM {SOURCE}.silver.dim_customers s
                WHERE NOT EXISTS (SELECT 1 FROM gold.customers g WHERE g.customer_id = s.customer_id))
    """).fetchone()
    return [
        Check("customers", "row_count_matches_silver", silver, gold),
        Check("customers", "duplicate_customer_id", 0, duplicates),
        Check("customers", "null_customer_id", 0, null_ids),
        Check("customers", "blank_display_name", 0, blank_names),
        Check("customers", "missing_country_or_segment", 0, unscoped),
        Check("customers", "silver_customer_missing_from_gold", 0, missing),
    ]


CARD_TYPES = ("Tarjeta Crédito", "Tarjeta Débito")  # Silver keeps the source's Spanish labels (DF-018)


def build_card_purchases(con: duckdb.DuckDBPyConnection) -> list[Check]:
    """One row per approved card purchase, with the Bronze amount and wall time served verbatim.

    Grain: ``transaction_id``, 1:1 with Silver ``Purchase``/``Approved`` rows. Joins are N:1:
    products on ``product_id`` and the Bronze source aggregated to one row per transaction first.
    Ownership, card type and Bronze uniqueness are checked, never filtered, so an unexpected
    row fails the build instead of disappearing. Missing merchants and categories stay NULL
    (DF-006); nothing is invented. ``row_hash`` covers only the columns published to D1.
    Requires ``gold.customers`` from this or an earlier build.
    """
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE card_purchases_stage AS
        WITH eligible AS (
            SELECT transaction_id, customer_id, product_id, transaction_date, merchant_name, merchant_category,
                   amount AS silver_amount, currency, transaction_country
            FROM {SOURCE}.silver.fact_transactions
            WHERE transaction_type = 'Purchase' AND transaction_status = 'Approved'
        ), raw AS (
            SELECT b.transaction_id, count(*) AS bronze_rows, any_value(b.amount) AS amount,
                   any_value(b.transaction_date) AS raw_ts, any_value(b._source_file) AS source_file
            FROM {SOURCE}.bronze.transactions b SEMI JOIN eligible e USING (transaction_id)
            GROUP BY 1
        )
        SELECT e.transaction_id, e.customer_id, e.product_id,
               replace(r.raw_ts, ' ', 'T') AS source_occurred_at,
               CAST(e.transaction_date AS DATE) AS business_date,
               e.merchant_name, e.merchant_category, r.amount, e.currency, e.transaction_country,
               p.product_type AS card_type,
               CASE WHEN length(p.product_number) >= 4 THEN right(p.product_number, 4) END AS card_last4,
               r.source_file,
               -- Check-only fields, dropped from the published table.
               coalesce(r.bronze_rows, 0) AS bronze_rows, e.silver_amount,
               strftime(e.transaction_date, '%Y-%m-%dT%H:%M:%S') AS silver_wall_time,
               p.product_id IS NOT NULL AS product_found, p.customer_id AS product_owner
        FROM eligible e
        LEFT JOIN raw r USING (transaction_id)
        LEFT JOIN {SOURCE}.silver.dim_products p ON p.product_id = e.product_id
    """)
    con.execute("""
        CREATE OR REPLACE TABLE gold.card_purchases AS
        SELECT transaction_id, customer_id, product_id, source_occurred_at, business_date,
               merchant_name, merchant_category, amount, currency, transaction_country,
               card_type, card_last4, source_file,
               sha256(CAST(json_array(transaction_id, customer_id, source_occurred_at, merchant_name, amount, currency)
                           AS VARCHAR)) AS row_hash
        FROM card_purchases_stage
        ORDER BY customer_id, transaction_id
    """)
    counts = con.execute(f"""
        SELECT
          (SELECT count(*) FROM {SOURCE}.silver.fact_transactions
            WHERE transaction_type = 'Purchase' AND transaction_status = 'Approved'),
          (SELECT count(*) FROM gold.card_purchases),
          (SELECT count(transaction_id) - count(DISTINCT transaction_id) FROM gold.card_purchases),
          count(*) FILTER (WHERE NOT product_found),
          count(*) FILTER (WHERE product_found AND product_owner IS DISTINCT FROM customer_id),
          count(*) FILTER (WHERE product_found AND card_type NOT IN {CARD_TYPES}),
          count(*) FILTER (WHERE customer_id NOT IN (SELECT customer_id FROM gold.customers)),
          count(*) FILTER (WHERE bronze_rows <> 1),
          count(*) FILTER (WHERE NOT coalesce(regexp_full_match(amount, '{AMOUNT.pattern}') AND CAST(amount AS DOUBLE) > 0, false)),
          count(*) FILTER (WHERE TRY_CAST(amount AS DOUBLE) IS DISTINCT FROM silver_amount),
          count(*) FILTER (WHERE source_occurred_at IS DISTINCT FROM silver_wall_time),
          count(*) FILTER (WHERE NOT coalesce(regexp_full_match(currency, '{CURRENCY.pattern}'), false)),
          (SELECT count(*) FROM {SOURCE}.silver.fact_transactions
            WHERE transaction_type = 'Purchase' AND transaction_status = 'Approved' AND merchant_name IS NULL),
          count(*) FILTER (WHERE merchant_name IS NULL)
        FROM card_purchases_stage
    """).fetchone()
    (silver, gold, duplicates, no_product, foreign_owner, not_card, no_customer, bronze_not_one,
     bad_amount, amount_diff, time_diff, bad_currency, silver_no_merchant, gold_no_merchant) = counts
    con.execute("DROP TABLE card_purchases_stage")
    return [
        Check("card_purchases", "row_count_matches_silver", silver, gold),
        Check("card_purchases", "duplicate_transaction_id", 0, duplicates),
        Check("card_purchases", "product_missing", 0, no_product),
        Check("card_purchases", "product_owned_by_another_customer", 0, foreign_owner),
        Check("card_purchases", "not_a_card_product", 0, not_card),
        Check("card_purchases", "customer_missing_from_gold_customers", 0, no_customer),
        Check("card_purchases", "bronze_rows_not_exactly_one", 0, bronze_not_one),
        Check("card_purchases", "amount_malformed_or_not_positive", 0, bad_amount),
        Check("card_purchases", "amount_differs_from_silver", 0, amount_diff),
        Check("card_purchases", "wall_time_differs_from_silver", 0, time_diff),
        Check("card_purchases", "currency_malformed", 0, bad_currency),
        Check("card_purchases", "missing_merchant_kept_as_null", silver_no_merchant, gold_no_merchant),
    ]


# Gold table → (builder, Bronze/Silver tables its quality run must cover), in build order.
BUILDERS = {"customers": (build_customers, {"customers"}),
            "card_purchases": (build_card_purchases, {"customers", "products", "transactions"})}


def build(con: duckdb.DuckDBPyConnection, tables: tuple[str, ...], silver_db: Path, quality: dict) -> tuple[str, list[Check]]:
    """Rebuild ``tables`` and record their checks atomically; roll back on any failed check."""
    unknown = set(tables) - BUILDERS.keys()
    if unknown:
        raise ValueError(f"Unknown Gold table {sorted(unknown)[0]}")
    build_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    con.execute("BEGIN TRANSACTION")
    try:
        checks = [c for name in tables for c in BUILDERS[name][0](con)]
        failed = [c for c in checks if not c.passed]
        if failed:
            raise GoldCheckError(failed)
        con.execute("INSERT INTO gold.builds VALUES (?, ?, ?, ?)",
                    [build_id, str(silver_db.resolve()), quality["generated_at_utc"], list(tables)])
        con.executemany("INSERT INTO gold.reconciliation VALUES (?, ?, ?, ?, ?, ?)",
                        [(build_id, c.table, c.name, c.expected, c.actual, c.passed) for c in checks])
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise
    return build_id, checks
