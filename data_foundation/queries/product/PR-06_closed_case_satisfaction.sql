-- id: PR-06
-- title: Closed-case satisfaction of unrecognized-charge complaints (F5): scores of cases closed in the design window
-- scope: design
-- memory: Design-window unrecognized-charge complaints (about 10k rows), grouped by score and closing window; aggregates only.
SELECT resolution_satisfaction AS score,
       coalesce(closing_date < $design_end, FALSE) AS closed_in_window,
       count(*) AS complaints
FROM silver.fact_complaints
WHERE subcategory = 'Cargo no reconocido' AND creation_date >= $design_start AND creation_date < $design_end
GROUP BY ALL
ORDER BY closed_in_window, score NULLS FIRST
