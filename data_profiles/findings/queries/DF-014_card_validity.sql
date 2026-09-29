-- id: DF-014
-- title: Purchases outside the card's opening and expiration dates
-- scope: design
-- memory: Design-window approved purchases joined to their owner-matched product; aggregates only.
SELECT p.product_type, COUNT(*) AS purchases,
       AVG(CASE WHEN CAST(t.transaction_date AS DATE) < p.opening_date THEN 1 ELSE 0 END) AS before_opening_share,
       AVG(CASE WHEN CAST(t.transaction_date AS DATE) > p.expiration_date THEN 1 ELSE 0 END) AS after_expiration_share,
       AVG(CASE WHEN p.product_status <> 'Active' THEN 1 ELSE 0 END) AS on_non_active_product_share
FROM silver.fact_transactions t
JOIN silver.dim_products p ON p.product_id = t.product_id AND p.customer_id = t.customer_id
WHERE t.transaction_type = 'Purchase' AND t.transaction_status = 'Approved' AND t.transaction_date < $design_end
GROUP BY 1
ORDER BY 1
