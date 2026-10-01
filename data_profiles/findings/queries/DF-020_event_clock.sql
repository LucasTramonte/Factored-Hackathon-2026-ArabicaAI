-- id: DF-020
-- title: Event clock: hour-of-day shape and partition rollover by customer country
-- scope: design
-- memory: Design-window events joined to dim_customers (small, hash join), grouped to at most 2 facts x countries x 24 hours; aggregates only.
WITH ev AS (
  SELECT 'fact_transactions' AS fact, cu.country, t.transaction_date AS ts, t.process_date
  FROM silver.fact_transactions t JOIN silver.dim_customers cu USING (customer_id)
  WHERE t.transaction_date < $design_end
  UNION ALL
  SELECT 'fact_complaints', cu.country, c.creation_date, c.process_date
  FROM silver.fact_complaints c JOIN silver.dim_customers cu USING (customer_id)
  WHERE c.creation_date < $design_end
), hourly AS (
  SELECT fact, country, hour(ts) AS h, COUNT(*) AS n FROM ev GROUP BY 1, 2, 3
), shape AS (
  -- A ratio near 1 means events are spread evenly over the day: no daily rhythm to align by.
  SELECT fact, country, SUM(n) AS events, round(MIN(n) * 1.0 / MAX(n), 3) AS min_to_max_hour_ratio,
         first(h ORDER BY n DESC, h) AS busiest_hour
  FROM hourly GROUP BY 1, 2
), rollover AS (
  -- The hour at which events stop being filed under the previous day's storage partition.
  SELECT fact, country,
         MAX(hour(ts)) FILTER (WHERE process_date < CAST(ts AS DATE)) AS last_hour_in_previous_partition,
         MIN(hour(ts)) FILTER (WHERE process_date = CAST(ts AS DATE)) AS first_hour_in_own_partition,
         COUNT(*) FILTER (WHERE process_date < CAST(ts AS DATE)) AS rows_in_previous_partition
  FROM ev GROUP BY 1, 2
)
SELECT s.fact, s.country, s.events, s.min_to_max_hour_ratio, s.busiest_hour,
       r.last_hour_in_previous_partition, r.first_hour_in_own_partition, r.rows_in_previous_partition
FROM shape s JOIN rollover r USING (fact, country)
ORDER BY s.fact, s.country
