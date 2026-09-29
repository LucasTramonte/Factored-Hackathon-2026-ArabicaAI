"""Write the Gold intake slice (D1 seed + manifest) from a focused, quality-gated DuckDB."""
from __future__ import annotations

import argparse
import json
import os
from datetime import date
from pathlib import Path

if __package__:
    from .intake_slice import build_slice, content_version, dataset_allowlist
else:  # direct script execution
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from data_pipelines.gold.intake_slice import build_slice, content_version, dataset_allowlist


def publish(seed: str, manifest: dict, seed_out: Path, manifest_out: Path) -> None:
    """Publish the seed and manifest together, or neither.

    Both are staged next to their targets, their ``slice_version`` must agree, and if the second
    rename fails the previous seed is restored, so a reviewer never sees a mismatched pair.
    """
    if manifest.get("slice_version") != content_version(seed):
        raise ValueError("Manifest slice_version does not match the seed")
    for path in (seed_out, manifest_out):
        path.parent.mkdir(parents=True, exist_ok=True)
    seed_tmp, manifest_tmp = seed_out.with_name(seed_out.name + ".tmp"), manifest_out.with_name(manifest_out.name + ".tmp")
    backup = seed_out.with_name(seed_out.name + ".bak.tmp")
    seed_tmp.write_text(seed, encoding="utf-8")
    manifest_tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    had_seed = seed_out.exists()
    try:
        if had_seed:
            os.replace(seed_out, backup)
        os.replace(seed_tmp, seed_out)
        try:
            os.replace(manifest_tmp, manifest_out)
        except BaseException:
            if had_seed:
                os.replace(backup, seed_out)
            else:
                seed_out.unlink(missing_ok=True)
            raise
    finally:
        for leftover in (seed_tmp, manifest_tmp, backup):
            leftover.unlink(missing_ok=True)


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
    publish(seed, manifest, args.seed_out, args.manifest_out)
    print(f"slice_version={manifest['slice_version']} selected={manifest['selected']} "
          f"eligible={manifest['eligible_rows_in_loaded_partitions']} outside_day={manifest['rows_outside_business_date_in_loaded_partitions']} seed={args.seed_out} manifest={args.manifest_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
