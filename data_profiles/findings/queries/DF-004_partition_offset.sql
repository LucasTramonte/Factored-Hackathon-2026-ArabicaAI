-- id: DF-004
-- title: Processing partition precedes the event date for early-hour events
-- scope: design
-- memory: Grouped by day offset; business timestamp bounded to the design window.
SELECT 'fact_transactions' AS fact,
       date_diff('day', CAST(transaction_date AS DATE), process_date) AS partition_minus_event_days,
       COUNT(*) AS rows,
       MIN(hour(transaction_date)) AS min_event_hour,
       MAX(hour(transaction_date)) AS max_event_hour
FROM silver.fact_transactions
WHERE transaction_date < $design_end
GROUP BY 1, 2
UNION ALL
SELECT 'fact_complaints',
       date_diff('day', CAST(creation_date AS DATE), process_date),
       COUNT(*), MIN(hour(creation_date)), MAX(hour(creation_date))
FROM silver.fact_complaints
WHERE creation_date < $design_end
GROUP BY 1, 2
ORDER BY 1, 2
