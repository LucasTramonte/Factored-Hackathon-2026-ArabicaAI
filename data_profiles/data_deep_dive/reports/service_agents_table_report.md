# `service_agents` deep dive -- Bronze vs. Silver

Findings from `04_deep_dive_service_agents.ipynb`, run against the real production DuckDB (`bronze.service_agents` / `silver.dim_service_agents`, 1,200 rows -- matches the data dictionary exactly).

## Real data-integrity issue -- third one found, same pattern as `product_number`

**`employee_code`'s UNIQUE constraint is violated: 13 genuine collisions, not resends.** 1,187 distinct values across 1,200 rows. All 13 repeated codes (`E65389`, `E72566`, `E15072`, `E70142`, `E57622`, `E28894`, `E90492`, `E95303`, `E53456`, `E12787`, `E77608`, `E30468`, `E41258`) each map to **two different `agent_id`s** -- same signature as the `product_number` violation found earlier, not a duplicate-row artifact. **Contract change applied**: `employee_code` is in `unique_fields`, like `document_number`/`product_number`/`branch_code`, so the quality gate now reports these collisions.

## Code fix candidate -- 5 clean domains ready to gate

**All five previously-ungated columns came back perfectly clean against the dictionary**, unlike `customer_status`/`document_type`, which had real drift:

| Column | Real values | Matches dictionary? |
|---|---|---|
| `native_accent` | mexican (600), colombian (360), argentine (240) | Exact match, no "neutral" leak like `customers.detected_accent` had |
| `agent_type` | Phone (588), Digital (251), In-Person (230), Hybrid (131) | Exact match |
| `experience_level` | Specialist (761), Senior (286), Mid-Senior (135), Junior (18) | Exact match |
| `agent_status` | Active (1,090), Vacation (62), Leave (29), Inactive (19) | Exact match |
| `work_shift` | Afternoon (418), Morning (398), Rotating (203), Night (181) | Exact match |

Since these are already 100% clean, adding all five to `contracts.py`'s `domains` costs nothing today and guards against a future regression -- the same reasoning as the `branch_code`/`branch_type` additions.

**Contract change applied** (`contracts.py`): all five columns are gated domains.

## Other findings (no action)

1. **`languages` includes Portuguese**, despite the dataset's three declared countries (México, Colombia, Argentina) all being Spanish-speaking. Combinations: `español` (649), `español, inglés` (422), `español, portugués` (68), `español, inglés, portugués` (61) -- consistent comma-separated format throughout, no parsing surprises. Worth knowing agents apparently serve (or are modeled to serve) Portuguese speakers even though Brazil isn't in this dataset's scope -- not a bug, just a fact worth being aware of if you ever build a "matches customer's country" agent-routing feature.

2. **`avg_csat` never drops below 3.5**, even though the dictionary's declared scale is 1-5. Not a violation (3.5-5.0 is inside 1-5), just narrower than the declared range implies -- worth knowing if you're using the full 1-5 scale as an assumption anywhere.

3. **`hire_date`: 80.5% of agents (966/1,200) were hired before the dataset's June 2023 window** -- consistent with the same pattern already confirmed in `customers`, `products`, and (100% of the time) `branches`. No action; this is now a well-established cross-table pattern, not a new finding.

## Confirmed correct (no action)

- Column inventory, row count (1,200, matches dictionary), dedup: all clean.
- NOT NULL audit: all 13 declared columns, zero NULLs.
- `country_of_origin`: full canonicalization coverage (Mexico -> México correctly applied).
- **FK integrity reproduced directly**: `assigned_branch_id` at 831/833 populated orphaned (69.25% of the full table, matching the original `diagnose_branch_fk.ipynb` finding exactly) -- and the orphan shape check confirms the same conclusion as before: 831/831 orphans are fully distinct (not a repeating placeholder set) and 831/831 match the real `SUC-XXXXXXXX` format. Nothing new here, just a clean direct reproduction closing the loop on the original investigation.
- `total_monthly_interactions`: 100-800 range, no negatives.
- `phone`/`email`: 5.75% phone nulls (69/1,200), 0 emails missing `@`, 0 phones with no digits.
- `specialty`: 39.67% NULL (plausible -- likely only some experience levels get a specialty), 8 real Spanish-language categories otherwise, no anomalies.

## Status

The contract changes above are applied in `contracts.py`.
