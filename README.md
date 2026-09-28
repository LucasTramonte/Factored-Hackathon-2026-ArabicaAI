# LATAM Bank data foundation

This repository supports the Factored Hackathon 2026 with a synthetic LATAM banking dataset. The current deliverable is a reproducible, read-only data pipeline and a quality audit for future Marketing and Product analysis. The earlier HTML reports were withdrawn while their metrics are revalidated.

## Start here

For local runs, you need Python 3.10+ and GNU Make. For container runs, you need Docker and GNU Make; Python is installed in the image. Both paths need several GB of free disk space and access to the organizer's S3 bucket through an AWS profile. The repository contains no raw data or credentials. Use an AWS profile or temporary role credentials; **do not add access keys to a repository `.env` file**.

From the repository root:

```bash
make setup       # create .venv and install pipeline dependencies
make test        # run offline fixtures; no S3 access needed
make pipeline AWS_PROFILE=default
```

To run entirely in Docker, use the same profile without creating a local virtual environment:

```bash
make docker-test
make docker-pipeline AWS_PROFILE=default
```

Both Docker targets build the image before running it. `docker-pipeline` mounts `data/` writable and your `~/.aws` directory read-only at runtime; credentials are never copied into the image.

`make pipeline` runs **Bronze → Silver → quality**. On a fresh checkout, Bronze loads all available source partitions; later runs ingest only newer fact partitions and refresh the small dimensions. The bucket and region defaults are in the [Makefile](Makefile). Use `AWS_PROFILE=your-profile` if your credentials are under another profile.

Before a full run, you can check read access without printing credentials:

```bash
aws s3 ls s3://factored-datathon-2026-s3-157725502942-us-east-2-an/data/ --profile default
```

The source CSVs are never modified. DuckDB, Parquet, temporary files, and audit runs stay under ignored `data/`. A successful pipeline run creates `data/latam_bank.duckdb` with `bronze.*` source tables and typed `silver.dim_*` / `silver.fact_*` tables. Read the latest `data/quality_runs/<run-id>/quality_report.md` for the readiness result and `quality_results.json` for every numerator and denominator.

A zero-error quality run means the tables are structurally ready to query. It does **not** validate campaign attribution or every customer-to-product link. Review the warnings and the [full parity record](data_pipelines/quality/PARITY.md) before using a relationship in a metric.

## Common commands

| Command | Purpose |
|---|---|
| `make test` | Run Bronze, Silver, and quality fixtures without S3. |
| `make bronze` | Refresh dimensions and ingest newer fact partitions. |
| `make bronze-full` | Rebuild Bronze when an older source partition was corrected or removed; follow with `make silver` and `make quality`. |
| `make silver` | Rebuild typed analytical tables from local Bronze. |
| `make quality` | Check all 13 Bronze/Silver table pairs and their relationships. |
| `make docker-test` | Run offline tests in the code-only container. |
| `make docker-pipeline` | Run the pipeline with local `data/` and `~/.aws` mounted at runtime. |

Docker reuses cached build layers on later runs. For a smaller first S3 check, follow the targeted commands in [REPRODUCIBILITY.md](REPRODUCIBILITY.md). CI runs offline tests and a Docker build; it does not need S3 credentials.

## Where to look next

- [Data dictionary](Docs/LATAM_BANK_DATA_DICTIONARY.md): exact table, column, and relationship names.
- [Dataset overview](Docs/LATAM_BANK_DATASET.md) and [hackathon brief](Docs/FACTORED_HACKATHON_2026.md): source scope and challenge context.
- [Architecture](ARCHITECTURE.md) and [reproduction guide](REPRODUCIBILITY.md): pipeline behavior, memory limits, Docker, and troubleshooting commands.
- [Quality parity record](data_pipelines/quality/PARITY.md): the 13-table audit, observed warnings, and comparison with the former CSV scanner.
- [Marketing/Product rebuild plan](Docs/Plans/marketing-product-trust.md) and [report hub](data_foundation/reports/README.md): why the old reports are unavailable and what evidence is needed before publishing new HTML.

The dataset is synthetic. Descriptive counts from it should not be presented as measured bank outcomes or causal effects.
