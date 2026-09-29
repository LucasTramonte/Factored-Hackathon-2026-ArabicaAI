"""Adversarial fixtures for the Gold intake slice.

Each test builds a tiny Bronze/Silver DuckDB and a quality report. The generated seed is
applied to SQLite with the Worker's real migrations, which stands in for D1. The tests try
to break the quality gate, the ownership rules, amount parsing, SQL escaping and rerun safety.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb
import pytest

from data_pipelines.gold import intake_slice as gold

DAY = date(2026, 2, 26)
CUSTOMER = "CLI-U53R5AZVLET0"


def make_db(tmp_path: Path, rows=None, products=None, customers=None, bronze=None) -> Path:
    """Minimal Bronze/Silver schema with the columns the slice projects."""
    path = tmp_path / "fixture.duckdb"
    path.unlink(missing_ok=True)
    rows = rows if rows is not None else [("T1", CUSTOMER, "P1", "2026-02-26 13:21:51", "Shop", "ARS", "Purchase", "Approved")]
    products = products if products is not None else [("P1", CUSTOMER)]
    customers = customers if customers is not None else [(CUSTOMER,)]
    bronze = bronze if bronze is not None else [("T1", "29763.49", "transactions/2026/02/26/part.csv")]
    with duckdb.connect(str(path)) as con:
        con.execute("CREATE SCHEMA bronze; CREATE SCHEMA silver")
        con.execute("CREATE TABLE silver.dim_customers(customer_id VARCHAR)")
        con.execute("CREATE TABLE silver.dim_products(product_id VARCHAR, customer_id VARCHAR)")
        con.execute("CREATE TABLE silver.fact_transactions(transaction_id VARCHAR, customer_id VARCHAR, product_id VARCHAR,"
                    " transaction_date TIMESTAMP, merchant_name VARCHAR, currency VARCHAR, transaction_type VARCHAR,"
                    " transaction_status VARCHAR)")
        con.execute("CREATE TABLE bronze.transactions(transaction_id VARCHAR, amount VARCHAR, _source_file VARCHAR)")
        if customers:
            con.executemany("INSERT INTO silver.dim_customers VALUES (?)", customers)
        if products:
            con.executemany("INSERT INTO silver.dim_products VALUES (?, ?)", products)
        if rows:
            con.executemany("INSERT INTO silver.fact_transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
        if bronze:
            con.executemany("INSERT INTO bronze.transactions VALUES (?, ?, ?)", bronze)
    return path


def make_quality(tmp_path: Path, db: Path, **override) -> Path:
    """Quality report written after the database, like a real focused run."""
    meta = {"ready": True, "errors": 0, "generated_at_utc": (datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat(),
            "tables": ["customers", "products", "transactions"], "database": str(db.resolve()),
            "watermarks": [{"table": "transactions", "last_loaded_date": str(DAY)}]}
    meta.update(override)
    path = tmp_path / "quality.json"
    path.write_text(json.dumps({"metadata": meta}))
    return path


def build(tmp_path: Path, db: Path | None = None, customers=(CUSTOMER,), max_rows=20, **quality):
    db = db or make_db(tmp_path)
    return gold.build_slice(db, make_quality(tmp_path, db, **quality), DAY, customers, max_rows=max_rows)


def d1(seed: str | None = None) -> sqlite3.Connection:
    """SQLite with the Worker's migrations, as a local stand-in for D1."""
    con = sqlite3.connect(":memory:")
    con.execute("PRAGMA foreign_keys=ON")
    for migration in sorted(gold.MIGRATIONS.glob("*.sql")):
        con.executescript(migration.read_text())
    if seed:
        con.executescript(seed)
    return con


