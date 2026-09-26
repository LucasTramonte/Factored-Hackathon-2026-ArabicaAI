# Data Quality Architecture

## Scope

The current system is a read-only baseline scanner for the LATAM Bank CSV dataset. It inventories files, checks declared schemas and rows, tracks duplicate keys, validates partition dates, and reports selected foreign-key orphan signals.

## Components

- `analysis/src/contracts.py` contains executable `TableContract` and `ForeignKey` definitions plus file discovery. Contracts define the Python runtime schema authority.
- `analysis/src/quality/checks.py` contains CSV row iteration, schema checks, required-field checks, domain checks, duplicate-key checks, date parsing, partition checks, and result normalization.
- `analysis/scripts/run_baseline.py` orchestrates table scans, retains key sets only for tables used as foreign-key parents, performs relationship checks, and writes JSON, CSV, and Markdown reports.
- `analysis/config/data_quality_contracts.yaml` is a human-readable audit registry. It mirrors the executable contracts but is not loaded by Python yet.
- `analysis/tests/` contains dependency-free fixture tests for the quality checks.

## Data Flow

```text
data/ CSV files
    -> contract-based file discovery
    -> header validation and streaming row iteration
    -> row-level quality checks
    -> dimension key materialization for FK parents
    -> streaming FK membership checks
    -> JSON / CSV / Markdown reports
```

The scanner does not modify raw files and does not silently deduplicate records.

## Memory Model

Rows are consumed through Python CSV iterators rather than loaded into a full-table DataFrame. Parent key sets are retained only for referenced dimension tables such as customers, products, branches, agents, and campaigns. Large fact-table key sets must never be retained.

A previous implementation reached approximately 2.3 GB of memory by materializing keys from large fact tables. The current orchestration avoids that mistake by identifying FK parent tables first and retaining keys only for those small-side tables. New large-data code must document whether memory grows with chunk size, unique dimension keys, or total fact rows.

## Foreign-Key Validation

The runner builds small-side key sets for referenced parent tables and streams child rows for membership checks. This is intentionally safer than building a set of all child or fact keys. The current implementation performs a separate pass for each relationship after the table scan; this is a known simplicity/runtime trade-off, not a one-pass guarantee.

## Contracts And Joins

Contracts are declarative in shape, even though the executable registry currently lives in Python. Composite keys are represented explicitly, including `(date, source_currency, target_currency)` for exchange rates. Analytical joins must state their grain and cardinality before execution. Shared `customer_id` values do not make two fact tables safe to join directly.

## Reporting And Artifacts

Reports include machine-readable check results, a file inventory, and a concise Markdown summary. Reports are generated artifacts and are ignored by Git. The report is evidence of observed data quality, not an automatic repair process.

## Testing Strategy

Quality behavior is protected with small fixtures first. The intended progression is unit tests, fixtures, integration tests, smoke tests, controlled data, and only then a full scan. Regression tests should reproduce discovered bugs with the smallest possible input before preserving the fix.

## Known Trade-offs

- The scanner uses streaming row iteration, not pandas chunking or a disk-backed query engine.
- Foreign-key validation currently uses repeated relationship passes for clarity.
- The YAML registry is intentionally not wired into runtime loading until contract parity and failure behavior are tested.
- Progress reporting is currently at command/result level; future long scans should add file-boundary progress without per-row logging.