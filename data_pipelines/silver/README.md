# Silver typed tables

`run_silver.py` rebuilds typed `silver.dim_*` and `silver.fact_*` tables from the local `bronze.*` snapshot in the same ignored DuckDB. It does not access S3 or need AWS credentials. All 13 source tables have a typed target, including `silver.dim_fx_rates` for `daily_exchange_rates`.

```bash
make silver
.venv/bin/python data_pipelines/silver/run_silver.py --tables customers,products
make quality
```

The CLI filter uses unprefixed source names. The FX reference table is built first even for a filtered run. `DUCKDB_PATH`, `DATA_DIR`, `DUCKDB_MEMORY_LIMIT` and `DUCKDB_THREADS` control local execution. A failed table returns a nonzero exit; do not treat a partial build as an analysis snapshot.

`table_specs.py` defines exact columns and types. It preserves business and process dates, canonicalizes known country spellings, parses text booleans, turns null-like sentinels into NULL, and removes the literal `nan` product name embedded in some campaign subjects. `fact_transactions.amount_usd_is_estimated` distinguishes source USD amounts from exact-date FX fallbacks. Product snapshot conversions use the latest available rate and are not historical balances. Silver deduplicates by primary key using latest ingestion timestamp; the quality gate reconciles each raw-to-typed row delta and reports raw defects separately. Bronze primary-key duplicates are quality errors and block readiness by design, so this dedup is defense-in-depth for runs that are not ready.

The transformations do not repair incorrect customer/product ownership, establish historical consent, or make campaign conversion causal. `silver.fact_complaints` omits the fully empty `origin_interaction_id`; that relationship cannot be inferred from other shared identifiers. Use the quality report and a metric-specific validity check before joining tables for a report.

`customers.registration_branch_id` and `service_agents.assigned_branch_id` do not reliably resolve to `branches.branch_id`: 99.997% (149,995/150,000) and 99.76% (831/833) of their populated values respectively have no matching branch (367 of the 1,200 agents have no `assigned_branch_id`). Every other branch/agent reference in this schema resolves cleanly — `products.opening_branch_id`, `transactions.branch_id`, `complaints.related_branch_id`, and `complaints.assigned_agent_id` all show 0 orphans at full population. The orphaned values are correctly shaped (`SUC-XXXXXXXX`, same length and character set as real branch IDs) and are almost entirely distinct rather than a small repeating placeholder set, which rules out a Silver transform bug or a format/encoding mismatch and points instead to a source-data generation defect isolated to these two columns. Do not join on either column for a branch-level metric without confirming this has been addressed upstream; see `data_pipelines/quality/PARITY.md` for the underlying orphan counts and the quality gate's `foreign_key_orphans` check in `data_pipelines/quality/checks.py` for how they're computed.

Offline fixtures are in `test_silver.py`. They test table-specific typing, country canonicalization, FX rules, deduplication, sentinels and source columns. Full 15.6M-event build performance must be measured on the real local Bronze snapshot rather than assumed from fixtures.
