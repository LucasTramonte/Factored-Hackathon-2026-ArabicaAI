# `complaints` deep dive -- Bronze vs. Silver

Findings from `12_deep_dive_complaints.ipynb`, run against the real production DuckDB (`bronze.complaints` / `silver.fact_complaints`, 67,095 rows).

## Headline finding -- `affected_product_id`'s owner NEVER matches the complaint's own `customer_id`, and the existing quality check can't catch it

Section 12 reproduced `checks.py`'s own `product_owner_mismatch` relationship check directly: **of the 44,570 complaints with a populated `affected_product_id`, exactly 0 have a product actually owned by the complaint's `customer_id` -- 44,570/44,570 mismatches, 100%.** This isn't a handful of edge cases (a complaint filed on a family member's behalf, say) -- it's *every single row*, which points to a synthetic-data-generation artifact (product assigned independently of customer during generation) rather than a real business scenario.

**Worth knowing regardless of what caused it: I checked `test_quality.py` and `checks.py` directly, and `product_owner_mismatch` is hardcoded to `"warning"` severity no matter how high the mismatch count is** (`checks.py` line ~167: `"warning" if mismatched else "info"`) -- there's no threshold that escalates it to `"error"`. So this check has been running against real production data at 100% mismatch and it has never once failed a build or blocked readiness; it just silently logs a warning every time. This is worth a conversation regardless of whether the underlying data issue itself needs fixing -- a relationship check that can never actually gate anything, even at a 100% violation rate, may not be doing the job its name implies.

## Second finding -- 492 complaints have `resolution_date` before `first_response_date`

Section 10's date-sequencing check: `assignment_before_creation` (0) and `closing_before_resolution` (0) are clean, but **`resolution_before_response` = 492** -- these complaints show a resolution timestamp earlier than the first-response timestamp, which shouldn't be possible in the stated workflow order (assign -> first respond -> resolve -> close). 492/67,095 is small (0.7%) but it's a real logical inversion, not just missing data -- both dates are actually populated on these rows, just in the wrong order.

## Third finding -- 62 complaints have `compensation_granted` exceeding `claimed_amount`

Section 7: `comp_exceeds_claimed = 62`. Compensation paid out that's larger than what was originally claimed, on 62/4,641 rows where both are populated (1.3% of compensated complaints). Could be legitimate (goodwill gestures, escalated settlements) but flagging since it's an unusual enough pattern to be worth knowing about.

## Code fix candidates

**1. `description` and `is_repeat_complainer` are both dictionary NOT NULL, confirmed 0 nulls (Bronze and Silver), and missing from `contracts.py`'s `required` tuple.** Both safe additions.

**2. Four domains, all confirmed clean:**

| Column | Real values | Matches dictionary? |
|---|---|---|
| `case_type` | Complaint, Claim, Request, Suggestion | Exact match |
| `reception_channel` | Call Center, Email, Web, App, Branch, Regulator | Exact match |
| `priority` | Low, Medium, High, Critical | Exact match |
| `status` | In Process, Open, Resolved, Escalated, Closed, Rejected | Exact match (dictionary text was truncated in the PDF but all 6 values are confirmed) |

**3. `currency` domain, also confirmed clean**: `{"MXN", "COP", "ARS", "USD"}` (each ~5,400-5,500 rows, 67.55% null -- matches the spec comment's stated null rate almost exactly). Same domain values as the still-pending `daily_exchange_rates` fix from earlier in this review.

Want me to add `description`/`is_repeat_complainer` to `required` and all five domains (4 categorical + `currency`)?

## Other findings (no action)

1. **Row count: 67,095 vs. the dictionary's declared 80,000** -- no duplicates. Note this exactly matches the row count `table_specs.py`'s own spec comment already cited from an earlier profile (67,095) -- consistent, not a new drift.

2. **`origin_interaction_id` drop re-confirmed still valid**: 0/67,095 populated, 0 distinct non-null values on the current data -- the old spec comment's justification for dropping it in Silver still holds.

3. **No hidden `amount_usd`-style column** -- confirmed directly, the "not converted to USD" design choice from the spec comment is real, not an oversight.

4. **`sla_breached` doesn't meaningfully correlate with `priority`** -- breach rate is ~19-20% across all four priority levels (Critical 19.2%, High 20.5%, Low 20.1%, Medium 20.1%). You might expect Critical complaints to either breach less (prioritized handling) or more (harder SLAs) -- instead it's close to a flat ~20% regardless of priority. Not a data-quality issue, just worth knowing if this ever feeds a priority-effectiveness analysis.

5. **`status` vs. date population makes sense once you look closely**: `Escalated` complaints get `assignment_date` (95.7%) but literally 0% ever get `first_response_date`/`resolution_date`/`closing_date` -- consistent (not partial), suggesting escalation routes around the normal response workflow entirely rather than being a data gap. `Resolved` complaints get `resolution_date` (95.3%) but 0% get `closing_date` -- "Resolved" and "Closed" are evidently distinct terminal states in this workflow, only `Closed` status rows ever have `closing_date` populated. `Rejected` complaints get none of the four dates (0% across the board), consistent with being dismissed without processing.

6. **`resolution_days` is an exact, deterministic match to `date_diff('day', creation_date, resolution_date)`** across all 14,626 rows where both are populated -- zero mismatches, confirming it's derived from the full creation-to-resolution span, not from any intermediate step.

## Confirmed correct (no action)

- Column inventory: 25 Silver columns present (26 Bronze minus the intentionally-dropped `origin_interaction_id`), types all correct.
- Dedup: 0 duplicate raw Bronze rows.
- NOT NULL audit: all 12 dictionary-declared columns clean, zero nulls in Bronze or Silver.
- **All 4 remaining FKs reproduced directly, zero orphans**: `customer_id`, `affected_product_id`, `related_branch_id`, `assigned_agent_id`.
- `resolution_satisfaction`: within the declared 1-5 range, all 5 distinct values present, zero out-of-range.
- `claimed_amount`/`compensation_granted`: no negatives (aside from the compensation-exceeds-claim finding above, which isn't a negativity issue).
- **Window check**: 0 rows before the declared window start; 29 rows slightly past the end (`creation_date` up to 2026-06-18 07:56:52) -- same small-overshoot pattern as other fact tables.
- `process_date` differs from `creation_date`'s date part in 22,585/67,095 rows (33.7%) -- same shape and range as the confirmed-clean timezone-rollback pattern seen in `transactions`/`digital_events`, not independently re-verified by hour-of-day here but consistent with that mechanism.

## Next

Two categories of code-fix candidates above (2 required-column additions + 5 domains) -- let me know if you want them applied. Also worth a decision on the `product_owner_mismatch` severity question (headline finding) -- that's a judgment call about the check framework itself, not something I'd change without you weighing in.

Last table left: `campaign_sends` (13/13) -- ready to build that notebook whenever you want to finish the series.
