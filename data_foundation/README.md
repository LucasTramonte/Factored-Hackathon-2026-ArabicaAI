# Data foundation archive

The former standalone CSV scanner and pre-pipeline Marketing/Product modules were retired after a controlled input parity check. The active Bronze, Silver, and quality checks live in [`data_pipelines`](../data_pipelines/).

For an offline quality baseline over the supplied local CSVs, run `make setup` and `make pipeline-local`. This reads `data/` (or `SOURCE_DIR=/path/to/csv-root`), builds local Bronze and Silver in ignored `DATA_DIR`, and writes `data/quality_runs/<run-id>/quality_report.md`. After the Python dependencies are installed, the run requires no S3, AWS credentials, or network access. The initial build reads all local partitions; later local runs use a full refresh so corrected or removed partitions are reflected. Use `DUCKDB_PATH` and `DATA_DIR` to isolate this database from an existing S3-backed run.

The [report hub](reports/README.md) explains why earlier aggregate HTML/JSON artifacts were withdrawn. The [deferred rebuild plan](../Docs/Plans/marketing-product-trust.md) records the next analysis step.
