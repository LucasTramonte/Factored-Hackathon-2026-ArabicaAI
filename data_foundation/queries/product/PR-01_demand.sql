-- id: PR-01
-- title: KPI 1, unrecognized-charge demand: complaints by year and over the design window, with calendar days
-- scope: design
-- memory: fact_complaints (small fact) projected to creation_date and subcategory, grouped by year; aggregates only.
WITH c AS (
  SELECT year(creation_date) AS y, subcategory = 'Cargo no reconocido' AS target
  FROM silver.fact_complaints
  WHERE creation_date >= $design_start AND creation_date < $design_end
)
SELECT CAST(y AS VARCHAR) AS period, count(*) AS all_complaints,
       count(*) FILTER (WHERE target) AS unrecognized_charges,
       date_diff('day', greatest(make_date(y, 1, 1), $design_start::DATE), least(make_date(y + 1, 1, 1), $design_end::DATE)) AS calendar_days
FROM c GROUP BY y
UNION ALL
SELECT 'design window', count(*), count(*) FILTER (WHERE target), date_diff('day', $design_start::DATE, $design_end::DATE)
FROM c
ORDER BY period
