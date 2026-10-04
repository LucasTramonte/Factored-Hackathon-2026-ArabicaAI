-- IK-05. Does a prior purchase at the same merchant separate fraud? The candidate "familiar merchant" context the
-- service could show an agent. Population: approved transactions with a merchant name, transaction_date in the window.
-- Grain: transaction. prior_same_merchant counts the same customer's earlier approved purchases at that merchant
-- inside the window (history before the window is not seen, which understates familiarity early in the window).
-- Memory model: a 5-column projected scan with one window function; DuckDB spills to disk; output is grouped counts.
WITH t AS (
  SELECT extract(year FROM transaction_date) AS yr, is_fraud,
         row_number() OVER (PARTITION BY customer_id, merchant_name ORDER BY transaction_date, transaction_id) - 1 AS prior_same_merchant
  FROM silver.fact_transactions
  WHERE transaction_date >= TIMESTAMP '{start}' AND transaction_date < TIMESTAMP '{end}'
    AND transaction_status = 'Approved' AND merchant_name IS NOT NULL)
SELECT yr, CASE WHEN prior_same_merchant = 0 THEN 'first_time' ELSE 'seen_before' END AS familiarity,
       count(*) AS transactions, sum(is_fraud::INT) AS fraud
FROM t GROUP BY ALL ORDER BY ALL;
