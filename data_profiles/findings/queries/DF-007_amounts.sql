-- id: DF-007
-- title: Purchase amount ranges and precision
-- scope: design
-- memory: Approved purchases in the design window grouped by currency.
SELECT t.currency, COUNT(*) AS purchases, MIN(t.amount) AS min_amount,
       quantile_cont(t.amount, 0.5) AS p50, quantile_cont(t.amount, 0.95) AS p95, MAX(t.amount) AS max_amount,
       AVG(CASE WHEN t.amount <> round(t.amount) THEN 1 ELSE 0 END) AS share_with_cents
FROM silver.fact_transactions t
WHERE t.transaction_type = 'Purchase' AND t.transaction_status = 'Approved' AND t.transaction_date < $design_end
GROUP BY 1
ORDER BY 1
