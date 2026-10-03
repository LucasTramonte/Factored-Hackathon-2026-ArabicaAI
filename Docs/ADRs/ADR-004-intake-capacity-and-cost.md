# ADR-004 — Capacity, cost and where each layer runs

- **Status:** Proposed (revised 2026-09-30; first version 2026-09-29)
- **Date:** 2026-09-30
- **Deciders:** Lucas Tramonte, Manoella R, Roberto Z
- **Workflow:** transaction-dispute intake, narrowed to unrecognized card charges with human handoff ([ADR-002](ADR-002-v1-workflow-unrecognized-charge-intake.md)). A read-only recent-transactions view is **proposed** as the normal-resolution path (a draft decision, not yet accepted), and it would be costed with the same API. Why the other three official workflows were not chosen: [ADR-001](ADR-001-workflow-prioritization.md).
- **Supersedes:** the decision section of the former `Docs/Costs/Intake/INTAKE_COST_REVIEW.md`, and the September drafts `ArabicaAI-Architecture-Capacity-Costs-EN.pdf` and `ArabicaAI-Intake-Scale-Plan-EN.pdf`, which were never committed.

This is the only record for cloud cost, sizing and layer placement. `Docs/Costs/` holds the evidence it cites and nothing else.

## Context

The brief asks us to make "explicit trade-offs across autonomy, accuracy, latency, cost, and human oversight" and to "justify where AI is appropriate, where deterministic logic is preferable" (problem statement, p. 2). It also asks for capacity limits, monitoring, access controls, retention and the remaining deployment work (p. 4), and for p50/p95 latency and cost per attempted case and per successful automated resolution, with the workload and assumptions stated (p. 6). Extra workflows earn no automatic bonus (p. 3), and streaming and new model training are not required (p. 4). So what counts is showing where each piece runs and why, with numbers, and what would make us change it. Spending more does not.

Factored confirmed on Slack that the dataset (about 780–900 interactions a day) is not production volume, that a prototype isn't expected to carry full volume, and that recognizing sizing limits is part of the evaluation. Nothing below is a production forecast.

- **Evaluation window:** submissions close on 2026-10-05, finalists are announced on 2026-10-15 and awards follow on 2026-10-16 (kickoff deck, p. 6). Everything online is shut down after 2026-10-20, which shortens the 2026-10-31 window first set in ADR-003.
- **Prototype runtime:** Cloudflare Workers + D1 ([ADR-003](ADR-003-intake-single-runtime-worker-d1.md)).
- **Learned component:** a fact extractor on Workers AI gpt-oss-20b ([ADR-006](ADR-006-learned-extractor-workers-ai.md)). The policy stays deterministic.

### Demand evidence (synthetic sample, full Silver build, 2023-06-17 → 2026-06-18)

| Measure | p50 | p95 | Max |
|---|---|---|---|
| Call-center interactions per day | 664 | 818 | 894 |
| `Queja` interactions per day | 111 | 145 | 169 |
| `Cargo no reconocido` complaints per day (2025) | 11 | 17 | 23 |

The busiest hour held 60 interactions. The hour-of-day profile is flat (about 4.2% of the day every hour), which real contact centres don't show, so peaks use a 3× factor that is an **assumption**. Contacts come from Mexico (50.0%), Colombia (30.1%) and Argentina (19.9%).

### Scenarios, and which layer each one tests

Each scenario answers a different question, so each one binds a different layer:

| Scenario | Per day | Basis | What it tests |
|---|---|---|---|
| S1 | 17 episodes | p95 `Cargo no reconocido` complaints, the closest proxy for V1 demand | Cost per case in scope, where fixed cost weighs most |
| S2 | 145 episodes | p95 `Queja` contacts: the ceiling if every complaint contact were screened by intake | Case storage and AI calls |
| S3 | 818 contacts | p95 of all contacts. Every contact passes authentication and routing, even out of scope | API, edge and WAF capacity (the front door) |
| S4 | 8,180 contacts | 10× S3 | Which limit breaks first |

Because production volume is unknown, costs are also given per unit, so a reader can scale them.

### Measured resources per episode (legacy `/cases` flow)

This is the flow the live demo ran on 2026-09-29. The guided flow that replaces it writes about 4× more rows per episode, and its figures are in section 2.

From `back-end/test/integration/budget.test.js` against local D1, which reads D1's own row counters:

| Unit | Worker requests | D1 queries | D1 rows read | D1 rows written | Source |
|---|---|---|---|---|---|
| Page load (gated HTML document + identity list) | 2 | 0 | 0 | 0 | code |
| Customer: login + list + create case | 3 | 10 | 10 | 7 | measured |
| Agent refresh (session + 50-case page) | 2 | 4 | ≤155 | 3 | 155 is the full-page upper bound |
| **Episode (one of each)** | **7** | **14** | **165** | **10** | |

Rows written include index writes. A case takes about 367 bytes with a typical statement and 4.3 KB at the 2,000-character maximum. In production, Worker CPU was 0–4 ms per request (implementation notes).

Other measured inputs used below:
- **Serving slice:** 996,168 approved purchases at about 214 bytes per row in SQLite with the primary key and customer index, so about 0.21 GB. With customers and cards, about 0.3 GB.
- **Full history:** Silver is 2.86 GB in DuckDB (23.5 M rows), and Bronze is 1.4 GB of Parquet in 7,699 files.
- **Batch:** the full Bronze → Silver → quality build took 11 min 15 s on a laptop, with DuckDB capped at 2–3 GB and 2–4 threads (`data/full_local/pipeline.log`, 2026-09-29).
- **Front-end:** the Angular build is 5 files, 97 KB gzipped.
- **AI:** 2,106 input and 266 output tokens per extraction call, and 48/48 schema-valid outputs (`intake_agent/extractor/DEV_LOG.md`, iteration 4).

## Decision

### 1. Each layer runs where the measured load puts it

