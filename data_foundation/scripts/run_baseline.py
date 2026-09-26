"""Command-line orchestration for the LATAM Bank data-quality baseline."""

from __future__ import annotations

import argparse
import csv
import json
import logging
import shlex
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
import re
import sys
import time

from data_foundation.src.contracts import CONTRACTS, discover_files
from data_foundation.src.quality.checks import DiskKeySet, read_rows, result, row_checks, schema_checks


LOGGER = logging.getLogger("data_foundation.data_quality")
RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


def partition_date_from_path(path: Path) -> str | None:
    """Extract a complete `YYYY-MM-DD` partition from a year/month/day path."""

    partition_parts = {match.group(1): match.group(2) for match in re.finditer(r"(year|month|day)=(\d+)", str(path))}
    if {"year", "month", "day"}.issubset(partition_parts):
        return "{year}-{month:02d}-{day:02d}".format(year=partition_parts["year"], month=int(partition_parts["month"]), day=int(partition_parts["day"]))
    return None


def run(data_root: Path, output_root: Path, selected_tables: set[str] | None = None, run_id: str | None = None, command: str | None = None) -> list[dict]:
    """Run checks and write an immutable, timestamped audit run directory."""

    if selected_tables:
        unknown = set(selected_tables) - set(CONTRACTS)
        if unknown:
            raise ValueError(f"Unknown table(s) selected: {sorted(unknown)}")

    generated_at = datetime.now(timezone.utc)
    run_id = run_id or generated_at.strftime("%Y%m%dT%H%M%SZ")
    if not RUN_ID_PATTERN.fullmatch(run_id):
        raise ValueError("run_id must contain 1-64 letters, numbers, dots, underscores, or hyphens")
    run_directory = output_root / run_id
    run_directory.mkdir(parents=True, exist_ok=False)
    _configure_logging(run_directory / "run.log")
    try:
        LOGGER.info("Starting data-quality run_id=%s data_root=%s", run_id, data_root)
        results: list[dict] = []
        inventories: list[dict] = []
        parent_tables = {
            foreign_key.parent_table
            for contract in CONTRACTS.values()
            for foreign_key in contract.foreign_keys
        }
        keys_by_table: dict[str, set[str]] = {}
        scanned_tables: set[str] = set()
        interaction_keys_store: DiskKeySet | None = None

        try:
            for name, contract in CONTRACTS.items():
                if selected_tables and name not in selected_tables:
                    continue
                scanned_tables.add(name)
                files = discover_files(data_root, contract)
                if not files:
                    results.append(result("table_discovery", name, "error", 1, 1, "No CSV files discovered"))
                    continue
                LOGGER.info("Scanning table=%s files=%d", name, len(files))

                is_fact_table = contract.partition_field is not None
                if name == "call_center_interactions":
                    if interaction_keys_store is None:
                        interaction_keys_store = DiskKeySet()
                    table_tracker = interaction_keys_store
                elif is_fact_table:
                    table_tracker = DiskKeySet()
                else:
                    table_tracker = set()

                table_keys: set[str] = set()
                cross_partition_duplicates = 0
                cross_partition_sample = None
                total_rows_seen = 0

                try:
                    for path in files:
                        with path.open("r", encoding="utf-8-sig", newline="") as handle:
                            reader = csv.reader(handle)
                            header = next(reader, [])
                        expected_partition = partition_date_from_path(path)
                        if contract.partition_field:
                            is_valid_date = False
                            if expected_partition:
                                try:
                                    datetime.strptime(expected_partition, "%Y-%m-%d")
                                    is_valid_date = True
                                except ValueError:
                                    is_valid_date = False
                            if not is_valid_date:
                                results.append(result("partition_path_invalid", name, "error", 1, 1, f"Partitioned contract file has invalid or incomplete partition date: {path}"))

                        schema_results = schema_checks(contract, header)
                        results.extend(schema_results)
                        if any(r["severity"] == "error" for r in schema_results):
                            LOGGER.error("Schema validation failed for table=%s file=%s, skipping row checks", name, path.name)
                            continue

                        def tracked_rows_generator(rows_iterable):
                            nonlocal cross_partition_duplicates, cross_partition_sample, total_rows_seen
                            for row in rows_iterable:
                                total_rows_seen += 1
                                key_values = tuple((row.get(field) or "").strip() for field in contract.key_fields)
                                key = "|".join(key_values)
                                if key:
                                    if isinstance(table_tracker, DiskKeySet):
                                        if not table_tracker.add(key):
                                            cross_partition_duplicates += 1
                                            if cross_partition_sample is None:
                                                cross_partition_sample = key
                                    else:
                                        if key in table_tracker:
                                            cross_partition_duplicates += 1
                                            if cross_partition_sample is None:
                                                cross_partition_sample = key
                                        else:
                                            table_tracker.add(key)
                                yield row

                        row_results, file_keys = row_checks(contract, tracked_rows_generator(read_rows(path)), expected_partition)
                        results.extend(row_results)
                        if name in parent_tables and name != "call_center_interactions":
                            table_keys.update(file_keys)
                        inventories.append({"table": name, "path": str(path.relative_to(data_root.parent)), "rows": next((r["numerator"] for r in row_results if r["check"] == "row_count"), 0), "columns": len(header), "partition": expected_partition})
                        LOGGER.info("Scanned table=%s file=%s", name, path.name)
                finally:
                    if is_fact_table and name != "call_center_interactions" and isinstance(table_tracker, DiskKeySet):
                        table_tracker.close()

                if name in parent_tables and name != "call_center_interactions":
                    keys_by_table[name] = table_keys

                if is_fact_table or len(files) > 1:
                    results.append(result(
                        "duplicate_primary_keys_across_partitions",
                        name,
                        "error" if cross_partition_duplicates else "info",
                        cross_partition_duplicates,
                        total_rows_seen,
                        "Duplicate primary-key values across partitions",
                        field=contract.key,
                        sample=cross_partition_sample,
                    ))

                results.append(result("table_discovery", name, "info", len(files), len(files), "CSV files discovered"))

            # Referential checks: select tables whose contracts declare foreign keys
            for name, contract in CONTRACTS.items():
                if not contract.foreign_keys:
                    continue
                if selected_tables and name not in selected_tables:
                    continue
                files = discover_files(data_root, contract)
                for foreign_key in contract.foreign_keys:
                    parent = foreign_key.parent_table
                    parent_is_scanned = parent in scanned_tables
                    parent_keys: set[str] | None = None
                    parent_disk_store: DiskKeySet | None = None

                    if parent == "call_center_interactions":
                        if parent_is_scanned and interaction_keys_store is not None:
                            parent_disk_store = interaction_keys_store
                        elif not parent_is_scanned:
                            # Focused scan: load required parent table or skip
                            parent_contract = CONTRACTS["call_center_interactions"]
                            p_files = discover_files(data_root, parent_contract)
                            if p_files:
                                LOGGER.info("Loading unscanned parent %s for focused scan", parent)
                                if interaction_keys_store is None:
                                    interaction_keys_store = DiskKeySet()
                                for pf in p_files:
                                    for prow in read_rows(pf):
                                        pkey = (prow.get(parent_contract.key) or "").strip()
                                        if pkey:
                                            interaction_keys_store.add(pkey)
                                parent_disk_store = interaction_keys_store
                            else:
                                results.append(result(
                                    "foreign_key_orphans",
                                    name,
                                    "info",
                                    0,
                                    0,
                                    f"Parent table {parent} was not scanned; check skipped",
                                    field=foreign_key.field,
                                ))
                                continue
                    else:
                        if parent_is_scanned:
                            parent_keys = keys_by_table.get(parent, set())
                        else:
                            # Unscanned parent: for focused scan, load required parent table or skip
                            parent_contract = CONTRACTS.get(parent)
                            p_files = discover_files(data_root, parent_contract) if parent_contract else []
                            if p_files:
                                LOGGER.info("Loading unscanned parent %s for focused scan", parent)
                                loaded_keys: set[str] = set()
                                for pf in p_files:
                                    for prow in read_rows(pf):
                                        pkey_values = tuple((prow.get(field) or "").strip() for field in parent_contract.key_fields)
                                        pkey = "|".join(pkey_values)
                                        if pkey:
                                            loaded_keys.add(pkey)
                                keys_by_table[parent] = loaded_keys
                                parent_keys = loaded_keys
                            else:
                                results.append(result(
                                    "foreign_key_orphans",
                                    name,
                                    "info",
                                    0,
                                    0,
                                    f"Parent table {parent} was not scanned; check skipped",
                                    field=foreign_key.field,
                                ))
                                continue

                    missing = 0
                    seen = 0
                    sample = None
                    for path in files:
                        for row in read_rows(path):
                            value = (row.get(foreign_key.field) or "").strip()
                            if not value:
                                continue
                            seen += 1
                            is_present = (value in parent_disk_store) if parent_disk_store is not None else (value in parent_keys)
                            if not is_present:
                                missing += 1
                                sample = sample or value
                    results.append(result(
                        "foreign_key_orphans",
                        name,
                        "warning" if missing else "info",
                        missing,
                        seen,
                        f"References missing from {foreign_key.parent_table}",
                        field=foreign_key.field,
                        sample=sample,
                    ))
        finally:
            if interaction_keys_store is not None:
                interaction_keys_store.close()

        all_parent_tables = set(keys_by_table)
        if "call_center_interactions" in scanned_tables or interaction_keys_store is not None:
            all_parent_tables.add("call_center_interactions")

        severity_counts = {severity: sum(item["severity"] == severity for item in results) for severity in ("error", "warning", "info")}
        metadata = {
            "run_id": run_id,
            "generated_at_utc": generated_at.isoformat().replace("+00:00", "Z"),
            "data_root": str(data_root),
            "tables_requested": sorted(selected_tables) if selected_tables else sorted(CONTRACTS),
            "tables_with_parent_keys": sorted(all_parent_tables),
            "checks": len(results),
            "severity_counts": severity_counts,
            "command": command,
            "artifacts": ["run_manifest.json", "quality_results.json", "file_inventory.csv", "quality_report.md", "run.log"],
        }
        (run_directory / "run_manifest.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        (run_directory / "quality_results.json").write_text(json.dumps({"metadata": metadata, "checks": results}, indent=2), encoding="utf-8")
        with (run_directory / "file_inventory.csv").open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=["table", "path", "rows", "columns", "partition"])
            writer.writeheader()
            writer.writerows(inventories)
        _write_markdown_report(run_directory / "quality_report.md", results, metadata)
        LOGGER.info("Completed run_id=%s checks=%d errors=%d warnings=%d", run_id, len(results), severity_counts["error"], severity_counts["warning"])
        return results
    finally:
        _close_logging()


