# Business outcomes: unrecognized-charge disputes

This is the business case for one problem at the LATAM bank: a customer sees a card charge they don't recognize and files a complaint, which the bank records as `Cargo no reconocido`. It sizes the problem, describes how the bank handles these complaints today, and states what our service changes, which outcomes we commit to measuring and what we can't claim.

We chose one workflow because the brief scores depth, not breadth. Unrecognized-charge intake was the largest complaint type that a deterministic boundary can make safe (nothing moves money, a person decides); the other candidates either change the account, lack outcome labels or have the least demand ([ADR-001](../ADRs/ADR-001-workflow-prioritization.md), [ADR-002](../ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md)).

## The data behind the figures

The data is synthetic. Every figure below is descriptive, and none of them is an effect of our product.

The figures come from Silver, quality run `20261002T232200Z` (390 checks, 0 errors, 7 warnings), over the design window 2023-06-17 to 2025-12-31 (929 days, [ADR-005](../ADRs/ADR-005-evaluation-data-protocol.md)) unless a figure says full period. The page with charts is [`product-report.html`](../../data_foundation/reports/product-report.html). Each figure sits next to the query that produced it in [`product-report.json`](../../data_foundation/reports/product-report.json), the quality run behind them is in [`product-manifest.json`](../../data_foundation/reports/product-manifest.json), and the queries are in [`data_foundation/queries/product/`](../../data_foundation/queries/product/). After `make pipeline`, `make product-report QUALITY_REPORT=data/quality_runs/<run-id>/quality_results.json` rebuilds all of it ([`DATA_ENGINEERING.md`](DATA_ENGINEERING.md)).

## The problem in numbers

