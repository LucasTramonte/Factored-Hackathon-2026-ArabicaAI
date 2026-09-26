"""CLI for reproducible marketing and product evidence runs."""

from __future__ import annotations

import argparse
import json
import logging
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from data_foundation.src.marketing_product import RUN_ID, analyze, preview_svg, render_report


def run_analysis(data_root: Path, output_root: Path, run_id: str | None = None) -> dict:
    """Scan local CSVs read-only and write an immutable aggregate-only run."""
    run_id = run_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    if not RUN_ID.fullmatch(run_id):
        raise ValueError("run_id must be a safe 1-64 character identifier")
    run_dir = output_root / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix="scratch-", dir=run_dir) as scratch:
        results, manifest = analyze(data_root, Path(scratch))
    (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    (run_dir / "summary.json").write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    (run_dir / "report.html").write_text(render_report(results), encoding="utf-8")
    (run_dir / "preview.svg").write_text(preview_svg(results), encoding="utf-8")
    return results


def main() -> None:
    """Parse CLI paths and run identifier before starting the analysis."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=Path("data"))
    parser.add_argument("--output-root", type=Path, default=Path("data_foundation/runs/marketing-product"))
    parser.add_argument("--run-id")
    args = parser.parse_args()
    logging.Formatter.converter = time.gmtime
    logging.basicConfig(level=logging.INFO, format="%(asctime)sZ %(levelname)s %(message)s", datefmt="%Y-%m-%dT%H:%M:%S")
    run_analysis(args.data_root, args.output_root, args.run_id)


if __name__ == "__main__":
    main()
