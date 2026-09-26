# Data Quality Baseline

This package profiles the supplied LATAM Bank CSV data without changing raw files.
It inventories files and partitions, validates declared contracts, measures completeness,
checks primary-key duplicates, and reports partition/date consistency.

## Layout

- `config/data_quality_contracts.yaml` is the human-readable audit registry.
- `src/contracts.py` contains the executable Python contracts and file discovery.
- `src/quality/checks.py` contains streaming schema and row checks.
- `scripts/run_baseline.py` orchestrates scans and report generation.
- `tests/` contains dependency-free fixtures and regression tests.
- `reports/` contains generated JSON, CSV, and Markdown outputs and is ignored by Git.

Python contracts remain the runtime source of truth until YAML loading is deliberately
wired and contract parity is tested.

## Run

From the repository root:

```powershell
python -m analysis.scripts.run_baseline
```

Reports are written to `analysis/reports/`. They are generated artifacts and are ignored by Git.
The scan uses streaming CSV reads and projected columns where possible.

For a focused scan:

```powershell
python -m analysis.scripts.run_baseline --table customers --table products --output-root analysis/reports/smoke
```

## Validation progression

Use the least expensive check that can disprove the current hypothesis:

```text
unit tests -> small fixtures -> integration tests -> smoke test -> controlled dataset -> full dataset
```

Large fact tables must be streamed or processed in bounded chunks. Do not materialize
fact-table key sets; retain only small referenced dimension keys where necessary. Declare
analytical grain before joining facts and aggregate before a customer-level join.

## Severity policy

- `error`: required schema or integrity problem that can invalidate a downstream analysis.
- `warning`: observed quality limitation that requires documented handling.
- `info`: inventory or non-blocking observation.

Raw data is never modified or silently deduplicated.
