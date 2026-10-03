-- id: PR-02
-- title: KPI 2, recorded claimed amounts of unrecognized-charge complaints, one row per source currency (never pooled)
-- scope: design
-- memory: Design-window unrecognized-charge complaints (about 10k rows) left-joined many-to-one to dim_fx_rates on (creation day, currency, USD); grouped by currency.
WITH c AS (
  SELECT creation_date::DATE AS d, currency, claimed_amount AS a
  FROM silver.fact_complaints
  WHERE subcategory = 'Cargo no reconocido' AND creation_date >= $design_start AND creation_date < $design_end
), v AS (
  SELECT c.*, fx.exchange_rate AS rate
  FROM c LEFT JOIN silver.dim_fx_rates fx
    ON fx.rate_date = c.d AND fx.source_currency = c.currency AND fx.target_currency = 'USD'
)
SELECT coalesce(currency, '(none)') AS currency,
       count(*) AS complaints,
       count(a) AS amount_present,
       sum(a) AS source_amount_sum,
       median(a) AS source_amount_p50,
       count(*) FILTER (WHERE a IS NOT NULL AND (currency = 'USD' OR rate IS NOT NULL)) AS usd_convertible,
       sum(CASE WHEN currency = 'USD' THEN a ELSE a * rate END) AS usd_amount_sum,
       currency IS DISTINCT FROM 'USD' AS usd_is_estimated
FROM v GROUP BY currency
ORDER BY currency
