# Insights report: what the survey and service data can support

For whoever builds the CSAT / CES / handle-time report for the judges. It covers where the report should live, which figures the data supports, and which ones look like insight but are noise. Every number below comes from aggregate SQL (appendix) over the local full Silver build (`data/full_local/latam_bank.duckdb`, surveys 2023-06-17 to 2026-06-19). Re-run them after `make pipeline` passes its quality gate before you publish (AGENTS.md, data workflow step 3). No customer record or identifier is reproduced here.

## 1. Where the report lives

- **Historical baseline (the dataset):** build it offline, extending the existing aggregate report (`make report`, `data_foundation/reports/`). Commit only reviewed aggregates, with no ids. The Worker never reads Silver (AGENTS.md), so the app can show this committed JSON on an `/insights` page linked from the admin banner, as a static file. That way judges see it in the app without any new data path.
- **Our own service, live:** D1 already records when each report was accepted, picked up (`in_review`) and closed. Time to pickup, review time and time to close can be computed per report and cut by urgency, kind, language and reason.
- **Dashboards are optional in the brief.** What is required is comparing outcomes by language and authorized customer segment, with small-sample limits stated. The organizers asked for KPIs that show why the problem matters. Lead with those.
- **Judges and "real" customers:** the dataset is fully synthetic. A judge can be enrolled as admin on a dataset customer (`CLI-…`) to see that customer's charges, but there is no free browsing of all customers (issue #69). "Other users" appear only as aggregates.

## 2. What the survey data actually contains

`satisfaction_surveys`: 212,759 surveys, one per call-center interaction (212,759 distinct `interaction_id`). It joins to `call_center_interactions` and not to complaints (`origin_interaction_id` is 100% null, DF-003).

| Field | What it holds |
|---|---|
| `survey_type`, `main_score` | CSAT 127,856 rows (1–4), CES 21,235 (1–4), NPS 63,668 (2–7: no promoters). The dictionary's 1–5 and 0–10 scales are wrong. |
| `question_1..3_text` / `_response` | Five fixed Spanish questions, answered 1–5. 0 to 3 per survey (45,816 surveys have none). |
| `open_comments` | 13 fixed sentences (101,196 comments): 5 negative, 3 neutral, 5 positive. |
| `comment_sentiment` | Negative 67,529, Neutral 26,774, Positive 6,954, null 111,502. |

The five questions are the bank's survey instrument:

| Question | Answers | Mean (1–5) |
|---|---|---|
| ¿El tiempo de espera fue aceptable? | 81,371 | 3.01 |
| ¿Cómo calificaría la atención brindada? | 40,667 | 3.01 |
| ¿El agente resolvió su consulta satisfactoriamente? | 40,489 | 3.01 |
| ¿Qué tan satisfecho está con el servicio recibido? | 40,147 | 3.00 |
| ¿Volvería a contactarnos por este canal? | 40,144 | 2.99 |

## 3. Findings

**F1. The question answers carry no signal. Don't chart them.**
- "¿El tiempo de espera fue aceptable?" is answered almost exactly uniformly: 15,204 / 15,393 / 15,778 / 15,603 / 15,393 for scores 1 to 5.
- Its correlation with the interaction's real `wait_time_seconds` is 0.0003, and with `main_score` −0.0001.
- Across wait-time quintiles (0–85 s up to 182–421 s), its mean stays between 2.99 and 3.03. The other four questions show the same flat means.
- A chart of "share who found the wait acceptable" would present random numbers as a finding.

**F2. The comments follow the score, not the experience.**
- People who wrote a wait complaint ("Tardaron mucho en atenderme.", "Tuve que esperar demasiado tiempo.") waited 120.6 s on average, against 119.9 s for those who left no comment.
- Their CSAT is lower (2.60 against 3.53). The comment text is derived from the score, not from what happened.
- Sentiment is a relabelling of the score: Negative averages CSAT 2.61, Positive 4.00.

**F3. Every score is a function of resolution.**

| Score | Resolved | Not resolved |
|---|---|---|
| CSAT (1–4) | 3.00 (97,851) | 2.00 (30,005) |
| CES (1–4) | 3.00 (16,246) | 2.00 (4,989) |
| NPS (2–7) | 6.00 (49,034) | 3.00 (14,634) |

- CSAT top-2-box (3–4) is 85.1% when resolved and 15.1% when not.
- Escalation makes no difference once resolution is known (resolved: 3.00 with or without escalation).
- Longer calls score lower: 2.89 in the shortest duration quintile, 2.61–2.71 in the longest two. Wait time doesn't move CSAT at all (correlation −0.0015).

**F4. Complaints are the least resolved and least satisfied contacts** (surveyed interactions). This is the strongest problem-sizing fact the data offers.

