# Bronze S3 ingestion

`run_ingestion.py` is the production extractor for the 13 LATAM Bank tables. It reads organizer S3 CSV objects without modifying them and writes ignored local Parquet plus `bronze.*` in `data/latam_bank.duckdb`. Six flat dimensions refresh; seven partitioned facts load only process-date partitions newer than their stored watermark. Use `--full-refresh` when existing or removed partitions must be reconciled with the current S3 snapshot; that mode stages replacement Parquet before swapping the local store.

## Setup and commands

```bash
make setup
make bronze AWS_PROFILE=default
make bronze-full AWS_PROFILE=default
```

`S3_BUCKET`, `AWS_REGION`, `AWS_PROFILE`, `DATA_DIR`, `DUCKDB_PATH`, `DUCKDB_MEMORY_LIMIT` and `DUCKDB_THREADS` can be supplied as environment variables. The default Makefile bucket is the organizer's dataset. DuckDB creates a temporary S3 secret using the AWS credential chain; profiles and role credentials are resolved at runtime. Do not commit or print access keys.

Run a subset with `--tables customers,campaign_sends`. A required table with no source data, a read failure or a failed build produces a nonzero exit. A no-op incremental fact run preserves its previous Bronze table. A source correction in an old process partition requires `--full-refresh`; an ordinary incremental run intentionally will not revisit history.

`data/bronze/` stores Parquet and `data/duckdb_tmp/` stores temporary spill files. Both, the DuckDB file and generated quality reports are ignored. The quality gate is a separate step: `make silver && make quality`. An ingestion success alone does not certify analytical joins or data quality.

Offline regression fixtures are in `test_ingestion.py`. They cover first load, incremental and no-op runs, full refresh with corrected/removed partitions, dimensions, empty sources and table-name validation. Follow fixtures with a small S3 table before all tables.
