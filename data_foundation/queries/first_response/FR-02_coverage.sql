-- FR-02. How many unrecognized-charge complaints carry a first response, and which are left out of FR-01.
-- Population: silver.fact_complaints, subcategory 'Cargo no reconocido', full period. One row per measure.
SELECT 'complaints' AS measure, NULL AS label, count(*) AS n
FROM silver.fact_complaints WHERE subcategory = 'Cargo no reconocido'
UNION ALL
SELECT 'with_first_response', NULL, count(first_response_date)
FROM silver.fact_complaints WHERE subcategory = 'Cargo no reconocido'
UNION ALL
SELECT 'first_response_without_assignment', NULL, count(*)
FROM silver.fact_complaints WHERE subcategory = 'Cargo no reconocido' AND first_response_date IS NOT NULL AND assignment_date IS NULL
UNION ALL
SELECT 'first_response_before_assignment', NULL, count(*)
FROM silver.fact_complaints WHERE subcategory = 'Cargo no reconocido' AND first_response_date < assignment_date
UNION ALL
SELECT 'charted', NULL, count(*)
FROM silver.fact_complaints WHERE subcategory = 'Cargo no reconocido' AND first_response_date >= assignment_date
UNION ALL
SELECT 'no_first_response_by_status', status, count(*)
FROM silver.fact_complaints WHERE subcategory = 'Cargo no reconocido' AND first_response_date IS NULL GROUP BY status
ORDER BY measure, label;
