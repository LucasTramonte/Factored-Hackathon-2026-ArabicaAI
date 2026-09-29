# Intake demo cost estimate — reviewed 29 September 2026

## Decision to make

Budget a small, access-controlled demo and measure the intake workflow before buying capacity. The application currently runs locally, makes **no AI calls**, and has **no cloud bill**. The attached [editable workbook](INTAKE_COST_ESTIMATE.xlsx) estimates proposed monthly spend. Its low prices are a starting budget, not evidence that a small server can carry 900 or 9,000 cases a day.

The customer outcome is a safely accepted report of an unrecognized charge, with a reference delivered and a useful human handoff. Acceptance is **not** a fraud decision, refund, or automated resolution. Cost per attempted intake can be estimated; cost per *successful automated resolution* remains undefined because no such outcome is measured.

## Evidence and scenarios

The verified Silver report counts **4,118** `Cargo no reconocido` complaints in the complete calendar year 2025, or **11.28 per calendar day**. This is a synthetic complaint count by `creation_date`, not observed application starts, a production forecast, or all contact-center traffic. The 900/day case is an all-contact stress assumption; 100/day and 9,000/day are also sensitivity cases. The workbook assumes one eligible app start per complaint only to illustrate a demand scale. See the [committed intake report](data_foundation/reports/intake-decision.html) and [aggregate data](data_foundation/reports/aggregates.json).

| Daily episode assumption | Episodes / 30 days | Planned HTTP requests / 30 days | AI usage / month | Render web + Postgres + AI / month | Lightsail single VM + AI / month | Lightsail with managed DB + AI / month |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2025 V1 complaint proxy: 11.28/day | 338 | 3,385 | $1.62 | $14.92 | $27.62 | $57.62 |
| 100/day | 3,000 | 30,000 | $14.40 | $27.70 | $40.40 | $70.40 |
| 900/day | 27,000 | 270,000 | $129.60 | $142.90 | $155.60 | $185.60 |
| 9,000/day | 270,000 | 2,700,000 | $1,296.00 | $1,309.30 | $1,322.00 | $1,352.00 |

These are **constant-capacity price floors**, before taxes and unpriced items. The VM and web plan prices stay flat in this table solely because no scaling rule or load-test result exists. Do not read the 9,000/day total as a deployable quote.

## What is priced

