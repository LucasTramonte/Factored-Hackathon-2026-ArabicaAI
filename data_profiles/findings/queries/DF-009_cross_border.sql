-- id: DF-009
-- title: Purchases outside the customer's country
-- scope: design
-- memory: Approved purchases in the design window joined to customers; grouped by purchase country.
SELECT t.transaction_country, cu.country = t.transaction_country AS home_country, COUNT(*) AS purchases,
       COUNT(*) * 1.0 / SUM(COUNT(*)) OVER () AS share
FROM silver.fact_transactions t
JOIN silver.dim_customers cu USING (customer_id)
WHERE t.transaction_type = 'Purchase' AND t.transaction_status = 'Approved' AND t.transaction_date < $design_end
GROUP BY 1, 2
ORDER BY 2, 3 DESC
