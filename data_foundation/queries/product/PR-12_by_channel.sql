-- id: PR-12
-- title: Unrecognized-charge complaints by reception channel: volume, unresolved, SLA, first response, closed-case satisfaction
-- scope: design
-- memory: Design-window unrecognized-charge complaints (about 10k rows) projected to channel, status and dates; grouped by channel, no joins.
SELECT coalesce(reception_channel, '(none)') AS channel,
       count(*) AS complaints,
       count(DISTINCT customer_id) AS customers,
       count(*) FILTER (WHERE status IN ('Open', 'In Process', 'Escalated')) AS unresolved,
       count(*) FILTER (WHERE status = 'Escalated') AS escalated,
       count(sla_breached) AS sla_known,
       count(*) FILTER (WHERE sla_breached) AS sla_breached,
       count(*) FILTER (WHERE first_response_date >= assignment_date) AS first_response_n,
       quantile_cont(date_diff('second', assignment_date, first_response_date) / 3600.0, 0.5)
         FILTER (WHERE first_response_date >= assignment_date) AS first_response_h_p50,
       count(resolution_satisfaction) FILTER (WHERE closing_date < $design_end) AS closed_scored,
       sum(resolution_satisfaction) FILTER (WHERE closing_date < $design_end) AS closed_score_sum
FROM silver.fact_complaints
WHERE subcategory = 'Cargo no reconocido' AND creation_date >= $design_start AND creation_date < $design_end
GROUP BY ALL
ORDER BY complaints DESC, channel