- **AI scenario:** 12,000 input and 2,000 output text tokens *per episode*, including all model calls, are unmeasured assumptions. As one illustrative model, [OpenAI lists GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) at **$0.20/M input** and **$1.20/M output** tokens. That gives `(12,000 × $0.20 + 2,000 × $1.20) / 1,000,000 = $0.0048` per episode. This model has not been selected or integrated. Caching, tool calls, retries, rate limits, and different models change the bill; output includes any billed reasoning tokens. The actual current AI charge is **$0**.
- **Render proposal:** [Render's published rates](https://render.com/pricing) show a **$7/month** 512 MB web plan, **$6/month** 256 MB managed PostgreSQL compute, and **$0.30/GB-month** of PostgreSQL storage. Assuming 1 GB allocated gives **$13.30/month fixed**, before AI. These are the smallest paid plans, not a capacity endorsement. A scheduled data-load job and its compute are omitted.
- **AWS single VM alternative:** [Lightsail](https://aws.amazon.com/lightsail/pricing/) lists a **$24/month** public-IPv4 Linux 4 GB, 2-vCPU, 80-GB instance. Add an assumed **20 billable snapshot GB-month × $0.05 = $1**, and an optional **$1/month 5-GB object storage bundle**: **$26/month fixed**. This variant runs PostgreSQL on the same VM, so the team owns database operations, restore checks, patching, and resource contention. The 20-GB snapshot figure is a billing assumption, not a proven backup size or retention policy.
- **AWS managed database alternative:** The same [Lightsail pricing](https://aws.amazon.com/lightsail/pricing/) lists a **$30/month** standard, encrypted, 2-GB managed database. Added to the preceding VM assumptions, the fixed total is **$56/month**. This differs materially from Render's 256-MB database; the options are not performance-equivalent.
- **Credits:** set to **$0** until eligibility is confirmed. The [AWS Free Tier](https://aws.amazon.com/free/) advertises credits for eligible new accounts, but those cannot be assumed and do not pay a separate model provider's API bill. The [AWS Pricing Calculator](https://calculator.aws/) should be used for a region-specific AWS quote. This workbook is not its export.

## Cloudflare Worker + D1 candidate

A [Cloudflare Worker can serve a Python or JavaScript API and static assets](https://developers.cloudflare.com/workers/static-assets/) without an always-on laptop. We have a separate JavaScript Worker + D1 variant in [`cloudflare/`](cloudflare/README.md) that passed local D1 flow tests. If it stays inside the [Workers Free limits](https://developers.cloudflare.com/workers/platform/pricing/) and [D1 Free limits](https://developers.cloudflare.com/d1/platform/limits/), its fixed Cloudflare hosting charge could be **$0/month**; hypothetical model API usage remains separate. This is **not yet a verified quote or production capacity result**: the current demo has no measured Worker CPU, D1 row scans, storage growth, retries, or peak load. At 9,000 episodes/day × 10 planned requests, the scenario already reaches 90,000 Worker requests/day before extra requests, close to the 100,000/day Free cap. The workbook shows this request comparison on a separate tab and leaves hosting suitability conditional. The Cloudflare variant is not yet deployed.

## Equations and operating limits

`monthly episodes = daily episodes × 30`; `planned requests = episodes × 10`; `AI/month = episodes × $0.0048`; `cost/attempt = (fixed hosting + AI) / monthly episodes`. The **10 planned HTTP requests** and **2-second mean service time** are assumptions. The current normal customer path has three API calls—start session, list own transactions, create case—excluding agent reads, retries, browser assets, and failures. It does not prove that a future AI episode will use 10 requests.

With 10% of daily planned requests in the busiest hour and no additional within-hour burst, 100/day implies **0.028 requests/second** in that hour; 900/day implies **0.25**, and 9,000/day implies **2.5**. Multiplying by the assumed two-second mean service time yields **0.06**, **0.5**, and **5** average requests in flight. This arithmetic does not establish CPU, database pool, tail latency, model rate-limit, or concurrency capacity. The actual distribution of arrivals and p95 latency must be measured in a load test.

The published totals omit domain, TLS-related add-ons if needed, logs, monitoring, bandwidth or transfer overages, taxes, FX, backup retention and restore testing, operational labor, security controls, an S3/Silver load job, and possible extra infrastructure at higher traffic. Any of these can dominate the low-volume bill. The cloud scenarios also assume a protected demo, a non-public database, and a separate bounded data-load job; a public deployment is not approved by this estimate.

## What to measure before a scale or savings claim

1. Log eligible starts, customer approval, backend acceptance, delivered references, failed/retried attempts, and handoff completion. Count **safe accepted intake / all eligible starts**. Count automated resolutions separately; a handoff stays in the handoff denominator.
2. Instrument per-episode input/output tokens, number of model calls, retries, and model errors; compare observed billing to the workbook's $0.0048 assumption. Do not send bank identifiers or sensitive evidence to a model without an approved data-handling design.
3. Record request p50/p95 latency, peak-minute arrivals, database connections, memory, CPU, and error rate on a bounded load test. Repeat after adding AI, which may dominate latency even if token cost is small.
4. Compare checklist versus AI on the same held-out, human-reviewed Spanish and Portuguese case families. Only then estimate any incremental safe-acceptance gain, agent time saved, and cost per successful outcome. The synthetic complaint count alone cannot show cost savings or production capacity.

To change assumptions and regenerate the workbook, run `python -m pip install -r cost-workbook-requirements.txt` in a virtual environment, then `python scripts/build_intake_cost_workbook.py`. Edit yellow cells on **Inputs** for live sensitivity checks. Recheck provider prices before spending.
