"""CLI for reproducible Bronze/Silver quality and analytical-readiness runs."""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from .checks import run_checks
from .contracts import CONTRACTS


def main(argv: list[str] | None = None) -> int:
    """Run aggregate checks, write an ignored audit, and fail on errors."""
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parents[2] / "data"))
    parser.add_argument("--db", type=Path, default=Path(os.environ.get("DUCKDB_PATH", root / "latam_bank.duckdb")))
    parser.add_argument("--output-root", type=Path, default=root / "quality_runs")
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--tables", help="Comma-separated contracts for a controlled check")
    parser.add_argument("--memory-limit", default="3GB")
    args = parser.parse_args(argv)
    if not args.db.is_file():
        parser.error(f"DuckDB file does not exist: {args.db}")
    if not args.run_id.replace("-", "").replace("_", "").isalnum():
        parser.error("run-id must contain only letters, numbers, hyphens, or underscores")
    selected = args.tables.split(",") if args.tables else None
    if selected and set(selected) - set(CONTRACTS):
        parser.error(f"Unknown tables: {sorted(set(selected)-set(CONTRACTS))}")
    run_dir = args.output_root / args.run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    temp_dir = root / "duckdb_tmp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(str(args.db), read_only=True) as con:
        con.execute("SET memory_limit=?", [args.memory_limit])
        con.execute("SET threads=?", [int(os.environ.get("DUCKDB_THREADS", "2"))])
        con.execute("SET temp_directory=?", [str(temp_dir)])
        checks = run_checks(con, selected, progress=lambda table: print(f"quality_table={table}", flush=True))
        watermarks = []
        if con.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='bronze' AND table_name='_load_watermarks'").fetchone()[0]:
            watermarks = [{"table": row[0], "last_loaded_date": str(row[1])} for row in con.execute("SELECT table_name, last_loaded_date FROM bronze._load_watermarks ORDER BY table_name").fetchall()]
    errors = sum(item["severity"] == "error" for item in checks)
    warnings = sum(item["severity"] == "warning" for item in checks)
    report = {"metadata": {"generated_at_utc": datetime.now(timezone.utc).isoformat(),
              "database": str(args.db.resolve()), "database_bytes": args.db.stat().st_size,
              "source": "Local Bronze DuckDB; _source_file identifies each ingested object", "tables": selected or list(CONTRACTS),
              "memory_limit": args.memory_limit, "watermarks": watermarks,
              "errors": errors, "warnings": warnings, "ready": errors == 0}, "checks": checks}
    (run_dir / "quality_results.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    lines = ["# Bronze/Silver quality audit", "", f"- Status: {'READY' if not errors else 'FAILED'}", f"- Errors: {errors}", f"- Warnings: {warnings}", f"- Checks: {len(checks)}", "", "## Findings", ""]
    lines.extend(f"- {item['severity']}: `{item['table'] + ('.' + item['field'] if item['field'] else '')}` {item['check']} = {item['numerator']:,}/{item['denominator']:,}" for item in checks if item["numerator"] and item["severity"] != "info")
    (run_dir / "quality_report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"quality_run={run_dir} errors={errors} warnings={warnings} checks={len(checks)}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
