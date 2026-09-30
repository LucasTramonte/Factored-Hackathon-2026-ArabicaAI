# ArabicaAI — Factored Hackathon 2026

A customer reports a card charge they don't recognize, confirms which of their own transactions they mean, and gets a reference once the case is stored for human review. That is the V1 workflow ([ADR-002](Docs/ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md)). It is intake with a human handoff: no fraud verdicts, refunds or card blocks. The MVP is deterministic, and a language model is added only if the evaluation shows it's needed.

The data is a synthetic LATAM banking dataset. Descriptive counts from it are not measured bank outcomes.

## How it fits together

```
S3 (read-only) ─► Bronze ─► Silver ─► quality gate ─► Gold intake slice ─► reviewed D1 seed
                   data_pipelines/ (Python + DuckDB, batch)                      │
                                                                                 ▼
 Angular client (front-end/) ─► Cloudflare Worker API + D1 (back-end/) ─► agent queue
                                            ▲
                     evals/intake (checklist baseline, episode scorer) over HTTP
```

| Component | Path | What it does |
|---|---|---|
| Data pipeline | `data_pipelines/bronze`, `silver`, `quality` | Reproducible, read-only S3 → typed Silver tables with a readiness audit |
| Gold intake slice | `data_pipelines/gold` | Bounded, quality-gated sample → versioned D1 seed with provenance |
| Intake API | `back-end/` | One online runtime: sessions, customer-scoped retrieval, idempotent cases, reference after commit, agent view |
| Web client | `front-end/` | Customer and agent views; API contracts in `front-end/contracts/` |
| Evaluation | `evals/intake` | ES/PT decision-point cases, checklist baseline, episode KPI scorer |
| Data quality register | [`DATA_QUALITY.md`](DATA_QUALITY.md), `data_profiles/findings/` | Every dataset finding that changes or limits a decision, with its query, impact and handling |
| Decisions | `Docs/ADRs/` | Scope, runtime, capacity and cost, each with its limitations and exit triggers |

**Live demo:** https://factored-hackathon-2026-arabicaai.lucas-tramonte.workers.dev/, behind Cloudflare Access (ask the team to be allowlisted) and a Basic gate. Sign-ins are simulated.

**Status (2026-09-29):**

- The deterministic intake flow is deployed and tested. That covers the adversarial gate, session, isolation and idempotency suites and a D1 budget test.
- It runs on the Free plan, which [ADR-004](Docs/ADRs/ADR-004-intake-capacity-and-cost.md) sizes at 10,000 episodes/day for the legacy one-step `/cases` flow, against measured volumes of 17–818 per day. The guided intake flow (`/intake/*`, backend branch, 2026-09-30) writes more rows per episode, so ADR-004 sizes it at about 2,100 complete episodes/day.
- **Not done yet:** retrieval-outcome states, case kinds, ES/PT interface text, event instrumentation, and any AI. These are covered in the [intake roadmap](Docs/Plans/intake-roadmap.md).

Quick starts:

- **Data:** see below.
- **Intake service:** see the [runbook](Docs/Plans/intake-demo.md).

## Data pipeline: start here

For local runs, you need Python 3.10+ and GNU Make. For container runs, you need Docker and GNU Make; Python is installed in the image. Full S3 runs need several GB of free disk space and access to the organizer's bucket through an AWS profile. The offline route below uses supplied local CSVs. The repository contains no raw data or credentials. Use an AWS profile or temporary role credentials; **do not add access keys to a repository `.env` file**.

From the repository root:

```bash
make setup       # create .venv and install pipeline dependencies
make test        # run offline fixtures; no S3 access needed
make pipeline AWS_PROFILE=default
```

To run entirely in Docker, use the same profile without creating a local virtual environment:

```bash
make docker-test
make docker-pipeline AWS_PROFILE=default
```

Both Docker targets build the image before running it. `docker-pipeline` mounts `data/` writable and your `~/.aws` directory read-only at runtime; credentials are never copied into the image.

`make pipeline` runs **Bronze → Silver → quality**. On a fresh checkout, Bronze loads all available source partitions; later runs ingest only newer fact partitions and refresh the small dimensions. The bucket and region defaults are in the [Makefile](Makefile). Use `AWS_PROFILE=your-profile` if your credentials are under another profile.

Before a full run, you can check read access without printing credentials:

