-- id: DF-006
-- title: Merchant domain, categories and missing merchants
-- scope: design
-- memory: Approved purchases in the design window grouped by merchant.
SELECT t.merchant_name, t.merchant_category, COUNT(*) AS purchases,
       COUNT(*) * 1.0 / SUM(COUNT(*)) OVER () AS share,
       COUNT(DISTINCT t.transaction_country) AS countries
FROM silver.fact_transactions t
WHERE t.transaction_type = 'Purchase' AND t.transaction_status = 'Approved' AND t.transaction_date < $design_end
GROUP BY 1, 2
ORDER BY 2, 1
