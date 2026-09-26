"""Command-line orchestration for the LATAM Bank data-quality baseline."""

from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
import re

from analysis.src.contracts import CONTRACTS, discover_files
from analysis.src.quality.checks import read_rows, result, row_checks, schema_checks


def partition_date_from_path(path: Path) -> str | None:
    """Extract a complete `YYYY-MM-DD` partition from a year/month/day path."""

    partition_parts = {match.group(1): match.group(2) for match in re.finditer(r"(year|month|day)=(\d+)", str(path))}
    if {"year", "month", "day"}.issubset(partition_parts):
        return "{year}-{month:02d}-{day:02d}".format(year=partition_parts["year"], month=int(partition_parts["month"]), day=int(partition_parts["day"]))
    return None


def run(data_root: Path, output_root: Path, selected_tables: set[str] | None = None) -> list[dict]:
    """Run configured quality checks and write JSON, CSV, and Markdown artifacts."""

    output_root.mkdir(parents=True, exist_ok=True)
    results: list[dict] = []
    inventories: list[dict] = []
    parent_tables = {
        foreign_key.parent_table
        for contract in CONTRACTS.values()
        for foreign_key in contract.foreign_keys
    }
    keys_by_table: dict[str, set[str]] = {}

    for name, contract in CONTRACTS.items():
        if selected_tables and name not in selected_tables:
            continue
        files = discover_files(data_root, contract)
        if not files:
            results.append(result("table_discovery", name, "error", 1, 1, "No CSV files discovered"))
            continue
        table_keys: set[str] = set()
        for path in files:
            with path.open("r", encoding="utf-8-sig", newline="") as handle:
                reader = csv.reader(handle)
                header = next(reader, [])
            expected_partition = partition_date_from_path(path)
            schema_results = schema_checks(contract, header)
            row_results, file_keys = row_checks(contract, read_rows(path), expected_partition)
            results.extend(schema_results)
            results.extend(row_results)
            if name in parent_tables:
                table_keys.update(file_keys)
            inventories.append({"table": name, "path": str(path.relative_to(data_root.parent)), "rows": next((r["numerator"] for r in row_results if r["check"] == "row_count"), 0), "columns": len(header), "partition": expected_partition})
        if name in parent_tables:
            keys_by_table[name] = table_keys
        results.append(result("table_discovery", name, "info", len(files), len(files), "CSV files discovered"))

    # Referential checks use key sets from dimensions and are intentionally reported at table level.
    for name, contract in CONTRACTS.items():
        if name not in keys_by_table:
            continue
        files = discover_files(data_root, contract)
        for foreign_key in contract.foreign_keys:
            parent_keys = keys_by_table.get(foreign_key.parent_table, set())
            missing = 0
            seen = 0
            sample = None
            for path in files:
                for row in read_rows(path):
                    value = (row.get(foreign_key.field) or "").strip()
                    if not value:
                        continue
                    seen += 1
                    if value not in parent_keys:
                        missing += 1
                        sample = sample or value
            results.append(result("foreign_key_orphans", name, "warning" if missing else "info", missing, seen, f"References missing from {foreign_key.parent_table}", field=foreign_key.field, sample=sample))

    metadata = {"generated_at_utc": datetime.utcnow().isoformat() + "Z", "data_root": str(data_root), "tables": sorted(keys_by_table)}
    (output_root / "baseline_results.json").write_text(json.dumps({"metadata": metadata, "checks": results}, indent=2), encoding="utf-8")
    with (output_root / "inventory.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["table", "path", "rows", "columns", "partition"])
        writer.writeheader()
        writer.writerows(inventories)
    _write_markdown_report(output_root / "baseline_report.md", results, metadata)
    return results


def _write_markdown_report(path: Path, results: list[dict], metadata: dict) -> None:
    """Write a concise human-readable summary of normalized quality results."""

    severity_counts = {severity: sum(item["severity"] == severity for item in results) for severity in ("error", "warning", "info")}
    error_checks: dict[str, int] = defaultdict(int)
    warning_checks: dict[str, int] = defaultdict(int)
    for item in results:
        if item["severity"] == "error":
            error_checks[item["check"]] += 1
        elif item["severity"] == "warning":
            warning_checks[item["check"]] += 1
    lines = [
        "# Data Quality Baseline",
        "",
        f"Generated: `{metadata['generated_at_utc']}`  ",
        f"Data root: `{metadata['data_root']}`",
        "",
        "## Summary",
        "",
        f"- Checks: {len(results)}",
        f"- Errors: {severity_counts['error']}",
        f"- Warnings: {severity_counts['warning']}",
        f"- Informational results: {severity_counts['info']}",
        "",
        "Errors indicate findings that can invalidate downstream analysis; they do not imply that raw data was changed.",
        "",
        "## Error checks",
        "",
    ]
    if error_checks:
        lines.extend(f"- `{check}`: {count}" for check, count in sorted(error_checks.items()))
    else:
        lines.append("- None")
    lines.extend(["", "## Warning checks", ""])
    if warning_checks:
        lines.extend(f"- `{check}`: {count}" for check, count in sorted(warning_checks.items()))
    else:
        lines.append("- None")
    lines.extend(["", "## Interpretation", "", "Raw files were scanned without modification or silent deduplication. Downstream analyses should use the machine-readable results to exclude or explicitly handle affected fields and relationships.", ""])
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    """Parse command-line options, run the baseline, and expose error status."""

    parser = argparse.ArgumentParser(description="Run the LATAM Bank data quality baseline")
    parser.add_argument("--data-root", type=Path, default=Path("data"))
    parser.add_argument("--output-root", type=Path, default=Path("analysis/reports"))
    parser.add_argument("--table", action="append", dest="tables")
    args = parser.parse_args()
    results = run(args.data_root, args.output_root, set(args.tables) if args.tables else None)
    errors = sum(item["severity"] == "error" for item in results)
    warnings = sum(item["severity"] == "warning" for item in results)
    print(f"checks={len(results)} errors={errors} warnings={warnings}")
    raise SystemExit(1 if errors else 0)


if __name__ == "__main__":
    main()
