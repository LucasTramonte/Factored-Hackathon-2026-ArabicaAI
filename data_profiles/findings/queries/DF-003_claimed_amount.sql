-- id: DF-003
-- title: Claimed amounts are not linked to transactions
-- scope: full
-- memory: Complaints filtered to one subcategory, joined to the same customer's transactions by currency and amount; grouped.
WITH c AS (
  SELECT complaint_id, customer_id, claimed_amount AS amount, currency, creation_date
  FROM silver.fact_complaints
  WHERE subcategory = 'Cargo no reconocido'
), matched AS (
  SELECT DISTINCT c.complaint_id
  FROM c
  JOIN silver.fact_transactions t
    ON t.customer_id = c.customer_id AND t.currency = c.currency
   AND abs(t.amount - c.amount) < 0.005
   AND t.transaction_date BETWEEN c.creation_date - INTERVAL 180 DAY AND c.creation_date
  WHERE c.amount IS NOT NULL
)
SELECT COUNT(*) AS complaints,
       COUNT(*) FILTER (WHERE amount IS NOT NULL) AS with_claimed_amount,
       COUNT(*) FILTER (WHERE amount IS NOT NULL AND currency IS NULL) AS amount_without_currency,
       COUNT(*) FILTER (WHERE amount IS NOT NULL AND currency = 'MXN') AS amount_in_mxn,
       MIN(amount) AS min_amount,
       quantile_cont(amount, 0.5) AS p50_amount,
       MAX(amount) AS max_amount,
       (SELECT COUNT(*) FROM matched) AS matched_to_a_transaction_within_180_days
FROM c
