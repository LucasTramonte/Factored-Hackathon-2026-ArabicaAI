# `products` deep dive -- Bronze vs. Silver

Findings from `02_deep_dive_products.ipynb`, run against the real production DuckDB (`bronze.products` / `silver.dim_products`, 400,000 rows).

## Summary

Silver implements every transformation `products_spec` calls for correctly: no missing/extra columns, no FX-join fan-out, no unexpected NULLs in required fields, correct type casts including the two derived USD columns, and both foreign keys (`customer_id`, `opening_branch_id`) at 0 orphans. One real constraint violation and several dictionary-vs-reality mismatches turned up; details below.

## Real data-integrity issue

1. **`product_number`'s UNIQUE constraint is violated -- 6 genuine collisions, not resends.** 399,994 distinct values across 400,000 rows. All 6 repeated values (4 `LOAN-XXXXXXXX`, 2 plain 10-digit numbers) each map to **two different `product_id` values** -- this isn't the same product re-sent twice, it's two distinct products sharing one account/card/loan number. This is the first genuine constraint violation found across the first two tables (`customers.document_number` was fully clean). Worth deciding whether to flag these 12 products for review or just document the exception, since nothing downstream currently checks this.

## Notable findings

2. **`products.currency` never contains MXN**, despite MXN being one of the 4 currencies the dictionary declares and México being the single largest customer country (74,907/150,000 customers, ~50%). Real distribution: USD 220,501, COP 107,975, ARS 71,524 -- zero MXN rows. Worth checking upstream whether Mexican customers' products were meant to be MXN-denominated and got mislabeled, or whether this is intentional (e.g. Mexican products always issued in USD).

3. **`product_type`'s real domain is 8 Spanish-language categories that don't textually match the dictionary's English example list**, which was also cut off mid-sentence in the PDF: `Cuenta Ahorro` (120,203), `Tarjeta Crédito` (100,102), `Cuenta Corriente` (99,979), `Tarjeta Débito` (39,938), `Préstamo Personal` (19,960), `Préstamo Hipotecario` (11,910), `Inversión` (5,859), `Seguro` (2,049). `Seguro` (Insurance) and `Tarjeta Débito` (Debit Card) weren't visible in the dictionary's truncated cell at all -- same class of issue as `customers.document_type`'s "Pasaporte" vs. "Passport". No `contracts.py` domain currently gates this column.

4. **The FX conversion math is correct; the notebook's own spot-check made it look otherwise.** The non-USD recomputation cell shows a consistent `0.005` "diff" on every sampled row -- but that's because `current_balance_usd`/`credit_limit_usd` are stored as raw, unrounded `DOUBLE`s (e.g. `1946.065`), while the diagnostic query rounds its independent recomputation to 2 decimals for comparison (`1946.06`). The underlying multiplication is right; the mismatch is an artifact of the check, not the data. Worth noting as a real (separate) observation though: the dictionary types these as `DECIMAL(15,2)`, but Silver never rounds them to 2 decimals -- consider adding `ROUND(..., 2)` to the USD expressions in `table_specs.py` if downstream reporting expects currency-standard precision.

5. **`last_updated`'s "2027 overshoot" is a cross-table pattern, not a `customers`-only quirk.** 25,113/400,000 rows (6.28%) have `last_updated` past the dataset's June 2026 window -- almost exactly the same rate as `customers` (9,379/150,000 = 6.25%). Worth watching for the same ~6.3% rate in every subsequent table's `last_updated`; if it holds, this points to one shared generator bug rather than 13 separate ones.

6. **`opening_date` also predates the dictionary's stated window, same as `customers.registration_date`.** 250,127/400,000 rows (62.5%) open before 2023-06-17 (earliest: 2018-06-18). Reinforces the conclusion from the customers notebook: the "June 2023-June 2026" window describes the transactional/event data, not dimension-table tenure dates.

7. **Extreme numeric outliers, same family as `customers.estimated_monthly_income`.** `current_balance` max ≈ $881.5M, `credit_limit` max ≈ $600.0M. No negatives anywhere. Not yet sampled to see if these are one or two fat-fingered rows or a genuine private-banking segment -- worth a joint look across both tables once more turn up.

8. **Credit-only fields are ~95%, not 100%, populated within credit-type products.** `credit_limit`/`days_past_due` correctly never populate for deposit-type products (`Cuenta Ahorro`, `Cuenta Corriente`, `Tarjeta Débito`, `Inversión`, `Seguro` -- exactly 0% each), confirming the intended design. But within the three credit-type products (`Tarjeta Crédito`, `Préstamo Personal`, `Préstamo Hipotecario`), only ~94.9-95.2% actually have a value -- roughly 5% of credit products are missing a limit/DPD they'd be expected to have. Minor; could be legitimate (e.g. a newly opened line not yet assigned a limit).

## Confirmed correct (no action)

- Column inventory: exact match, including the two FX-derived columns with correct `DOUBLE` types.
- Row/dedup reconciliation: 400,000 Bronze rows = 400,000 distinct `product_id` = 400,000 Silver rows; the FX `LEFT JOIN` does not fan out.
- NOT NULL audit: all 12 dictionary-declared NOT NULL columns have zero NULLs.
- FK integrity: `customer_id` and `opening_branch_id` both at 0 orphans, 100% populated -- reinforces that the `registration_branch_id`/`assigned_branch_id` orphan defect is isolated to those two columns only.
- `product_status`: matches both the dictionary and `contracts.py` exactly (`Active, Blocked, Closed, Suspended`) -- no drift, unlike `customers.customer_status`.
- `opening_channel`: matches the dictionary's 4 declared values exactly.
- FX coverage: `v_fx_latest_to_usd` covers every currency actually used (ARS, COP; USD needs no conversion). USD passthrough is exact (0 mismatches). Non-USD conversion math is correct (see finding 4).
- Date ordering: no `expiration_date` before `opening_date`, no `last_transaction_date`/`last_updated` before `opening_date`.
- `has_linked_app`: clean ~50/50 boolean parse, no NULLs introduced.

## Next

`branches` deep dive.
