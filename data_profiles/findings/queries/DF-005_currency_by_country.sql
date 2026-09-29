-- id: DF-005
-- title: Purchase currency by customer country
-- scope: design
-- memory: Approved purchases in the design window joined to the customer dimension; grouped.
SELECT cu.country, t.currency, COUNT(*) AS purchases,
       COUNT(*) * 1.0 / SUM(COUNT(*)) OVER (PARTITION BY cu.country) AS share_within_country
FROM silver.fact_transactions t
JOIN silver.dim_customers cu USING (customer_id)
WHERE t.transaction_type = 'Purchase' AND t.transaction_status = 'Approved' AND t.transaction_date < $design_end
GROUP BY 1, 2
ORDER BY 1, 3 DESC
