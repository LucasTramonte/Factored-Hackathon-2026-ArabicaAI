-- id: DF-025
-- title: Dispute outcomes can't show friendly fraud: few rejections, template resolutions, no transaction link
-- scope: design
-- memory: Design-window unrecognized-charge complaints (small fact), projected to status, resolution and customer_id and grouped; the per-customer count is one hash aggregate. Aggregates only; resolution values are the source's fixed templates.
WITH c AS (
  SELECT customer_id, status, resolution FROM silver.fact_complaints
  WHERE subcategory = 'Cargo no reconocido' AND creation_date < $design_end
), per_customer AS (SELECT customer_id, COUNT(*) AS n FROM c GROUP BY customer_id)
SELECT 'status' AS kind, coalesce(status, '(none)') AS label, COUNT(*) AS complaints, COUNT(DISTINCT customer_id) AS customers
FROM c GROUP BY 2
UNION ALL
SELECT 'resolution', coalesce(resolution, '(none)'), COUNT(*), COUNT(DISTINCT customer_id) FROM c GROUP BY 2
UNION ALL
SELECT 'complaints_per_customer', CASE WHEN n = 1 THEN '1' ELSE '2 or more' END, SUM(n), COUNT(*) FROM per_customer GROUP BY 2
ORDER BY 1, 3 DESC, 2
