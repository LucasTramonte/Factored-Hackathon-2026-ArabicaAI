"""Gold intake serving slice: a bounded, quality-gated Silver sample rendered as a D1 seed.

The online Worker never reads DuckDB, Silver or S3. This batch step selects the few
transactions the demo may show, checks them against the focused quality run, and writes:

- an idempotent SQL seed for D1. It reruns as a no-op, and drift in stored rows makes it fail
  through a NOT NULL guard;
- a JSON manifest with provenance for every selected row.

Memory model: DuckDB is opened read-only with a 1 GB limit, 2 threads and disk spill. Filters
on the business date, type, status and allowlist run in SQL before any join output reaches
Python, and at most ``max_rows + 1`` rows are fetched.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import duckdb
from intake_agent.context_card import CARD_VERSION, build_context_card

REPO_ROOT = Path(__file__).resolve().parents[2]
IDENTITIES = REPO_ROOT / "back-end/src/config/identities.json"
MIGRATIONS = REPO_ROOT / "back-end/migrations"
REQUIRED_TABLES = ("dim_customers", "dim_products", "fact_transactions")
MAPPING = "Silver Purchase/Approved owner match; Bronze original amount"
AMOUNT = re.compile(r"[0-9]+(\.[0-9]{1,2})?")
CURRENCY = re.compile(r"[A-Z]{3}")
SOURCE_TS = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}")


@dataclass(frozen=True)
class SliceRow:
    """One selected transaction with the values the Worker serves and its provenance."""
    transaction_id: str
    customer_id: str
    product_id: str
    source_occurred_at: str
    merchant_name: str
    amount: str
    currency: str
    source_file: str


def dataset_allowlist(path: Path = IDENTITIES) -> dict[str, str]:
    """Dataset-backed demo identities (``customer_id`` → display name) from the shared config."""
    config = json.loads(path.read_text(encoding="utf-8"))
    return {c["customer_id"]: c["display_name"] for c in config["customers"] if c["source"] == "dataset"}


def check_quality_gate(db_path: Path, quality_path: Path, business_date: date) -> dict:
    """Require a ready, error-free focused quality run for this exact database and business day."""
    meta = json.loads(quality_path.read_text(encoding="utf-8"))["metadata"]
    if not meta.get("ready") or meta.get("errors") or not {"customers", "products", "transactions"} <= set(meta.get("tables", [])):
        raise ValueError("Focused quality gate is incomplete or has errors")
    if Path(meta["database"]).resolve() != db_path.resolve():
        raise ValueError("Quality result belongs to another DuckDB")
    checked_at = datetime.fromisoformat(meta["generated_at_utc"])
    if checked_at.tzinfo is None:
        raise ValueError("Quality timestamp has no timezone")
    if db_path.stat().st_mtime > checked_at.timestamp():
        raise ValueError("DuckDB changed after the focused quality check")
    if not any(w.get("table") == "transactions" and w.get("last_loaded_date") == str(business_date)
               for w in meta.get("watermarks", [])):
        raise ValueError("The selected Bronze date was not quality checked")
    return meta


def validate_sample(con: duckdb.DuckDBPyConnection, business_date: date) -> dict[str, int]:
    """Check Silver grain and customer/product ownership for every eligible row of the day."""
    missing = [name for name in REQUIRED_TABLES if not con.execute(
        "SELECT 1 FROM information_schema.tables WHERE table_schema='silver' AND table_name=?", [name]).fetchone()]
    if missing:
        raise ValueError(f"Silver tables missing: {', '.join(missing)}")
    # LEFT JOIN fact → dimensions: products and customers are N:1 on their keys.
    row = con.execute("""
        SELECT count(*), count(DISTINCT t.transaction_id),
               count(*) FILTER (WHERE p.product_id IS NULL),
               count(*) FILTER (WHERE c.customer_id IS NULL),
               count(*) FILTER (WHERE p.product_id IS NOT NULL AND p.customer_id IS DISTINCT FROM t.customer_id)
        FROM silver.fact_transactions t
        LEFT JOIN silver.dim_products p ON p.product_id = t.product_id
        LEFT JOIN silver.dim_customers c ON c.customer_id = t.customer_id
        WHERE CAST(t.transaction_date AS DATE) = ?
          AND t.transaction_type = 'Purchase' AND t.transaction_status = 'Approved'
    """, [business_date]).fetchone()
    checks = dict(zip(("rows", "unique_ids", "missing_product", "missing_customer", "owner_mismatch"), row))
    if checks["rows"] != checks["unique_ids"]:
        raise ValueError("Eligible transaction IDs are duplicated or a dimension join multiplied rows")
    if checks["missing_product"] or checks["missing_customer"] or checks["owner_mismatch"]:
        raise ValueError("Eligible sample has orphan or mismatched ownership links")
    if checks["rows"] == 0:
        raise ValueError("No eligible transactions on the selected business date")
    return checks


def partition_scope(con: duckdb.DuckDBPyConnection, business_date: date) -> dict:
    """Which storage partitions are loaded, and how many of their rows belong to other business days.

    ``process_date`` is the storage partition. It only says what was loaded; business-day filtering
    always uses ``transaction_date``.
    """
    columns = {r[0] for r in con.execute("SELECT column_name FROM information_schema.columns "
                                         "WHERE table_schema='silver' AND table_name='fact_transactions'").fetchall()}
    if "process_date" not in columns:
        return {"loaded_process_dates": [], "rows_outside_business_date_in_loaded_partitions": None}
    dates = [str(r[0]) for r in con.execute(
        "SELECT DISTINCT process_date FROM silver.fact_transactions ORDER BY 1").fetchall()]
    outside = con.execute("SELECT count(*) FROM silver.fact_transactions WHERE CAST(transaction_date AS DATE) <> ?",
                          [business_date]).fetchone()[0]
    return {"loaded_process_dates": dates, "rows_outside_business_date_in_loaded_partitions": outside}


def _validated(raw: tuple) -> SliceRow:
    tx_id, customer_id, product_id, when, merchant, currency, amount, source_file, bronze_rows, raw_ts = raw
    if bronze_rows != 1:
        raise ValueError(f"No unique Bronze source row for {tx_id}")
    if not isinstance(amount, str) or not AMOUNT.fullmatch(amount) or Decimal(amount) <= 0:
        raise ValueError(f"Invalid source amount for {tx_id}: {amount!r}")
    if not isinstance(currency, str) or not CURRENCY.fullmatch(currency):
        raise ValueError(f"Invalid currency for {tx_id}: {currency!r}")
    if not isinstance(merchant, str) or not merchant:
        raise ValueError(f"Missing merchant for {tx_id}")
    # Serve the ISO form of the source wall time, and prove it is the Bronze string itself.
    served = when.isoformat()
    if not isinstance(raw_ts, str) or not SOURCE_TS.fullmatch(raw_ts) or raw_ts.replace(" ", "T") != served:
        raise ValueError(f"Bronze timestamp {raw_ts!r} for {tx_id} does not match Silver {served!r}")
    return SliceRow(tx_id, customer_id, product_id, served, merchant, amount, currency, source_file)


def select_rows(con: duckdb.DuckDBPyConnection, business_date: date, customer_ids: tuple[str, ...],
                max_rows: int) -> list[SliceRow]:
    """Allowlisted eligible rows with their unique Bronze source amount and file."""
    rows = con.execute("""
        WITH picked AS (
            SELECT t.transaction_id, t.customer_id, t.product_id, t.transaction_date, t.merchant_name, t.currency
            FROM silver.fact_transactions t
            JOIN silver.dim_products p ON p.product_id = t.product_id AND p.customer_id = t.customer_id
            JOIN silver.dim_customers c ON c.customer_id = t.customer_id
            WHERE CAST(t.transaction_date AS DATE) = ?
              AND t.transaction_type = 'Purchase' AND t.transaction_status = 'Approved'
              AND t.customer_id IN (SELECT unnest(?::VARCHAR[]))
        ), raw AS (
            SELECT transaction_id, count(*) AS n, any_value(amount) AS amount, any_value(_source_file) AS source_file,
                   any_value(transaction_date) AS raw_ts
            FROM bronze.transactions WHERE transaction_id IN (SELECT transaction_id FROM picked)
            GROUP BY transaction_id
        )
        SELECT picked.transaction_id, picked.customer_id, picked.product_id, picked.transaction_date,
               picked.merchant_name, picked.currency, raw.amount, raw.source_file, coalesce(raw.n, 0), raw.raw_ts
        FROM picked LEFT JOIN raw USING (transaction_id)
        ORDER BY picked.transaction_id
        LIMIT ?
    """, [business_date, list(customer_ids), max_rows + 1]).fetchall()
    if len(rows) > max_rows:
        raise ValueError("Sample exceeds max_rows; narrow the allowlist")
    if not rows:
        raise ValueError("No eligible transactions for the allowlisted customers; no unique Bronze source row to serve")
    return [_validated(row) for row in rows]


def quote(value: str | None) -> str:
    """SQLite string literal for an already validated value."""
    return "NULL" if value is None else "'" + value.replace("'", "''") + "'"


def content_version(seed: str) -> str:
    """Stable version of a seed: hash of everything after its leading header comment lines.

    Only the header at the top is skipped. Lines further down that start with ``--``, for example
    inside a merchant name containing a newline, are part of the content.
    """
    lines = seed.split("\n")
    start = 0
    while start < len(lines) and lines[start].startswith("-- "):
        start += 1
    return hashlib.sha256("\n".join(lines[start:]).encode("utf-8")).hexdigest()[:16]


def customer_statement(customer_id: str, display_name: str, source: str | None = None) -> str:
    """Idempotent customer upsert; a different stored name makes the rerun fail.

    ``source='dataset'`` marks a dataset customer (migration 0006). Without it the column keeps its
    default, which is what the committed fictitious seed relies on.
    """
    if source is not None:
        return dataset_customer_statement(customer_id, display_name, None)
    return ("INSERT INTO customers(customer_id,display_name) VALUES "
            f"({quote(customer_id)},{quote(display_name)}) "
            "ON CONFLICT(customer_id) DO UPDATE SET display_name=CASE "
            "WHEN customers.display_name=excluded.display_name THEN customers.display_name ELSE NULL END;")


def transaction_statement(transaction_id: str, customer_id: str, occurred_at: str | None, source_occurred_at: str | None,
                          merchant_name: str, amount: str, currency: str) -> str:
    """Idempotent transaction upsert; any difference in a stored column makes the rerun fail."""
    values = [transaction_id, customer_id, occurred_at, source_occurred_at, merchant_name, amount, currency]
    return ("INSERT INTO transactions(transaction_id,customer_id,occurred_at,source_occurred_at,merchant_name,amount,currency) "
            f"VALUES ({','.join(quote(v) for v in values)}) "
            "ON CONFLICT(transaction_id) DO UPDATE SET customer_id=CASE WHEN "
            "transactions.customer_id=excluded.customer_id AND transactions.occurred_at IS excluded.occurred_at AND "
            "transactions.source_occurred_at IS excluded.source_occurred_at AND "
            "transactions.merchant_name=excluded.merchant_name AND transactions.amount=excluded.amount AND "
            "transactions.currency=excluded.currency THEN transactions.customer_id ELSE NULL END;")


def provenance_statement(transaction_id: str, product_id: str, source_file: str, business_date: date) -> str:
    """Idempotent provenance upsert for a dataset-backed transaction."""
    values = [transaction_id, product_id, source_file, str(business_date), MAPPING]
    return ("INSERT INTO sample_provenance(transaction_id,product_id,source_file,business_date,mapping) "
            f"VALUES ({','.join(quote(v) for v in values)}) "
            "ON CONFLICT(transaction_id) DO UPDATE SET product_id=CASE WHEN "
            "sample_provenance.product_id=excluded.product_id AND sample_provenance.source_file=excluded.source_file AND "
            "sample_provenance.business_date=excluded.business_date AND sample_provenance.mapping=excluded.mapping "
            "THEN sample_provenance.product_id ELSE NULL END;")


def dataset_customer_statement(customer_id: str, display_name: str, country: str) -> str:
    """Idempotent upsert of a dataset customer; a different stored name, source or country fails the rerun."""
    return ("INSERT INTO customers(customer_id,display_name,source,country) VALUES "
            f"({quote(customer_id)},{quote(display_name)},'dataset',{quote(country)}) "
            "ON CONFLICT(customer_id) DO UPDATE SET display_name=CASE WHEN "
            "customers.display_name=excluded.display_name AND customers.source=excluded.source AND "
            "customers.country IS excluded.country THEN customers.display_name ELSE NULL END;")


def context_card_statement(customer_id: str, card: dict, snapshot_at: str) -> str:
    """Idempotent context-card upsert; any stored difference makes the rerun fail."""
    payload = json.dumps(card, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return ('INSERT INTO context_cards(customer_id,card_version,snapshot_at,card_json) VALUES '
            f'({quote(customer_id)},{CARD_VERSION},{quote(snapshot_at)},{quote(payload)}) '
            'ON CONFLICT(customer_id) DO UPDATE SET card_json=CASE WHEN '
            'context_cards.card_version=excluded.card_version AND '
            'context_cards.snapshot_at=excluded.snapshot_at AND '
            'context_cards.card_json=excluded.card_json THEN context_cards.card_json ELSE NULL END;')


def with_header(body: str, first_line: str) -> str:
    """Prefix a seed body with its header; the version covers only the body."""
    return f"-- {first_line}; slice_version: {content_version(body)}\n" + \
        "-- Contains no cases or sessions. Generated file: do not edit by hand.\n" + body


def render_seed(rows: list[SliceRow], business_date: date, display_names: dict[str, str],
                cards: dict[str, dict], snapshot_at: str) -> str:
    """Idempotent D1 seed. A rerun is a no-op; any stored difference sets a NOT NULL column to NULL and fails."""
    lines = [customer_statement(c, display_names[c], source="dataset") for c in sorted({r.customer_id for r in rows})]
    lines += [transaction_statement(r.transaction_id, r.customer_id, None, r.source_occurred_at, r.merchant_name,
                                    r.amount, r.currency) for r in rows]
    lines += [provenance_statement(r.transaction_id, r.product_id, r.source_file, business_date) for r in rows]
    lines += [context_card_statement(customer_id, card, snapshot_at) for customer_id, card in sorted(cards.items())]
    return with_header("\n".join(lines) + "\n", f"Gold intake slice for {business_date} from a quality-gated Silver sample")


def build_slice(db_path: Path, quality_path: Path, business_date: date, customer_ids: tuple[str, ...],
                max_rows: int = 20) -> tuple[str, dict]:
    """Validate the inputs and return ``(seed_sql, manifest)`` without writing anything."""
    allowlist = dataset_allowlist()
    if not customer_ids or not set(customer_ids) <= set(allowlist):
        raise ValueError("Customer IDs must be on the dataset allowlist")
    if not 1 <= max_rows <= 100:
        raise ValueError("max_rows must be between 1 and 100")
    meta = check_quality_gate(db_path, quality_path, business_date)
    temp_dir = db_path.parent / "duckdb_tmp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(str(db_path), read_only=True) as con:
        con.execute("SET memory_limit='1GB'")
        con.execute("SET threads=2")
        con.execute("SET temp_directory=?", [str(temp_dir)])
        checks = validate_sample(con, business_date)
        scope = partition_scope(con, business_date)
        rows = select_rows(con, business_date, tuple(customer_ids), max_rows)
        cards = {cid: build_context_card(con, cid) for cid in sorted({r.customer_id for r in rows})}
        if any(card is None for card in cards.values()):
            raise ValueError('Selected customer has no context card')
        if any(not (card['first_name'] or '').strip() for card in cards.values()):
            raise ValueError('Selected customer has no first_name; the dictionary defines it as NOT NULL')
    seed = render_seed(rows, business_date, allowlist, cards, meta['generated_at_utc'])
    manifest = {
        "slice_version": content_version(seed), "business_date": str(business_date),
        "eligible_rows_in_loaded_partitions": checks["rows"], "selected": len(rows), **scope,
        "completeness": ("Eligible rows are counted only within the loaded storage partitions; business-day rows "
                         "stored in other storage partitions are not included."),
        "source_files": sorted({r.source_file for r in rows}), "scope": "one_day_allowlist",
        "filters": {"business_date": str(business_date), "transaction_type": "Purchase", "transaction_status": "Approved"},
        "mapping": MAPPING, "quality_generated_at_utc": meta["generated_at_utc"],
        "selected_records": [{"transaction_id": r.transaction_id, "customer_id": r.customer_id,
                              "product_id": r.product_id, "source_file": r.source_file} for r in rows],
    }
    return seed, manifest