| KPI | Value | Denominator and limit |
|---|---|---|
| Unrecognized-charge complaints | 11.16 a day | 10,370 complaints, 18.28% of 56,736. The share is stable by year (18.2–18.4%) |
| Recorded claims | US$2,327 a day in source USD; US$2,474 with FX estimates | Amounts are convertible on 3,296 of 10,370 complaints (31.78%): 835 recorded in USD (US$2,161,914.20) and 2,461 FX-estimated at the creation-day rate (US$135,989.84, flagged). Excluded: 6,919 with no amount and 155 with an amount but no currency. These are claims, not losses or savings. Each source currency is reported separately ([DF-023](DATA_ENGINEERING.md#df-023-amounts-share-one-usd-scale-and-claimed-currencies-ignore-the-customers-country)) |
| Complaint-contact workload | 11.08 hours a day, 106.70 contacts | All complaint contacts (`Queja`), not only unrecognized charges. Mean duration 434.71 s over 85,261 observed durations (86.02%); 13,861 are missing. Turning this into a cost needs a rate the data doesn't have |
| Resolution of complaint contacts | 43.65%, against 76.61% for all contacts | 43,269 of 99,122, against 444,741 of 580,546 |

About eleven customers a day report a charge they don't recognize, and the contact channel they reach resolves complaints far less often than anything else it handles.

## How disputes are handled today

| Measure | Unrecognized charges | Other complaints |
|---|---|---|
| Unresolved (Open, In Process, Escalated) | 74.57% (7,733 of 10,370) | 75.09% |
| SLA breached | 20.11% | 20.03% |
| Assignment to first response, p50 / p90 | 25 / 44 hours (n = 6,045) | 25 / 44 hours |
| First response to resolution, p50 / p90 | 14.4 / 25.9 days (n = 2,241) | 14.7 / 26.2 days |
| Customer wait, creation to resolution, p50 / p90 | 15 / 27 days (n = 2,414) | 16 / 28 days |

The two columns are nearly identical. A customer looking at a large charge they didn't make treats it as urgent ([DF-024](DATA_ENGINEERING.md#df-024-purchase-amounts-are-almost-flat-up-to-usd-509-with-no-high-value-tail)), yet nothing in today's handling sets these complaints apart from any other.

Escalation is where cases disappear. The 514 complaints escalated in the window have no first response, resolution or closing date. At the end of the data (2026-06-18, full period), the 618 escalated cases had been open 535 days at p50 and 973 days at p90, and that is a lower bound, not a closing time.

Two data choices affect these rows. We kept the 52 window complaints whose outcome dates fall in 2026. We left out of the durations the 84 whose resolution date precedes their first response.

Underneath the timings sits a linkage problem. No complaint points to a transaction, and the product a complaint cites belongs to another customer ([DF-002, DF-003](DATA_ENGINEERING.md)). And 6,919 of the 10,370 complaints record no amount. An agent picking up a case has to work out which charge the customer meant before doing anything else.

## Satisfaction, each with its own population

The three satisfaction sources measure different people, so we don't combine them.

Closed-case satisfaction for unrecognized charges averages 3.07 of 5. Only 371 of 10,370 cases (3.58%) were closed in the window with a score, which makes it a selected subset.

Contact-centre CSAT (observed on a 1–4 scale) is 2.44 for complaint contacts and 2.83 for other contacts. Within each resolution outcome, every contact reason scores about the same: about 3.0 when resolved and 2.0 when not. Reasons with a lower average are the ones resolved less often. That is a descriptive association, not evidence that resolution causes satisfaction ([#86 F3](../Plans/insights-report.md#4-findings)).

| Contact reason | Contacts | Resolved | CSAT answers | Mean CSAT | If resolved | If not resolved |
|---|---|---|---|---|---|---|
| Queja (complaints) | 99,122 | 43.65% | 18,514 | 2.44 | 3.00 | 2.00 |
| Retención | 17,396 | 59.89% | 3,237 | 2.61 | 3.01 | 2.00 |
| Comercial | 46,417 | 65.05% | 8,677 | 2.65 | 2.99 | 2.02 |
| Técnico | 87,040 | 69.95% | 16,249 | 2.69 | 3.00 | 1.99 |
| Producto | 127,444 | 89.61% | 23,515 | 2.90 | 3.00 | 2.00 |
| Transaccional | 203,127 | 91.46% | 37,968 | 2.91 | 3.00 | 1.99 |

For NPS, 74.49% of 53,790 answers are detractors (0–6) and none is a promoter, because answers stop at 7. We report the distribution rather than the formal score, which would say nothing about loyalty here.

There is no survey CSAT for unrecognized-charge complainants at all. Surveys link to contact-centre interactions, not to complaints.

## The segment cut

Segment is today's snapshot, not the segment at complaint time. Cells under 30 are not compared.

| Segment | Complaints | Unresolved | SLA breached | Closed-case satisfaction | Complaint-contact CSAT |
|---|---|---|---|---|---|
| Basic | 6,221 | 74.51% | 19.90% | 3.01 (n = 205) | 2.44 |
| Plus | 2,557 | 74.74% | 21.47% | 3.28 (n = 100) | 2.42 |
| Premium | 1,053 | 74.83% | 20.51% | 3.00 (n = 45) | 2.44 |
| Student | 539 | 74.03% | 15.21% | too few (n = 21) | 2.41 |

Premium complaints stay unresolved and breach SLAs as often as anyone's. No segment is handled differently today. A language cut exists only for our live episodes, and the 5 team episodes so far are too few for any rate.

## What our service changes

The service doesn't resolve disputes. It changes how one starts. The customer signs in, describes the charge, picks it from their own recent purchases, confirms it, and gets a reference only after the case has been stored and read back. The agent receives the confirmed transaction, the customer's own words, what was checked and what is still open, instead of a complaint with no transaction attached. When no charge is confirmed, the case still reaches a person, marked as incomplete.

For the bank, that targets the linkage gap above: a confirmed case arrives tied to a transaction the customer owns. Reports on a charge above a stated amount, unusual for the customer, or flagged by the bank's own fraud engine ([ADR-011](../ADRs/ADR-011-proactive-alert-bank-flag.md)) lead the agent queue, which is the differentiated handling today's data shows is missing. The amount thresholds are policy we set, not values fitted to outcomes, and the flags in the prototype are authored.

For the customer, the receipt says what happened and what happens next, and the report's status stays visible after the tab closes. Nothing is refunded, blocked or decided by the system.

Whether any of this shortens the waits or raises satisfaction in the tables above is a hypothesis. This data can't test it: without complaint-to-transaction links, faster intake has no measurable business value here.

## Outcome measures we commit to

The definitions are in the [customer and measurement contract](../intake/customer-and-measurement-contract.md). Empty denominators are undefined, never zero, and results are reported by language before pooling.

| Measure | Numerator / denominator | Status |
|---|---|---|
| Safe accepted intake (primary) | Eligible episodes with an owned transaction, verified evidence, current confirmation, durable receipt and assessed safety / all eligible episodes started, including failures and abandonment | Not measured. Production doesn't assess safety, so none of the 5 live episodes counts as safe accepted |
| Unsafe outcome rate | Cases exposing another customer's data, inventing candidates, taking a prohibited action or handing off an unconfirmed match as complete / all attempted cases | A release gate at zero, measured offline ([`EVALUATION.md`](EVALUATION.md)) |
| Missed and unnecessary handoff | Against independently reviewed expected behaviour, each over its own gold denominator | Measured offline on authored cases |
| Receiving-agent readiness | Actionable packages / submitted packages, judged blind by an agent | Not measured |
| Customer effort, teach-back, intake CSAT | Real participants only, never simulated ratings | Not measured; a five-person moderated test comes first |
| Intake rework within 7 days | Accepted cases needing a correction / accepted cases with a full window | Deferred: complaints lack origin-interaction links |
| Cost per safe completed episode | Attributable charges / safe completed episodes | Not measured |

A handoff never counts as an automated resolution, so the brief's "safe automated resolution" has no numerator in this workflow. The held-out comparison of the learned component against the checklist baseline hasn't run yet; it will be reported in [`EVALUATION.md`](EVALUATION.md).

## What not to claim

- Claimed amounts are not losses, and source currencies are never added together.
- None of the time, SLA or satisfaction figures is an effect of our product. They are baselines to measure against.
- No complaint links to a transaction, so "large for this customer" can only be measured live.
- Survey answers about waiting are not measured wait, and wait is recorded only for phone contacts ([DF-027](DATA_ENGINEERING.md#df-027-wait-time-exists-only-for-phone-contacts-and-survey-wait-answers-dont-track-it)).
- The data is synthetic, and every association here is descriptive.
