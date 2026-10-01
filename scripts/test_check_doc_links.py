"""Tests for the Markdown link check: fences, anchors and reference definitions."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_doc_links as cdl  # noqa: E402


def check(tmp_path: Path, files: dict[str, str]) -> list[str]:
    for name, text in files.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text(text, encoding="utf-8")
    return cdl.broken(sorted(files), root=tmp_path)


def test_a_missing_target_and_a_missing_anchor_are_reported(tmp_path):
    problems = check(tmp_path, {"a.md": "# Title\n[x](nope.md) [y](b.md#no-such) [z](b.md#real-heading)\n",
                                "b.md": "## Real heading\n"})
    assert problems == ["a.md:2: nope.md", "a.md:2: b.md#no-such (no such heading)"]


def test_a_shorter_fence_inside_a_longer_one_does_not_close_it(tmp_path):
    text = "````md\n```\n[inside](missing.md)\n```\n# Not a heading\n````\n[after](missing-after.md)\n"
    problems = check(tmp_path, {"a.md": text})
    assert problems == ["a.md:7: missing-after.md"], "the example link is code; the link after the real fence is checked"


def test_headings_inside_a_fence_are_not_anchors(tmp_path):
    problems = check(tmp_path, {"a.md": "~~~\n# Hidden\n~~~\n[x](#hidden)\n"})
    assert problems == ["a.md:4: #hidden (no such heading)"]


def test_reference_definitions_are_checked(tmp_path):
    problems = check(tmp_path, {"a.md": "See [the guide][g] and ![logo][l].\n\n[g]: missing.md\n[l]: <img/logo.png>\n",
                                "img/logo.png": ""})
    assert problems == ["a.md:3: missing.md"]


def test_external_links_and_inline_code_are_ignored(tmp_path):
    assert check(tmp_path, {"a.md": "[w](https://example.com/x.md) `[c](missing.md)` [m](mailto:a@b.c)\n"}) == []