def _configure_logging(log_path: Path) -> None:
    """Configure concise console and file logging for one audit run."""

    _close_logging()
    LOGGER.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)sZ %(levelname)s %(message)s", "%Y-%m-%dT%H:%M:%S")
    formatter.converter = time.gmtime
    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(formatter)
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    LOGGER.addHandler(file_handler)
    LOGGER.addHandler(console_handler)


def _close_logging() -> None:
    """Close and remove all handlers attached to LOGGER."""

    for handler in list(LOGGER.handlers):
        handler.close()
        LOGGER.removeHandler(handler)


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
        f"Run ID: `{metadata['run_id']}`  ",
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
    parser.add_argument("--output-root", type=Path, default=Path("data_foundation/runs/data-quality-baseline"), help="Base directory for immutable audit runs")
    parser.add_argument("--run-id", help="Optional unique run identifier; defaults to UTC timestamp")
    parser.add_argument("--table", action="append", dest="tables")
    args = parser.parse_args()
    results = run(args.data_root, args.output_root, set(args.tables) if args.tables else None, args.run_id, shlex.join(sys.argv))
    errors = sum(item["severity"] == "error" for item in results)
    warnings = sum(item["severity"] == "warning" for item in results)
    print(f"checks={len(results)} errors={errors} warnings={warnings}")
    raise SystemExit(1 if errors else 0)


if __name__ == "__main__":
    main()
