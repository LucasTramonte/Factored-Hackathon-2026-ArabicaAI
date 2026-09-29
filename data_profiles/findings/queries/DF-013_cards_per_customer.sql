-- id: DF-013
-- title: Cards per purchasing customer
-- scope: design
-- memory: Distinct design-window purchasers joined to the current product snapshot; grouped by card type.
WITH buyers AS (
  SELECT DISTINCT t.customer_id FROM silver.fact_transactions t WHERE t.transaction_type = 'Purchase' AND t.transaction_status = 'Approved' AND t.transaction_date < $design_end
), cards AS (
  SELECT p.customer_id, p.product_type, COUNT(*) AS n
  FROM silver.dim_products p JOIN buyers USING (customer_id)
  WHERE p.product_type IN ('Tarjeta Crédito', 'Tarjeta Débito')
  GROUP BY 1, 2
)
SELECT product_type, COUNT(*) AS customers, quantile_cont(n, 0.5) AS p50_cards, quantile_cont(n, 0.9) AS p90_cards,
       MAX(n) AS max_cards, AVG(CASE WHEN n > 1 THEN 1 ELSE 0 END) AS share_with_more_than_one
FROM cards
GROUP BY 1
ORDER BY 1
