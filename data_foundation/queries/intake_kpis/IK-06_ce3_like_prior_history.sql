-- IK-06. A merchant-only approximation of Visa's Compelling Evidence 3.0 heuristic: does a purchase whose customer
-- has at least 2 earlier approved purchases at the same merchant, each more than 120 days older, carry less fraud?
-- CE3.0 also needs a matching IP address or device ID; transactions carry neither, so this is weaker than CE3.0.
-- Population: approved transactions with a merchant name, transaction_date in the window. Grain: transaction.
-- History before the window is not seen, so the flag is understated early in the window.
-- Memory model: a projected scan with one RANGE window per (customer, merchant); DuckDB spills; output is grouped counts.
WITH t AS (
  SELECT extract(year FROM transaction_date) AS yr, is_fraud,
         count(*) OVER (PARTITION BY customer_id, merchant_name ORDER BY transaction_date
                        RANGE BETWEEN UNBOUNDED PRECEDING AND INTERVAL 121 DAYS PRECEDING) AS prior_older_than_120d
  FROM silver.fact_transactions
  WHERE transaction_date >= TIMESTAMP '{start}' AND transaction_date < TIMESTAMP '{end}'
    AND transaction_status = 'Approved' AND merchant_name IS NOT NULL)
SELECT yr, (prior_older_than_120d >= 2) AS ce3_like_history, count(*) AS transactions, sum(is_fraud::INT) AS fraud
FROM t GROUP BY ALL ORDER BY ALL;
