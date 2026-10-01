# Current analysis: Silver first

`07_silver_transcript_verification.ipynb` is the current transcript-label reconciliation readout. It consumes the fresh S3 → Bronze → Silver audit after the scoped quality gate passes. Run commands and scope are in `Docs/intake/silver-transcript-verification.md`.

Notebooks 01–06 and their CSV/SQLite reports below are **historical evidence**. Do not use their old ingestion instructions for new analysis. Their cached results remain available for comparison; they are not a substitute for the current Silver quality gate. Jev predictions remain unadjudicated.

---

# Contact-center and fraud exploration

Open `01_customer_service_workflow_exploration.ipynb` for methods and code. The source notebook has cleared outputs; an executed notebook, HTML preview and meeting brief are delivered separately. No raw records or credentials belong in notebook outputs or Git.

## Setup

From the repository root, use Python 3.11 or newer (validated with Python 3.12):

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r notebooks/requirements.txt
.venv/bin/python -m ipykernel install --prefix .venv --name arabica-exploration --display-name 'ArabicaAI exploration'
```

If `python3 --version` is older than 3.11, use your installed newer Python executable for the first command. The notebook packages are separate from the stdlib baseline scanner.

## Inputs

Use the organizer-authorized AWS profile described in `Docs/deliverables/REPRODUCIBILITY.md`. The required tables are `call_center_interactions`, `transactions`, `complaints`, `customers` and `call_transcripts`. Finish their download before the final run; the input gate rejects missing, extra or differently sized CSV files. Never place keys in commands or notebook cells.

Create a fresh inventory from S3 (no credentials are included in this output):

```sh
mkdir -p data_foundation/runs/meeting-exploration
aws s3api list-objects-v2 \
  --bucket factored-datathon-2026-s3-157725502942-us-east-2-an \
  --prefix data/ --profile factored-datathon \
  --query 'Contents[].[Key,Size]' --output json \
  > data_foundation/runs/meeting-exploration/s3-inventory.json
.venv/bin/python - <<'PY'
import json
from pathlib import Path
folder = Path('data_foundation/runs/meeting-exploration')
objects = json.loads((folder / 's3-inventory.json').read_text())
manifest = [{'path': key.removeprefix('data/'), 'size': size}
            for key, size in objects if key.endswith('.csv')]
(folder / 'manifest.json').write_text(json.dumps(manifest, indent=2))
PY
```

This verifies object names/sizes, not S3 content checksums. Ingestion also detects files changing during the run and records a SHA-256 of the manifest. The inventory is a reproducibility artifact in ignored scratch storage, not a substitute for row-level quality checks.

## Execute and export

```sh
make test compile PYTHON=.venv/bin/python
.venv/bin/jupyter nbconvert --execute --to notebook \
  --ExecutePreprocessor.timeout=1800 \
  --ExecutePreprocessor.kernel_name=arabica-exploration \
  --output-dir=data_foundation/runs/meeting-exploration \
  --output=executed \
  notebooks/01_customer_service_workflow_exploration.ipynb
.venv/bin/jupyter nbconvert --to html \
  --output-dir=data_foundation/runs/meeting-exploration \
  data_foundation/runs/meeting-exploration/executed.ipynb
```

The notebook discovers the repository from the working directory or its parent. Set `ARABICA_REPO` explicitly when launching elsewhere. Optional parameters are `ARABICA_DATA_ROOT`, `ARABICA_MANIFEST_PATH`, `ARABICA_SCRATCH_ROOT`, and `ARABICA_RUN_LABEL`. Defaults are `data/`, the scratch manifest, ignored `data_foundation/runs/meeting-exploration/`, and `full`. Subset runs must use a separate data root and a matching subset manifest, and a visible non-full label. Never present a subset as the full dataset.

The notebook rebuilds `meeting.sqlite` tables and writes aggregate `results.json` in scratch. Allow several GB of disk for SQLite tables, indexes and disk-backed sorting. RAM is bounded by the ingestion batch (5,000 rows), SQLite page cache (32 MiB), and compact output tables. Full execution can take several minutes; table/file-batch progress is printed.

## Interpretation and checks

- The three business facts retain their own grains. Customers enrich only through unique keys; transcript relationships are checked separately.
- Blank IDs and **all occurrences** of duplicate IDs are excluded from primary metrics. Raw counts and ranking sensitivity stay visible.
- Boolean denominators contain only known valid values; missing/invalid values remain unknown. `was_resolved` is the dictionary's documented FCR flag, not independently verified repeat-contact resolution.
- Medians average central values; p95 uses nearest rank. Open complaints are excluded from observed resolution durations.
- Monetary inputs use integer minor units after Decimal parsing. Local totals stay grouped by currency; missing USD conversions are not imputed.
- `is_fraud` is a target label. Score provenance, label availability and pre-decision variable availability remain prerequisites for a predictive prevention baseline. Descriptive fraud rates are not model performance.
- Group tables retain at most 100 categories per dimension, figures at most 10. Overall totals are untruncated. Check dates for partial boundary months before interpreting trends.
- The focused regression fixture tests cross-file keys, BOM, atomic failure, input inventory, unknown denominators, open cases, currencies and ambiguous dimension matches. Notebook validation also includes a clean-kernel synthetic fixture, one-partition smoke and seven-partition controlled runs before a full run.

Review the saved HTML after execution for clipped labels, missing outputs and conclusions that need updating. The summary and meeting recommendation are dated interpretations of the reviewed run, not guaranteed to remain valid after changing the inputs. Keep only output-cleared notebook source in Git.

## Suspicious-charge intake baselines

`02_suspicious_charge_intake_baselines.ipynb` is the next evaluation stage. It runs two deterministic references on 42 authored ES/PT cases without reading raw bank records. See [the evaluation guide](../evals/intake/README.md) and [customer/KPI contract](../Docs/intake/customer-and-measurement-contract.md) for definitions, scenario provenance and limitations.
