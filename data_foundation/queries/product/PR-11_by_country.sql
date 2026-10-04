-- id: PR-11
-- title: Unrecognized-charge complaints by the customer's country (a snapshot): volume, unresolved, SLA, first response, closed-case satisfaction
-- scope: design
-- memory: Design-window unrecognized-charge complaints (about 10k rows) left-joined many-to-one to dim_customers (150k rows) on the complaint's own customer_id; grouped by country.
SELECT coalesce(cu.country, '(no customer)') AS country,
       count(*) AS complaints,
       count(DISTINCT c.customer_id) AS customers,
       count(*) FILTER (WHERE c.status IN ('Open', 'In Process', 'Escalated')) AS unresolved,
       count(*) FILTER (WHERE c.status = 'Escalated') AS escalated,
       count(c.sla_breached) AS sla_known,
       count(*) FILTER (WHERE c.sla_breached) AS sla_breached,
       count(*) FILTER (WHERE c.first_response_date >= c.assignment_date) AS first_response_n,
       quantile_cont(date_diff('second', c.assignment_date, c.first_response_date) / 3600.0, 0.5)
         FILTER (WHERE c.first_response_date >= c.assignment_date) AS first_response_h_p50,
       count(c.resolution_satisfaction) FILTER (WHERE c.closing_date < $design_end) AS closed_scored,
       sum(c.resolution_satisfaction) FILTER (WHERE c.closing_date < $design_end) AS closed_score_sum
FROM silver.fact_complaints c
LEFT JOIN silver.dim_customers cu ON cu.customer_id = c.customer_id
WHERE c.subcategory = 'Cargo no reconocido' AND c.creation_date >= $design_start AND c.creation_date < $design_end
GROUP BY ALL
ORDER BY complaints DESC, country
