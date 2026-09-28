"""Build reviewed, aggregate-only Marketing/Product reports from a verified Silver DB."""
from __future__ import annotations

import argparse
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from data_foundation.src.marketing_product_evidence import analyze
from data_foundation.src.marketing_product_report import write_reports


def validate_quality_identity(db: Path, metadata: dict) -> None:
    """Reject incomplete or stale quality evidence for the selected database."""
    if not db.is_file():
        raise ValueError(f'Database missing: {db}')
    if not metadata['ready'] or metadata['errors'] or len(metadata['tables']) != 13:
        raise ValueError('A complete, ready, 13-table quality run is required')
    if Path(metadata['database']).resolve() != db.resolve():
        raise ValueError('Quality run refers to a different database')
    if metadata['database_bytes'] != db.stat().st_size:
        raise ValueError('Database size changed after the quality run')
    checked_at = datetime.fromisoformat(metadata['generated_at_utc'])
    if datetime.fromtimestamp(db.stat().st_mtime, timezone.utc) > checked_at:
        raise ValueError('Database was modified after the quality run')


def published_manifest(manifest: dict, db: Path, quality: Path) -> dict:
    """Hide machine paths while retaining source names and quality-run identity."""
    return {**manifest, "database": db.name,
            "quality_run": f"{quality.parent.name}/{quality.name}"}


def main(argv: list[str] | None = None) -> int:
    """Check quality provenance, aggregate in DuckDB and write an ignored run."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('--quality', type=Path, required=True, help='Full quality_results.json for this DB')
    parser.add_argument('--output', type=Path, required=True, help='Ignored scratch run directory')
    parser.add_argument('--publish', type=Path, help='Optional reviewed report directory')
    parser.add_argument('--memory-limit', default='3GB')
    args = parser.parse_args(argv)
    report = json.loads(args.quality.read_text(encoding='utf-8'))
    metadata = report['metadata']
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
            con.execute('SET threads=?', [int(os.environ.get('DUCKDB_THREADS','2'))])
            con.execute('SET temp_directory=?', [str(tmp)])
            data = analyze(con)
    finally:
        shutil.rmtree(tmp)
    manifest = {
        'generated_at_utc': datetime.now(timezone.utc).isoformat(),
        'database': str(args.db.resolve()),
        'database_bytes': args.db.stat().st_size,
        'quality_run': str(args.quality.resolve()),
        'quality_generated_at_utc': metadata['generated_at_utc'],
        'quality_checks': len(report['checks']),
        'quality_errors': metadata['errors'],
        'quality_warnings': metadata['warnings'],
        'source': metadata['source'],
        'bronze_watermarks': metadata['watermarks'],
        'source_files_by_table': {item['table']: item['numerator'] for item in report['checks'] if item['check']=='source_files'},
        'quality_warning_checks': [{'table': item['table'], 'check': item['check'], 'numerator': item['numerator'], 'denominator': item['denominator']} for item in report['checks'] if item['severity']=='warning'],
        'silver_counts': data['silver_counts'],
        'metric_grain': {'marketing':'send_id','product':'product_id','digital':'session_id','intake':'complaint_id'},
        'memory_model': 'DuckDB projected scans and grouped SQL with disk spill; Python holds aggregate rows only',
    }
    write_reports(data,args.output)
    (args.output/'manifest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    if args.publish:
        write_reports(data,args.publish)
        (args.publish/'manifest.json').write_text(json.dumps(published_manifest(manifest,args.db,args.quality),indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    print(f'report_run={args.output} sends={data["marketing"]["overall"]["sends"]} events={data["digital"]["events"]["events"]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
