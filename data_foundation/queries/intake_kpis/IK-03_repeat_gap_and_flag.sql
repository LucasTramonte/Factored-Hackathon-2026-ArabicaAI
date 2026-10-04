-- IK-03. Days between a customer's consecutive unrecognized-charge complaints, and whether the source flag
-- is_repeat_complainer agrees with the history (another complaint of any type by the same customer in the window).
-- Grain: complaint. customer_id is used only to order one customer's own complaints, never to link cases.
WITH uc AS (
  SELECT customer_id, creation_date, is_repeat_complainer
  FROM silver.fact_complaints
  WHERE subcategory = 'Cargo no reconocido' AND creation_date >= TIMESTAMP '{start}' AND creation_date < TIMESTAMP '{end}'),
any_c AS (
  SELECT customer_id, count(*) AS n FROM silver.fact_complaints
  WHERE creation_date >= TIMESTAMP '{start}' AND creation_date < TIMESTAMP '{end}' GROUP BY 1),
gaps AS (
  SELECT datediff('day', lag(creation_date) OVER (PARTITION BY customer_id ORDER BY creation_date), creation_date) AS d FROM uc)
SELECT 'gap' AS part, count(d) AS n, median(d) AS median_days, quantile_cont(d, 0.1) AS p10_days, NULL::BIGINT AS flag_true_history_single,
       NULL::BIGINT AS flag_false_history_multiple
FROM gaps
UNION ALL
SELECT 'flag', count(*), NULL, NULL,
       sum((uc.is_repeat_complainer AND any_c.n = 1)::INT), sum((NOT uc.is_repeat_complainer AND any_c.n > 1)::INT)
FROM uc JOIN any_c USING (customer_id);
