-- id: AI-01
-- title: Would an AI agent in place of the human reviewer raise satisfaction or speed? (ADR-012, the challenge)
-- scope: design (2023-06-17 to 2025-12-31, ADR-005)
-- memory: about 0.6M design-window interactions projected to a few columns and joined 1:1 to CSAT surveys (at most one
--   CSAT per interaction, checked by query 2); complaints are about 10k unrecognized-charge rows. Grouped aggregates only;
--   run read-only with memory_limit 3GB, threads 2. Descriptive: no figure here is a causal effect.

-- 1. Is there any automated (agent-less) service to compare against? Interactions with no agent, by interaction type.
SELECT interaction_type, count(*) AS interactions, count(*) FILTER (WHERE agent_id IS NULL) AS without_agent
FROM silver.fact_call_center_interactions
WHERE interaction_date >= TIMESTAMP '2023-06-17' AND interaction_date < TIMESTAMP '2026-01-01'
GROUP BY 1 ORDER BY 2 DESC;

-- 2. At most one CSAT survey per interaction (the join below is 1:1).
SELECT max(n) AS max_csat_per_interaction FROM (
  SELECT interaction_id, count(*) AS n FROM silver.fact_satisfaction_surveys
  WHERE interaction_id IS NOT NULL AND survey_type = 'CSAT' GROUP BY 1);

-- 3. Complaint-contact CSAT (scale 1-4) by escalation and resolution. Repeat the GROUP BY with a.agent_type,
--    a.experience_level, wait-time bands (wait_time_seconds < 60, < 300) and duration bands (< 300, < 600) in place of
--    was_escalated, always together with was_resolved. Join: interactions N:1 dim_service_agents on agent_id.
SELECT i.was_escalated, i.was_resolved, count(*) AS answers, avg(s.main_score) AS mean_csat
FROM silver.fact_call_center_interactions i
JOIN silver.fact_satisfaction_surveys s ON s.interaction_id = i.interaction_id AND s.survey_type = 'CSAT'
LEFT JOIN silver.dim_service_agents a ON a.agent_id = i.agent_id
WHERE i.interaction_date >= TIMESTAMP '2023-06-17' AND i.interaction_date < TIMESTAMP '2026-01-01' AND i.reason_category = 'Queja'
GROUP BY 1, 2 ORDER BY 1, 2;

-- 4. Unrecognized-charge complaints: does speed relate to the resolution score? (closed cases with a score only)
SELECT corr(resolution_days, resolution_satisfaction) AS corr_days, count(*) AS n
FROM silver.fact_complaints
WHERE creation_date >= TIMESTAMP '2023-06-17' AND creation_date < TIMESTAMP '2026-01-01'
  AND subcategory = 'Cargo no reconocido' AND resolution_satisfaction IS NOT NULL;

SELECT corr(date_diff('hour', assignment_date, first_response_date), resolution_satisfaction) AS corr_first_response_hours, count(*) AS n
FROM silver.fact_complaints
WHERE creation_date >= TIMESTAMP '2023-06-17' AND creation_date < TIMESTAMP '2026-01-01'
  AND subcategory = 'Cargo no reconocido' AND resolution_satisfaction IS NOT NULL AND first_response_date IS NOT NULL;

SELECT CASE WHEN h < 12 THEN '<12h' WHEN h < 24 THEN '12-24h' WHEN h < 36 THEN '24-36h' ELSE '>=36h' END AS first_response_band,
       count(*) AS n, avg(s) AS mean_score
FROM (SELECT date_diff('hour', assignment_date, first_response_date) AS h, resolution_satisfaction AS s
      FROM silver.fact_complaints
      WHERE creation_date >= TIMESTAMP '2023-06-17' AND creation_date < TIMESTAMP '2026-01-01'
        AND subcategory = 'Cargo no reconocido' AND resolution_satisfaction IS NOT NULL
        AND first_response_date IS NOT NULL AND assignment_date IS NOT NULL)
GROUP BY 1 ORDER BY 1;

SELECT sla_breached, count(*) AS n, avg(resolution_satisfaction) AS mean_score
FROM silver.fact_complaints
WHERE creation_date >= TIMESTAMP '2023-06-17' AND creation_date < TIMESTAMP '2026-01-01'
  AND subcategory = 'Cargo no reconocido' AND resolution_satisfaction IS NOT NULL
GROUP BY 1;

-- 5. What a resolution is: the recorded resolution text and compensation, resolved or closed complaints.
SELECT resolution, count(*) AS n, 100.0 * count(*) / sum(count(*)) OVER () AS share_pct
FROM silver.fact_complaints
WHERE creation_date >= TIMESTAMP '2023-06-17' AND creation_date < TIMESTAMP '2026-01-01'
  AND subcategory = 'Cargo no reconocido' AND status IN ('Resolved', 'Closed')
GROUP BY 1 ORDER BY 2 DESC;

SELECT count(*) FILTER (WHERE compensation_granted > 0) AS with_compensation, count(*) AS resolved_or_closed
FROM silver.fact_complaints
WHERE creation_date >= TIMESTAMP '2023-06-17' AND creation_date < TIMESTAMP '2026-01-01'
  AND subcategory = 'Cargo no reconocido' AND status IN ('Resolved', 'Closed');