| `reason_category` | Resolved | Mean CSAT |
|---|---|---|
| Queja (complaint) | 43.6% | 2.43 |
| Retención | 60.7% | 2.61 |
| Comercial | 65.4% | 2.66 |
| Técnico | 70.0% | 2.70 |
| Producto | 89.6% | 2.90 |
| Transaccional | 91.5% | 2.91 |

Across all 686,296 interactions: 76.6% resolved, 10.0% escalated, mean handle time 321 s, mean wait 120 s. Wait time is null on 63,653 of the 212,759 surveyed interactions (29.9%).

## 4. Recommendations

1. **Report resolution as the outcome, and satisfaction as its consequence.**
   - Headline: complaint contacts are resolved 43.6% of the time, against 76.6% overall, and score the lowest CSAT (2.43).
   - That is the KPI case for a faster, surer path for unrecognized charges.
   - Say plainly that in this dataset satisfaction is fully explained by resolution, so it is not an independent signal.
2. **Use the bank's questions as wording, not as data.**
   - The five questions are the instrument the bank already uses. When we collect feedback in the app (the thumbs up/down that is a must-have), ask the same thing in the customer's language, so our figures read as the same KPI: "¿El agente resolvió su consulta satisfactoriamente?" and "¿El tiempo de espera fue aceptable?".
   - Our version of wait is measured, not asked: time from report to receipt, and time to pickup and to close, from D1.
3. **Segment honestly.**
   - By language: the dataset surveys are Spanish only, so the language comparison comes from our live episodes (es, pt, en).
   - By customer segment: `customers.segment` (Basic, Plus, Premium, Student) is a current snapshot, joined through the survey's own `customer_id`, which is a customer attribute, not a case link.
   - "Large charge for this customer" can't be measured on dataset complaints (no transaction link, DF-003). It is live-only: our urgency rule.
4. **Don't report:**
   - time-to-resolution of escalated complaints (they have no resolution or closing dates);
   - CSAT of unrecognized-charge complainants (no join from surveys to complaints);
   - anything from the question answers or comment text as evidence of wait or quality (F1, F2).
5. **Register F1 and F2** in [`DATA_QUALITY.md`](../deliverables/DATA_QUALITY.md) as a new finding with the appendix queries. Like DF-001 for complaint text, it changes what the product may claim.

## Appendix: queries

Run against Silver with DuckDB (`read_only=True`). Each query is grouped, so nothing per-customer leaves the database.

```sql
-- Questions: text, answers, mean
WITH u AS (
  SELECT question_1_text t, question_1_response r FROM silver.fact_satisfaction_surveys UNION ALL
  SELECT question_2_text, question_2_response FROM silver.fact_satisfaction_surveys UNION ALL
  SELECT question_3_text, question_3_response FROM silver.fact_satisfaction_surveys)
SELECT t, count(*), round(avg(r), 2) FROM u WHERE t IS NOT NULL GROUP BY t ORDER BY 2 DESC;

-- F1: the wait question against the real wait
WITH w AS (
  SELECT i.wait_time_seconds w, s.main_score,
    CASE WHEN question_1_text LIKE '%tiempo de espera%' THEN question_1_response
         WHEN question_2_text LIKE '%tiempo de espera%' THEN question_2_response
         WHEN question_3_text LIKE '%tiempo de espera%' THEN question_3_response END wait_q
  FROM silver.fact_satisfaction_surveys s JOIN silver.fact_call_center_interactions i USING (interaction_id))
SELECT corr(wait_q, w), corr(wait_q, main_score), count(*) FROM w WHERE wait_q IS NOT NULL;

-- F2: wait-complaint comments against the real wait
SELECT CASE WHEN open_comments IN ('Tardaron mucho en atenderme.', 'Tuve que esperar demasiado tiempo.') THEN 'wait complaint'
            WHEN open_comments IS NULL THEN 'no comment' ELSE 'other comment' END k,
       count(*), avg(i.wait_time_seconds), avg(s.main_score)
FROM silver.fact_satisfaction_surveys s JOIN silver.fact_call_center_interactions i USING (interaction_id) GROUP BY 1;

-- F3: scores by resolution
SELECT s.survey_type, i.was_resolved, i.was_escalated, count(*), avg(s.main_score)
FROM silver.fact_satisfaction_surveys s JOIN silver.fact_call_center_interactions i USING (interaction_id) GROUP BY ALL ORDER BY ALL;

-- F4: resolution and CSAT by contact reason
SELECT i.reason_category, avg(i.was_resolved::int) resolved, avg(CASE WHEN s.survey_type = 'CSAT' THEN s.main_score END) csat
FROM silver.fact_satisfaction_surveys s JOIN silver.fact_call_center_interactions i USING (interaction_id) GROUP BY 1 ORDER BY 3;
```
