# Data and service architecture

**Deployed state:** main `79c324b`, Worker `79aa39a9` (`main-79c324b`), deployed 2026-10-03 by the GitHub Actions deploy workflow, D1 migrations 0001–0020, extractor off. The latest release tag is [v0.2.0](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/releases/tag/v0.2.0); #87–#92 are deployed and not yet tagged. The offline evaluation on Vertex AI (ADR-006 amendment 7) has not run on the frozen set.

![Deployed service, offline data path and gated Vertex AI evaluation](../Evidence/diagrams/current-workflow.png)

The editable diagram is [`current-workflow.svg`](../Evidence/diagrams/current-workflow.svg). The older Excalidraw/PNG records the former Access and Basic gates and is historical. This diagram labels deployed, built and pending work separately.

## Flow

```text
authorized S3 CSV objects (read only)
  -> data_pipelines/bronze: incremental fact partitions, refreshed dimensions
  -> ignored data/bronze Parquet + bronze.* in data/latam_bank.duckdb
  -> data_pipelines/silver: typed, deduplicated silver.dim_* and silver.fact_*
  -> data_pipelines/quality: raw/typed reconciliation and relationship warnings
  -> analytical Gold + reviewed intake serving slice
  -> reviewed D1 seed (online service) and reconciled aggregate reports
```

Bronze is the sole production extraction path. It records `_source_file`, `_ingested_at` and `_source_table`; a watermark tracks the latest process partition. Full refresh writes a staged Parquet snapshot before replacing old local partitions, so corrected or removed partitions do not survive by accident. Missing source data is a failed ingestion. Silver rebuilds from local Bronze, parses text booleans and dates, canonicalizes known country spellings, keeps source vs FX-estimated USD amounts distinct and defensively deduplicates by primary key. Bronze primary-key duplicates still block quality readiness by design, so this dedup is defense-in-depth for runs that are not ready.

## Analytical contract

`process_date` is the processing partition, while `send_date`, `event_date`, `transaction_date`, and similar fields describe occurrence. Silver facts retain the typed processing date where supplied. Query plans should project columns and filter early, then aggregate a fact to the target grain before joining another fact. Product-linked customer events need both an existing product and owner agreement; an existing `product_id` alone is insufficient. Current product and customer dimensions are snapshots, not historical state.

## Readiness and memory

The quality gate queries Bronze and Silver in DuckDB. It reports table/schema presence, raw and deduplicated row counts, required values, domains, processing partitions, date parseability, foreign-key orphans, and known owner/temporal mismatches. Errors block readiness; warnings remain visible for the subsequent metric-specific decision. Its JSON and Markdown reports are ignored under `data/quality_runs/`.

Python keeps only contracts and aggregate counters. DuckDB limits memory and uses ignored `data/duckdb_tmp` for external joins and grouping. Bronze and Silver share the ignored local database; S3 input is never modified. AWS credentials come from the runtime profile via DuckDB's credential chain and are not embedded in code or Docker images.

The previous CSV baseline was retired only after its check semantics were compared on the same controlled source snapshot; [the parity record](../../data_pipelines/quality/PARITY.md) also reconciles the full S3 Bronze run with the installed CSV inventory. The Marketing/Product HTML, intake decision page and aggregates were rebuilt from one verified Silver run and passed the gate in `Docs/archive/marketing/marketing-product-trust.md` (release record); they are in `data_foundation/reports/`.

## Optional transcript-intent enrichment

`make pipeline-with-labels` adds an explicit offline step after quality. It reads two authorized, local SQLite caches of pinned Jev responses and transactionally publishes `enrichment.jev_predictions`, `enrichment.jev_members`, and the current-source view `enrichment.interaction_labels`. It does not invoke Jev or extract source data. The default pipeline remains unchanged.

The view preserves original categories and all interactions. Identity and exact-text hashes bind predictions to current Silver records; absent/new/changed text remains unclassified. `provisional` and `review_required` are model-derived triage statuses, never verified labels; human adjudication remains pending. Confidence is uncalibrated. Rebuild enrichment after a Silver refresh and query the view rather than historical cache tables directly.

DuckDB checks one-to-one interaction/transcript keys and cache membership coverage before publication; failure rolls back the import. Membership streams through a temporary CSV, while the historical 546 distinct-text responses fit in memory. This importer is intended for the bounded historical cache, not an unbounded live classification service. No historical exploratory module is required by the pipeline or Docker image.

## Online path

The pipeline above ends in a reviewed Gold seed loaded into D1. The online service reads only that seed.

```text
browser -> Amazon Cognito: email one-time code -> ID token
browser -> Cloudflare Worker (router, per-IP limit, session from the verified token)
  -> D1 (every statement in back-end/src/store/d1.js)
  -> Amazon SES: notification emails, sent after the response
```

The Worker and D1 remain the single runtime ([ADR-003](../ADRs/ADR-003-intake-single-runtime-worker-d1.md)). Cognito email sign-in and SES notification delivery are deployed ([ADR-007](../ADRs/ADR-007-customer-identity-cognito-email-otp.md)); the shared Access and Basic gates belong to the earlier checkpoint. The Worker enforces role and customer ownership outside model output, stores sessions and cases in D1, and returns a reference only after read-back. SES sandbox restrictions remain. Agent review status records a human workflow step, not a bank resolution.

## Offline learned evaluation

The rule-based checklist and learned extractor are evaluated on the same authored ES/PT workload, under the same deterministic policy. Amendment 7 of [ADR-006](../ADRs/ADR-006-learned-extractor-workers-ai.md) makes Google Vertex AI (`openai/gpt-oss-20b-maas`, the same weights) the evaluation host, because Bedrock inference is blocked on the project's AWS Free plan; historical development used Workers AI. `vertex.py` reuses the committed prompt, body and parsing in `workers_ai.py`. Only synthetic messages, session language/time and a closed vocabulary reach the model. Customer identifiers, transactions and action authority do not.

The online extractor remains off. The frozen run has not occurred: Manoella's approval, the isolated builder's development-only reasoning update, the development trigger report, pre-registration of both implementation files and a human tag are prerequisites. Offline accuracy, live handoff counts and read-only inquiry results stay separate ([EVALUATION](EVALUATION.md)).

## AWS production target

The [Lambda and RDS PostgreSQL target](../Costs/aws-target/) is a priced design with templates, never deployed. Its private networking, standby database and Bedrock endpoint are production-target assumptions. Current AWS use is Cognito/SES alongside the Cloudflare service; the offline evaluation calls Vertex AI; it does not make the online service a Lambda/Postgres deployment.
