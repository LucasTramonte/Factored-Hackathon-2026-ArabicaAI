# ArabicaAI — Factored Hackathon 2026

A customer reports a card charge they don't recognize, confirms which of their own transactions they mean, and gets a reference once the case is stored for human review. That is the V1 workflow ([ADR-002](Docs/ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md)). It is intake with a human handoff: no fraud verdicts, refunds or card blocks. The MVP is deterministic, and a language model is added only if the evaluation shows it's needed.

The data is a synthetic LATAM banking dataset. Descriptive counts from it are not measured bank outcomes.

**Evaluators: start with [`SYSTEM_DESIGN.md`](Docs/deliverables/SYSTEM_DESIGN.md).** It tells the whole story in one narrative: the customer and the problem, what we built, how it works, how we know it works, what it costs, and what is missing. The [reading guide](Docs/README.md) then maps each point of the brief to the document that answers it.

![Current architecture on Cloudflare: browsers pass Cloudflare Access, the Basic gate, the router and the session cookie to the customer, intake and agent modules, whose SQL lives in store/d1.js over D1. Static assets skip the Worker; Workers AI is gated and offline only. An offline DuckDB batch goes from S3 to Bronze, Silver, the quality gate, the Gold slice and a reviewed seed loaded into D1](Docs/Evidence/diagrams/current_workflow_arabica_ai.png)

