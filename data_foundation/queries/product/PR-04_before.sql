-- id: PR-04
-- title: The before picture: unrecognized charges against other complaints, status, SLA and durations, by escalation
-- scope: design
-- memory: Design-window complaints (about 50k rows) projected to dates and status; quantiles per group. Negative intervals are counted and left out of the quantiles, never silently dropped.
WITH c AS (
  SELECT CASE WHEN subcategory = 'Cargo no reconocido' THEN 'unrecognized charge' ELSE 'other complaint' END AS grp,
         coalesce(status = 'Escalated', FALSE) AS escalated,
         status, sla_breached, resolution_days,
         date_diff('second', assignment_date, first_response_date) / 3600.0 AS first_response_h,
         date_diff('second', first_response_date, resolution_date) / 86400.0 AS to_resolution_d,
         date_diff('second', first_response_date, closing_date) / 86400.0 AS to_closing_d,
         date_diff('second', creation_date, resolution_date) / 86400.0 AS customer_wait_d,
         assignment_date IS NOT NULL AS assigned,
         coalesce(first_response_date >= $design_end OR resolution_date >= $design_end OR closing_date >= $design_end, FALSE) AS outcome_after_window
  FROM silver.fact_complaints
  WHERE creation_date >= $design_start AND creation_date < $design_end
)
SELECT grp,
       CASE WHEN GROUPING(escalated) = 1 THEN 'all' WHEN escalated THEN 'escalated' ELSE 'not escalated' END AS escalation,
       count(*) AS complaints,
       count(*) FILTER (WHERE status = 'Open') AS open,
       count(*) FILTER (WHERE status = 'In Process') AS in_process,
       count(*) FILTER (WHERE status = 'Escalated') AS escalated_status,
       count(*) FILTER (WHERE status = 'Resolved') AS resolved,
       count(*) FILTER (WHERE status = 'Closed') AS closed,
       count(*) FILTER (WHERE status = 'Rejected') AS rejected,
       count(sla_breached) AS sla_known,
       count(*) FILTER (WHERE sla_breached) AS sla_breached,
       count(*) FILTER (WHERE assigned) AS assigned,
       count(resolution_days) AS resolution_days_n,
       quantile_cont(resolution_days, 0.5) AS resolution_days_p50,
       quantile_cont(resolution_days, 0.9) AS resolution_days_p90,
       count(*) FILTER (WHERE first_response_h >= 0) AS first_response_n,
       quantile_cont(first_response_h, 0.5) FILTER (WHERE first_response_h >= 0) AS first_response_h_p50,
       quantile_cont(first_response_h, 0.9) FILTER (WHERE first_response_h >= 0) AS first_response_h_p90,
       count(*) FILTER (WHERE to_resolution_d >= 0) AS to_resolution_n,
       quantile_cont(to_resolution_d, 0.5) FILTER (WHERE to_resolution_d >= 0) AS to_resolution_d_p50,
       quantile_cont(to_resolution_d, 0.9) FILTER (WHERE to_resolution_d >= 0) AS to_resolution_d_p90,
       count(*) FILTER (WHERE to_closing_d >= 0) AS to_closing_n,
       quantile_cont(to_closing_d, 0.5) FILTER (WHERE to_closing_d >= 0) AS to_closing_d_p50,
       quantile_cont(to_closing_d, 0.9) FILTER (WHERE to_closing_d >= 0) AS to_closing_d_p90,
       count(*) FILTER (WHERE customer_wait_d >= 0) AS customer_wait_n,
       quantile_cont(customer_wait_d, 0.5) FILTER (WHERE customer_wait_d >= 0) AS customer_wait_d_p50,
       quantile_cont(customer_wait_d, 0.9) FILTER (WHERE customer_wait_d >= 0) AS customer_wait_d_p90,
       count(*) FILTER (WHERE first_response_h < 0 OR to_resolution_d < 0 OR to_closing_d < 0 OR customer_wait_d < 0) AS negative_intervals,
       count(*) FILTER (WHERE outcome_after_window) AS outcome_after_window
FROM c
GROUP BY GROUPING SETS ((grp, escalated), (grp))
ORDER BY grp DESC, escalation
