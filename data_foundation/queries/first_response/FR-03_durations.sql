-- FR-03. One duration per charted complaint, for the bootstrap intervals of FR-01. Same population and filters as
-- FR-01; no identifier is selected. Memory: about 7.2k (year, quarter, hours) rows, resampled in memory per quarter
-- and never written: only the interval bounds reach the aggregate JSON.
SELECT year(creation_date) AS year, quarter(creation_date) AS quarter,
       date_diff('second', assignment_date, first_response_date) / 3600.0 AS hours
FROM silver.fact_complaints
WHERE subcategory = 'Cargo no reconocido'
  AND assignment_date IS NOT NULL AND first_response_date IS NOT NULL
  AND first_response_date >= assignment_date
ORDER BY 1, 2, 3;
