-- id: DF-010
-- title: Unrecognized-charge share by year, country and segment
-- scope: design
-- memory: Design-window complaints joined to customers; three grouped breakdowns.
WITH f AS (
  SELECT f.subcategory = 'Cargo no reconocido' AS cnr, year(f.creation_date) AS y, cu.country, cu.segment
  FROM silver.fact_complaints f
  JOIN silver.dim_customers cu USING (customer_id)
  WHERE f.creation_date < $design_end
)
SELECT 'year' AS dimension, CAST(y AS VARCHAR) AS value, COUNT(*) AS complaints, AVG(CASE WHEN cnr THEN 1 ELSE 0 END) AS cnr_share FROM f GROUP BY 1, 2
UNION ALL
SELECT 'country', country, COUNT(*), AVG(CASE WHEN cnr THEN 1 ELSE 0 END) FROM f GROUP BY 1, 2
UNION ALL
SELECT 'segment', coalesce(segment, '(null)'), COUNT(*), AVG(CASE WHEN cnr THEN 1 ELSE 0 END) FROM f GROUP BY 1, 2
ORDER BY 1, 2
