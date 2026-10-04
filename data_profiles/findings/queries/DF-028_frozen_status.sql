-- id: DF-028
-- title: Complaint statuses are fixed labels: they don't progress with case age, escalated cases never get an outcome, and closing keeps the creation hour
-- scope: design
-- memory: Design-window unrecognized-charge complaints (small fact), projected to status, dates and assignment and grouped; aggregates only.
WITH c AS (
  SELECT status, creation_date, assignment_date, first_response_date, resolution_date, closing_date,
         year(creation_date) || '-Q' || quarter(creation_date) AS quarter
  FROM silver.fact_complaints
  WHERE subcategory = 'Cargo no reconocido' AND creation_date < $design_end
)
-- 1. Share still unresolved by creation quarter: older complaints are no more likely to be done.
SELECT 'unresolved_by_quarter' AS measure, quarter AS label,
       count(*) FILTER (WHERE status IN ('Open', 'In Process', 'Escalated')) AS numerator, count(*) AS denominator
FROM c GROUP BY quarter
UNION ALL
-- 2. Outcome dates on escalated complaints.
SELECT 'escalated_with_' || d, 'Escalated', n, total FROM (
  SELECT count(first_response_date) AS first_response, count(resolution_date) AS resolution, count(closing_date) AS closing,
         count(*) AS total FROM c WHERE status = 'Escalated')
  UNPIVOT (n FOR d IN (first_response, resolution, closing))
UNION ALL
-- 3. Assignment by status: Open and Rejected complaints never reach an agent.
SELECT 'assigned_by_status', status, count(assignment_date), count(*) FROM c GROUP BY status
UNION ALL
-- 4. Closed complaints whose closing time of day equals the creation time of day.
SELECT 'closing_keeps_creation_time', 'Closed with both dates',
       count(*) FILTER (WHERE strftime(closing_date, '%H:%M:%S') = strftime(creation_date, '%H:%M:%S')),
       count(*)
FROM c WHERE closing_date IS NOT NULL
ORDER BY measure, label
