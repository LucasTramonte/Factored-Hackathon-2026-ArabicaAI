"""Fixture tests for the findings queries: headers, the design-window guard and aggregate output.

The fixture is a tiny Silver schema with only the columns the queries project. One row per fact
is dated in the holdout window; design-scope results must not change when it is present.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import duckdb
import pytest

from data_profiles.findings import run_findings as rf

DDL = """
CREATE SCHEMA silver;
CREATE TABLE silver.dim_customers(customer_id VARCHAR, country VARCHAR, segment VARCHAR, detected_accent VARCHAR, last_updated TIMESTAMP);
CREATE TABLE silver.dim_products(product_id VARCHAR, customer_id VARCHAR, product_type VARCHAR, currency VARCHAR,
  opening_date DATE, expiration_date DATE, product_status VARCHAR);
CREATE TABLE silver.fact_transactions(transaction_id VARCHAR, transaction_date TIMESTAMP, process_date DATE, product_id VARCHAR,
  customer_id VARCHAR, transaction_type VARCHAR, transaction_status VARCHAR, amount DOUBLE, currency VARCHAR,
  amount_usd DOUBLE, amount_usd_is_estimated BOOLEAN, merchant_name VARCHAR, merchant_category VARCHAR, transaction_country VARCHAR);
CREATE TABLE silver.fact_complaints(complaint_id VARCHAR, creation_date TIMESTAMP, process_date DATE, customer_id VARCHAR,
  subcategory VARCHAR, description VARCHAR, affected_product_id VARCHAR, claimed_amount DOUBLE, currency VARCHAR);
CREATE TABLE silver.fact_call_center_interactions(interaction_id VARCHAR, contact_reason VARCHAR, reason_category VARCHAR);
CREATE TABLE silver.fact_call_transcripts(transcript_id VARCHAR, interaction_id VARCHAR, customer_text VARCHAR, detected_language VARCHAR);
INSERT INTO silver.dim_customers VALUES ('C1','México','Basic','mexican','2026-01-02'), ('C2','Colombia','Plus',NULL,'2027-01-01');
INSERT INTO silver.dim_products VALUES ('P1','C1','Tarjeta Crédito','USD','2024-01-01','2030-01-01','Active'),
  ('P2','C2','Tarjeta Débito','COP','2024-01-01','2025-01-01','Active');
INSERT INTO silver.fact_transactions VALUES
  ('T1','2025-03-01 03:00:00','2025-02-28','P1','C1','Purchase','Approved',10.50,'USD',10.50,false,'Uber','Transport','México'),
  ('T2','2025-03-03 12:00:00','2025-03-03','P1','C1','Purchase','Approved',20.00,'USD',20.00,false,'Uber','Transport','USA'),
  ('T3','2025-05-01 12:00:00','2025-05-01','P2','C2','Withdrawal','Approved',5000.10,'COP',1.2,true,NULL,NULL,'Colombia');
INSERT INTO silver.fact_complaints VALUES
  ('Q1','2025-03-10 02:00:00','2025-03-09','C1','Cargo no reconocido','Queja relacionada con transactions','P2',10.50,'USD'),
  ('Q2','2025-04-10 12:00:00','2025-04-10','C2','Cobro indebido','Queja relacionada con fees',NULL,NULL,NULL);
INSERT INTO silver.fact_call_center_interactions VALUES ('I1','Queja','Queja'), ('I2','Producto','Producto');
INSERT INTO silver.fact_call_transcripts VALUES ('X1','I1','hola','es'), ('X2','I2','hola','es');
"""

HOLDOUT_ROWS = """
INSERT INTO silver.fact_transactions VALUES
  ('T9','2026-02-01 12:00:00','2026-02-01','P1','C1','Purchase','Approved',499.99,'USD',499.99,false,'Cine Premium','Entertainment','Spain');
INSERT INTO silver.fact_complaints VALUES
  ('Q9','2026-02-02 12:00:00','2026-02-02','C2','Cargo no reconocido','Queja relacionada con transactions',NULL,NULL,NULL);
"""


def make_db(path: Path, with_holdout: bool) -> Path:
    with duckdb.connect(str(path)) as con:
        con.execute(DDL)
        if with_holdout:
            con.execute(HOLDOUT_ROWS)
    return path


def test_every_query_declares_a_unique_id_title_scope_and_memory_model():
    queries = rf.load_queries()
    assert len(queries) >= 15
    ids = [q.id for q in queries]
    assert len(ids) == len(set(ids))
    for q in queries:
        assert q.path.name.startswith(q.id + "_"), q.path.name
        assert q.title and q.memory and q.scope in {"design", "full"}


def test_design_queries_are_bounded_by_the_design_window_and_full_queries_are_not():
    for q in rf.load_queries():
        uses_bound = "$design_end" in q.sql
        assert uses_bound == (q.scope == "design"), q.id


def test_the_runner_offers_no_way_to_move_the_design_window():
    options = {a.dest for a in rf.parser()._actions}
    assert not any(re.search("design|window|end", o) for o in options), options
    assert rf.DESIGN_END == "2026-01-01"


def test_holdout_rows_never_change_a_design_result(tmp_path):
    without = rf.run(make_db(tmp_path / "a.duckdb", with_holdout=False))
    with_holdout = rf.run(make_db(tmp_path / "b.duckdb", with_holdout=True))
    for a, b in zip(without["results"], with_holdout["results"]):
        assert a["id"] == b["id"]
        if a["scope"] == "design":
            assert a["rows"] == b["rows"], a["id"]
    changed = {a["id"] for a, b in zip(without["results"], with_holdout["results"]) if a["rows"] != b["rows"]}
    assert changed and all(rf.load_query(i).scope == "full" for i in changed)


def test_output_is_aggregate_json_with_provenance(tmp_path):
    db = make_db(tmp_path / "f.duckdb", with_holdout=True)
    out = rf.write(rf.run(db), tmp_path / "out")
    blob = json.loads(out.read_text(encoding="utf-8"))
    assert blob["metadata"]["design_end"] == "2026-01-01"
    assert blob["metadata"]["database"] == str(db.resolve())
    assert {r["id"] for r in blob["results"]} == {q.id for q in rf.load_queries()}
    df008 = next(r for r in blob["results"] if r["id"] == "DF-008")
    assert df008["columns"][:3] == ["transaction_type", "transaction_status", "rows"]
    assert sum(row[2] for row in df008["rows"]) == 3


def test_only_selects_the_requested_findings(tmp_path):
    result = rf.run(make_db(tmp_path / "o.duckdb", with_holdout=False), only=("DF-001", "DF-008"))
    assert [r["id"] for r in result["results"]] == ["DF-001", "DF-008"]
    with pytest.raises(ValueError, match="Unknown finding"):
        rf.run(tmp_path / "o.duckdb", only=("DF-999",))
