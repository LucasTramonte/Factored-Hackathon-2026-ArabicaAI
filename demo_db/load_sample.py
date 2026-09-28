"""Load a bounded, quality-checked Silver sample into the demo PostgreSQL."""
from __future__ import annotations

import argparse
import json
import os
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

from psycopg.types.json import Jsonb

import duckdb
import psycopg

from .migrate import DEFAULT_DSN

ALLOWED_CUSTOMERS = frozenset({"CLI-U53R5AZVLET0"})
REQUIRED_TABLES = ("dim_customers", "dim_products", "fact_transactions")


def validate_sample(con: duckdb.DuckDBPyConnection, business_date: date) -> dict[str, int]:
    """Check Silver grain and customer/product ownership before selecting any rows."""
    missing = [name for name in REQUIRED_TABLES if not con.execute(
        "SELECT 1 FROM information_schema.tables WHERE table_schema='silver' AND table_name=?", [name]
    ).fetchone()]
    if missing:
        raise ValueError(f"Silver tables missing: {', '.join(missing)}")
    checks = con.execute("""
        SELECT count(*) AS rows, count(DISTINCT t.transaction_id) AS unique_ids,
               count(*) FILTER (WHERE p.product_id IS NULL) AS missing_product,
               count(*) FILTER (WHERE c.customer_id IS NULL) AS missing_customer,
               count(*) FILTER (WHERE p.product_id IS NOT NULL AND p.customer_id <> t.customer_id) AS owner_mismatch
        FROM silver.fact_transactions t
        LEFT JOIN silver.dim_products p ON p.product_id=t.product_id
        LEFT JOIN silver.dim_customers c ON c.customer_id=t.customer_id
        WHERE CAST(t.transaction_date AS DATE)=?
          AND t.transaction_type='Purchase' AND t.transaction_status='Approved'
    """, [business_date]).fetchone()
    names = ("rows", "unique_ids", "missing_product", "missing_customer", "owner_mismatch")
    result = dict(zip(names, checks))
    if result["rows"] != result["unique_ids"]:
        raise ValueError("Eligible transaction IDs are duplicated or a dimension join multiplied rows")
    return result


