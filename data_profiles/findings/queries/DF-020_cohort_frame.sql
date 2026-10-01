-- id: DF-020
-- title: Cohort sampling frame by country and segment
-- scope: design
-- memory: Design-window approved purchases and unrecognized-charge complaints each aggregated to one row per customer, then joined 1:1 to the customer snapshot; grouped by country and segment with subtotals.
WITH buys AS (
  SELECT t.customer_id, COUNT(*) AS purchases,
         COUNT(*) FILTER (WHERE p.customer_id IS DISTINCT FROM t.customer_id) AS off_owner
  FROM silver.fact_transactions t
  LEFT JOIN silver.dim_products p USING (product_id)
  WHERE t.transaction_type = 'Purchase' AND t.transaction_status = 'Approved' AND t.transaction_date < $design_end
  GROUP BY 1
), cnr AS (
  SELECT customer_id FROM silver.fact_complaints
  WHERE subcategory = 'Cargo no reconocido' AND creation_date < $design_end
  GROUP BY 1
)
SELECT CASE WHEN GROUPING(cu.country) = 1 THEN '(all)' ELSE coalesce(cu.country, '(null)') END AS country,
       CASE WHEN GROUPING(cu.segment) = 1 THEN '(all)' ELSE coalesce(cu.segment, '(null)') END AS segment,
       COUNT(*) AS customers,
       COUNT(b.customer_id) AS purchasers,
       COUNT(*) FILTER (WHERE b.customer_id IS NOT NULL AND c.customer_id IS NOT NULL) AS purchasers_with_cnr,
       coalesce(SUM(b.purchases), 0) AS approved_purchases,
       coalesce(SUM(b.off_owner), 0) AS purchases_off_owner
FROM silver.dim_customers cu
LEFT JOIN buys b USING (customer_id)
LEFT JOIN cnr c USING (customer_id)
GROUP BY GROUPING SETS ((cu.country, cu.segment), (cu.country), ())
ORDER BY 1, 2
