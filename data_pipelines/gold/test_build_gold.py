"""Fixtures for the Gold build: the quality gate, each Gold table, its checks and atomic rollback.

Each test writes a tiny Silver DuckDB with only the columns Gold projects, and a quality report
dated after it, like a real run.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import duckdb
import pytest

from data_pipelines.gold import build_gold as gb

CUSTOMERS = [("C1", " Ana ", "gómez", "Argentina", "Basic"),
             ("C2", "Bruno", "Lima", "Colombia", "Plus"),
             ("C3", "Carla", "Ruiz", "México", "Student")]
# product_id, customer_id, product_type, product_number
PRODUCTS = [("P1", "C1", "Tarjeta Crédito", "4111222233334444"),
            ("P2", "C2", "Tarjeta Débito", "123"),
            ("P3", "C3", "Cuenta Ahorro", "9999888877776666")]
# transaction_id, customer_id, product_id, Silver timestamp, merchant, category, Silver amount, currency, country, type, status
PURCHASES = [("T1", "C1", "P1", "2025-03-01 03:00:00", "Uber", "Transport", 29763.49, "ARS", "Argentina", "Purchase", "Approved"),
             ("T2", "C2", "P2", "2026-02-26 13:21:51", None, "Food", 20.0, "USD", "USA", "Purchase", "Approved"),
             ("T3", "C1", "P1", "2025-03-02 10:00:00", "Uber", "Transport", 5.0, "ARS", "Argentina", "Purchase", "Declined"),
             ("T4", "C3", "P3", "2025-03-03 10:00:00", None, None, 7.0, "USD", "México", "Withdrawal", "Approved")]


def bronze_for(purchases):
    """The Bronze strings Silver was typed from: the exact amount text and wall time, one row each."""
    texts = {"T1": "29763.49", "T2": "20.00"}
    return [(p[0], texts.get(p[0], f"{p[6]:.2f}"), p[3], f"transactions/year=2025/month=03/day=01/{p[0]}.csv")
            for p in purchases]


def make_silver(tmp_path: Path, customers=CUSTOMERS, products=PRODUCTS, purchases=PURCHASES, bronze=None) -> Path:
    """A tiny Bronze/Silver DuckDB with only the columns Gold projects."""
    path = tmp_path / "silver_fixture.duckdb"
    path.unlink(missing_ok=True)
    bronze = bronze_for(purchases) if bronze is None else bronze
    with duckdb.connect(str(path)) as con:
        con.execute("CREATE SCHEMA silver; CREATE SCHEMA bronze")
        con.execute("CREATE TABLE silver.dim_customers(customer_id VARCHAR, first_name VARCHAR, last_name VARCHAR,"
                    " country VARCHAR, segment VARCHAR)")
        con.execute("CREATE TABLE silver.dim_products(product_id VARCHAR, customer_id VARCHAR, product_type VARCHAR,"
                    " product_number VARCHAR)")
        con.execute("CREATE TABLE silver.fact_transactions(transaction_id VARCHAR, customer_id VARCHAR, product_id VARCHAR,"
                    " transaction_date TIMESTAMP, merchant_name VARCHAR, merchant_category VARCHAR, amount DOUBLE,"
                    " currency VARCHAR, transaction_country VARCHAR, transaction_type VARCHAR, transaction_status VARCHAR)")
        con.execute("CREATE TABLE bronze.transactions(transaction_id VARCHAR, amount VARCHAR, transaction_date VARCHAR,"
                    " _source_file VARCHAR)")
        for table, rows in (("silver.dim_customers", customers), ("silver.dim_products", products),
                            ("silver.fact_transactions", purchases), ("bronze.transactions", bronze)):
            if rows:
                con.executemany(f"INSERT INTO {table} VALUES ({', '.join('?' * len(rows[0]))})", rows)
    return path


def make_quality(tmp_path: Path, silver: Path, name="quality_results.json", **override) -> Path:
    meta = {"ready": True, "errors": 0, "tables": ["customers", "products", "transactions"],
            "database": str(silver.resolve()),
            "generated_at_utc": (datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat()}
    meta.update(override)
    path = tmp_path / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"metadata": meta}), encoding="utf-8")
    return path


def run(tmp_path: Path, silver: Path, tables=("customers",)):
    quality = gb.check_quality(silver, make_quality(tmp_path, silver), {"customers"})
    with gb.connect(tmp_path / "gold_fixture.duckdb", silver) as con:
        return gb.build(con, tables, silver, quality)


def gold_rows(tmp_path: Path, sql: str):
    with duckdb.connect(str(tmp_path / "gold_fixture.duckdb"), read_only=True) as con:
        return con.execute(sql).fetchall()


def test_one_row_per_silver_customer_with_the_provisional_display_name(tmp_path):
    run(tmp_path, make_silver(tmp_path))
    assert gold_rows(tmp_path, "SELECT customer_id, display_name, country, segment FROM gold.customers ORDER BY 1") == [
        ("C1", "Ana G.", "Argentina", "Basic"), ("C2", "Bruno L.", "Colombia", "Plus"), ("C3", "Carla R.", "México", "Student")]


def test_every_check_is_recorded_with_its_build(tmp_path):
    build_id, checks = run(tmp_path, make_silver(tmp_path))
    assert all(c.passed for c in checks) and len(checks) == 6
    assert gold_rows(tmp_path, "SELECT count(*), bool_and(passed) FROM gold.reconciliation WHERE build_id = "
                     f"'{build_id}'") == [(6, True)]
    assert gold_rows(tmp_path, "SELECT build_id, tables FROM gold.builds") == [(build_id, ["customers"])]
    assert gold_rows(tmp_path, "SELECT actual FROM gold.reconciliation WHERE check_name = 'row_count_matches_silver'") == [(3,)]


def test_row_hash_changes_only_with_published_columns(tmp_path):
    silver = make_silver(tmp_path)
    run(tmp_path, silver)
    before = dict(gold_rows(tmp_path, "SELECT customer_id, row_hash FROM gold.customers"))
    changed = [("C1", " Ana ", "gómez", "Colombia", "Premium"),   # scope columns only: same hash
               ("C2", "Bruno", "Silva", "Colombia", "Plus"),      # display name changes: new hash
               CUSTOMERS[2]]
    run(tmp_path, make_silver(tmp_path, changed))
    after = dict(gold_rows(tmp_path, "SELECT customer_id, row_hash FROM gold.customers"))
    assert after["C1"] == before["C1"] and after["C3"] == before["C3"]
    assert after["C2"] != before["C2"]


@pytest.mark.parametrize(("customers", "failed"), [
    (CUSTOMERS + [("C1", "Ana", "Gómez", "Argentina", "Basic")], "duplicate_customer_id"),
    (CUSTOMERS + [(None, "Nadie", "X", "Colombia", "Basic")], "null_customer_id"),
    (CUSTOMERS + [("C4", "Dora", None, "Colombia", "Basic")], "blank_display_name"),
    (CUSTOMERS + [("C4", "Dora", "Paz", None, "Basic")], "missing_country_or_segment"),
])
def test_a_failed_check_rolls_back_and_keeps_the_previous_gold(tmp_path, customers, failed):
    first_build, _ = run(tmp_path, make_silver(tmp_path))
    with pytest.raises(gb.GoldCheckError, match=failed) as err:
        run(tmp_path, make_silver(tmp_path, customers))
    assert failed in {c.name for c in err.value.failed}
    assert gold_rows(tmp_path, "SELECT count(*) FROM gold.customers") == [(3,)]
    assert gold_rows(tmp_path, "SELECT build_id FROM gold.builds") == [(first_build,)]


def test_building_gold_never_modifies_the_silver_file(tmp_path):
    silver = make_silver(tmp_path)
    before = (silver.stat().st_mtime_ns, silver.read_bytes())
    run(tmp_path, silver)
    assert (silver.stat().st_mtime_ns, silver.read_bytes()) == before


@pytest.mark.parametrize(("override", "message"), [
    ({"ready": False}, "not ready"),
    ({"errors": 2}, "not ready"),
    ({"tables": ["products"]}, "does not cover"),
    ({"database": "elsewhere.duckdb"}, "another DuckDB"),
    ({"generated_at_utc": "2026-01-01T00:00:00+00:00"}, "changed after"),
    ({"generated_at_utc": "2999-01-01T00:00:00"}, "no timezone"),
])
def test_quality_gate_rejects_unusable_runs(tmp_path, override, message):
    silver = make_silver(tmp_path)
    with pytest.raises(ValueError, match=message):
        gb.check_quality(silver, make_quality(tmp_path, silver, **override), {"customers"})


def test_unknown_table_is_rejected_before_anything_is_written(tmp_path):
    silver = make_silver(tmp_path)
    with gb.connect(tmp_path / "gold_fixture.duckdb", silver) as con:
        with pytest.raises(ValueError, match="Unknown Gold table"):
            gb.build(con, ("cohort",), silver, {"generated_at_utc": "x"})
    assert gold_rows(tmp_path, "SELECT count(*) FROM gold.builds") == [(0,)]


@pytest.mark.parametrize("stem", ["gold", "silver", "lake"])
def test_file_names_that_clash_with_schema_names_are_refused(tmp_path, stem):
    silver = make_silver(tmp_path)
    with pytest.raises(ValueError, match="clashes with a schema name"):
        gb.connect(tmp_path / f"{stem}.duckdb", silver)
    assert not (tmp_path / f"{stem}.duckdb").exists()


def test_latest_quality_report_picks_the_newest_run_for_this_database(tmp_path):
    silver = make_silver(tmp_path)
    runs = tmp_path / "quality_runs"
    make_quality(runs, tmp_path / "other.duckdb", name="20260930T000000Z/quality_results.json")
    make_quality(runs, silver, name="20260929T000000Z/quality_results.json")
    assert gb.latest_quality_report(silver, runs) == runs / "20260929T000000Z/quality_results.json"
    with pytest.raises(ValueError, match="No quality run"):
        gb.latest_quality_report(tmp_path / "missing.duckdb", runs)


# ---- gold.card_purchases ----------------------------------------------------------------------

BOTH = ("customers", "card_purchases")


def with_row(rows, index, **changes):
    """Copy ``rows`` with fields of one row replaced, by position name in the fixture tuples."""
    fields = {"transaction_id": 0, "customer_id": 1, "product_id": 2, "ts": 3, "merchant": 4,
              "category": 5, "amount": 6, "currency": 7, "owner": 1}
    out = [list(r) for r in rows]
    for name, value in changes.items():
        out[index][fields[name]] = value
    return [tuple(r) for r in out]


def test_card_purchases_serve_bronze_values_and_keep_missing_merchants_null(tmp_path):
    run(tmp_path, make_silver(tmp_path), BOTH)
    assert gold_rows(tmp_path, "SELECT transaction_id, customer_id, product_id, source_occurred_at, business_date::VARCHAR,"
                     " merchant_name, merchant_category, amount, currency, transaction_country, card_type, card_last4,"
                     " source_file FROM gold.card_purchases") == [
        ("T1", "C1", "P1", "2025-03-01T03:00:00", "2025-03-01", "Uber", "Transport", "29763.49", "ARS", "Argentina",
         "Tarjeta Crédito", "4444", "transactions/year=2025/month=03/day=01/T1.csv"),
        ("T2", "C2", "P2", "2026-02-26T13:21:51", "2026-02-26", None, "Food", "20.00", "USD", "USA",
         "Tarjeta Débito", None, "transactions/year=2025/month=03/day=01/T2.csv")]
    checks = dict(gold_rows(tmp_path, "SELECT check_name, actual FROM gold.reconciliation WHERE table_name = 'card_purchases'"))
    assert checks["row_count_matches_silver"] == 2 and checks["missing_merchant_kept_as_null"] == 1
    assert len(checks) == 12


def test_card_purchase_hash_changes_only_with_published_columns(tmp_path):
    run(tmp_path, make_silver(tmp_path), BOTH)
    before = dict(gold_rows(tmp_path, "SELECT transaction_id, row_hash FROM gold.card_purchases"))
    purchases = with_row(PURCHASES, 0, category="Travel")             # not published: same hash
    bronze = [(b[0], "20.0", *b[2:]) if b[0] == "T2" else b for b in bronze_for(purchases)]  # amount text: new hash
    run(tmp_path, make_silver(tmp_path, purchases=purchases, bronze=bronze), BOTH)
    after = dict(gold_rows(tmp_path, "SELECT transaction_id, row_hash FROM gold.card_purchases"))
    assert after["T1"] == before["T1"] and after["T2"] != before["T2"]


def _bronze(change):
    return [change(b) for b in bronze_for(PURCHASES)]


@pytest.mark.parametrize(("kwargs", "failed"), [
    ({"products": with_row(PRODUCTS, 0, owner="C2")}, "product_owned_by_another_customer"),
    ({"purchases": with_row(PURCHASES, 0, product_id="PX")}, "product_missing"),
    ({"purchases": PURCHASES + [("T5", "C3", "P3", "2025-04-01 10:00:00", "Cine", "Fun", 9.0, "USD", "México",
                                 "Purchase", "Approved")]}, "not_a_card_product"),
    ({"products": PRODUCTS + [("P9", "C9", "Tarjeta Débito", "5555")],
      "purchases": PURCHASES + [("T9", "C9", "P9", "2025-04-01 10:00:00", "Cine", "Fun", 9.0, "USD", "México",
                                 "Purchase", "Approved")]}, "customer_missing_from_gold_customers"),
    ({"bronze": bronze_for(PURCHASES) + [bronze_for(PURCHASES)[0]]}, "bronze_rows_not_exactly_one"),
    ({"bronze": [b for b in bronze_for(PURCHASES) if b[0] != "T2"]}, "bronze_rows_not_exactly_one"),
    ({"bronze": _bronze(lambda b: (b[0], "2.976349e4", *b[2:]) if b[0] == "T1" else b)}, "amount_malformed_or_not_positive"),
    ({"bronze": _bronze(lambda b: (b[0], "29763.48", *b[2:]) if b[0] == "T1" else b)}, "amount_differs_from_silver"),
    ({"bronze": _bronze(lambda b: (*b[:2], "2025-03-01 03:00:01", b[3]) if b[0] == "T1" else b)}, "wall_time_differs_from_silver"),
    ({"bronze": _bronze(lambda b: (*b[:2], "2025-03-01T03:00:00Z", b[3]) if b[0] == "T1" else b)}, "wall_time_differs_from_silver"),
    ({"purchases": with_row(PURCHASES, 1, currency="usd")}, "currency_malformed"),
])
def test_a_failed_card_purchase_check_rolls_back_every_table(tmp_path, kwargs, failed):
    first_build, _ = run(tmp_path, make_silver(tmp_path), BOTH)
    renamed = [("C2", "Bruna", "Lima", "Colombia", "Plus") if c[0] == "C2" else c for c in CUSTOMERS]
    with pytest.raises(gb.GoldCheckError) as err:
        run(tmp_path, make_silver(tmp_path, customers=renamed, **kwargs), BOTH)
    assert failed in {c.name for c in err.value.failed}
    # The customers rebuild in the same transaction is rolled back too.
    assert gold_rows(tmp_path, "SELECT display_name FROM gold.customers WHERE customer_id = 'C2'") == [("Bruno L.",)]
    assert gold_rows(tmp_path, "SELECT count(*) FROM gold.card_purchases") == [(2,)]
    assert gold_rows(tmp_path, "SELECT build_id FROM gold.builds") == [(first_build,)]