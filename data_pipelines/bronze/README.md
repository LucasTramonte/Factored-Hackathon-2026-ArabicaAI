# Bronze Ingestion Pipeline

Production version of `ingest_all_bronze.ipynb`. The core change: **fact tables are ingested
incrementally**, not re-read in full every run. The old notebook did `CREATE OR REPLACE TABLE ... AS
SELECT * FROM read_csv('.../year=*/month=*/day=*/*.csv')` on every execution — for `digital_events`
(15.6M+ rows and growing daily), that means re-downloading and re-parsing the entire table's history
from S3 every single run. That doesn't scale, and it's the main thing this rewrite fixes.

## What changed from the notebook

| | Notebook | This version |
|---|---|---|
| Execution | Interactive Jupyter cells | `python run_ingestion.py`, schedulable via cron/Airflow/Databricks Jobs |
| Fact tables | Full re-read every run | Incremental: only new `year=/month=/day=` partitions since the last run |
| Credentials | `SET s3_access_key_id=...` (session variable) | `CREATE SECRET` (DuckDB's secrets manager) |
| Errors | Printed and swallowed per-table | Logged, tracked, non-zero exit code if anything failed |
| Table list | Hardcoded in a cell | `config.py`, single source of truth |
| Testing | None | `pytest` suite against local fixtures, no S3 dependency |
| File paths | Relative to whatever directory the notebook's kernel started in | Anchored to the scripts' own location on disk (`PROJECT_ROOT`/`DATA_DIR` overridable) — see below |

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env   # then fill in your real credentials
```

## Folder layout & where files land

The scripts are meant to sit inside a project like this:

```
latam-bank-datathon/            <- project root
    data/                        <- local Bronze Parquet + latam_bank.duckdb (created automatically)
    data_pipelines/
        bronze/                  <- this package (config.py, db.py, ingestion.py, run_ingestion.py, ...)
```

Paths are resolved from **where these `.py` files live on disk**, not from whatever directory you
happen to launch `python` from. Concretely, `config.py` computes `project_root` as two levels above
itself (`bronze/` → `data_pipelines/` → project root), then derives:

- `data_dir` = `<project_root>/data`
- `duckdb_path` = `<data_dir>/latam_bank.duckdb`
- local Bronze Parquet = `<data_dir>/bronze/<table_name>/...`

This means `python run_ingestion.py` works the same whether you run it from the project root, from
inside `data_pipelines/bronze/`, or invoke it by absolute path from a scheduler — all three land on
the same `data/` folder. Every run logs the resolved `project_root` / `data_dir` / `duckdb_path` at
startup, so you can confirm it picked the right folder without guessing.

If your layout differs from the one above (e.g. the scripts live flat at the repo root, or you want
`data/` on a different disk), override with environment variables instead of editing paths in code:

```bash
PROJECT_ROOT=/path/to/latam-bank-datathon   # overrides the "two levels up" default
DATA_DIR=/path/to/somewhere/else            # overrides project_root/data specifically
DUCKDB_PATH=/path/to/somewhere/else.duckdb  # overrides just the .duckdb file location
```

## Running it

```bash
# Normal run -- incremental for fact tables, full refresh for dimensions
python run_ingestion.py

# Force a full re-read of every fact table's history (e.g. first run, or after a schema change)
python run_ingestion.py --full-refresh

# Just a subset, useful for debugging one table
python run_ingestion.py --tables transactions,customers

# More verbose logging
python run_ingestion.py --log-level DEBUG
```

Exit code is `0` only if every table succeeded. A scheduler should treat non-zero as a failed run.

## How incremental loading works

1. A `bronze._load_watermarks` table tracks the last-loaded date per fact table.
2. Each run calls `list_available_partition_dates()`, which uses DuckDB's `glob()` to list which
   `year=/month=/day=` partitions actually exist in S3 -- this only lists matching object keys, it
   never downloads or reads their contents, so it's cheap even for huge tables.
3. Only partitions newer than the watermark get read from S3 and appended to the local Parquet store
   (`COPY ... PARTITION_BY (year, month, day) ... OVERWRITE_OR_IGNORE`, which only touches the specific
   partition values present in the new data -- verified in `tests/test_ingestion.py` by deleting the
   old partitions' source files entirely and confirming an incremental run still produces the correct
   full-history row count).
4. The `bronze.<table>` table is rebuilt from the local Parquet files (cheap, local disk only -- no
   S3 traffic), so it always reflects full history regardless of how much is new.

Dimensions (`customers`, `products`, `branches`, `service_agents`, `marketing_campaigns`,
`daily_exchange_rates`) stay full-refresh — they're small (largest is 400K rows) and don't have a
partition structure to be incremental about.

## Known limitation, called out rather than silently assumed

`CREATE SECRET`, like the old `SET` approach, still requires credentials to be interpolated into SQL
text -- DuckDB's DDL statements don't accept bound (`?`) parameters (tested directly before writing
this, since assuming otherwise has bitten this project before). The credential-building statement in
`db.py` is isolated to one function and never logged, but this is a mitigation, not a claim that the
credentials never touch a SQL string.

## Testing

```bash
python -m pytest tests/ -v
```

Tests run against local files standing in for S3 (`read_csv`/`glob` behave identically on local paths),
so the full suite runs offline with no AWS credentials or network access required. Covers: dimension
full-refresh, fact first-load, incremental partition discovery, no-op reruns, `--full-refresh` behavior,
empty-source handling, and SQL-injection-shaped table names being rejected.

## What's still worth adding before a real production deployment

- **Alerting**: a non-zero exit code is enough for a scheduler to detect failure, but nothing here
  pages anyone -- wire the exit code into whatever alerting your scheduler supports.
- **Row-count sanity checks**: this pipeline logs counts but doesn't fail the run if a table's count
  drops unexpectedly or comes back as zero when it shouldn't. Worth adding a check against the previous
  run's count (stored alongside the watermark) once you have a few runs of history to compare against.
- **Data-quality gate before Silver**: this only covers Bronze (raw ingest). Silver-layer dedup/typing
  should run as a separate, later stage that can fail independently of ingestion succeeding.
