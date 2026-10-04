-- FR-01. Hours from assignment_date to first_response_date for unrecognized-charge complaints, by creation quarter.
-- Population: silver.fact_complaints, subcategory 'Cargo no reconocido', every available quarter (full period).
-- Included: both timestamps recorded and first_response_date >= assignment_date. Grain: complaint; aggregated
-- per quarter, never pooled. Memory: one small fact projected to three columns; aggregates only.
SELECT year(creation_date) AS year, quarter(creation_date) AS quarter,
       count(*) AS n,
       median(date_diff('second', assignment_date, first_response_date) / 3600.0) AS median_hours,
       quantile_cont(date_diff('second', assignment_date, first_response_date) / 3600.0, 0.9) AS p90_hours,
       min(creation_date)::DATE AS first_day, max(creation_date)::DATE AS last_day
FROM silver.fact_complaints
WHERE subcategory = 'Cargo no reconocido'
  AND assignment_date IS NOT NULL AND first_response_date IS NOT NULL
  AND first_response_date >= assignment_date
GROUP BY 1, 2
ORDER BY 1, 2;
