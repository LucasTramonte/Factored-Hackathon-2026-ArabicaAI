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

## 4. The required cut: by customer segment

Segment is today's snapshot. Cells under 30 are not compared.

| Segment | Complaints | Unresolved | SLA breached | Closed-case satisfaction | Complaint-contact CSAT |
|---|---|---|---|---|---|
| Basic | 6,221 | 74.51% | 19.90% | 3.01 (n = 205) | 2.44 |
| Plus | 2,557 | 74.74% | 21.47% | 3.28 (n = 100) | 2.42 |
| Premium | 1,053 | 74.83% | 20.51% | 3.00 (n = 45) | 2.44 |
| Student | 539 | 74.03% | 15.21% | too few (n = 21) | 2.41 |

- **Premium complaints stay unresolved and breach SLAs as often as anyone's.** No segment is handled differently today.
- **By language:** only our live episodes carry it, and there are 5 team episodes so far, too few for any rate.
- **The held-out comparison** of the learned component against the baseline is required too. It is not run yet, and will be reported in [`EVALUATION.md`](EVALUATION.md).

## 5. What not to claim

- Claimed amounts are not losses, and source currencies are never added together.
- No time saved, SLA change or satisfaction change is caused by our product; these are baselines to measure against.
- No complaint links to a transaction ([DF-002, DF-003](DATA_QUALITY.md)), so "large for this customer" is measured only live.
- Survey answers about waiting are not evidence of measured wait, and wait is recorded only for Phone contacts ([DF-027](DATA_QUALITY.md#df-027-wait-time-exists-only-for-phone-contacts-and-survey-wait-answers-dont-track-it)).
- The data is synthetic, and all associations are descriptive.
