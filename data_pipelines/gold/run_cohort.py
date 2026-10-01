"""Build the Gold cohort seed parts, or load one part into D1, printing only counts and paths.

``build`` writes ``part-NNN.sql`` files and ``manifest.json`` into one directory under ignored
``data/``. ``load`` applies one part with Wrangler, after checking that the file still matches its
manifest version and that its version isn't in D1's ``seed_loads``, then compares D1's measured rows written
with the manifest estimate (remote only: local Wrangler doesn't report rows written). ``--remote`` is never the default; the remote run is a reviewed,
manual step (``back-end/README.md``).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import date
from pathlib import Path
from typing import Callable

if __package__:
    from .cohort import CohortParams, build_cohort
    from .intake_slice import content_version, quote
else:  # direct script execution
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from data_pipelines.gold.cohort import CohortParams, build_cohort
    from data_pipelines.gold.intake_slice import content_version, quote

BACK_END = Path(__file__).resolve().parents[2] / "back-end"
DATABASE = "arabica-intake-demo"
TARGETS = {"local": "--local", "remote": "--remote"}


def publish(parts: list[str], manifest: dict, out_dir: Path) -> Path:
    """Write every part and the manifest into ``out_dir`` together, or leave the old directory untouched."""
    versions = [p["version"] for p in manifest.get("parts", [])]
    if versions != [content_version(p) for p in parts]:
        raise ValueError("Part versions do not match the manifest")
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=out_dir.name + ".", dir=out_dir.parent))
    try:
        for i, part in enumerate(parts, 1):
            (staging / f"part-{i:03d}.sql").write_text(part, encoding="utf-8")
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        old = out_dir.with_name(out_dir.name + ".old")
        moved = out_dir.exists()
        if moved:
            os.replace(out_dir, old)
        try:
            os.replace(staging, out_dir)
        except BaseException:
            if moved:  # put the previous cohort back rather than leave no directory at all
                os.replace(old, out_dir)
            raise
        shutil.rmtree(old, ignore_errors=True)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return out_dir


def wrangler(args: list[str]) -> str:
    """Run Wrangler from ``back-end/`` and return its stdout; no debug log file, no metrics."""
    env = {**os.environ, "WRANGLER_WRITE_LOGS": "false", "WRANGLER_SEND_METRICS": "false"}  # any WRANGLER_LOG hides --json output
    return subprocess.run(["npx", "wrangler", *args], cwd=BACK_END, env=env, check=True,
                          capture_output=True, text=True).stdout


def _json(text: str) -> list[dict]:
    start = text.find("[")
    return json.loads(text[start:])


def load(out_dir: Path, part: int, target: str, run: Callable[[list[str]], str] = wrangler) -> dict:
    """Apply one part unless it is already present; fail if D1 wrote more rows than estimated."""
    if target not in TARGETS:
        raise ValueError(f"Unknown target {target!r}; use local or remote")
    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    meta = next((p for p in manifest["parts"] if p["index"] == part), None)
    if meta is None:
        raise ValueError(f"Part {part} is not in the manifest")
    path = out_dir / f"part-{part:03d}.sql"
    if content_version(path.read_text(encoding="utf-8")) != meta["version"]:
        raise ValueError(f"Part {part} no longer matches its manifest version")
    flag = TARGETS[target]
    version = meta["version"]
    if not re.fullmatch(r"[0-9a-f]{16}", version):
        raise ValueError(f"Part {part} has a malformed version")
    probe = _json(run(["d1", "execute", DATABASE, flag, "--json", "--command",
                       f"SELECT count(*) AS n FROM seed_loads WHERE version='{version}'"]))
    if probe[0]["results"][0]["n"]:
        return {"part": part, "status": "already_loaded", "rows_written": 0}
    # The part's upserts are idempotent, so a part left half-applied by an earlier failure loads again safely.
    result = _json(run(["d1", "execute", DATABASE, flag, "--json", "--yes", "--file", str(path.resolve())]))
    # Remote D1 reports rows_written per statement; local Wrangler doesn't, so locally it is unmeasured.
    measured = [r["meta"]["rows_written"] for r in result if "rows_written" in r.get("meta", {})]
    written = sum(measured) if measured else "not_measured"
    if measured and written > meta["expected_writes"]:
        raise ValueError(f"Part {part} wrote {written} rows, over its estimate of {meta['expected_writes']}")
    run(["d1", "execute", DATABASE, flag, "--json", "--command",
         f"INSERT INTO seed_loads(version, loaded_at) VALUES ('{version}', datetime('now')) ON CONFLICT(version) DO NOTHING"])
    return {"part": part, "status": "loaded", "rows_written": written}


def main(argv: list[str] | None = None) -> int:
    """``build`` or ``load``; output is counts and paths only, never customer rows."""
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build")
    b.add_argument("--db", type=Path, required=True)
    b.add_argument("--quality-report", type=Path, required=True)
    b.add_argument("--as-of", type=date.fromisoformat, required=True)
    b.add_argument("--window-days", type=int, default=CohortParams.window_days)
    b.add_argument("--min-purchases", type=int, default=CohortParams.min_purchases)
    b.add_argument("--size", type=int, default=CohortParams.size)
    b.add_argument("--salt", default=CohortParams.salt)
    b.add_argument("--out", type=Path, required=True)
    l = sub.add_parser("load")
    l.add_argument("--out", type=Path, required=True)
    l.add_argument("--part", type=int, required=True)
    l.add_argument("--target", choices=sorted(TARGETS), default="local")
    args = p.parse_args(argv)
    if args.command == "build":
        params = CohortParams(as_of=args.as_of, window_days=args.window_days, min_purchases=args.min_purchases,
                              size=args.size, salt=args.salt)
        parts, manifest = build_cohort(args.db, args.quality_report, params)
        out = publish(parts, manifest, args.out)
        print(f"slice_version={manifest['slice_version']} customers={len(manifest['customers'])} "
              f"transactions={sum(c['transactions'] for c in manifest['customers'])} parts={len(parts)} "
              f"expected_writes={manifest['expected_writes_total']} sampling={manifest['sampling']} out={out}")
    else:
        print(json.dumps(load(args.out, args.part, args.target)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
