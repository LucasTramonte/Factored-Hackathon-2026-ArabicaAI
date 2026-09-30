-- id: DF-017
-- title: Business codes shared by two different entities
-- scope: full
-- memory: One grouped aggregate per dimension; the grouped set is at most 400,000 codes.
SELECT 'dim_products.product_number' AS code,
       COUNT(*) AS codes, COUNT(*) FILTER (WHERE ids > 1) AS codes_with_several_ids, SUM(ids) AS rows
FROM (SELECT product_number, COUNT(DISTINCT product_id) AS ids FROM silver.dim_products GROUP BY 1)
UNION ALL
SELECT 'dim_service_agents.employee_code',
       COUNT(*), COUNT(*) FILTER (WHERE ids > 1), SUM(ids)
FROM (SELECT employee_code, COUNT(DISTINCT agent_id) AS ids FROM silver.dim_service_agents GROUP BY 1)
