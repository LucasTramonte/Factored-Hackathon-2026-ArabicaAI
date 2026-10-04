# Data engineering: from the organizers' S3 files to the rows the service shows

How the supplied LATAM Bank data becomes the few rows the online service may show, how each step is checked and traced, what the data can and can't support, and how to rebuild it. Every figure comes from a recorded run, a findings query or a test named here.

The brief asks for "repeatable data preparation with contracts, quality checks, lineage, and an update/freshness policy", in batch, incremental or streaming mode "according to the supplied inputs and the workflow's latency and freshness needs", and, for static data, update correctness shown "with a clearly labeled test fixture".

| The brief asks for | Where |
|---|---|
| Repeatable preparation | [1. The pipeline](#1-the-pipeline), [11. Reproducing it](#11-reproducing-it) |
| Contracts, quality checks, lineage | [2. Contracts](#2-contracts), [3. The quality gate](#3-the-quality-gate), [4. Lineage](#4-lineage) |
| Update/freshness policy and its correctness | [5. Update and freshness policy](#5-update-and-freshness-policy), [6. Update correctness](#6-update-correctness) |
| Batch vs. streaming, and the stack | [7. Stack and trade-offs](#7-stack-and-trade-offs) |
| "If we give you data tomorrow, what works?" | [8. If new data arrives tomorrow](#8-if-new-data-arrives-tomorrow) |
| What the data can't support | [9. Currency and time: served as provided](#9-currency-and-time-served-as-provided), [10. Findings register](#10-findings-register) |
| Known limits | [Limitations and how we handle them](#limitations-and-how-we-handle-them) |

## 1. The pipeline

```
S3 (organizers, read-only) ─▶ Bronze (raw Parquet) ─▶ Silver (typed tables) ─▶ quality gate ─▶ Gold (reviewed seed) ─▶ D1 (online)
```

**Bronze** (`data_pipelines/bronze/`) copies the 13 source tables as raw text. The six dimensions are rebuilt every run; the seven facts are partitioned by day (`year=/month=/day=`) and loaded incrementally against a per-table watermark in `bronze._load_watermarks`. Every row gets `_source_file`, `_ingested_at` and `_source_table`. The code only lists and reads S3.

**Silver** (`data_pipelines/silver/`) types each table from its spec in `table_specs.py`, keeps one row per primary key (the latest delivery), canonicalizes country names and converts amounts to USD at the exact-date FX rate. A fallback conversion is flagged `amount_usd_is_estimated` and never summed as real USD. Silver is always rebuilt in full, which takes seconds from local Parquet.

**The quality gate** (`data_pipelines/quality/`) runs read-only over Bronze and Silver and writes `quality_results.json` with the watermarks it checked.

**Gold** (`data_pipelines/gold/`) cuts the serving data, either the one-day slice or the cohort of customers who disputed a charge (796 customers and 2,906 purchases as of 2026-06-17, [ADR-004 §2](../ADRs/ADR-004-intake-capacity-and-cost.md)), as an idempotent SQL seed plus a manifest. **D1** receives the reviewed seed. The Worker never reads S3, DuckDB or Silver ([ADR-003](../ADRs/ADR-003-intake-single-runtime-worker-d1.md)).

Measured on the full data on one laptop (reconciliation in `PARITY.md` on 2026-09-27, full build in ADR-004 on 2026-09-29):

| What | Value |
|---|---|
| Source | 13 tables, 7,671 CSV files, 23,495,188 rows |
| Bronze | 7,699 Parquet files, 1.4 GB |
| Silver | 2.86 GB in DuckDB, 23.5 M rows; all 13 row counts equal Bronze, 0 duplicate keys |
| Full build, Bronze → Silver → quality | 11 min 15 s, DuckDB capped at 2–3 GB and 2–4 threads |
| Quality run | 163 s, peak memory 5.7 GB |
| Largest Bronze table | `digital_events`, 1,097 partitions in 1,220 s at a 2 GB limit |

Python never holds fact rows. Every scan is grouped SQL in DuckDB, filtered early and spilled to disk. Tables load one at a time, and a failing table fails the run without stopping the others ([`SYSTEM_DESIGN.md`](SYSTEM_DESIGN.md)).

## 2. Contracts

Each contract is enforced in code where data crosses a boundary.

| Boundary | Contract | Enforced by |
|---|---|---|
| S3 → Bronze | Expected tables, `year=/month=/day=` paths, path date matching `process_date` | `table_discovery`, `partition_source_missing`, `partition_date_mismatch` (errors) |
| Bronze → Silver | Column names, types, primary keys and required fields per table (`ALL_SPECS`) | `silver_schema_missing_columns`, `duplicate_primary_keys`, `silver_required_nulls`, `silver_row_delta_unexplained` (errors), Silver unit tests |
| Silver → Gold | Ownership (`products.customer_id = transactions.customer_id`), one Bronze source row per served transaction, amount, currency and timestamp formats | `validate_sample` and `_validated` fail the build |
| Gold → D1 | Idempotent upserts that fail on drift; NOT NULL, CHECK and foreign keys | a seed sets a NOT NULL column to NULL if a stored value differs, so D1 rejects it |
| D1 → client | Every API response body | `front-end/contracts/intake-api.schema.json`, checked in every integration test |

The DBML model in `data_profiles/silver_data_model/` is documentation only; `table_specs.py` is the enforced contract.

## 3. The quality gate

On the full data the latest gate run (`20261002T232200Z`, re-run in the 2026-10-03 review) made 390 aggregate checks: 0 errors, 7 warnings ([new-data rehearsal](../Evidence/new-data-rehearsal.md)).

Errors block readiness: missing tables or columns, duplicate or missing keys, unexplained Bronze-to-Silver row changes, unparseable dates, missing foreign-key parents, a partition that doesn't match its date. Gold refuses to build unless its quality run is ready, is for the same DuckDB file, postdates that file's last change, and checked the watermark Gold serves (`check_quality_gate`).

Warnings stay visible and are handled where a metric uses the data: orphan links, late-arrival signals, owner mismatches, domain violations. The detailed results of `20261002T232200Z` aren't kept in the repository; a full local run with the same check set (`pr23-check`, 391 checks) lists seven warnings, all source limitations: customer registration-branch orphans (149,995 of 150,000), agent branch orphans (831 of 1,200), duplicate values in unique fields of `products` (6 of 400,000) and `service_agents` (13 of 1,200), complaint products owned by another customer (44,570 of 44,570, DF-002), digital events whose product belongs to another customer (1,094,226 of 1,094,242), and transactions dated before their product opened (827,610 of 4,425,008). The [findings register](#10-findings-register) and [`PARITY.md`](../../data_pipelines/quality/PARITY.md) explain their handling. All 181 check numerators shared with the former CSV scanner match it. A passing run doesn't make campaign attribution or customer/product ownership a usable analytical link.

## 4. Lineage

| Layer | What records where a row came from |
|---|---|
| Bronze | `_source_file` (the S3 object path), `_ingested_at`, `_source_table`, partition columns |
| Silver | `process_date`, the storage partition |
| Quality | Run id, watermarks checked, database path and size |
| Gold manifest | `slice_version`, the quality run it passed, `source_file` per served transaction (Bronze is re-joined, so the amount is the original string) |
| D1 | `sample_provenance(transaction_id, product_id, source_file, business_date, mapping)` per dataset transaction; `seed_loads(version, loaded_at)` per seed part |

Silver doesn't carry `_source_file`, so Gold re-joins Bronze for it. We'll carry it forward if a second consumer needs per-row lineage.

## 5. Update and freshness policy

The source is a static snapshot (dataset version 1.0.0, generated July 2026): 1,097 daily partitions from 2023-06-17 to 2026-06-17, reconciled on 2026-09-27 and rebuilt in full on 2026-09-29. The submission is frozen on it; a later delivery becomes a new versioned build, never a silent patch. For a live feed, the pipeline does this, and section 6 tests every row:

| Delivery | What the pipeline does | Why |
|---|---|---|
| A new day | Incremental run loads it and moves the watermark | One S3 read per month with new days |
| A late day (older than the watermark, never delivered) | Loaded next run, logged and printed as a late partition; the watermark doesn't move back | A late arrival is new data. The old code skipped it silently |
| A corrected or removed day already in Bronze | Never reread incrementally. `make bronze-full` re-reads history and swaps it in atomically | A correction should be deliberate and reviewed |
| A row re-delivered with the same key | Bronze keeps both; the gate's `duplicate_primary_keys_across_partitions` error blocks Gold until resolved. Silver keeps the latest partition's copy, ties broken on `process_date` | A duplicate key is a source defect a person must see |
| A partition that isn't a date (`day=32`, `day=xx`) | Incremental runs skip it with a warning; a full refresh refuses the source and exits 1 | Otherwise it would store partition values later runs can't parse |
| Dimensions | Rebuilt every run | Small flat exports |

Bronze and Silver are as fresh as the last run; in production one batch would run a day after each partition lands, on EventBridge and Fargate in the AWS target, designed but not deployed ([ADR-004 §3](../ADRs/ADR-004-intake-capacity-and-cost.md)). Gold and D1 change only through a reviewed seed with a new version, so the service shows data as of the manifest's `as_of` (2026-06-17 for the cohort), and `seed_loads` says which. `process_date` only prunes reads; business filters use the event timestamp, because early-hour events are filed under the previous day (DF-004). Demo activity is deleted after 2026-10-20 ([ADR-004 §7](../ADRs/ADR-004-intake-capacity-and-cost.md)). The batch operator watches for a non-zero exit and `late_partitions` warnings; the data owner approves every `bronze-full` and every new `as_of`.

## 6. Update correctness

`data_pipelines/test_update_correctness.py` is the labelled fixture. Its data is synthetic, generated by the team, and it drives the real Bronze ingestion and Silver build over local S3-shaped partitions.

| Test | Proves |
|---|---|
| `test_a_new_day_is_appended_and_the_watermark_advances` | A new day loads and moves the watermark |
| `test_a_late_old_day_is_loaded_and_counted_without_moving_the_watermark_back` | A late day is loaded, counted and not reloaded |
| `test_a_row_redelivered_later_with_new_content_replaces_the_old_copy_in_silver` | Silver keeps the latest copy, even when both were ingested together |
| `test_a_corrected_old_partition_needs_a_full_refresh` | Incremental runs don't revisit history; a full refresh does |
| `test_a_late_day_never_rereads_the_days_already_held_in_its_month` | A late day leaves its month's held days untouched |
| `test_a_new_day_never_rereads_earlier_days_of_the_current_month` | The same for the current month |

Crash recovery, atomic swaps and idempotent reruns are covered in `data_pipelines/bronze/test_ingestion.py`, and Gold reruns and drift rejection in `data_pipelines/gold/test_*.py`.

The fixture found three defects, each fixed test-first. Late days were dropped silently. Incremental runs used a `day=*` glob and so reread and overwrote held days in any month they touched, letting a correction in unreviewed. And an original and its re-delivery could share one `_ingested_at`, so Silver could keep the stale copy; facts now tie-break on `process_date`. None affects the current snapshot, which has no gaps or duplicate keys.

## 7. Stack and trade-offs

Batch fits: the source arrives as daily files, the service reads a reviewed seed, and a purchase list doesn't need minute-level freshness. The brief itself says incremental files "do not by itself require streaming".

| Concern | Choice | Instead of | Why, at this size | What would change it |
|---|---|---|---|---|
| Engine | DuckDB, one process | Spark (EMR, Glue), Athena, Snowflake/BigQuery | 2.86 GB builds in 11 minutes and would run on Fargate for $0.60 a month; Glue's minimum is about $6.60, and Spark is a rewrite | Over ~100 GB, builds over 1 hour, or concurrent jobs (ADR-004 §1) |
| Storage | Hive-partitioned Parquet plus a DuckDB file | Iceberg, Delta Lake | One writer and full Silver rebuilds | Several writers or row-level corrections |
| Transformations | Typed Python specs generating SQL | dbt | 13 tables, one transformation each | Over about 30 models, or analysts maintaining SQL |
| Orchestration | Make targets, a CLI, CI | EventBridge + Fargate; Airflow, Dagster, Prefect | No live feed to schedule | A daily feed: EventBridge and one Fargate task first |
| Quality | Own aggregate checks and a gate before Gold | Great Expectations, Soda | SQL over our specs, parity proven | Several teams writing checks |
| Lineage | Columns and manifests carried to D1 | OpenLineage with Marquez | One pipeline | Several pipelines needing an impact graph |
| Change detection | Watermark plus late-day detection | S3 Inventory or ETag manifest | No extra service | Corrections under the same file name |

## 8. If new data arrives tomorrow

The organizers confirmed new data would come in the snapshot's pattern: daily `year=/month=/day=` partitions under the same S3 prefixes. The path needs the same 13 tables (a mismatched path date stops the run with `partition_date_mismatch`, a missing column with `schema_missing_columns`), a passing quality run on the same DuckDB file (`check_quality_gate` in `data_pipelines/gold/intake_slice.py`), disputing customers with at least 3 approved purchases with a merchant in the 120 days before the cut-off (DF-021), and room in D1's write quota: a full cohort load writes about 20,620 rows against 100,000 a day on the free plan ([ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md)). A person runs the batch and the data owner approves the new `as_of` and the remote load, with Python 3.10+, Node 22+, the read-only AWS profile and Wrangler signed in.

| Step | Command | Who | Time | What happens |
|---|---|---|---|---|
| 1. Bronze | `make bronze` | Manual today; a daily job in production | Incremental Docker run 660 s ([`PARITY.md`](../../data_pipelines/quality/PARITY.md)); one new day not timed | Loads new and late days, refreshes dimensions |
| 2. Silver | `make silver` | After Bronze | Inside the 11-minute full build | Rebuilds typed tables |
| 3. Quality | `make quality` | After Silver; non-zero exit stops | Inside the full build | Any error blocks Gold |
| 4. Gold and cohort | `make intake-cohort-slice COHORT_AS_OF=<new watermark>` (`COHORT_DB`, `COHORT_QUALITY` override the inputs) | Manual, data owner approves | Gold about 10 s; selection not timed | Gold gated on the quality run; versioned seed parts and a manifest with expected writes |
| 5. D1 load | `python -m data_pipelines.gold.run_cohort load --part N --target remote` | Manual, at most one part per UTC day | Not timed | Skips parts already in `seed_loads`; fails if D1 wrote more rows than estimated |
| 6. Demo | none | Automatic | Immediate | New customers in the picker, each with their newest 20 charges |

**Where it stops today.** These limits were checked against the code, and the third reproduced in SQLite, which D1 runs on. Build/gate failures (including stop 1) and manifest validation failures occur before any D1 write and leave serving unchanged; stop 2 is a membership limit, not an error. A remote part is applied statement by statement, not atomically: a failure during the part (including stop 3) can leave earlier statements applied and a partially updated cohort served despite no `seed_loads` record. The serving queries do not check that record. Write-count checks also run after the part is applied, so their failure does not roll back writes (`run_cohort.py`).

**Recovery for a remote-load failure.** Before an approved load, the operator must preserve a restorable pre-load D1 backup. On failure, pause cohort serving and inspect the applied rows and write counts against the reviewed manifest. After a transient failure, retry the exact same part only when its stored values still match and quota permits: identical upserts are idempotent. A drift failure (changed `snapshot_at`, card or transaction values) will fail again on retry; restore the pre-load backup, or use a separately reviewed replacement procedure that handles conflicting and removed seed rows. The replacement path is not implemented today. Reconcile any activity written since the backup before restoring, then verify the cohort against the intended manifest and its load records before resuming serving. Do not insert a `seed_loads` record merely to hide a failed load.

1. The cohort needs the new date passed by hand. `COHORT_AS_OF ?= 2026-06-17`, and the gate requires every Gold table to come from one quality run whose transactions watermark equals `as_of`. A default run stops with "gold.customers was built from transactions loaded to <new date>, not as_of 2026-06-17".
2. New disputes don't enter the cohort. Membership is fixed to complaints before 2026-01-01 (`DESIGN_END` in `data_pipelines/gold/cohort.py`) to keep the design window clean (ADR-005); new data only moves existing members' 120-day purchase window.
3. Reloading over the current D1 fails. Every context card carries the quality run's timestamp as `snapshot_at`, and upserts reject any stored value that differs, so a rebuilt cohort fails on its first loaded customer with `NOT NULL constraint failed: context_cards.card_json`. Corrected amounts fail the same way, and no seed deletes rows that left the cohort.

The [new-data rehearsal](../Evidence/new-data-rehearsal.md) of 2026-10-02 ran the path from S3 to a customer's charges on a copy in 158 seconds and reproduced stops 1 and 3. The follow-up takes `as_of` from the quality run, lets membership move with new complaints while the evaluation window stays fixed, adds a reviewed replace path and a delete for seed rows, and records a rehearsal on a labelled fixture. Until then the demo serves the snapshot as of 2026-06-17.

On schema changes, which the organizers agreed are a next step: a missing or renamed column stops the build at the gate. An added column never reaches Silver, since each spec selects its columns; whether Bronze's append accepts one is untested. The next step is an additive Bronze contract that reports new columns, versioned Silver specs, and fixtures for an added and a renamed column.

## 9. Currency and time: served as provided

The source doesn't settle the currency of an amount or the time zone of a timestamp. The organizers asked us to treat the data as provided, document it and handle the uncertainty safely, and called currency a key point.

Currency ([DF-023](#df-023-amounts-share-one-usd-scale-and-claimed-currencies-ignore-the-customers-country), [DF-005](#df-005-mexican-customers-transact-only-in-usd)): amounts sit on one USD scale, Mexican customers transact only in USD, and complaint currencies look random. Gold keeps the Bronze amount and currency code as delivered and the service shows both on every row. Nothing converts or sums across currencies; `amount_usd` keeps its estimated flag and isn't served. A Mexican customer saying "pesos" matches none of their charges, but today they pick the charge from their own list, so the word can't select the wrong one. Once free text is read online, the reply will state the card's currency and ask them to confirm (planned).

Time ([DF-020](#df-020-one-clock-for-every-country-no-daily-rhythm), [DF-004](#df-004-processing-partition-precedes-the-event-date-for-early-hour-events)): timestamps carry no zone and every country shares one clock. The service shows the stored time labelled "source time zone not provided" and claims no local-time precision. Row counts that differ from the dictionary are in [DF-026](#df-026-the-dictionarys-row-counts-are-approximate); the supplied data is the source of truth.

## 10. Findings register

What the supplied dataset can and can't support, where it changes, limits or backs a decision. Each finding names its query in [`data_profiles/findings/queries/`](../../data_profiles/findings/queries/), run by `make findings` on the full Silver build (quality run `20260929T113804Z`, ready, 0 errors) on 2026-09-29; DF-016 to DF-018 from findings run `20260930T033230Z`, DF-019 from `20260930T192858Z`, and later findings name their run. Results are aggregates. The dataset is synthetic (dataset summary, p. 5), so "unrealistic" means unlike a real bank, not wrong in the file. We identify a limitation, document it here, and handle it in the product: values served as provided, uncertainty labelled, anything unverifiable fails closed.

Scope follows [ADR-005](../ADRs/ADR-005-evaluation-data-protocol.md): `design` queries see only business timestamps before 2026-01-01 and may inform prompts, fixtures, thresholds and learned components; `full` queries check structure over every row and fit nothing. Holdout rows (2026-01-01 → 2026-06-18) are never used for design. Severity High changes a metric or product decision, Medium limits a claim, Low is informational.

### DF-001 Source text fields are fixed templates

*`DF-001_text_templates.sql` · full · High · accepted limitation.* `fact_complaints.description` has 5 distinct values in 67,095 rows, one per subcategory; `fact_call_transcripts.customer_text` has 42 in 171,321 rows, all `es`, each shared by several of the 6 contact reasons. Complaint text is its own label, so no model is trained on source text and dispute phrasing is authored: the intake evaluation uses a blind, frozen ES/PT set (ADR-005), Portuguese synthetic throughout. See the [bronze profile](../../data_profiles/bronze_data_profile/bronze_profile.md).

### DF-002 Complaint product links point to other customers

*`DF-002_product_owner_links.sql` · full · High · handled at metric level.* All 44,570 complaints with an `affected_product_id` cite another customer's product (22,525 cite none), while 4,425,008 of 4,425,008 transaction product links match their owner. Digital events show the same pattern (1,094,226 of 1,094,242). Any complaint-to-product join mixes customers, so it is suppressed and reported as `product_owner_mismatch` every build. The source draws the product at random: cited product types match the full table within a point, digital events match their owner 16 times in 1,094,242, and 8,351 cited products (18.7%) opened after the complaint ([follow-up](../../data_profiles/data_deep_dive/reports/complaints_product_owner_mismatch_followup.md)).

### DF-003 Claimed amounts are not linked to transactions

*`DF-003_claimed_amount.sql` · full · High · accepted limitation.* Of 12,297 `Cargo no reconocido` complaints, 4,090 have a `claimed_amount` (183 without currency), from 55.06 to 4,999.90, including 989 in MXN, which no transaction uses. None equals a same-customer, same-currency transaction in the prior 180 days, and `origin_interaction_id` is 100% null in Bronze (dropped in Silver). We can't tell which charge was disputed or when, nor size losses; the evaluation's 45-day lookback is an assumption (ADR-001, ADR-002).

### DF-004 Processing partition precedes the event date for early-hour events

*`DF-004_partition_offset.sql` · design · Medium · open.* 933,847 of 3,738,506 design-window transactions (25%) sit in the previous day's partition, all with event hours 00–06; for complaints 19,054 of 56,736 (34%), hours 00–08. One clock is shifted, about 6 hours for transactions and 8 for complaints, and the data doesn't say which. Filters and splits use the business timestamp (AGENTS.md, ADR-005), and the service shows zone-free wall time. Open: check Bronze files and the source partition layout for the cause.

### DF-005 Mexican customers transact only in USD

*`DF-005_currency_by_country.sql` · design · Medium · accepted limitation.* 100% of Mexican customers' approved design-window purchases are in USD, and no MXN transaction or product exists. Colombia is 89.9% COP and 10.1% USD, Argentina 90.0% ARS and 10.0% USD; purchase currency always equals the card's. MXN complaint amounts prove nothing, since claimed currencies ignore the customer's country (DF-023). Fixtures mirror it.

### DF-006 Closed merchant list with one category each

*`DF-006_merchants.sql` · design · Low · accepted limitation.* 24 merchant names, one category each, all present in the 6 purchase countries; 5.0% of purchases lack a merchant but keep a category. Matching is exact over a closed list, and a missing merchant is shown as missing with its category.

### DF-007 Amounts always carry cents

*`DF-007_amounts.sql` · design · Low · accepted limitation.* 99% of purchase amounts have cents in every currency, COP included, over uniform ranges: USD 5.00–500.00 (p50 252.20), ARS 1,750.05–174,999.31 (p50 88,303.46), COP 20,006.90–1,999,997.03 (p50 1,011,764.16). Amounts carry no merchant or customer signal. The service keeps the source string.

### DF-008 Card purchases are a minority of transactions

*`DF-008_transaction_mix.sql` · design · Medium · handled at metric level.* Approved purchases are 22.5% of design-window transactions; withdrawals 20.1%, transfers 18.6%, payments 15.4%, deposits 12.7%, adjustments and fees 2.7%, declined, pending and reversed about 8%. V1 lists approved card purchases only and routes other movements with an explicit message (ADR-002).

### DF-009 About 4.6% of purchases are abroad

*`DF-009_cross_border.sql` · design · Low · accepted limitation.* 4.57% of approved design-window purchases are outside the customer's country (the USA, Spain or Brazil at 0.9% each, or another bank country). Fixtures carry `transaction_country`; the service doesn't show it yet, a gap before a live comparison.

### DF-010 Unrecognized-charge demand is stable

*`DF-010_demand_stability.sql` · design · Low · supports ADR-002.* `Cargo no reconocido` is 18.2%, 18.2% and 18.4% of complaints in 2023, 2024 and 2025; 18.2–18.4% by country, 18.1–18.9% by segment. A segment comparison therefore measures how the system treats segments, not demand.

### DF-011 30% of customers have no detected accent

*`DF-011_accent_coverage.sql` · full · Low · handled at metric level.* `detected_accent` is null for 29.6% (Argentina), 30.0% (Colombia) and 29.9% (Mexico); other values match the country. The context card falls back to country, then `es-419`.

### DF-012 Ambiguous reports are rare and double charges absent

*`DF-012_repeat_purchases.sql` · design · Medium · accepted limitation.* A customer makes 1 approved purchase in a typical month (p90: 2); 0.43% of purchases repeat a merchant within 7 days, and no customer has two same-merchant, same-amount purchases on one day. The evaluation uses denser, more ambiguous authored fixtures reported by scenario family, and "charged twice" reports are authored and routed as billing disputes.

### DF-013 A third of credit-card-holding buyers hold multiple credit cards

*`DF-013_cards_per_customer.sql` · design · Medium · accepted limitation.* Of design-window purchasers holding at least one credit card in the current snapshot, 32.0% hold more than one (maximum 6); of those holding a debit card, 13.8% hold more than one. Denominators are holders of that card type. "My credit card" is ambiguous for a third of them; the snapshot says nothing about past holdings. Fixtures carry card type and last four digits.

### DF-014 Purchases fall outside the card's validity dates

*`DF-014_card_validity.sql` · design · Medium · open.* 21.6% of approved design-window purchases predate their card's `opening_date` and 27.1% follow its `expiration_date`, all on currently `Active` products. Over all 4,425,008 transactions, 18.7% predate `opening_date`, by 1 to 1,094 days (median 321) ([warnings follow-up](../../data_profiles/data_deep_dive/reports/quality_report_warnings_followup.md)). No filter uses card validity. Open: whether Bronze snapshots carry different dates per month.

### DF-015 Bronze-profile findings re-checked in Silver

*`DF-015_structural_leftovers.sql` · full · Low · mixed.* The [bronze profile findings](../../data_profiles/bronze_data_profile/bronze_profile_findings.md) against Silver:

| Bronze finding | Silver result | Status |
|---|---|---|
| `México` / `Mexico` spelling split | 6 values: Argentina, Brazil, Colombia, México, Spain, USA | Handled in Silver |
| `contact_reason` duplicates `reason_category` | Identical in all 686,296 interactions ([deep dive](../../data_profiles/data_deep_dive/reports/call_center_interactions_table_report.md)) | Open: keep one |
| Future-dated `customers.last_updated` | 9,316 customers after 2026-06-18, up to 2027-06-15 | Open |
| `amount_usd` 57% null | 35 null; 99,442 of 4,425,008 (2.25%) FX-estimated and flagged | Handled in Silver |
| `origin_interaction_id` 100% null | Column dropped | Handled in Silver |
| Literal `nan` in campaign subjects | None left | Handled in Silver |

### DF-016 Branch reference columns do not resolve

*`DF-016_branch_reference_columns.sql` · full · Medium · handled at metric level.* `dim_customers.registration_branch_id` has 150,000 distinct values for 150,000 customers, 5 of them real branches; `dim_service_agents.assigned_branch_id` has 833 distinct values for 833 of 1,200 agents, 2 real. The orphans look like real IDs (`SUC-XXXXXXXX`). No metric joins on them; the gate reports `foreign_key_orphans` and the [Silver README](../../data_pipelines/silver/README.md) marks them.

### DF-017 A few business codes are shared by two entities

*`DF-017_business_code_collisions.sql` · full · Low · accepted limitation.* 6 `product_number` values in 400,000 products and 13 `employee_code` values in 1,200 agents each belong to exactly two IDs. Joins use `product_id` and `agent_id`; both codes are in the gate's `unique_fields`.

### DF-018 Categorical values are in Spanish where the dictionary lists English

*`DF-018_spanish_domain_labels.sql` · full · Low · handled at metric level.* `product_type`, `document_type` (`Pasaporte`, no `CURP`), `geographic_zone` (only `Urbana`), `reason_category` and `detected_sentiment` are Spanish where the dictionary lists English; survey `comment_sentiment` is English. Gate domains use observed values, and filters use the source spelling (`Tarjeta Crédito`, `Queja`).

### DF-019 Foreign purchase countries are stored in English

*`DF-019_country_spelling.sql` · full · Medium · handled in the written policy (pending review).* Foreign countries are stored as `USA` (40,621 rows), `Spain` (40,542) and `Brazil` (40,472); home countries are Spanish, and Bronze's 40,515 `Mexico` rows become `México`. These three are 23,110 of 842,103 approved design-window purchases (2.74%). Customers say "EE.UU.", "EUA", "España", "Brasil", which exact string matching never matched. The policy (`evals/intake/frozen_es_pt_v1/label_rules.py`) now compares ISO 3166-1 codes through a closed ES/PT/EN map; unknown names never match, and recomputing the frozen answers changes none (only one frozen situation states a country). It awaits the unexposed reviewer's approval (ADR-006, decision 5), and development cases with a purchase country still need an unexposed author.

### DF-020 One clock for every country, no daily rhythm

*`DF-020_event_clock.sql` · design · Medium · accepted limitation.* Run `20261001T020908Z`. Transactions spread almost evenly over 24 hours in every country: the quietest hour has 98–99% of the busiest (Mexico 1,872,519 events, Colombia 1,122,261, Argentina 743,726); complaints 84–93% (28,197 / 17,225 / 11,314). Partitions roll over at the same stored hour everywhere, 06:00 for transactions and 08:00 for complaints, though Mexico is UTC−6, Colombia UTC−5 and Argentina UTC−3. Timestamps don't follow local time. Gold serves zone-free `source_occurred_at`, labelled in the interface.

### DF-021 Disputing customers have few recent purchases

*`DF-021_purchase_lookback.sql` · design · High · handled in the Gold cohort.* Population: 9,009 `Cargo no reconocido` complaints from 2023-10-15 to 2025-12-31. Numerator: the customer's approved purchases in (c − W, c], W = 30, 45, 90, 120 days. The median is 0 in every window and country (at 120 days p90 is 2, p99 5). 79.0% of complaints have no purchase in the prior 45 days, 61.1% none in 120. The last purchase, where one exists, is 41 days old at the median, 109 at p95, 118 at p99, bounded by the window, so it can't stand in for the disputed charge's age (DF-003). No window met our pre-written rule (at most 5% with none, median at least 3). The fallback applies: a 120-day serving cap, and a cohort of customers with at least 3 purchases in it. That is a selection, anchored on `as_of` (2026-06-17), so it never contains the disputed charge; no metric is computed on it (ADR-005).

### DF-022 Unrecognized-charge customers by country, segment and accent

*`DF-022_cohort_strata.sql` · design · Low · supports the Gold cohort.* 10,013 customers filed a `Cargo no reconocido` complaint: Mexico 5,001 (49.9%), Colombia 3,031 (30.3%), Argentina 1,981 (19.8%). The full country × segment × accent rollup labels missing values `(none)`. The slice manifest reports the cohort's mix against these shares.

### DF-023 Amounts share one USD scale, and claimed currencies ignore the customer's country

*`DF-023_currency_scale.sql` · design · High · handled at metric level; the free-text reply is planned. The key data risk.* Run `20261001T030222Z`. The median approved purchase is about USD 252 everywhere: Mexico USD 252.09 (420,916 purchases), Colombia COP 1,011,764 = USD 252.93, Argentina ARS 88,303 = USD 252.27. Mexican amounts are dollar-sized, not pesos labelled USD. Claimed currencies split almost evenly in each country (Mexico: COP 424, MXN 423, USD 394, ARS 391; Argentina: USD 178, MXN 174, ARS 172, COP 147), median 2,094–2,952 whatever the currency.

The guided flow is unaffected: the customer picks from their own list, currency shown. The written policy (`evals/intake/frozen_es_pt_v1/POLICY.md`, `label_rules._currency`) maps "pesos" from a Mexican customer to a currency they don't hold, so it answers "clarify, no candidates". Faithful to the data, but once free text is read online every such report would be asked again, and Mexico is 48.7% of the served cohort. Factored's answer (2026-10-01): treat the data as provided, document it, handle the uncertainty safely. Built: amounts served with their own currency, never converted (section 9). Planned: the reply states the card's currency and asks for confirmation. The policy and frozen labels change only with Manoella's approval; [EVALUATION.md](EVALUATION.md) reports the dependent cases.

### DF-024 Purchase amounts are almost flat up to USD 509, with no high-value tail

*`DF-024_amount_tiers.sql` · design · Medium · accepted limitation.* Run `20261001T182840Z`, 842,103 approved purchases with a USD amount: USD 5.00 to 509.41 (p50 252.39, p90 450.29, p99 495.00). Under USD 50 is 9.1% of purchases and 1.0% of value; 50–200 is 30.3% and 15.0%; 200–500 is 60.6% and 84.0%; over 500, 78 purchases. The top 20% hold 35.7% of value, so no Pareto tail. The 3,451 claimed amounts reach 4,999.90 (median 2,533.08), unlinked (DF-003). The data can't say where a high-value dispute starts, so urgency is a stated policy with round, unfitted amounts (`back-end/src/config/urgency.json`, migration 0013): above the p95 of the customer's latest 21 served purchases (at least 5 in its currency), or above a bank-set amount, gets a priority handoff and a "call the bank to block your card" line; since ADR-010 so does `card_lost_or_stolen` (`high_reasons`). The assistant never blocks a card (ADR-002).

### DF-025 Dispute outcomes can't show friendly fraud

*`DF-025_dispute_outcomes.sql` · design · Medium · accepted limitation.* Run `20261001T182840Z`, 10,370 `Cargo no reconocido` complaints: In Process 4,114, Open 3,105, Resolved 2,117, Escalated 514, Closed 418, Rejected 102. 7,963 have no resolution; the rest carry one of five fixed sentences (453–508 each). 350 customers filed two or more (707 complaints), 9,663 one. Friendly fraud needs disputes linked to transactions and an outcome saying the customer made the charge; the data has neither, and deciding fraud is outside V1 (ADR-002). Intake reduces it without judging: merchant and time shown before the report and the exact charge confirmed (built); an "I recognize it now" close and prior reports from our own case history (planned).

### DF-026 The dictionary's row counts are approximate

*`DF-026_dictionary_counts.sql` · full · Low · accepted limitation.* Run `20261001T182840Z`.

| Table | Dictionary | Supplied (Bronze = Silver) | Ratio |
|---|---|---|---|
| digital_events | 10,000,000 | 15,620,994 | 1.56 |
| transactions | 5,000,000 | 4,425,008 | 0.89 |
| campaign_sends | 2,000,000 | 1,746,801 | 0.87 |
| call_center_interactions | 800,000 | 686,296 | 0.86 |
| products | 400,000 | 400,000 | 1.00 |
| satisfaction_surveys | 250,000 | 212,759 | 0.85 |
| call_transcripts | 200,000 | 171,321 | 0.86 |
| customers | 150,000 | 150,000 | 1.00 |
| complaints | 80,000 | 67,095 | 0.84 |
| daily_exchange_rates | 3,000 | 13,164 | 4.39 |
| service_agents, branches, marketing_campaigns | 1,200, 350, 200 | 1,200, 350, 200 | 1.00 |

23,495,188 rows supplied against a dictionary sum of 18,884,750 ("~19 million"). Silver removed 0 duplicates, against the overview's "~2% duplicate records". Factored's answer (2026-10-01): the dictionary isn't ground truth; use the supplied data. The gate compares Bronze with Silver, never with the dictionary.

### DF-027 Wait time exists only for Phone contacts, and survey wait answers don't track it

*`DF-027_wait_missingness.sql` · design · Medium · accepted limitation.* Run `20261003T182506Z`, 580,546 contacts and their surveys (at most one per contact). `wait_time_seconds` is present on 406,622 of 493,375 Phone contacts and on 0 of 87,171 contacts in other channels, whose surveys still hold 9,805 wait answers. Over the 45,919 Phone answers paired with a measured wait, the correlation is 0.000. No "time saved waiting" claim comes from history; the [product report](BUSINESS_OUTCOMES.md) shows wait only for Phone, labelled, and our service times itself from case status history.

### Disclosure and adding a finding

On 2026-09-29, before ADR-005 set the design window, Lucas and an AI assistant profiled several facts once over the full period. Every fact used in evaluation design agrees with its design-window value to one decimal place, so the holdout changed no design choice.

To add one, write `data_profiles/findings/queries/DF-0NN_short_name.sql` with header lines `-- id:`, `-- title:`, `-- scope: design|full`, `-- memory:` (design queries must filter with `$design_end`; a test enforces it), run `make findings` (results in ignored `data/findings_runs/<UTC time>/results.json`), paste reviewed aggregates only, and name the quality run in the PR.

## 11. Reproducing it

The repository holds no data and no credentials. You need Python 3.10+, GNU Make, local disk for the ignored store under `data/`, and read-only access to the organizers' S3 bucket for anything that reads the source. Defaults are in `Makefile`; override `S3_BUCKET`, `AWS_REGION`, `AWS_PROFILE` or `DATA_DIR`. Check a profile without printing keys: `aws s3 ls s3://<bucket>/data/ --profile <profile>`.

| Command | Needs | Does |
|---|---|---|
| `make setup` | nothing | Installs dependencies in the ignored `.venv` |
| `make test`, `make compile` | nothing | Offline Bronze, Silver and quality fixtures; compiles the packages |
| `make docker-test` | Docker | Code-only image running CI's tests, minus `test_complete_audit_on_controlled_snapshot` (needs `.git`) |
| `make intake-setup`, `make intake-test` | Node 22+ | Client build; Gold, Angular and Worker tests against local D1 |
| `make intake-sample-{bronze,silver,quality,slice}`, `make intake-seed-local` | S3 read | One-day sample → reviewed seed → local D1 |
| `make pipeline AWS_PROFILE=default` | S3 read | Bronze, Silver, quality gate, in order |
| `make bronze-full` | S3 read | Re-reads history after a corrected partition; rebuild Silver and rerun quality after |
| `make docker-pipeline` | S3 read, Docker | The pipeline with `data/` mounted writable and `~/.aws` read-only at runtime |
| `make findings` | a built Silver | Every findings query |
| `make gold`, `make intake-cohort-slice` | a ready quality run | Gold, then the cohort |
| Remote D1, deploy | a person's approval | The deploy workflow applies additive migrations; agents never run `--remote` |

CI (`.github/workflows/quality.yml`) runs the offline fixtures and compiles the packages on pushes to `main` and every pull request, with no credentials and no dataset. No data or credentials enter an image layer. Bronze reads S3 through DuckDB's AWS credential chain, so no keys go in `.env`. `data/quality_runs/<UTC run ID>/` holds aggregate results and a summary; don't read an analysis from Silver until quality exits successfully.

For debugging, every stage takes `--tables`:

```bash
.venv/bin/python data_pipelines/bronze/run_ingestion.py --tables customers,marketing_campaigns
.venv/bin/python data_pipelines/silver/run_silver.py --tables customers,marketing_campaigns
.venv/bin/python -m data_pipelines.quality.run_quality --tables customers,marketing_campaigns
```

Bronze defaults to a 2 GB DuckDB limit and four threads, Silver and quality to 3 GB and two; all honor `DUCKDB_MEMORY_LIMIT` and `DUCKDB_THREADS`, with spill in ignored `data/duckdb_tmp`. The reports in `data_foundation/reports/` were rebuilt from one verified Silver run and passed the gate in `Docs/archive/marketing/marketing-product-trust.md`; new aggregates are committed only after a full Silver run, reconciliation, a privacy check and HTML inspection.

**Optional cached transcript labels.** These are historical model predictions, not human-verified labels. The custodian shares two frozen SQLite caches through an authorized private channel; they stay outside Git, need no API key, and should match these SHA-256 values (`shasum -a 256`):

| Cache | SHA-256 |
|---|---|
| First-pass `audit.sqlite` | `22dab32f44802bba1fb240204d3cbd035bb47666eaef6e39bdc1bb713bfa8f2f` |
| Second-pass `second-pass.sqlite` | `0aeb4a4dcdb13795df0fd337339d3cad5bb4ccccf53ed84ed8db250fb1fbd3a8` |

```bash
make transcript-labels \
  JEV_FIRST_CACHE=/private/path/audit.sqlite \
  JEV_SECOND_CACHE=/private/path/second-pass.sqlite
```

The target runs the transcript quality checks first (`make pipeline-with-labels` runs the whole pipeline before it; `python -m data_pipelines.transcript_labels --first ... --second ...` assumes a passing gate). Missing caches fail explicitly. `enrichment.interaction_labels` then holds 132,668 provisional + 38,653 review_required + 514,975 no_transcript = 686,296 interactions; the 171,321 transcript-bearing records share 546 distinct texts. Source labels are never overwritten, and no accuracy claim is made without human adjudication.

**Offline evaluation checks.** The online service is deterministic, extractor off. These fixtures need no key and call no model or cloud:

```bash
.venv/bin/python -m pytest intake_agent/extractor/test_vertex.py \
  intake_agent/extractor/test_workers_ai.py evals/intake/test_report_cuts.py \
  evals/intake/test_frozen_report.py evals/intake/preregistration/test_prereg.py -q
```

One deadline fixture binds a loopback server, so localhost sockets must be allowed. Vertex AI sign-in is in the [extractor runbook](../../intake_agent/extractor/README.md): a person supplies the hour-long `gcloud auth print-access-token` token in the environment, never in a file. The frozen run happened once, on 2026-10-04, after the hashes were checked and a person tagged `extractor-v1`; the custodian then generated the [language, family and authored-segment cuts](EVALUATION.md#1-the-result) without a model call. Cognito enrolment and the SES sandbox are in the [auth runbook](../Plans/auth-runbook.md).

**Latency and the diagram.** `scripts/summarize_worker_latency.py` summarizes an authorized, ignored Worker export, e.g. `.venv/bin/python scripts/summarize_worker_latency.py data/observability/tail-2026-10-01.jsonl --route /intake/confirm`. The existing export has one timed confirmation, too few for the p95-below-2-s target ([latency evidence](EVALUATION.md#11-other-measurements)). [`current-workflow.svg`](../Evidence/diagrams/current-workflow.svg) renders to the checked-in PNG with headless Chrome at `--window-size=1440,1127`, screenshotting to `Docs/Evidence/diagrams/current-workflow.png`.

## Limitations and how we handle them

| Limitation | How we handle it |
|---|---|
| A correction under the same file name is invisible to incremental runs, and nothing prompts `make bronze-full` | The data owner runs it deliberately; a per-object ETag manifest would detect it but isn't built for a static snapshot |
| Late-day detection reads Bronze's partition columns every run | One columnar read of three columns; fine at this size |
| The pipeline has never run on a live feed | Every delivery case runs on the fixture in section 6 |
| Gold and D1 don't refresh on their own (section 8, stops 1–3) | Build/gate failures leave D1 unchanged; remote-load failures require the recovery above. `as_of` is manual; the follow-up adds the replace path |
| The cohort is fixed to complaints before 2026-01-01 | Keeps the evaluation window clean (ADR-005) |
| The demo serves up to 1,000 identities and each customer's newest 20 charges (`COHORT_LIMIT`, `PAGE` in `back-end/src/modules/customer/routes.js`) | The cohort has 796 customers; older charges sit behind `has_more` |
| The UI doesn't show the data's cut-off date | The coverage line says "the most recent at the cutoff"; the manifest and `seed_loads` hold the date |
| Schema changes only stop the build | Next step in section 8 |
| Currency, time zone, templated text, unlinked complaints | Served as provided and labelled; see the findings register |
