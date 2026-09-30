# `customers` deep dive -- Bronze vs. Silver

Findings from `01_deep_dive_customers.ipynb`, run against the real production DuckDB (`bronze.customers` / `silver.dim_customers`, 150,000 rows).

## Summary

Silver correctly implements every transformation `customers_spec` and the data dictionary call for: no missing/extra columns, no dedup issues, no unexpected NULLs in required fields, correct type casts (`DATE`, `DOUBLE`, `TIMESTAMP`, `BOOLEAN`), full country canonicalization, and correct boolean parsing. Six items below are worth acting on or noting; none require a Silver code change.

## Fixed

- **`customer_status` domain violation was a false positive.** `contracts.py` declared `{Active, Inactive, Blocked, Closed}`; real data (and the data dictionary) only ever produce `Suspended`, never `Blocked`. Every one of the 4,407 "violations" in the quality report was this mismatched label, not bad data. **Fixed**: `contracts.py` now declares `{Active, Inactive, Suspended, Closed}`. Quality warnings should drop from 6 to 5 on the next run.

## Open findings

1. **`document_type` has the same kind of label drift, not yet gated.** Data dictionary declares `DNI, CURP, CC, CE, Passport`; real data is `DNI, CE, Pasaporte, CC` -- `CURP` never appears, and it's `Pasaporte` (Spanish), not `Passport`. `contracts.py` declares no domain for this column, so nothing currently catches it. Candidate for a `domains` entry once a canonical value is chosen.

2. **`last_updated` 2027 anomaly is bigger than documented.** `table_specs.py`'s docstring implies a single stray value; real data has 9,379 rows (6.25%) with `last_updated` past the dataset's stated June 2026 window. They cluster near `registration_date + ~1 year` (e.g. `2026-06-16` -> `2027-06-15`), suggesting an "anniversary update" pattern in the generator that overshoots the window rather than one outlier. Docstring/README should be updated to reflect the real scale.

3. **`registration_date` window assumption was wrong, not the data.** 93,695/150,000 rows (62%) register before 2023-06-17 (earliest: 2018-06-18). The dictionary's "June 2023-June 2026" window most likely describes the transactional/event data window, not customer tenure -- customers can register years before a snapshot. No data issue; corrected in the notebook.

4. **`estimated_monthly_income` has an extreme outlier.** Max ~$111.9M/month, no negative values otherwise. Not yet sampled to confirm whether it's one fat-fingered row or a real ultra-high-income segment -- worth a follow-up query.

5. **`postal_code` numeric-parseable rate on real data is 80.09%**, not the ~72.06% the spec docstring cites (that figure came from dev/profile data). Conclusion (keep as VARCHAR) still holds; docstring figure is stale.

6. **Duplicated first/last names (e.g. "Adriana Adriana", "Cruz Cruz") are a source-generator artifact, not a Silver gap.** Names are two-part compounds drawn from component pools; the doubled ones just drew the same component twice for both halves. `as_string` is the only transform applied and is already correct -- nothing to fix. Worth a one-line README note if documenting known data-generation quirks, same treatment as the branch_id anomaly.

## Follow-up findings (section 10.5 -- document_number, contact fields, accent, occupation, state/country)

7. **`detected_accent` never uses the dictionary's fourth declared value, "neutral."** Real distribution: `mexican` 52,505, `colombian` 31,666, `argentine` 21,012, and 44,817 (29.9%) are plain NULL. The dictionary declares the domain as `(mexican, colombian, argentine, neutral)` -- in practice, whatever should have produced "neutral" produced NULL instead. Worth deciding whether that's intentional (no accent detected = NULL is a reasonable design) or whether "neutral" was meant to be a real, distinct value that never got generated.

8. **`landline_phone` is NULL for 50.0% of customers** (75,053/150,000) -- much higher than `email` (2.0%), `mobile_phone` (3.1%), or `address` (4.9%). Plausible on its own (landlines are genuinely less universal than mobile), but flagging the scale since it's an order of magnitude above the dataset's own stated "~5% nulls in nullable fields" baseline.

## Confirmed correct (no action)

- **`document_number`**: confirmed genuinely unique -- 150,000 distinct values across 150,000 rows, 0 NULLs. The `NOT NULL, UNIQUE` constraint holds exactly.
- **`email`/`mobile_phone`**: where populated, 0 rows fail basic shape checks (every email has `@`, every phone has at least one digit).
- **`occupation`**: 10.03% NULL (15,039/150,000), 20 real categories otherwise fairly evenly distributed (~6,650-6,862 each) -- no anomalies.
- **`state` vs. `country`**: every state value correctly belongs to its claimed country (Argentina's 5 provinces, Colombia's 5 departments, México's 6 states) -- no cross-country contamination.

- Column inventory: exact match between `customers_spec` and `silver.dim_customers`, right order, right types.
- Row/dedup reconciliation: 150,000 Bronze rows = 150,000 distinct `customer_id` = 150,000 Silver rows, no duplicates.
- NOT NULL audit: all 15 dictionary-declared NOT NULL columns have zero NULLs in Bronze.
- `credit_score`: 422-850, fully inside the declared 300-850 range, NULLs (22,492) preserved correctly through the cast.
- `date_of_birth`: 1942-2005, no implausible ages or future dates.
- Country canonicalization: 100% coverage, no uncanonicalized spellings leak into Silver.
- `accepts_marketing`: clean ~50/50 True/False split, boolean parsing introduces no unexpected NULLs.
- `marital_status`/`education_level` "NaN" cells: confirmed to be actual SQL NULLs (a pandas display artifact when printing `None`), not the literal string `"nan"` -- `strip_templated_nan` would have caught the latter case regardless.

## Next

`products` deep dive.
