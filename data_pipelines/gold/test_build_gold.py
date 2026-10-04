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

# customer_id, first_name, last_name, country, segment[, detected_accent (default NULL), customer_status (default 'Active')]
CUSTOMERS = [("C1", " Ana ", "gómez", "Argentina", "Basic"),
             ("C2", "Bruno", "Lima", "Colombia", "Plus"),
             ("C3", "Carla", "Ruiz", "México", "Student")]
# product_id, customer_id, product_type, product_number[, currency (default 'ARS'), product_status (default 'Active')]
PRODUCTS = [("P1", "C1", "Tarjeta Crédito", "4111222233334444"),
            ("P2", "C2", "Tarjeta Débito", "123"),
            ("P3", "C3", "Cuenta Ahorro", "9999888877776666")]
# transaction_id, customer_id, product_id, Silver timestamp, merchant, category, Silver amount, currency, country, type, status
PURCHASES = [("T1", "C1", "P1", "2025-03-01 03:00:00", "Uber", "Transport", 29763.49, "ARS", "Argentina", "Purchase", "Approved"),
             ("T2", "C2", "P2", "2026-02-26 13:21:51", None, "Food", 20.0, "USD", "USA", "Purchase", "Approved"),
             ("T3", "C1", "P1", "2025-03-02 10:00:00", "Uber", "Transport", 5.0, "ARS", "Argentina", "Purchase", "Declined"),
             ("T4", "C3", "P3", "2025-03-03 10:00:00", None, None, 7.0, "USD", "México", "Withdrawal", "Approved")]
# complaint_id, customer_id, creation_date, category, subcategory
COMPLAINTS = [("Q1", "C1", "2025-03-10 02:00:00", "Transactions", "Cargo no reconocido"),
              ("Q2", "C1", "2026-02-02 09:00:00", "Transactions", "Cargo no reconocido"),  # holdout: kept, consumers bound it
              ("Q3", "C2", "2025-04-10 12:00:00", "Fees", "Cobro indebido"),
              ("Q4", "C2", "2025-05-01 12:00:00", "Transactions", None)]                  # no subcategory: own group


def bronze_for(purchases):
    """The Bronze strings Silver was typed from: the exact amount text and wall time, one row each."""
    texts = {"T1": "29763.49", "T2": "20.00"}
    return [(p[0], texts.get(p[0], f"{p[6]:.2f}"), p[3], f"transactions/year=2025/month=03/day=01/{p[0]}.csv")
            for p in purchases]


def make_silver(tmp_path: Path, customers=CUSTOMERS, products=PRODUCTS, purchases=PURCHASES, bronze=None,
                complaints=COMPLAINTS) -> Path:
    """A tiny Bronze/Silver DuckDB with only the columns Gold projects."""
    path = tmp_path / "silver_fixture.duckdb"
    path.unlink(missing_ok=True)
    bronze = bronze_for(purchases) if bronze is None else bronze
    with duckdb.connect(str(path)) as con:
        con.execute("CREATE SCHEMA silver; CREATE SCHEMA bronze")
        con.execute("CREATE TABLE silver.dim_customers(customer_id VARCHAR, first_name VARCHAR, last_name VARCHAR,"
                    " country VARCHAR, segment VARCHAR, detected_accent VARCHAR DEFAULT NULL, customer_status VARCHAR DEFAULT 'Active')")
        con.execute("CREATE TABLE silver.dim_products(product_id VARCHAR, customer_id VARCHAR, product_type VARCHAR,"
                    " product_number VARCHAR, currency VARCHAR DEFAULT 'ARS', product_status VARCHAR DEFAULT 'Active')")
        con.execute("CREATE TABLE silver.fact_transactions(transaction_id VARCHAR, customer_id VARCHAR, product_id VARCHAR,"
                    " transaction_date TIMESTAMP, merchant_name VARCHAR, merchant_category VARCHAR, amount DOUBLE,"
                    " currency VARCHAR, transaction_country VARCHAR, transaction_type VARCHAR, transaction_status VARCHAR)")
        con.execute("CREATE TABLE silver.fact_complaints(complaint_id VARCHAR, customer_id VARCHAR, creation_date TIMESTAMP,"
                    " category VARCHAR, subcategory VARCHAR, assignment_date TIMESTAMP DEFAULT NULL,"
                    " first_response_date TIMESTAMP DEFAULT NULL, resolution_date TIMESTAMP DEFAULT NULL)")
        con.execute("CREATE TABLE bronze.transactions(transaction_id VARCHAR, amount VARCHAR, transaction_date VARCHAR,"
                    " _source_file VARCHAR)")
        for table, rows in (("silver.dim_customers", customers), ("silver.dim_products", products),
                            ("silver.fact_transactions", purchases), ("bronze.transactions", bronze),
                            ("silver.fact_complaints", complaints)):
            columns = [r[0] for r in con.execute(f"DESCRIBE {table}").fetchall()]
            for width in sorted({len(r) for r in rows or []}):  # shorter rows take the column defaults
                con.executemany(f"INSERT INTO {table} ({', '.join(columns[:width])}) VALUES ({', '.join('?' * width)})",
                                [r for r in rows if len(r) == width])
    return path


