"""Streaming schema and row-level quality checks."""

from __future__ import annotations

import csv
from collections.abc import Iterable, Iterator
from datetime import datetime
from pathlib import Path
from typing import Any

from data_foundation.src.contracts import TableContract


def result(check: str, table: str, severity: str, numerator: int, denominator: int, message: str, field: str | None = None, sample: Any = None) -> dict[str, Any]:
    """Build a normalized quality result with numerator, denominator, and rate."""

    return {"check": check, "table": table, "field": field, "severity": severity, "numerator": numerator, "denominator": denominator, "rate": numerator / denominator if denominator else None, "message": message, "sample": sample}


def read_rows(path: Path) -> Iterator[dict[str, str]]:
    """Yield CSV rows one at a time without retaining the file in memory."""

    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        yield from csv.DictReader(handle)


def schema_checks(contract: TableContract, header: list[str]) -> list[dict[str, Any]]:
    """Compare an observed header with the columns declared by a contract."""

    actual = set(header)
    expected = set(contract.expected_columns)
    missing = sorted(expected - actual)
    results = [result("schema_missing_columns", contract.name, "error" if missing else "info", len(missing), len(expected), "Missing expected columns", sample=missing)]
    return results


def row_checks(contract: TableContract, rows: Iterable[dict[str, str]], expected_partition: str | None = None) -> tuple[list[dict[str, Any]], set[str]]:
    """Evaluate contract checks over an iterable and return results plus observed keys."""

    rows_seen = 0
    nulls = {field: 0 for field in contract.required}
    invalid_domains = {field: 0 for field in contract.domains}
    duplicate_keys = 0
    keys: set[str] = set()
    partition_mismatches = 0
    date_parse_failures = 0
    late_rows = 0
    samples: dict[str, Any] = {}

    for row in rows:
        rows_seen += 1
        key_values = tuple((row.get(field) or "").strip() for field in contract.key_fields)
        key = "|".join(key_values)
        if not key:
            nulls[contract.key] = nulls.get(contract.key, 0) + 1
        elif key in keys:
            duplicate_keys += 1
            samples.setdefault("duplicate_key", key)
        else:
            keys.add(key)

        for field in contract.required:
            if not (row.get(field) or "").strip():
                nulls[field] += 1
        for field, allowed in contract.domains.items():
            value = (row.get(field) or "").strip()
            if value and value not in allowed:
                invalid_domains[field] += 1
                samples.setdefault(f"invalid_{field}", value)
        if expected_partition and contract.partition_field:
            actual_partition = (row.get(contract.partition_field) or "")[:10]
            if actual_partition != expected_partition:
                partition_mismatches += 1
                samples.setdefault("partition_mismatch", actual_partition)
        if contract.date_field and (row.get(contract.date_field) or "").strip():
            try:
                datetime.fromisoformat(row[contract.date_field].replace("Z", "+00:00"))
                if expected_partition and row[contract.date_field][:10] > expected_partition:
                    late_rows += 1
            except ValueError:
                date_parse_failures += 1
                samples.setdefault("date_parse_failure", row[contract.date_field])

    results = [result("row_count", contract.name, "info", rows_seen, rows_seen, "Rows scanned")]
    results.append(result("duplicate_primary_keys", contract.name, "error" if duplicate_keys else "info", duplicate_keys, rows_seen, "Duplicate primary-key values", field=contract.key, sample=samples.get("duplicate_key")))
    for field, count in nulls.items():
        results.append(result("required_field_nulls", contract.name, "error" if count else "info", count, rows_seen, "Blank required values", field=field))
    for field, count in invalid_domains.items():
        results.append(result("domain_violations", contract.name, "warning" if count else "info", count, rows_seen, "Values outside declared domain", field=field, sample=samples.get(f"invalid_{field}")))
    if contract.partition_field:
        results.append(result("partition_date_mismatch", contract.name, "error" if partition_mismatches else "info", partition_mismatches, rows_seen, "Rows disagree with file partition", field=contract.partition_field, sample=samples.get("partition_mismatch")))
    if contract.date_field:
        results.append(result("date_parse_failures", contract.name, "error" if date_parse_failures else "info", date_parse_failures, rows_seen, "Business date could not be parsed", field=contract.date_field, sample=samples.get("date_parse_failure")))
        results.append(result("late_arrival_signal", contract.name, "warning" if late_rows else "info", late_rows, rows_seen, "Business date is after process partition", field=contract.date_field))
    return results, keys