```bash
aws s3 ls s3://factored-datathon-2026-s3-157725502942-us-east-2-an/data/
```

The source CSVs are never modified. DuckDB, Parquet, temporary files, and audit runs stay under ignored `data/`. A successful pipeline run creates `data/latam_bank.duckdb` with `bronze.*` source tables and typed `silver.dim_*` / `silver.fact_*` tables. Read the latest `data/quality_runs/<run-id>/quality_report.md` for the readiness result and `quality_results.json` for every numerator and denominator.

A zero-error quality run means the tables are structurally ready to query. It does **not** validate campaign attribution or every customer-to-product link. Review the warnings and the [full parity record](data_pipelines/quality/PARITY.md) before using a relationship in a metric.

## Offline baseline from supplied CSVs

If the CSVs are installed locally, run `make setup` and `make pipeline-local`. Once Python dependencies are installed, this reads the CSV tree in `data/` and builds the same Bronze → Silver → quality audit without S3, AWS credentials, or DuckDB extension downloads. Set `SOURCE_DIR=/path/to/csv-root` when the CSVs are elsewhere. The first run scans the local dataset; subsequent local runs intentionally refresh all source partitions so corrections and deletions are visible. Use a separate `DATA_DIR` for an offline run if you also maintain an S3-backed database.

## Common commands

| Command | Purpose |
|---|---|
| `make test` | Run Bronze, Silver, and quality fixtures without S3. |
| `make bronze` | Refresh dimensions and ingest newer fact partitions from S3. |
| `make pipeline-local` | Build and audit the supplied local CSVs entirely offline. |
| `make bronze-full` | Rebuild Bronze when an older source partition was corrected or removed; follow with `make silver` and `make quality`. |
| `make silver` | Rebuild typed analytical tables from local Bronze. |
| `make findings` | Run the data findings queries on the Silver DuckDB and write aggregates to ignored `data/findings_runs/`. |
| `make quality` | Check all 13 Bronze/Silver table pairs and their relationships. |
| `make report QUALITY_REPORT=data/quality_runs/<run-id>/quality_results.json` | Rebuild an ignored Marketing/Product report run from the verified Silver database. |
| `make docker-test` | Run offline tests in the code-only container. |
| `make docker-pipeline` | Run the pipeline with local `data/` and `~/.aws` mounted at runtime. |
| `make intake-setup` / `make intake-test` | Install and test the intake service: Gold slice, Angular specs, and Worker unit and local-D1 tests. |
| `make intake-sample-slice` | Build the reviewed D1 seed from the one-day quality-gated sample (see the intake runbook). |

Docker reuses cached build layers on later runs. For a smaller first S3 check, follow the targeted commands in [REPRODUCIBILITY.md](REPRODUCIBILITY.md). CI runs offline tests and compilation without S3 credentials. Docker checks remain available with `make docker-test`.

## Where to look next

- [Data dictionary](Docs/LATAM_BANK_DATA_DICTIONARY.md): exact table, column, and relationship names.
- [Dataset overview](Docs/LATAM_BANK_DATASET.md) and [hackathon brief](Docs/FACTORED_HACKATHON_2026.md): source scope and challenge context.
- [Architecture](ARCHITECTURE.md) and [reproduction guide](REPRODUCIBILITY.md): pipeline behavior, memory limits, Docker, and troubleshooting commands.
- [Data quality and findings register](DATA_QUALITY.md): what the data can and can't support, each finding backed by a reproducible query, and the evaluation data protocol ([ADR-005](Docs/ADRs/ADR-005-evaluation-data-protocol.md)).
- [Quality parity record](data_pipelines/quality/PARITY.md): the 13-table audit, observed warnings, and comparison with the former CSV scanner.
- [Decision records](Docs/ADRs/README.md): workflow scope, runtime, and capacity and cost, with their limitations.
- [Silver transcript verification](Docs/intake/silver-transcript-verification.md): the current transcript reconciliation. `notebooks/07_silver_transcript_verification.ipynb` has a network-free readout. Older notebooks and reports are dated historical evidence.
- [Marketing/Product evidence](data_foundation/reports/README.md) and [offline report hub](data_foundation/reports/index.html): reviewed aggregates, limits and reproducible source. The [customer-backward brief](Docs/Marketing-Product-PRFAQ.md) frames the proposed test.

The dataset is synthetic. Descriptive counts from it should not be presented as measured bank outcomes or causal effects.
