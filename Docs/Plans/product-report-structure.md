# Product report: build plan

- **Status:** Draft for team review (v3: v2 plus gaps found in the v1→v2 comparison, aligned with #86 and scoped for 2026-10-05). No figure here is final: each one comes from a query, and is published with that query.
- **Owner:** Manoella R. Branch `data/analytics-kpis`.
- **Date:** 2026-10-03
- **Builds on:** `Docs/Plans/insights-report.md` (Lucas, [PR #86](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/pull/86)). It defines the problem-sizing KPIs, the survey findings F1–F5, "what not to claim" and the queries. This plan doesn't repeat them; it adds the product questions below and how the report gets built.

## Scope for 2026-10-05
Submission closes on 2026-10-05. Nothing below is deleted; sections are only ordered.
- **By 10-05:**
  - section 0: KPIs 1–3 and the 43.60% against 76.65% resolution figure, as reviewed `make report` aggregates with their SQL;
  - section 4, the "before" picture: unresolved share, SLA breaches, time to first response and to close (non-escalated), closed-case satisfaction (F5), contact-centre CSAT by resolution;
  - section 9's segment cut;
  - F1 and the wait missingness registered as DF-027 in `DATA_QUALITY.md`;
  - section 11, the limits.
- **After 10-05, or only if time allows:**
  - sections 2 and 5 (critical customers and the priority order are stated policies, not demanded by the brief);
  - section 6 (re-open proxies) and section 3 (agents per day);
  - sections 7 and 8 (they need a D1 export and a latency run);
  - section 12, the `/insights` page (needs Roberto).

## Purpose and audience

The evaluators asked for the problem explained "using KPIs and values", with limitations "fully listed" (quoted in the insights report). The report answers three questions about the unrecognized-charge intake product (ADR-002):
1. **Who and what:** the customers, the agents, and how disputes are handled today (the "before" picture).
2. **What success looks like:** lower agent handle time while satisfaction holds, and verification answered fast.
3. **What the real risk is:** a wrong refund or policy answer, and the AI failing a dispute.

## Where it's built (from #86 §2)

- **Historical figures:** offline, by extending `make report` (`data_foundation/reports/`). The output is reviewed aggregate JSON plus the SQL that produced it, with no customer IDs, on the design window (2023-06-17 to 2025-12-31, ADR-005). The Worker never reads Silver.
- **Our own service:** time to pickup and to close, by urgency, kind, language and reason, from the D1 status history and the event export.
- **The `/insights` page:** a later, read-only page behind the admin banner that shows the committed JSON. It needs no new data path or API, and comes after the aggregates are reviewed. Its content is in section 12.

## Ground rules

- **Each metric states** its population, numerator, denominator, window, grain, joins, exclusions and coverage (AGENTS.md).
- **Currencies are never summed across currencies.** FX estimates stay flagged.
- **Customer attributes are today's snapshot.**
- **The data is synthetic, and associations are descriptive.**
- **A small denominator says so.** For example, the live sample is 5 team episodes.
- **The frozen evaluation is cited only through its published aggregates.**
- **Outcome dates:** a complaint enters a design-window metric by its `creation_date` (before 2026-01-01). Its durations may end in 2026: in the design-window unrecognized-charge cohort, 38 resolution, 7 closing and 18 first-response dates fall in 2026. They are kept, and the chart says so.
- **A *full period* metric** (to the data end, 2026-06-18) is labelled as such; every other metric uses the design window.
- **Every query is re-run after `make pipeline`,** and each figure is published with its SQL and the quality run ID it came from.
- **Everything in the insights report's §5, "What not to claim",** applies here, including: no CSAT for unrecognized-charge complainants, and no "large for this customer" on dataset complaints.

## Report sections

### 0. Executive summary
- **Leads with the insights report's KPIs 1–3,** each with its denominator, coverage and limit:
  - unrecognized-charge demand (11.16 a day; 18.28% of complaints);
  - recorded claims (US$2,327 a day in USD; US$2,474 a day with FX estimates; 31.78% coverage; not losses or savings);
  - complaint-contact workload (11.08 observed hours a day, all complaint contacts). A cost per contact is only a scenario: it needs a supplied rate, which the data doesn't have.

  Reproduced on two Silver builds, including quality run `20261002T232200Z`.
- **The resolution gap** (#86 F3): complaint contacts were resolved in 43.60% of cases (51,021 of 117,021) against 76.65% for all contacts (526,030 of 686,296). Reproduced on quality run `20261002T232200Z`.
- **Then the tiles this plan adds:**
  - the share of unrecognized-charge complaints left unresolved;
  - their **SLA breach rate against other complaint types**;
  - time to first response;
  - customers served;
  - verification p95 against the 4 s target;
  - recorded unsafe outcomes.
- **Charts for KPIs 1–3:**
  - daily unrecognized-charge complaints with a p50/p95 band, plus their share of complaints per year (stable at 18.2–18.4%, DF-010);
  - recorded claimed amounts **per currency, one panel each** (never pooled), with the USD and FX-estimated parts marked;
  - complaint-contact hours per day, as a time series.

  Each tile shows its denominator and coverage under the value.

### 1. Who are our customers?
| Metric | Definition and source | Chart |
|---|---|---|
| Population profile | Country, segment (Basic, Plus, Premium, Student), education, age band, occupation. `silver.dim_customers`, a snapshot of 150,000 | Bars, one panel per country |
| Language and region | `detected_accent` (30% missing, DF-011), and country. Source text is Spanish only (DF-001); Portuguese and English are product languages | Stacked bar |
| Disputing customers against the base | The same profile for unrecognized-charge complainants (DF-022), as share against base share | Dot plot |
| Customers the product serves | 10,013 complainants → 9,834 not currently closed → 796 served → 2,906 charges, with the mix against reference shares (cohort manifest) | Funnel, plus a dot plot |

### 2. Which customers are the most critical? (a stated policy, not a learned score)
- **Criteria, each counted on dataset complaints:**
  - repeat unrecognized-charge complainant;
  - source priority `High` or `Critical`;
  - Premium segment;
  - SLA breached on an open complaint.
- **"Amount large for this customer"** is measured only **live**, through the urgency rule (`back-end/src/config/urgency.json`). Dataset complaints match no transaction (DF-003).
- **Never used:** `fraud_score` and `is_fraud` (they leak the label), and credit score or income for ranking people.
- **Charts:** the count per criterion, overlaps, and the split by country and segment.

### 3. Agents and operations today
Design window. `contact_reason` equals `reason_category` in every row (0 differ), and neither identifies unrecognized charges: `Queja` covers all complaint contacts.

| Metric | Definition and source | Chart |
|---|---|---|
| Agents | 1,200 in `dim_service_agents`, by type, experience, specialty, shift (a snapshot) | Bars |
| Agents per day: contact centre | Distinct `agent_id` per business day in `fact_call_center_interactions`: p50, p95, max | Time series with a band |
| Agents per day: complaint handling | Distinct `assigned_agent_id` per day of `assignment_date` in `fact_complaints`, overall and for unrecognized charges (66% of those have an assignment) | The same chart, second series |
| Load per agent | Interactions per active agent per day | Histogram |
| Handle time | `duration_seconds` (86% filled) by reason (`Queja` against the others), channel, experience and `was_escalated`. **By escalation, always split by resolution:** unresolved contacts drive the gap, and escalation alone would suggest a false effect (#86 F3). `wait_time_seconds` exists **only for Phone** (insights report §3) | ECDF curves or box plots |
| Escalation rate | `was_escalated` over interactions, by reason | Bar chart with counts |

### 4. The "before" picture: unrecognized-charge complaints against the other types
Source: `fact_complaints`, design window.

| Metric | Definition | Coverage and limits |
|---|---|---|
| Unresolved | `Open` + `In Process` + `Escalated` over all complaints of the type | A status snapshot |
| SLA breach rate | `sla_breached` | Fully filled |
| Resolution days | `resolution_days`: p50, p90 | Where filled |
| Time to first response | `first_response_date − assignment_date` | Unrecognized charges: assignment 66%, first response 61.5% |
| Time to close (agent) | `resolution_date − first_response_date`, `closing_date − first_response_date` | Resolution 23%, closing 3.9%. **Escalated complaints have none** (618 of them, 0 resolution and 0 closing dates) |
| Escalated: status age (substitute for time to close) | `2026-06-18 (data end) − creation_date` for complaints still `Escalated`, and `− first_response_date` where present. Labelled *full period* | A lower bound on how long escalated cases stay open, not a closing time |
| Customer's total wait | `resolution_date − creation_date` | Non-escalated, resolved cases only |
| Satisfaction | **Closed-case complaint satisfaction** only (F5: 371 cases, mean 3.07 out of 5, 3.6%, a selected subset) | No survey CSAT for this complaint type |
| Outcome and priority | `resolution` (5 templates), `compensation_granted` (7.4% filled), `priority` | — |

**Segmentation:** escalated or not (escalated cases get first response and status age only), segment, country, priority.

**Contact-centre satisfaction**, kept separate and clearly labelled as complaint *contacts* (`Queja`, not unrecognized charges):
- the resolution gap: 43.60% of complaint contacts resolved against 76.65% of all contacts (section 0);
- CSAT by resolution and contact reason (F3, F4);
- CES and NPS with their own populations, on the observed scales (CSAT 1–4, CES 1–4, NPS 2–7, all inside the documented scales).

Survey answers and comments are never charted as evidence of wait or quality (F1, F2).

**Charts:**
- unrecognized charges against each other type, one small-multiple panel per metric (unresolved share, SLA breach rate, p50/p90 resolution days);
- ECDF curves of time to first response and time to close, non-escalated against escalated (first response only);
- CSAT, CES and NPS distributions by contact reason, each panel with its n.

### 5. Is handle time linked to the disputed amount? A priority order
- **Amount against handle time:** for the 33% of unrecognized-charge complaints with a `claimed_amount`, compare amount bands **within each currency** against time to first response, time to close and SLA breaches.
  - **Method:** medians by band, plus Spearman correlation. Descriptive only.
  - **Caveats:** DF-003, DF-023 (claimed currencies ignore the customer's country), DF-024.
- **Proposed priority order** for cases, a stated policy:
  1. the urgency lane (amount over the threshold, or over the customer's p95, live only);
  2. source priority `Critical`/`High`;
  3. repeat complainant;
  4. SLA at risk;
  5. arrival order.

  **Check:** whether higher tiers breach SLAs and take longer today. Descriptive, not a claim that prioritizing helps.
- **Charts:**
  - box plots of time to first response by amount band, one panel per currency;
  - SLA breach rate by priority tier, as bars with counts.

### 6. Unresolved and re-opened cases
- **Unresolved:** counts and age of `Open`, `In Process` and `Escalated` unrecognized-charge complaints, by country and priority.
- **Re-opened: no such status exists in the source.** Labelled proxies:
  - a repeat unrecognized-charge complaint by the same customer within 30 or 90 days of a resolved or closed one;
  - `is_repeat_complainer`;
  - `Escalated`.
- **In the product:** a second report for a charge after its report was closed. While a report is open, a second one is refused with 409, though that check isn't yet atomic across episodes (insights report §6).
- **Charts:**
  - unresolved complaints by status and age band, as stacked bars;
  - repeat-complaint rate within 30 and 90 days, by country.

### 7. The product and its service outcomes
- **The flow:** Cognito sign-in → charges → one-tap reason (#81) → pick and confirm → reference after read-back → a person reviews it → email at each step (attempted once; "sent" means SES accepted it).
- **Live KPIs** (`evals/intake/episodes.py`, EVALUATION §9):
  - safe accepted intake over eligible starts;
  - the funnel;
  - complete, incomplete and technical handoffs;
  - turns and episode span;
  - plus time to pickup and to close, by urgency, kind, **language** and **reason**.

  **Currently 5 team episodes, all with safety not assessed.** They support no rate.
- **Automated resolution** (ADR-009): charge views displayed over eligible requests. Cost per resolution is "not defined" while that is zero.
- **Charts:**
  - the intake funnel, with counts at every step;
  - outcome mix by language;
  - time to pickup and to close by urgency and reason.

  Each chart carries an "n = 5 team episodes" label until real volume exists.

### 8. What success looks like: baseline, target, current
| Success metric | Baseline (from section 4) | Target | Current measurement |
|---|---|---|---|
| Agent time to answer: assignment → first response (non-escalated and escalated) | p50/p90 | Lower | Product: received → in review (status history) |
| Agent time to close: first response → resolution or closing (non-escalated only) | p50/p90, with coverage | Lower | Product: in review → closed |
| Escalated cases: time open (substitute, since there is no closing date) | Status age of escalated complaints (section 4) | Lower | Product: in review → closed for reports a person escalates. Same metric, live |
| CSAT holds | Contact-centre CSAT for complaint contacts (`Queja`), by resolution (F3, F4); closed-case complaint satisfaction (F5) | Hold | Not measurable until real users take part (the user test in the customer contract). In-app thumbs up/down is not CSAT |
| **NPS holds** | Contact-centre NPS answers for complaint contacts against other reasons: the **distribution and mean** (63,668 NPS surveys overall). **The standard NPS score is degenerate here:** answers stop at 7 on the 0–10 scale, so no one is a promoter (9–10) and the score is almost entirely detractors. Report the distribution, and the formal NPS only with that caveat | Hold | Same as CSAT: needs real users |
| **Verification answered in under 4 s, 95% of the time** | Not in the data | **p95 < 4 s** | Server time of `GET /transactions`, `POST /intake/start` and `POST /intake/confirm`. Known so far: about 1.4 s for one earlier episode, and confirm projected at about 1.2 s of D1 waiting (ADR-004). **To do:** a scripted run against the deployed Worker recording p50/p95 per request. The extractor is off the path (its own p95 is 3.58 s) |
| Safe accepted intake | — | High, with 0 unsafe | Event export |

**Chart:** one row per success metric, a "baseline → target → current" bullet chart, with "not yet measured" shown as an empty marker rather than a zero.

### 9. The required cuts (brief pp. 3, 5–6)
- **Service outcomes by language** (live episodes) **and by customer segment.** The segment comes from `customers.segment` (a snapshot), through the survey's or complaint's own `customer_id` for historical figures. Live D1 has no segment field yet.
- **The held-out comparison of the learned component against the baseline** is required and still blocked on #77's host decision. This report cites its published aggregates when they exist, and never frozen content.
- **Chart:** small multiples of each outcome (resolved share, SLA breaches, satisfaction where it exists) by segment, and of each live outcome by language. Every panel shows its n, and panels below a minimum n are shown as "too few to compare".

### 10. What is the real risk?
- **A wrong refund or policy answer:**
  - the product never refunds, blocks a card or decides fraud (ADR-002), so a wrong refund by the system is structurally 0;
  - today's exposure is compensation granted on unrecognized-charge complaints (count and rate per currency, 7.4% filled);
  - policy answers are measured as unsafe outcomes from the evaluation's published aggregates: counts over denominators, with an upper bound, by language.
- **The AI failing a dispute:**
  - the incomplete-handoff rate;
  - the product's reopen signal (section 6);
  - shadow extractor agreement and the latency trigger;
  - the held-out comparison (section 9).
- **Trust indicators** (the "trust" half of "cost money and trust"), descriptive:
  - CSAT and NPS for complaint contacts against other reasons (sections 4 and 8);
  - the repeat-complaint proxy (section 6);
  - the unresolved share and SLA breaches for unrecognized charges (section 4);
  - in the product: the incomplete-handoff share, and reports a customer files again after closing.
- **Chart:** a risk table rather than a plot: each risk, its indicator, the current value with its denominator, and "structural 0" or "not yet measured" where that applies.
- **Also listed:**
  - the cost of handling is a scenario only: contact hours times a supplied rate, never a figure from the data;
  - friendly fraud can't be measured (DF-025);
  - the cohort is a selection, not a sample (holdout disclosure);
  - the data is synthetic.

### 11. Data trust and limits
- The quality gate (run ID, checks, errors, warnings), lineage counts from S3 to D1, and freshness (2026-06-17).
- The findings register, plus the **new finding to register as DF-027:** F1 (no substantial association between survey answers and measured wait or quality) and wait missing on every non-phone channel (design window: Phone 406,622 of 493,375 filled; other channels 0 of 87,171).
- The insights report's §5, "What not to claim", in full.

### 12. Evaluator dashboard (`/insights`, behind the admin banner)
- **Who sees it:** evaluators enrolled as admins (#80). Read-only. It shows the committed aggregate JSON only, with no customer rows and no new API.
- **What it shows, in this order** (KPIs first, as #86 recommends):
  1. **KPIs 1–3,** with their denominators and limits;
  2. **the "before" picture** (section 4): unresolved share, SLA breaches, time to first response and to close, non-escalated against escalated;
  3. **satisfaction:**
     - **CSAT** for complaint contacts by resolution;
     - **CES** for complaint contacts against other reasons;
     - **NPS** for complaint contacts against other reasons;
     - closed-case complaint satisfaction (F5);

     each with its population, and none labelled as CSAT for unrecognized charges;
  4. **segment cuts:** escalated against not, and Premium against other segments. "Amount large for this customer" is shown only from the live product;
  5. **the success table** (section 8), with the 4 s target.
- **Each number carries** its population, denominator, window and limit underneath, as in the report.
- **Owners:** the JSON contract is Manoella's; the route and charts are Roberto's.

### Appendix: metric dictionary and queries
- **The metric dictionary:** one row per metric in the report and on the dashboard, with:
  - name and section;
  - population, numerator and denominator;
  - window and grain;
  - joins and their cardinality, exclusions, missingness or coverage;
  - source query file;
  - chart.

  A metric without a complete row doesn't enter the report.
- **Queries:**
  - the insights report's appendix (KPIs 1–3, F1–F5);
  - the existing `data_profiles/findings/queries/DF-*.sql`;
  - new queries, one SQL file per metric, next to the `make report` code that runs them. All read-only, aggregates only, design window unless labelled *full period*.

## Build order
1. **Section 0, KPIs 1–3,** as reviewed aggregates in `make report`, with their SQL (insights report next steps 1–2).
2. **Register F1** and the wait missingness in `DATA_QUALITY.md`, with a query (next step 3).
3. **Sections 1, 3, 4, 5 and 6** from Silver, with satisfaction shown only with its population (next step 4).
4. **Section 9's segment cut** (next step 5), then sections 7 and 8 from the D1 export, plus the latency run.
5. **Sections 10 and 11,** then the `/insights` page (section 12) with Roberto, once the aggregates are reviewed.

The metric dictionary grows with each step: a metric is added to it when its query is written, not at the end.

## Open decisions
1. **Report format:** the `make report` HTML hub only, or also a Markdown deliverable (`Docs/deliverables/PRODUCT_REPORT.md`) with static charts.
2. **Whether the critical-customer and priority definitions** stay report-only, or are proposed for the product.
3. **Who runs the latency measurement** for the 4 s target, and who exports the D1 status history.