def make_quality(tmp_path: Path, silver: Path, name="quality_results.json", **override) -> Path:
    meta = {"ready": True, "errors": 0, "tables": ["customers", "products", "transactions", "complaints"],
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
        ("C1", "Ana g.", "Argentina", "Basic"), ("C2", "Bruno L.", "Colombia", "Plus"), ("C3", "Carla R.", "México", "Student")]


def test_every_check_is_recorded_with_its_build(tmp_path):
    build_id, checks = run(tmp_path, make_silver(tmp_path))
    assert all(c.passed for c in checks) and len(checks) == 7
    assert gold_rows(tmp_path, "SELECT count(*), bool_and(passed) FROM gold.reconciliation WHERE build_id = "
                     f"'{build_id}'") == [(7, True)]
    assert gold_rows(tmp_path, "SELECT build_id, tables FROM gold.builds") == [(build_id, ["customers"])]
    assert gold_rows(tmp_path, "SELECT actual FROM gold.reconciliation WHERE check_name = 'row_count_matches_silver'") == [(3,)]


def test_row_hash_changes_only_with_published_columns(tmp_path):
    silver = make_silver(tmp_path)
    run(tmp_path, silver)
    before = dict(gold_rows(tmp_path, "SELECT customer_id, row_hash FROM gold.customers"))
    changed = [("C1", " Ana ", "gómez", "Argentina", "Premium", None, "Closed"),  # segment, status: not in D1
               ("C2", "Bruno", "Silva", "Colombia", "Plus"),                      # display name: written to D1
               ("C3", "Carla", "Ruiz", "Colombia", "Student")]                    # country: written to D1 (0006)
    run(tmp_path, make_silver(tmp_path, changed))
    after = dict(gold_rows(tmp_path, "SELECT customer_id, row_hash FROM gold.customers"))
    assert after["C1"] == before["C1"]
    assert after["C2"] != before["C2"] and after["C3"] != before["C3"]


