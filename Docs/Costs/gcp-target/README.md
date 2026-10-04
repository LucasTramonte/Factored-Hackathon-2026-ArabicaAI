# GCP production target (design only, never applied)

The same workflow as the [AWS production target](../aws-target/architecture.yaml), drawn for Google Cloud so the two can be compared on equal terms. The live prototype runs on Cloudflare Workers + D1 ([ADR-003](../../ADRs/ADR-003-intake-single-runtime-worker-d1.md)), and nothing here has been applied.

- [`main.tf`](main.tf): the design as Terraform, the format Google's Infrastructure Manager deploys. Deployment Manager, the closest thing GCP had to CloudFormation, is being retired. `terraform validate` passes; that is the only check run.
- [`architecture.png`](architecture.png): the diagram, generated from [`build_diagram.py`](build_diagram.py) with the same helpers and layout as the AWS one.

![GCP production target: global HTTPS load balancer with Cloud Armor and Cloud CDN, Cloud Run API with Cloud Tasks for the AI suggestion, Cloud SQL PostgreSQL regional HA on a private IP, Vertex AI Gemini 3.5 Flash-Lite in the US multi-region, a daily Cloud Run job into a CMEK Cloud Storage lake](architecture.png)

## What it costs

The volumes are the AWS target's (ADR-004, section 3): the S3 front door (24,880 contacts and 124,400 API requests a month) and S2 for the work in scope (4,410 episodes, rounded up to 5,400 model calls). Prices are list prices for `us-central1`, read from the Cloud Billing Catalog API on 2026-10-04. Free tiers are not applied, so the comparison with AWS is fair.

| Layer | Service | Sizing | $/month | AWS counterpart ($) |
|---|---|---|---|---|
| Edge | External Application Load Balancer | 1 forwarding rule ($0.025/h), 2.7 GB processed ($0.008/GB) | 18.27 | CloudFront 0.70 + API Gateway 0.13 |
| Edge | Cloud Armor (standard) | 1 policy ($5), 3 rules ($1 each), 275,000 requests ($0.75/M) | 8.21 | WAF 9.17 |
| Edge | Cloud CDN + Cloud Storage site | 2.7 GB cache egress ($0.08/GB), 0.01 GB stored | 0.22 | S3 site 0.01 |
| API | Cloud Run, request-based | 124,400 requests × 200 ms × 1 vCPU, 512 MiB ($0.000024/vCPU-s, $0.0000025/GiB-s, $0.40/M requests); plus 5,400 suggestion tasks × 2 s | 0.95 | Lambda 0.19 |
| API | Cloud Tasks | 5,400 dispatches | 0.00 | — (Lambda async invoke) |
| Data | Cloud SQL for PostgreSQL | db-g1-small, regional HA ($0.07/h), 20 GB SSD HA ($0.34/GB), backups (~2 GB, $0.08/GB) | 58.06 | RDS Multi-AZ 52.05 |
| Data | Private access to Google APIs | Private Google Access, no endpoint or NAT | 0.00 | PrivateLink 14.60 + public IPv4 0.05 |
| AI | Vertex AI, Gemini 3.5 Flash-Lite, `us` multi-region | 5,400 calls × 2,106 input / 266 output tokens ($0.33 / $2.75 per M, the "Regional" SKU; global is $0.30 / $2.50) | 7.70 | Bedrock gpt-oss-20b 2.57 |
| Batch | Cloud Run job + Cloud Scheduler | 1 run a day, 15 min, 2 vCPU, 4 GiB; 1 scheduler job | 1.29 | Fargate 0.60 |
| Batch | Cloud Storage lake | 13 GB Standard, 15,000 class A and 250,000 class B operations | 0.44 | S3 lake 0.47 |
| Ops | Cloud Logging | 1.4 GB ingested at the $0.50/GB list price. Google's free monthly allotment (50 GB a project) would make this $0, but free allotments are excluded everywhere in this table | 0.70 | CloudWatch 4.76 |
| Ops | Cloud KMS + Secret Manager | 1 key version, 20,000 operations; 2 secret versions | 0.24 | KMS 1.06 |
| | **Total** | | **96.08** | **86.36** |

**What decides the total is the same on both clouds:** a standby database. It is $58 here (about 60% of the total) and $52 on AWS (also about 60%), and it is driven by availability, not by load (see the capacity estimate in [`SYSTEM_DESIGN.md`](../../deliverables/SYSTEM_DESIGN.md#capacity-the-numbers-before-the-boxes)). The fixed costs differ by shape:
- **GCP:** a load-balancer forwarding rule ($18), but private access to Google APIs is free.
- **AWS:** a private endpoint ($15), but its edge and API are almost free at this volume.

**Two choices worth stating:**
- **`db-g1-small` is a shared-core machine.** Google doesn't cover shared-core instances with the Cloud SQL SLA. A bank that needs the SLA takes `db-custom-1-3840` (1 dedicated vCPU, 3.75 GB), regional: about $98.60 a month for the instance plus storage, about $137 in total.
- **The model is `gemini-3.5-flash-lite` in the `us` multi-region** (`aiplatform.us.rep.googleapis.com`, location `us`), so customer text is processed inside the United States. It answered there and in `eu` on 2026-10-04 (HTTP 200); none of the 10 single regions we tried serves it (404). The global endpoint would be $0.70 a month cheaper but pins nothing. The regional `gemini-2.5-flash-lite` would cost $1.71 a month, but a reviewer cites Google's lifecycle page retiring it on 2026-10-20, so it can't be the successor ([AI suggestion plan](../../Plans/ai-suggestion-plan.md)). Nothing serves it inside Latin America; a bank that needs that would self-deploy open weights on a regional endpoint (a dedicated GPU, roughly $800 a month).

**Not included, as on AWS:**
- the bank's identity provider, which replaces the demo's Cognito sign-in;
- transactional email, since GCP has no native equivalent of SES. A bank would use its own provider;
- the migration work: porting `store/d1.js` and the migrations from SQLite to PostgreSQL, and re-registering the extractor on its new model.

## Which cloud

Neither wins on capacity at this volume, and on cost they are about 11% apart, less than one line item's worth of difference. Choose by what the bank already runs:
- its identity provider and key management;
- where its audit logs go;
- whether its data must stay in a given region. Neither cloud offers the evaluated model family in São Paulo today.

Two things favour GCP for this workload specifically:
- **The model.** The AI path was measured on Vertex AI, and latency and stability are properties of the host as much as of the model.
- **Private access to the model is free.** It costs $15 a month on AWS.

The AWS target already exists, was priced through the calculator and passes `cfn-lint`.
