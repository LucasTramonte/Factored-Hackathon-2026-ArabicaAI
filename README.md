# ArabicaAI — Factored Hackathon 2026

A customer reports a card charge they don't recognize, confirms which of their own transactions they mean, and gets a reference once the case is stored for human review. That is the V1 workflow ([ADR-002](Docs/ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md)). It is intake with a human handoff: no fraud verdicts, refunds or card blocks. The deployed flow is deterministic. A learned extractor was compared offline with hand-written rules on 60 held-out Spanish and Portuguese cases we wrote: by the majority of 3 runs it got 53 right against the checklist's 23, with no unsafe answer, and 46 of 52 on the cases whose content never leaked during the build ([evaluation](Docs/deliverables/EVALUATION.md)). Whether and where it goes online is [ADR-012](Docs/ADRs/ADR-012-ai-online-only-where-evidence-shows.md), and how is the [AI suggestion plan](Docs/Plans/ai-suggestion-plan.md).

The data is a synthetic LATAM banking dataset. Descriptive counts from it are not measured bank outcomes.

**Evaluators: start with [`SYSTEM_DESIGN.md`](Docs/deliverables/SYSTEM_DESIGN.md).** It tells the whole story in one narrative: the customer and the problem, what we built, how it works, how we know it works, what it costs, and what is missing. The [reading guide](Docs/README.md) then maps each point of the brief to the document that answers it.

![Deployed architecture: Angular, Cloudflare Worker and D1 with Cognito email sign-in and SES sandbox notifications, deployed from GitHub Actions after CI; a read-only S3, Bronze, Silver, quality and Gold batch produces a reviewed D1 seed. The offline evaluation calls Vertex AI and ran once on the frozen set; the online extractor is off. The Lambda and PostgreSQL AWS target was never deployed.](Docs/Evidence/diagrams/current-workflow.png)

*Deployed state: main `a47b2e1`, Worker `d8da20c6`, deployed 2026-10-04 by the GitHub Actions deploy workflow, D1 migrations 0001–0023, extractor off. The latest release tag is [v0.2.0](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/releases/tag/v0.2.0); #87–#106 and #110 are deployed but not yet tagged. Solid paths are deployed; dashed paths are the offline evaluation, which ran once on the frozen set on 2026-10-04 (the diagram's label predates that run).*

## Contents

