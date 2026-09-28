"""Read-only DuckDB checks over Bronze source rows and Silver analytical tables.

The database engine may spill large joins and grouped keys to disk. Python retains only
contract metadata and aggregate results, never a fact-table key set or raw row list.
"""
from __future__ import annotations

import re
from typing import Iterable

from .contracts import CONTRACTS, TableContract
from data_pipelines.silver.table_specs import ALL_SPECS

_SILVER_COLUMNS = {spec.name: {column.target_name() for column in spec.columns} for spec in ALL_SPECS}
_SILVER_COLUMNS["daily_exchange_rates"] = {"rate_date", "source_currency", "target_currency", "exchange_rate", "buy_rate", "sell_rate", "rate_source"}

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z_0-9]*$")


def ident(name: str) -> str:
    """Return a safe SQL identifier from a fixed, developer-owned contract."""
    if not _IDENTIFIER.fullmatch(name):
        raise ValueError(f"Unsafe identifier: {name!r}")
    return f'"{name}"'


def metric(check: str, table: str, count: int, denominator: int, severity: str, field: str | None = None) -> dict:
    """Describe one aggregate check with a reproducible denominator."""
    return {"check": check, "table": table, "field": field, "numerator": int(count),
            "denominator": int(denominator), "rate": count / denominator if denominator else None,
            "severity": severity}


def silver_name(contract: TableContract) -> str:
    """Map the raw contract to Manoella's typed Silver naming convention."""
    if contract.name == "daily_exchange_rates":
        return "dim_fx_rates"
    return ("fact_" if contract.partition_field else "dim_") + contract.name


def _scalar(con, sql: str, params: Iterable = ()) -> int:
    return int(con.execute(sql, list(params)).fetchone()[0] or 0)


def _columns(con, schema: str, table: str) -> set[str]:
    return {row[0] for row in con.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=?",
        [schema, table]).fetchall()}


def _nonblank(alias: str, field: str) -> str:
    value = f"{alias}.{ident(field)}"
    return f"NULLIF(TRIM(CAST({value} AS VARCHAR)), '')"


def check_table(con, contract: TableContract, selected: set[str] | None = None) -> list[dict]:
    """Check one Bronze/Silver pair without copying fact rows into Python."""
    name = contract.name
    silver = silver_name(contract)
    bronze_cols = _columns(con, "bronze", name)
    silver_cols = _columns(con, "silver", silver)
    results: list[dict] = []
    if not bronze_cols:
        return [metric("table_discovery", name, 1, 1, "error")]
    if not silver_cols:
        return [metric("silver_table_discovery", name, 1, 1, "error")]
    missing = set(contract.expected_columns) - bronze_cols
    duplicate_columns = [col for col in bronze_cols if re.fullmatch(r".+_[0-9]+", col) and col.rsplit("_", 1)[0] in bronze_cols]
    results.append(metric("schema_duplicate_columns", name, len(duplicate_columns), len(bronze_cols), "error" if duplicate_columns else "info"))
    results.append(metric("schema_missing_columns", name, len(missing), len(contract.expected_columns),
                          "error" if missing else "info"))
    silver_required = _SILVER_COLUMNS[name]
    silver_missing = silver_required - silver_cols
    results.append(metric("silver_schema_missing_columns", name, len(silver_missing), len(silver_required),
                          "error" if silver_missing else "info"))
    if missing or silver_missing:
        return results
    b = f"bronze.{ident(name)}"
    s = f"silver.{ident(silver)}"
    raw = _scalar(con, f"SELECT COUNT(*) FROM {b}")
    typed = _scalar(con, f"SELECT COUNT(*) FROM {s}")
    results.extend([metric("row_count", name, raw, raw, "info"), metric("silver_row_count", name, typed, raw, "info")])
    if "_source_file" in bronze_cols:
        source_files = _scalar(con, f"SELECT COUNT(DISTINCT _source_file) FROM {b}")
        results.append(metric("source_files", name, source_files, source_files, "info"))
    key_sql = ", ".join(f"{ident(field)}" for field in contract.key_fields)
    duplicates = _scalar(con, f"SELECT COALESCE(SUM(n-1),0) FROM (SELECT COUNT(*) n FROM {b} GROUP BY {key_sql} HAVING COUNT(*)>1)")
    results.append(metric("duplicate_primary_keys", name, duplicates, raw, "error" if duplicates else "info", contract.key))
    if "_source_file" in bronze_cols:
        grouped = f"SELECT {key_sql}, _source_file, COUNT(*) n FROM {b} GROUP BY {key_sql}, _source_file"
        within = _scalar(con, f"SELECT COALESCE(SUM(n-1),0) FROM ({grouped})")
        origin_group = f"SELECT n, _source_file, MIN(_source_file) OVER (PARTITION BY {key_sql}) first_file FROM ({grouped})"
        across = _scalar(con, f"SELECT COALESCE(SUM(CASE WHEN _source_file IS DISTINCT FROM first_file THEN n ELSE 0 END),0) FROM ({origin_group})")
        results.append(metric("duplicate_primary_keys_within_file", name, within, raw, "error" if within else "info", contract.key))
        results.append(metric("duplicate_primary_keys_across_partitions", name, across, raw, "error" if across else "info", contract.key))
    delta = raw - typed
    results.append(metric("silver_row_delta_unexplained", name, abs(delta-duplicates), raw,
                          "error" if delta != duplicates else "info"))
    for field in contract.required:
        blank = _scalar(con, f"SELECT COUNT(*) FROM {b} b WHERE {_nonblank('b',field)} IS NULL")
        results.append(metric("required_field_nulls", name, blank, raw, "error" if blank else "info", field))
        silver_field = "rate_date" if name == "daily_exchange_rates" and field == "date" else field
        nulls = _scalar(con, f"SELECT COUNT(*) FROM {s} WHERE {ident(silver_field)} IS NULL")
        results.append(metric("silver_required_nulls", name, nulls, typed, "error" if nulls else "info", silver_field))
    for field, allowed in contract.domains.items():
        clauses = ", ".join("?" for _ in allowed)
        invalid = _scalar(con, f"SELECT COUNT(*) FROM {b} b WHERE {_nonblank('b',field)} IS NOT NULL AND {_nonblank('b',field)} NOT IN ({clauses})", sorted(allowed))
        results.append(metric("domain_violations", name, invalid, raw, "warning" if invalid else "info", field))
    if contract.partition_field:
        # Source path describes processing partition. The business event timestamp is checked separately.
        if "_source_file" not in bronze_cols:
            results.append(metric("partition_source_missing", name, 1, raw, "error"))
        else:
            path_date = "regexp_extract(_source_file, 'year=([0-9]{4})/month=([0-9]{2})/day=([0-9]{2})', 1) || '-' || regexp_extract(_source_file, 'year=([0-9]{4})/month=([0-9]{2})/day=([0-9]{2})', 2) || '-' || regexp_extract(_source_file, 'year=([0-9]{4})/month=([0-9]{2})/day=([0-9]{2})', 3)"
            bad = _scalar(con, f"SELECT COUNT(*) FROM {b} WHERE TRY_CAST({path_date} AS DATE) IS DISTINCT FROM TRY_CAST({ident(contract.partition_field)} AS DATE)")
            results.append(metric("partition_date_mismatch", name, bad, raw, "error" if bad else "info", contract.partition_field))
    if contract.date_field:
        value = _nonblank('b', contract.date_field)
        invalid = _scalar(con, f"SELECT COUNT(*) FROM {b} b WHERE {value} IS NOT NULL AND TRY_CAST({value} AS TIMESTAMP) IS NULL")
        results.append(metric("date_parse_failures", name, invalid, raw, "error" if invalid else "info", contract.date_field))
        if contract.partition_field:
            late = _scalar(con, f"SELECT COUNT(*) FROM {b} b WHERE TRY_CAST({value} AS TIMESTAMP)::DATE < TRY_CAST(b.{ident(contract.partition_field)} AS DATE)")
            results.append(metric("late_arrival_signal", name, late, raw, "warning" if late else "info", contract.date_field))
    for fk in contract.foreign_keys:
        if selected is not None and fk.parent_table not in selected:
            results.append(metric("foreign_key_skipped", name, 0, raw, "info", fk.field))
            continue
        parent_cols = _columns(con, "bronze", fk.parent_table)
        if not parent_cols:
            results.append(metric("foreign_key_parent_missing", name, 1, raw, "error", fk.field))
            continue
        if fk.field not in bronze_cols or fk.parent_key not in parent_cols:
            results.append(metric("foreign_key_schema_missing", name, 1, raw, "error", fk.field))
            continue
        child = _nonblank('c', fk.field)
        parent = _nonblank('p', fk.parent_key)
        orphans = _scalar(con, f"SELECT COUNT(*) FROM {b} c WHERE {child} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bronze.{ident(fk.parent_table)} p WHERE {parent}={child})")
        results.append(metric("foreign_key_orphans", name, orphans, raw, "warning" if orphans else "info", fk.field))
    return results


