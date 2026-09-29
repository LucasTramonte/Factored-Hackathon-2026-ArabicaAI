# ADR-004 — Intake capacity and cost for the evaluation window

- **Status:** Proposed
- **Date:** 2026-09-29
- **Deciders:** Lucas Tramonte, Manoella R, Roberto Z
- **Supersedes:** the decision section of the former `Docs/Costs/Intake/INTAKE_COST_REVIEW.md` (removed; this record and the workbook replace it)

## Context

The brief asks for capacity limits, latency and cost trade-offs, cost per attempted case, the workload behind each figure, and the cost assumptions. On Slack, Factored confirmed that the dataset sample (about 780–900 call-center interactions a day) doesn't represent production volume. They said a prototype isn't expected to handle full volume, and that recognizing sizing limits is part of the evaluation. So this record sizes the service against the volumes we measured and the limits of the platform, and it makes no production forecast.

- **Window:** 2026-09-29 → 2026-10-31. Finalists are announced on 2026-10-15; the rest is margin.
- **Runtime:** Cloudflare Workers + D1 ([ADR-003](ADR-003-intake-single-runtime-worker-d1.md)).
- **MVP:** deterministic, with no model calls ([ADR-002](ADR-002-v1-workflow-unrecognized-charge-intake.md)).
- **Current state:** on 2026-09-29, production D1 held the fictitious seed and no cases.

### Demand evidence (synthetic sample, full Silver build, 2023-06-17 → 2026-06-18)

| Measure | p50 | p95 | Max |
|---|---|---|---|
| Call-center interactions per day | 664 | 818 | 894 |
| `Queja` interactions per day | 111 | 145 | 169 |
| `Cargo no reconocido` complaints per day (2025) | 11 | 17 | 23 |

The single busiest hour held 60 interactions. The hour-of-day profile is flat (about 4.2% of the day in every hour), which real contact centres don't show, so peaks are handled with a 3× factor that is an **assumption**. The sizing scenarios use a p95 day:

- **S1:** 17 episodes/day. In-scope complaints, the closest proxy for V1 demand.
- **S2:** 145/day. Every `Queja` contact.
- **S3:** 818/day. Every contact of any reason.
- **S4:** 8,180/day. A 10× stress case over S3.

None of these is a forecast.

### Measured cost of one episode

The measurements come from `back-end/test/integration/budget.test.js`, which runs against local D1 and reads D1's own row counters. Storage was measured on SQLite with the Worker's migrations.

| Unit | Worker requests | D1 queries | D1 rows read | D1 rows written | Source |
|---|---|---|---|---|---|
| Page load (gated HTML document) | 1 | 0 | 0 | 0 | code |
| Customer: login + list + create case | 3 | 9 | 10 | 7 | measured |
| Agent refresh (session + 50-case page) | 2 | 4 | ≤155 | 3 | 13 rows measured with few cases; 155 is the full-page upper bound |
| **Episode (one of each)** | **6** | **13** | **165** | **10** | |

Rows written include D1's index writes. A case takes about **367 bytes** with a typical 77-character statement and about **4.3 KB** at the 2,000-character maximum. Worker CPU per request is **not measured yet**. The handlers are light (a SHA-256, JSON and indexed queries), and the workbook assumes 5 ms against the 10 ms limit until Workers analytics gives a real number.

## Decision

1. **Run on the Workers + D1 Free plan through 2026-10-31.** On the plan's own limits, the service carries **10,000 episodes a day**, and rows written is the binding constraint (100,000 per day ÷ 10 per episode). That is 588× S1, 69× S2 and 12× S3.

   | Scenario | Episodes/day | Worker requests | Rows read | Rows written | Highest use of a Free limit | Within Free |
   |---|---|---|---|---|---|---|
   | S1 | 17 | 102 (0.1%) | 2,805 (0.06%) | 170 (0.2%) | 0.2% | yes |
   | S2 | 145 | 870 (0.9%) | 23,925 (0.5%) | 1,450 (1.5%) | 1.5% | yes |
   | S3 | 818 | 4,908 (4.9%) | 134,970 (2.7%) | 8,180 (8.2%) | 8.2% | yes |
   | S4 | 8,180 | 49,080 (49%) | 1,349,700 (27%) | 81,800 (82%) | 82% | **no, upgrade** |

