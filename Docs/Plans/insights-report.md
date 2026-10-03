# Insights report: what the data supports

For whoever builds the problem-sizing and satisfaction report for the judges. It covers which figures the data supports, which only look like insight, where the report should live, and what to do next.

The evaluators asked for exactly this: "properly explaining the problem (PLEASE INCLUDE METRICS to demonstrate why your problem matters)… using KPIs and values… and limitations are fully listed". So the KPIs come first, every figure carries its population and denominator, and the limits sit next to the numbers.

**Provenance.**
- **Data:** the local full Silver build (`data/full_local/latam_bank.duckdb`), opened read-only and queried with grouped SQL only (appendix). No record or identifier is reproduced here.
- **Quality gate:** the adversarial review of 2026-10-03 re-ran it: 390 checks, 0 errors, 7 warnings. One of the warnings is that all 44,570 complaint→product links point to another customer's product (DF-002).
- **Windows:** problem-sizing KPIs and design diagnostics use business timestamps from 2023-06-17 to 2025-12-31 (929 calendar days, empty days included), following [ADR-005](../ADRs/ADR-005-evaluation-data-protocol.md). Survey figures marked *full period* (2023-06-17 to 2026-06-19) are exploratory. Outcome timestamps are bounded separately: 38 resolution dates and 7 closing dates of the design cohort fall in 2026.
- **Re-run before publishing:** run every query again after `make pipeline` passes, and publish the SQL with the figures. The appendix reproduces every figure in this document; the agent-level cell sizes in F1 come from the adversarial review's own grouped query.

## 1. Problem-sizing KPIs

| # | KPI | Value | Population, numerator, denominator, exclusions |
|---|---|---|---|
| 1 | Unrecognized-charge demand | **11.16 cases a day; 18.28% of all complaints** | Complaint grain, `complaints.subcategory = 'Cargo no reconocido'`, filtered on `creation_date`. 10,370 cases out of 56,736 complaints, over 929 days. No survey selection. |
| 2 | Recorded claimed amounts | **US$2,327.14 a day** in claims recorded directly in USD; **US$2,473.52 a day** including FX-estimated ones | 835 of 10,370 cases (8.05%) are in USD: US$2,161,914.20. Another 2,461 are FX-estimated at the creation-day rate: US$135,989.84, flagged as estimated. Combined coverage: 3,296 of 10,370 (31.78%). Excluded: 6,919 cases with no amount and 155 with an amount but no currency. |
| 3 | Complaint-contact workload | **106.70 contacts and 11.08 observed contact hours a day** | Interaction grain, `reason_category = 'Queja'`. 99,122 contacts and 10,295.42 observed hours over 929 days. Mean duration is 434.71 s over 85,261 observed durations; 13,861 durations are missing. |

How to read them:
- **KPI 2 is not a loss or a saving.** These are synthetic *recorded claims*, with incomplete coverage. Claimed currencies ignore the customer's country (DF-023), so even a correct FX conversion can't make the amounts realistic.
- **KPI 3 is all complaint contacts, not unrecognized charges.** `contact_reason` equals `reason_category` everywhere, and neither identifies an unrecognized charge.
- **Cost per contact can't be measured.** No field holds a contact cost or labour rate (marketing `send_cost` is unrelated). With a bank-supplied fully loaded hourly rate, `11.08 h/day × rate` is a *scenario*: it states the cost of the workload, not a measured saving.
- **Complaint contacts are the least resolved.** In the call center, `Queja` contacts are resolved 43.60% of the time (51,021 of 117,021, full period), against 76.65% for all contacts (526,030 of 686,296). The same 43.6% holds for surveyed and unsurveyed `Queja` contacts. This describes complaint contacts in general, not unrecognized charges.

## 2. Where the report lives (proposal, not built)

