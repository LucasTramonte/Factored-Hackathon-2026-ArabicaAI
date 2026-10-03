-- id: PA-01
-- title: Which transaction-time signal marks a charge urgent enough to contact the customer first (ADR-011)
-- scope: design (2023-06-17 to 2025-12-31, ADR-005), temporal split: derive on 2023-06-17..2024-12-31, check on 2025 H1 and H2
-- memory: about 3.7M design-window transactions projected to five columns; every query is one grouped aggregate
--   (DuckDB spills to disk); only aggregates leave the database. Run read-only, memory_limit 3GB, threads 2.
-- target: is_fraud (the dataset's label). Prediction unit: one transaction. Signal available when a proactive message
--   would be sent: fraud_score is assigned with the transaction. Outcomes after the fact (complaints) are not used.

-- 1. Prevalence, missing labels and missing scores.
SELECT count(*) AS transactions, count(*) FILTER (WHERE is_fraud) AS fraud,
       count(*) FILTER (WHERE is_fraud IS NULL) AS label_missing, count(*) FILTER (WHERE fraud_score IS NULL) AS score_missing
FROM silver.fact_transactions
WHERE transaction_date >= TIMESTAMP '2023-06-17' AND transaction_date < TIMESTAMP '2026-01-01';

-- 2. Score distribution by label.
SELECT is_fraud, count(*) AS n, quantile_cont(fraud_score, 0.5) AS p50, quantile_cont(fraud_score, 0.9) AS p90,
       quantile_cont(fraud_score, 0.99) AS p99, max(fraud_score) AS max
FROM silver.fact_transactions
WHERE transaction_date >= TIMESTAMP '2023-06-17' AND transaction_date < TIMESTAMP '2026-01-01'
GROUP BY is_fraud;

-- 3. Threshold sweep per period (precision, recall, alerts a day). Repeat with 20, 25, 30, 35, 40, 50.
WITH t AS (
  SELECT CASE WHEN transaction_date < TIMESTAMP '2025-01-01' THEN 'train'
              WHEN transaction_date < TIMESTAMP '2025-07-01' THEN 'validation' ELSE 'test' END AS period,
         transaction_date, is_fraud, fraud_score
  FROM silver.fact_transactions
  WHERE transaction_date >= TIMESTAMP '2023-06-17' AND transaction_date < TIMESTAMP '2026-01-01'
)
SELECT period, date_diff('day', min(transaction_date)::DATE, max(transaction_date)::DATE) + 1 AS days,
       count(*) FILTER (WHERE fraud_score > 30) AS flagged,
       count(*) FILTER (WHERE fraud_score > 30 AND is_fraud) AS true_positives,
       count(*) FILTER (WHERE is_fraud) AS fraud,
       max(fraud_score) FILTER (WHERE NOT is_fraud) AS max_legitimate_score
FROM t GROUP BY period ORDER BY period;

-- 4. Does amount separate fraud? (USD where convertible; estimated FX flag kept out of the comparison's scope)
SELECT is_fraud, quantile_cont(amount_usd, 0.5) AS p50, quantile_cont(amount_usd, 0.9) AS p90, quantile_cont(amount_usd, 0.99) AS p99
FROM silver.fact_transactions
WHERE transaction_date >= TIMESTAMP '2023-06-17' AND transaction_date < TIMESTAMP '2026-01-01' AND amount_usd IS NOT NULL
GROUP BY is_fraud;

-- 5. Categorical signals (repeat for transaction_category, channel, transaction_status, merchant_category, currency).
SELECT transaction_type, count(*) AS n, avg(is_fraud::INT) AS fraud_rate
FROM silver.fact_transactions
WHERE transaction_date >= TIMESTAMP '2023-06-17' AND transaction_date < TIMESTAMP '2026-01-01'
GROUP BY transaction_type ORDER BY fraud_rate DESC;

-- 6. Foreign vs home country. Join: transactions N:1 dim_customers on customer_id (the transaction's own customer).
SELECT (t.transaction_country IS DISTINCT FROM c.country) AS foreign_tx, count(*) AS n, avg(t.is_fraud::INT) AS fraud_rate
FROM silver.fact_transactions t JOIN silver.dim_customers c ON c.customer_id = t.customer_id
WHERE t.transaction_date >= TIMESTAMP '2023-06-17' AND t.transaction_date < TIMESTAMP '2026-01-01'
GROUP BY 1;

-- 7. Customers reached in the test half-year at the chosen cut.
SELECT count(DISTINCT customer_id) AS customers, count(*) AS charges
FROM silver.fact_transactions
WHERE transaction_date >= TIMESTAMP '2025-07-01' AND transaction_date < TIMESTAMP '2026-01-01' AND fraud_score > 30;