2. **Upgrade triggers, checked weekly in Workers and D1 analytics:**
   - **Workers Paid ($5/month):** any daily Free limit above 70% for 3 days in a row, or any Worker CPU p95 above 8 ms.
   - **Split or move the database:** one D1 database passing 400 MB (80% of the 500 MB Free cap; 10 GB on Paid), or D1 write p95 above 200 ms. PostgreSQL through Hyperdrive, or path O4 in ADR-003.
   - **Single writer:** D1 runs one writer per database, at about 1,000 queries/s with 1 ms queries. S4 at a 3× peak needs 2.8 writes/s, so this isn't the limit at any scenario above.
3. **No capacity claim beyond what was measured.** The per-episode figures come from local tests. Production latency (p50/p95) and CPU are reported only after the remote run in the implementation notes.
4. **Cost envelope.** Before tax, in USD per month:

   | Scenario | Cloudflare Free | Workers Paid | AWS serverless equivalent | AWS O4: Lambda + RDS + NAT (indicative) |
   |---|---|---|---|---|
   | S1 | $0 | $5.00 | $0.01 | $50.49 |
   | S2 | $0 | $5.00 | $0.09 | $50.57 |
   | S3 | $0 | $5.00 | $0.53 | $51.01 |
   | S4 | exceeds Free | $5.00 | $5.34 | $55.82 |

   The table uses these assumptions:
   - **Workers Paid:** every scenario stays inside the included usage (10 M requests, 30 M CPU-ms, 25 B rows read and 50 M rows written a month), so only the base fee applies.
   - **AWS serverless equivalent:** API Gateway HTTP API at $1.00/M, without the 12-month free tier; Lambda with 512 MB, 100 ms and the always-free 1 M requests and 400k GB-s; DynamoDB on demand, with D1 rows mapped to request units; CloudFront Free for static files.
   - **AWS O4:** adds a NAT gateway ($0.045/h) and its public IPv4 ($0.005/h), both from the official VPC page, to an RDS db.t4g.micro with 20 GB. The RDS figures ($11.68 + $2.30) are indicative, because the fetched pricing page didn't show them, and must be confirmed in the AWS Pricing Calculator (point 6).

   **Cost per attempted case is $0 on Free.** On Paid it is $5 ÷ (episodes per month): $0.0098 at S1 and $0.0002 at S3. **Cost per successful automated resolution is `not defined`**, because V1 has no automated resolution (ADR-002).
5. **AI is only an envelope, not a plan.** No model runs in the MVP. If a later ADR approves one, the per-episode costs at 12k input and 2k output tokens (unmeasured) are:

   | Model | Cost per episode | Free episodes/day | S1 per month | S3 per month |
   |---|---|---|---|---|
   | Workers AI gpt-oss-20b | $0.0030 | 36 (10k-neuron daily allocation) | $1.53 | $73.62 |
   | Workers AI llama-3.3-70b | $0.0080 | 14 | $4.09 | $196.96 |
   | Claude Haiku 4.5 | $0.022 | — | $11.22 | $539.88 |
   | Claude Sonnet 5 | $0.044 | — | $22.44 | $1,079.76 |

   The monthly figures ignore the free allocation. Claude through Bedrock: the rate comes from the calculator, and whether credits apply to Marketplace-billed models is unverified. At S3 volume, AI would cost about 15× (gpt-oss-20b) to 215× (Sonnet 5) the $5 Workers Paid base, so it has to earn its place in the evaluation first.
