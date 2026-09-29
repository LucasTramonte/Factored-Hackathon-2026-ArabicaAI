"""Export only the reviewed one-day PostgreSQL demo sample as an ignored D1 seed."""
from __future__ import annotations

import argparse
import os
from datetime import date
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from demo_pg.db.migrate import DEFAULT_DSN

CUSTOMER_ID = "CLI-U53R5AZVLET0"
BUSINESS_DATE = date(2026, 2, 26)
DEFAULT_OUTPUT = Path("data/cloudflare_sample_seed.sql")


def quote(value: str | None) -> str:
    """Quote one bounded, already validated SQL text value for Wrangler's seed file."""
    return "NULL" if value is None else "'" + value.replace("'", "''") + "'"


def export(dsn: str, output: Path) -> int:
    """Use the existing quality-gated sample manifest; never scan source facts."""
    with psycopg.connect(dsn, row_factory=dict_row) as pg:
        manifests = pg.execute(
            "SELECT manifest FROM intake_demo.sample_loads WHERE business_date=%s "
            "ORDER BY loaded_at DESC LIMIT 1", (BUSINESS_DATE,)
        ).fetchone()
        if not manifests:
            raise ValueError("Run the bounded Bronze/Silver sample load and quality gate first")
        selected = manifests["manifest"]["selected_records"]
        ids = sorted({x["transaction_id"] for x in selected if x["customer_id"] == CUSTOMER_ID})
        if not 1 <= len(ids) <= 20 or len(ids) != len(selected):
            raise ValueError("Expected 1–20 unique transactions for the fixed demo identity")
        customer = pg.execute(
            "SELECT customer_id,display_name FROM intake_demo.customers WHERE customer_id=%s", (CUSTOMER_ID,)
        ).fetchone()
        rows = pg.execute(
            "SELECT transaction_id,customer_id,occurred_at,source_occurred_at,merchant_name,amount,currency "
            "FROM intake_demo.transactions WHERE transaction_id=ANY(%s) ORDER BY transaction_id", (ids,)
        ).fetchall()
    if not customer or len(rows) != len(ids) or any(
        row["customer_id"] != CUSTOMER_ID or row["transaction_id"] not in ids
        or row["occurred_at"] is not None or row["source_occurred_at"] is None
        or row["source_occurred_at"].date() != BUSINESS_DATE
        for row in rows
    ):
        raise ValueError("Sample ownership, count, or source wall time differs from reviewed manifest")
    provenance = {x["transaction_id"]: x for x in selected}
    if any(not provenance[x]["product_id"] or not provenance[x]["source_file"] for x in ids):
        raise ValueError("Sample provenance is incomplete")
    lines = ["-- Generated from the bounded, quality-gated PostgreSQL demo sample. No cases."]
    lines.append(
        "INSERT INTO customers(customer_id,display_name) VALUES "
        f"({quote(customer['customer_id'])},{quote(customer['display_name'])}) "
        "ON CONFLICT(customer_id) DO UPDATE SET display_name=CASE "
        "WHEN customers.display_name=excluded.display_name THEN customers.display_name ELSE NULL END;"
    )
    for row in rows:
        values = [row["transaction_id"], row["customer_id"],
                  row["occurred_at"].isoformat() if row["occurred_at"] else None,
                  row["source_occurred_at"].isoformat() if row["source_occurred_at"] else None,
                  row["merchant_name"], str(row["amount"]), row["currency"]]
        lines.append(
            "INSERT INTO transactions(transaction_id,customer_id,occurred_at,source_occurred_at,merchant_name,amount,currency) "
            f"VALUES ({','.join(quote(x) for x in values)}) "
            "ON CONFLICT(transaction_id) DO UPDATE SET customer_id=CASE WHEN "
            "transactions.customer_id=excluded.customer_id AND "
            "transactions.occurred_at IS excluded.occurred_at AND "
            "transactions.source_occurred_at IS excluded.source_occurred_at AND "
            "transactions.merchant_name=excluded.merchant_name AND "
            "transactions.amount=excluded.amount AND transactions.currency=excluded.currency "
            "THEN transactions.customer_id ELSE NULL END;"
        )
        source = provenance[row["transaction_id"]]
        values = [row["transaction_id"], source["product_id"], source["source_file"],
                  str(BUSINESS_DATE), "Silver Purchase/Approved owner match; Bronze original amount"]
        lines.append(
            "INSERT INTO sample_provenance(transaction_id,product_id,source_file,business_date,mapping) "
            f"VALUES ({','.join(quote(x) for x in values)}) "
            "ON CONFLICT(transaction_id) DO UPDATE SET product_id=CASE WHEN "
            "sample_provenance.product_id=excluded.product_id AND "
            "sample_provenance.source_file=excluded.source_file AND "
            "sample_provenance.business_date=excluded.business_date AND "
            "sample_provenance.mapping=excluded.mapping "
            "THEN sample_provenance.product_id ELSE NULL END;"
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines) + "\n")
    return len(rows)


def main() -> None:
    """Write an ignored, bounded seed only after the PostgreSQL sample exists."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    count = export(os.environ.get("DEMO_DATABASE_DSN", DEFAULT_DSN), args.output)
    print(f"Exported {count} reviewed synthetic transaction(s) to {args.output}")


if __name__ == "__main__":
    main()