def load(db_path: Path, quality_path: Path, business_date: date, customer_ids: tuple[str, ...],
         max_rows: int = 20, dsn: str | None = None) -> dict:
    """Load exact original amount/currency and timezone-free date; reject existing drift."""
    if not customer_ids or not set(customer_ids) <= ALLOWED_CUSTOMERS:
        raise ValueError("Customer IDs must be on the fixed demo allowlist")
    if max_rows < 1 or max_rows > 100:
        raise ValueError("max_rows must be between 1 and 100")
    quality = json.loads(quality_path.read_text())
    meta = quality["metadata"]
    if not meta.get("ready") or meta.get("errors") or not {"customers", "products", "transactions"} <= set(meta["tables"]):
        raise ValueError("Focused quality gate is incomplete or has errors")
    if Path(meta["database"]).resolve() != db_path.resolve():
        raise ValueError("Quality result belongs to another DuckDB")
    checked_at = datetime.fromisoformat(meta["generated_at_utc"])
    if checked_at.tzinfo is None or db_path.stat().st_mtime > checked_at.timestamp() + 1:
        raise ValueError("DuckDB changed after the focused quality check")
    if not any(x["table"] == "transactions" and x["last_loaded_date"] == str(business_date)
               for x in meta.get("watermarks", [])):
        raise ValueError("The selected Bronze date was not quality checked")
    temp_dir = db_path.parent / "duckdb_tmp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(str(db_path), read_only=True) as con:
        con.execute("SET memory_limit='1GB'")
        con.execute("SET threads=2")
        con.execute("SET temp_directory=?", [str(temp_dir)])
        checks = validate_sample(con, business_date)
        if any(checks[k] for k in ("missing_product", "missing_customer", "owner_mismatch")):
            raise ValueError("Eligible sample has orphan or mismatched ownership links")
        if checks["rows"] == 0:
            raise ValueError("No eligible transactions on selected business date")
        # Bronze supplies exact source-currency decimals and source object; Silver supplies
        # deduplicated eligibility and typed joins. LIMIT bounds Python/PG memory.
        query = """
            SELECT t.transaction_id, t.customer_id, t.product_id, t.transaction_date,
                   t.merchant_name, b.amount, t.currency, b._source_file,
                   count(*) OVER (PARTITION BY t.transaction_id) AS raw_matches
            FROM silver.fact_transactions t
            JOIN silver.dim_products p ON p.product_id=t.product_id AND p.customer_id=t.customer_id
            JOIN silver.dim_customers c ON c.customer_id=t.customer_id
            JOIN bronze.transactions b ON b.transaction_id=t.transaction_id
            WHERE CAST(t.transaction_date AS DATE)=?
              AND t.transaction_type='Purchase' AND t.transaction_status='Approved'
              AND t.customer_id IN (SELECT unnest(?::VARCHAR[]))
            ORDER BY t.transaction_id
            LIMIT ?
        """
        rows = con.execute(query, [business_date, list(customer_ids), max_rows + 1]).fetchall()
    if len(rows) > max_rows:
        raise ValueError("Sample exceeds max_rows; narrow the allowlist")
    if not rows or any(row[8] != 1 for row in rows):
        raise ValueError("No unique Bronze source row for selected transaction")
    inserted = 0
    with psycopg.connect(dsn or os.environ.get("DEMO_DATABASE_DSN", DEFAULT_DSN)) as pg:
        for tx_id, customer_id, _product_id, when, merchant, amount_raw, currency, _source, _ in rows:
            amount = Decimal(amount_raw)
            if amount <= 0 or amount.as_tuple().exponent < -2:
                raise ValueError(f"Invalid source amount precision for {tx_id}")
            pg.execute("INSERT INTO intake_demo.customers(customer_id,display_name) VALUES (%s,%s) "
                       "ON CONFLICT DO NOTHING", (customer_id, "Dataset customer (synthetic)"))
            result = pg.execute("INSERT INTO intake_demo.transactions "
                                "(transaction_id,customer_id,source_occurred_at,merchant_name,amount,currency) "
                                "VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING transaction_id",
                                (tx_id, customer_id, when, merchant, amount, currency)).fetchone()
            existing = pg.execute("SELECT customer_id,occurred_at,source_occurred_at,merchant_name,amount,currency "
                                  "FROM intake_demo.transactions WHERE transaction_id=%s", (tx_id,)).fetchone()
            if existing != (customer_id, None, when, merchant, amount, currency):
                raise ValueError(f"Existing transaction differs: {tx_id}")
            inserted += int(result is not None)
        manifest = {"business_date": str(business_date), "eligible_sample_rows": checks["rows"],
            "selected": len(rows), "inserted": inserted, "unchanged": len(rows)-inserted,
            "source_files": sorted({row[7] for row in rows}), "scope": "one_day_allowlist",
            "filters": {"business_date": str(business_date), "transaction_type": "Purchase",
                        "transaction_status": "Approved"},
            "mapping": "Silver typed eligibility and owner joins; original source-currency decimal from Bronze; source timestamp has no timezone",
            "selected_records": [{"transaction_id": row[0], "customer_id": row[1],
                                  "product_id": row[2], "source_file": row[7]} for row in rows]}
        pg.execute("INSERT INTO intake_demo.sample_loads(run_id,business_date,manifest) VALUES (%s,%s,%s)",
                   (uuid4(), business_date, Jsonb(manifest)))
    return manifest


def main() -> None:
    """Run the bounded load after migration and focused quality checks."""
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", type=Path, required=True)
    p.add_argument("--quality-report", type=Path, required=True)
    p.add_argument("--business-date", type=date.fromisoformat, required=True)
    p.add_argument("--customer-id", action="append", required=True)
    p.add_argument("--max-rows", type=int, default=20)
    p.add_argument("--manifest", type=Path)
    args = p.parse_args()
    result = load(args.db, args.quality_report, args.business_date,
                  tuple(args.customer_id), args.max_rows)
    if args.manifest:
        args.manifest.parent.mkdir(parents=True, exist_ok=True)
        args.manifest.write_text(json.dumps(result, indent=2) + "\n")
    print(f"Selected {result['selected']}; inserted {result['inserted']}; unchanged {result['unchanged']}")


if __name__ == "__main__":
    main()
