-- id: DF-027
-- title: Wait time exists only for Phone contacts, and survey wait answers don't track measured wait
-- scope: design
-- memory: Design-window interactions (about 0.6M rows) projected to three columns and left-joined one-to-one to surveys (at most one per interaction, checked in the result) on interaction_id; grouped by channel.
WITH s AS (
  SELECT interaction_id,
         CASE WHEN question_1_text LIKE '%espera%' THEN question_1_response
              WHEN question_2_text LIKE '%espera%' THEN question_2_response
              WHEN question_3_text LIKE '%espera%' THEN question_3_response END AS wait_answer
  FROM silver.fact_satisfaction_surveys
  WHERE survey_date < $design_end
), by_channel AS (
SELECT i.channel,
       count(*) AS contact_rows,
       count(DISTINCT i.interaction_id) AS contacts,
       count(i.wait_time_seconds) AS wait_observed,
       count(s.interaction_id) AS surveyed,
       count(s.wait_answer) AS wait_answers,
       count(s.wait_answer) FILTER (WHERE i.wait_time_seconds IS NOT NULL) AS pairs,
       round(corr(s.wait_answer, i.wait_time_seconds), 3) AS wait_answer_r
FROM silver.fact_call_center_interactions i
LEFT JOIN s USING (interaction_id)
WHERE i.interaction_date < $design_end
GROUP BY i.channel
)
-- corr() is NaN when either side has no variance; report that as no correlation (NULL).
SELECT * REPLACE (CASE WHEN isnan(wait_answer_r) THEN NULL ELSE wait_answer_r END AS wait_answer_r)
FROM by_channel
ORDER BY contacts DESC, channel
