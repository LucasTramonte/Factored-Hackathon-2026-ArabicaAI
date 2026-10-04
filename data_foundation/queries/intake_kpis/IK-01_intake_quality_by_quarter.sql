-- IK-01. Intake-quality rates for unrecognized-charge complaints, by quarter of creation.
-- Population: silver.fact_complaints, subcategory 'Cargo no reconocido', creation_date in [{start}, {end}).
-- Grain: one row per complaint; aggregated to quarter. No joins. Status is the source snapshot, not history.
-- Numerators: rejected (status Rejected), escalated (status Escalated), mistyped (case_type Suggestion or Request),
-- digital (reception_channel App or Web), assigned (assigned_agent_id present). Denominator: complaints in the quarter.
SELECT date_trunc('quarter', creation_date)::DATE AS quarter,
       count(*) AS complaints,
       sum((status = 'Rejected')::INT) AS rejected,
       sum((status = 'Escalated')::INT) AS escalated,
       sum((case_type IN ('Suggestion', 'Request'))::INT) AS mistyped,
       sum((reception_channel IN ('App', 'Web'))::INT) AS digital,
       sum((assigned_agent_id IS NOT NULL)::INT) AS assigned
FROM silver.fact_complaints
WHERE subcategory = 'Cargo no reconocido' AND creation_date >= TIMESTAMP '{start}' AND creation_date < TIMESTAMP '{end}'
GROUP BY 1 ORDER BY 1;
