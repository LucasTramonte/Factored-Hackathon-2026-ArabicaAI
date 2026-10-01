"""Tests for the cohort command line: atomic publication and a loader that never reloads or overspends."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from data_pipelines.gold import run_cohort as cli
from data_pipelines.gold.intake_slice import content_version, with_header


def parts_and_manifest(n=2):
    parts = [with_header(f"SELECT {i};\n", f"part {i}") for i in range(1, n + 1)]
    manifest = {"slice_version": "v", "parts": [{"index": i, "version": content_version(p), "expected_writes": 10,
                                                   "customers": 1, "transactions": 2, "customer_ids": [f"C{i}"]} for i, p in enumerate(parts, 1)],
                "customers": [{"customer_id": f"C{i}", "country": "México", "transactions": 1} for i in range(1, n + 1)]}
    return parts, manifest


def test_publish_writes_every_part_and_the_manifest_together(tmp_path):
    parts, manifest = parts_and_manifest()
    out = cli.publish(parts, manifest, tmp_path / "cohort")
    assert sorted(p.name for p in out.iterdir()) == ["manifest.json", "part-001.sql", "part-002.sql"]
    assert json.loads((out / "manifest.json").read_text())["slice_version"] == "v"


def test_publish_refuses_parts_that_do_not_match_the_manifest_and_leaves_nothing(tmp_path):
    parts, manifest = parts_and_manifest()
    manifest["parts"][1]["version"] = "tampered"
    with pytest.raises(ValueError, match="version"):
        cli.publish(parts, manifest, tmp_path / "cohort")
    assert not (tmp_path / "cohort").exists() and not list(tmp_path.iterdir())


def test_publish_replaces_a_previous_cohort_whole(tmp_path):
    parts, manifest = parts_and_manifest(3)
    cli.publish(parts, manifest, tmp_path / "cohort")
    parts, manifest = parts_and_manifest(1)
    out = cli.publish(parts, manifest, tmp_path / "cohort")
    assert sorted(p.name for p in out.iterdir()) == ["manifest.json", "part-001.sql"]


class FakeWrangler:
    """Records commands; answers the presence probe and the load with canned JSON."""
    def __init__(self, present=0, written=10):
        self.present, self.written, self.calls = present, written, []

    def __call__(self, args):
        self.calls.append(args)
        if "--command" in args:
            return json.dumps([{"results": [{"n": self.present}], "success": True}])
        return json.dumps([{"results": [], "success": True, "meta": {"rows_written": self.written}}])


def published(tmp_path, n=1):
    parts, manifest = parts_and_manifest(n)
    return cli.publish(parts, manifest, tmp_path / "cohort")


def test_load_applies_a_part_and_checks_measured_writes_against_the_estimate(tmp_path):
    fake = FakeWrangler(present=0, written=9)
    assert cli.load(published(tmp_path), part=1, target="local", run=fake) == {"part": 1, "status": "loaded", "rows_written": 9}
    assert any("--file" in c for c in fake.calls) and all("--remote" not in c for c in fake.calls)


def test_load_skips_a_part_already_present(tmp_path):
    fake = FakeWrangler(present=2)
    assert cli.load(published(tmp_path), part=1, target="local", run=fake)["status"] == "already_loaded"
    assert not any("--file" in c for c in fake.calls)


def test_load_fails_when_measured_writes_exceed_the_estimate(tmp_path):
    with pytest.raises(ValueError, match="estimate"):
        cli.load(published(tmp_path), part=1, target="local", run=FakeWrangler(written=11))


def test_load_refuses_a_partly_loaded_part_and_an_unknown_target(tmp_path):
    out = published(tmp_path)  # the part holds 2 transactions; 1 present means a broken earlier load
    with pytest.raises(ValueError, match="partly"):
        cli.load(out, part=1, target="local", run=FakeWrangler(present=1))
    with pytest.raises(ValueError, match="target"):
        cli.load(out, part=1, target="production", run=FakeWrangler())


def test_load_refuses_a_part_edited_after_publication(tmp_path):
    out = published(tmp_path)
    (out / "part-001.sql").write_text("DELETE FROM customers;\n")
    with pytest.raises(ValueError, match="version"):
        cli.load(out, part=1, target="local", run=FakeWrangler())


def test_a_load_without_a_measured_write_count_says_so_instead_of_reporting_zero(tmp_path):
    class Local(FakeWrangler):
        def __call__(self, args):
            out = super().__call__(args)
            return out if "--command" in args else json.dumps([{"results": [], "success": True, "meta": {"duration": 1}}])
    assert cli.load(published(tmp_path), part=1, target="local", run=Local())["rows_written"] == "not_measured"