6. **Official AWS Pricing Calculator estimate (follow-up, no deployment).** The account is Lucas's, on the Free plan: $100 in credits available until 2027-03-22, no card on file, Roberto and Manoella invited. It is used for estimating only. Steps:
   1. Open [calculator.aws](https://calculator.aws/) → *Create estimate* → region **US East (N. Virginia)**.
   2. Create four groups:
      - **Edge:** CloudFront (static assets).
      - **API:** API Gateway HTTP API plus Lambda at 512 MB and 100 ms.
      - **Data:** first DynamoDB on demand; then, as a separate estimate, RDS PostgreSQL db.t4g.micro Single-AZ with 20 GB gp3 and 7-day backups, plus a NAT gateway.
      - **AI, optional:** Bedrock, Claude Haiku 4.5.
   3. Enter the S3 and S4 monthly volumes from the workbook's *Cloudflare capacity* and *Monthly cost* sheets. For S3 that is 4,908 × 30 Worker requests, of which 4,090 × 30 are API calls, plus 8,180 × 30 writes and 134,970 × 30 reads.
   4. Save the public link and export CSV to `Docs/Costs/Intake/aws-pricing-calculator-<YYYY-MM-DD>.csv`. Record the link, the date and the RDS lines here, and replace the indicative RDS inputs in the workbook.
   5. State in the record that the calculator excludes tax and credits and doesn't check Free-plan eligibility for this account.
7. **Operating the window:**
   - **Monitoring:** Workers observability logs and traces are enabled at 100% sampling. A weekly check covers requests per day, errors, CPU p95, D1 rows read and written, and database size, against the triggers in point 2.
   - **Access:** Cloudflare Access (email allowlist or one-time PIN, free up to 50 users) in front of the whole hostname, and the Basic gate on the API and HTML documents. Neither is customer authentication.
   - **Retention:** demo cases and sessions are deleted after 2026-10-31 with `DELETE FROM cases; DELETE FROM sessions;` on the remote D1, run after a final export for the record. Expired sessions are purged on every login. D1 Time Travel keeps 7 days on Free for recovery. No real customer data is ever loaded.
   - **Remaining deployment work before any real pilot:** real authentication; a preview database separate from production; alerting on the triggers; a load test against the deployed Worker; a cross-key duplicate rule; a data-handling approval for any AI provider.

## Consequences

- **+** Hosting cost is $0 for the whole window, with every figure traceable to a measurement or an official price. The workbook recalculates when any input changes.
- **+** The first limit we'd hit (rows written) is known, and so is the cheapest way past it ($5/month).
- **+** A CI budget test catches a regression that multiplies queries or rows per request, such as a new scan on a hot path, before it shows up on the bill.
- **−** Sizing rests on a synthetic, flat-hourly sample. Real peaks and real volume could be very different, which is exactly the limitation Factored asked us to state.
- **−** CPU and remote latency are unmeasured until the deploy check runs.
- **−** The agent-refresh read figure is an upper bound, and actual refresh behaviour is an assumption.
- **−** AWS RDS prices are indicative until the calculator estimate is recorded.

## Alternatives considered

- **Size on the hosted-FastAPI options** (Render, Lightsail) from the former review. Their fixed prices don't track load, and those runtimes were rejected in ADR-003. Rejected.
- **Buy Workers Paid now.** Measured use is under 9% of Free even at S3. Rejected. Reopen it on any trigger in point 2.
- **Quote the AWS O4 path as the plan.** It costs about $50/month for no benefit at these volumes. Rejected for the window, but kept as the documented scale path with the calculator follow-up.

## Implementation notes

- **Workbook:** [`Docs/Costs/Intake/INTAKE_COST_ESTIMATE.xlsx`](../Costs/Intake/INTAKE_COST_ESTIMATE.xlsx), generated by `scripts/intake_cost/build_workbook.py`. `--print` outputs the same figures computed in Python. Every derived cell is a formula over the *Inputs* sheet, and an independent recalculation on 2026-09-29 matched the Python figures.
- **Budget ceilings in CI** (per request: queries / rows read / rows written):
  - login 4/8/6;
  - list 2/25/0;
  - create 4/12/6;
  - agent login 3/6/6;
  - agent list 2/250/0.

  Tighten them if the measured values stay lower after the deploy.
- **Remote check (to record after the deploy):** date, results of the checklist in `back-end/README.md`, Worker CPU p50/p95 and end-to-end p50/p95 from a low-rate run with a dedicated test identity.
- **Sources (checked 2026-09-29):**
  - Cloudflare: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Zero Trust plans](https://www.cloudflare.com/plans/zero-trust-services/).
  - AWS: [Free plan](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html), [Lambda](https://aws.amazon.com/lambda/pricing/), [API Gateway](https://aws.amazon.com/api-gateway/pricing/), [DynamoDB on demand](https://aws.amazon.com/dynamodb/pricing/on-demand/), [VPC/NAT](https://aws.amazon.com/vpc/pricing/), [CloudFront](https://aws.amazon.com/cloudfront/pricing/), [RDS for PostgreSQL](https://aws.amazon.com/rds/postgresql/pricing/), [Pricing Calculator](https://docs.aws.amazon.com/pricing-calculator/latest/userguide/what-is-pricing-calculator.html).
  - Anthropic API list prices.
