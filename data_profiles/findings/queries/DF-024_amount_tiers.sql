-- id: DF-024
-- title: Purchase amounts are almost flat up to USD 509, with no high-value tail
-- scope: design
-- memory: Design-window approved purchases projected to one DOUBLE (amount_usd); the quintile window sorts that single column, which DuckDB spills to disk if needed. Claimed amounts are aggregated from unrecognized-charge complaints. Aggregates only.
WITH p AS (
  SELECT amount_usd FROM silver.fact_transactions
  WHERE transaction_type = 'Purchase' AND transaction_status = 'Approved' AND amount_usd IS NOT NULL
    AND transaction_date < $design_end
), totals AS (SELECT COUNT(*) AS n, SUM(amount_usd) AS v FROM p),
tiers AS (
  SELECT CASE WHEN amount_usd < 50 THEN '1 under 50' WHEN amount_usd < 200 THEN '2 50-200'
              WHEN amount_usd <= 500 THEN '3 200-500' ELSE '4 over 500' END AS tier, amount_usd FROM p
), ranked AS (SELECT amount_usd, ntile(5) OVER (ORDER BY amount_usd DESC) AS quintile FROM p)
SELECT 'purchases_usd' AS kind, 'all' AS label, COUNT(*) AS rows, 1.0 AS row_share, 1.0 AS value_share,
       round(MIN(amount_usd), 2) AS min, round(quantile_cont(amount_usd, 0.5), 2) AS p50,
       round(quantile_cont(amount_usd, 0.9), 2) AS p90, round(quantile_cont(amount_usd, 0.99), 2) AS p99,
       round(MAX(amount_usd), 2) AS max
FROM p
UNION ALL
SELECT 'purchases_usd_tier', tier, COUNT(*), round(COUNT(*) / any_value(t.n), 4), round(SUM(amount_usd) / any_value(t.v), 4),
       round(MIN(amount_usd), 2), NULL, NULL, NULL, round(MAX(amount_usd), 2)
FROM tiers, totals t GROUP BY tier
UNION ALL
SELECT 'purchases_usd_top_quintile', 'top 20% by amount', COUNT(*), round(COUNT(*) / any_value(t.n), 4),
       round(SUM(amount_usd) / any_value(t.v), 4), round(MIN(amount_usd), 2), NULL, NULL, NULL, round(MAX(amount_usd), 2)
FROM ranked, totals t WHERE quintile = 1
UNION ALL
SELECT 'claimed_amount_source_currency', 'Cargo no reconocido', COUNT(*), NULL, NULL,
       round(MIN(claimed_amount), 2), round(quantile_cont(claimed_amount, 0.5), 2),
       round(quantile_cont(claimed_amount, 0.9), 2), round(quantile_cont(claimed_amount, 0.99), 2), round(MAX(claimed_amount), 2)
FROM silver.fact_complaints
WHERE subcategory = 'Cargo no reconocido' AND claimed_amount IS NOT NULL AND creation_date < $design_end
ORDER BY 1, 2
