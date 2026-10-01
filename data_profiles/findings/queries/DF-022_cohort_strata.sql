-- id: DF-022
-- title: Customers with an unrecognized-charge complaint, by country, segment and accent
-- scope: design
-- memory: Design-window complaints of one subcategory joined to dim_customers, distinct customers per rollup cell; aggregates only.
WITH c AS (
    -- Missing values get a label so they can't be mistaken for a ROLLUP subtotal (NULL).
  SELECT DISTINCT c.customer_id, coalesce(cu.country, '(none)') AS country, coalesce(cu.segment, '(none)') AS segment,
         coalesce(cu.detected_accent, '(none)') AS detected_accent
  FROM silver.fact_complaints c JOIN silver.dim_customers cu USING (customer_id)
  WHERE c.subcategory = 'Cargo no reconocido' AND c.creation_date < $design_end
), total AS (SELECT COUNT(*) AS n FROM c)
SELECT country, segment, detected_accent, COUNT(*) AS customers,
       round(COUNT(*) * 1.0 / (SELECT n FROM total), 4) AS share_of_all
FROM c
GROUP BY ROLLUP (country, segment, detected_accent)
ORDER BY country NULLS LAST, segment NULLS LAST, detected_accent NULLS LAST
