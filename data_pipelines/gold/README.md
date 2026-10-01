# Gold

## Gold serving tables (`build_gold.py`, in progress)

`make gold` (or `python -m data_pipelines.gold.run_gold`) builds Gold tables over the **whole population** into their own DuckDB file, `data/latam_bank_gold.duckdb`. Which rows reach D1 is decided later by a publish step, not by Gold. `build_gold.py` is the library; `run_gold.py` is the entry point:

```bash
python -m data_pipelines.gold.run_gold                          # build every Gold table
python -m data_pipelines.gold.run_gold --tables customers       # build a subset (comma-separated)
python -m data_pipelines.gold.run_gold --quality-report data/quality_runs/<run>/quality_results.json
python -m data_pipelines.gold.run_gold --silver-db <file> --gold-db <file>
python -m data_pipelines.gold.run_gold --list                   # list the Gold tables; build nothing
python -m data_pipelines.gold.run_gold --last                   # show the last committed build; build nothing
```

Paths default to `DUCKDB_PATH` and `GOLD_DUCKDB_PATH`, or otherwise to files under `DATA_DIR`. The exit code is 0 only when the gate and every check pass.

- **Gate.** The build needs a ready, error-free quality run of the same Silver file, taken after that file's last change. By default it uses the one under `data/quality_runs/` with the latest `generated_at_utc` (the report's own timestamp, not its folder name, so a hand-named folder such as `pr23-check` can't jump the queue).
- **Read-only Silver.** Silver is attached read-only as `lake`, so a Gold build never changes the Silver file and never invalidates its quality run. File names whose stem is `gold`, `silver` or `lake` are refused, because DuckDB would read `gold.x` as a catalog name rather than a schema.
- **Atomic.** Each run rebuilds its tables and their checks in one transaction. If any check fails, everything rolls back and the previous tables stay. Passed checks go to `gold.reconciliation`. The build itself goes to `gold.builds`: its Silver file, quality report, quality time and watermarks, so a later publish step can gate on the Gold build alone. Older Gold files gain the last two columns in place. `gold.table_builds` says which build each table currently comes from, since `--tables` rebuilds only some of them; `--last` prints it.
- **`row_hash`** covers every column written to D1, including `customers.country` (migration 0006) and the provenance row of each purchase, so a publish step can send only changed rows and miss none.

| Table | Grain | Columns | Checks |
|---|---|---|---|
| `gold.customers` | one row per `silver.dim_customers` customer (a current snapshot) | Written to D1: `customer_id`, `display_name` (first name and last initial, the same rule as the cohort's `_display_name`, which a test pins, whitespace included), `country`. Kept in Gold only: `segment`, `customer_status`, `row_hash` | count equals Silver; no duplicate or null IDs; no blank display name; country, segment and status present; no Silver customer missing |
| `gold.customer_complaints` | one row per (`customer_id`, `category`, `subcategory`) | `complaints`, `first_created_at`, `last_created_at` (business timestamps, every period). Not served | complaints and groups equal Silver; customer and category present; first not after last; customer in `gold.customers`; complaints without a subcategory kept as their own NULL group (reported) |
| `gold.card_purchases` | one row per Silver `Purchase`/`Approved` transaction | Written to D1: `transaction_id`, `customer_id`, `source_occurred_at` (the Bronze wall time in ISO form), `merchant_name`, `amount` (the Bronze string), `currency`, plus the provenance row's `product_id`, `source_file` and `business_date`. Kept in Gold only: `occurred_at` (the same wall time as a timestamp, for windows and ordering), `merchant_category`, `transaction_country`, `card_type`, `card_last4`, `row_hash` | count equals Silver; unique IDs; product exists and is owned by the buyer; product is a credit or debit card; buyer is in `gold.customers`; exactly one Bronze row; amount well formed, positive and equal to Silver (a malformed amount fails this check rather than the cast); wall time equal to Silver; currency well formed; missing merchants kept as NULL (reported) |
| `gold.context_cards` | one row per `gold.customers` customer | Served: `customer_id`, `card_version` (1), `snapshot_at` (the quality run's time), `card_json` (first name, locale hint, current active products with type, last four digits and currency). Kept in Gold only: `row_hash` (covers version and JSON, not `snapshot_at`) | count equals `gold.customers`; unique IDs; no customer without a card; valid JSON; non-blank first name; locale and product fields pass the Worker's own checks; active products on cards equal Silver's; customers with no active product reported |

`card_json` is byte-identical to `intake_agent.context_card.build_context_card` serialized as the seed does (`sort_keys`, compact, `ensure_ascii=False`), because D1's drift guard compares it as text. A test compares the two, and on 2026-10-01 a random sample of 3,000 real cards, plus the dataset customer already in D1, matched exactly. Products are today's active products (a snapshot, never what was active on a past date): 339,965 across all cards. 15,484 customers have none and get `"products": []`, which the Worker accepts.

`segment` and `customer_status` are not served (`country` is written to D1 for the sign-in list). A publish step uses all three, with `gold.customer_complaints`, to choose a scope, such as the dispute cohort or a single country. **Gold can already feed the cohort.** On the full build of 2026-10-01, recomputing the cohort's pool from Gold alone gave the same numbers as the `cohort.py` manifest (#33): 10,013 complainants, 179 currently closed, 9,834 eligible, 796 with at least 3 window purchases that have a merchant, and 2,906 purchases. The same 796 customers have identical display names and byte-identical cards. Moving `cohort.py` onto Gold is a separate change, to agree with its owner first.

`gold.card_purchases` checks ownership, card type and Bronze uniqueness rather than filtering on them, so an unexpected row fails the build instead of quietly disappearing. A missing merchant or category stays NULL and is never filled in (DF-006). The full build on 2026-10-01 had 996,168 rows, of which 49,810 had no merchant. D1's `transactions.merchant_name` is `NOT NULL`, so those rows can't be published until either the schema accepts a missing merchant (and shows the category instead), or the publish step excludes them and reports it in the manifest, as the cohort does. Building a table on its own (`--tables`) needs `gold.customers` from an earlier build. The default builds every table in one transaction.

Memory model: DuckDB SQL only, with a 2 GB limit, 4 threads and disk spill in `data/duckdb_tmp/`. Only check aggregates reach Python. Tests: `pytest data_pipelines/gold/test_build_gold.py`.

## One-day intake slice (`intake_slice.py`, current D1 seed)

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
