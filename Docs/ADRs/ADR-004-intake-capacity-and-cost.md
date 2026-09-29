# ADR-004 — Intake capacity and cost for the evaluation window

- **Status:** Proposed
- **Date:** 2026-09-29
- **Deciders:** Lucas Tramonte, Manoella R, Roberto Z
- **Supersedes:** the decision section of the former `Docs/Costs/Intake/INTAKE_COST_REVIEW.md` (removed; this record and the workbook replace it)

## Context

The brief asks for capacity limits, latency and cost trade-offs, cost per attempted case, the workload behind each figure, and the cost assumptions. On Slack, Factored confirmed that the dataset sample (about 780–900 call-center interactions a day) doesn't represent production volume. They said a prototype isn't expected to handle full volume, and that recognizing sizing limits is part of the evaluation. So this record sizes the service against the volumes we measured and the limits of the platform, and it makes no production forecast.

- **Window:** 2026-09-29 → 2026-10-31. Submissions close on 2026-10-05 and finalists are announced on 2026-10-15 (kickoff deck, p. 6); the service stays up through judging.
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
| Page load (gated HTML document + identity list) | 2 | 0 | 0 | 0 | code |
| Customer: login + list + create case | 3 | 9 | 10 | 7 | measured |
| Agent refresh (session + 50-case page) | 2 | 4 | ≤155 | 3 | 13 rows measured with few cases; 155 is the full-page upper bound |
| **Episode (one of each)** | **7** | **13** | **165** | **10** | |

Rows written include D1's index writes. A case takes about **367 bytes** with a typical 77-character statement and about **4.3 KB** at the 2,000-character maximum. Worker CPU per request is **not measured yet**. The handlers are light (a SHA-256, JSON and indexed queries), and the workbook assumes 5 ms against the 10 ms limit until Workers analytics gives a real number.

## Decision

1. **Run on the Workers + D1 Free plan through 2026-10-31.** The daily quotas bound the service at **10,000 episodes a day**, with rows written as the binding quota (100,000 per day ÷ 10 per episode). That is 588× S1, 69× S2 and 12× S3.

   **That figure is a daily-quota bound, not a whole-window capacity.** Storage is cumulative. At 10,000 episodes a day, the 500 MB database cap lasts about 136 days with typical cases (367 bytes) but only **about 12 days with 2,000-character statements** (4.3 KB). Across the window, stored cases use at most 0.5% (S1), 4% (S2) and 22% (S3) of the cap, even at maximum statement length. S4 would need 223% at maximum length, so storage binds before the daily quotas there.

   | Scenario | Episodes/day | Worker requests | Rows read | Rows written | Highest use of a daily Free limit | Within daily Free limits | 70% upgrade policy |
   |---|---|---|---|---|---|---|---|
   | S1 | 17 | 119 (0.1%) | 2,805 (0.06%) | 170 (0.2%) | 0.2% | yes | not triggered |
   | S2 | 145 | 1,015 (1.0%) | 23,925 (0.5%) | 1,450 (1.5%) | 1.5% | yes | not triggered |
   | S3 | 818 | 5,726 (5.7%) | 134,970 (2.7%) | 8,180 (8.2%) | 8.2% | yes | not triggered |
   | S4 | 8,180 | 57,260 (57%) | 1,349,700 (27%) | 81,800 (82%) | 82% | yes | **triggered: move to Workers Paid** |

2. **Upgrade triggers, checked weekly in Workers and D1 analytics:**
   - **Workers Paid ($5/month):** any daily Free limit above 70% for 3 days in a row, or any Worker CPU p95 above 8 ms.
   - **Split or move the database:** one D1 database passing 400 MB (80% of the 500 MB Free cap; 10 GB on Paid), or D1 write p95 above 200 ms. PostgreSQL through Hyperdrive, or path O4 in ADR-003.
   - **Single writer:** D1 runs one writer per database, at about 1,000 queries/s with 1 ms queries. S4 at a 3× peak needs 2.8 writes/s, so this isn't the limit at any scenario above.