@pytest.mark.parametrize(("customers", "failed"), [
    (CUSTOMERS + [("C1", "Ana", "Gómez", "Argentina", "Basic")], "duplicate_customer_id"),
    (CUSTOMERS + [(None, "Nadie", "X", "Colombia", "Basic")], "null_customer_id"),
    (CUSTOMERS + [("C4", "  ", None, "Colombia", "Basic")], "blank_display_name"),
    (CUSTOMERS + [("C4", "Dora", "Paz", "Colombia", "Basic", None, None)], "missing_customer_status"),
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
    # NULL product_type: NOT IN alone would yield NULL and let the row pass.
    ({"products": [("P1", "C1", None, "4111222233334444"), *PRODUCTS[1:]]}, "not_a_card_product"),
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

# ---- gold.context_cards -----------------------------------------------------------------------

from intake_agent.context_card import build_context_card  # noqa: E402  (the reference implementation)

CARD_TABLES = ("customers", "context_cards")
CARD_CUSTOMERS = [("C1", ' Ana "la"\t', "gómez", "Argentina", "Basic", "argentine"),  # accent → es-AR; raw name kept
                  ("C2", "Bruno\\Ü", "Lima", "Colombia", "Plus", None),               # no accent → country → es-CO
                  ("C3", "Carla", "Ruiz", "México", "Student", "colombian"),          # accent wins over country
                  ("C4", "Dora", "Paz", "Brasil", "Basic", None)]                     # unknown → es-419; no products
CARD_PRODUCTS = [("P1", "C1", "Tarjeta Crédito", "4111222233334444", "ARS", "Active"),
                 ("P1b", "C1", "Cuenta Ahorro", "0000111122223333", "ARS", "Active"),
                 ("P1c", "C1", "Tarjeta Crédito", "5555000011112222", "USD", "Active"),
                 ("P1d", "C1", "Préstamo Personal", "9876543210", "ARS", "Closed"),       # not active: left off
                 ("P2", "C2", "Tarjeta Débito", "123", "COP", "Active"),                  # short number: last4 null
                 ("P3", "C3", "Cuenta Ahorro", "9999888877776666", "USD", "Active")]


def card_silver(tmp_path, customers=CARD_CUSTOMERS, products=CARD_PRODUCTS):
    return make_silver(tmp_path, customers=customers, products=products)


def test_cards_are_byte_identical_to_the_python_builder(tmp_path):
    silver = card_silver(tmp_path)
    run(tmp_path, silver, CARD_TABLES)
    gold = dict(gold_rows(tmp_path, "SELECT customer_id, card_json FROM gold.context_cards"))
    with duckdb.connect(str(silver), read_only=True) as con:
        expected = {c[0]: json.dumps(build_context_card(con, c[0]), ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")) for c in CARD_CUSTOMERS}
    assert gold == expected
    c1 = json.loads(gold["C1"])
    assert c1["locale_hint"] == "es-AR" and c1["first_name"] == ' Ana "la"\t'
    assert [(p["product_type"], p["last4"]) for p in c1["products"]] == [
        ("Cuenta Ahorro", "3333"), ("Tarjeta Crédito", "2222"), ("Tarjeta Crédito", "4444")]
    assert json.loads(gold["C2"])["products"] == [{"currency": "COP", "last4": None, "product_type": "Tarjeta Débito"}]
    assert json.loads(gold["C3"])["locale_hint"] == "es-CO"
    assert json.loads(gold["C4"]) == {"first_name": "Dora", "locale_hint": "es-419", "products": []}


def test_cards_carry_the_version_and_quality_time_and_report_their_checks(tmp_path):
    silver = card_silver(tmp_path)
    quality = gb.check_quality(silver, make_quality(tmp_path, silver), {"customers"})
    with gb.connect(tmp_path / "gold_fixture.duckdb", silver) as con:
        _, checks = gb.build(con, CARD_TABLES, silver, quality)
    assert set(gold_rows(tmp_path, "SELECT card_version, snapshot_at FROM gold.context_cards")) == {
        (1, quality["generated_at_utc"])}
    found = {c.name: (c.expected, c.actual) for c in checks if c.table == "context_cards"}
    assert len(found) == 9
    assert found["active_products_match_silver"] == (5, 5)
    assert found["customers_without_active_product"] == (1, 1)


def test_card_hash_ignores_a_newer_quality_run_but_not_a_content_change(tmp_path):
    silver = card_silver(tmp_path)
    run(tmp_path, silver, CARD_TABLES)
    query = "SELECT customer_id, row_hash, snapshot_at FROM gold.context_cards"
    before = {r[0]: r[1:] for r in gold_rows(tmp_path, query)}
    renamed = [("C2", "Bruna", *c[2:]) if c[0] == "C2" else c for c in CARD_CUSTOMERS]
    run(tmp_path, card_silver(tmp_path, customers=renamed), CARD_TABLES)   # a new quality run, written later
    after = {r[0]: r[1:] for r in gold_rows(tmp_path, query)}
    assert after["C1"][1] != before["C1"][1]      # snapshot_at moved to the newer quality run...
    assert after["C1"][0] == before["C1"][0]      # ...but an unchanged card keeps its hash
    assert after["C2"][0] != before["C2"][0]      # a changed first name changes it


@pytest.mark.parametrize(("products", "failed"), [
    (CARD_PRODUCTS + [("P5", "C3", "Tarjeta Débito", "12a4", "USD", "Active")], "product_field_rejected_by_worker"),
    (CARD_PRODUCTS + [("P5", "C3", "Tarjeta Débito", "1234", "usd", "Active")], "product_field_rejected_by_worker"),
])
def test_a_card_the_worker_would_reject_rolls_the_build_back(tmp_path, products, failed):
    first_build, _ = run(tmp_path, card_silver(tmp_path), CARD_TABLES)
    with pytest.raises(gb.GoldCheckError) as err:
        run(tmp_path, card_silver(tmp_path, products=products), CARD_TABLES)
    assert failed in {c.name for c in err.value.failed}
    assert gold_rows(tmp_path, "SELECT build_id FROM gold.builds") == [(first_build,)]
    assert gold_rows(tmp_path, "SELECT count(*) FROM gold.context_cards") == [(4,)]


def test_a_blank_first_name_fails_the_card_even_though_the_customer_row_passes(tmp_path):
    customers = CARD_CUSTOMERS + [("C5", "  ", "Vega", "Colombia", "Basic", None)]
    with pytest.raises(gb.GoldCheckError) as err:
        run(tmp_path, card_silver(tmp_path, customers=customers), CARD_TABLES)
    assert {c.name for c in err.value.failed} == {"blank_first_name"}

# ---- gold.customer_complaints, shared name rule, occurred_at, build log --------------------------

from data_pipelines.gold.cohort import _display_name  # noqa: E402  (the rule D1 serves today)


def test_complaints_are_counted_per_customer_and_type_with_first_and_last_times(tmp_path):
    _, checks = run(tmp_path, make_silver(tmp_path), ("customers", "customer_complaints"))
    rows = gold_rows(tmp_path, "SELECT customer_id, category, subcategory, complaints, first_created_at::VARCHAR,"
                               " last_created_at::VARCHAR FROM gold.customer_complaints")
    assert rows == [("C1", "Transactions", "Cargo no reconocido", 2, "2025-03-10 02:00:00", "2026-02-02 09:00:00"),
                    ("C2", "Fees", "Cobro indebido", 1, "2025-04-10 12:00:00", "2025-04-10 12:00:00"),
                    ("C2", "Transactions", None, 1, "2025-05-01 12:00:00", "2025-05-01 12:00:00")]
    found = {c.name: (c.expected, c.actual) for c in checks if c.table == "customer_complaints"}
    assert len(found) == 6 and all(e == a for e, a in found.values())
    assert found["complaints_match_silver"] == (4, 4) and found["missing_subcategory_kept_as_null"] == (1, 1)


def test_a_complaint_from_an_unknown_customer_rolls_the_build_back(tmp_path):
    complaints = COMPLAINTS + [("Q9", "C9", "2025-06-01 10:00:00", "Fees", "Cobro indebido")]
    with pytest.raises(gb.GoldCheckError) as err:
        run(tmp_path, make_silver(tmp_path, complaints=complaints), ("customers", "customer_complaints"))
    assert {c.name for c in err.value.failed} == {"customer_missing_from_gold_customers"}


@pytest.mark.parametrize(("first", "last"), [
    (" Ana ", "gómez"), ("Bruno", "Lima"), ("Dora", None), ("Dora", "  "), ("María José", "de la Cruz"),
    ("Ñandú", "Ñúñez"), ("Zoë", "O'Brien"),
    ("\tAna\n", "\tgómez "), ("Ana", "\n\t "), ("  Luis\r\n", "Paz\t"),  # whitespace Python strips and trim() kept
])
def test_the_display_name_matches_the_cohort_rule_served_in_d1(tmp_path, first, last):
    customers = [("C1", first, last, "Argentina", "Basic")]
    run(tmp_path, make_silver(tmp_path, customers=customers, products=[], purchases=[], complaints=[]))
    assert gold_rows(tmp_path, "SELECT display_name FROM gold.customers") == [(_display_name(first, last),)]


def test_customers_keep_todays_status_outside_the_row_hash(tmp_path):
    customers = [CUSTOMERS[0] + (None, "Closed"), *CUSTOMERS[1:]]
    run(tmp_path, make_silver(tmp_path))
    before = dict(gold_rows(tmp_path, "SELECT customer_id, row_hash FROM gold.customers"))
    run(tmp_path, make_silver(tmp_path, customers=customers))
    assert gold_rows(tmp_path, "SELECT customer_status FROM gold.customers WHERE customer_id = 'C1'") == [("Closed",)]
    assert dict(gold_rows(tmp_path, "SELECT customer_id, row_hash FROM gold.customers")) == before


def test_card_purchases_carry_the_wall_time_as_a_timestamp_too(tmp_path):
    run(tmp_path, make_silver(tmp_path), BOTH)
    rows = gold_rows(tmp_path, "SELECT source_occurred_at, strftime(occurred_at, '%Y-%m-%dT%H:%M:%S'),"
                               " typeof(occurred_at) FROM gold.card_purchases")
    assert rows and all(served == typed and kind == "TIMESTAMP" for served, typed, kind in rows)


def test_the_build_log_records_the_quality_report_and_its_watermarks(tmp_path):
    silver = make_silver(tmp_path)
    report = make_quality(tmp_path, silver, watermarks=[{"table": "transactions", "last_loaded_date": "2026-06-17"},
                                                        {"table": "complaints", "last_loaded_date": "2026-06-17"}])
    quality = gb.check_quality(silver, report, {"customers"})
    with gb.connect(tmp_path / "gold_fixture.duckdb", silver) as con:
        build_id, _ = gb.build(con, ("customers",), silver, quality, report)
    (logged_report, watermarks), = gold_rows(tmp_path, "SELECT quality_report, watermarks FROM gold.builds")
    assert logged_report == str(report.resolve())
    assert json.loads(watermarks) == {"complaints": "2026-06-17", "transactions": "2026-06-17"}


def test_a_gold_file_from_before_the_build_log_columns_is_upgraded_in_place(tmp_path):
    gold = tmp_path / "gold_fixture.duckdb"
    with duckdb.connect(str(gold)) as con:  # the gold.builds shape of the first committed version
        con.execute("CREATE SCHEMA gold; CREATE TABLE gold.builds (build_id VARCHAR PRIMARY KEY,"
                    " silver_database VARCHAR NOT NULL, quality_generated_at_utc VARCHAR NOT NULL, tables VARCHAR[] NOT NULL)")
        con.execute("INSERT INTO gold.builds VALUES ('old', 's', 't', ['customers'])")
    build_id, _ = run(tmp_path, make_silver(tmp_path))
    assert gold_rows(tmp_path, "SELECT quality_report, watermarks FROM gold.builds WHERE build_id = 'old'") == [(None, None)]
    assert gold_rows(tmp_path, f"SELECT watermarks FROM gold.builds WHERE build_id = '{build_id}'") == [("{}",)]

# ---- review fixes: amounts, quality-run choice, hashes, table lineage, NULL-safe membership --------


@pytest.mark.parametrize("text", ["12,50", "abc", ""])
def test_a_malformed_bronze_amount_fails_its_check_instead_of_crashing(tmp_path, text):
    bronze = [(b[0], text, *b[2:]) if b[0] == "T1" else b for b in bronze_for(PURCHASES)]
    with pytest.raises(gb.GoldCheckError) as err:
        run(tmp_path, make_silver(tmp_path, bronze=bronze), BOTH)
    assert "amount_malformed_or_not_positive" in {c.name for c in err.value.failed}


def test_the_newest_quality_run_is_chosen_by_its_timestamp_not_its_folder_name(tmp_path):
    silver = make_silver(tmp_path)
    runs = tmp_path / "quality_runs"
    make_quality(runs, silver, name="20260929T000000Z/quality_results.json", generated_at_utc="2026-09-29T00:00:00+00:00")
    make_quality(runs, silver, name="pr23-check/quality_results.json", generated_at_utc="2026-09-01T00:00:00+00:00")
    make_quality(runs, silver, name="naive/quality_results.json", generated_at_utc="2026-12-31T00:00:00")
    make_quality(runs, tmp_path / "other.duckdb", name="20261001T000000Z/quality_results.json",
                 generated_at_utc="2026-10-01T00:00:00+00:00")
    (runs / "broken").mkdir()
    (runs / "broken" / "quality_results.json").write_text("{not json", encoding="utf-8")
    assert gb.latest_quality_report(silver, runs) == runs / "20260929T000000Z/quality_results.json"


def test_card_purchase_hash_covers_the_provenance_written_to_d1(tmp_path):
    run(tmp_path, make_silver(tmp_path), BOTH)
    before = dict(gold_rows(tmp_path, "SELECT transaction_id, row_hash FROM gold.card_purchases"))
    moved = [(*b[:3], b[3].replace("day=01", "day=02")) if b[0] == "T1" else b for b in bronze_for(PURCHASES)]
    run(tmp_path, make_silver(tmp_path, bronze=moved), BOTH)
    after = dict(gold_rows(tmp_path, "SELECT transaction_id, row_hash FROM gold.card_purchases"))
    assert after["T1"] != before["T1"] and after["T2"] == before["T2"]


def test_each_table_records_the_build_it_comes_from(tmp_path):
    silver = make_silver(tmp_path)
    first, _ = run(tmp_path, silver, ("customers", "card_purchases"))
    second, _ = run(tmp_path, silver, ("card_purchases",))
    assert dict(gold_rows(tmp_path, "SELECT table_name, build_id FROM gold.table_builds")) == {
        "customers": first, "card_purchases": second}
    with pytest.raises(gb.GoldCheckError):  # a rolled-back build leaves the lineage as it was
        run(tmp_path, make_silver(tmp_path, products=with_row(PRODUCTS, 0, owner="C2")), ("card_purchases",))
    assert dict(gold_rows(tmp_path, "SELECT table_name, build_id FROM gold.table_builds"))["card_purchases"] == second


@pytest.mark.parametrize(("table", "silver_kwargs"), [
    ("card_purchases", {"products": PRODUCTS + [("P9", "C9", "Tarjeta Débito", "5555")],
                        "purchases": PURCHASES + [("T9", "C9", "P9", "2025-04-01 10:00:00", "Cine", "Fun", 9.0, "USD",
                                                   "México", "Purchase", "Approved")]}),
    ("customer_complaints", {"complaints": COMPLAINTS + [("Q9", "C9", "2025-06-01 10:00:00", "Fees", "Cobro indebido")]}),
])
def test_a_null_id_in_gold_customers_cannot_hide_a_missing_customer(tmp_path, table, silver_kwargs):
    run(tmp_path, make_silver(tmp_path))
    with duckdb.connect(str(tmp_path / "gold_fixture.duckdb")) as con:  # NOT IN (... NULL ...) would count 0
        con.execute("INSERT INTO gold.customers (customer_id, display_name) VALUES (NULL, 'ghost')")
    with pytest.raises(gb.GoldCheckError) as err:
        run(tmp_path, make_silver(tmp_path, **silver_kwargs), (table,))
    assert "customer_missing_from_gold_customers" in {c.name for c in err.value.failed}

# complaint_id, customer_id, creation_date, category, subcategory, assignment_date, first_response_date, resolution_date
TIMED = [("R1", "C1", "2025-01-01 00:00:00", "T", "Cargo no reconocido", "2025-01-01 00:00:00", "2025-01-01 10:00:00", "2025-01-11 00:00:00"),
         ("R2", "C1", "2025-01-02 00:00:00", "T", "Cargo no reconocido", "2025-01-02 00:00:00", "2025-01-03 06:00:00", None),
         ("R3", "C2", "2025-01-03 00:00:00", "T", "Cargo no reconocido", "2025-01-03 00:00:00", None, None),
         ("R4", "C2", "2025-01-04 00:00:00", "T", "Cargo no reconocido", "2025-01-04 12:00:00", "2025-01-04 06:00:00", "2025-01-02 00:00:00"),
         ("R5", "C3", "2026-02-01 00:00:00", "T", "Cargo no reconocido", "2026-02-01 00:00:00", "2026-02-01 01:00:00", None),  # after the window
         ("R6", "C3", "2025-01-05 00:00:00", "T", "Cobro indebido", "2025-01-05 00:00:00", "2025-01-05 01:00:00", None)]       # other type


def test_complaint_timing_counts_every_window_complaint_and_keeps_survivor_intervals_apart(tmp_path):
    silver = make_silver(tmp_path, complaints=TIMED)
    quality = gb.check_quality(silver, make_quality(tmp_path, silver), {"complaints"})
    with gb.connect(tmp_path / "gold_fixture.duckdb", silver) as con:
        _, checks = gb.build(con, ("complaint_timing",), silver, quality)
    assert all(c.passed for c in checks) and len(checks) == 4
    rows = gold_rows(tmp_path, "SELECT metric, unit, p50, p90, n, missing, negative, population, subcategory,"
                     " CAST(window_start AS VARCHAR), CAST(window_end_exclusive AS VARCHAR) FROM gold.complaint_timing ORDER BY metric")
    # R5 is after the window and R6 another type; R4's dates run backwards and are counted, not used.
    assert rows == [("creation_to_resolution", "days", 10.0, 10.0, 1, 2, 1, 4, "Cargo no reconocido", "2023-06-17", "2026-01-01"),
                    ("first_response", "hours", 20.0, 28.0, 2, 1, 1, 4, "Cargo no reconocido", "2023-06-17", "2026-01-01")]
