"""Publishing the seed and manifest is all-or-nothing, and the pair must agree on slice_version."""
from __future__ import annotations

import json
import os

import pytest

from data_pipelines.gold import run_intake_slice as run
from data_pipelines.gold.intake_slice import content_version


def test_publish_writes_a_matching_pair(tmp_path):
    seed, manifest = tmp_path / "seed.sql", tmp_path / "manifest.json"
    body = "INSERT INTO customers VALUES ('a');\n"
    run.publish(body, {"slice_version": content_version(body)}, seed, manifest)
    assert seed.read_text() == body
    assert json.loads(manifest.read_text())["slice_version"] == content_version(body)
    assert not list(tmp_path.glob("*.tmp"))


def test_mismatched_versions_publish_nothing(tmp_path):
    seed, manifest = tmp_path / "seed.sql", tmp_path / "manifest.json"
    with pytest.raises(ValueError, match="slice_version"):
        run.publish("INSERT 1;\n", {"slice_version": "0000"}, seed, manifest)
    assert not seed.exists() and not manifest.exists()


def test_a_failed_manifest_publish_restores_the_previous_pair(tmp_path, monkeypatch):
    seed, manifest = tmp_path / "seed.sql", tmp_path / "manifest.json"
    seed.write_text("old seed")
    manifest.write_text("old manifest")
    body = "INSERT INTO customers VALUES ('new');\n"
    real = os.replace

    def flaky(src, dst):
        if str(dst) == str(manifest):
            raise OSError("disk full")
        return real(src, dst)

    monkeypatch.setattr(run.os, "replace", flaky)
    with pytest.raises(OSError):
        run.publish(body, {"slice_version": content_version(body)}, seed, manifest)
    assert seed.read_text() == "old seed" and manifest.read_text() == "old manifest"
    assert not list(tmp_path.glob("*.tmp"))
