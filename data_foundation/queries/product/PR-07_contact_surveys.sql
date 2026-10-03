-- id: PR-07
-- title: Contact-centre surveys (CSAT, CES, NPS): score distribution by contact reason and resolution
-- scope: design
-- memory: Surveys (about 0.2M rows) left-joined many-to-one to interactions on interaction_id, both bounded to the design window; grouped to a few hundred cells.
SELECT s.survey_type,
       CASE WHEN i.interaction_id IS NULL THEN '(no interaction)' ELSE coalesce(i.reason_category, '(none)') END AS reason,
       i.was_resolved,
       s.main_score AS score,
       count(*) AS surveys
FROM silver.fact_satisfaction_surveys s
LEFT JOIN silver.fact_call_center_interactions i
  ON i.interaction_id = s.interaction_id AND i.interaction_date >= $design_start AND i.interaction_date < $design_end
WHERE s.survey_date >= $design_start AND s.survey_date < $design_end
GROUP BY ALL
ORDER BY ALL