def test_seed_applies_to_the_real_schema_and_keeps_source_values(tmp_path):
    seed, manifest = build(tmp_path)
    con = d1(seed)
    assert con.execute("SELECT transaction_id, customer_id, occurred_at, source_occurred_at, merchant_name, amount, currency "
                       "FROM transactions").fetchall() == [
        ("T1", CUSTOMER, None, "2026-02-26T13:21:51", "Shop", "29763.49", "ARS")]
    assert con.execute("SELECT display_name FROM customers").fetchone() == ("Dataset customer (synthetic)",)
    assert con.execute("SELECT product_id, source_file, business_date FROM sample_provenance").fetchone() == (
        "P1", "transactions/2026/02/26/part.csv", "2026-02-26")
    assert manifest["selected"] == 1 and manifest["eligible_sample_rows"] == 1
    assert manifest["selected_records"] == [{"transaction_id": "T1", "customer_id": CUSTOMER, "product_id": "P1",
                                             "source_file": "transactions/2026/02/26/part.csv"}]
    assert "INSERT INTO cases" not in seed and "INSERT INTO sessions" not in seed


def test_output_is_deterministic_and_versioned_by_content(tmp_path):
    db = make_db(tmp_path)
    quality = make_quality(tmp_path, db)
    first = gold.build_slice(db, quality, DAY, (CUSTOMER,))
    second = gold.build_slice(db, quality, DAY, (CUSTOMER,))
    assert first == second
    assert first[1]["slice_version"] == gold.content_version(first[0])
    assert first[1]["slice_version"] in first[0]


def test_rerun_is_a_noop_and_stored_drift_is_rejected(tmp_path):
    seed, _ = build(tmp_path)
    con = d1(seed)
    con.executescript(seed)
    assert con.execute("SELECT count(*) FROM transactions").fetchone() == (1,)
    con.execute("UPDATE transactions SET amount='1.00' WHERE transaction_id='T1'")
    with pytest.raises(sqlite3.IntegrityError):
        con.executescript(seed)


@pytest.mark.parametrize("merchant", ["O'Brien's", "a;DROP TABLE cases;--", "back\\slash", "Café ☕ ñandú", "line\nbreak", "%_*"])
def test_hostile_merchant_names_round_trip_as_data(tmp_path, merchant):
    db = make_db(tmp_path, rows=[("T1", CUSTOMER, "P1", "2026-02-26 13:21:51", merchant, "ARS", "Purchase", "Approved")])
    seed, _ = build(tmp_path, db)
    con = d1(seed)
    assert con.execute("SELECT merchant_name FROM transactions").fetchone() == (merchant,)
    assert con.execute("SELECT count(*) FROM sqlite_master WHERE name='cases'").fetchone() == (1,)


@pytest.mark.parametrize("override, message", [
    ({"ready": False}, "quality gate"),
    ({"errors": 2}, "quality gate"),
    ({"tables": ["customers", "transactions"]}, "quality gate"),
    ({"database": "/elsewhere/latam_bank.duckdb"}, "another DuckDB"),
    ({"generated_at_utc": "2020-01-01T00:00:00+00:00"}, "changed after"),
    ({"generated_at_utc": "2099-01-01T00:00:00"}, "timezone"),
    ({"watermarks": []}, "not quality checked"),
    ({"watermarks": [{"table": "transactions", "last_loaded_date": "2026-02-25"}]}, "not quality checked"),
])
def test_quality_gate_fails_closed(tmp_path, override, message):
    with pytest.raises(ValueError, match=message):
        build(tmp_path, **override)


@pytest.mark.parametrize("kwargs, message", [
    (dict(products=[]), "ownership"),
    (dict(products=[("P1", "someone-else")]), "ownership"),
    (dict(customers=[]), "ownership"),
    (dict(rows=[("T1", CUSTOMER, "P1", "2026-02-26 10:00:00", "A", "ARS", "Purchase", "Approved")] * 2), "duplicated"),
    (dict(rows=[("T1", CUSTOMER, "P1", "2026-02-27 10:00:00", "A", "ARS", "Purchase", "Approved")]), "No eligible"),
    (dict(bronze=[("T1", "1.00", "a.csv"), ("T1", "1.00", "b.csv")]), "unique Bronze"),
    (dict(bronze=[]), "unique Bronze"),
])
def test_source_integrity_problems_stop_the_slice(tmp_path, kwargs, message):
    with pytest.raises(ValueError, match=message):
        build(tmp_path, make_db(tmp_path, **kwargs))


