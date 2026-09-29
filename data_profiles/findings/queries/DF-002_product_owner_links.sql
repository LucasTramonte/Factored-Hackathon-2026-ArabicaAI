-- id: DF-002
-- title: Product links whose owner is another customer
-- scope: full
-- memory: One left join per fact to the product dimension; grouped counts only.
SELECT 'fact_complaints.affected_product_id' AS link,
       COUNT(*) FILTER (WHERE f.affected_product_id IS NULL) AS no_product,
       COUNT(*) FILTER (WHERE f.affected_product_id IS NOT NULL AND p.product_id IS NULL) AS orphan,
       COUNT(*) FILTER (WHERE p.customer_id = f.customer_id) AS owner_match,
       COUNT(*) FILTER (WHERE p.product_id IS NOT NULL AND p.customer_id <> f.customer_id) AS owner_mismatch
FROM silver.fact_complaints f
LEFT JOIN silver.dim_products p ON p.product_id = f.affected_product_id
UNION ALL
SELECT 'fact_transactions.product_id',
       COUNT(*) FILTER (WHERE t.product_id IS NULL),
       COUNT(*) FILTER (WHERE t.product_id IS NOT NULL AND p.product_id IS NULL),
       COUNT(*) FILTER (WHERE p.customer_id = t.customer_id),
       COUNT(*) FILTER (WHERE p.product_id IS NOT NULL AND p.customer_id <> t.customer_id)
FROM silver.fact_transactions t
LEFT JOIN silver.dim_products p ON p.product_id = t.product_id
