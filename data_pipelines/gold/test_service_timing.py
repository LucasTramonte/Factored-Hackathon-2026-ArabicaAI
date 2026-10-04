"""The committed timing baseline: Gold export, its seed rendering, and migration 0027 agreeing with the reviewed JSON."""
from __future__ import annotations

import json
import sqlite3

import pytest

from data_pipelines.gold import build_gold as gb
from data_pipelines.gold import service_timing as st
from data_pipelines.gold.intake_slice import MIGRATIONS
from data_pipelines.gold.test_build_gold import TIMED, make_quality, make_silver


def test_migration_inserts_exactly_the_reviewed_json():
    data = json.loads(st.DATA.read_text(encoding="utf-8"))
    assert st.render_seed(data) in st.MIGRATION.read_text(encoding="utf-8"), \
        "Migration 0027's INSERTs differ from back-end/seeds/service_timing.json: regenerate with render_seed"
    content = {k: v for k, v in data.items() if k != "version"}
    assert data["version"] == st.hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()[:16]


def test_the_reviewed_baseline_is_the_published_one():
    """BUSINESS_OUTCOMES.md, 'How disputes are handled today': first response 25/44 h on 6,045 of 10,370."""
    metrics = {m["metric"]: m for m in json.loads(st.DATA.read_text(encoding="utf-8"))["metrics"]}
    assert (metrics["first_response"]["p50"], metrics["first_response"]["p90"], metrics["first_response"]["n"],
            metrics["first_response"]["population"]) == (25.0, 44.0, 6045, 10370)
    assert (metrics["creation_to_resolution"]["n"], metrics["creation_to_resolution"]["missing"]) == (2414, 7956)


def test_migrations_load_the_baseline_and_d1_refuses_an_inconsistent_row():
    con = sqlite3.connect(":memory:")
    for migration in sorted(MIGRATIONS.glob("*.sql")):
        con.executescript(migration.read_text())
    assert con.execute("SELECT metric, unit, p50, p90, n FROM service_timing ORDER BY metric").fetchall() == [
        ("creation_to_resolution", "days", 15.0, 27.0, 2414), ("first_response", "hours", 25.0, 44.0, 6045)]
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("INSERT INTO service_timing VALUES ('v','2026-10-05','first_response','hours',1,2,3,0,0,4,'s','a','b','c','d','e')")


def test_export_reads_the_current_gold_build(tmp_path):
    silver = make_silver(tmp_path, complaints=TIMED)
    quality = gb.check_quality(silver, make_quality(tmp_path, silver), {"complaints"})
    gold = tmp_path / "gold_fixture.duckdb"
    with gb.connect(gold, silver) as con:
        build_id, _ = gb.build(con, ("complaint_timing",), silver, quality)
    data = st.export(gold, "2026-10-04")
    assert data["gold_build"] == build_id and data["population"]["query"] == st.QUERY
    assert [m["metric"] for m in data["metrics"]] == ["creation_to_resolution", "first_response"]
    assert st.render_seed(data).count("INSERT INTO service_timing") == 2


@pytest.mark.parametrize("change", [{"p50": 50.0}, {"n": 1}, {"p90": "44); DROP TABLE x; --"}, {"n": True}])
def test_render_refuses_an_inconsistent_or_hostile_aggregate(change):
    data = json.loads(st.DATA.read_text(encoding="utf-8"))
    data["metrics"][1].update(change)
    with pytest.raises((ValueError, TypeError)):
        st.render_seed(data)