@pytest.mark.parametrize("amount", ["0", "0.00", "-1", "12.345", "1E+3", "NaN", " 12.50", "", "1,50"])
def test_invalid_source_amounts_are_rejected(tmp_path, amount):
    with pytest.raises(ValueError, match="amount"):
        build(tmp_path, make_db(tmp_path, bronze=[("T1", amount, "a.csv")]))


@pytest.mark.parametrize("amount", ["12", "12.5", "29763.49"])
def test_valid_source_amounts_are_kept_verbatim(tmp_path, amount):
    seed, _ = build(tmp_path, make_db(tmp_path, bronze=[("T1", amount, "a.csv")]))
    assert d1(seed).execute("SELECT amount FROM transactions").fetchone() == (amount,)


@pytest.mark.parametrize("currency, merchant", [("us", "Shop"), (None, "Shop"), ("ARS", None)])
def test_rows_the_worker_schema_would_reject_fail_early(tmp_path, currency, merchant):
    db = make_db(tmp_path, rows=[("T1", CUSTOMER, "P1", "2026-02-26 13:21:51", merchant, currency, "Purchase", "Approved")])
    with pytest.raises(ValueError, match="currency|merchant"):
        build(tmp_path, db)


def test_only_allowlisted_dataset_customers_are_accepted(tmp_path):
    assert gold.dataset_allowlist() == {CUSTOMER: "Dataset customer (synthetic)"}
    for customers in [(), ("demo-ana",), (CUSTOMER, "CLI-NOT-ALLOWED")]:
        with pytest.raises(ValueError, match="allowlist"):
            build(tmp_path, customers=customers)


def test_filters_keep_other_customers_types_and_days_out(tmp_path):
    rows = [("T1", CUSTOMER, "P1", "2026-02-26 13:21:51", "Shop", "ARS", "Purchase", "Approved"),
            ("T2", CUSTOMER, "P1", "2026-02-26 14:00:00", "Shop", "ARS", "Purchase", "Declined"),
            ("T3", CUSTOMER, "P1", "2026-02-26 15:00:00", "Shop", "ARS", "Payment", "Approved"),
            ("T4", CUSTOMER, "P1", "2026-02-25 15:00:00", "Shop", "ARS", "Purchase", "Approved"),
            ("T5", "CLI-OTHER", "P2", "2026-02-26 16:00:00", "Shop", "ARS", "Purchase", "Approved")]
    db = make_db(tmp_path, rows=rows, products=[("P1", CUSTOMER), ("P2", "CLI-OTHER")],
                 customers=[(CUSTOMER,), ("CLI-OTHER",)], bronze=[(t, "1.00", "a.csv") for t in ("T1", "T2", "T3", "T4", "T5")])
    seed, manifest = build(tmp_path, db)
    assert [r[0] for r in d1(seed).execute("SELECT transaction_id FROM transactions")] == ["T1"]
    assert manifest["eligible_sample_rows"] == 2  # T1 and T5 are eligible on the day; only T1 is allowlisted


def test_row_cap_is_enforced(tmp_path):
    rows = [(f"T{i}", CUSTOMER, "P1", "2026-02-26 10:00:00", "Shop", "ARS", "Purchase", "Approved") for i in range(3)]
    db = make_db(tmp_path, rows=rows, bronze=[(f"T{i}", "1.00", "a.csv") for i in range(3)])
    with pytest.raises(ValueError, match="max_rows"):
        build(tmp_path, db, max_rows=2)
    for bad in (0, 101):
        with pytest.raises(ValueError, match="max_rows"):
            build(tmp_path, db, max_rows=bad)
