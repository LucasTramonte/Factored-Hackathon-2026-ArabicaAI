# Shared Data Foundation

This package provides reusable data contracts, quality checks, CSV processing utilities,
and test conventions for future analytical use cases. It is not the final business
analysis and does not select a customer-service workflow.

The first concrete capability is a data-quality baseline that profiles the supplied
LATAM Bank CSV data without changing raw files.

## Layout

- `config/` contains shared data contracts and future foundation configuration.
- `src/` contains reusable contracts and quality-check components.
- `scripts/` contains runnable foundation utilities, not business-specific analyses.
- `tests/` contains dependency-free fixtures and regression tests for shared behavior.
- `runs/data-quality-baseline/<run_id>/` contains immutable audit-run outputs and is ignored by Git.

Future use cases should add separate modules with their own contracts, tests, outputs,
and documentation. Business-specific reports should not be placed in this package.

Python contracts remain the runtime source of truth until YAML loading is deliberately
wired and contract parity is tested.

## Run

From the repository root:

```powershell
python -m data_foundation.scripts.run_baseline
```

Each run is written to `data_foundation/runs/data-quality-baseline/<run_id>/`. The UTC `run_id`
defaults to `YYYYMMDDTHHMMSSZ`; pass `--run-id` when a named smoke or controlled run is
useful. Generated artifacts are ignored by Git.

Each audit run contains:

- `run_manifest.json` — run ID, timestamp, command, data root, tables, counts, and artifact list.
- `quality_results.json` — machine-readable check results.
- `file_inventory.csv` — discovered files, partitions, row counts, and column counts.
- `quality_report.md` — concise human-readable summary.
- `run.log` — UTC table/file progress and completion status.

For a focused scan:

```powershell
python -m data_foundation.scripts.run_baseline --table customers --table products --output-root data_foundation/runs/data-quality-baseline --run-id controlled-20260926T120000Z
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
