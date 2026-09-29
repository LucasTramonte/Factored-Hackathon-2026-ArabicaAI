-- id: DF-011
-- title: Detected accent coverage by country
-- scope: full
-- memory: Customer dimension snapshot grouped by country and accent.
SELECT country, coalesce(detected_accent, '(null)') AS detected_accent, COUNT(*) AS customers,
       COUNT(*) * 1.0 / SUM(COUNT(*)) OVER (PARTITION BY country) AS share_within_country
FROM silver.dim_customers
GROUP BY 1, 2
ORDER BY 1, 3 DESC
