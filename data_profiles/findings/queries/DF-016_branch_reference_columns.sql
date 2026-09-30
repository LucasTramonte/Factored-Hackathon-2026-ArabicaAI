-- id: DF-016
-- title: Branch reference columns that do not resolve to branches
-- scope: full
-- memory: One left join per dimension to the 350-row branch dimension; grouped counts only.
SELECT 'dim_customers.registration_branch_id' AS link,
       COUNT(*) AS total_rows,
       COUNT(c.registration_branch_id) AS populated,
       COUNT(DISTINCT c.registration_branch_id) AS distinct_values,
       COUNT(*) FILTER (WHERE c.registration_branch_id IS NOT NULL AND b.branch_id IS NOT NULL) AS resolves,
       COUNT(DISTINCT b.branch_id) AS distinct_branches_resolved
FROM silver.dim_customers c
LEFT JOIN silver.dim_branches b ON b.branch_id = c.registration_branch_id
UNION ALL
SELECT 'dim_service_agents.assigned_branch_id',
       COUNT(*), COUNT(a.assigned_branch_id), COUNT(DISTINCT a.assigned_branch_id),
       COUNT(*) FILTER (WHERE a.assigned_branch_id IS NOT NULL AND b.branch_id IS NOT NULL),
       COUNT(DISTINCT b.branch_id)
FROM silver.dim_service_agents a
LEFT JOIN silver.dim_branches b ON b.branch_id = a.assigned_branch_id
