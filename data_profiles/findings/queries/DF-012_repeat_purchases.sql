-- id: DF-012
-- title: Repeat merchants and exact duplicate purchases
-- scope: design
-- memory: Window functions over design-window approved purchases, partitioned by customer; aggregates only.
WITH p AS (
  SELECT t.customer_id, t.merchant_name, t.amount, t.transaction_date
  FROM silver.fact_transactions t
  WHERE t.transaction_type = 'Purchase' AND t.transaction_status = 'Approved' AND t.transaction_date < $design_end
)
SELECT
  (SELECT quantile_cont(n, 0.5) FROM (SELECT COUNT(*) AS n FROM p GROUP BY customer_id, date_trunc('month', transaction_date))) AS purchases_per_customer_month_p50,
  (SELECT quantile_cont(n, 0.9) FROM (SELECT COUNT(*) AS n FROM p GROUP BY customer_id, date_trunc('month', transaction_date))) AS purchases_per_customer_month_p90,
  (SELECT AVG(CASE WHEN gap <= 7 THEN 1 ELSE 0 END) FROM (
     SELECT date_diff('day', lag(transaction_date) OVER (PARTITION BY customer_id, merchant_name ORDER BY transaction_date), transaction_date) AS gap FROM p)) AS same_merchant_within_7_days_share,
  (SELECT COUNT(*) FROM (SELECT 1 FROM p GROUP BY customer_id, merchant_name, amount, CAST(transaction_date AS DATE) HAVING COUNT(*) > 1)) AS exact_same_day_duplicate_groups
