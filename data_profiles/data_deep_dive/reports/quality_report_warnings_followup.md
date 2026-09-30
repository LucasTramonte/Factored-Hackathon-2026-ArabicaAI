# Follow-up: the 5 unexplained warnings from the full quality report -- resolved

Ran `14_followup_quality_report_warnings.ipynb`. All five explained, two confirm a new pattern beyond the `product_owner_mismatch` finding, one is a genuinely different mechanism, and two are negligible.

## `registration_branch_id`/`assigned_branch_id` -- confirmed: these aren't real FKs to `branches` at all

The hypothesis from the Bronze-profile clue holds up completely:

| Field | Total rows | Distinct values used | Distinct values that are real `branch_id`s | Real `branches` table size |
|---|---|---|---|---|
| `customers.registration_branch_id` | 150,000 | **150,000** (every single one unique) | **5** | 350 |
| `service_agents.assigned_branch_id` | 833 populated | 833 | **2** | 350 |

Every `registration_branch_id` value is distinct -- that alone rules out a real assignment to 350 branches (which would produce heavy repetition, ~429 customers/branch on average). Only 5 of 150,000 happen to coincide with an actual branch ID, and only 2 of 833 for agents -- consistent with coincidental string collisions in a large ID space, not real linkage. The format comparison (section 1) shows the values look identical in shape (`SUC-XXXXXXXX`) to real branch IDs -- they're just drawn from an independent generator, not the real 350-branch list. **This is the same class of issue as `complaints.affected_product_id`/`digital_events.product_id`'s `product_owner_mismatch` -- a synthetic-generation artifact upstream, not something this pipeline's Bronze-to-Silver logic introduced or can fix -- but it's a more extreme version: those fields at least landed on a real, valid product; these essentially never land on a real, valid branch at all.**

Worth flagging clearly: `customers`' and `branches`' own earlier deep dives (tables 1 and 3 in this series) didn't catch this, because neither one checks a *cross-table* relationship -- `customers`' own report would have checked `registration_branch_id`'s FK integrity against `branches` directly (and 149,995/150,000 orphans should have shown up there too, if the check ran the same way). This is worth a look back at that table's original FK section to see whether this was actually caught before and not flagged as prominently, or whether it's a genuinely new finding.

## `transaction_before_product_opening` -- real and substantial, different mechanism from the branch/product issues

This isn't a small artifact: the affected transactions happen **1 to 1,094 days** before their own product's `opening_date` (median 321 days, average ~366 days -- essentially a full year early on average). That's a transaction on an account that, per the data, didn't exist yet -- for 18.7% of all 4.4M transactions. Importantly, this is a **different mechanism** from the branch/product-ownership issues above: `transactions.product_id` correctly resolves to a real product owned by the right customer (0/4,425,008 ownership mismatches, reconfirmed here) -- the FK and ownership are both clean. The problem is purely **temporal**: `transaction_date` and the product's `opening_date` weren't generated with any consistency constraint between them. This is worth flagging separately from the ownership-mismatch family of findings since the fix story (if any) would be different -- there's no wrong ID here, just an impossible date relationship.

## `product_number`/`employee_code` unique violations -- negligible, simple duplicate collisions

Both are exactly what the counts implied: 6 `product_number` values and 13 `employee_code` values each appear in exactly 2 rows (no value appears 3+ times). At this scale (6/400,000 and 13/1,200) these read as ordinary random-ID collisions in the generation process, not a systemic problem -- nothing further to investigate.

## Bottom line

- **2 warnings (`registration_branch_id`, `assigned_branch_id`) are a newly-confirmed, more severe version of the same synthetic-ID-generation pattern already found in `complaints`/`digital_events`** -- not a pipeline bug, a source-data characteristic, but one that essentially breaks any real "which branch is this customer/agent tied to" analysis.
- **1 warning (`transaction_before_product_opening`) is a genuinely different, temporal-consistency issue**, also upstream, also not something Silver's transform logic caused.
- **2 warnings (the unique-field violations) are negligible**, simple small-scale ID collisions.
- The 2 `product_owner_mismatch` warnings were already fully explained in the `complaints` deep dive.

None of this suggests any of the `contracts.py` changes need to be reverted -- 0 errors, and every warning here is a real signal about the underlying data (correctly surfaced as a warning), not a false positive introduced by the fixes applied earlier today.
