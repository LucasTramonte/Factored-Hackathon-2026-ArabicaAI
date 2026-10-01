# Data freshness policy

- **Status:** Draft proposal for team review. Manoella owns the Bronze-side findings it relies on (DF-004, DF-014, DF-015).
- **Date:** 2026-09-30
- **Deciders:** Manoella R, Lucas Tramonte, Roberto Z
- **Why:** the brief asks for "an update/freshness policy" alongside contracts, quality checks and lineage (problem statement, p. 4; [`Docs/sources/README.md`](../sources/README.md)).
- **Related:** [Bronze](../../data_pipelines/bronze/README.md), [quality gate](../../data_pipelines/quality/README.md), [Gold slice](../../data_pipelines/gold/README.md), [cohort proposal](gold-cohort-decision.md), [ADR-004 §7](../ADRs/ADR-004-intake-capacity-and-cost.md), [ADR-005](../ADRs/ADR-005-evaluation-data-protocol.md)

## What "fresh" means here

The source is a **static synthetic snapshot**. The organizers' S3 bucket holds daily fact partitions up to `process_date` 2026-06-17, and business timestamps up to 2026-06-18 05:59:41. No new data is expected. So freshness here doesn't mean "close to real time". It means:

> The data the service serves comes from the **current** S3 snapshot, through a quality run that passed, and every served row can be traced to its source file and its seed version.

The policy is written so that it would still hold if the bucket began receiving daily partitions.

## Clocks

- **Business timestamp** (`transaction_date`, `creation_date`, …):
  - Every event-time filter, window and split uses it (AGENTS.md, ADR-005).
  - It has no time zone, and is served as wall time.
- **`process_date`** is the storage partition. It is used only to decide what to load.
  - It runs *ahead* of the event for early-hour events: 25% of transactions (event hours 00–06) and 34% of complaints (hours 00–08) sit in the previous day's partition (DF-004, open).
  - No partition holds events from an earlier day. The `late_arrival_signal` check is 0 in all six fact tables with a business date (quality run `20260929T231714Z`).
- **Consequence:** business day D is complete once partitions D−1 and D are both loaded. The last complete business day in the source is **2026-06-17**. Business day 2026-06-18 exists only as its 00–06 hours, so it is partial.

## Rules by layer

| # | Layer | Rule | Enforced by |
|---|---|---|---|
| 1 | Bronze facts | Load new partitions incrementally, past a per-table watermark (`bronze._load_watermarks`). An incremental run never re-reads old partitions. **If an old partition changes, or the organizers announce a correction, run `make bronze-full`,** which stages and then swaps. | `data_pipelines/bronze/ingestion.py`; its tests |
| 2 | Bronze dimensions, rates | Fully overwritten on every run. Customers and products are **current snapshots**: never infer historical status, segment or card validity from them (DF-014). Rates are a flat file; derived USD amounts keep `amount_usd_is_estimated`. | `ingest_dimension`; Silver `dim_fx_rates` |
| 3 | Silver and quality | Silver is fully rebuilt from Bronze, so it is as fresh as Bronze. A quality run follows every build and records the watermarks. **Any error blocks everything downstream**; warnings are reported and never silently cleaned. A Gold build needs a quality run that is ready, has no errors, was taken on the same database after its last change, and has a transactions watermark **at least** as late as the last business day served. | `run_quality.py`; `check_quality_gate` |
| 4 | Gold → D1 seed | Each seed is content-addressed (`slice_version`) and published together with its manifest (source files, loaded partitions, coverage note). Rerunning the same inputs changes nothing. **If a stored row differs, D1 rejects the load** rather than overwriting it. Context cards carry `snapshot_at`, the time of the quality run. | `intake_slice.py`, `run_intake_slice.py`; the drift tests |
| 5 | D1, remote | A seed version goes to `--remote` only after a person has reviewed its manifest. The live database must always hold exactly one reviewed `slice_version`. | Runbook (manual) |
| 6 | Online writes | Cases, episodes and events are written live. A reference is returned only after the row has been read back, and agent views read the primary, so nothing served is stale. **If D1 read replicas are ever enabled,** every agent read must go through the Sessions API with a bookmark. | `d1.js`; integration tests |
| 7 | Evaluation data | The frozen set and development fixtures don't depend on D1 or Silver freshness. The design window is fixed at 2026-01-01 and no refresh moves it. | ADR-005; `run_findings.py` |

## Cadence and triggers

- **While the service is up** (until 2026-10-20):
  - **Daily:** `make pipeline` (incremental; a no-op if S3 has nothing new).
  - **Before each Gold build or recorded demo:** `make bronze-full`, then Silver and a full quality run. The full build took 11 min 15 s on a laptop (ADR-004).
- **Triggers for a new seed:**
  - a new or changed source partition that affects served rows;
  - an accepted cohort change;
  - a schema or contract change.
  
  An unchanged source produces the same `slice_version`, so there is nothing to load.
- **Weekly check** (together with the ADR-004 §7 monitoring):
  - the latest quality run is ready, and its watermarks equal the S3 listing;
  - the remote D1 `slice_version` equals the latest reviewed manifest.

## How staleness is reported

- **API:** the transaction list declares its coverage (`coverage`, `has_more`). Once the cohort seed ships, it should also return the served window and the `slice_version` (roadmap phase 4).
- **Manifest:** records the quality run ID, the watermarks, the served business-day window, the loaded partitions and the partial-day note. This is the freshness evidence for any figure the demo shows.
- **Documents:** figures quote their findings or quality run ID. Figures from different builds are never mixed.

## Known gaps

1. **No automatic detection of changed old partitions.** An incremental run doesn't compare object ETags or sizes. `bronze-full` before each Gold build is the workaround.
2. **The Gold gate relies on file modification time.** It compares the DuckDB file's `mtime` with the quality timestamp, so copying or touching the database invalidates a good run.
3. **The gate needs changing for the cohort.** Today it requires the watermark to *equal* the business day, which only works for the one-day sample, and a focused quality run skips the relationship checks. Rule 3 needs both changes before a cohort seed is built.
4. **There is no scheduler.** Every run is manual (`make`). The AWS target would run it from EventBridge Scheduler with Fargate (ADR-004 §3).
5. **The DF-004 cause is still open.** We can't tell which clock is shifted. That doesn't change any rule above, because every rule uses the business timestamp.
