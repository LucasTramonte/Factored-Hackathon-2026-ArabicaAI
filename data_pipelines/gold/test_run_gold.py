"""The Gold entrypoint: usage modes, path defaults, exit codes and rollback reporting."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import duckdb
import pytest

from data_pipelines.gold import run_gold as rg
from data_pipelines.gold.test_build_gold import PRODUCTS, make_quality, make_silver, with_row

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def paths(tmp_path):
    """A gated Silver file whose newest quality run sits where the default lookup expects it."""
    silver = make_silver(tmp_path)
    make_quality(tmp_path / "quality_runs", silver, name="20260929T000000Z/quality_results.json")
    return silver, tmp_path / "gold_fixture.duckdb"


def cli(silver: Path, gold: Path, *extra: str) -> int:
    return rg.main(["--silver-db", str(silver), "--gold-db", str(gold), *extra])


def tables_in(gold: Path) -> set[str]:
    with duckdb.connect(str(gold), read_only=True) as con:
        return {r[0] for r in con.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = 'gold'").fetchall()}


def test_default_builds_every_table_with_the_newest_quality_run(paths, capsys):
    silver, gold = paths
    assert cli(silver, gold) == 0
    out = capsys.readouterr().out
    assert "customers" in out and "customer_complaints" in out and "card_purchases" in out and "context_cards" in out
    assert "7/7" in out and "6/6" in out and "12/12" in out and "9/9" in out
    assert {"customers", "customer_complaints", "card_purchases", "context_cards", "builds", "reconciliation"} <= tables_in(gold)


def test_tables_option_builds_only_the_requested_tables(paths):
    silver, gold = paths
    assert cli(silver, gold, "--tables", " customers ,") == 0
    assert "customers" in tables_in(gold) and "card_purchases" not in tables_in(gold)


def test_unknown_table_names_fail_without_building(paths, caplog):
    silver, gold = paths
    assert cli(silver, gold, "--tables", "customers,cohort") == 1
    assert "Unknown table name(s) in --tables: cohort" in caplog.text
    assert not gold.exists()


def test_card_purchases_alone_needs_an_earlier_customers_build(paths, caplog):
    silver, gold = paths
    assert cli(silver, gold, "--tables", "card_purchases") == 1
    assert "Gold build failed" in caplog.text
    assert cli(silver, gold, "--tables", "customers") == 0
    assert cli(silver, gold, "--tables", "card_purchases") == 0


def test_a_failed_check_exits_nonzero_and_reports_the_rollback(paths, tmp_path, caplog):
    silver, gold = paths
    assert cli(silver, gold) == 0
    broken = make_silver(tmp_path, products=with_row(PRODUCTS, 0, owner="C2"))
    report = make_quality(tmp_path, broken, name="late/quality_results.json")
    assert cli(broken, gold, "--quality-report", str(report)) == 1
    assert "check failed: card_purchases.product_owned_by_another_customer" in caplog.text
    assert "rolled back" in caplog.text
    with duckdb.connect(str(gold), read_only=True) as con:
        assert con.execute("SELECT count(*) FROM gold.builds").fetchone() == (1,)


def test_a_failed_gate_exits_nonzero(paths, tmp_path, caplog):
    silver, gold = paths
    report = make_quality(tmp_path, silver, name="bad/quality_results.json", errors=3)
    assert cli(silver, gold, "--quality-report", str(report)) == 1
    assert "not ready or has errors" in caplog.text


def test_missing_silver_file_is_reported(tmp_path, caplog):
    assert cli(tmp_path / "absent.duckdb", tmp_path / "gold_fixture.duckdb") == 1
    assert "No Silver DuckDB" in caplog.text


def test_list_shows_tables_and_builds_nothing(paths, capsys):
    silver, gold = paths
    assert cli(silver, gold, "--list") == 0
    out = capsys.readouterr().out
    assert "customers" in out and "card_purchases" in out and "customers,products,transactions" in out
    assert not gold.exists()


def test_last_shows_the_newest_committed_build(paths, capsys, caplog):
    silver, gold = paths
    assert cli(silver, gold, "--last") == 1
    assert "No Gold DuckDB" in caplog.text
    assert cli(silver, gold, "--tables", "customers") == 0
    assert cli(silver, gold) == 0
    capsys.readouterr()
    assert cli(silver, gold, "--last") == 0
    out = capsys.readouterr().out
    assert "card_purchases" in out and "row_count_matches_silver" in out and "missing_merchant_kept_as_null" in out
    assert "from build" in out and "quality_generated_at_utc" in out


def test_list_and_last_are_mutually_exclusive(paths):
    silver, gold = paths
    with pytest.raises(SystemExit) as exc:
        cli(silver, gold, "--list", "--last")
    assert exc.value.code == 2


def test_paths_default_to_the_environment(monkeypatch, tmp_path):
    monkeypatch.delenv("DUCKDB_PATH", raising=False)
    monkeypatch.delenv("GOLD_DUCKDB_PATH", raising=False)
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    assert rg.default_paths() == (tmp_path / "latam_bank.duckdb", tmp_path / "latam_bank_gold.duckdb")
    monkeypatch.setenv("DUCKDB_PATH", str(tmp_path / "s.duckdb"))
    monkeypatch.setenv("GOLD_DUCKDB_PATH", str(tmp_path / "g.duckdb"))
    assert rg.default_paths() == (tmp_path / "s.duckdb", tmp_path / "g.duckdb")


def test_runs_as_a_plain_script(tmp_path):
    done = subprocess.run([sys.executable, str(REPO_ROOT / "data_pipelines/gold/run_gold.py"), "--list"],
                          cwd=tmp_path, capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    assert "card_purchases" in done.stdout
