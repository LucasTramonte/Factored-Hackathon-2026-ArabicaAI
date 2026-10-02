# New-data rehearsal: from S3 to a customer's charges

2 October 2026. This rehearsal answers Factored's question of 1 October: "If we give you some data tomorrow, what would work?" It runs the whole path in [DATA_ENGINEERING section 8](../deliverables/DATA_ENGINEERING.md#8-if-new-data-arrives-tomorrow), from S3 to what a customer sees, on a copy, and records where it stops.

## Setup

- **Commit rehearsed:** e253267, the tip of `feat/urgency-and-shadow`.
- **Machine:** macOS 26.4 on an Apple M5 Pro with 24 GB, Python 3.14.7, Node 26.8.1, Wrangler 4.143.0.
- **Data:** an APFS clone of the team's local `data/` (4.0 GB: Bronze Parquet, the DuckDB file and earlier quality runs). `DATA_DIR` and `DUCKDB_PATH` pointed at the copy for every command. The original wasn't touched.
- **S3:** read-only, with the `factored-datathon` profile. Nothing was written to S3.
- **D1:** a fresh local D1 in an isolated worktree. Nothing ran `--remote`, and nothing was deployed.

**S3 had no new partitions.** Every fact table was up to date at 2026-06-17, so the run proves the path and its guards, not the volume of a new day.

## Steps

Times are wall-clock seconds from `date` stamps around each command.

| Step | Command | Time | Counts | Result |
|---|---|---|---|---|
| 1. Bronze incremental from S3 | `make bronze AWS_PROFILE=factored-datathon` | 24 s | 0 new and 0 late partitions in all 7 fact tables. Watermark 2026-06-17. 6 dimensions refreshed in full (customers 150,000, products 400,000) | Pass |
| 2. Silver | `make silver` | 78 s | `fact_transactions` 4,425,008, `fact_complaints` 67,095, `fact_digital_events` 15,620,994 (57 s of the 78), `dim_customers` 150,000, `dim_products` 400,000 | Pass |
| 3. Quality gate | `make quality` | 28 s | 390 checks, 0 errors, 7 warnings (orphans, unique-field and product-owner warnings already in the register). `ready: true`. Transactions watermark 2026-06-17. Report: `quality_runs/20261002T092328Z/quality_results.json` | Pass |
| 4. Gold cohort | `make intake-cohort-slice COHORT_DB=<copy> COHORT_QUALITY=<step 3 report> COHORT_AS_OF=2026-06-17` | 4 s | 796 customers, 2,906 purchases, 1 part, 20,620 expected writes, `sampling=all_eligible` | Pass |
| 5a. Fresh local D1 | `wrangler d1 migrations apply --local`, then `seed_fictitious.sql` | 6 s | Migrations 0001 to 0013. 2 fictitious customers | Pass |
| 5b. Cohort load | `make intake-cohort-seed-local COHORT_OUT=<step 4>` | 18 s | 798 customers (796 dataset), 2,912 transactions, 796 context cards, 1 `seed_loads` row. Rows written aren't measured locally | Pass |
| 5c. The same cohort again | `make intake-cohort-seed-local`, same directory | 2 s | `{"status": "already_loaded", "rows_written": 0}` | Skipped by `seed_loads`, as designed |
| 5d. The same part, bypassing `seed_loads` | `wrangler d1 execute --local --file part-001.sql` | 16 s | Counts unchanged | Pass: the upserts are idempotent |
| 5e. A cohort rebuilt from a second quality run | `make quality`, `make intake-cohort-slice` (same `as_of`), `make intake-cohort-seed-local` | 26 + 4 + 18 s | New version `87ed3b20…`, same 796 customers and 2,906 purchases. The two parts differ only in `snapshot_at` (796 cards each) | **Fails** on `context_cards` (stop 3). D1 counts unchanged |
| 6. What the customer sees | `wrangler dev --local` with `DEMO_PICKER="1"`, then `curl` | Ready in a few seconds; `/transactions` answered in 5 ms | `/demo/identities`: 799 (3 committed, 796 dataset). One cohort customer: `/demo/session` 200 with a context card dated by the step 3 run; `GET /transactions` 5 charges from 2026-02-26 to 2026-05-29, `has_more: false`, `coverage: dataset_cohort`; `GET /reports` 0 | Pass |

**From S3 to a customer's charges took 158 s** of commands (steps 1 to 5b) on this machine. The whole rehearsal, including the reruns and the UI check, took about 8 minutes.

## Where it stops

**Stop 1: Gold needs the new date passed by hand. Reproduced, and it stops earlier than predicted.** The Makefile defaults point at `data/full_local/`, which doesn't exist in the main checkout or in a fresh clone, so a default run fails before it reaches the date check:

```
FileNotFoundError: [Errno 2] No such file or directory: 'data/full_local/quality_runs/pr23-check/quality_results.json'
```

With the right database and report but an `as_of` one day past the watermark (2026-06-18, what a stale default looks like once a new day lands), the gate refuses:

```
ValueError: The selected Bronze date was not quality checked
```

Nothing is written in either case.

**Stop 2: new disputes don't enter the cohort. Confirmed from the code, not run.** `cohort.py` selects complainants with `c.creation_date < $design_end`, and `DESIGN_END = date(2026, 1, 1)`. `run_cohort build` has no flag to change it. A complaint created after 2026-01-01 never enters the cohort, whatever its `as_of`. This already applies to the snapshot: 1,927 `Cargo no reconocido` complaints from 1,915 customers, created between 2026-01-01 and 2026-06-18, are outside the cohort today. New data only moves the 120-day purchase window of customers already in it.

**Stop 3: reloading a rebuilt cohort over D1 fails. Reproduced.** A second quality run gives every context card a new `snapshot_at`, and the seed's upsert guard rejects the stored card that differs:

```
✘ [ERROR] NOT NULL constraint failed: context_cards.card_json: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)
```

The Makefile target shows only `subprocess.CalledProcessError: ... returned non-zero exit status 1`, because `run_cohort` captures Wrangler's output. The text above comes from running the same `wrangler d1 execute --local --file` by hand. The local load was atomic: customers, transactions, cards and `seed_loads` kept their counts, and only one `snapshot_at` remained. A remote load applies statement by statement, so this result doesn't carry over to remote D1.

## What surprised us

- The Makefile's default cohort paths don't exist, so stop 1 fails on a missing file before the date guard.
- A failed load hides the database error behind `CalledProcessError`. The operator has to rerun Wrangler by hand to read it.
- The same data with a new quality run is enough to trip stop 3. No data change is needed.

## What it would take

- **Stop 1:** read `as_of` and the database path from the quality run (`metadata.watermarks`, `metadata.database`) instead of Makefile defaults, and print Wrangler's stderr when a load fails.
- **Stop 2:** a `--design-end` (or a separate serving cut-off) for cohort membership, so new complaints enter the served cohort while the evaluation's design window stays fixed (ADR-005).
- **Stop 3:** a reviewed replace path for seed rows, in which a person approves the drift that the guard rejects, plus a delete for rows that left the cohort, with a fixture next to [section 6](../deliverables/DATA_ENGINEERING.md#6-update-correctness).
