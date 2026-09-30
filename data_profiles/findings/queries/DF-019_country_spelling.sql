-- id: DF-019
-- title: How each layer spells the purchase country
-- scope: full
-- memory: One grouped count per layer over a single column; at most a few distinct values.
SELECT layer, transaction_country, n
FROM (
    SELECT 'bronze' AS layer, transaction_country, COUNT(*) AS n FROM bronze.transactions GROUP BY 1, 2
    UNION ALL
    SELECT 'silver', transaction_country, COUNT(*) FROM silver.fact_transactions GROUP BY 1, 2
)
ORDER BY layer, n DESC, transaction_country
