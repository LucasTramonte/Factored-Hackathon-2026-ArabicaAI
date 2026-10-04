# Product report: the unrecognized-charge baseline

What the data says about unrecognized-charge disputes before our service: how many there are, what they claim, how they are handled, and how satisfied customers are. The full page with charts is [`product-report.html`](../../data_foundation/reports/product-report.html). Every figure is in [`product-report.json`](../../data_foundation/reports/product-report.json) next to the query that produced it, and the quality run behind them is in [`product-manifest.json`](../../data_foundation/reports/product-manifest.json).

- **Data:** synthetic. Silver from quality run `20261002T232200Z` (390 checks, 0 errors, 7 warnings).
- **Window:** the design window, 2023-06-17 to 2025-12-31 (929 days, [ADR-005](../ADRs/ADR-005-evaluation-data-protocol.md)), unless a figure says **full period**.
- **Rebuild:** after `make pipeline`, run `make product-report QUALITY_REPORT=data/quality_runs/<run-id>/quality_results.json`. The queries are in [`data_foundation/queries/product/`](../../data_foundation/queries/product/).
- **Every figure is descriptive.** None of them is a product effect.

## 1. The problem in numbers

| KPI | Value | Denominator and limit |
|---|---|---|
| Unrecognized-charge complaints | **11.16 a day** | 10,370 complaints; 18.28% of 56,736. The share is stable by year (18.2–18.4%) |
| Recorded claims | **US$2,327 a day** in source USD; US$2,474 with FX estimates | Amounts convertible on 3,296 of 10,370 complaints (31.78%): 835 recorded in USD (US$2,161,914.20) and 2,461 FX-estimated at the creation-day rate (US$135,989.84, flagged). Excluded: 6,919 with no amount and 155 with an amount but no currency. Claims, not losses or savings. Each source currency is reported separately ([DF-023](DATA_QUALITY.md#df-023-amounts-share-one-usd-scale-and-claimed-currencies-ignore-the-customers-country)) |
| Complaint-contact workload | **11.08 hours a day**, 106.70 contacts | All complaint contacts (`Queja`), not only unrecognized charges. Mean duration 434.71 s over 85,261 observed durations (86.02%); 13,861 missing. A cost needs a rate the data lacks |
| Resolution of complaint contacts | **43.65%**, against 76.61% for all contacts | 43,269 of 99,122, against 444,741 of 580,546 |

## 2. How disputes are handled today

| Measure | Unrecognized charges | Other complaints |
|---|---|---|
| Unresolved (Open, In Process, Escalated) | 74.57% (7,733 of 10,370) | 75.09% |
| SLA breached | 20.11% | 20.03% |
| Assignment → first response, p50 / p90 | 25 / 44 hours (n = 6,045) | 25 / 44 hours |
| First response → resolution, p50 / p90 | 14.4 / 25.9 days (n = 2,241) | 14.7 / 26.2 days |
| Customer wait, creation → resolution, p50 / p90 | 15 / 27 days (n = 2,414) | 16 / 28 days |

- **Unrecognized charges are handled like any other complaint.** Customers experience a large unexpected charge as urgent ([DF-024](DATA_QUALITY.md#df-024-purchase-amounts-are-almost-flat-up-to-usd-509-with-no-high-value-tail)), but nothing in today's handling sets these complaints apart.
- **Escalated cases have no outcome at all.** The 514 escalated in the window have no first response, resolution or closing date. At the data end (2026-06-18, **full period**), the 618 escalated cases had been open 535 days at p50 and 973 days at p90. That is a lower bound, not a closing time.
- **Repeat complaints are rare.** 350 of 10,013 customers (3.5%) filed two or more, 707 complaints in all. The source has no re-opened status, so these are labelled proxies: of 10,370 complaints, 357 follow an earlier one by the same customer, 27 within 30 days and 64 within 90, and 92 after the earlier one had a resolution or closing date. The source's `is_repeat_complainer` flag is set on 1,517 complaints, more than repeats explain, so it isn't used. In the product, "not resolved" on a closed report starts a new one that cites it (#90); that live signal isn't exported yet.
- **Kept and counted:** 52 complaints from the window have outcome dates in 2026. Another 84 have a resolution date before their first response; they are left out of the durations.

## 3. Satisfaction, each with its own population

- **Closed-case satisfaction for unrecognized charges:** 3.07 of 5. Only 371 of 10,370 cases (3.58%) were closed in the window with a score, so this is a selected subset.
- **Contact-centre CSAT** (scale 1–4 observed): complaint contacts score 2.44, other contacts 2.83. **Within each resolution outcome every contact reason scores about the same:** about 3.0 when resolved and 2.0 when not. The reasons with a lower average are the ones resolved less often. That is a descriptive association, not evidence that resolution causes satisfaction ([#86 F3](../Plans/insights-report.md#4-findings)).

  | Contact reason | Contacts | Resolved | CSAT answers | Mean CSAT | If resolved | If not resolved |
  |---|---|---|---|---|---|---|
  | Queja (complaints) | 99,122 | 43.65% | 18,514 | 2.44 | 3.00 | 2.00 |
  | Retención | 17,396 | 59.89% | 3,237 | 2.61 | 3.01 | 2.00 |
  | Comercial | 46,417 | 65.05% | 8,677 | 2.65 | 2.99 | 2.02 |
  | Técnico | 87,040 | 69.95% | 16,249 | 2.69 | 3.00 | 1.99 |
  | Producto | 127,444 | 89.61% | 23,515 | 2.90 | 3.00 | 2.00 |
  | Transaccional | 203,127 | 91.46% | 37,968 | 2.91 | 3.00 | 1.99 |
- **NPS:** 74.49% of 53,790 answers are detractors (0–6) and none is a promoter: answers stop at 7. So we report the distribution, not the formal score, which would say nothing about loyalty.
- **No survey CSAT exists for unrecognized-charge complainants.** Surveys link to contact-centre interactions, not complaints.

## 4. The cuts: segment, country, channel and language

Segment is today's snapshot. Cells under 30 are not compared.

| Segment | Complaints | Unresolved | SLA breached | Closed-case satisfaction | Complaint-contact CSAT |
|---|---|---|---|---|---|
| Basic | 6,221 | 74.51% | 19.90% | 3.01 (n = 205) | 2.44 |
| Plus | 2,557 | 74.74% | 21.47% | 3.28 (n = 100) | 2.42 |
| Premium | 1,053 | 74.83% | 20.51% | 3.00 (n = 45) | 2.44 |
| Student | 539 | 74.03% | 15.21% | too few (n = 21) | 2.41 |

- **Premium complaints stay unresolved and breach SLAs as often as anyone's.** No segment is handled differently today.
- **By country and by reception channel, unrecognized-charge complaints are handled the same way too.** Country is today's customer snapshot; the channel is where the complaint was received.

  | Cut | Complaints | Unresolved | SLA breached | First response p50 | Closed-case satisfaction |
  |---|---|---|---|---|---|
  | Mexico | 5,188 | 74.69% | 20.28% | 25 h | 3.07 (n = 181) |
  | Colombia | 3,129 | 74.98% | 19.69% | 25 h | 3.04 (n = 120) |
  | Argentina | 2,053 | 73.65% | 20.31% | 25 h | 3.10 (n = 70) |
  | Call Center | 5,210 | 74.64% | 19.94% | 25 h | 3.16 (n = 190) |
  | Email | 2,013 | 75.11% | 19.62% | 25 h | 3.06 (n = 83) |
  | Web | 1,524 | 74.67% | 19.75% | 24 h | 3.12 (n = 43) |
  | App | 1,103 | 73.98% | 21.67% | 24 h | 2.87 (n = 39) |
  | Branch | 402 | 71.89% | 21.39% | 24 h | too few (n = 13) |
  | Regulator | 118 | 75.42% | 21.19% | 26.5 h | too few (n = 3) |

  Half of these disputes (5,210 of 10,370) arrive through the Call Center.
- **By language:** only our live service records it. Its first export (2026-10-02, 5 team and reviewer episodes, on the flow that calls no model) has 1 Spanish and 4 Portuguese reports: 4 accepted as complete handoffs, 1 routed, 0 recorded unsafe. These are counts, not rates; the table and its method are in [EVALUATION.md §9](EVALUATION.md#9-live-service-as-measured).
- **The held-out comparison** of the learned component against the baseline is required too. It is not run yet, and will be reported in [`EVALUATION.md`](EVALUATION.md).

## 5. What not to claim

- Claimed amounts are not losses, and source currencies are never added together.
- No time saved, SLA change or satisfaction change is caused by our product; these are baselines to measure against.
- No complaint links to a transaction ([DF-002, DF-003](DATA_QUALITY.md)), so "large for this customer" is measured only live.
- Survey answers about waiting are not evidence of measured wait, and wait is recorded only for Phone contacts ([DF-027](DATA_QUALITY.md#df-027-wait-time-exists-only-for-phone-contacts-and-survey-wait-answers-dont-track-it)).
- The data is synthetic, and all associations are descriptive.

## 6. Metric dictionary

Every published metric, with what it counts. "Window" is the design window unless it says *full period*; "UC" means `Cargo no reconocido` complaints created in that window. Queries are in [`data_foundation/queries/product/`](../../data_foundation/queries/product/).

| Metric | Population | Numerator / denominator | Window | Query |
|---|---|---|---|---|
| UC complaints a day; share of complaints | All complaints, by `creation_date` | UC complaints / 929 calendar days; UC / all complaints | Design | PR-01 |
| Recorded claims a day | UC complaints | Sum of claimed amounts in source USD, and with FX estimates (creation-day rate) / 929 days; coverage = convertible / UC complaints. Never summed across source currencies | Design | PR-02 |
| Complaint-contact workload | Contacts with `reason_category = 'Queja'` | Observed `duration_seconds` / 3,600 / 929 days; mean over observed durations only | Design | PR-03 |
| Resolution gap | Contact-centre contacts | `was_resolved` contacts / contacts, for `Queja` and for all reasons | Design | PR-03 |
| Unresolved share | UC complaints, and all other complaints | Status Open, In Process or Escalated / complaints (a status snapshot) | Design | PR-04 |
| SLA breach rate | Same | `sla_breached` / complaints with the flag | Design | PR-04 |
| Step durations (p50, p90) | Same, with both dates and a non-negative interval | Assignment → first response; first response → resolution or closing; creation → resolution; `resolution_days` | Design (outcomes may fall in 2026) | PR-04 |
| Escalated time open (p50, p90) | UC complaints with status Escalated | Data end (latest `creation_date`) − creation | *Full period* | PR-05 |
| Repeat customers; re-open proxies | Customers with UC complaints; UC complaints | Customers with 2 or more / customers; complaints after an earlier one by the same customer (within 30 or 90 days, or after its outcome) / complaints | Design | PR-10 |
| Closed-case satisfaction (F5) | UC complaints | Mean `resolution_satisfaction` over complaints closed in the window with a score; coverage = scored / UC complaints | Design | PR-06 |
| Contact CSAT, CES, NPS | Surveys joined one-to-one to their contact | Mean and share by score, by contact reason and resolution; NPS detractors (0–6) / answers | Design | PR-07 |
| Cuts by segment, country, channel | UC complaints, by the customer's snapshot segment or country, or by `reception_channel` | Unresolved, SLA breached, escalated / complaints; first response p50; F5 mean. Cells under 30 publish no numerators | Design | PR-08, PR-11, PR-12 |
| Complaint-contact CSAT by segment | CSAT surveys of complaint and other contacts | Mean score; share scoring 4 / answers | Design | PR-09 |
| Live outcomes by language | Report episodes in the live store at export | Counts only (5 episodes) | 2026-10-02 export | [EVALUATION.md §9](EVALUATION.md#9-live-service-as-measured) |
