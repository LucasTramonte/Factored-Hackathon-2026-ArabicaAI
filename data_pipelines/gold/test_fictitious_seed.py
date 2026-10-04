"""The committed fictitious seed must be exactly what the shared renderer produces."""
from __future__ import annotations

import sqlite3

import pytest

from data_pipelines.gold import fictitious_seed as fs
from data_pipelines.gold.intake_slice import MIGRATIONS


def d1() -> sqlite3.Connection:
    con = sqlite3.connect(":memory:")
    con.execute("PRAGMA foreign_keys=ON")
    for migration in sorted(MIGRATIONS.glob("*.sql")):
        con.executescript(migration.read_text())
    return con


def test_committed_seed_matches_the_generator():
    assert fs.SEED.read_text(encoding="utf-8") == fs.render_fictitious_seed(), \
        "Run: python -m data_pipelines.gold.fictitious_seed"


def test_seed_loads_reruns_and_rejects_drift():
    seed = fs.render_fictitious_seed()
    con = d1()
    con.executescript(seed)
    con.executescript(seed)
    assert con.execute("SELECT customer_id, display_name FROM customers ORDER BY 1").fetchall() == [
        ("demo-ana", "Ana (demo)"), ("demo-bruno", "Lucas (demo)"), ("demo-carla", "Manoella (demo)"),
        ("demo-diego", "Diego (demo)"), ("demo-elena", "Elena (demo)"), ("demo-marco", "Marco (demo)")]
    assert con.execute("SELECT count(*) FROM transactions WHERE source_occurred_at IS NULL").fetchone() == (26,)
    assert con.execute("SELECT customer_id, transaction_id FROM transactions WHERE bank_flagged=1 ORDER BY 1").fetchall() == [
        ("demo-diego", "demo-tx-015"), ("demo-elena", "demo-tx-020"), ("demo-marco", "demo-tx-025")], \
        "three small charges carry the ADR-011 flag, and a rerun keeps them"
    con.execute("UPDATE transactions SET amount='1.00' WHERE transaction_id='demo-tx-001'")
    with pytest.raises(sqlite3.IntegrityError):
        con.executescript(seed)


def test_only_fictitious_identities_can_own_fictitious_charges(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text('{"transactions": [{"transaction_id": "x", "customer_id": "CLI-U53R5AZVLET0", '
                   '"occurred_at": "2026-09-25T14:00:00+00:00", "merchant_name": "M", "amount": "1.00", "currency": "BRL"}]}')
    with pytest.raises(ValueError, match="fictitious"):
        fs.render_fictitious_seed(bad)


@pytest.mark.parametrize("amount", ["0", "0.00", "00.0"])
def test_zero_amounts_are_rejected(tmp_path, amount):
    bad = tmp_path / "zero.json"
    bad.write_text('{"transactions": [{"transaction_id": "x", "customer_id": "demo-ana", '
                   f'"occurred_at": "2026-09-25T14:00:00+00:00", "merchant_name": "M", "amount": "{amount}", "currency": "BRL"}}]}}')
    with pytest.raises(ValueError, match="amount"):
        fs.render_fictitious_seed(bad)


def test_bank_flagged_must_be_a_boolean(tmp_path):
    import json
    data = json.loads(fs.DATA.read_text(encoding="utf-8"))
    data["transactions"][0]["bank_flagged"] = "yes"
    bad = tmp_path / "flag.json"
    bad.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="bank_flagged"):
        fs.render_fictitious_seed(bad)
