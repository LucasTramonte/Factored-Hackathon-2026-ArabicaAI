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
