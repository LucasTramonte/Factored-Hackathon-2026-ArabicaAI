-- id: DF-023
-- title: Amounts share one USD scale, and claimed currencies ignore the customer's country
-- scope: design
-- memory: Design-window approved purchases and unrecognized-charge claims joined to dim_customers (small, hash join), grouped by country and currency; aggregates only.
SELECT 'purchases' AS source, cu.country, t.currency, COUNT(*) AS rows,
       round(quantile_cont(t.amount, 0.5), 2) AS median_amount,
       round(quantile_cont(t.amount_usd, 0.5), 2) AS median_amount_usd
FROM silver.fact_transactions t JOIN silver.dim_customers cu USING (customer_id)
WHERE t.transaction_type = 'Purchase' AND t.transaction_status = 'Approved' AND t.transaction_date < $design_end
GROUP BY 1, 2, 3
UNION ALL
SELECT 'unrecognized_charge_claims', cu.country, coalesce(c.currency, '(none)'), COUNT(*),
       round(quantile_cont(c.claimed_amount, 0.5), 2), NULL
FROM silver.fact_complaints c JOIN silver.dim_customers cu USING (customer_id)
WHERE c.subcategory = 'Cargo no reconocido' AND c.claimed_amount IS NOT NULL AND c.creation_date < $design_end
GROUP BY 1, 2, 3
ORDER BY 1, 2, 4 DESC, 3
