# AGENTS.md

## Current data workflow

1. Identify the business question, analytical grain and relevant tables using `Docs/LATAM_BANK_DATA_DICTIONARY.md` and `Docs/LATAM_BANK_DATASET.md`. Check the observed Bronze/Silver schema before executing SQL; report discrepancies with the dictionary.
2. The production extraction path is `data_pipelines/bronze/` from the authorized S3 bucket. It stores local Parquet and `bronze.*` in an ignored DuckDB. `data_pipelines/silver/` builds typed `silver.dim_*` and `silver.fact_*` tables. Do not introduce another production S3 or CSV extractor for an analysis.
3. Run `data_pipelines/quality/` after Silver and inspect its aggregate results before reporting metrics. Missing tables, unexplained row changes and schema errors block readiness. Warnings such as orphan links remain visible and must be handled at the metric level.
4. Query only necessary Silver columns and filter on the business timestamp. `process_date` describes a storage/processing partition and may differ from the event date. Use it to prune source partitions, not as a substitute event date.
5. Record a metric's population, numerator, denominator, event-time range, grain, joins, exclusions and missingness. Do not silently clean source anomalies or claim causality from descriptive counts.

## Engineering rules

- Fact tables contain millions of rows. Before a large operation, state its memory model; use DuckDB projection, early filters, grouped SQL and disk spill rather than Python lists or sets of all fact keys. Keep dimensions or bounded batches in memory only when justified.
- Declare join cardinality. Aggregate facts to the target grain before joining facts; never use shared `customer_id` alone as a case-level relationship. For product-linked customer facts, verify that `products.customer_id` matches the fact's customer.
- Keep Bronze raw values, Silver transformations and analytical exclusions distinct. Silver deduplication must be reconciled to Bronze counts. FX-derived USD amounts retain their estimated flag; source-currency amounts cannot be summed as USD.
- Treat current customer consent, segment and product status as snapshots. Do not infer historical consent, product acquisition or bank loss from them.
- Use regression fixtures for schema, keys, partitions, joins, aggregations, and memory-sensitive changes. Progress through unit tests, controlled source files, a small Bronze/Silver build, then full S3 data. Long scans report table or file progress, not rows.
- S3 input is read-only. Keep credentials out of source, logs, image layers and commits. Generated DuckDB, Parquet, quality runs and temporary files stay ignored. Reviewed aggregate reports are committed only after reconciliation.
- Public functions and classes need concise docstrings explaining purpose and important invariants. Keep commits scoped and state the tests run.

## Interfaces

- `make setup`: install declared dependencies in ignored `.venv`.
- `make test`: offline Bronze, Silver and quality fixtures.
- `make pipeline`: S3 Bronze ingestion, Silver build and quality gate, in order.
- `make bronze-full`: deliberately rebuild source history when old partitions change.
- `make docker-test`: code-only test image; `make docker-pipeline` mounts data and the local AWS profile at runtime.

See `ARCHITECTURE.md`, `REPRODUCIBILITY.md` and `.github/skills/` for further procedures. `Docs/Plans/marketing-product-trust.md` records the deferred report rebuild; old HTML metrics are withdrawn until that gate passes.