3. **No capacity claim beyond what was measured.** The per-episode figures come from local tests. Production latency (p50/p95) and CPU are reported only after the remote run in the implementation notes.
4. **Cost envelope.** Before tax, in USD per month:

   | Scenario | Cloudflare Free | Workers Paid | AWS serverless equivalent | AWS O4: API + Lambda + RDS + NAT, no DynamoDB (indicative) |
   |---|---|---|---|---|
   | S1 | $0 | $5.00 | $0.01 | $50.48 |
   | S2 | $0 | $5.00 | $0.09 | $50.50 |
   | S3 | $0 | $5.00 | $0.53 | $50.60 |
   | S4 | $0 (within limits; the policy calls for Paid) | $5.00 | $5.34 | $51.75 |

   The table uses these assumptions:
   - **Workers Paid:** every scenario stays inside the included usage (10 M requests, 30 M CPU-ms, 25 B rows read and 50 M rows written a month), so only the base fee applies.
   - **AWS serverless equivalent:** API Gateway HTTP API at $1.00/M, without the 12-month free tier; Lambda with 512 MB, 100 ms and the always-free 1 M requests and 400k GB-s; DynamoDB on demand, with D1 rows mapped to request units; CloudFront Free for static files.
   - **AWS O4:** uses RDS instead of DynamoDB, so it adds only the shared API Gateway and Lambda costs to RDS and NAT. It adds a NAT gateway ($0.045/h) and its public IPv4 ($0.005/h), both from the official VPC page, to an RDS db.t4g.micro with 20 GB. The RDS figures ($11.68 + $2.30) are indicative, because the fetched pricing page didn't show them, and must be confirmed in the AWS Pricing Calculator (point 6).

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
   3. Enter the S3 and S4 monthly volumes from the workbook's *Cloudflare capacity* and *Monthly cost* sheets. For S3 that is 5,726 × 30 Worker requests, of which 4,090 × 30 are API calls that touch D1, plus 8,180 × 30 writes and 134,970 × 30 reads.
   4. Save the public link and export CSV to `Docs/Costs/Intake/aws-pricing-calculator-<YYYY-MM-DD>.csv`. Record the link, the date and the RDS lines here, and replace the indicative RDS inputs in the workbook.
   5. State in the record that the calculator excludes tax and credits and doesn't check Free-plan eligibility for this account.
