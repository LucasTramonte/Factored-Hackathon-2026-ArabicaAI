"""Check that relative links and images in the repository's Markdown resolve.

Reads every Markdown file Git tracks (outside ``Docs/superpowers/`` and ``Docs/sources/``, which are
dated working notes and verbatim organizer material) and checks that each relative link target
is a tracked file or directory, for inline links, images and reference definitions
(``[label]: target``). A ``#anchor`` on a Markdown target must match one of that file's
headings, using GitHub's slug rules. External links (``http``, ``mailto``) are not fetched. Text in
fenced code blocks and inline code is ignored. Exits 1 and lists each broken link as
``file:line: target``.

Run from anywhere: ``python scripts/check_doc_links.py``.
"""
from __future__ import annotations

import posixpath
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
SKIP_PREFIXES = ("Docs/superpowers/", "Docs/sources/")
LINK = re.compile(r"!?\[(?:[^\[\]]|\[[^\]]*\])*\]\((<[^>]+>|[^)\s]+)(?:\s+\"[^\"]*\")?\)")
# A reference definition, ``[label]: target``, used by ``[text][label]`` and ``![alt][label]``.
REFERENCE = re.compile(r"^ {0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)")
OPEN_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
INLINE_CODE = re.compile(r"`[^`]*`")


def prose(path: Path):
    """Yield (line number, line) outside fenced code blocks.

    A fence closes only on a line of the opening character, at least as long as the opening run,
    with nothing after it but whitespace, so a three-backtick example inside a four-backtick block
    doesn't end the block early.
    """
    fence = None
    for no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if fence is None:
            m = OPEN_FENCE.match(line)
            if m:
                fence = m.group(1)
                continue
            yield no, line
        elif re.fullmatch(r" {0,3}" + re.escape(fence[0]) + "{" + str(len(fence)) + r",}\s*", line):
            fence = None


def tracked() -> list[str]:
    """Paths Git tracks, relative to the repository root, with forward slashes."""
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True).stdout
    return [p for p in out.decode().split("\0") if p]


def slug(heading: str) -> str:
    """GitHub's anchor for a heading: lowercase, punctuation dropped, spaces to hyphens."""
    text = re.sub(r"`|\*\*|__", "", heading.strip().lower())
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def anchors(path: Path) -> set[str]:
    """Every heading anchor in a Markdown file, with GitHub's -1, -2 suffixes for repeats."""
    seen: dict[str, int] = {}
    found: set[str] = set()
    for _, line in prose(path):
        m = re.match(r"^#{1,6}\s+(.*?)\s*#*\s*$", line)
        if m:
            base = slug(m.group(1))
            n = seen.get(base, 0)
            found.add(base if n == 0 else f"{base}-{n}")
            seen[base] = n + 1
    return found


def links(path: Path):
    """Yield (line number, target) for each inline link and reference definition outside code."""
    for no, line in prose(path):
        ref = REFERENCE.match(line)
        if ref:
            yield no, ref.group(1).strip("<>")
            continue
        for m in LINK.finditer(INLINE_CODE.sub("", line)):
            yield no, m.group(1).strip("<>")


def broken(files: list[str], root: Path = ROOT) -> list[str]:
    """Every link in ``files`` (paths relative to ``root``) whose relative target or anchor doesn't resolve."""
    paths = set(files)
    dirs = {posixpath.dirname(p) for p in files}
    dirs |= {d for p in list(dirs) for d in _parents(p)}
    cache: dict[str, set[str]] = {}
    problems = []
    for md in files:
        if not md.endswith(".md") or md.startswith(SKIP_PREFIXES):
            continue
        for no, target in links(root / md):
            if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I):
                continue
            file_part, _, anchor = target.partition("#")
            resolved = md if not file_part else posixpath.normpath(posixpath.join(posixpath.dirname(md), unquote(file_part)))
            resolved = resolved.rstrip("/")
            if resolved not in paths and resolved not in dirs:
                problems.append(f"{md}:{no}: {target}")
                continue
            if anchor and resolved.endswith(".md"):
                if resolved not in cache:
                    cache[resolved] = anchors(root / resolved)
                if anchor.lower() not in cache[resolved]:
                    problems.append(f"{md}:{no}: {target} (no such heading)")
    return problems


def _parents(directory: str):
    while directory:
        yield directory
        directory = posixpath.dirname(directory)


def main() -> int:
    """Print broken links and exit 1, or print a count and exit 0."""
    problems = broken(tracked())
    for p in problems:
        print(p)
    if problems:
        print(f"{len(problems)} broken link(s)", file=sys.stderr)
        return 1
    print("All relative Markdown links resolve.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
