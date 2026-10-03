-- id: PR-03
-- title: KPI 3 and the resolution gap: contact-centre contacts, observed duration and resolution by reason
-- scope: design
-- memory: fact_call_center_interactions (about 0.6M design-window rows) projected to six columns and grouped by reason with a rollup; aggregates only.
SELECT CASE WHEN GROUPING(reason_category) = 1 THEN '(all contacts)' ELSE coalesce(reason_category, '(none)') END AS reason,
       count(*) AS contacts,
       count(duration_seconds) AS duration_observed,
       sum(duration_seconds) AS duration_seconds_sum,
       count(was_resolved) AS resolution_known,
       count(*) FILTER (WHERE was_resolved) AS resolved,
       count(*) FILTER (WHERE was_escalated) AS escalated,
       count(*) FILTER (WHERE contact_reason IS DISTINCT FROM reason_category) AS reason_fields_differ
FROM silver.fact_call_center_interactions
WHERE interaction_date >= $design_start AND interaction_date < $design_end
GROUP BY ROLLUP (reason_category)
ORDER BY reason
