-- id: DF-008
-- title: Transaction types and statuses
-- scope: design
-- memory: Design-window transactions grouped by type and status.
SELECT transaction_type, transaction_status, COUNT(*) AS rows,
       COUNT(*) * 1.0 / SUM(COUNT(*)) OVER () AS share
FROM silver.fact_transactions
WHERE transaction_date < $design_end
GROUP BY 1, 2
ORDER BY 3 DESC
