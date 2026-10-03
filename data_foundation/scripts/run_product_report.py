"""Build the reviewed, aggregate-only product report from a verified Silver DB."""
from __future__ import annotations

import argparse
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from data_foundation.scripts.run_marketing_product import published_manifest, validate_quality_identity
from data_foundation.src.product_report import build, write_report


def main(argv: list[str] | None = None) -> int:
    """Check quality provenance, run the product queries read-only and write an ignored run."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('--quality', type=Path, required=True, help='Full quality_results.json for this DB')
    parser.add_argument('--output', type=Path, required=True, help='Ignored scratch run directory')
    parser.add_argument('--publish', type=Path, help='Optional reviewed report directory')
    parser.add_argument('--memory-limit', default='3GB')
    args = parser.parse_args(argv)
    quality = json.loads(args.quality.read_text(encoding='utf-8'))
    metadata = quality['metadata']
    try:
        validate_quality_identity(args.db, metadata)
    except ValueError as exc:
        parser.error(str(exc))
    args.output.mkdir(parents=True, exist_ok=False)
    tmp = args.output / 'duckdb_tmp'
    tmp.mkdir()
    try:
        with duckdb.connect(str(args.db), read_only=True) as con:
            con.execute('SET memory_limit=?', [args.memory_limit])
            con.execute('SET threads=?', [int(os.environ.get('DUCKDB_THREADS', '2'))])
            con.execute('SET temp_directory=?', [str(tmp)])
            report = build(con)
    finally:
        shutil.rmtree(tmp)
    manifest = published_manifest({
        'generated_at_utc': datetime.now(timezone.utc).isoformat(),
        'database_bytes': args.db.stat().st_size,
        'quality_generated_at_utc': metadata['generated_at_utc'],
        'quality_checks': len(quality['checks']),
        'quality_errors': metadata['errors'],
        'quality_warnings': metadata['warnings'],
        'bronze_watermarks': metadata['watermarks'],
        'memory_model': 'DuckDB projected scans and grouped SQL with disk spill; Python holds aggregate rows only',
    }, args.db, args.quality)
    write_report(report, manifest, args.output)
    if args.publish:
        write_report(report, manifest, args.publish)
    k1 = report['summary']['kpi1_demand']
    print(f'report_run={args.output} unrecognized_charges={k1["unrecognized_charges"]} per_day={k1["per_day"]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
