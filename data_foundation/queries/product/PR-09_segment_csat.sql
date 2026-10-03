-- id: PR-09
-- title: Segment cut: CSAT of complaint contacts (Queja) against other reasons, by the customer's current segment
-- scope: design
-- memory: CSAT surveys (about 0.1M rows) joined many-to-one to interactions and left-joined many-to-one to dim_customers on the survey's own customer_id; grouped to a few dozen cells.
SELECT coalesce(cu.segment, '(no customer)') AS segment,
       CASE WHEN i.reason_category = 'Queja' THEN 'Queja' ELSE 'other reasons' END AS reason_group,
       count(*) AS surveys,
       sum(s.main_score) AS score_sum,
       count(*) FILTER (WHERE s.main_score >= 4) AS top_score,
       count(*) FILTER (WHERE i.was_resolved) AS resolved
FROM silver.fact_satisfaction_surveys s
JOIN silver.fact_call_center_interactions i
  ON i.interaction_id = s.interaction_id AND i.interaction_date >= $design_start AND i.interaction_date < $design_end
LEFT JOIN silver.dim_customers cu ON cu.customer_id = s.customer_id
WHERE s.survey_type = 'CSAT' AND s.survey_date >= $design_start AND s.survey_date < $design_end
GROUP BY ALL
ORDER BY ALL
