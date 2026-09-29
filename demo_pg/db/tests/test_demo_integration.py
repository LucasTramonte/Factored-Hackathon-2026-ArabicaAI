"""Live PostgreSQL fixture tests; create and drop an isolated database only."""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from demo_pg import api as demo_api
from demo_pg.db.migrate import migrate
from demo_pg.db.seed_fictitious import seed

ADMIN_DSN = "host=127.0.0.1 port=55432 dbname=postgres user=arabica connect_timeout=2"


@pytest.fixture
def demo_db(monkeypatch):
    """Keep all tests away from the persistent arabica_demo database and its cases."""
    try:
        with psycopg.connect(ADMIN_DSN) as con:
            pass
    except psycopg.Error:
        pytest.skip("Local demo PostgreSQL is not running")
    name = "demo_test_" + uuid4().hex[:16]
    with psycopg.connect(ADMIN_DSN, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    dsn = ADMIN_DSN.replace("dbname=postgres", f"dbname={name}")
    try:
        assert migrate(dsn) == ["001_schema.sql", "002_existing_dates.sql", "003_sample_loads.sql"]
        assert migrate(dsn) == []
        seed(dsn)
        seed(dsn)
        monkeypatch.setattr(demo_api, "DSN", dsn)
        yield dsn
    finally:
        with psycopg.connect(ADMIN_DSN, autocommit=True) as admin:
            admin.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=%s", (name,))
            admin.execute(f'DROP DATABASE "{name}"')


def test_customer_isolation_confirmation_replay_conflict_and_agent_handoff(demo_db):
    ana = TestClient(demo_api.app)
    bruno = TestClient(demo_api.app)
    assert ana.get("/transactions").status_code == 401
    assert ana.post("/demo/session", json={"customer_id": "demo-ana"}).status_code == 200
    assert bruno.post("/demo/session", json={"customer_id": "demo-bruno"}).status_code == 200
    ana_ids = {x["transaction_id"] for x in ana.get("/transactions").json()["items"]}
    bruno_ids = {x["transaction_id"] for x in bruno.get("/transactions").json()["items"]}
    assert ana_ids == {"demo-tx-001", "demo-tx-002"}
    assert bruno_ids == {"demo-tx-003"}
    body = {"transaction_id": "demo-tx-001", "customer_statement": "I do not recognize this charge.",
            "customer_confirmed": True, "idempotency_key": str(uuid4())}
    assert ana.post("/cases", json={**body, "customer_confirmed": False}).status_code == 422
    assert ana.post("/cases", json={**body, "customer_confirmed": "true"}).status_code == 422
    assert bruno.post("/cases", json=body).status_code == 404
    first = ana.post("/cases", json=body)
    assert first.status_code == 201 and first.json()["status"] == "accepted"
    replay = ana.post("/cases", json=body)
    assert replay.status_code == 200 and replay.json()["protocol"] == first.json()["protocol"]
    assert replay.json()["replayed"] is True
    assert ana.post("/cases", json={**body, "customer_statement": "This is a different statement."}).status_code == 409
    agent = TestClient(demo_api.app)
    assert agent.get("/agent/cases").status_code == 401
    assert agent.post("/demo/agent-session").status_code == 200
    cases = agent.get("/agent/cases").json()["items"]
    assert len(cases) == 1 and cases[0]["protocol"] == first.json()["protocol"]
    with psycopg.connect(demo_db) as pg:
        assert pg.execute("SELECT count(*) FROM intake_demo.cases").fetchone()[0] == 1


def test_source_wall_time_and_database_failure_do_not_confirm_acceptance(demo_db, monkeypatch):
    with psycopg.connect(demo_db) as pg:
        pg.execute("INSERT INTO intake_demo.customers VALUES ('CLI-U53R5AZVLET0','Dataset customer (synthetic)')")
        pg.execute("INSERT INTO intake_demo.transactions "
                   "(transaction_id, customer_id, source_occurred_at, merchant_name, amount, currency) "
                   "VALUES ('TRX-SAMPLE','CLI-U53R5AZVLET0','2026-02-26 13:21:51','Tienda Don José',29763.49,'ARS')")
    client = TestClient(demo_api.app)
    client.post("/demo/session", json={"customer_id": "CLI-U53R5AZVLET0"})
    tx = client.get("/transactions").json()["items"][0]
    assert tx["source_occurred_at"] == "2026-02-26T13:21:51"
    assert tx["occurred_at"] is None and tx["amount"] == "29763.49"
    body = {"transaction_id": "TRX-SAMPLE", "customer_statement": "I cannot identify this transaction.",
            "customer_confirmed": True, "idempotency_key": str(uuid4())}
    original = demo_api.psycopg.connect
    def fail(*args, **kwargs):
        raise psycopg.OperationalError("simulated outage")
    monkeypatch.setattr(demo_api.psycopg, "connect", fail)
    assert client.post("/cases", json=body).status_code == 503
    monkeypatch.setattr(demo_api.psycopg, "connect", original)
    with psycopg.connect(demo_db) as pg:
        assert pg.execute("SELECT count(*) FROM intake_demo.cases").fetchone()[0] == 0
    assert client.post("/cases", json=body).status_code == 201


def test_public_gate_rejects_missing_or_invalid_credentials(demo_db, monkeypatch):
    import base64
    monkeypatch.setattr(demo_api, "PUBLIC", True)
    monkeypatch.setattr(demo_api, "GATE_USER", "reviewer")
    monkeypatch.setattr(demo_api, "GATE_PASSWORD", "local-test-only")
    client = TestClient(demo_api.app)
    assert client.get("/healthz").status_code == 200
    assert client.get("/transactions").status_code == 401
    assert client.get("/transactions", headers={"Authorization": "Basic ???"}).status_code == 401
    header = "Basic " + base64.b64encode(b"reviewer:local-test-only").decode()
    assert client.get("/transactions", headers={"Authorization": header}).status_code == 401  # no simulated customer session


def test_silver_sample_load_is_bounded_repeatable_and_rejects_drift(demo_db, tmp_path):
    import json
    from datetime import date
    from pathlib import Path
    import duckdb
    from demo_pg.db.load_sample import load

    path = tmp_path / "sample.duckdb"
    with duckdb.connect(str(path)) as con:
        con.execute("CREATE SCHEMA bronze; CREATE SCHEMA silver")
        con.execute("CREATE TABLE silver.dim_customers(customer_id VARCHAR,customer_status VARCHAR)")
        con.execute("CREATE TABLE silver.dim_products(product_id VARCHAR,customer_id VARCHAR)")
        con.execute("CREATE TABLE silver.fact_transactions(transaction_id VARCHAR,customer_id VARCHAR,product_id VARCHAR,transaction_date TIMESTAMP,merchant_name VARCHAR,currency VARCHAR,transaction_type VARCHAR,transaction_status VARCHAR)")
        con.execute("CREATE TABLE bronze.transactions(transaction_id VARCHAR,amount VARCHAR,_source_file VARCHAR)")
        con.execute("INSERT INTO silver.dim_customers VALUES ('CLI-U53R5AZVLET0','Inactive')")
        con.execute("INSERT INTO silver.dim_products VALUES ('P1','CLI-U53R5AZVLET0')")
        con.execute("INSERT INTO silver.fact_transactions VALUES ('T1','CLI-U53R5AZVLET0','P1','2026-02-26 13:21:51','Shop','ARS','Purchase','Approved')")
        con.execute("INSERT INTO bronze.transactions VALUES ('T1','29763.49','fixture.csv')")
    quality = tmp_path / "quality.json"
    quality.write_text(json.dumps({"metadata": {"ready": True, "errors": 0, "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "tables": ["customers", "products", "transactions"], "database": str(path.resolve()),
        "watermarks": [{"table": "transactions", "last_loaded_date": "2026-02-26"}]}}))
    call = lambda: load(path, quality, date(2026, 2, 26), ("CLI-U53R5AZVLET0",), dsn=demo_db)
    assert call()["inserted"] == 1
    assert call()["unchanged"] == 1
    with psycopg.connect(demo_db) as pg:
        assert pg.execute("SELECT count(*) FROM intake_demo.sample_loads").fetchone()[0] == 2
    with psycopg.connect(demo_db) as pg:
        pg.execute("UPDATE intake_demo.transactions SET amount=1 WHERE transaction_id='T1'")
    with pytest.raises(ValueError, match="differs"):
        call()
    with psycopg.connect(demo_db) as pg:
        assert pg.execute("SELECT count(*) FROM intake_demo.transactions WHERE transaction_id='T1'").fetchone()[0] == 1
    with duckdb.connect(str(path)) as con:
        con.execute("UPDATE silver.dim_products SET customer_id='another' WHERE product_id='P1'")
    with pytest.raises(ValueError, match="ownership"):
        call()


def test_database_insert_failure_rolls_back_without_receipt(demo_db):
    with psycopg.connect(demo_db) as pg:
        pg.execute("CREATE FUNCTION intake_demo.reject_case() RETURNS trigger LANGUAGE plpgsql "
                   "AS $$ BEGIN RAISE EXCEPTION 'fixture rejection'; END $$")
        pg.execute("CREATE TRIGGER reject_fixture BEFORE INSERT ON intake_demo.cases "
                   "FOR EACH ROW EXECUTE FUNCTION intake_demo.reject_case()")
    client = TestClient(demo_api.app)
    client.post("/demo/session", json={"customer_id": "demo-ana"})
    body = {"transaction_id": "demo-tx-001", "customer_statement": "I do not recognize this charge.",
            "customer_confirmed": True, "idempotency_key": str(uuid4())}
    assert client.post("/cases", json=body).status_code == 503
    with psycopg.connect(demo_db) as pg:
        assert pg.execute("SELECT count(*) FROM intake_demo.cases").fetchone()[0] == 0
        pg.execute("DROP TRIGGER reject_fixture ON intake_demo.cases")
    assert client.post("/cases", json=body).status_code == 201