| Layer | Open-source or low-cost choice | AWS alternative | What the data says | Decision | Trigger to move |
|---|---|---|---|---|---|
| Batch: Bronze → Silver → Gold | Parquet + DuckDB | Glue, EMR, Athena | 2.86 GB builds in about 11 minutes on one machine | DuckDB, wherever it runs | Over ~100 GB, a build over 1 h, or several concurrent jobs |
| Online store | SQLite (D1) | RDS PostgreSQL, Aurora, DynamoDB | 318 reads and 43 writes per complete guided episode at the CI ceilings; the serving slice is about 0.3 GB | D1 in the prototype, PostgreSQL in the AWS target | A database over 5 GB (ADR-003's exit trigger; Paid caps at 10 GB), write p95 over 200 ms, cross-customer online queries, or a row-level security requirement |
| API | Cloudflare Worker | API Gateway + Lambda, ECS Fargate | 9 requests per complete guided episode, CPU 0–4 ms (legacy flow, measured in production) | Worker in the prototype, Lambda in the AWS target | Section 4 |
| AI extraction | Workers AI gpt-oss-20b ($0.0005 per call, measured) | Bedrock, SageMaker endpoint | 18/18 on development with the corrected labels (16/18 before; ADR-006 amendment 3), p95 3.25 s | Workers AI for development and the frozen evaluation only. The live service calls it after the frozen run, behind a switch that falls back to the deterministic flow (ADR-006, decision 6). The same model runs on Bedrock in the AWS target | The extractor fails the frozen test on quality → the next ADR-006 rung |
| Observability | Workers logs and analytics | CloudWatch, X-Ray | About 29 log events per legacy episode (guided not measured) | Workers logs now, CloudWatch in the target | Moving the runtime |

The pattern is deliberate. Processing stays open source (DuckDB, SQLite, the same model family), and the managed cloud services are the ones a bank needs for availability, private networking and audit. Moving the online store is not free, though: section 3 lists what a migration costs in engineering work.

### 2. The prototype stays on Cloudflare Free for the evaluation window

Capacity is sized on the **guided flow** (`/intake/start` → `/intake/confirm`), which replaces the legacy one-step `/cases` flow. Its budgets were measured in the budget suite on local D1, using D1's own counters and `dbstat` for storage (method and per-request figures under Implementation notes).

- **Per complete episode, with one agent look:** 9 Worker requests, 318 rows read and **43 rows written** at the CI ceilings (285 and 40 measured; one write per handoff is the unique index on the short reference, migration 0008).
- **Daily bound:** rows written binds, so the daily quotas allow **about 2,325 complete episodes a day** (2,500 on measured values; 2,380 and 2,564 before migration 0008). The legacy flow wrote 10 rows and allowed 10,000.
- **Storage per complete episode:** about 5.0 KB with a typical statement, 12.5 KB at 2,000 ASCII characters, and 21.3 KB at the 4-byte worst case. The CI bounds are 5.5, 13.8 and 23.4 KB, and the table below uses them.

| Scenario | Rows written/day (share of Free) | Storage over the window, 22 days to 2026-10-20 (typical / 2,000 ASCII / 4-byte max) | Verdict |
|---|---|---|---|
| S1 | 714 (0.7%) | 2.1 / 5.2 / 8.8 MB | Free |
| S2 | 6,090 (6.1%) | 18 / 44 / 75 MB | Free |
| S3 | 34,356 (34%) | 99 / 248 / 421 MB | Free on daily quotas; at the 4-byte maximum storage passes the 400 MB split trigger, but stays under the 500 MB cap |
| S4 | 343,560 (344%) | 1.0 / 2.5 / 4.2 GB | **Writes exceed the Free quota on day one: Workers Paid first** |

Storage is cumulative, and it binds before the daily quotas at long statements. The table starts from an empty store. At S3 the daily growth is about 4.5 MB (typical), 11.3 MB (2,000 ASCII) or 19.1 MB (4-byte maximum).

| S3 storage baseline | 400 MB split trigger reached after | 500 MB cap reached after |
|---|---|---|
| Empty store (the table above) | about 89 / 35 / 21 days | about 111 / 44 / 26 days |
| Full serving slice loaded first (about 0.3 GB, so 100 MB to the trigger and 200 MB to the cap) | about 22 / 9 / 5 days | about 44 / 18 / 10 days |

So the slice load plus S3-level traffic is a Workers Paid decision, and so is S4.

**Cost of the prototype:** $0 on Free, and $5 a month on Workers Paid, which covers every scenario. **Cost per attempted case** is $0 on Free and $5 ÷ episodes per month on Paid ($0.0098 at S1). **Cost per successful automated resolution** is `not defined` for intake, because V1 always ends in a handoff (ADR-002). It will be reported for the proposed recent-transactions path once that path is decided and measured.

Loading every customer's approved purchases (about 1 M rows) into D1 would take more than 20 days of the Free write quota, because index writes count too. **The team loads a cohort instead, and stays on Free** (2026-10-01):
- **Who and what** (DATA_QUALITY DF-020 to DF-022): customers with a design-window `Cargo no reconocido` complaint, excluding customers whose current status is closed, with their approved purchases that have a merchant in the 120 days before 2026-06-17, capped at 50 each. A customer is served only with at least 3 such purchases. That window lies in the holdout period, so the purchase rule selects members on holdout rows: the cohort serves the demo only, and no metric is computed on it (ADR-005). The manifest records this under `holdout`.
- **Size** as of 2026-06-17: 796 customers (Mexico 388, Colombia 251, Argentina 157) and 2,906 purchases. That is one seed part of 20,620 expected writes (2 per customer, 2 per context card, 6 per transaction), so the load fits one day within the 70,000-write budget per part. The 20,620-write load leaves 79% of that day's quota. A full 70,000-write part plus S3 traffic (34%) would exceed it, so a full part is loaded on a quiet day. The write estimate is derived from the schema: local Wrangler doesn't report rows written, so the loader checks it against remote D1's count on the first remote load.
- **Exclusions,** reported in the manifest: 179 closed complainants, 351 window purchases without a merchant across all eligible complainants, 82 of them belonging to the selected customers (D1 requires one) and 9,038 complainants with fewer than 3 purchases.
- **Why not Workers Paid:** the cohort covers the workflow's own customers at no cost. More rows would add breadth the demo doesn't use (DF-021: most disputing customers have 0 recent purchases).
- **Login reads D1 for the cohort.** `GET /demo/identities` now makes 1 query that reads every `customers` row: about 800 with the cohort, against a CI ceiling of 16 rows on the fixture. Per page load that adds about 800 rows read. At S3 (818 episodes a day) that is about 650,000 more reads a day, 13% of the Free 5 M, so rows written still bind first. Dataset IDs and names stay out of git, as the data terms require (`Docs/FACTORED_HACKATHON_2026.md`).

### 3. The production target on AWS, and what it costs

If a bank ran this workflow, it would ask for private networking, high availability, customer-managed keys and audit. Capacity would not be the reason. That target is estimated in the official calculator, and nothing is deployed from it:

**[AWS Pricing Calculator estimate](https://calculator.aws/#/estimate?id=2c6fd3cd749c39840166f0e274fd6813501f5f7e): $86.36 a month, $1,036.32 for 12 months** (US East (Ohio), On-Demand, list price, free tier not applied because a bank account shares it across workloads, tax excluded). Export: [`Docs/Costs/Intake/aws-pricing-calculator-2026-09-30.csv`](../Costs/Intake/aws-pricing-calculator-2026-09-30.csv).

```mermaid
flowchart LR
  U[Customer and agent browsers] --> CF[CloudFront + WAF]
  CF --> SITE[(S3: Angular build)]
  CF --> API[API Gateway HTTP API]
  API --> L[Lambda arm64]
  subgraph VPC[VPC, 2 AZs, no NAT gateway]
    L --> DB[(RDS PostgreSQL Multi-AZ)]
    L --> VPCE[Interface endpoint]
    B[Fargate batch: DuckDB] --> DB
  end
  VPCE --> BR[Bedrock gpt-oss-20b]
  SCH[EventBridge Scheduler] --> B
  B --> LAKE[(S3 lake: Bronze, Silver, Gold)]
  L -.-> CW[CloudWatch logs, metrics, alarms]
  KMS[KMS key] -.-> DB
  KMS -.-> LAKE
```

![AWS production target: CloudFront and WAF at the edge, HTTP API and Lambda in a two-AZ VPC with RDS PostgreSQL Multi-AZ and a Bedrock endpoint, a daily Fargate batch into an S3 lake](../Costs/aws-target/architecture.png)

The diagram is generated from `Docs/Costs/aws-target/build_diagram.py` and matches the two CloudFormation templates listed in the implementation notes.

The volumes are S3 for the front door (24,880 contacts a month, 124,400 API requests) and S2 for work in scope (4,410 episodes a month).

**Migration work this price doesn't include:**
- porting the store module and migrations from D1/SQLite to PostgreSQL (section 1, Consequences);
- re-registering the extractor on Bedrock;
- handling client IPs in CloudWatch, where logs should keep a truncated address (/24) or drop it, and inherit the 30-day retention.

| Layer | Service | Sizing and its source | $/month | Why this and not the alternative | Trigger |
|---|---|---|---|---|---|
| Edge | CloudFront, pay as you go | 2.7 GB and 275,000 HTTPS requests (24,880 × 97 KB build + API), 50% US incl. Mexico, 50% South America | 0.70 | The always-free 1 TB and 10 M requests would make this $0; list price is shown. The flat-rate Pro plan ($15) caps overage, but Shield Standard is included and the WAF rate rule already bounds abuse | Over 10 M requests a month |
| Edge | WAF | 1 web ACL, 3 AWS managed rule groups (core, known bad inputs, IP reputation), 1 rate rule on the API | 9.17 | Bot Control and account-takeover protection ($10+ each) protect a login that belongs to the bank's identity provider, not to this service | Login moves into this service |
| Edge | S3 (site) | 0.01 GB (last 10 releases of a 326 KB build), 20,000 GETs from cache misses | 0.01 | A static origin, not an application server | — |
| API | API Gateway, HTTP API | 0.125 M requests, bodies capped at 16 KB | 0.13 | A REST API costs about 3.5× more for usage plans and keys we don't use; an ALB is about $16 fixed | Per-partner quotas or request validation |
| API | Lambda | Arm64, 124,400 invocations, 512 MB, 200 ms (assumed, including the in-region database trip) | 0.19 | Section 4 | Section 4 |
| Data | RDS for PostgreSQL | db.t4g.small Multi-AZ, 20 GB, 7-day backups included | 52.05 | Sized for availability and memory (a working set under 1 GB in 2 GiB), not CPU (about 0.25 API requests a second at 3× the busiest observed hour). Single-AZ (about $26 with storage) could lose accepted cases in an AZ failure. The Multi-AZ DB cluster (about 50% more) buys readable standbys we don't need. Aurora Serverless v2 costs more at its minimum. DynamoDB loses the foreign keys and uniqueness the idempotency tests rely on. RDS Proxy (about $22) solves connection pressure we don't have | CPU p95 over 60% or connections over 80% → db.t4g.medium; Lambda connection errors → RDS Proxy; 2–3 stable months → reserved instance |
| Data | PrivateLink | 1 interface endpoint (Bedrock) in 2 AZs, 0.05 GB | 14.60 | A NAT gateway costs about $33 plus traffic. RDS IAM authentication signs tokens locally, so no Secrets Manager endpoint is needed. Tracing uses correlation IDs in Lambda logs, so no X-Ray endpoint either ($14.60 more) | More than 3 AWS services called from the VPC → compare against NAT |
| Data | Public IPv4 | The batch task's address, about 10 h a month, no inbound rules | 0.05 | Private subnets would need 3 more endpoints (about $44) just to pull the image and ship logs | — |
| AI | Bedrock, gpt-oss-20b, In-Region, On-Demand | 5,400 calls entered (1 a minute for 3 h a day over 30 days), a conservative rounding of 4,851 (4,410 episodes × 1.1); 2,106 in / 266 out tokens | 2.57 | The same model weights as the evaluated one, and In-Region keeps processing in us-east-2. A different serving stack can still change outputs and latency at temperature 0 (quantization, chat template, reasoning defaults), so Bedrock is a **new registered version**: it re-runs the development gate and then the frozen set once, after confirming that structured JSON output behaves the same and re-measuring the latency trigger there. That is $0.00048 a call, against $0.0005 on Workers AI. Provisioned throughput bills by the hour for about 160 calls a day. Prompt caching isn't worth the complexity at $2.57 | AI cost over ~$50 a month → prompt caching |
| Batch | S3 (lake) | 13 GB: Bronze 1.4 GB plus 8 Silver/Gold rebuilds kept 7 days by lifecycle; 15,000 PUTs, 250,000 GETs | 0.47 | Standard, because the data is read daily; Infrequent Access charges retrieval and a 30-day minimum on data rewritten every day | Incremental builds would cut GETs |
| Batch | Fargate | 1 task a day, 15 min (11 min 15 s measured, plus margin), 2 vCPU, 4 GB, Arm | 0.60 | The same DuckDB code. Glue at its 2-DPU minimum would be about $6.60 a month and a rewrite to Spark; EMR is for much larger data | Section 1 |
| Ops | CloudWatch | 10 custom KPI metrics, 1.4 GB of logs (0.4 GB of it WAF), 30-day retention, 10 alarms, 1 dashboard | 4.76 | Vended metrics are free. Synthetic canaries (about $10), Lambda Insights, RUM and Application Signals add cost without a question to answer at this volume | Real users → RUM |
| Ops | KMS | 1 customer-managed key, 20,000 requests with S3 Bucket Keys | 1.06 | The AWS-managed key is free but gives no key policy, revocation or separate audit trail | Logs owned by another team → a second key |
| | **Total** | | **86.36** | | |

About three quarters of the total is the Multi-AZ database and the private endpoint. That spend comes from bank requirements, not from volume. Scaled:

| Scenario | AWS $/month | Cost per episode in scope | Cost per front-door contact |
|---|---|---|---|
| S1 volume | about 85 | $0.16 | — |
| Base (S2 in scope, S3 front door) | 86.36 | $0.020 | $0.0035 |
| S4 (10× both) | about 126 | $0.0029 | $0.0005 |

The S4 row scales only the volume-driven lines (CDN, WAF requests, API, Lambda, Bedrock, logs). At ten times the traffic the bill rises by about 46%, and the cost per contact falls by about 7×.

### 4. Lambda for the API, Fargate for the batch

The two services put different work on the team. Lambda leaves the code and the runtime version to maintain; AWS retires Node versions, and ours is pinned in infrastructure code. Fargate adds the container image (base patches, CVE scans), scaling policies, a minimum of two tasks for availability, and health checks. At about 0.05 API requests a second on average, and about 0.25 at 3× the busiest observed hour (60 contacts × 3 × 5 requests), the API is sparse. Lambda costs about $0.20 a month here, and two always-on Fargate tasks cost about $14 idle. The break-even is about 9 M requests a month, 7× the S4 stress case.

The batch is the opposite: one long, predictable job, which fits Fargate.

Move the API to Fargate on any of these:
- more than about 300,000 requests a day sustained;
- a p95 over budget that is caused by cold starts, measured separately from warm requests;
- a need for persistent connections (WebSocket, streaming).

Check the account's Lambda concurrency quota before any pilot, because new accounts can start low.

### 5. Services considered and not used

| Service | Why not | What would change it |
|---|---|---|
| SageMaker real-time endpoint | An ml.g6.xlarge is $1.13/h in us-east-2, about $822 a month always on (more with a second one for availability). Against $0.0005 per call, break-even is about 55,000 calls a day. At the S4 stress case the model gets about 1,600 calls a day (in-scope episodes only), so the endpoint would be about 34× over-provisioned; even if every S4 contact called the model (8,180 a day) it would be about 7× short of break-even. Training our own model is also unsound: the source text is templated (DF-001: 5 distinct complaint descriptions in 67,095 rows), so a model trained on it learns a lookup | Sustained volume above break-even, or a labelled corpus of real customer messages |
| Claude on Bedrock | About 7× (Haiku 4.5) to 14× (Sonnet 5) the cost per call of gpt-oss-20b (section 6) | The extractor fails the frozen test on quality (ADR-006 ladder) |
| Glue, EMR, Redshift, Athena | 2.86 GB builds in minutes with DuckDB | Section 1 trigger |
| Comprehend, Kendra, OpenSearch | Language comes from the session, events carry references only, and the policy is small and deterministic, so retrieval adds risk | Free-text policy content, or an unstructured knowledge base |
| Cognito | Identity belongs to the bank's provider; the brief accepts a trusted test session | A pilot with real customers |
| NAT gateway, RDS Proxy, X-Ray endpoint | Section 3 | Section 3 triggers |
| Hosting the prototype on RDS through Hyperdrive | D1 already holds the serving slice; RDS would add about $18 a month and a network hop with nothing to show for it | D1 triggers in section 1 |

### 6. AI cost, measured and enveloped

The per-call figures use the measured 2,106 input and 266 output tokens. The envelope column keeps the first version's 12k/2k-token episode, which ADR-006 cites for its model ladder.

| Model | Per call, measured tokens | Envelope per episode (12k in, 2k out) | S2, 4,851 calls/month | vs gpt-oss-20b |
|---|---|---|---|---|
| Workers AI gpt-oss-20b ($0.20 / $0.30 per M) | $0.00050 | $0.0030 | $2.43 | 1× |
| Bedrock gpt-oss-20b, In-Region (calculator) | $0.00048 | — | $2.33 | about 1× |
| Workers AI llama-3.3-70b ($0.293 / $2.253 per M) | $0.0012 | $0.0080 | $5.92 | about 2.4× |
| Claude Haiku 4.5 ($1 / $5 per M) | $0.0034 | $0.022 | $16.70 | about 7× |
| Claude Sonnet 5 ($2 / $10 per M) | $0.0069 | $0.044 | $33.30 | about 14× |

At the S4 stress case (10× the in-scope calls), multiply by 10. **Latency and the free allocation are the open questions, not cost.** The development p95 trips ADR-006's 3 s trigger, and the qualification rule and its response are fixed in ADR-006's pre-freeze amendments. On the free allocation the account served fewer than about 280 extraction calls in one UTC day before answering `HTTP 429` (2026-09-30). That bounds any live AI use on Free at a few hundred calls a day. The frozen run (about 180 calls) must start right after a reset, or use Workers Paid ($5 a month plus about $0.011 per 1,000 neurons over the allocation).

### 7. Operating the evaluation window

- **Monitoring:** Workers observability logs at 100% sampling. A weekly check covers requests per day, errors, CPU p95, D1 rows read and written, and database size against the triggers above.
- **Access:** Cloudflare Access in front of the whole hostname, plus the Basic gate on the API and HTML documents. Neither is customer authentication.
- **Retention and shutdown (one date for every document: after 2026-10-20):**
  - **Until 2026-10-15:** nothing is deleted by age before judging ends, so judges see the cases in the recorded demo. Before each recorded demo, the team may reset demo activity only. Expired sessions are purged on every login.
  - **After 2026-10-20:** demo activity is exported for the record, then deleted from the remote D1, and the Worker is taken down.
  - **Deletes follow foreign-key order.** Guided handoffs reference cases (`intake_handoffs.complete_case_id`), and D1 enforces foreign keys, so the old `DELETE FROM cases; DELETE FROM sessions;` recipe fails since migration 0004. Resets and the final delete use `back-end/scripts/reset-demo-activity.sql`: it deletes intake events, turns, handoffs and episodes, then cases, then sessions, and a unit test runs it against the migrations. D1 Time Travel keeps 7 days on Free, so a mistaken reset can be recovered within that period. Customers, transactions, context cards and provenance stay until the seed version is replaced. Nothing here has been run remotely.
  - **Export limit:** the final export is all-or-nothing and bounded at 100 pages × 100 = 10,000 episodes. That is below S3 volume over the window (818 × 22 ≈ 18,000 episodes), which would need segmented exports. They aren't implemented, and this is recorded as a limitation.
  - **Data handling:** no real customer data is ever loaded.
- **AWS:** nothing in the prototype runs on AWS.
  - Spend to date is $0.21 (September 2026), from an exploratory RDS db.t4g.micro (`database-1`, created 2026-09-29, private, empty). It is deleted by 2026-10-20 at the latest.
  - The read-only IAM user used for pricing (`arabica-readonly`) and its access key are deleted at the same time.
- **Remaining deployment work before a real pilot:**
  - real authentication through the bank's identity provider;
  - separate preview and production databases;
  - alerting on the triggers;
  - a load test against the deployed service;
  - a cross-key duplicate rule;
  - data-handling approval for the model provider;
  - the migration in section 3, if the bank requires AWS.

## Consequences

- **+** One place answers where each layer runs, what it costs and what would change it. Every figure is a measurement, a list price, or an assumption named as such.
- **+** The prototype costs $0, and the production target costs $86 a month. Both are explained by requirements, not by volume.
- **+** The batch pipeline (DuckDB) carries over to the AWS target unchanged.
- **−** The online store does not. Moving to PostgreSQL means rewriting `back-end/src/store/d1.js`, which relies on D1 batch atomicity today. The guided backend also relies on SQLite JSON functions (`json_set`, `json_patch`, `json_group_array`), `MIN(a,b)` in an expression index and `strftime`/`printf`. It also means porting the Wrangler migrations and the budget tests that read D1's row counters. The model also needs re-registration (section 3).
- **−** Sizing rests on a synthetic sample with a flat hourly profile. Real peaks and volume could be very different.
- **−** Several inputs are assumptions:
  - the 3× peak factor and the 1.1 retry allowance;
  - 5 API requests for every front-door contact (measured per intake episode, assumed for out-of-scope contacts);
  - about 11 CDN requests per contact;
  - 8 retained rebuilds, 250,000 lake GETs and the log volume;
  - Lambda duration (200 ms) and the 15-minute Fargate budget.
- **−** The calculator estimate excludes tax, credits and free tier, and doesn't check eligibility for any specific account.

## Alternatives considered

- **Host the prototype on AWS with the credits** ($199.79 left on 2026-09-30, up from the $100 recorded in ADR-003). Nothing the evaluation measures would improve, and it would add operations and about $18–86 a month. Rejected. Reopen it if a requirement can't be met on Cloudflare.
- **One ADR per cost decision.** It would scatter sizing across records. Rejected: this record stays the single source, and `Docs/Costs/` holds only its evidence.
- **Size the AWS target for the whole database online.** The workflow reads only the serving slice (about 0.3 GB), and the full history belongs in the lake. Rejected: it would have meant a db.t4g.medium and 50 GB for no measured need.
- **CloudFront flat-rate Pro plan.** It costs $15 against about $9.87 for pay-as-you-go plus WAF, and its advantage (no overage) is already covered. Kept as the option if traffic becomes unpredictable.
- **Buy Workers Paid now.** The guided flow uses about 34% of the Free write quota at S3 (section 2), and the cohort loads within one day's quota (section 2). Rejected, unless traffic reaches S4.

## Implementation notes

- **Evidence in `Docs/Costs/`** (index in [`Docs/Costs/README.md`](../Costs/README.md)):
  - the calculator export `Intake/aws-pricing-calculator-2026-09-30.csv`;
  - the Cloudflare workbook `Intake/INTAKE_COST_ESTIMATE.xlsx`, generated by `scripts/intake_cost/build_workbook.py`.
- **Architecture templates:** the section 3 design as CloudFormation, **design only and never deployed**. Both templates pass `cfn-lint`. AWS Infrastructure Composer needs a paid plan in the console, or WebGL in the VS Code Toolkit, so a static diagram (`architecture.svg` and `architecture.png`) is generated from `build_diagram.py` as well.
  - [`edge-us-east-1.yaml`](../Costs/aws-target/edge-us-east-1.yaml): the WAF web ACL, which CloudFront requires in us-east-1.
  - [`architecture.yaml`](../Costs/aws-target/architecture.yaml): everything else, in us-east-2.
  - **Design details the estimate doesn't show:**
    - HTTP APIs can't carry a WAF, so CloudFront sends a secret origin header that the handler checks. That keeps the API reachable only through the WAF, which is what backs the rate-limit claim above.
    - Angular routes are rewritten to `index.html` by a CloudFront Function on the site behaviour only.
    - The batch loads the serving slice with IAM database authentication.
    - WAF log delivery is not enabled, because WAF logs always carry the full client IP, which this design doesn't keep. Metrics and sampled requests are used instead. The estimate's 0.4 GB of WAF logs ($0.20) is margin the design doesn't use.
  - **Items the estimate leaves out:** two Secrets Manager secrets, the RDS-managed break-glass admin credential and the origin header, at $0.40 a month each. CloudFront Function invocations stay inside the always-free 2 million a month.
- **Calculator caveats, as exported:**
  - The six layers above were entered as one flat group.
  - The RDS line shows gp2. The price is the same as gp3 for Multi-AZ, and the target is gp3, for its 3,000-IOPS baseline at any size.
  - Bedrock was entered as 1 request a minute for 3 hours a day (5,400 calls), a conservative rounding of 4,851.
  - Some line descriptions say "measured" for the 5 API requests per contact and quote 0.35 req/s. The 5 requests are measured per intake episode and assumed for other contacts. This record uses 0.25 req/s: API requests only, at 3× the busiest hour.
- **Prices checked 2026-09-30** with the AWS Price List API (us-east-2) and the calculator:
  - RDS db.t4g.small Multi-AZ $0.065/h; Multi-AZ storage $0.23/GB-month;
  - interface endpoint $0.01/h per AZ; public IPv4 $0.005/h;
  - Lambda Arm $0.0000133334/GB-s; API Gateway HTTP $1.00 per million;
  - SageMaker ml.g6.xlarge hosting $1.1267/h.
- **Budget ceilings in CI** (per request, queries / rows read / rows written / round trips), as committed in `back-end/test/integration/budget.test.js`:
  - legacy flow: login 5/10/6/3, list 2/25/0/2, create 4/12/6/4, agent login 3/6/6/1, agent list 2/250/0/2;
  - guided flow: a complete customer episode 31/82/40/15, and an incomplete one 27/66/32/14 (per-request ceilings in the next note; raised by the 2026-10-02 "received" email note).
- **Measured in production, 2026-09-29** (one manual episode, so a sample rather than a load test):
  - **Placement:** the Worker ran in GRU (São Paulo), and the D1 primary is in ENAM.
  - **CPU and D1:** CPU was 0–4 ms per request. D1 round trips took 136–186 ms (median 148 ms), so latency is dominated by distance to D1, not by compute.
  - **Customer path:** login, list and case add up to about 1.4 s of server time.
  - **Static bundles:** they don't reach the Worker, so an episode is 7 Worker requests, as modelled.
  - **After batching the login writes** (deploy `aa0c804`): customer login went from 514 to 418 ms and agent login from 302 to 161 ms.
  - **Smart Placement** is enabled. No location is claimed until the `cf-placement` header shows `remote-…`.
- **Access changed by ADR-007 (2026-10-02).** Section 7's access line no longer holds once that branch deploys. Customers sign in with a Cognito email code, the Basic gate covers only `/agent`, `/agent/*` and `/demo/*`, and Cloudflare Access is removed from the hostname ([ADR-007](ADR-007-customer-identity-cognito-email-otp.md)).
- **Per-IP limit on the public API paths (2026-10-02).** After the team gate was narrowed to `/agent`, `/agent/*` and `/demo/*`, the customer routes and `/auth/*` are reachable without it, and each anonymous request carrying a cookie-shaped or bearer token costs a D1 read or a JWKS check. The Workers Rate Limiting binding `API_LIMIT` (`wrangler.jsonc`) now allows 60 requests a minute per IP (`CF-Connecting-IP`) on those paths and answers 429 with `Retry-After: 60`, before any store call. Static assets, documents and the team-gated paths are not counted. The count is per Cloudflare location and eventually consistent, so it is an approximate bound, and it is keyed by IP, so a shared NAT shares the budget. Miniflare enforces the binding locally with one shared key, so `run-local.mjs` drops it from the local-D1 suites' config; the 429 path is covered by a unit test.
- **Guided intake flow, measured 2026-09-30 (final schema).** No remote D1, deploy or model call was used.

  > **Dated note (final fix wave, 2026-09-30).** Migration 0004 was edited before merge; it has never been applied remotely. It no longer creates `intake_episodes_updated` or `intake_handoffs_queue`. Migration 0005's idle and queue indexes replaced them and no query used them, so they cost writes for nothing. 0004 now adds CHECK constraints: `intake_episodes.state` must be one of the six states the code writes, `intake_handoffs.destination` must be `case_service`, and `priority` must be `normal`.
  >
  > **Effect of the edit.** Rows written fell for start (13 → 11), start replay (3 → 2), confirm (25 → 22), incomplete (17 → 14) and each abandoned episode in the idle page (4 → 3). The CHECKs added one counted read to each statement that writes an episode row: start 6 → 7, replay 4 → 5, confirm 54 → 56, incomplete 38 → 40 (checked by applying the old and new 0004 to separate scratch D1s). `EXPLAIN QUERY PLAN` over the 38 distinct statements a full flow runs shows no new scan. Every statement is a `SEARCH`, except the two newest-first lists (`/agent/cases`, `/agent/intakes`), which walk their ordering index under `LIMIT` as before.
  >
  > **Dated note (migration 0008, short reference, 2026-10-02).** `intake_handoffs.reference_short` (issue #52) carries a unique index, so every handoff insert writes one more index row: confirm 22 → 23, incomplete 14 → 15, a complete episode 36 → 37 and an incomplete one 28 → 29. These are the only ceilings raised, by that one row each, and the daily bound moves from about 2,380 to about 2,325 complete episodes. Reads, queries and round trips are unchanged: the receipt and the agent views read the column from rows they already read. The column's CHECK uses one short GLOB per four-character group plus `NOT GLOB '*[ILOU]*'` for the excluded letters, instead of one eight-class pattern: D1 caps a GLOB pattern's length and rejected the long pattern at insert time ("LIKE or GLOB pattern too complex"), which Node's SQLite accepts, so unit tests passed while the local-D1 suite failed.
  >
  > **Dated note ("received" email, Task 3.2, 2026-10-02).** The first acknowledgement of a handoff now queues one `received` email in `email_outbox` when the customer has a notification target, as one more `INSERT … SELECT` inside the existing acknowledgement batch, so no round trip is added. It runs before the state change and requires `state='handoff_pending'`, so a replay or a concurrent acknowledgement queues nothing. Measured with a target present (the worst case; without one the statement writes nothing): confirm 18 / 56 / 23 / 8 → 19 / 66 / 26 / 8, confirm replay 17 / 42 / 0 / 7 → 18 / 49 / 0 / 7, incomplete 14 / 40 / 15 / 7 → 15 / 50 / 18 / 7, incomplete replay 14 / 33 / 0 / 7 → 15 / 40 / 0 / 7. New ceilings 19 / 72 / 26 / 8, 18 / 54 / 0 / 7, 15 / 55 / 18 / 7 and 15 / 44 / 0 / 7; episodes 31 / 82 / 40 / 15 (complete) and 27 / 66 / 32 / 14 (incomplete). Each queued email writes 3 rows (the row, its primary key and `email_outbox_recent`). Counting every write an email-signed-in customer adds to a complete episode at the ceilings, 43 becomes 48: those 3, 1 for the encrypted-address upsert at sign-in, and 1 for `markEmail` after the send. The daily bound for that customer falls from about 2,325 to about 2,080 complete episodes (100,000 / 48). Sending happens in `ctx.waitUntil` after the response with its own store, so its 2 queries (read the target, mark the row: 1 read and 1 to 2 writes) are not in these per-request figures but do count toward the invocation's 50-query limit and the daily quotas. Email sign-in folds the encrypted-address upsert into the session batch: 4 / 2 / 3 / 3 → 5 / 3 / 4 / 3, inside the existing login ceiling of 5 / 10 / 6 / 3 (a sign-in that also revokes a presented cookie would be 6 queries; CI measures the cookie-less one).

  > **Dated note ("send me an update", Task 3.3, 2026-10-02).** `POST /reports/update` emails the session customer the status of one of their acknowledged reports. Measured on `CLI-COHORT-2` signed in by email with one report: 3 queries / 12 rows read / 3 rows written / 3 round trips (session, the owned report with its target flag, and one `INSERT … SELECT … WHERE NOT EXISTS` that checks the 5-minute window and writes the row, its primary key and `email_outbox_recent`). New ceiling `reportsUpdate` 3 / 14 / 3 / 3; no other ceiling changes. As with the "received" email, the send runs in `ctx.waitUntil` with its own store and adds 2 queries (1 read, 1 to 2 writes) outside these figures, so one update costs about 4 to 5 writes in all. It is bounded by one `update` email per report per 5 minutes (429 with `Retry-After`) and by the 60-a-minute per-IP limit; at that cap one report adds at most 12 updates and about 60 writes an hour. The window check is inside the insert, so concurrent requests queue one email (an integration test fires two at once); only a refused request reads the newest `update` row to compute `Retry-After`, one more query on the 429 path.

  > **Dated note (review status, migration 0010, Tasks 4.1–4.2, 2026-10-02).** `POST /agent/intake-status` lets a person move a handoff received → in_review → closed. Measured on `CLI-COHORT-2` signed in by email (the worst case, since an email is queued): 5 queries / 24 rows read / 6 rows written / 2 round trips (the agent session, then one batch of four statements: the history row and its unique index, the customer's email with its primary key and `email_outbox_recent`, and the status update). New ceiling `agentTransition` 5 / 26 / 6 / 2; no other ceiling changes. A replay or a refused step writes nothing. Reads add `status` from rows they already read, so the queue, the detail and `/reports` are unchanged. A report that goes through both steps adds at most 12 writes plus about 2 to 4 for the two sends in `ctx.waitUntil`, so the bound for an email-signed-in complete episode taken to closed falls from about 2,080 to about 1,600 a day (100,000 / 62). Steps are made by the team behind the gate, so this is bounded by review throughput, not by customer traffic.

  > **Dated note (one open report per charge, Task 4.4, migration 0011, 2026-10-02).** A new confirmation (not a replay) first checks that the customer has no acknowledged complete report on that charge still `received` or `in_review`, and answers 409 if one exists. The check reads `cases` by customer and charge through the new index `cases_customer_transaction(customer_id, transaction_id)` (migration 0011), then the handoff by `complete_case_id` and the episode by id, so it reads only that charge's reports (EXPLAIN QUERY PLAN: `SEARCH c USING INDEX cases_customer_transaction (customer_id=? AND transaction_id=?)`). A first version filtered handoffs by `json_extract` on the evidence and walked the customer's episodes, about 2 rows per prior episode (117 rows on `demo-ana` after the other suites); an expression index on the evidence did not help, because the plan still started from the customer's episodes. Measured on `demo-ana` after every other suite: confirm 19 / 66 / 26 / 8 → 20 / 67 / 27 / 9 (one query and round trip for the check, one write for the new index entry on the case insert); confirm replay 18 / 49 / 0 / 7 unchanged (it skips the check); the legacy `/cases` create writes 4 → 5, inside its ceiling of 6. New ceilings: confirm 20 / 74 / 27 / 9 and a complete episode 32 / 90 / 41 / 16 (measured 32 / 82 / 41 / 16). A complete episode writes one more row, so 48 becomes 49 for an email-signed-in customer and the daily bound falls from about 2,080 to about 2,040 complete episodes (100,000 / 49). The check is not inside the reservation batch, so two confirms of the same charge in the same instant can still open two reports, and the agent queue shows both.

  > **Dated note (authentication audit, migration 0012, Task 0.2, 2026-10-02).** `auth_events` records `session_started`, `logged_out`, `session_expired` (a well-formed cookie with no live row) and `session_rejected` (a malformed one), with only a 12-hex prefix of the token hash and the request id (`cf-ray`, at most 64 characters). Start and logout add one statement to their existing batch, so no round trip is added; a refused cookie adds one insert after the read, on the 401 path only, and a request with no cookie writes nothing. Logout records a row only when a session of that actor existed, and revokes only that actor's session. Each row costs 1 query, 1 row read and 2 rows written (the row and `auth_events_time`); the id is a plain `INTEGER PRIMARY KEY` without `AUTOINCREMENT`, which would add a `sqlite_sequence` read and write per row, and nothing deletes rows, so ids still increase. Measured: picker login 4 / 2 / 3 / 3 → 5 / 3 / 5 / 3, email sign-in 5 / 3 / 4 / 3 → 6 / 4 / 6 / 3, agent sign-in 2 / 1 / 3 / 1 → 3 / 2 / 5 / 1 (inside its ceiling of 3 / 6 / 6 / 1), logout 1 / 1 / 1 / 1 → 2 / 3 / 3 / 1. New ceilings: login 6 / 10 / 6 / 3, logout 2 / 3 / 3 / 1, a complete episode 33 / 90 / 43 / 16 and an incomplete one 28 / 67 / 34 / 14; every other request is unchanged. An email-signed-in complete episode writes 51 rows instead of 49, so the daily bound falls from about 2,040 to about 1,960 (100,000 / 51). Refused cookies are bounded by the 60-a-minute per-IP limit, at most about 7,200 writes an hour from one IP.
  >
  > **Dated note (urgency lane, Task 5.1, migration 0013, 2026-10-02).** A new confirmation now reads the customer's served purchases once (`listTransactions(customer, 21)`, the chosen charge plus up to 20 others) and applies the stated policy in `back-end/src/config/urgency.json` (DF-024: no high-value tail, so nothing is fitted). Migration 0013 adds `intake_handoffs.urgency` (`normal` or `high`) and a partial index `intake_handoffs_urgent` holding only open high reports. Measured on `demo-ana` (a normal charge, now with 6 served purchases) after every other suite: confirm 20 / 67 / 27 / 9 → 21 / 73 / 27 / 10 (one query and round trip; the 6 rows read are her purchases, at most 21 for any customer). A replay skips it (18 / 49 / 0 / 7 unchanged). The queue reads the high lane and the rest in one batch, so 2 → 3 queries and still 2 round trips; the 50 + 50 tied fixture reads 203 → 204 rows, so the rest still walks `intake_handoffs_queue_protocol`. The new fictitious charge also adds one row to Ana's `/transactions` read. New ceilings: confirm 21 / 74 / 27 / 10, queue 3 / 225 / 0 / 2, a complete episode 34 / 92 / 43 / 17 (measured 34 / 90 / 43 / 17) and an incomplete one 28 / 70 / 34 / 14 (measured 28 / 68 / 34 / 14). Writes are unchanged for a normal charge, since the partial index holds no normal row; a high charge writes one more row at confirmation, its entry in that index. CI measures it on Ana's `demo-tx-006` (BRL 3,890.00) with a notification target: confirm 21 / 75 / 28 / 10 (new ceiling `intakeConfirmHigh` 21 / 77 / 28 / 10), so a high complete episode writes 44; closing it 5 / 24 / 6 / 2, the same as a normal step (new ceiling `agentTransitionHigh` 5 / 26 / 6 / 2), because D1 counts no write for a row leaving the partial index. The daily bound (about 1,960 complete episodes for an email-signed-in customer) is unchanged to the nearest 10. At about 148 ms per remote round trip, the extra round trip adds about 0.15 s to a confirmation (a projection).

  > **Dated note (charge views, ADR-009, migration 0015, 2026-10-02).** `GET /transactions?lang=` inserts one `charge_views` row after the list: 2 / 7 / 0 / 2 → 3 / 8 / 2 / 3 on `demo-ana` (one query and round trip; the row and its primary key). Without `lang` it is unchanged. `POST /transactions/displayed` costs 2 / 3 / 1 / 2 (session, then one `UPDATE … RETURNING`); a replay rewrites the same row, so it costs the same. New ceilings: `listView` 3 / 26 / 2 / 3 (the list's 25 plus the insert's read) and `displayed` 2 / 5 / 1 / 2. From B.5 the client sends both on every load, so the episode ceilings now count 5 requests: a complete episode 37 / 97 / 46 / 20 (measured 37 / 95 / 46 / 20) and an incomplete one 31 / 75 / 37 / 17 (measured 31 / 73 / 37 / 17). Each load writes 3 rows, so an email-signed-in complete episode writes 54 rows instead of 51, and the daily bound at the binding quota (100,000 rows written) falls from about 1,960 to about 1,850 complete episodes. Each sign-in or resume adds another 3 writes and 1 Worker request; requests (100,000 a day) bind much later: 10 Worker requests for an episode with one agent look, about 10,000 a day. The `identities` ceiling moves from 10 to 12 rows only because the fixture gains two customers (the charge-view shapes); that query still reads every `customers` row.
  >
  > **Dated note (evaluator identities, 2026-10-03).** The identities ceiling moves 12 → 16 rows read because the fixture gains four fictitious customers (demo-carla, -diego, -elena, -marco); no code path or per-request cost changes, and the cohort figure (~800) is unchanged.

  > **Dated note (report reasons, ADR-010, migration 0016, 2026-10-03).** `intake_episodes.reason` is one more column in the start's existing insert, and the handoff and agent reads select a column of a row they already load, so queries, writes and round trips are unchanged. Its `CHECK` adds one counted read to each statement that writes an episode row, as 0004's CHECKs did: measured on local D1 with the same code and the migration with and without the `CHECK`, start 6 / 8 / 11 / 2 → 6 / 9 / 11 / 2 and start replay 6 / 6 / 2 / 2 → 6 / 7 / 2 / 2. New ceilings: start 6 / 9 / 11 / 2 and start replay 6 / 7 / 2 / 2. Confirm, incomplete and both episodes stay inside their ceilings: a complete episode measures 37 / 96 / 46 / 20 (ceiling 37 / 97 / 46 / 20) and an incomplete one 31 / 74 / 37 / 17 (ceiling 31 / 75 / 37 / 17), so their read margin is now 1. Rows written, and so the daily bound, are unchanged.

  > **Dated note (review follow-ups, migration 0017 and the auditor route, 2026-10-03).** `intake_episodes.reason_source` is one more column in the start's existing insert, and the agent reads select it from a row they already load: the start, confirm, incomplete and queue ceilings all pass unchanged on local D1. A lost card is now `high` on every kind of handoff, which moves an incomplete one into the urgent lane of the same two-query queue read, so the cost is unchanged. `GET /agent/cases` was removed (issue #69), with its `agentList` ceiling (2 / 250 / 0 / 2). `GET /audit/events` reads no session: one batch of two primary-key or rowid reads, at most `limit` + 1 rows each, measured 2 / 92 / 0 / 1 on the fixture with the default limit. Its ceiling is 2 / 102 / 0 / 1; an auditor's call is an operator read, outside the per-episode bound.
  >
  > **Dated note (atomic one-open-report, 2026-10-03).** The confirm batch's case insert now repeats the open-report check (`NOT EXISTS` over `cases_customer_transaction`, counting `handoff_pending` reservations), so two confirmations racing on one charge open one report. Measured on local D1: confirm 21 / 74 / 27 / 10 (at its ceiling), a high-urgency confirm 21 / 78 / 28 / 10 (ceiling 77 → 78), a complete episode 37 / 97 / 46 / 20 (at its ceiling, no read margin left). Queries, writes and round trips are unchanged, so the daily bound is unchanged.
  >
  > **Dated note (agent detail history and first open, migration 0018, 2026-10-03).** `GET /agent/intake-detail` becomes one batch of three statements: it stamps `first_opened_at` on the first read only (1 write, once per report), reads the detail row, and summarises the same customer's other reports among their newest 21 episodes (new index `intake_episodes_owner_recent`). The read is bounded by that window, not by the customer's history: measured 5 / 46 / 1 / 3 (complete) and 5 / 42 / 1 / 3 (incomplete) on a short history, and up to 73 rows read on the 100-reservation fixture. New ceilings: 5 / 80 / 1 / 3 for both, replacing 3 / 15 / 0 / 3 and 3 / 10 / 0 / 3. The index adds one write to each episode insert: start 6 / 9 / 12 / 2, a complete episode 37 / 97 / 47 / 20 and an incomplete one 31 / 74 / 38 / 17. So the binding daily bound (100,000 rows written) falls by about 2%. An agent's first look at a report adds one write; later looks add none.
  >
  > **Dated note (receipt feedback, migration 0019, 2026-10-03).** `POST /reports/feedback` reads the session, then runs one batch that inserts the first answer and reads it back: measured 3 / 7 / 2 / 2, and a repeated answer 3 / 7 / 0 / 2. Ceiling: 3 / 10 / 2 / 2. It sits outside the episode ceilings, because a customer may never answer. At one answer per complete episode, it adds at most 2 writes, about 4% of an episode's 47.
  >
  > **Review correction (2026-10-03).** A full 21-episode window now sets `customer_history.has_more` even when pending, in-progress or abandoned episodes leave fewer than 20 acknowledged other reports. Counts and latest status/time describe this bounded creation-time window, not all customer history; a late acknowledgement outside it may be omitted. The same single query retains null slots internally and returns only an aggregate summary. No query, write, round-trip or read ceiling was raised. Pickup milliseconds require conversion of the ISO-text `accepted_at` before subtraction from the stored epoch-ms `first_opened_at`; the exact SQLite expression and a millisecond regression fixture are documented in `back-end/README.md` and `test/unit/agent-intake.test.js`.
  >
  > **Local databases.** Anyone who applied the pre-merge 0004 to a local D1 must recreate it: delete `back-end/.wrangler/state`, then reapply migrations and seeds. Local state is ignored and disposable. The figures below are for the final schema; earlier values are kept in the dated notes.

  > **Dated note (sign-in emails, 2026-10-03).** Sign-in codes: 50 emails per day per AWS account under `COGNITO_DEFAULT` (not adjustable; resets at 09:00 UTC); every sign-in sends one ([Cognito quotas](https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html)). Team plus evaluators share that budget on demo day. Lifted by SES production access and `DEVELOPER` ([ADR-007](ADR-007-customer-identity-cognito-email-otp.md#implementation-notes)).

  *Method.* `back-end/test/integration/budget.test.js` reads D1's own counters (`X-D1-Metrics`) on local D1 (Miniflare, Wrangler 4.143.0) through the real Worker. `run-local.mjs` runs it after every other integration suite, so it measures against their retained rows, and its fixtures can't affect them. To separate per-statement costs, a scratch harness (not committed) called the same route handlers against a fresh local D1, read each statement's D1 `meta`, and ran `EXPLAIN QUERY PLAN`. It did this on the seed alone, after a second round, and after bulk fixtures of 5,004 and then 25,006 episodes (60,124 events, 15,006 handoffs, 25,006 sessions, 5,003 cases). Storage comes from SQLite `dbstat` over the Worker's migrations (`back-end/test/unit/intake-storage.test.js`).

  *Per request* (queries / rows read / rows written / round trips) in the CI run, with neighbouring rows present. On an empty store, reads are lower by the look-ahead rows explained below (for example confirm 48, confirm replay 35). Queries, writes and round trips are fixed per path.

  | Request | Measured (final) | Before the 0004 edit | CI ceiling (final) |
  |---|---|---|---|
  | `POST /intake/start` | 6 / 7 / 11 / 2 | 6 / 6 / 13 / 2 | 6 / 8 / 11 / 2 |
  | start replay (same key) | 6 / 5 / 2 / 2 | 6 / 4 / 3 / 2 | 6 / 6 / 2 / 2 |
  | `POST /intake/confirm` | 18 / 56 / 23 / 8 | 18 / 54 / 25 / 8 | 18 / 60 / 23 / 8 |
  | confirm replay | 17 / 42 / 0 / 7 | same | 17 / 45 / 0 / 7 |
  | `POST /intake/handoff` (incomplete) | 14 / 40 / 15 / 7 | 14 / 38 / 17 / 7 | 14 / 42 / 15 / 7 |
  | incomplete replay | 14 / 33 / 0 / 7 | same | 14 / 36 / 0 / 7 |
  | `GET /agent/intakes`, 50 rows behind 50 tied pending reservations | 2 / 203 / 0 / 2 | same | 2 / 225 / 0 / 2 |
  | `GET /agent/intake-detail`, complete | 3 / 12 / 0 / 3 | same | 3 / 15 / 0 / 3 |
  | `GET /agent/intake-detail`, incomplete | 3 / 7 / 0 / 3 | same | 3 / 10 / 0 / 3 |

  The rule for the new ceilings: queries, writes and round trips equal the measured counts, since each is fixed per code path, and a new query or write should fail CI. Rows read get a margin of about 10%, and at least 2 rows, over the populated value, but a ceiling is never raised. That is why start and start replay keep a read margin of 1 after the CHECKs added a read. The largest request, confirm, uses 18 of the 50 queries D1 allows per invocation.

  *Why confirm replay read 42 against a provisional ceiling of 40.*
  - No replay statement scans a population. `EXPLAIN QUERY PLAN` shows an index `SEARCH` for every statement on the path; none is a `SCAN`.
  - Seven statements each read exactly one more row once another index entry follows the looked-up key: `findOwnedIntakeHandoff`, the same lookup at the end of the persistence batch, `readIntakeReceipt`, and the four event `INSERT … SELECT`s of the acknowledgment batch. Each looks up `intake_episodes_owner (customer_id, episode_id)` or the `intake_events (episode_id, seq)` range.
  - So 35 on an empty store becomes 42 once the looked-up keys have a following index entry. At a few episodes that depends on where the random UUIDs fall: it was 42 in some small runs and 35 in others. It was 42 at every larger population measured, including 5,004 and 25,006 episodes, and in the CI run. The other ten statements read the same at every size.
  - Replay breakdown (empty → populated): session 1, episode 1, reservation lookup 2 → 3, session 1, persistence batch 0 + 3 + 0 + 1 + (2 → 3), receipt read-back 5 → 6, acknowledgment batch 2 + 4 × (3 → 4) + 2 + 3.
  - The 42 is a bounded per-lookup constant, so the ceiling is 45 rather than a larger allowance. Making the owner index `UNIQUE` was tried on a scratch copy; it changed several plans and still grew with population.

  *Rows written by index.* Migration 0005's `intake_episodes_idle` adds one write when a start inserts an episode and one when the renewal `UPDATE` rewrites `updated_at`/`expires_at`. Its `intake_handoffs_queue_protocol` adds one per handoff insert. Before the 0004 edit, these explained Task 5's increases: start 11 → 13, replay 2 → 3, confirm 24 → 25, incomplete 16 → 17. The renewal `UPDATE` also matches the just-inserted row on a first start and costs 2 of its 11 writes. Skipping it on first insert is a possible later saving, not made here.

  *Per episode.* Customer requests only, as enforced in CI:
  - **Complete** (login, list, start, confirm): 4 requests, 30 / 69 / 36 / 15, ceiling 30 / 72 / 36 / 15 (was 30 / 66 / 41 / 15).
  - **Incomplete** (login, list, start, handoff): 4 requests, 26 / 53 / 28 / 14, ceiling 26 / 56 / 28 / 14 (was 26 / 50 / 33 / 14).
  - **Abandoned:** login and start, 14 rows written, plus 3 when the idle sweep closes it.
  - **With one agent look, for capacity:** a complete episode also carries the page load (2 Worker requests, no D1) and one agent look (session, queue and detail: 3 requests, 1 + 203 + 12 rows read, 3 rows written). That is **9 Worker requests, 285 rows read and 39 rows written** measured, or 318 read and 42 written at the CI ceilings (the agent login ceiling allows 6 writes, against 3 measured) (was 282 / 44 measured and 318 / 47 at the ceilings). The one-look-per-handoff agent behaviour is an assumption, as in the legacy model.

  *Housekeeping and export* (store calls, CI-enforced).
  - **Idle page:** an atomic page closing 100 episodes costs 2 queries, 1,100 rows read, 300 rows written and 1 round trip (11 read and 3 written per closed episode); ceiling 2 / 1,210 / 300 / 1.
    - *History:* the first Task 5 sweep hard-coded the end event at sequence 1 and read 800 / wrote 400. The fix wave appended the end at the episode's next sequence number and checked that the latest event is the abandoned end (1,100 / 400). The final wave reads the latest event once per episode and skips an episode whose latest event already ends it, so reads stay 1,100. The 0004 edit dropped writes to 300.
    - The page limit bounds the cost, not the population: 1,100 at CI size, 5,004 and 25,006 episodes.
  - **Sweep with nothing due:** 2 / 6 / 0 / 1 (ceiling 2 / 10 / 0 / 1). The final due probe that sets `complete` costs 1 / 1 / 0 / 1 (ceiling 1 / 3 / 0 / 1).
  - **Export page:** 1 query reading **2 rows per episode (its page entry and the look-ahead that ends its event range) plus its events**. CI measured 416 rows for 100 episodes with 216 events, and 327 for a page of 77 episodes (174 events) after a cursor; the last episode in the table has no look-ahead. The CI ceiling is computed per page as 2 × episodes + events + 2. It is at most 702 for a full page, because the guided producer writes at most 5 events per episode.
  - **Scan sensitivity:** on a scratch store of 130 episodes, the old flat ceiling of 700 accepted an injected full scan of `intake_episodes` (530 rows), and the computed ceiling of 402 rejects it. A full scan of `intake_events` read 23,300 rows and fails both.
  - **Full export:** one page query per page. The integration run exported 18 episodes in 3 pages of 7, reading 82 rows.

  *Paths without a CI budget.*
  - **Technical handoff:** the technical-handoff branch of confirm needs a failing transaction lookup. That can't happen on local D1 without fault injection, so CI doesn't budget it. A scratch run with an injected lookup error, on the pre-edit schema, measured technical confirm 14 / 38 / 17 / 7, its replay 15 / 33 / 0 / 7 and its agent detail 3 / 7 / 0 / 3. It was not re-measured after the 0004 edit; its writes follow the incomplete path's. These figures are not CI-enforced.

  *Queue scan and pending density.* The queue walks `intake_handoffs_queue_protocol` newest first and skips pending reservations. It reads about 1 + 2 × (51 + P) rows, where P is the number of pending reservations ahead of the 51st acknowledged one: 203 in the 50 + 50 tied fixture. A pending reservation exists only while an acknowledged read-back is outstanding (a lost response or an expired session), and nothing expires it. So P has no structural bound, and the fixture is a qualified workload, not a universal scan bound. Watch the count of `handoff_pending` episodes in the weekly check.

  *Storage per episode* (dbstat: rows, index entries and B-tree free space; repeated runs agreed within 1%; CI bound in brackets; before the 0004 edit in parentheses):

  | Statement | Complete | Incomplete |
  |---|---|---|
  | typical 77 code points | 4,997 B [5,500] (5,161) | 3,318 B [3,700] (3,482) |
  | 2,000 ASCII characters | 12,534 B [13,800] (12,739) | 7,045 B [7,800] (7,209) |
  | 2,000 four-byte code points (worst case) | 21,299 B [23,400] (21,422) | 11,674 B [12,900] (11,837) |

  Typical complete episode by table: episode 614 B, 2 turns × 348 B, 5 events × 434 B, handoff 1,024 B, case 492 B. The statement is stored twice for a complete episode, once in the episode and once in the case. Sessions are excluded because they are purged at expiry.

  *Capacity on Free.* Using the CI ceilings (9 requests, 318 rows read, 42 rows written per complete episode), the daily quotas allow 11,111 episodes by requests, 15,723 by rows read and **2,380 by rows written** (was 2,127 before the 0004 edit). Rows written binds; measured values give 2,564. The scenario table and storage over the window are in section 2. On Workers Paid, S4 needs 10.3 M rows written, 78 M read and 2.2 M requests a month, all inside the included usage, so only the $5 base applies.

  *What these figures don't show.*
  - They are local D1 counters on bounded fixture workloads (at most 25,006 episodes, and a 50 + 50 pending queue). That is not a universal scan bound, a production measurement or an approved Gold import size.
  - Worker CPU, remote D1 latency and Workers Logs events per guided request are not measured. The only remote evidence is still the legacy episode of 2026-09-29, about 148 ms per D1 round trip from GRU. At that rate, confirm's 8 round trips would spend about 1.2 s waiting on D1. That is a projection, not a measurement.
  - Retries, replays, renewals, queue refreshes beyond one per handoff, and operator runs add to these costs.
  - Production safety is `not_assessed`.
  - Outcome counts depend on sweep discipline. The idle deadline is applied only by the manual sweep, so an episode is abandoned only if a sweep runs before the customer returns. The procedure is to sweep immediately before each export, at the same cutoff. Enforcing the deadline online would change the reviewed same-owner resume behaviour and needs a team decision.
  - **One agent queue:** `/agent/intakes` is the only agent list; the legacy `GET /agent/cases` was removed on 2026-10-03 (issue #69). Details in [`intake-events.md`](../intake/intake-events.md#legacy-case-list).
  - The workbook (`INTAKE_COST_ESTIMATE.xlsx`) still models the legacy `/cases` flow. It was not regenerated for the guided flow.
- **Observability limits:**
  - Workers Logs Free allows 200,000 events a day, about 6,900 legacy episodes at 29 events each; head sampling applies after that. Log events per guided episode are not measured.
  - Logs are kept 3 days.
  - `Authorization` and `Cookie` are redacted.
  - The client IP is logged, so exported logs stay in the ignored `data/observability/`. On the AWS target, logs keep a truncated IP (/24) or drop it (section 3).
- **Sources:**
  - Cloudflare: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Zero Trust plans](https://www.cloudflare.com/plans/zero-trust-services/).
  - AWS: [Pricing Calculator](https://docs.aws.amazon.com/pricing-calculator/latest/userguide/what-is-pricing-calculator.html), [Price List API](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html), [CloudFront](https://aws.amazon.com/cloudfront/pricing/), [Lambda](https://aws.amazon.com/lambda/pricing/), [RDS for PostgreSQL](https://aws.amazon.com/rds/postgresql/pricing/), [Bedrock](https://aws.amazon.com/bedrock/pricing/), [VPC](https://aws.amazon.com/vpc/pricing/).

**2026-10-03 linked follow-up (#90):** migration 0020 adds a nullable prior-handoff FK to the new episode, never reopens the source. The optional linked-start path verifies one closed acknowledged owner-scoped source and a live session inside its batch. Native local-D1 linked start measures `7 / 19 / 12 / 2`; replay `7 / 17 / 2 / 2`, checked as separate ceilings in `report-again.test.js`. Unlinked requests retain their existing ceilings. These are bounded fixture counters, not remote latency or live safety evidence.

**2026-10-03 review follow-up (#87):** a complete pending reservation blocks its charge for one session lifetime (one hour from its immutable `accepted_at`). The fast read and atomic reservation batch use the same cutoff. Acknowledgement checks that cutoff in its atomic batch too, so an expired reservation cannot later create a second acknowledged report. Same-owner renewal resumes a reservation within that hour; acknowledged reports remain open until a person closes them, regardless of age. Expired reservations remain stored and pending in episode accounting; the queue still skips them, so this does not bound queue scan density. No migration or API response-schema change.

**2026-10-03 #88 review measurement:** after preserving null slots for saturated history windows, the native local-D1 fixture with 50 acknowledged plus 50 tied pending handoffs measures detail `5 / 78 / 1 / 3` (queries / rows read / rows written / round trips), with 10 visible other reports and `has_more: true`; queue remains `3 / 204 / 0 / 2`. Both pass the existing ceilings; no ceiling was raised. Combined #87–#88 validation: unit 178/178, integration 75/75, budgets 4/4.

**2026-10-03 #89 authority review measurement:** feedback rechecks the customer session inside both insert and read-back statements. Native local D1 now measures `3 / 9 / 2 / 2`, replay `3 / 9 / 0 / 2`, replacing the earlier 7-row-read observation. The existing `3 / 10 / 2 / 2` ceiling passes unchanged. Combined stack checks: Worker unit 182/182, integration 76/76, budgets 4/4; focused customer Angular 103/103.

**2026-10-03 delayed-acknowledgement race (#87):** a request can capture its time before expiry but reach D1 after a replacement report. The acknowledgement batch now also excludes any newer persisted report for that owned charge, even if the replacement has since closed, and any other still-open report. Each of its seven pending writes performs an indexed check on that charge. Native local D1 measures normal confirm `21 / 102 / 27 / 10` (28 additional reads), and high confirm `21 / 120 / 28 / 10` (42 additional reads because its fixture also contains an earlier closed report on that charge). The corresponding read ceilings become 102, 120 and 125 for normal confirm, high confirm and the normal complete episode; queries, writes and round trips remain unchanged. These scan costs are qualified by the fixture charge history, not a universal bound on repeated reports for one charge. An already acknowledged episode skips the extra scan on replay; live-session checks and pending-state SQL write guards remain active. No migration. Regression preserves zero writes for delayed acknowledgements behind pending, accepted and closed replacements.
