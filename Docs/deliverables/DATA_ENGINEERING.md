# Data engineering: from the organizers' S3 files to the rows the service shows

This is the data-engineering deliverable. It covers how the supplied data becomes the few rows the online service may show, and how each step is checked and traced. It also states what happens when the data changes, which stack we chose, what would change that choice, and what isn't solved yet. Every figure comes from a recorded run or a test named here.

The brief asks for "repeatable data preparation with contracts, quality checks, lineage, and an update/freshness policy". It also says: "use batch, incremental, or streaming processing according to the supplied inputs and the workflow's latency and freshness needs… If only static data is supplied, demonstrate update correctness with a clearly labeled test fixture." Each part of that request has a section below.

| The brief asks for | Where we meet it | Evidence |
|---|---|---|
| Repeatable preparation | One Make target per layer, a Docker image, and offline CI | [Section 1](#1-the-pipeline), [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md) |
| Contracts | Typed Silver specs, schema checks that block the build, and API and D1 schema constraints | [Section 2](#2-contracts) |
| Quality checks | 336 aggregate checks; any error blocks every later step | [Section 3](#3-the-quality-gate), [`PARITY.md`](../../data_pipelines/quality/PARITY.md) |
| Lineage | Every served row traces back to its S3 file | [Section 4](#4-lineage) |
| Update/freshness policy | What each kind of delivery does, and how fresh each layer is | [Section 5](#5-update-and-freshness-policy) |
| Update correctness on static data | A labelled fixture that drives the real code through each kind of delivery | [Section 6](#6-update-correctness) |
| Batch vs. streaming, and the stack | Batch on DuckDB, with what would change it | [Section 7](#7-stack-and-trade-offs) |
| "If we give you data tomorrow, what works?" | The whole path from a new S3 delivery to what the demo shows: what is automatic, what a person does, and the three places it stops today | [Section 8](#8-if-new-data-arrives-tomorrow) |
| Currency and time the source doesn't settle | Served as provided, never corrected, and the service says what it doesn't know | [Section 9](#9-currency-and-time-served-as-provided) |
| Limitations | Every known limit in one list, with how we handle it | [Limitations](#limitations-and-how-we-handle-them) |

## 1. The pipeline

```
S3 (organizers, read-only) ─▶ Bronze (raw Parquet) ─▶ Silver (typed tables) ─▶ quality gate ─▶ Gold (reviewed seed) ─▶ D1 (online)
```

- **Bronze** (`data_pipelines/bronze/`) copies the 13 source tables as raw text, so nothing is lost before typing.
  - **Dimensions:** the six are rebuilt in full every run.
  - **Facts:** the seven are partitioned by day (`year=/month=/day=`) and loaded incrementally, using a per-table watermark in `bronze._load_watermarks`.
  - **Lineage columns:** every row gets `_source_file`, `_ingested_at` and `_source_table`.
  - **Access to S3:** the code only lists and reads from S3, through a credential chain scoped to the bucket. Nothing writes there.
- **Silver** (`data_pipelines/silver/`) types each table from its spec in `table_specs.py`.
  - **Deduplication:** one row per primary key, keeping the latest delivery.
  - **Countries:** names are canonicalized.
  - **USD amounts:** converted at the exact-date FX rate. A fallback conversion is flagged `amount_usd_is_estimated` (DF-015) and is never summed as real USD.
  - **Rebuilds:** Silver is always rebuilt in full. That takes seconds from local Parquet.
- **The quality gate** (`data_pipelines/quality/`) runs read-only over Bronze and Silver and writes `quality_results.json` with the watermarks it checked ([section 3](#3-the-quality-gate)).
- **Gold** (`data_pipelines/gold/`) cuts the serving data. It is either the one-day slice or the cohort of customers who disputed a charge (796 customers and 2,906 purchases as of 2026-06-17, [ADR-004 §2](../ADRs/ADR-004-intake-capacity-and-cost.md)). The output is an idempotent SQL seed and a manifest.
- **D1** receives the reviewed seed. The Worker never reads S3, DuckDB or Silver ([ADR-003](../ADRs/ADR-003-intake-single-runtime-worker-d1.md)).

**Measured on the full data** (one laptop; the source reconciliation in `PARITY.md` ran on 2026-09-27, and the full build in ADR-004 on 2026-09-29):

| What | Value |
|---|---|
| Source | 13 tables, 7,671 CSV files, 23,495,188 rows |
| Bronze | 7,699 Parquet files, 1.4 GB |
| Silver | 2.86 GB in DuckDB, 23.5 M rows; all 13 row counts equal Bronze, 0 duplicate keys |
| Bronze → Silver → quality, full build | 11 min 15 s with DuckDB capped at 2–3 GB and 2–4 threads |
| Quality run | 163 s, peak memory 5.7 GB |
| Largest Bronze table | `digital_events`, 1,097 partitions in 1,220 s at a 2 GB limit |

**Memory model.** Python never holds fact rows: every scan is grouped SQL in DuckDB, filtered early and spilled to disk. Tables load one at a time, and a failing table fails the run without stopping the others ([`ARCHITECTURE.md`](ARCHITECTURE.md)).

**Running it:**
- `make pipeline` runs ingestion, Silver and quality in order.
- `make bronze-full` rebuilds the source history.
- `make gold` builds the Gold tables over every customer; `make intake-cohort-slice` rebuilds them and selects the cohort from them.
- `make test` runs the offline fixtures.
- CI (`.github/workflows/quality.yml`) runs the tests on pushes to `main` and on every pull request, without any S3 credentials.

## 2. Contracts

Each contract is enforced by code at the point where the data crosses a boundary.

| Boundary | Contract | Enforced by |
|---|---|---|
| S3 → Bronze | Expected tables, `year=/month=/day=` paths, and a path date that matches `process_date` | the `table_discovery`, `partition_source_missing` and `partition_date_mismatch` checks (errors) |
| Bronze → Silver | Column names, types, primary keys and required fields per table (`ALL_SPECS`) | `silver_schema_missing_columns`, `duplicate_primary_keys`, `silver_required_nulls` and `silver_row_delta_unexplained` (errors), plus Silver unit tests |
| Silver → Gold | Ownership (`products.customer_id = transactions.customer_id`), exactly one Bronze source row per served transaction, and amount, currency and timestamp formats | `validate_sample` and `_validated`; any violation fails the build |
| Gold → D1 | Idempotent upserts that fail on drift, plus the D1 schema (NOT NULL, CHECK, foreign keys) | each seed sets a NOT NULL column to NULL if a stored value differs, so D1 rejects it |
| D1 → client | Every API response body | `front-end/contracts/intake-api.schema.json`, checked in every integration test |

The DBML model in `data_profiles/silver_data_model/` documents relationships for readers. Nothing validates it automatically; the specs in `table_specs.py` are the contract that is actually enforced.

## 3. The quality gate

On the full data the gate ran **336 aggregate checks, with 0 errors and 6 warnings**.

**An error blocks readiness.** Errors cover:
- missing tables or columns;
- duplicate or missing keys;
- unexplained row-count changes between Bronze and Silver;
- unparseable dates;
- missing foreign-key parents;
- a mismatch between a partition and its date.

Gold refuses to build unless its quality run is ready. That run must also be for the same DuckDB file, must have been generated after the last change to that file, and must have checked the watermark Gold serves (`check_quality_gate`).

**Warnings stay visible** and are handled where a metric uses the data: orphan links, late-arrival signals, owner mismatches and domain violations. All six on the full data are source limitations recorded in [`DATA_QUALITY.md`](DATA_QUALITY.md) and [`PARITY.md`](../../data_pipelines/quality/PARITY.md). One example is DF-002: complaints cite other customers' products.

**Parity.** All 181 check numerators shared with the former CSV scanner match it ([`PARITY.md`](../../data_pipelines/quality/PARITY.md)).

## 4. Lineage

A transaction shown to a customer can be traced back to its S3 file.

| Layer | What records where a row came from |
|---|---|
| Bronze | `_source_file` (the S3 object path), `_ingested_at`, `_source_table`, and the partition columns |
| Silver | `process_date`, the storage partition |
| Quality | The run id, the watermarks it checked, and the database path and size |
| Gold manifest | The seed's `slice_version`, the quality run it passed, and `source_file` for every served transaction (the Bronze row is re-joined, so the amount is the original string) |
| D1 | `sample_provenance(transaction_id, product_id, source_file, business_date, mapping)` for every dataset transaction, and `seed_loads(version, loaded_at)` for every loaded seed part |

**Gap:** Silver doesn't carry `_source_file`, so Gold re-joins Bronze to recover it. Carrying it forward would remove that join at the cost of one more text column per row. We'll do it only if a second consumer needs per-row lineage.

## 5. Update and freshness policy

**The source is a static snapshot** (dataset version 1.0.0, generated July 2026). It has 1,097 daily partitions from 2023-06-17 to 2026-06-17, reconciled on 2026-09-27 and rebuilt in full on 2026-09-29. **We freeze the submission on that snapshot.** Any later delivery becomes a new versioned build and is never patched in silently. We will ask the organizers whether the snapshot is final.

This policy describes how the pipeline handles a live feed, and the fixture in [section 6](#6-update-correctness) runs every case.

| Delivery | What the pipeline does | Why |
|---|---|---|
| **A new day** | An incremental run loads it and moves the watermark forward | The normal case. It reads exactly the new days, one S3 read per month that has any |
| **A late day** (older than the watermark, never delivered before) | Loaded on the next incremental run, logged as a warning and printed in the run summary as late partitions; the watermark doesn't move back | A late arrival is new data, not a correction. Skipping it would lose it silently, which the old code did |
| **A corrected or removed day** (one Bronze already holds) | Never reread by an incremental run, even when a new or late day arrives in the same month. `make bronze-full` re-reads the history and swaps it in atomically | Revisiting history on every run would cost an S3 read of every partition. A correction should be a deliberate, reviewed act |
| **A row re-delivered later** with the same key | Bronze keeps both copies. The quality gate reports `duplicate_primary_keys_across_partitions` as an error, so Gold won't build until the delivery is resolved (a reviewed `bronze-full` or a source fix). Silver keeps the copy from the latest partition, as defense in depth | Bronze stays raw and auditable, and a duplicate key is a source defect that a person must see. If a run that isn't ready is still used, Silver serves the latest truth; ties within one load break on `process_date` |
| **A partition directory that isn't a real date** (`day=32`, `day=xx`) | An incremental run skips it with a warning. A full refresh refuses the source before writing anything, and the run exits 1 | A full refresh reads one history-wide glob and would otherwise import it, storing partition values that later runs can't read as dates |
| **Dimensions** | Rebuilt in full every run | They are flat exports and small |

**How fresh each layer is:**
- **Bronze and Silver:** as fresh as the last run. In production, one batch runs a day after the daily partition lands; the AWS target, which is designed but not deployed, would schedule it with EventBridge on Fargate ([ADR-004 §3](../ADRs/ADR-004-intake-capacity-and-cost.md)).
- **Gold and D1:** they change only through a reviewed seed with a new version. `seed_loads` records what is loaded, so the service shows data as of the manifest's `as_of` date and no fresher. The cohort's `as_of` is the last loaded partition, so once the cohort is loaded into remote D1 the demo will show data up to 2026-06-17.
- **Event time vs. storage time:** `process_date` is the storage partition and is used only to prune reads. Every business filter uses the event timestamp. The two differ: early-hour events are filed under the previous day (DF-004), and the same clock applies to every country (DF-020).
- **Retention:** demo activity is kept until judging ends and deleted after 2026-10-20 ([ADR-004 §7](../ADRs/ADR-004-intake-capacity-and-cost.md)).

**Who acts on what:**
- **The batch operator** watches for a run that exits non-zero (any failed table) and for any `late_partitions` warning.
- **The data owner** reviews and approves every `bronze-full` and every new Gold `as_of`.

## 6. Update correctness

`data_pipelines/test_update_correctness.py` is the labelled fixture the brief asks for. Its data is synthetic and was generated by the team. It drives the real Bronze ingestion and Silver build over local partitions shaped like S3:

| Test | Proves |
|---|---|
| `test_a_new_day_is_appended_and_the_watermark_advances` | The incremental path loads the new day and moves the watermark |
| `test_a_late_old_day_is_loaded_and_counted_without_moving_the_watermark_back` | A late day is loaded, counted and not reloaded on the next run |
| `test_a_row_redelivered_later_with_new_content_replaces_the_old_copy_in_silver` | Silver keeps the latest copy even when both copies were ingested together |
| `test_a_corrected_old_partition_needs_a_full_refresh` | Incremental runs don't revisit history, and a full refresh picks up the correction |
| `test_a_late_day_never_rereads_the_days_already_held_in_its_month` | A late day in an old month leaves that month's held days untouched, so a correction there waits for a full refresh |
| `test_a_new_day_never_rereads_earlier_days_of_the_current_month` | The same holds for the current month |

Older tests cover atomic swaps, crash recovery and idempotent reruns in Bronze (`data_pipelines/bronze/test_ingestion.py`), and rerun and drift rejection in Gold (`data_pipelines/gold/test_*.py`).

**Three defects that the fixture and its review found and that are now fixed:**
- **Late days were dropped.** A day older than the watermark was skipped silently, even if Bronze had never held it.
- **Incremental runs reread whole months.** They used a `day=*` glob, so an incremental run reread, and overwrote, the days already held in any month it touched. A source correction could then slip in unreviewed. Runs now read exactly the days they load.
- **Duplicate keys within one load could keep the stale copy.** An original and its re-delivery could share one `_ingested_at`, and the Silver dedup kept either copy. Facts now tie-break on `process_date`.

Each was fixed test-first, and reverting the fix makes its test fail. None of the three affects the current snapshot, which has no gaps and no duplicate keys.

## 7. Stack and trade-offs

**Batch is the right mode.** The source arrives as daily files. The workflow serves a reviewed seed, and a customer's purchase list doesn't need minute-level freshness for intake. The brief notes that incremental files "do not by itself require streaming".

| Concern | Our choice | Considered | Why ours, at this size | What would change it |
|---|---|---|---|---|
| Engine | **DuckDB**, one process | Spark (EMR, Glue), Athena, Snowflake/BigQuery | 2.86 GB builds in 11 minutes on a laptop and would run unchanged on Fargate for $0.60 a month. A Glue job would cost about $6.60 a month at its minimum, and moving to Spark means a rewrite | Over ~100 GB, a build over 1 hour, or several concurrent jobs (ADR-004 §1) |
| Storage format | **Hive-partitioned Parquet** plus a DuckDB file | Apache Iceberg, Delta Lake | One writer and full Silver rebuilds need no ACID table format or time travel | Several writers, row-level corrections without full rebuilds, or query engines that must share tables |
| Transformations | **Typed specs in Python** that generate SQL, plus unit tests | dbt | 13 tables with one transformation each. The specs already give typed columns, tests and one dedup rule | More than about 30 models, or analysts who maintain SQL themselves |
| Orchestration | **Make targets and a CLI**, plus CI | cron or GitHub Actions; EventBridge with Fargate; Airflow, Dagster, Prefect | There is no live feed, so there is nothing to schedule yet. A scheduler would add operations without a measured need | A real daily feed: start with EventBridge and one Fargate task (the AWS target). Use Dagster or Airflow only once there are several dependent pipelines with retries and backfills |
| Quality | **Our own aggregate checks**, with errors and warnings and a gate before Gold | Great Expectations, Soda | The checks are SQL over our own specs, with parity proven against the old scanner. A framework would add a dependency without adding coverage | Several teams writing checks, or a need for a hosted results UI |
| Lineage | **Columns and manifests**, carried all the way to D1 | OpenLineage with Marquez | One pipeline, and every served row already traces to its file | Several pipelines and consumers that need an impact graph |
| Change detection | **A watermark plus late-day detection** | An S3 Inventory or ETag manifest | Catches new and late days with no extra service | Corrections delivered under the same file name: compare ETags per object (see Limitations) |

## 8. If new data arrives tomorrow

The organizers confirmed that new data would arrive in the same storage pattern as the snapshot: daily `year=/month=/day=` partitions under the same S3 prefixes. This section is the whole path for that case, from S3 to what a customer sees, and it is honest about where it stops today.

**What the solution needs in order to work (the inputs it assumes):**
- **The same 13 tables and storage pattern.** A path whose date doesn't match `process_date` stops the run (`partition_date_mismatch`), and a missing expected column stops it (`schema_missing_columns`).
- **A passing quality run on the same DuckDB file**, written after the database last changed. Gold refuses a quality run from another database or an older one (`check_quality_gate` in `data_pipelines/gold/intake_slice.py`).
- **Disputes to serve:** customers with a `Cargo no reconocido` complaint and at least 3 approved purchases with a merchant in the 120 days before the cut-off (DF-021, DF-022).
- **Room in D1's write quota.** A full cohort load is about 20,620 rows written against 100,000 a day on the free plan ([ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md)).
- **People:** someone to run the batch and watch for a non-zero exit, and the data owner to approve the new `as_of` and the remote load.
- **Tools:** Python 3.10+, Node 22+, the read-only AWS profile, and Wrangler signed in to the Cloudflare account.

**The path, step by step:**

| Step | Command | Automatic or manual | Time | What happens |
|---|---|---|---|---|
| 1. Bronze | `make bronze` | Manual today; one daily job in production (EventBridge and Fargate on the AWS target) | An incremental Docker run took 660 s ([`PARITY.md`](../../data_pipelines/quality/PARITY.md)); a single new day hasn't been timed | Loads new and late days, moves the watermark, refreshes dimensions (section 5) |
| 2. Silver | `make silver` | Runs after Bronze | Inside the 11-minute full build | Rebuilds typed tables; the latest copy of a key wins |
| 3. Quality gate | `make quality` | Runs after Silver; a non-zero exit stops the run | Inside the full build | Any error blocks Gold. Warnings stay visible |
| 4. Gold and the cohort | `make intake-cohort-slice COHORT_AS_OF=<new watermark>` (`COHORT_DB` and `COHORT_QUALITY` override the Silver file and quality run) | Manual, with the data owner's approval of the new `as_of` | Gold about 10 s on the full data; the selection not timed | Rebuilds the Gold tables gated on the quality run, then picks the cohort from Gold only and writes versioned seed parts and a manifest with the expected writes and the Gold builds used |
| 5. D1 load | `python -m data_pipelines.gold.run_cohort load --part N --target remote` | Manual, reviewed, at most one part per UTC day | Not timed; one Wrangler call per part | Skips a part whose version `seed_loads` already holds; fails if D1 wrote more rows than estimated |
| 6. The demo | none | Automatic | Immediate | The new cohort's customers appear in the picker; each sees their newest 20 charges |

**Where it stops today.** We checked each of these against the code, and reproduced the third in SQLite, which D1 runs on. In each case the build or the load stops with an error, and nothing that was already served changes. The new data doesn't reach the demo until someone acts. One caveat: a remote part is applied statement by statement and isn't atomic. A part that fails partway can leave its earlier statements applied, for example new customers added before the first stored customer that differs. The part is then not recorded in `seed_loads`, and because every statement is an idempotent upsert, it is loaded again once the cause is fixed (`run_cohort.py`).
1. **The cohort needs the new date passed by hand.** `COHORT_AS_OF ?= 2026-06-17` is the snapshot's date. The cohort's gate requires every Gold table it reads to come from one quality run whose transactions watermark equals `as_of`, so a default run against new data stops with "gold.customers was built from transactions loaded to <new date>, not as_of 2026-06-17". It is safe, but manual. (The quality run itself is now the latest one for the Silver file, chosen by timestamp.)
2. **New disputes don't enter the cohort.** Cohort membership is fixed to complaints created before 2026-01-01 (`DESIGN_END` in `data_pipelines/gold/cohort.py`), which keeps the evaluation's design window clean (ADR-005). New data only moves the 120-day purchase window of customers already in the cohort.
3. **Reloading over the current D1 fails.** Every context card carries the quality run's timestamp as `snapshot_at`, and the seed's upserts reject any stored value that differs, by design ([section 2](#2-contracts)). A rebuilt cohort therefore fails on its first customer who is already loaded, with `NOT NULL constraint failed: context_cards.card_json`. A corrected amount, merchant or time fails the same way, and no seed deletes rows that left the cohort or the window.

The [new-data rehearsal](../Evidence/new-data-rehearsal.md) of 2026-10-02 ran this path from S3 to a customer's charges on a copy in 158 seconds, and reproduced stops 1 and 3.

**The fix**, in a follow-up PR:
- take `as_of` from the quality run instead of a default;
- let cohort membership move with new complaints, while keeping the evaluation window fixed;
- add a reviewed replace path for seed rows, in which a person approves the drift the guard now rejects, plus a delete for rows that left the cohort;
- record a rehearsal on a labelled fixture, in the same way as [section 6](#6-update-correctness).

Until then, the demo serves the snapshot as of 2026-06-17, and the manifest and `seed_loads` say so.

**Schema changes.** We don't expect arbitrary schema changes, and the organizers agreed that handling them is a next step for us. What happens today:
- **A missing or renamed column** in a table we use stops the build at the quality gate. That is deliberate.
- **An added column never reaches Silver**, because each Silver spec selects its own columns. Whether Bronze's append accepts a new partition with an extra column hasn't been tested.

The next step has three parts:
- an additive Bronze contract (a new column is accepted and reported, never dropped silently);
- a version on each Silver spec;
- a fixture for an added column and a renamed column, next to the update-correctness tests.

## 9. Currency and time: served as provided

The source doesn't settle two things a dispute depends on: which currency an amount is in, and which time zone a timestamp is in. The organizers asked us not to correct either, but to treat the data as provided, document it, and handle the uncertainty safely. They called currency a key point.

**Currency** ([DF-023](DATA_QUALITY.md#df-023-amounts-share-one-usd-scale-and-claimed-currencies-ignore-the-customers-country), [DF-005](DATA_QUALITY.md#df-005-mexican-customers-transact-only-in-usd)):
- **What the data shows.** Every amount is on one USD scale, Mexican customers transact only in USD, and the currency on complaints looks random.
- **What we do.**
  - Gold keeps the Bronze amount and its currency code exactly as delivered, and the service shows them together on every row.
  - Nothing converts or sums amounts across currencies. `amount_usd` is FX-derived, carries its estimated flag, and isn't served.
- **What we don't do.** We never guess that an amount "should" be pesos.
- **Where it shows up.** A Mexican customer will naturally say "pesos", which matches none of their charges.
  - Today the customer picks the charge from their own list, so a currency word can't select the wrong one.
  - Once free text is read online, the reply will state the card's currency and ask the customer to confirm, rather than match on the word (planned, DF-023).

**Time** ([DF-020](DATA_QUALITY.md#df-020-one-clock-for-every-country-no-daily-rhythm), [DF-004](DATA_QUALITY.md)):
- **What the data shows.** Timestamps carry no time zone, and every country shares one clock.
- **What we do.** The service shows the source time as stored and labels it "source time zone not provided". Filters use the event timestamp, never `process_date`.
- **What we don't claim.** We never claim local-time precision the data doesn't support.

**Counts differ from the dictionary.** We treat the supplied data as the source of truth, and the dictionary's counts as approximate. The differences are recorded in [DF-026](DATA_QUALITY.md#df-026-the-dictionarys-row-counts-are-approximate).

## Limitations and how we handle them

This is the complete list. Each item says what it limits and how we handle it today. Fixes that need code are in the follow-up PR named in section 8.

| Limitation | What it limits | How we handle it |
|---|---|---|
| **An in-place correction is invisible to incremental runs.** A file replaced under the same name is picked up only by `make bronze-full`, and nothing tells the operator to run it | Corrections | The data owner runs `bronze-full` deliberately. A per-object ETag manifest would detect it, but isn't built because the snapshot is static |
| **Late-day detection reads Bronze's partition columns** on every incremental run | Run cost as history grows | One columnar read of three columns; acceptable at this size |
| **The pipeline has never run on a live feed** | Confidence in section 5 | Every delivery case runs on the labelled fixture in section 6 |
| **Gold and D1 don't refresh on their own** (section 8, items 1–3) | New data reaching the demo | Fail closed; manual `as_of`; the follow-up PR adds the replace path and a rehearsal |
| **The cohort is fixed to complaints before 2026-01-01** | New disputes reaching the demo | Keeps the evaluation window clean (ADR-005); the follow-up lets membership move |
| **The demo serves up to 1,000 cohort identities and each customer's newest 20 charges** (`COHORT_LIMIT`, `PAGE` in `back-end/src/modules/customer/routes.js`) | Breadth of the demo | The cohort has 796 customers, so the identity cap isn't reached; older charges sit behind `has_more` |
| **The UI doesn't show the data's cut-off date** | The customer knowing how fresh the list is | The coverage line says "the most recent at the cutoff"; the manifest and `seed_loads` hold the date |
| **Currency and time zone are uncertain in the source** | Matching a customer's words to a charge | Served as provided, with labels (section 9); never corrected |
| **Schema changes aren't handled beyond stopping the build** | New or renamed columns | Missing columns stop the gate; the next step is in section 8 |
| **The DBML schema is documentation only** | Readers trusting it as a contract | The enforced contract is `table_specs.py` |
| **Freshness is bounded by the snapshot** | What the demo can show | The demo shows nothing after 2026-06-17 |
