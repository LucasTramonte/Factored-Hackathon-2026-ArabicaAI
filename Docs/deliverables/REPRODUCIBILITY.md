# Reproducing the data foundation and intake evidence

**Recorded service state:** v0.2.0, Worker `f76c7f7b` (`main-64ae03a`), deployed 2026-10-03 with D1 migrations 0001–0017 and the extractor off ([release evidence](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/releases/tag/v0.2.0)). Cognito email sign-in and SES sandbox notifications are included. App changes in #87–#90 are built and unmerged; offline Bedrock evaluation in #91 is gated. A newer deployment has not been re-read. The [architecture](ARCHITECTURE.md) separates these states from the never-deployed Lambda/Postgres target.

## Prerequisites

Python 3.10+, GNU Make, enough local disk for the ignored DuckDB/Parquet store, and read-only access to the organizer's S3 bucket. The repository does not contain data or credentials. The default bucket and region are in `Makefile`; override `S3_BUCKET`, `AWS_REGION`, `AWS_PROFILE` or `DATA_DIR` as needed. A usable AWS profile can be checked without displaying keys with `aws s3 ls s3://<bucket>/data/ --profile <profile>`.

## Local pipeline

```bash
make setup
make test
make compile
make pipeline AWS_PROFILE=default
```

`make pipeline` runs Bronze, Silver, then the DuckDB quality gate in that order. Bronze reads S3 through DuckDB's AWS credential chain; it does not need keys in `.env`. Facts add new process-date partitions; dimensions refresh on each run. Use `make bronze-full` only when a source partition was corrected or removed, then rebuild Silver and rerun quality. The database and Parquet files stay under ignored `data/`; `data/quality_runs/<UTC run ID>/` contains aggregate results and a Markdown summary.

Do not read an analysis from Silver until the quality command exits successfully. Warnings still require metric-specific treatment; a successful quality run does not validate campaign attribution or customer/product ownership as a usable analytical link.

For targeted debugging, call the existing entrypoints with `--tables`, for example:

```bash
.venv/bin/python data_pipelines/bronze/run_ingestion.py --tables customers,marketing_campaigns
.venv/bin/python data_pipelines/silver/run_silver.py --tables customers,marketing_campaigns
.venv/bin/python -m data_pipelines.quality.run_quality --tables customers,marketing_campaigns
```

The Silver command always refreshes its small FX reference table. Bronze defaults to a 2 GB DuckDB limit and four threads; Silver defaults to 3 GB and two threads. Both honor `DUCKDB_MEMORY_LIMIT` and `DUCKDB_THREADS`; the quality gate defaults to 3 GB and two threads. Ignored `data/duckdb_tmp` holds spill files. Override the limits only after measuring memory and runtime.

## Docker and CI

`make docker-test` builds a code-only image and runs the offline fixtures. `make docker-pipeline` builds the same image, mounts `data/` writable and `~/.aws` read-only at runtime, then executes Bronze, Silver and quality. No data or credentials enter an image layer. CI installs the declared requirements, runs offline fixtures and compiles the packages. Docker can be checked separately with `make docker-test`; it runs CI's test set only (no `compileall`), minus `test_complete_audit_on_controlled_snapshot`, which needs a `.git` directory the image doesn't have. CI needs no S3 credentials or full dataset.

## Rebuilding reports

The Marketing/Product HTML, intake decision page and aggregates were rebuilt from one verified Silver run and passed the gate in `Docs/archive/marketing/marketing-product-trust.md` (release record); they are in `data_foundation/reports/`. That plan records the customer-backwards analysis and report gate. New aggregate artifacts can be committed only after a single full Silver run, numerator/denominator reconciliation, privacy check and local HTML inspection.

## Optional cached Jev labels

This step imports historical model predictions, not human-verified corrections. Obtain the two frozen SQLite caches from their custodian through an authorized private team channel; the repository does not distribute transcripts or responses. Keep them outside Git. No API key is needed and no missing prediction is automatically requested.

Historical file SHA-256 checksums (verify with `shasum -a 256` after transfer):

| Cache | SHA-256 |
|---|---|
| First-pass `audit.sqlite` | `22dab32f44802bba1fb240204d3cbd035bb47666eaef6e39bdc1bb713bfa8f2f` |
| Second-pass `second-pass.sqlite` | `0aeb4a4dcdb13795df0fd337339d3cad5bb4ccccf53ed84ed8db250fb1fbd3a8` |

After building Silver, run:

