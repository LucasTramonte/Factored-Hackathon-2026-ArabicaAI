-- id: PR-05
-- title: Escalated unrecognized-charge complaints: how long they have stayed open at the data end (a lower bound, not a closing time)
-- scope: full
-- memory: Escalated unrecognized-charge complaints (under 1k rows) and one scalar for the data end; aggregates only.
WITH snapshot AS (SELECT max(creation_date) AS data_end FROM silver.fact_complaints),
e AS (
  SELECT c.creation_date, c.first_response_date, c.resolution_date, c.closing_date, a.data_end
  FROM silver.fact_complaints c CROSS JOIN snapshot a
  WHERE c.subcategory = 'Cargo no reconocido' AND c.status = 'Escalated'
)
SELECT any_value(data_end)::DATE AS data_end,
       count(*) AS escalated,
       count(*) FILTER (WHERE creation_date < TIMESTAMP '2026-01-01') AS created_in_design_window,
       count(resolution_date) AS with_resolution_date,
       count(closing_date) AS with_closing_date,
       quantile_cont(date_diff('day', creation_date, data_end), 0.5) AS age_since_creation_d_p50,
       quantile_cont(date_diff('day', creation_date, data_end), 0.9) AS age_since_creation_d_p90,
       count(first_response_date) AS with_first_response,
       quantile_cont(date_diff('day', first_response_date, data_end), 0.5) AS age_since_first_response_d_p50,
       quantile_cont(date_diff('day', first_response_date, data_end), 0.9) AS age_since_first_response_d_p90
FROM e
