-- id: PR-08
-- title: Segment cut: unrecognized-charge complaints by the customer's current segment (a snapshot)
-- scope: design
-- memory: Design-window unrecognized-charge complaints (about 10k rows) left-joined many-to-one to dim_customers (150k rows) on the complaint's own customer_id; grouped by segment.
SELECT coalesce(cu.segment, '(no customer)') AS segment,
       count(*) AS complaints,
       count(DISTINCT c.customer_id) AS customers,
       count(*) FILTER (WHERE c.status IN ('Open', 'In Process', 'Escalated')) AS unresolved,
       count(*) FILTER (WHERE c.status = 'Escalated') AS escalated,
       count(c.sla_breached) AS sla_known,
       count(*) FILTER (WHERE c.sla_breached) AS sla_breached,
       count(c.resolution_satisfaction) FILTER (WHERE c.closing_date < $design_end) AS closed_scored,
       sum(c.resolution_satisfaction) FILTER (WHERE c.closing_date < $design_end) AS closed_score_sum
FROM silver.fact_complaints c
LEFT JOIN silver.dim_customers cu ON cu.customer_id = c.customer_id
WHERE c.subcategory = 'Cargo no reconocido' AND c.creation_date >= $design_start AND c.creation_date < $design_end
GROUP BY ALL
ORDER BY segment
