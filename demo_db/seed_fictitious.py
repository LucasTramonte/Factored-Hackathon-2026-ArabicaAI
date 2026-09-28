"""Idempotently add the clearly fictitious local identities and charges."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from decimal import Decimal

import psycopg
from .migrate import DEFAULT_DSN

CUSTOMERS = (("demo-ana", "Ana (demo)"), ("demo-bruno", "Bruno (demo)"))
TRANSACTIONS = (
    ("demo-tx-001", "demo-ana", datetime(2026, 9, 25, 14, tzinfo=timezone.utc), "Mercado Demo", Decimal("125.50"), "BRL"),
    ("demo-tx-002", "demo-ana", datetime(2026, 9, 26, 15, tzinfo=timezone.utc), "Loja Demo", Decimal("89.90"), "BRL"),
    ("demo-tx-003", "demo-bruno", datetime(2026, 9, 26, 16, tzinfo=timezone.utc), "Cafe Demo", Decimal("32.00"), "BRL"),
)


def seed(dsn: str | None = None) -> None:
    """Insert missing fixture rows; reject divergent existing values."""
    with psycopg.connect(dsn or os.environ.get("DEMO_DATABASE_DSN", DEFAULT_DSN)) as conn:
        for customer_id, name in CUSTOMERS:
            conn.execute("INSERT INTO intake_demo.customers VALUES (%s,%s) ON CONFLICT DO NOTHING", (customer_id, name))
            if conn.execute("SELECT display_name FROM intake_demo.customers WHERE customer_id=%s", (customer_id,)).fetchone()[0] != name:
                raise ValueError(f"Existing customer differs: {customer_id}")
        for tx_id, customer_id, date, merchant, amount, currency in TRANSACTIONS:
            conn.execute("INSERT INTO intake_demo.transactions "
                         "(transaction_id,customer_id,occurred_at,merchant_name,amount,currency) "
                         "VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                         (tx_id, customer_id, date, merchant, amount, currency))
            actual = conn.execute("SELECT customer_id,occurred_at,source_occurred_at,merchant_name,amount,currency "
                                  "FROM intake_demo.transactions WHERE transaction_id=%s", (tx_id,)).fetchone()
            if actual != (customer_id, date, None, merchant, amount, currency):
                raise ValueError(f"Existing transaction differs: {tx_id}")


if __name__ == "__main__":
    seed()
    print("Fictitious seed checked")
