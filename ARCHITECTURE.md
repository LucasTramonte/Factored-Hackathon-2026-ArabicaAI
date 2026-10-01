# Data pipeline architecture

## Flow

```text
authorized S3 CSV objects (read only)
  -> data_pipelines/bronze: incremental fact partitions, refreshed dimensions
  -> ignored data/bronze Parquet + bronze.* in data/latam_bank.duckdb
  -> data_pipelines/silver: typed, deduplicated silver.dim_* and silver.fact_*
  -> data_pipelines/quality: raw/typed reconciliation and relationship warnings
  -> future Marketing/Product analyses after the deferred evidence gate
```

Bronze is the sole production extraction path. It records `_source_file`, `_ingested_at` and `_source_table`; a watermark tracks the latest process partition. Full refresh writes a staged Parquet snapshot before replacing old local partitions, so corrected or removed partitions do not survive by accident. Missing source data is a failed ingestion. Silver rebuilds from local Bronze, parses text booleans and dates, canonicalizes known country spellings, keeps source vs FX-estimated USD amounts distinct and defensively deduplicates by primary key.

## Analytical contract

`process_date` is the processing partition, while `send_date`, `event_date`, `transaction_date`, and similar fields describe occurrence. Silver facts retain the typed processing date where supplied. Query plans should project columns and filter early, then aggregate a fact to the target grain before joining another fact. Product-linked customer events need both an existing product and owner agreement; an existing `product_id` alone is insufficient. Current product and customer dimensions are snapshots, not historical state.

## Readiness and memory

The quality gate queries Bronze and Silver in DuckDB. It reports table/schema presence, raw and deduplicated row counts, required values, domains, processing partitions, date parseability, foreign-key orphans, and known owner/temporal mismatches. Errors block readiness; warnings remain visible for the subsequent metric-specific decision. Its JSON and Markdown reports are ignored under `data/quality_runs/`.

Python keeps only contracts and aggregate counters. DuckDB limits memory and uses ignored `data/duckdb_tmp` for external joins and grouping. Bronze and Silver share the ignored local database; S3 input is never modified. AWS credentials come from the runtime profile via DuckDB's credential chain and are not embedded in code or Docker images.

The previous CSV baseline was retired only after its check semantics were compared on the same controlled source snapshot; [the parity record](data_pipelines/quality/PARITY.md) also reconciles the full S3 Bronze run with the installed CSV inventory. The Marketing/Product HTML, intake decision page and aggregates were rebuilt from one verified Silver run and passed the gate in `Docs/Plans/marketing-product-trust.md` (release record); they are in `data_foundation/reports/`.

## Optional transcript-intent enrichment

`make pipeline-with-labels` adds an explicit offline step after quality. It reads two authorized, local SQLite caches of pinned Jev responses and transactionally publishes `enrichment.jev_predictions`, `enrichment.jev_members`, and the current-source view `enrichment.interaction_labels`. It does not invoke Jev or extract source data. The default pipeline remains unchanged.

The view preserves original categories and all interactions. Identity and exact-text hashes bind predictions to current Silver records; absent/new/changed text remains unclassified. `provisional` and `review_required` are model-derived triage statuses, never verified labels; human adjudication remains pending. Confidence is uncalibrated. Rebuild enrichment after a Silver refresh and query the view rather than historical cache tables directly.

DuckDB checks one-to-one interaction/transcript keys and cache membership coverage before publication; failure rolls back the import. Membership streams through a temporary CSV, while the historical 546 distinct-text responses fit in memory. This importer is intended for the bounded historical cache, not an unbounded live classification service. No historical exploratory module is required by the pipeline or Docker image.
