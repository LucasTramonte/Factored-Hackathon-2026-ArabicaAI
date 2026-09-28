# Reproducing the data foundation

## Prerequisites

Python 3.10+, GNU Make, enough local disk for the ignored DuckDB/Parquet store, and read-only access to the organizer's S3 bucket. The repository does not contain data or credentials. The default bucket and region are in `Makefile`; override `S3_BUCKET`, `AWS_REGION`, `AWS_PROFILE` or `DATA_DIR` as needed. A usable AWS profile can be checked without displaying keys with `aws s3 ls s3://<bucket>/data/ --profile <profile>`.

## Local pipeline

```bash
make setup
make test
make compile
make pipeline AWS_PROFILE=default
```

`make pipeline` runs Bronze, Silver, then the DuckDB quality gate in that order. Bronze reads S3 through DuckDB's AWS credential chain; it does not need keys in `.env`. Facts add new process-date partitions; dimensions refresh on each run. Use `make bronze-full` only when a source partition was corrected or removed, then rebuild Silver and rerun quality. The database and Parquet files stay under ignored `data/`; `data/quality_runs/<UTC run ID>/` contains aggregate results and a Markdown summary.

Do not read an analysis from Silver until the quality command exits successfully. Warnings still require metric-specific treatment; a successful quality run does not validate campaign attribution or customer/product ownership as a usable analytical link.

For targeted debugging, call the existing entrypoints with `--tables`, for example:

```bash
.venv/bin/python data_pipelines/bronze/run_ingestion.py --tables customers,marketing_campaigns
.venv/bin/python data_pipelines/silver/run_silver.py --tables customers,marketing_campaigns
.venv/bin/python -m data_pipelines.quality.run_quality --tables customers,marketing_campaigns
```

The Silver command always refreshes its small FX reference table. Bronze defaults to a 2 GB DuckDB limit and four threads; Silver defaults to 3 GB and two threads. Both honor `DUCKDB_MEMORY_LIMIT` and `DUCKDB_THREADS`; the quality gate defaults to 3 GB and two threads. Ignored `data/duckdb_tmp` holds spill files. Override the limits only after measuring memory and runtime.

## Docker and CI

`make docker-test` builds a code-only image and runs the offline fixtures. `make docker-pipeline` builds the same image, mounts `data/` writable and `~/.aws` read-only at runtime, then executes Bronze, Silver and quality. No data or credentials enter an image layer. CI installs the declared requirements, runs the same fixture suite and builds the test image; it does not require S3 credentials or run the full dataset.

## Rebuilding reports

The old HTML and aggregates were withdrawn. `Docs/Plans/marketing-product-trust.md` records the customer-backwards analysis and report gate. New aggregate artifacts can be committed only after a single full Silver run, numerator/denominator reconciliation, privacy check and local HTML inspection.

## Optional cached Jev labels

This step imports historical model predictions, not human-verified corrections. Obtain the two frozen SQLite caches from their custodian through an authorized private team channel; the repository does not distribute transcripts or responses. Keep them outside Git. No API key is needed and no missing prediction is automatically requested.

Historical file SHA-256 checksums (verify with `shasum -a 256` after transfer):

| Cache | SHA-256 |
|---|---|
| First-pass `audit.sqlite` | `22dab32f44802bba1fb240204d3cbd035bb47666eaef6e39bdc1bb713bfa8f2f` |
| Second-pass `second-pass.sqlite` | `0aeb4a4dcdb13795df0fd337339d3cad5bb4ccccf53ed84ed8db250fb1fbd3a8` |

After building Silver, run:

```bash
make transcript-labels \
  JEV_FIRST_CACHE=/private/path/audit.sqlite \
  JEV_SECOND_CACHE=/private/path/second-pass.sqlite
```

This target runs the contact-center/transcript quality checks before importing. `make pipeline-with-labels` runs the full existing pipeline first. Both cache paths can also be supplied to `python -m data_pipelines.transcript_labels` using `--first` and `--second`; direct CLI use assumes a successful quality gate on the current Silver snapshot. Missing caches fail explicitly. Defaults point to the historical local `data_foundation/runs/` locations only for convenience; no code from that directory is imported.

Query `enrichment.interaction_labels` for original category, provisional transcript intent/category, confidence, model/configuration hashes, review status and pending human adjudication. On the reconciled historical snapshot: 132,668 provisional + 38,653 review_required + 514,975 no_transcript = 686,296 interactions. The 171,321 transcript-bearing records share only 546 distinct full texts; these counts describe that supplied corpus, not true customer demand or classification accuracy. New/changed text receives no current prediction and requires a separately authorized inference process if needed. Source labels are never overwritten.

Run `make test`, `make compile`, and `make docker-test` for offline fixtures, including malformed/stale caches, key uniqueness, rollback and missing transcripts. The code-only image needs neither cache files nor credentials for tests. Human adjudication and broader ES/PT evaluation remain separate prerequisites for any accuracy claim or production routing use.