```bash
make transcript-labels \
  JEV_FIRST_CACHE=/private/path/audit.sqlite \
  JEV_SECOND_CACHE=/private/path/second-pass.sqlite
```

This target runs the contact-center/transcript quality checks before importing. `make pipeline-with-labels` runs the full existing pipeline first. Both cache paths can also be supplied to `python -m data_pipelines.transcript_labels` using `--first` and `--second`; direct CLI use assumes a successful quality gate on the current Silver snapshot. Missing caches fail explicitly. Defaults point to the historical local `data_foundation/runs/` locations only for convenience; no code from that directory is imported.

Query `enrichment.interaction_labels` for original category, provisional transcript intent/category, confidence, model/configuration hashes, review status and pending human adjudication. On the reconciled historical snapshot: 132,668 provisional + 38,653 review_required + 514,975 no_transcript = 686,296 interactions. The 171,321 transcript-bearing records share only 546 distinct full texts; these counts describe that supplied corpus, not true customer demand or classification accuracy. New/changed text receives no current prediction and requires a separately authorized inference process if needed. Source labels are never overwritten.

Run `make test`, `make compile`, and `make docker-test` for offline fixtures, including malformed/stale caches, key uniqueness, rollback and missing transcripts. The code-only image needs neither cache files nor credentials for tests. Human adjudication and broader ES/PT evaluation remain separate prerequisites for any accuracy claim or production routing use.

## Local intake and offline evaluation checks

The Worker and Angular client need Node 22+. `make intake-setup` installs their declared dependencies; `make intake-test` builds the client and tests Gold, Angular and the Worker against local D1. Local tests apply migrations locally. The approved deployment workflow applies pending additive remote migrations; agents do not run remote migrations or deploy.

The [auth runbook](../Plans/auth-runbook.md) describes Cognito enrolment and the SES sandbox. The online service remains deterministic, with the extractor off. Offline transport, reporting and freeze-integrity fixtures need no key and make no cloud/model request:

```bash
.venv/bin/python -m pytest intake_agent/extractor/test_bedrock.py \
  intake_agent/extractor/test_workers_ai.py evals/intake/test_report_cuts.py \
  evals/intake/test_frozen_report.py evals/intake/preregistration/test_prereg.py -q
```

One existing deadline fixture binds a loopback HTTP server, so a restricted environment must permit localhost sockets. The test still calls no external endpoint.

Bedrock setup and key refresh are in the [extractor runbook](../../intake_agent/extractor/README.md). Short-term keys are region-bound and expire with the generating session, at most 12 hours later; credentials are supplied privately by a person, never read from files for this review. The frozen run remains blocked on Manoella's approval, the isolated builder's development revision and trigger report, checked prompt/transport/shared-code hashes and a human-created tag. No frozen messages, labels or model outputs are required to run the mocked checks above.

After the approved one-time batch, the custodian generates [language/family/authored-segment cuts](EVALUATION.md#language-and-segment-reporting) from its saved result and exact-hash-matched corpus. This calls no model. Missing metadata and sparse groups stay visible; D1 has no segment field, and authored fixture segments are not source-customer segment performance. Do not join fictitious frozen customers to source customers.

## Reproducing service-latency aggregates

Run the aggregate-only analyzer on an authorized local Worker export:

```bash
.venv/bin/python scripts/summarize_worker_latency.py \
  data/observability/tail-2026-10-01.jsonl --route /intake/confirm
```

The export stays ignored. Record route/version, UTC window, capture coverage, timed and missing requests, failures, status counts and the p95 interval. The available old export has one timed report confirmation; it cannot establish the current **p95 below 2 s** target ([latency evidence](EVALUATION.md#10-report-request-latency-evidence-still-incomplete)). A fresh current-version capture remains necessary. Episode duration is a separate measure that includes customer time.

## Rendering the current architecture

[`current-workflow.svg`](../Evidence/diagrams/current-workflow.svg) is the editable source. The checked-in PNG was rendered locally and visually checked, including the state footer. With Chrome installed, from the repository root:

```bash
google-chrome --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --hide-scrollbars --no-first-run --disable-background-networking \
  --window-size=1440,1127 \
  --screenshot=Docs/Evidence/diagrams/current-workflow.png \
  "file://$PWD/Docs/Evidence/diagrams/current-workflow.svg"
```

The taller viewport accommodates Chrome's browser-frame allowance. Inspect the PNG after a source change. The earlier Excalidraw/PNG remains historical evidence of the Access/Basic-gated checkpoint; the Lambda/Postgres diagram remains a production-target design, never deployed.
