"""Write the Gold intake slice (D1 seed + manifest) from a focused, quality-gated DuckDB."""
from __future__ import annotations

import argparse
import json
from datetime import date
from pathlib import Path

if __package__:
    from .intake_slice import build_slice, dataset_allowlist
else:  # direct script execution
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from data_pipelines.gold.intake_slice import build_slice, dataset_allowlist


def main(argv: list[str] | None = None) -> int:
    """Validate, render and write the seed and manifest; print only counts and paths."""
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", type=Path, required=True)
    p.add_argument("--quality-report", type=Path, required=True)
    p.add_argument("--business-date", type=date.fromisoformat, required=True)
    p.add_argument("--customer-id", action="append",
                   help="Dataset customer to include (repeatable); defaults to the whole dataset allowlist")
    p.add_argument("--max-rows", type=int, default=20)
    p.add_argument("--seed-out", type=Path, required=True)
    p.add_argument("--manifest-out", type=Path, required=True)
    args = p.parse_args(argv)
    customers = tuple(args.customer_id or sorted(dataset_allowlist()))
    seed, manifest = build_slice(args.db, args.quality_report, args.business_date, customers, args.max_rows)
    for path in (args.seed_out, args.manifest_out):
        path.parent.mkdir(parents=True, exist_ok=True)
    args.seed_out.write_text(seed, encoding="utf-8")
    args.manifest_out.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"slice_version={manifest['slice_version']} selected={manifest['selected']} "
          f"eligible={manifest['eligible_sample_rows']} seed={args.seed_out} manifest={args.manifest_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