- **Historical figures:** offline, by extending the aggregate report (`make report`, `data_foundation/reports/`), with reviewed aggregates and no IDs. The Worker never reads Silver (AGENTS.md).
- **In the app:** an `/insights` page could show that committed JSON. **It doesn't exist yet**; there is no such route in `front-end/src/app/app.routes.ts`.
- **Our own service:** D1 records when each report is accepted, picked up (`in_review`) and closed. From that we can compute time to pickup, review time and time to close, by urgency, kind, language and reason. D1 has no customer-segment field.
- **What the brief requires:** a dashboard is optional (problem statement p. 4). What is **required** (pp. 3, 5–6) is the held-out comparison of the learned component against the baseline, plus service outcomes compared by language and authorized customer segment, with small-sample limits stated. Historical charts do not replace either.
- **Evaluators and customer data:** the dataset is fully synthetic. An evaluator enrolled as admin can open individual reports in the approved agent queue, and is a customer only on their own synthetic identity. There is no unrestricted customer browser ([auth runbook](auth-runbook.md#11-evaluator-access)).

## 3. The survey data

`satisfaction_surveys` holds 212,759 surveys, exactly one per call-center interaction: 212,759 distinct `interaction_id`, with no customer or agent mismatch. It does not join to complaints, because `origin_interaction_id` is empty in all 67,095 complaints (DF-003).

- **`survey_type` and `main_score`:**
  - CSAT, 127,856 surveys, observed scores 1–4;
  - CES, 21,235, observed 1–4;
  - NPS, 63,668, observed 2–7.

  These are observed ranges, and they fit the documented scales (CSAT 1–5, NPS 0–10). They don't contradict them. A "score ≥ 3" share is therefore a custom threshold. On the documented scale, CSAT 4–5 occurs in 14.79% of resolved surveys and 0% of unresolved ones.
- **Five fixed Spanish questions,** answered 1–5, 0 to 3 per survey. The wait question always sits in slot 2.

  | Question | Occurrences |
  |---|---|
  | ¿El tiempo de espera fue aceptable? | 81,371, of which 77,371 answered |
  | ¿Cómo calificaría la atención brindada? | 40,667 |
  | ¿El agente resolvió su consulta satisfactoriamente? | 40,489 |
  | ¿Qué tan satisfecho está con el servicio recibido? | 40,147 |
  | ¿Volvería a contactarnos por este canal? | 40,144 |

- **`open_comments`:** 13 fixed sentences (5 negative, 3 neutral, 5 positive), on 101,196 surveys.
- **Wait time is missing for every non-phone channel.** In the design-window survey population, Phone has 126,094 observed waits out of 152,972 contacts; Email, App, WhatsApp, Web Chat and Web have none.

## 4. Findings

Verdicts are from the adversarial review of 2026-10-03, reproduced before this edit. All of them are **descriptive associations**, not causal estimates.

- **F1. No substantial association was found between the question answers and the measured experience.**
  - Answers to the wait question are approximately uniform across 1–5.
  - Its Pearson correlation with the interaction's `wait_time_seconds` is 0.0003, over 54,331 complete pairs. Its correlation with `main_score` (survey types mixed) is −0.0001. The design-window Spearman correlation is −0.0013.
  - Mean answers stay between 2.99 and 3.02 across wait quintiles (full period, complete pairs).
  - For the wait question, the largest absolute correlation with wait is 0.006 across countries, 0.013 across survey types and 0.07 across months (cells with at least 100 pairs). The adversarial review's broader check, over all five questions in the design window, found at most 0.022 and 0.10.
  - **Limits:** wait is observed only for Phone; agent-level cells have 5 to 61 pairs; and the fixed slot prevents a slot comparison. So "no signal at all" is not proven.
  - **Use:** don't chart these answers as evidence of wait or quality.
- **F2. Comments go with lower scores, but not with longer waits.**
  - People who wrote a wait complaint ("Tardaron mucho en atenderme.", "Tuve que esperar demasiado tiempo.") waited 120.61 s on average, against 119.88 s for those who left no comment (full period).
  - Their CSAT is 2.606 (21,629 CSAT surveys), against 2.764 for no comment (66,928) and 2.855 for other comments (39,299).
  - The mechanism that generated the comments is not known. Don't claim it.
- **F3. Resolution goes with satisfaction, but does not fully explain it.**
  - CSAT averages 2.999 when resolved (97,851 surveys) and 2.003 when not (30,005), with a variance of about 0.30 inside each group.
  - In 93,090 design-window CSAT surveys with a duration, resolution accounts for about 37.7% of the score variance.
  - Duration's correlation with CSAT is −0.165 overall but 0.001 once each resolution group's mean is removed, so longer calls are not independently worse.
  - Escalation makes little difference once resolution is known.
- **F4. Complaint contacts have the lowest resolution and satisfaction.** Surveyed `Queja` contacts: 43.60% resolved (15,851 of 36,357), CSAT 2.434 (21,843 CSAT surveys). See §1 for what this does and doesn't size.
- **F5. Satisfaction for unrecognized-charge complaints exists only for a small, selected subset.**
  - `complaints.resolution_satisfaction` (1–5) is scored on 371 unrecognized-charge complaints closed before 2026: mean 3.067. That is 3.58% of the 10,370-case cohort.
  - It describes cases that completed, and the score's timestamp is unknown.
  - It may be shown only as **closed-case complaint satisfaction**, with those limits stated.

## 5. What not to claim

- **The CSAT of unrecognized-charge complainants.** Surveys don't link to complaints, and `customer_id` alone is not a case link (AGENTS.md).
- **Time to resolution for escalated complaints.** They have no resolution or closing dates.
- **"Large charge versus the customer's history" on dataset complaints.** No complaint matches a transaction (DF-003). This is measurable only live, through our urgency rule.
- **Survey answers or comments as evidence of wait or quality** (F1, F2).
- **Claimed amounts as losses, recoveries or savings,** and the workload as a cost without a supplied rate (§1).
- **That resolution "explains" satisfaction, or any causal effect** (F3).
- **That binary in-app feedback equals CSAT or CES.** Reusing the bank's wording helps comparability; it doesn't make a thumbs up/down a CSAT score. (Thumbs up/down is a team requirement, not one from the brief.)

## 6. Next steps

**For the insights report (Manoella):**
1. **Lead with KPIs 1–3,** with their denominators, coverage and the limits under them. This is what the evaluators asked for.
2. **Build them as reviewed aggregates** in `make report`, from the appendix queries, design window only, and commit the SQL and quality evidence with the figures. Leave the `/insights` page for after the aggregates are reviewed.
3. **Register F1 and the channel-dependent wait missingness** as a finding in [`DATA_QUALITY.md`](../deliverables/DATA_QUALITY.md), with its query.
4. **Show satisfaction honestly:** call-center CSAT by resolution and contact reason (F3, F4), and closed-case complaint satisfaction (F5), each with its population. No survey CSAT for unrecognized charges.
5. **Prepare the segment cut** the brief requires: language comes from our live episodes; customer segment needs `customers.segment` (a current snapshot) through the survey's or complaint's own `customer_id`. Live D1 has no segment yet.

**For the team (owners to agree):**
- **Run the held-out comparison of the learned component against the baseline** (it waits on the host decision in #77). It is required by the brief, and no historical chart replaces it.
- **Make "one open report per charge" atomic.** Two simultaneous confirmations of one charge from different episodes can open two reports today.
- **Say plainly in the demo that the live sample is five team episodes,** and that email is attempted once.

## Review history

2026-10-03: an adversarial review (Codex) re-ran every query. It corrected three things in the first version of this document:
- the comment comparison mixed CSAT, CES and NPS (F2);
- "resolution fully explains satisfaction" and the independent duration effect were wrong (F3);
- the wait-question count conflated occurrences with answers (F1).

It also added the KPIs in §1, the closed-case satisfaction subset (F5), the channel-dependent missingness, and the design-window convention.

## Appendix: queries

DuckDB on Silver, `read_only=True`, grouped output only. The KPIs use the design window.

```sql
-- KPI 1: unrecognized-charge demand
SELECT count(*) all_complaints,
       count(*) FILTER (WHERE subcategory = 'Cargo no reconocido') target_cases,
       count(*) FILTER (WHERE subcategory = 'Cargo no reconocido') / 929.0 cases_per_day
FROM silver.fact_complaints
WHERE creation_date >= TIMESTAMP '2023-06-17' AND creation_date < TIMESTAMP '2026-01-01';

-- KPI 2: recorded claimed amounts; creation-day FX is a stated convention, kept flagged
WITH c AS (
  SELECT creation_date::DATE d, currency, claimed_amount a FROM silver.fact_complaints
  WHERE subcategory = 'Cargo no reconocido'
    AND creation_date >= TIMESTAMP '2023-06-17' AND creation_date < TIMESTAMP '2026-01-01'),
v AS (
  SELECT c.*, CASE WHEN currency = 'USD' THEN a ELSE a * fx.exchange_rate END usd,
         currency <> 'USD' AND a IS NOT NULL AND fx.exchange_rate IS NOT NULL AS estimated
  FROM c LEFT JOIN silver.dim_fx_rates fx
    ON fx.rate_date = c.d AND fx.source_currency = c.currency AND fx.target_currency = 'USD')
SELECT count(*) cases, count(a) amount_present, count(usd) convertible,
       count(*) FILTER (WHERE a IS NOT NULL AND currency IS NULL) amount_without_currency,
       sum(usd) FILTER (WHERE currency = 'USD') direct_usd,
       count(*) FILTER (WHERE estimated) estimated_cases, sum(usd) FILTER (WHERE estimated) estimated_usd,
       sum(usd) / 929.0 combined_usd_per_day
FROM v;

-- KPI 3: complaint-contact workload
SELECT count(*) contacts, count(duration_seconds) observed, count(*) - count(duration_seconds) missing,
       sum(duration_seconds) / 3600.0 / 929.0 observed_hours_per_day, avg(duration_seconds) mean_seconds
FROM silver.fact_call_center_interactions
WHERE reason_category = 'Queja'
  AND interaction_date >= TIMESTAMP '2023-06-17' AND interaction_date < TIMESTAMP '2026-01-01';

-- F1: wait question occurrences, answers, pairs and correlations
WITH w AS (
  SELECT i.wait_time_seconds wait, s.main_score,
         (question_1_text LIKE '%espera%' OR question_2_text LIKE '%espera%' OR question_3_text LIKE '%espera%') asked,
         CASE WHEN question_1_text LIKE '%espera%' THEN question_1_response
              WHEN question_2_text LIKE '%espera%' THEN question_2_response
              WHEN question_3_text LIKE '%espera%' THEN question_3_response END r
  FROM silver.fact_satisfaction_surveys s JOIN silver.fact_call_center_interactions i USING (interaction_id))
SELECT count(*) occurrences, count(r) answers, count(wait) FILTER (WHERE r IS NOT NULL) pairs,
       corr(r, wait), corr(r, main_score)
FROM w WHERE asked;

-- F2: comment groups, CSAT only
SELECT CASE WHEN open_comments IN ('Tardaron mucho en atenderme.', 'Tuve que esperar demasiado tiempo.') THEN 'wait complaint'
            WHEN open_comments IS NULL THEN 'no comment' ELSE 'other comment' END grp,
       avg(i.wait_time_seconds) mean_wait,
       count(*) FILTER (WHERE survey_type = 'CSAT') csat_n, avg(main_score) FILTER (WHERE survey_type = 'CSAT') csat
FROM silver.fact_satisfaction_surveys s JOIN silver.fact_call_center_interactions i USING (interaction_id) GROUP BY 1;

-- F3: CSAT within resolution groups; duration after removing each group's mean
WITH r AS (
  SELECT main_score m, duration_seconds d,
         main_score - avg(main_score) OVER (PARTITION BY was_resolved) sy,
         duration_seconds - avg(duration_seconds) OVER (PARTITION BY was_resolved) sd
  FROM silver.fact_satisfaction_surveys s JOIN silver.fact_call_center_interactions i USING (interaction_id)
  WHERE survey_type = 'CSAT' AND duration_seconds IS NOT NULL
    AND survey_date < TIMESTAMP '2026-01-01' AND interaction_date < TIMESTAMP '2026-01-01')
SELECT count(*), corr(m, d) marginal_r, corr(sy, sd) within_resolution_r, 1 - var_pop(sy) / var_pop(m) resolution_r2 FROM r;

-- F4 and §1: resolution and CSAT by contact reason, surveyed and all contacts
SELECT reason_category, count(*) contacts, avg(was_resolved::int) resolved,
       count(s.interaction_id) surveyed,
       avg(main_score) FILTER (WHERE survey_type = 'CSAT') csat
FROM silver.fact_call_center_interactions i
LEFT JOIN silver.fact_satisfaction_surveys s USING (interaction_id)
GROUP BY ROLLUP (reason_category);

-- F5: closed-case satisfaction of unrecognized-charge complaints
SELECT count(resolution_satisfaction) FILTER (WHERE closing_date < TIMESTAMP '2026-01-01') scored_closed,
       avg(resolution_satisfaction) FILTER (WHERE closing_date < TIMESTAMP '2026-01-01') mean_satisfaction,
       count(*) cohort
FROM silver.fact_complaints
WHERE subcategory = 'Cargo no reconocido' AND creation_date < TIMESTAMP '2026-01-01';
-- §3: score ranges by survey type, and CSAT 4-5 share by resolution
SELECT survey_type, count(*), min(main_score), max(main_score) FROM silver.fact_satisfaction_surveys GROUP BY 1;
SELECT i.was_resolved, avg((s.main_score >= 4)::int) csat_4_5_share
FROM silver.fact_satisfaction_surveys s JOIN silver.fact_call_center_interactions i USING (interaction_id)
WHERE s.survey_type = 'CSAT' GROUP BY 1;

-- §3: question occurrences, answers and slots; comment templates and counts
WITH u AS (
  SELECT 1 slot, question_1_text t, question_1_response r FROM silver.fact_satisfaction_surveys UNION ALL
  SELECT 2, question_2_text, question_2_response FROM silver.fact_satisfaction_surveys UNION ALL
  SELECT 3, question_3_text, question_3_response FROM silver.fact_satisfaction_surveys)
SELECT t, count(*) occurrences, count(r) answers, min(slot), max(slot) FROM u WHERE t IS NOT NULL GROUP BY t;
SELECT count(DISTINCT open_comments) templates, count(open_comments) comments FROM silver.fact_satisfaction_surveys;
SELECT comment_sentiment, count(*) FROM silver.fact_satisfaction_surveys GROUP BY 1;

-- §3: observed wait by channel (design window)
SELECT i.channel, count(*) contacts, count(i.wait_time_seconds) observed_waits
FROM silver.fact_satisfaction_surveys s JOIN silver.fact_call_center_interactions i USING (interaction_id)
WHERE s.survey_date < TIMESTAMP '2026-01-01' GROUP BY 1;

-- F1: mean wait answer by wait quintile, largest |r| by country, survey type and month (cells with >= 100 pairs),
-- and the design-window Spearman correlation (midranks for ties)
WITH w AS (
  SELECT i.wait_time_seconds wait, s.survey_type, s.survey_date, cu.country,
         CASE WHEN question_2_text LIKE '%espera%' THEN question_2_response END r      -- the wait question is always slot 2
  FROM silver.fact_satisfaction_surveys s JOIN silver.fact_call_center_interactions i USING (interaction_id)
  LEFT JOIN silver.dim_customers cu ON cu.customer_id = s.customer_id)
SELECT b, min(wait), max(wait), avg(r) FROM (
  SELECT ntile(5) OVER (ORDER BY wait) b, wait, r FROM w WHERE r IS NOT NULL AND wait IS NOT NULL) GROUP BY b ORDER BY b;
-- (same CTE)
SELECT dim, max(abs(rho)) FILTER (WHERE n >= 100) largest_abs_r FROM (
  SELECT 'country' dim, country v, count(wait) FILTER (WHERE r IS NOT NULL) n, corr(r, wait) rho FROM w GROUP BY country UNION ALL
  SELECT 'survey_type', survey_type, count(wait) FILTER (WHERE r IS NOT NULL), corr(r, wait) FROM w GROUP BY survey_type UNION ALL
  SELECT 'month', strftime(survey_date, '%Y-%m'), count(wait) FILTER (WHERE r IS NOT NULL), corr(r, wait) FROM w GROUP BY 2) GROUP BY dim;
-- (same CTE)
SELECT corr(rr, wr) spearman FROM (
  SELECT rank() OVER (ORDER BY r) + (count(*) OVER (PARTITION BY r) - 1) / 2.0 rr,
         rank() OVER (ORDER BY wait) + (count(*) OVER (PARTITION BY wait) - 1) / 2.0 wr
  FROM w WHERE r IS NOT NULL AND wait IS NOT NULL AND survey_date < TIMESTAMP '2026-01-01');
```
