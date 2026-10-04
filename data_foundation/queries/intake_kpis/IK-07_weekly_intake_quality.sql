-- IK-07. Weekly counts for the control-chart demonstration (p-chart): unrecognized-charge complaints per ISO week
-- (weeks starting Monday), with the same numerators as IK-01. Partial first and last weeks are dropped by the chart.
SELECT date_trunc('week', creation_date)::DATE AS week, count(*) AS complaints,
       sum((status = 'Rejected')::INT) AS rejected, sum((status = 'Escalated')::INT) AS escalated,
       sum((case_type IN ('Suggestion', 'Request'))::INT) AS mistyped, sum((assigned_agent_id IS NOT NULL)::INT) AS assigned
FROM silver.fact_complaints
WHERE subcategory = 'Cargo no reconocido' AND creation_date >= TIMESTAMP '{start}' AND creation_date < TIMESTAMP '{end}'
GROUP BY 1 ORDER BY 1;