7. **Operating the window:**
   - **Monitoring:** Workers observability logs and traces are enabled at 100% sampling. A weekly check covers requests per day, errors, CPU p95, D1 rows read and written, and database size, against the triggers in point 2.
   - **Access:** Cloudflare Access (email allowlist or one-time PIN, free up to 50 users) required in front of the whole hostname, with its denial of unlisted emails still to be confirmed on the remote checklist, and the Basic gate on the API and HTML documents. Neither is customer authentication.
   - **Retention:** demo cases and sessions are deleted after 2026-10-31 with `DELETE FROM cases; DELETE FROM sessions;` on the remote D1, run after a final export for the record. No case is deleted by age before then, so judges see the cases shown in the recorded demo. Before each recorded demo, the team may reset cases and sessions only. Customers, transactions, context cards and provenance stay until the seed version is replaced. Expired sessions are purged on every login. D1 Time Travel keeps 7 days on Free for recovery. No real customer data is ever loaded.
   - **Remaining deployment work before any real pilot:** real authentication; a preview database separate from production (until then, non-production branch builds stay disabled); alerting on the triggers; a load test against the deployed Worker; a cross-key duplicate rule; a data-handling approval for any AI provider.

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
- **Measured in production, 2026-09-29.** One manual episode after the deploy of version `529907dd`: Workers Logs export, 13 invocations and 13 D1 spans. It's a single sample, not a load test.
  - **Placement:** the Worker ran in GRU (São Paulo, region SAM). The D1 primary is in ENAM and was served from ORD (Chicago).
  - **CPU per request:** 0–4 ms, under the 10 ms Free limit. The workbook's 5 ms assumption was conservative.
  - **D1 round trip from the Worker:** 136–186 ms, median 148 ms. Latency is dominated by the distance to D1, not by compute.
  - **Wall time per request:**

    | Request | Wall time |
    |---|---|
    | `GET /demo/identities` | 1 ms |
    | `GET /` (document) | 252 ms |
    | `GET /transactions` | 297 ms |
    | `POST /demo/agent-session` | 309 ms |
    | `GET /agent/cases` | 278 ms |
    | `POST /demo/session` | 524 ms |
    | `POST /cases` | 605 ms |

    The customer path (login, list, case) adds up to about 1.4 s of server time.
  - **Static bundles:** they no longer reach the Worker. The episode made 7 Worker requests, as modelled.
  - **Functional checks:** Access and the Basic gate held, the customer saw only their own charges, a case got a reference, and the agent view showed it. All requests succeeded and there were no errors.
  - **Change made after this measurement:**
    - **Smart Placement** (`placement.mode = "smart"` in `wrangler.jsonc`, checked by `test/unit/config.test.js`) is an adaptive setting. Cloudflare moves the Worker closer to D1 only if observed telemetry shows that helps, so no location is claimed until the `cf-placement` header confirms it.
    - **Login writes in one batch:** purging expired sessions, revoking the old token and inserting the new one run as one atomic `db.batch()`, so login drops to 2 round trips. The budget test now caps round trips per request (login 2, list 2, create 4, agent 1–2).

    Re-measured at 11:05 BRT on 2026-09-29, one episode after the deploy of `aa0c804`:

    | Request | Before | After |
    |---|---|---|
    | `POST /demo/session` | 514 ms | 418 ms (2 round trips) |
    | `POST /demo/agent-session` | 302 ms | 161 ms (1 round trip) |
    | `GET /transactions` | 290 ms | 294 ms |
    | `POST /cases` | 595 ms | 611 ms |

    The batch works. Smart Placement had not moved the Worker yet: it needs observed traffic first, and per-query time was still about 145 ms. Check the `cf-placement` response header (`local-GRU` means not moved; `remote-…` means moved) and re-measure once it reads `remote-…`.

    Caveats:
    - Cloudflare needs some traffic before it moves the Worker.
    - The gated HTML document now makes one trip near D1 (about 130 ms from Brazil), while bundles are still served at the edge.
    - If D1 read replicas are adopted later, revisit placement, because reads could then be served nearer the user.
    - No effect expected on the data-integration or AI phases: more queries per request make proximity to D1 worth more, a model call from North America fits the same placement, and a batch maps to a transaction if the store moves to PostgreSQL.
- **Observability limits:**
  - Workers Logs Free allows 200,000 events per day. After that, 1% head sampling applies for the rest of the day. One episode produced about 29 events, so full-fidelity logs cover about 6,900 episodes per day, which is below the 10,000-episode capacity. `head_sampling_rate` can be lowered if that matters.
  - Logs are retained for 3 days on Free.
  - `Authorization` and `Cookie` are redacted, and request bodies are logged only as sizes. The client IP (`cf-connecting-ip`) is logged, which is personal data, so exported logs stay in ignored `data/observability/` and are never committed.
- **Sources (checked 2026-09-29):**
  - Cloudflare: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Zero Trust plans](https://www.cloudflare.com/plans/zero-trust-services/).
  - AWS: [Free plan](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html), [Lambda](https://aws.amazon.com/lambda/pricing/), [API Gateway](https://aws.amazon.com/api-gateway/pricing/), [DynamoDB on demand](https://aws.amazon.com/dynamodb/pricing/on-demand/), [VPC/NAT](https://aws.amazon.com/vpc/pricing/), [CloudFront](https://aws.amazon.com/cloudfront/pricing/), [RDS for PostgreSQL](https://aws.amazon.com/rds/postgresql/pricing/), [Pricing Calculator](https://docs.aws.amazon.com/pricing-calculator/latest/userguide/what-is-pricing-calculator.html).
  - Anthropic API list prices.
