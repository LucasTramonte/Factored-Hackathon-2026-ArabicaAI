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
from intake_agent.context_card import CARD_VERSION, VARIANTS

SOURCE = "lake"  # alias of the attached, read-only Silver database
# DuckDB names a file's catalog after its stem, so these stems would make ``gold.x`` or
# ``silver.x`` ambiguous between a catalog and a schema.
RESERVED_STEMS = {"gold", "silver", SOURCE}

# The picker label: first name and last initial, the same rule as ``cohort._display_name``, which is
# what D1 serves today (a test pins the two together). The only place Gold builds the name.
# Python's str.strip() removes tabs and newlines, which DuckDB's trim() keeps, so names are stripped with the
# ASCII [[:space:]] set. Unicode spaces such as U+00A0 are not in the data and would still differ.
STRIP = "regexp_replace({}, '^[[:space:]]+|[[:space:]]+$', '', 'g')"
_FIRST, _LAST = STRIP.format("c.first_name"), STRIP.format("c.last_name")
DISPLAY_NAME = f"CASE WHEN coalesce({_LAST}, '') = '' THEN {_FIRST} ELSE {_FIRST} || ' ' || left({_LAST}, 1) || '.' END"

CONTROL_DDL = """
CREATE SCHEMA IF NOT EXISTS gold;
CREATE TABLE IF NOT EXISTS gold.builds (
  build_id VARCHAR PRIMARY KEY, silver_database VARCHAR NOT NULL,
  quality_generated_at_utc VARCHAR NOT NULL, tables VARCHAR[] NOT NULL);
-- Added after the first builds; NULL on rows written before them.
ALTER TABLE gold.builds ADD COLUMN IF NOT EXISTS quality_report VARCHAR;
ALTER TABLE gold.builds ADD COLUMN IF NOT EXISTS watermarks VARCHAR;
CREATE TABLE IF NOT EXISTS gold.table_builds (
  table_name VARCHAR PRIMARY KEY, build_id VARCHAR NOT NULL, quality_generated_at_utc VARCHAR NOT NULL,
  built_at TIMESTAMP NOT NULL);
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
    """The quality report for ``silver_db`` with the latest ``generated_at_utc``; the gate still checks it.

    Chosen by the report's own timestamp, not its folder name: run folders are usually UTC stamps,
    but a hand-named one (``pr23-check``) would otherwise sort ahead of every one of them. Reports
    that can't be read or carry no timezone-aware timestamp are skipped.
    """
    candidates = []
    for path in runs_dir.glob("*/quality_results.json"):
        try:
            meta = json.loads(path.read_text(encoding="utf-8")).get("metadata", {})
            generated = datetime.fromisoformat(meta["generated_at_utc"])
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if generated.tzinfo and meta.get("database") and Path(meta["database"]).resolve() == silver_db.resolve():
            candidates.append((generated, str(path), path))
    if not candidates:
        raise ValueError(f"No quality run for {silver_db} under {runs_dir}")
    return max(candidates)[2]


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


def build_customers(con: duckdb.DuckDBPyConnection, quality: dict) -> list[Check]:
    """One row per Silver customer; ``row_hash`` covers every column written to D1 (id, name, country).

    Grain: ``customer_id``, 1:1 with ``silver.dim_customers`` (a current snapshot, so country,
    segment and status are today's values, never history). Country, segment and status are kept
    for publish scopes (a cohort excludes customers who are closed today), not served.
    """
    con.execute(f"""
        CREATE OR REPLACE TABLE gold.customers AS
        SELECT c.customer_id,
               {DISPLAY_NAME} AS display_name,
               c.country,
               c.segment,
               c.customer_status,
               sha256(CAST(json_array(c.customer_id, {DISPLAY_NAME}, c.country) AS VARCHAR)) AS row_hash
        FROM {SOURCE}.silver.dim_customers c
        ORDER BY c.customer_id
    """)
    blank_name = STRIP.format("display_name")
    silver, gold, duplicates, null_ids, blank_names, unscoped, no_status, missing = con.execute(f"""
        SELECT (SELECT count(*) FROM {SOURCE}.silver.dim_customers),
               (SELECT count(*) FROM gold.customers),
               (SELECT count(customer_id) - count(DISTINCT customer_id) FROM gold.customers),
               (SELECT count(*) FROM gold.customers WHERE customer_id IS NULL),
               (SELECT count(*) FROM gold.customers WHERE coalesce({blank_name}, '') = ''),
               (SELECT count(*) FROM gold.customers WHERE country IS NULL OR segment IS NULL),
               (SELECT count(*) FROM gold.customers WHERE customer_status IS NULL),
               (SELECT count(*) FROM {SOURCE}.silver.dim_customers s
                WHERE NOT EXISTS (SELECT 1 FROM gold.customers g WHERE g.customer_id = s.customer_id))
    """).fetchone()
    return [
        Check("customers", "row_count_matches_silver", silver, gold),
        Check("customers", "duplicate_customer_id", 0, duplicates),
        Check("customers", "null_customer_id", 0, null_ids),
        Check("customers", "blank_display_name", 0, blank_names),
        Check("customers", "missing_country_or_segment", 0, unscoped),
        Check("customers", "missing_customer_status", 0, no_status),
        Check("customers", "silver_customer_missing_from_gold", 0, missing),
    ]


def build_customer_complaints(con: duckdb.DuckDBPyConnection, quality: dict) -> list[Check]:
    """Complaints per customer and type: how many, and the first and last creation time.

    Grain: (``customer_id``, ``category``, ``subcategory``), aggregated from
    ``silver.fact_complaints`` before any join. A complaint without a subcategory (about 10%)
    stays in its own group with a NULL subcategory; nothing is inferred. Times are the
    timezone-free business timestamp, so a consumer can bound them to a window (ADR-005).
    Not served: it is the input for publish scopes such as the dispute cohort, and later for
    customer context. Requires ``gold.customers`` from this or an earlier build.

    ``groups_match_silver`` and ``missing_subcategory_kept_as_null`` hold by construction of the
    GROUP BY; they guard against a later edit that filters or coalesces, not against bad data.
    """
    con.execute(f"""
        CREATE OR REPLACE TABLE gold.customer_complaints AS
        SELECT customer_id, category, subcategory,
               count(*) AS complaints,
               min(creation_date) AS first_created_at,
               max(creation_date) AS last_created_at
        FROM {SOURCE}.silver.fact_complaints
        GROUP BY customer_id, category, subcategory
        ORDER BY customer_id, category, subcategory
    """)
    counts = con.execute(f"""
        SELECT
          (SELECT count(*) FROM {SOURCE}.silver.fact_complaints),
          coalesce(sum(complaints), 0),
          (SELECT count(DISTINCT (customer_id, category, subcategory)) FROM {SOURCE}.silver.fact_complaints),
          count(*),
          count(*) FILTER (WHERE customer_id IS NULL OR category IS NULL),
          count(*) FILTER (WHERE first_created_at IS NULL OR first_created_at > last_created_at),
          (SELECT count(*) FROM gold.customer_complaints k
            WHERE NOT EXISTS (SELECT 1 FROM gold.customers g WHERE g.customer_id = k.customer_id)),
          (SELECT count(*) FROM {SOURCE}.silver.fact_complaints WHERE subcategory IS NULL),
          coalesce(sum(complaints) FILTER (WHERE subcategory IS NULL), 0)
        FROM gold.customer_complaints
    """).fetchone()
    (silver, gold, silver_groups, gold_groups, unkeyed, bad_times, no_customer,
     silver_no_sub, gold_no_sub) = counts
    return [
        Check("customer_complaints", "complaints_match_silver", silver, gold),
        Check("customer_complaints", "groups_match_silver", silver_groups, gold_groups),
        Check("customer_complaints", "missing_customer_or_category", 0, unkeyed),
        Check("customer_complaints", "first_after_last_or_missing", 0, bad_times),
        Check("customer_complaints", "customer_missing_from_gold_customers", 0, no_customer),
        Check("customer_complaints", "missing_subcategory_kept_as_null", silver_no_sub, gold_no_sub),
    ]


CARD_TYPES = ("Tarjeta Crédito", "Tarjeta Débito")  # Silver keeps the source's Spanish labels (DF-018)


def build_card_purchases(con: duckdb.DuckDBPyConnection, quality: dict) -> list[Check]:
    """One row per approved card purchase, with the Bronze amount and wall time served verbatim.

    Grain: ``transaction_id``, 1:1 with Silver ``Purchase``/``Approved`` rows. Joins are N:1:
    products on ``product_id`` and the Bronze source aggregated to one row per transaction first.
    Ownership, card type and Bronze uniqueness are checked, never filtered, so an unexpected
    row fails the build instead of disappearing. Missing merchants and categories stay NULL
    (DF-006); nothing is invented. ``row_hash`` covers every column written to D1: the six served
    ones and the provenance row's product, source file and business date.
    ``occurred_at`` is the same wall time typed as a timestamp, for window filters and ordering;
    the wall-time check ties it to the served string. Requires ``gold.customers`` from this or an
    earlier build.
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
               e.transaction_date AS occurred_at,
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
        SELECT transaction_id, customer_id, product_id, source_occurred_at, occurred_at, business_date,
               merchant_name, merchant_category, amount, currency, transaction_country,
               card_type, card_last4, source_file,
               sha256(CAST(json_array(transaction_id, customer_id, source_occurred_at, merchant_name, amount, currency,
                                      product_id, source_file, business_date) AS VARCHAR)) AS row_hash
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
          count(*) FILTER (WHERE product_found AND (card_type IS NULL OR card_type NOT IN {CARD_TYPES})),
          (SELECT count(*) FROM card_purchases_stage s
            WHERE NOT EXISTS (SELECT 1 FROM gold.customers g WHERE g.customer_id = s.customer_id)),
          count(*) FILTER (WHERE bronze_rows <> 1),
          count(*) FILTER (WHERE NOT coalesce(regexp_full_match(amount, '{AMOUNT.pattern}') AND TRY_CAST(amount AS DOUBLE) > 0, false)),
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


# Mirrors LOCALE in back-end/src/modules/customer/routes.js: a card whose hint fails it is served as null.
WORKER_LOCALE = "(es|pt)(-[A-Za-z0-9]+)*"
CARD_PRODUCT = "STRUCT(currency VARCHAR, last4 VARCHAR, product_type VARCHAR)"


def build_context_cards(con: duckdb.DuckDBPyConnection, quality: dict) -> list[Check]:
    """One context card per Gold customer, byte-identical to ``intake_agent.context_card``.

    Grain: ``customer_id``, 1:1 with ``gold.customers``. Products are the customer's *current*
    active products (a snapshot, never what was active on a transaction date), aggregated to one
    list per customer before the join. ``card_json`` has the same keys, order and escaping as the
    Python builder's ``json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)``,
    because D1's drift guard compares it as text. ``snapshot_at`` is the quality run's time.
    ``row_hash`` leaves ``snapshot_at`` out, so a newer quality run over unchanged data doesn't
    mark every card as changed. Requires ``gold.customers`` from this or an earlier build.
    """
    con.execute("CREATE OR REPLACE TEMP TABLE locale_variants (key VARCHAR, locale VARCHAR)")
    con.executemany("INSERT INTO locale_variants VALUES (?, ?)", list(VARIANTS.items()))
    last4 = "CASE WHEN length(p.product_number) >= 4 THEN right(p.product_number, 4) END"
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE context_card_products AS
        SELECT p.customer_id,
               list(struct_pack(currency := p.currency, last4 := {last4}, product_type := p.product_type)
                    ORDER BY p.product_type, {last4}, p.currency) AS products
        FROM {SOURCE}.silver.dim_products p
        WHERE p.product_status = 'Active' AND p.customer_id IN (SELECT customer_id FROM gold.customers)
        GROUP BY 1
    """)
    con.execute(f"""
        CREATE OR REPLACE TABLE gold.context_cards AS
        WITH cards AS (
            SELECT g.customer_id, {CARD_VERSION} AS card_version, CAST(? AS VARCHAR) AS snapshot_at,
                   CAST(to_json(struct_pack(
                       first_name := c.first_name,
                       locale_hint := coalesce(va.locale, vc.locale, 'es-419'),
                       products := coalesce(p.products, CAST([] AS {CARD_PRODUCT}[])))) AS VARCHAR) AS card_json
            FROM gold.customers g
            JOIN {SOURCE}.silver.dim_customers c USING (customer_id)
            LEFT JOIN locale_variants va ON va.key = c.detected_accent
            LEFT JOIN locale_variants vc ON vc.key = c.country
            LEFT JOIN context_card_products p USING (customer_id)
        )
        SELECT customer_id, card_version, snapshot_at, card_json,
               sha256(CAST(json_array(customer_id, card_version, card_json) AS VARCHAR)) AS row_hash
        FROM cards
        ORDER BY customer_id
    """, [quality["generated_at_utc"]])
    card_first_name = STRIP.format("json_extract_string(card_json, '$.first_name')")
    counts = con.execute(f"""
        SELECT
          (SELECT count(*) FROM gold.customers),
          count(*),
          count(customer_id) - count(DISTINCT customer_id),
          (SELECT count(*) FROM gold.customers g WHERE NOT EXISTS
             (SELECT 1 FROM gold.context_cards k WHERE k.customer_id = g.customer_id)),
          count(*) FILTER (WHERE NOT json_valid(card_json)),
          count(*) FILTER (WHERE coalesce({card_first_name}, '') = ''),
          count(*) FILTER (WHERE NOT regexp_full_match(json_extract_string(card_json, '$.locale_hint'), '{WORKER_LOCALE}')),
          (SELECT count(*) FROM (SELECT unnest(products) AS item FROM context_card_products)
            WHERE NOT (item.last4 IS NULL OR regexp_full_match(item.last4, '[0-9]{{4}}'))
               OR NOT (item.currency IS NULL OR regexp_full_match(item.currency, '[A-Z]{{3}}'))),
          (SELECT count(*) FROM {SOURCE}.silver.dim_products
            WHERE product_status = 'Active' AND customer_id IN (SELECT customer_id FROM gold.customers)),
          coalesce(sum(json_array_length(card_json, '$.products')), 0),
          (SELECT count(*) FROM gold.customers g WHERE NOT EXISTS
             (SELECT 1 FROM {SOURCE}.silver.dim_products p WHERE p.customer_id = g.customer_id AND p.product_status = 'Active')),
          count(*) FILTER (WHERE json_array_length(card_json, '$.products') = 0)
        FROM gold.context_cards
    """).fetchone()
    (customers, cards, duplicates, uncarded, bad_json, no_name, bad_locale, bad_product,
     silver_active, carded_products, silver_no_active, cards_no_products) = counts
    con.execute("DROP TABLE context_card_products")
    con.execute("DROP TABLE locale_variants")
    return [
        Check("context_cards", "row_count_matches_gold_customers", customers, cards),
        Check("context_cards", "duplicate_customer_id", 0, duplicates),
        Check("context_cards", "gold_customer_without_card", 0, uncarded),
        Check("context_cards", "card_json_invalid", 0, bad_json),
        Check("context_cards", "blank_first_name", 0, no_name),
        Check("context_cards", "locale_hint_rejected_by_worker", 0, bad_locale),
        Check("context_cards", "product_field_rejected_by_worker", 0, bad_product),
        Check("context_cards", "active_products_match_silver", silver_active, carded_products),
        Check("context_cards", "customers_without_active_product", silver_no_active, cards_no_products),
    ]


# ADR-005's design window, the population of the reviewed baselines (PR-04, BUSINESS_OUTCOMES.md).
TIMING_WINDOW = ("2023-06-17", "2026-01-01")  # [start, end): business timestamp ``creation_date``
TIMING_SUBCATEGORY = "Cargo no reconocido"
# metric → (unit, SQL interval in that unit). Negative intervals are counted and left out, never silently dropped.
TIMING_METRICS = {
    "first_response": ("hours", "date_diff('second', assignment_date, first_response_date) / 3600.0"),
    "creation_to_resolution": ("days", "date_diff('second', creation_date, resolution_date) / 86400.0"),
}


def build_complaint_timing(con: duckdb.DuckDBPyConnection, quality: dict) -> list[Check]:
    """How long unrecognized-charge complaints waited at this bank: p50 and p90 per metric, with ``n`` and population.

    Grain: one row per metric, aggregated in SQL from ``silver.fact_complaints`` in ADR-005's design window, the same
    population and intervals as ``data_foundation/queries/product/PR-04_before.sql``. ``n`` counts the complaints that
    have the interval; ``missing`` those without one (no response or no resolution yet) and ``negative`` those whose
    dates run backwards, so ``n + missing + negative = population``. Creation to resolution covers resolved complaints
    only: most are never resolved, so it is a survivor statistic and must never be shown as an expected time.
    Served as a reviewed seed (``data_pipelines.gold.service_timing``), never read online from Gold or Silver.
    """
    start, end = TIMING_WINDOW
    selects = " UNION ALL ".join(f"""
        SELECT '{metric}' AS metric, '{unit}' AS unit,
               quantile_cont(x, 0.5) FILTER (WHERE x >= 0) AS p50,
               quantile_cont(x, 0.9) FILTER (WHERE x >= 0) AS p90,
               count(*) FILTER (WHERE x >= 0) AS n,
               count(*) FILTER (WHERE x IS NULL) AS missing,
               count(*) FILTER (WHERE x < 0) AS negative,
               count(*) AS population
        FROM (SELECT {interval} AS x FROM window_complaints)""" for metric, (unit, interval) in TIMING_METRICS.items())
    con.execute(f"""
        CREATE OR REPLACE TABLE gold.complaint_timing AS
        WITH window_complaints AS (
          SELECT * FROM {SOURCE}.silver.fact_complaints
          WHERE subcategory = ? AND creation_date >= CAST(? AS TIMESTAMP) AND creation_date < CAST(? AS TIMESTAMP))
        SELECT metric, unit, p50, p90, n, missing, negative, population,
               ? AS subcategory, CAST(? AS DATE) AS window_start, CAST(? AS DATE) AS window_end_exclusive,
               'silver.fact_complaints' AS source
        FROM ({selects}) ORDER BY metric
    """, [TIMING_SUBCATEGORY, start, end, TIMING_SUBCATEGORY, start, end])
    silver = con.execute(f"SELECT count(*) FROM {SOURCE}.silver.fact_complaints WHERE subcategory = ?"
                         " AND creation_date >= CAST(? AS TIMESTAMP) AND creation_date < CAST(? AS TIMESTAMP)",
                         [TIMING_SUBCATEGORY, start, end]).fetchone()[0]
    rows, mismatched, unbalanced, unordered = con.execute("""
        SELECT count(*), count(*) FILTER (WHERE population <> ?), count(*) FILTER (WHERE n + missing + negative <> population),
               count(*) FILTER (WHERE n > 0 AND NOT (0 <= p50 AND p50 <= p90))
        FROM gold.complaint_timing""", [silver]).fetchone()
    return [
        Check("complaint_timing", "one_row_per_metric", len(TIMING_METRICS), rows),
        Check("complaint_timing", "population_matches_silver_window", 0, mismatched),
        Check("complaint_timing", "n_missing_negative_sum_to_population", 0, unbalanced),
        Check("complaint_timing", "p50_not_above_p90", 0, unordered),
    ]


# Gold table → (builder, Bronze/Silver tables its quality run must cover), in build order.
BUILDERS = {"customers": (build_customers, {"customers"}),
            "customer_complaints": (build_customer_complaints, {"customers", "complaints"}),
            "card_purchases":(build_card_purchases, {"customers", "products", "transactions"}),
            "context_cards": (build_context_cards, {"customers", "products"}),
            "complaint_timing": (build_complaint_timing, {"complaints"})}


def build(con: duckdb.DuckDBPyConnection, tables: tuple[str, ...], silver_db: Path, quality: dict,
          quality_report: Path | None = None) -> tuple[str, list[Check]]:
    """Rebuild ``tables`` and record their checks atomically; roll back on any failed check.

    ``gold.builds`` records the Silver file, the quality report and its watermarks, so a consumer
    such as a publish step can gate on the Gold build alone. ``gold.table_builds`` says which build
    each table currently comes from, since a ``--tables`` run rebuilds only some of them.
    """
    unknown = set(tables) - BUILDERS.keys()
    if unknown:
        raise ValueError(f"Unknown Gold table {sorted(unknown)[0]}")
    build_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    con.execute("BEGIN TRANSACTION")
    try:
        checks = [c for name in tables for c in BUILDERS[name][0](con, quality)]
        failed = [c for c in checks if not c.passed]
        if failed:
            raise GoldCheckError(failed)
        watermarks = {w["table"]: w["last_loaded_date"] for w in quality.get("watermarks", [])}
        con.execute("INSERT INTO gold.builds (build_id, silver_database, quality_generated_at_utc, tables,"
                    " quality_report, watermarks) VALUES (?, ?, ?, ?, ?, ?)",
                    [build_id, str(silver_db.resolve()), quality["generated_at_utc"], list(tables),
                     str(quality_report.resolve()) if quality_report else None,
                     json.dumps(watermarks, sort_keys=True)])
        con.executemany("INSERT OR REPLACE INTO gold.table_builds VALUES (?, ?, ?, ?)",
                        [(name, build_id, quality["generated_at_utc"], datetime.now(timezone.utc).replace(tzinfo=None))
                         for name in tables])
        con.executemany("INSERT INTO gold.reconciliation VALUES (?, ?, ?, ?, ?, ?)",
                        [(build_id, c.table, c.name, c.expected, c.actual, c.passed) for c in checks])
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise
    return build_id, checks