- [Deliverables](#deliverables)
- [Repository layout](#repository-layout)
- [How it fits together](#how-it-fits-together)
- [Where the AI goes online](#where-the-ai-goes-online)
- [Data pipeline: start here](#data-pipeline-start-here)
- [Offline baseline from supplied CSVs](#offline-baseline-from-supplied-csvs)
- [Common commands](#common-commands)
- [Where to look next](#where-to-look-next)
- [About us](#about-us)
- [Appendix: production targets on AWS and GCP](#appendix-production-targets-on-aws-and-gcp)

## Deliverables

| Deliverable | Document |
|---|---|
| **System design:** the customer, the problem, what we built, the architecture and security, the AI decision, results, cost and risks | [`SYSTEM_DESIGN.md`](Docs/deliverables/SYSTEM_DESIGN.md) |
| **Business outcomes:** the unrecognized-charge problem in numbers, how it's handled today, satisfaction, and what we will and won't claim | [`BUSINESS_OUTCOMES.md`](Docs/deliverables/BUSINESS_OUTCOMES.md) |
| **Data engineering:** the pipeline, contracts, quality gate, lineage, update policy, the findings register (each with its query) and how to reproduce it all | [`DATA_ENGINEERING.md`](Docs/deliverables/DATA_ENGINEERING.md) |
| **Evaluation:** how the model is compared with a baseline, the test sets we built, how leakage is prevented, and the options we considered | [`EVALUATION.md`](Docs/deliverables/EVALUATION.md) |
| **Capacity and cost:** where each layer runs and why, the Cloudflare limits, and a priced AWS production target ([calculator estimate](https://calculator.aws/#/estimate?id=2c6fd3cd749c39840166f0e274fd6813501f5f7e)) | [ADR-004](Docs/ADRs/ADR-004-intake-capacity-and-cost.md) |

## Repository layout

| Folder | What it holds | Who needs it |
|---|---|---|
| [`Docs/deliverables/`](Docs/deliverables/) | The four documents the brief asks for: system design, business outcomes, data engineering and evaluation | Evaluators, first |
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
        │                            ▲            └─► Amazon SES (notification emails)
        └─► Amazon Cognito           │
            (email code → ID token)  evals/intake (checklist baseline, episode scorer) over HTTP
```

The Worker and D1 remain the single runtime ([ADR-003](Docs/ADRs/ADR-003-intake-single-runtime-worker-d1.md)). Cognito proves who signs in, and the Worker issues its own session from the verified token. SES only delivers email; cases stay in D1. These integrations are deployed, with Cognito replacing the former shared gates ([ADR-007](Docs/ADRs/ADR-007-customer-identity-cognito-email-otp.md)). SES remains in the sandbox, so only verified recipients receive email.

Everything merged through #106 and #110 is deployed, including the in-app alert when the bank flags a charge (ADR-011) and session restore on reload. The offline evaluation runs on Google Vertex AI (ADR-006 amendment 7; Bedrock is blocked on the project's AWS Free plan). Extractor v1 was registered, tagged and run once on the frozen set on 2026-10-04: 88% correct against 38% for the rules, 0 unsafe, p95 2,048 ms ([results and limits](Docs/deliverables/EVALUATION.md#1-the-result)).

| Component | Path | What it does |
|---|---|---|
| Data pipeline | `data_pipelines/bronze`, `silver`, `quality` | Reproducible, read-only S3 → typed Silver tables with a readiness audit |
| Gold intake slice | `data_pipelines/gold` | Bounded, quality-gated sample → versioned D1 seed with provenance |
| Intake API | `back-end/` | One online runtime: sessions from Cognito sign-in, customer-scoped retrieval, idempotent cases, reference after commit, the customer's reports, review status, notification emails, agent view |
| Web client | `front-end/` | Customer and agent views; API contracts in `front-end/contracts/` |
| Evaluation | `evals/intake`, [`EVALUATION.md`](Docs/deliverables/EVALUATION.md) | Team-built ES/PT test sets, checklist baseline, learned-component harness, episode KPI scorer |
| Data quality register | [`DATA_ENGINEERING.md`](Docs/deliverables/DATA_ENGINEERING.md), `data_profiles/findings/` | Every dataset finding that changes or limits a decision, with its query, impact and handling |
| Decisions | `Docs/ADRs/` | Scope, runtime, capacity, cost and cloud placement, each with its limitations and exit triggers |

## Where the AI goes online

The model reads better than our rules on held-out cases (53 of 60 against 23 by majority of 3 runs; 46 of 52 against 20 on the never-exposed cases), but the guided flow only needs to read free text in one place: when a customer can't find the charge in their own list. That is where it goes online, behind a switch that is off today ([ADR-012](Docs/ADRs/ADR-012-ai-online-only-where-evidence-shows.md), [plan](Docs/Plans/ai-suggestion-plan.md)).

![Target workflow: the customer's request stays deterministic; for "I can't find it", Vertex AI reads the description after the reference, code suggests up to three of the customer's own charges, the customer confirms and a person reviews; every failure falls back to today's handoff; events feed the pilot measures and the offline evaluation](Docs/Evidence/diagrams/target-workflow.png)

- **The customer never waits for the model.** The reference comes back first; the model runs after the response.
- **The model reads, code decides, a person reviews.** Suggestions come only from the customer's own charges.
- **Every failure is today's flow.** Timeout, provider error, invalid output, no match or a retired model all leave the incomplete handoff as it is.
- **It is measured and can switch itself off.** A randomized pilot measures how often the path is used and how often agents mark suggestions correct. Fixed rules turn it off on any unsafe outcome.

**Live demo:** https://factored-hackathon-2026-arabicaai.lucas-tramonte.workers.dev/. Customers, agents and evaluators sign in with an email one-time code from Amazon Cognito; ask the team to enrol your email. There is no team password ([ADR-007](Docs/ADRs/ADR-007-customer-identity-cognito-email-otp.md), [auth runbook](Docs/Plans/auth-runbook.md)).

What each version contains and what is deployed: [release history](Docs/releases/README.md). What comes next: [intake roadmap](Docs/Plans/intake-roadmap.md).

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

Docker reuses cached build layers on later runs. For a smaller first S3 check, follow the targeted commands in [DATA_ENGINEERING.md](Docs/deliverables/DATA_ENGINEERING.md#11-reproducing-it). CI runs offline tests and compilation without S3 credentials. Docker checks remain available with `make docker-test`.

## Where to look next

- [Data dictionary](Docs/LATAM_BANK_DATA_DICTIONARY.md): exact table, column, and relationship names.
- [Dataset overview](Docs/LATAM_BANK_DATASET.md) and [hackathon brief](Docs/FACTORED_HACKATHON_2026.md): source scope and challenge context.
- [Reproducing the pipeline](Docs/deliverables/DATA_ENGINEERING.md#11-reproducing-it): memory limits, Docker, and troubleshooting commands.
- [Findings register](Docs/deliverables/DATA_ENGINEERING.md#10-findings-register): what the data can and can't support, each finding backed by a reproducible query, and the evaluation data protocol ([ADR-005](Docs/ADRs/ADR-005-evaluation-data-protocol.md)).
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

## Appendix: production targets on AWS and GCP

Design only, never deployed: what this workflow would run on if a bank required private networking, a standby database and its own keys. Both are written as code, drawn from that code and priced at list price for the same volumes.

| | AWS ([`aws-target/`](Docs/Costs/aws-target/)) | GCP ([`gcp-target/`](Docs/Costs/gcp-target/)) |
|---|---|---|
| Written as | CloudFormation, passes `cfn-lint` | Terraform, passes `terraform validate` |
| API and model | Lambda; Bedrock gpt-oss-20b through PrivateLink | Cloud Run; Vertex AI Gemini 3.5 Flash-Lite (global endpoint), after the response through Cloud Tasks |
| Database | RDS PostgreSQL Multi-AZ | Cloud SQL PostgreSQL regional HA |
| Per month | $86.36 ([ADR-004](Docs/ADRs/ADR-004-intake-capacity-and-cost.md) section 3) | $95.38 ([line by line](Docs/Costs/gcp-target/README.md)) |

On both, the standby database is about 60% of the bill. Load would never require it: at 100× the dataset's busiest day the database sees about 145 writes a second, around 1% of what one PostgreSQL primary handles. The [capacity estimate](Docs/deliverables/SYSTEM_DESIGN.md#capacity-the-numbers-before-the-boxes) shows the arithmetic.

![AWS production target: CloudFront and WAF at the edge, HTTP API and Lambda in a two-AZ VPC with RDS PostgreSQL Multi-AZ and a Bedrock endpoint, a daily Fargate batch into an S3 lake](Docs/Costs/aws-target/architecture.png)

![GCP production target: global HTTPS load balancer with Cloud Armor and Cloud CDN, Cloud Run API with Cloud Tasks for the AI suggestion, Cloud SQL PostgreSQL regional HA on a private IP, Vertex AI on the global endpoint, a daily Cloud Run job into a CMEK lake](Docs/Costs/gcp-target/architecture.png)
