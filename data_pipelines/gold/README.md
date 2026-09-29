# Gold intake serving slice

`python -m data_pipelines.gold.run_intake_slice` turns a focused, quality-gated Bronze/Silver DuckDB into the only data the online intake service serves: a D1 SQL seed and a JSON manifest. Run it through `make intake-sample-slice` after the one-day sample targets.

What it enforces before writing anything:

- **Quality gate.** The focused quality run must be ready, error-free, taken on this exact database after its last change, and must include the business day's transactions watermark.
- **Grain and ownership.** Every Purchase/Approved row of the day has a unique `transaction_id`, a product and a customer, and the product belongs to the transaction's customer. One bad row stops the slice.
- **Scope.** Only dataset customers listed in `back-end/src/config/identities.json`, the same file the Worker's login uses, and at most `--max-rows` rows (1–100, default 20).
- **Source values.** The original Bronze amount string, which must be positive with at most two decimals and no exponent or spaces. A three-letter currency and a non-empty merchant. The timezone-free source timestamp is served in ISO form (`2026-02-26T13:21:51`), and the slice checks that it is exactly the Bronze string (`2026-02-26 13:21:51`), so no parsing can shift it.
- **One Bronze row per selected transaction.**

Output properties:

- **Idempotent seed.** A rerun changes nothing. If a stored row differs, the rerun sets a NOT NULL column to NULL and D1 rejects it, so drift is never silently overwritten.
- **Content-addressed.** `slice_version` is a hash of the SQL statements, so the same inputs give the same seed byte for byte.
- **No cases or sessions**, and no data outside the allowlist.
- **Versioned context cards.** The same quality-gated load snapshots first name, a Spanish locale hint, and active product type/last four/currency. `snapshot_at` is the quality-run time. Products come from the current `dim_products` snapshot, not the business day: Silver keeps no product-status history, so the card never claims what was active on the transaction date. A selected customer without a first name blocks the slice (the dictionary defines it as NOT NULL), and `last4` is null for product numbers shorter than four characters. The Worker reads one D1 row at session start and serves only the known card fields, with `version` and `snapshot_at` from their columns; a malformed stored card becomes `context_card: null`. A well-formed session language tag takes precedence over the hint. Transaction matching uses each transaction's currency.
- **Partition scope stated, not hidden.** Business-day filtering uses `transaction_date`. The storage partition (`process_date`) only says what was loaded. The manifest records `loaded_process_dates`, the rows in those partitions that belong to other business days (986 on 2026-02-26), and a completeness note: business-day rows stored in other partitions are not included.

The fictitious seed (`back-end/seeds/seed_fictitious.sql`) is generated from `back-end/seeds/fictitious.json` by `python -m data_pipelines.gold.fictitious_seed`, using the same statement builders. A test fails if the committed file differs from the generator.

Memory model: read-only DuckDB, 1 GB limit, 2 threads, disk spill under the database folder. Filters run in SQL, and at most `max_rows + 1` rows reach Python.

Tests: `pytest data_pipelines/gold`. They apply every seed to SQLite with the Worker's real migrations and try quality-gate bypasses, orphan and foreign rows, duplicate IDs, malformed amounts, hostile merchant names and drift.

Load into local D1 from `back-end/`: `npx wrangler d1 execute arabica-intake-demo --local --file <seed>`. Use `--remote` only after the manifest has been reviewed.
