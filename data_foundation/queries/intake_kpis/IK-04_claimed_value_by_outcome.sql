-- IK-04. Claimed amount by outcome group and source currency. Amounts are never summed across currencies
-- (DF-023: one USD-like scale, currencies that ignore the customer's country). Missing amount or currency is counted.
-- Outcome groups from the status snapshot: rejected; resolved or closed with compensation; resolved or closed without;
-- still open, in process or escalated.
SELECT CASE WHEN status = 'Rejected' THEN 'rejected'
            WHEN status IN ('Resolved', 'Closed') AND compensation_granted IS NOT NULL THEN 'resolved_compensated'
            WHEN status IN ('Resolved', 'Closed') THEN 'resolved_no_compensation'
            ELSE 'open_in_process_escalated' END AS outcome,
       coalesce(currency, '(none)') AS currency,
       count(*) AS complaints, count(claimed_amount) AS with_amount,
       round(median(claimed_amount), 2) AS median_amount,
       round(quantile_cont(claimed_amount, 0.25), 2) AS p25, round(quantile_cont(claimed_amount, 0.75), 2) AS p75
FROM silver.fact_complaints
WHERE subcategory = 'Cargo no reconocido' AND creation_date >= TIMESTAMP '{start}' AND creation_date < TIMESTAMP '{end}'
GROUP BY ALL ORDER BY 1, 3 DESC;