def relationship_checks(con) -> list[dict]:
    """Measure cross-table relationships that foreign keys alone cannot validate."""
    results = []
    product_cols = _columns(con, "bronze", "products")
    if not {"product_id", "customer_id"} <= product_cols:
        return results
    for name in ("complaints", "digital_events", "transactions"):
        product_field = "affected_product_id" if name == "complaints" else "product_id"
        child_cols = _columns(con, "bronze", name)
        if not {"customer_id", product_field} <= child_cols:
            continue
        child = f"bronze.{ident(name)}"
        linked = _scalar(con, f"SELECT COUNT(*) FROM {child} c JOIN bronze.products p ON c.{ident(product_field)}=p.product_id WHERE c.customer_id IS NOT NULL")
        mismatched = _scalar(con, f"SELECT COUNT(*) FROM {child} c JOIN bronze.products p ON c.{ident(product_field)}=p.product_id WHERE c.customer_id IS NOT NULL AND c.customer_id<>p.customer_id")
        results.append(metric("product_owner_mismatch", name, mismatched, linked, "warning" if mismatched else "info", product_field))
    transaction_cols = _columns(con, "bronze", "transactions")
    if {"customer_id", "product_id", "transaction_date"} <= transaction_cols and "opening_date" in product_cols:
        preopen = _scalar(con, "SELECT COUNT(*) FROM bronze.transactions t JOIN bronze.products p ON t.product_id=p.product_id WHERE TRY_CAST(t.transaction_date AS TIMESTAMP)::DATE < TRY_CAST(p.opening_date AS DATE)")
        total = _scalar(con, "SELECT COUNT(*) FROM bronze.transactions")
        results.append(metric("transaction_before_product_opening", "transactions", preopen, total, "warning" if preopen else "info"))
    return results


def run_checks(con, tables: Iterable[str] | None = None, progress=None) -> list[dict]:
    """Return aggregate checks; optionally report completion at table boundaries."""
    selected = tuple(tables) if tables is not None else tuple(CONTRACTS)
    unknown = set(selected) - set(CONTRACTS)
    if unknown:
        raise ValueError(f"Unknown tables: {sorted(unknown)}")
    results = []
    selection = set(selected) if tables is not None else None
    for name in selected:
        results.extend(check_table(con, CONTRACTS[name], selection))
        if progress is not None:
            progress(name)
    if tables is None:
        results.extend(relationship_checks(con))
    return results
