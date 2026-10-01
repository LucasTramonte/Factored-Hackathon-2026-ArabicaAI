"""Adversarial fixtures for the Gold cohort: who is served, which rows, and how the seed parts load.

Each test builds a tiny Bronze/Silver DuckDB and applies the seed parts to SQLite with the
Worker's real migrations, which stands in for D1. The tests try to leak other customers' rows,
holdout statistics or risk fields into the cohort, and to break the write budget and reruns.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb
import pytest

from data_pipelines.gold import cohort as gold
from data_pipelines.gold.intake_slice import MIGRATIONS

AS_OF = date(2026, 6, 17)
SECRET = ("987654", "0.4242", "123456789")  # credit score, fraud score, income sentinels


def customer(cid, country="México", status="Active", first="Ana", last="Pérez", accent="mexican", segment="Basic"):
    return (cid, first, last, country, accent, segment, status, int(SECRET[0]), int(SECRET[2]))


def purchases(cid, n, start="2026-06-10 12:00:00", product=None, **kw):
    when = datetime.fromisoformat(start)
    return [purchase(f"{cid}-T{i}", cid, (when - timedelta(days=i)).isoformat(" "), product=product, **kw) for i in range(n)]


def purchase(tid, cid, when, product=None, merchant="Shop", status="Approved", kind="Purchase"):
    return (tid, cid, product or f"{cid}-P", when, merchant, "USD", kind, status)


def make_db(tmp_path: Path, customers, transactions, complaints, products=None, bronze=None) -> Path:
    """Minimal Bronze/Silver schema with the columns the cohort projects."""
    path = tmp_path / "cohort.duckdb"
    path.unlink(missing_ok=True)
    products = products if products is not None else [(f"{c[0]}-P", c[0]) for c in customers]
    bronze = bronze if bronze is not None else [(t[0], "10.50", f"transactions/{t[3][:10]}/part.csv", t[3]) for t in transactions]
    with duckdb.connect(str(path)) as con:
        con.execute("CREATE SCHEMA bronze; CREATE SCHEMA silver")
        con.execute("CREATE TABLE silver.dim_customers(customer_id VARCHAR, first_name VARCHAR, last_name VARCHAR, country VARCHAR,"
                    " detected_accent VARCHAR, segment VARCHAR, customer_status VARCHAR, credit_score INTEGER,"
                    " estimated_monthly_income BIGINT)")
        con.execute("CREATE TABLE silver.dim_products(product_id VARCHAR, customer_id VARCHAR, product_type VARCHAR,"
                    " product_number VARCHAR, currency VARCHAR, product_status VARCHAR)")
        con.execute("CREATE TABLE silver.fact_transactions(transaction_id VARCHAR, customer_id VARCHAR, product_id VARCHAR,"
                    " transaction_date TIMESTAMP, merchant_name VARCHAR, currency VARCHAR, transaction_type VARCHAR,"
                    f" transaction_status VARCHAR, fraud_score DOUBLE DEFAULT {SECRET[1]}, is_fraud BOOLEAN DEFAULT true)")
        con.execute("CREATE TABLE silver.fact_complaints(complaint_id VARCHAR, customer_id VARCHAR, creation_date TIMESTAMP, subcategory VARCHAR)")
        con.execute("CREATE TABLE bronze.transactions(transaction_id VARCHAR, amount VARCHAR, _source_file VARCHAR, transaction_date VARCHAR)")
        con.executemany("INSERT INTO silver.dim_customers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", customers)
        con.executemany("INSERT INTO silver.dim_products VALUES (?, ?, 'Tarjeta Crédito', '4111222233334444', 'USD', 'Active')", products)
        con.executemany("INSERT INTO silver.fact_transactions (transaction_id, customer_id, product_id, transaction_date, merchant_name,"
                        " currency, transaction_type, transaction_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", transactions)
        con.executemany("INSERT INTO silver.fact_complaints VALUES (?, ?, ?, ?)", complaints)
        if bronze:
            con.executemany("INSERT INTO bronze.transactions VALUES (?, ?, ?, ?)", bronze)
    return path


def make_quality(tmp_path: Path, db: Path, **override) -> Path:
    meta = {"ready": True, "errors": 0, "generated_at_utc": (datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat(),
            "tables": ["customers", "products", "transactions", "complaints"], "database": str(db.resolve()),
            "watermarks": [{"table": "transactions", "last_loaded_date": str(AS_OF)}]}
    meta.update(override)
    path = tmp_path / "quality.json"
    path.write_text(json.dumps({"metadata": meta}))
    return path


def complaint(cid, when="2025-05-01 10:00:00", sub="Cargo no reconocido"):
    return (f"Q-{cid}-{when[:10]}-{sub[:4]}", cid, when, sub)


def standard(tmp_path, extra_customers=(), extra_tx=(), extra_complaints=(), **kw):
    customers = [customer("A")] + list(extra_customers)
    tx = purchases("A", 3) + list(extra_tx)
    complaints = [complaint("A")] + list(extra_complaints)
    return make_db(tmp_path, customers, tx, complaints, **kw)


def build(tmp_path, db, **params):
    return gold.build_cohort(db, make_quality(tmp_path, db), gold.CohortParams(as_of=AS_OF, **params))


def d1(*parts: str) -> sqlite3.Connection:
    con = sqlite3.connect(":memory:")
    con.execute("PRAGMA foreign_keys=ON")
    for migration in sorted(MIGRATIONS.glob("*.sql")):
        con.executescript(migration.read_text())
    for part in parts:
        con.executescript(part)
    return con


def selected(manifest) -> set[str]:
    return {c["customer_id"] for c in manifest["customers"]}


# ---------------------------------------------------------------- selection

def test_a_disputing_customer_with_recent_purchases_is_served_with_source_values(tmp_path):
    parts, manifest = build(tmp_path, standard(tmp_path))
    con = d1(*parts)
    assert con.execute("SELECT customer_id, display_name, source, country FROM customers").fetchall() == [
        ("A", "Ana P.", "dataset", "México")]
    assert con.execute("SELECT count(*), min(amount), min(currency) FROM transactions").fetchone() == (3, "10.50", "USD")
    assert con.execute("SELECT source_occurred_at FROM transactions ORDER BY 1 DESC LIMIT 1").fetchone() == ("2026-06-10T12:00:00",)
    assert con.execute("SELECT count(*) FROM sample_provenance").fetchone() == (3,)
    assert json.loads(con.execute("SELECT card_json FROM context_cards").fetchone()[0])["first_name"] == "Ana"
    assert selected(manifest) == {"A"}
    assert "INSERT INTO cases" not in "".join(parts) and "INSERT INTO sessions" not in "".join(parts)


@pytest.mark.parametrize("label, customers, tx, complaints", [
    ("no complaint", [customer("B")], purchases("B", 5), []),
    ("another complaint type", [customer("B")], purchases("B", 5), [complaint("B", sub="Cobro indebido")]),
    ("complaint only in the holdout", [customer("B")], purchases("B", 5), [complaint("B", when="2026-02-01 10:00:00")]),
    ("too few purchases", [customer("B")], purchases("B", 2), [complaint("B")]),
    ("closed account", [customer("B", status="Closed")], purchases("B", 5), [complaint("B")]),
    ("declined and refunds do not count", [customer("B")],
     purchases("B", 2) + [purchase("B-D", "B", "2026-06-01 10:00:00", status="Declined"),
                          purchase("B-R", "B", "2026-06-01 11:00:00", kind="Refund")], [complaint("B")]),
    ("rows without a merchant do not count", [customer("B")],
     purchases("B", 2) + [purchase("B-N", "B", "2026-06-01 10:00:00", merchant=None)], [complaint("B")]),
])
def test_customers_outside_the_definition_are_never_served(tmp_path, label, customers, tx, complaints):
    parts, manifest = build(tmp_path, standard(tmp_path, customers, tx, complaints))
    assert selected(manifest) == {"A"}, label
    assert "'B" not in "".join(parts), label


def test_the_window_is_exactly_w_days_open_at_its_start_and_closed_at_as_of(tmp_path):
    # The window is (end - W, end) with end = as_of + 1 day, so it is exactly W days long.
    start = datetime(2026, 6, 18) - timedelta(days=120)
    tx = [purchase("B1", "B", (start).isoformat(" ")),                      # exactly 120 days back: out
          purchase("B2", "B", (start + timedelta(seconds=1)).isoformat(" ")),
          purchase("B3", "B", "2026-06-17 23:59:59"),                       # as_of itself: in
          purchase("B4", "B", "2026-06-18 00:00:00"),                       # after as_of: out
          purchase("B5", "B", "2026-06-16 12:00:00")]
    parts, manifest = build(tmp_path, standard(tmp_path, [customer("B")], tx, [complaint("B")]))
    con = d1(*parts)
    assert {r[0] for r in con.execute("SELECT transaction_id FROM transactions WHERE customer_id='B'")} == {"B2", "B3", "B5"}


def test_each_customer_is_capped_at_the_most_recent_purchases(tmp_path):
    db = standard(tmp_path, [customer("B")], purchases("B", 8), [complaint("B")])
    parts, manifest = build(tmp_path, db, max_per_customer=5)
    con = d1(*parts)
    kept = [r[0] for r in con.execute("SELECT transaction_id FROM transactions WHERE customer_id='B' ORDER BY source_occurred_at DESC")]
    assert kept == [f"B-T{i}" for i in range(5)]
    assert manifest["exclusions"]["rows_over_per_customer_cap"] == 3


# ---------------------------------------------------------------- fail closed

def test_a_purchase_on_another_customers_product_fails_the_build(tmp_path):
    db = standard(tmp_path, [customer("B")], purchases("B", 3, product="A-P"), [complaint("B")])
    with pytest.raises(ValueError, match="ownership"):
        build(tmp_path, db)


def test_a_purchase_without_one_bronze_source_row_fails_the_build(tmp_path):
    tx = purchases("A", 3)
    bronze = [(t[0], "10.50", "f.csv", t[3]) for t in tx] + [(tx[0][0], "10.50", "g.csv", tx[0][3])]
    with pytest.raises(ValueError, match="Bronze"):
        build(tmp_path, make_db(tmp_path, [customer("A")], tx, [complaint("A")], bronze=bronze))


def test_a_stale_or_incomplete_quality_report_fails_the_build(tmp_path):
    db = standard(tmp_path)
    params = gold.CohortParams(as_of=AS_OF)
    with pytest.raises(ValueError, match="complaints"):
        gold.build_cohort(db, make_quality(tmp_path, db, tables=["customers", "products", "transactions"]), params)
    with pytest.raises(ValueError, match="quality"):
        gold.build_cohort(db, make_quality(tmp_path, db, watermarks=[{"table": "transactions", "last_loaded_date": "2026-06-16"}]), params)


@pytest.mark.parametrize("bad", [{"window_days": 0}, {"window_days": 121}, {"min_purchases": 0},
                                 {"max_per_customer": 0}, {"size": 0}, {"salt": ""}])
def test_parameters_outside_their_bounds_are_rejected(tmp_path, bad):
    with pytest.raises(ValueError):
        gold.CohortParams(as_of=AS_OF, **bad)


# ---------------------------------------------------------------- what never leaves Silver

def test_risk_and_value_fields_never_reach_the_seed_or_the_manifest(tmp_path):
    parts, manifest = build(tmp_path, standard(tmp_path))
    text = "".join(parts) + json.dumps(manifest)
    for sentinel in SECRET:
        assert sentinel not in text
    for column in ("fraud", "credit_score", "income"):
        assert column not in text


def test_hostile_names_are_stored_exactly_and_cannot_break_the_seed(tmp_path):
    first, last = "Zoë 🙂 𝔸na", "O'Brien'); DELETE FROM customers; --"
    db = make_db(tmp_path, [customer("A", first=first, last=last)], purchases("A", 3), [complaint("A")])
    parts, _ = build(tmp_path, db)
    con = d1(*parts)
    assert con.execute("SELECT display_name FROM customers").fetchone() == (f"{first} O.",)
    assert con.execute("SELECT count(*) FROM transactions").fetchone() == (3,)


# ---------------------------------------------------------------- determinism, quotas, holdout

def test_output_is_deterministic_and_the_salt_changes_a_capped_sample(tmp_path):
    many = [customer(f"C{i:02d}") for i in range(12)]
    tx = [row for c in many for row in purchases(c[0], 3)]
    db = make_db(tmp_path, many, tx, [complaint(c[0]) for c in many])
    quality = make_quality(tmp_path, db)
    run = lambda **kw: gold.build_cohort(db, quality, gold.CohortParams(as_of=AS_OF, size=4, country_floor=1, **kw))
    first = run()
    assert first == run()
    assert len(selected(first[1])) == 4
    others = {frozenset(selected(run(salt=s)[1])) for s in ("a", "b", "c", "d")}
    assert len(others) > 1


def test_quotas_take_the_floor_then_split_the_rest_by_largest_remainder():
    shares = {"México": 0.4995, "Colombia": 0.3027, "Argentina": 0.1978}
    plenty = {k: 10_000 for k in shares}
    quotas = gold.allocate_quotas(plenty, shares, size=1000, floor=100)
    assert sum(quotas.values()) == 1000 and min(quotas.values()) >= 100
    assert quotas == {"México": 450, "Colombia": 312, "Argentina": 238}


def test_a_short_country_keeps_what_it_has_and_its_gap_is_not_redistributed():
    shares = {"México": 0.5, "Colombia": 0.3, "Argentina": 0.2}
    quotas = gold.allocate_quotas({"México": 10_000, "Colombia": 10_000, "Argentina": 40}, shares, size=1000, floor=100)
    assert quotas == {"México": 450, "Colombia": 310, "Argentina": 40}


def test_everyone_is_served_when_the_eligible_pool_is_below_the_target(tmp_path):
    db = standard(tmp_path, [customer("B", country="Colombia")], purchases("B", 3), [complaint("B")])
    _, manifest = build(tmp_path, db, size=1000)
    assert selected(manifest) == {"A", "B"}
    assert manifest["sampling"] == "all_eligible"


def test_holdout_complaints_never_change_who_is_served_or_the_reference_shares(tmp_path):
    base = standard(tmp_path, [customer("B", country="Colombia")], purchases("B", 3), [complaint("B")])
    _, before = build(tmp_path, base)
    with duckdb.connect(str(base)) as con:
        con.execute("INSERT INTO silver.fact_complaints VALUES ('QH', 'B', TIMESTAMP '2026-03-01 10:00:00', 'Cargo no reconocido'),"
                    " ('QH2', 'A', TIMESTAMP '2026-04-01 10:00:00', 'Cargo no reconocido')")
    _, after = build(tmp_path, base)
    assert selected(before) == selected(after)
    assert before["reference_shares"] == after["reference_shares"]


# ---------------------------------------------------------------- write budget and parts

def test_expected_writes_follow_the_index_count():
    assert gold.estimate_writes(customers=10, cards=10, transactions=30) == 2 * 10 + 2 * 10 + 6 * 30


def test_parts_stay_under_the_write_limit_keep_each_customer_whole_and_load_in_order(tmp_path):
    many = [customer(f"C{i:02d}") for i in range(6)]
    db = make_db(tmp_path, many, [row for c in many for row in purchases(c[0], 4)], [complaint(c[0]) for c in many])
    parts, manifest = build(tmp_path, db, part_write_limit=70)  # one customer = 2 + 2 + 6 * 4 = 28 writes
    assert len(parts) == 3
    assert [p["expected_writes"] for p in manifest["parts"]] == [56, 56, 56]
    assert all(p["expected_writes"] <= 70 for p in manifest["parts"])
    con = d1()
    for part in parts:  # each part loads on its own, in order, with foreign keys on
        con.executescript(part)
    assert con.execute("SELECT count(*) FROM transactions").fetchone() == (24,)
    assert [p["version"] for p in manifest["parts"]] == [gold.content_version(p) for p in parts]


def test_a_customer_larger_than_the_part_limit_is_refused(tmp_path):
    with pytest.raises(ValueError, match="write limit"):
        build(tmp_path, standard(tmp_path), part_write_limit=10)


def test_a_rerun_is_a_noop_and_stored_drift_fails(tmp_path):
    parts, _ = build(tmp_path, standard(tmp_path))
    con = d1(*parts)
    con.executescript(parts[0])
    assert con.execute("SELECT count(*) FROM transactions").fetchone() == (3,)
    con.execute("UPDATE customers SET display_name = 'Someone else' WHERE customer_id = 'A'")
    with pytest.raises(sqlite3.IntegrityError):
        con.executescript(parts[0])


def test_the_manifest_reconciles_counts_per_country(tmp_path):
    db = standard(tmp_path, [customer("B", country="Colombia"), customer("C", country="Colombia")],
                  purchases("B", 3) + purchases("C", 1), [complaint("B"), complaint("C")])
    _, manifest = build(tmp_path, db)
    assert manifest["by_country"] == {"Colombia": {"eligible": 2, "dense": 1, "selected": 1},
                                      "México": {"eligible": 1, "dense": 1, "selected": 1}}
    assert manifest["exclusions"]["customers_below_min_purchases"] == 1
    assert manifest["params"]["window_days"] == 120 and manifest["as_of"] == str(AS_OF)


def test_no_cohort_customer_id_is_in_a_tracked_file():
    """Dataset ids live only in ignored data/ and in D1. Skipped where no cohort was built."""
    import subprocess
    root = MIGRATIONS.parents[1]
    manifests = sorted((root / "data/gold_cohort").glob("*/manifest.json"))
    if not manifests:
        pytest.skip("no local cohort manifest")
    ids = {c["customer_id"] for m in manifests for c in json.loads(m.read_text())["customers"]}
    tracked = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True, check=True).stdout.split(b"\0")
    # Pre-existing profile reports list sample source values (ids among them). Whether they may stay in the
    # public repository is decided in that review, for the whole file; the cohort must not add any.
    reviewed_elsewhere = {b"data_profiles/bronze_data_profile/bronze_profile.md"}
    leaked = set()
    for name in filter(lambda n: n and n not in reviewed_elsewhere, tracked):
        path = root / name.decode()
        if path.is_file() and path.stat().st_size < 5_000_000:
            text = path.read_bytes().decode("utf-8", "ignore")
            leaked |= {i for i in ids if i in text}
    assert not leaked, f"{len(leaked)} cohort customer ids appear in tracked files"
