-- id: DF-021
-- title: Approved purchases a customer has in the days before an unrecognized-charge complaint
-- scope: design
-- memory: Design-window complaints of one subcategory range-joined to the same customer's approved purchases in the prior 120 days, grouped per complaint, then quantiles per country; aggregates only.
-- The complaint cannot be linked to its charge (DF-003), so this measures what a disputing customer
-- would have to look through, in windows (c - W, c]. Complaints before 2023-10-15 are excluded
-- because the data starts on 2023-06-17 and their 120-day history would be truncated.
WITH c AS (
  SELECT complaint_id, customer_id, creation_date FROM silver.fact_complaints
  WHERE subcategory = 'Cargo no reconocido'
    AND creation_date >= TIMESTAMP '2023-10-15' AND creation_date < $design_end
), p AS (
  SELECT customer_id, transaction_date FROM silver.fact_transactions
  WHERE transaction_type = 'Purchase' AND transaction_status = 'Approved' AND transaction_date < $design_end
), per AS (
  SELECT c.complaint_id, cu.country, c.creation_date,
         COUNT(p.transaction_date) FILTER (WHERE p.transaction_date > c.creation_date - INTERVAL 30 DAY) AS n30,
         COUNT(p.transaction_date) FILTER (WHERE p.transaction_date > c.creation_date - INTERVAL 45 DAY) AS n45,
         COUNT(p.transaction_date) FILTER (WHERE p.transaction_date > c.creation_date - INTERVAL 90 DAY) AS n90,
         COUNT(p.transaction_date) AS n120,
         date_diff('day', MAX(p.transaction_date), c.creation_date) AS days_since_last_purchase
  FROM c JOIN silver.dim_customers cu USING (customer_id)
  LEFT JOIN p ON p.customer_id = c.customer_id
             AND p.transaction_date > c.creation_date - INTERVAL 120 DAY AND p.transaction_date <= c.creation_date
  GROUP BY 1, 2, 3
)
SELECT country, COUNT(*) AS complaints,
       quantile_cont(n30, [0.5, 0.9, 0.95, 0.99]) AS n30_p50_p90_p95_p99,
       quantile_cont(n45, [0.5, 0.9, 0.95, 0.99]) AS n45_p50_p90_p95_p99,
       quantile_cont(n90, [0.5, 0.9, 0.95, 0.99]) AS n90_p50_p90_p95_p99,
       quantile_cont(n120, [0.5, 0.9, 0.95, 0.99]) AS n120_p50_p90_p95_p99,
       round(AVG((n45 = 0)::INT), 3) AS share_without_purchase_45d,
       round(AVG((n120 = 0)::INT), 3) AS share_without_purchase_120d,
       quantile_cont(days_since_last_purchase, [0.5, 0.95, 0.99]) AS days_since_last_purchase_p50_p95_p99
FROM per
GROUP BY ROLLUP (country)
ORDER BY country NULLS LAST
