-- IK-02. Repeat reporters: customers by number of unrecognized-charge complaints in the window.
-- Population: same as IK-01. Grain: customer. The denominator for the Poisson check is every customer in
-- silver.dim_customers (customers with zero complaints are included as k = 0 by the runner).
SELECT k AS complaints_per_customer, count(*) AS customers
FROM (SELECT customer_id, count(*) AS k FROM silver.fact_complaints
      WHERE subcategory = 'Cargo no reconocido' AND creation_date >= TIMESTAMP '{start}' AND creation_date < TIMESTAMP '{end}'
      GROUP BY 1)
GROUP BY 1 ORDER BY 1;
