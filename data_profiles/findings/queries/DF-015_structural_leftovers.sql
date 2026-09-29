-- id: DF-015
-- title: Bronze-profile findings re-checked in Silver
-- scope: full
-- memory: Scalar counts over three tables.
SELECT 'transaction_country spellings' AS check_name, CAST(COUNT(DISTINCT transaction_country) AS VARCHAR) AS value,
       string_agg(DISTINCT transaction_country, ', ' ORDER BY transaction_country) AS detail
FROM silver.fact_transactions
UNION ALL
SELECT 'contact_reason differs from reason_category',
       CAST(COUNT(*) FILTER (WHERE contact_reason IS DISTINCT FROM reason_category) AS VARCHAR),
       'of ' || COUNT(*) || ' interactions'
FROM silver.fact_call_center_interactions
UNION ALL
SELECT 'customers.last_updated after 2026-06-18',
       CAST(COUNT(*) FILTER (WHERE last_updated > TIMESTAMP '2026-06-18') AS VARCHAR),
       'max ' || CAST(MAX(last_updated) AS VARCHAR)
FROM silver.dim_customers
UNION ALL
SELECT 'transactions.amount_usd null / estimated',
       CAST(COUNT(*) FILTER (WHERE amount_usd IS NULL) AS VARCHAR),
       'estimated ' || COUNT(*) FILTER (WHERE amount_usd_is_estimated) || ' of ' || COUNT(*)
FROM silver.fact_transactions