*What runs today, on Cloudflare (solid: live, dashed: planned). The editable source is [`Workflow - Cloudflare intake.excalidraw`](<Docs/Evidence/diagrams/Workflow - Cloudflare intake.excalidraw>). The priced AWS production target is in the [appendix](#appendix-aws-production-target).*

## Contents

- [Deliverables](#deliverables)
- [Repository layout](#repository-layout)
- [How it fits together](#how-it-fits-together)
- [Data pipeline: start here](#data-pipeline-start-here)
- [Offline baseline from supplied CSVs](#offline-baseline-from-supplied-csvs)
- [Common commands](#common-commands)
- [Where to look next](#where-to-look-next)
- [About us](#about-us)
- [Appendix: AWS production target](#appendix-aws-production-target)

## Deliverables

| Deliverable | Document |
|---|---|
| **System design:** customer, problem, solution, architecture, results, cost and risks, in one narrative | [`SYSTEM_DESIGN.md`](Docs/deliverables/SYSTEM_DESIGN.md) |
| **Evaluation:** how the model is compared with a baseline, the test sets we built ourselves, how data leakage is prevented, and every option we considered | [`EVALUATION.md`](Docs/deliverables/EVALUATION.md) |
| **Data quality:** every finding that changes or limits a decision, each with its query | [`DATA_QUALITY.md`](Docs/deliverables/DATA_QUALITY.md) |
| **Data engineering:** contracts, the quality gate, lineage from S3 to the served row, the update and freshness policy with its test fixture, and the stack with its trade-offs | [`DATA_ENGINEERING.md`](Docs/deliverables/DATA_ENGINEERING.md) |
| **Capacity and cost:** where each layer runs and why, the Cloudflare limits, and a priced AWS production target ([calculator estimate](https://calculator.aws/#/estimate?id=2c6fd3cd749c39840166f0e274fd6813501f5f7e)) | [ADR-004](Docs/ADRs/ADR-004-intake-capacity-and-cost.md) |

## Repository layout

| Folder | What it holds | Who needs it |
|---|---|---|
| [`Docs/deliverables/`](Docs/deliverables/) | The documents the brief asks for: system design, data engineering, data quality, evaluation, plus architecture, business outcomes and reproduction | Evaluators, first |
| [`Docs/`](Docs/README.md) | Decisions ([`ADRs/`](Docs/ADRs/README.md)), workflow contracts ([`intake/`](Docs/intake/)), runbooks and roadmaps ([`Plans/`](Docs/Plans/)), cost evidence ([`Costs/`](Docs/Costs/README.md)), accessibility evidence and diagrams ([`Evidence/`](Docs/Evidence/)), release history ([`releases/`](Docs/releases/README.md)), the organizers' originals ([`sources/`](Docs/sources/README.md)) and dated working notes ([`archive/`](Docs/archive/)) | Anyone checking why a decision was made |
| [`data_pipelines/`](data_pipelines/) | The batch path: S3 → `bronze/` → `silver/` → `quality/` → `gold/` (the reviewed serving slice and cohort), Python and DuckDB | Data engineering |
| [`data_profiles/`](data_profiles/) | The findings register's queries (`findings/queries/DF-*.sql`) and their runner and tests | Data quality |
| [`back-end/`](back-end/README.md) | The only online runtime: the Cloudflare Worker, its D1 migrations and seeds. All SQL is in `src/store/d1.js` | The service |
| [`front-end/`](front-end/README.md) | The Angular client, and the API response contracts in `contracts/` | The service |
| [`intake_agent/`](intake_agent/) | The context card and the learned extractor, with its [development log](intake_agent/extractor/DEV_LOG.md) | AI engineering |
| [`evals/`](evals/intake/README.md) | Decision-point cases, the frozen held-out set, the checklist baseline and the episode KPI scorer | Evaluation |
| [`data_foundation/`](data_foundation/README.md) | Archived pre-pipeline scanner, and the reviewed Marketing/Product report hub | Historical evidence |
| [`notebooks/`](notebooks/README.md), [`reports/`](reports/) | Exploration notebooks and dated reports. They are evidence of how we got here, not current results | Historical evidence |
| [`scripts/`](scripts/) | Small repository tools, such as the Markdown link check CI runs | Maintainers |
| `data/` | Ignored. Local DuckDB, Parquet, quality runs and generated seeds; never committed | Local runs only |

How changes are reviewed, versioned and released is in [`CONTRIBUTING.md`](CONTRIBUTING.md), and each release's PRs, decisions and deployed state are in the [release history](Docs/releases/README.md).

The root keeps only what tools expect there: this README, [`CONTRIBUTING.md`](CONTRIBUTING.md), [`AGENTS.md`](AGENTS.md) (the contract for coding agents), the [`Makefile`](Makefile), the `Dockerfile` and CI under [`.github/`](.github/).

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
| Evaluation | `evals/intake`, [`EVALUATION.md`](Docs/deliverables/EVALUATION.md) | Team-built ES/PT test sets, checklist baseline, learned-component harness, episode KPI scorer |
| Data quality register | [`DATA_QUALITY.md`](Docs/deliverables/DATA_QUALITY.md), `data_profiles/findings/` | Every dataset finding that changes or limits a decision, with its query, impact and handling |
| Decisions | `Docs/ADRs/` | Scope, runtime, capacity, cost and cloud placement, each with its limitations and exit triggers |

**Live demo:** https://factored-hackathon-2026-arabicaai.lucas-tramonte.workers.dev/, behind Cloudflare Access (ask the team to be allowlisted) and a Basic gate. Sign-ins are simulated.

**Status (2026-10-01):**

- The guided intake is deployed (latest Worker version `77f72eb4`, 2026-10-01) and tested by the adversarial gate, session, isolation, idempotency and D1 budget suites:
  - owned ES/PT guided reports, with complete, incomplete and technical handoffs;
  - the agent intake queue and detail with service history;
  - a validated event export and a manual idle sweep;
  - the 796-customer dataset cohort loaded into D1.
- The AI extraction step is wired behind a switch that is off. Its latency fired the trigger, so a faster version comes first ([ADR-006](Docs/ADRs/ADR-006-learned-extractor-workers-ai.md)).
- It runs on the Cloudflare Free plan ($0). [ADR-004](Docs/ADRs/ADR-004-intake-capacity-and-cost.md) sizes the guided flow at about 2,380 complete episodes a day, against measured volumes of 17–818 a day. The same record prices a production target on AWS at $86.36 a month and explains each service choice.
- **Not done yet:**
  - automatic one / several / none classification of free text (waits for the extractor);
  - the frozen comparison;
  - the customer's report status and proactive updates;
  - the cohort refresh path for new data ([DATA_ENGINEERING.md section 8](Docs/deliverables/DATA_ENGINEERING.md#8-if-new-data-arrives-tomorrow));
  - the recent-transactions resolution path (a draft proposal).

  These are covered in the [intake roadmap](Docs/Plans/intake-roadmap.md).

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

`make pipeline` runs **Bronze → Silver → quality**. On a fresh checkout, Bronze loads all available source partitions; later runs ingest newer fact partitions plus any never-loaded partition older than the watermark (without moving it back), and refresh the small dimensions. A correction to a partition already loaded needs `make bronze-full` ([DATA_ENGINEERING.md](Docs/deliverables/DATA_ENGINEERING.md#5-update-and-freshness-policy)). The bucket and region defaults are in the [Makefile](Makefile). Use `AWS_PROFILE=your-profile` if your credentials are under another profile.

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

Docker reuses cached build layers on later runs. For a smaller first S3 check, follow the targeted commands in [REPRODUCIBILITY.md](Docs/deliverables/REPRODUCIBILITY.md). CI runs offline tests and compilation without S3 credentials. Docker checks remain available with `make docker-test`.

## Where to look next

- [Data dictionary](Docs/LATAM_BANK_DATA_DICTIONARY.md): exact table, column, and relationship names.
- [Dataset overview](Docs/LATAM_BANK_DATASET.md) and [hackathon brief](Docs/FACTORED_HACKATHON_2026.md): source scope and challenge context.
- [Architecture](Docs/deliverables/ARCHITECTURE.md) and [reproduction guide](Docs/deliverables/REPRODUCIBILITY.md): pipeline behavior, memory limits, Docker, and troubleshooting commands.
- [Data quality and findings register](Docs/deliverables/DATA_QUALITY.md): what the data can and can't support, each finding backed by a reproducible query, and the evaluation data protocol ([ADR-005](Docs/ADRs/ADR-005-evaluation-data-protocol.md)).
- [Quality parity record](data_pipelines/quality/PARITY.md): the 13-table audit, observed warnings, and comparison with the former CSV scanner.
- [Decision records](Docs/ADRs/README.md): workflow scope, runtime, and capacity and cost, with their limitations.
- [Silver transcript verification](Docs/archive/2026-09-27-silver-transcript-verification.md): the dated record of the 2026-09-27 transcript reconciliation. `notebooks/07_silver_transcript_verification.ipynb` has a network-free readout. Older notebooks and reports are dated historical evidence.
- [Marketing/Product evidence](data_foundation/reports/README.md) and [offline report hub](data_foundation/reports/index.html): reviewed aggregates, limits and reproducible source. This work predates the V1 intake choice; its [customer-backward brief](Docs/archive/marketing/Marketing-Product-PRFAQ.md) is archived.

The dataset is synthetic. Descriptive counts from it should not be presented as measured bank outcomes or causal effects.

## About us

We are three engineers from two coffee countries, Brazil and Colombia, and the name comes from the plant they share. Both grow *Coffea arabica*, the most widely traded coffee species, which originally comes from Ethiopia. The same plant gives two different cups:
- **Brazil,** the world's largest producer, mostly processes its beans naturally (dried in the fruit). The coffee has a dense body, with chocolate and nut notes.
- **Colombia** grows only arabica and mostly washes it. The coffee has a brighter acidity, caramel sweetness and citrus or fruit notes.

| | Role | From | Main contributions |
|---|---|---|---|
| **Manoella** ([@ManoellaR](https://github.com/ManoellaR)) | Data engineer | Santa Catarina, southern Brazil | The Bronze and Silver pipelines, data contracts and profiling, and the data deep-dive findings; the unexposed reviewer of the frozen evaluation |
| **Roberto** ([@Robertzu43](https://github.com/Robertzu43)) | AI engineer | Colombia | The intake evaluation harness and event contract, the guided intake backend, the Angular client and agent view, and the accessibility audit; the native Spanish review of the frozen set |
| **Lucas** ([@LucasTramonte](https://github.com/LucasTramonte)) | Machine learning engineer | Limeira, São Paulo, Brazil | The quality gate and findings register, the Worker and D1 runtime, the ADRs, the capacity and cost record, the learned extractor, the evaluation deliverable and the Gold cohort |

## Appendix: AWS production target

![AWS production target: CloudFront and WAF at the edge, HTTP API and Lambda in a two-AZ VPC with RDS PostgreSQL Multi-AZ and a Bedrock endpoint, a daily Fargate batch into an S3 lake](Docs/Costs/aws-target/architecture.png)

*Design only, never deployed: what this workflow would run on if a bank required private networking, a standby database and its own keys. It is priced at $86.36 a month, service by service, in [ADR-004](Docs/ADRs/ADR-004-intake-capacity-and-cost.md) section 3. Templates and diagram source: [`Docs/Costs/aws-target/`](Docs/Costs/aws-target/).*
