-- id: PR-10
-- title: Repeat complainers: unrecognized-charge complaints that follow an earlier one by the same customer (as many as chance predicts; not re-opened disputes)
-- scope: design
-- memory: Design-window unrecognized-charge complaints (about 10k rows) with one window per customer (lag over creation_date); aggregates only.
-- There is no re-opened status in the source, so the proxies are labelled: a later complaint by the same customer within 30 or
-- 90 days, or after the earlier one had a resolution or closing date. is_repeat_complainer is the source's own flag, reported apart.
WITH c AS (
  SELECT customer_id, creation_date, is_repeat_complainer,
         lag(creation_date) OVER w AS prev_created,
         lag(coalesce(resolution_date, closing_date)) OVER w AS prev_outcome,
         count(*) OVER (PARTITION BY customer_id) AS per_customer
  FROM silver.fact_complaints
  WHERE subcategory = 'Cargo no reconocido' AND creation_date >= $design_start AND creation_date < $design_end
  WINDOW w AS (PARTITION BY customer_id ORDER BY creation_date)
)
SELECT count(DISTINCT customer_id) AS customers,
       count(DISTINCT customer_id) FILTER (WHERE per_customer >= 2) AS repeat_customers,
       count(*) AS complaints,
       count(*) FILTER (WHERE per_customer >= 2) AS complaints_from_repeat_customers,
       count(*) FILTER (WHERE prev_created IS NOT NULL) AS follow_up_complaints,
       count(*) FILTER (WHERE creation_date - prev_created <= INTERVAL 30 DAY) AS within_30_days,
       count(*) FILTER (WHERE creation_date - prev_created <= INTERVAL 90 DAY) AS within_90_days,
       count(*) FILTER (WHERE prev_outcome < creation_date) AS after_prior_outcome,
       count(*) FILTER (WHERE is_repeat_complainer) AS source_flag_repeat
FROM c
