"""Streaming schema and row-level quality checks."""

from __future__ import annotations

import csv
from collections.abc import Iterable, Iterator
from datetime import datetime
from pathlib import Path
import sqlite3
import tempfile
from typing import Any

from data_foundation.src.contracts import TableContract

class DiskKeySet:
    """Bounded-memory, disk-backed set for tracking unique string keys using SQLite."""

    def __init__(self, db_path: Path | str | None = None) -> None:
        self._temp_file = None
        if db_path is None:
            self._temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
            self._path = Path(self._temp_file.name)
            self._temp_file.close()
        else:
            self._path = Path(db_path)
            self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._path)
        self._conn.execute("PRAGMA synchronous = OFF")
        self._conn.execute("PRAGMA journal_mode = OFF")
        self._conn.execute("CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, origin TEXT)")
        self._cur = self._conn.cursor()

    def add(self, key: str) -> bool:
        """Add key. Return True if new, False if already present (duplicate)."""
        self._cur.execute("INSERT OR IGNORE INTO keys (key) VALUES (?)", (key,))
        return self._cur.rowcount > 0

    def first_origin(self, key: str, origin: str) -> str | None:
        """Record a key's first file and return its earlier file, if any."""
        self._cur.execute("INSERT OR IGNORE INTO keys (key, origin) VALUES (?, ?)", (key, origin))
        if self._cur.rowcount:
            return None
        self._cur.execute("SELECT origin FROM keys WHERE key = ?", (key,))
        return self._cur.fetchone()[0]

    def __contains__(self, key: str) -> bool:
        self._cur.execute("SELECT 1 FROM keys WHERE key = ?", (key,))
        return self._cur.fetchone() is not None

    def close(self) -> None:
        self._conn.close()
        if self._temp_file is not None and self._path.exists():
            try:
                self._path.unlink()
            except OSError:
                pass

    def __enter__(self) -> DiskKeySet:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.close()


def result(check: str, table: str, severity: str, numerator: int, denominator: int, message: str, field: str | None = None, sample: Any = None) -> dict[str, Any]:
    """Build a normalized quality result with numerator, denominator, and rate."""

    return {"check": check, "table": table, "field": field, "severity": severity, "numerator": numerator, "denominator": denominator, "rate": numerator / denominator if denominator else None, "message": message, "sample": sample}


def read_rows(path: Path) -> Iterator[dict[str, str]]:
    """Yield CSV rows one at a time without retaining the file in memory."""

    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        yield from csv.DictReader(handle)


def schema_checks(contract: TableContract, header: list[str]) -> list[dict[str, Any]]:
    """Compare an observed header with the columns declared by a contract."""

    seen: set[str] = set()
    duplicate_columns: list[str] = []
    for col in header:
        if col in seen:
            if col not in duplicate_columns:
                duplicate_columns.append(col)
        else:
            seen.add(col)

    actual = set(header)
    expected = set(contract.expected_columns)
    missing = sorted(expected - actual)
    results = [
        result("schema_duplicate_columns", contract.name, "error" if duplicate_columns else "info", len(duplicate_columns), len(header), "Duplicate columns in header", sample=duplicate_columns if duplicate_columns else None),
        result("schema_missing_columns", contract.name, "error" if missing else "info", len(missing), len(expected), "Missing expected columns", sample=missing),
    ]
    return results


def row_checks(
    contract: TableContract,
    rows: Iterable[dict[str, str]],
    expected_partition: str | None = None,
    retain_keys: bool | None = None,
) -> tuple[list[dict[str, Any]], set[str]]:
    """Evaluate contract checks over an iterable and return results plus observed keys."""

    rows_seen = 0
    nulls = {field: 0 for field in contract.required}
    invalid_domains = {field: 0 for field in contract.domains}
    duplicate_keys = 0
    partition_mismatches = 0
    date_parse_failures = 0
    late_rows = 0
    samples: dict[str, Any] = {}

    is_large_fact = contract.partition_field is not None
    if retain_keys is None:
        retain_in_memory = not is_large_fact
    else:
        retain_in_memory = retain_keys

    key_tracker: DiskKeySet | set[str] = DiskKeySet() if is_large_fact else set()
    in_memory_keys: set[str] = set()

    try:
        for row in rows:
            rows_seen += 1
            key_values = tuple((row.get(field) or "").strip() for field in contract.key_fields)
            key = "|".join(key_values)
            if not key:
                if contract.key not in contract.required:
                    nulls[contract.key] = nulls.get(contract.key, 0) + 1
            elif isinstance(key_tracker, DiskKeySet):
                if not key_tracker.add(key):
                    duplicate_keys += 1
                    samples.setdefault("duplicate_key", key)
                elif retain_in_memory:
                    in_memory_keys.add(key)
            else:
                if key in key_tracker:
                    duplicate_keys += 1
                    samples.setdefault("duplicate_key", key)
                else:
                    key_tracker.add(key)
                    if retain_in_memory:
                        in_memory_keys.add(key)

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
                    if expected_partition and row[contract.date_field][:10] < expected_partition:
                        late_rows += 1
                except ValueError:
                    date_parse_failures += 1
                    samples.setdefault("date_parse_failure", row[contract.date_field])
    finally:
        if isinstance(key_tracker, DiskKeySet):
            key_tracker.close()

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
        results.append(result("late_arrival_signal", contract.name, "warning" if late_rows else "info", late_rows, rows_seen, "Business date is before process partition", field=contract.date_field))
    return results, in_memory_keys
