# `marketing_campaigns` deep dive -- Bronze vs. Silver

Findings from `05_deep_dive_marketing_campaigns.ipynb`, run against the real production DuckDB (`bronze.marketing_campaigns` / `silver.dim_marketing_campaigns`, 200 rows -- matches the data dictionary exactly).

This is the cleanest table so far -- no UNIQUE violations, no FK orphans (it has none to check), no cast bugs, no dropped values anywhere. First table this run that comes back with zero real data-integrity findings.

## Code fix candidate -- 3 clean domains + a missing `expected_columns` entry

**`campaign_type`, `campaign_objective`, and `campaign_status` all came back perfectly clean against the dictionary**, in both Bronze and Silver, with no drift at all (not even the Spanish/English mismatch seen in `product_type`/`geographic_zone`):

| Column | Real values | Matches dictionary? |
|---|---|---|
| `campaign_type` | Email (67), SMS (42), WhatsApp (37), Push (24), Mix (21), Voice (9) | Exact match, all 6 declared values present |
| `campaign_objective` | Retention (62), Cross-sell (51), Acquisition (38), Reactivation (25), Up-sell (24) | Exact match, all 5 declared values present |
| `campaign_status` | Completed (172), Paused (25), Active (3) | Matches the declared set, but **`Planned` never appears** -- see below |

Same reasoning as the `service_agents`/`branches` additions: free to gate since they're already clean, guards against a future regression. Also, `campaign_name` is dictionary-declared `NOT NULL` (confirmed clean: 0 nulls in Bronze or Silver) but isn't in `contracts.py`'s `expected_columns` string at all -- a one-line addition alongside the domains.

**Contract change applied** (`contracts.py`): `campaign_objective`, `campaign_status` and `campaign_type` are gated domains, and `campaign_name` is in `expected_columns`.

## Other findings (no action)

1. **`campaign_status` never shows `Planned`** (only `Completed`, `Paused`, `Active`) -- same shape as `branches.branch_status` never showing `Closed`. Plausible: if all sampled campaigns already started, there'd be nothing left in a pre-launch state. Worth knowing if you build logic branching on `Planned` specifically -- it's untested.

2. **8 campaigns have `end_date` after the dataset's declared window end (2026-06-17)**, latest being 2026-08-20. Unlike the "dimension predates the window" pattern seen in every other table's lifecycle-start field, this is the opposite direction -- a campaign whose end_date runs past the window. Not a violation of anything declared, just worth knowing this table's date range doesn't fully sit inside the "June 2023-June 2026" window on either edge (start_dates were all inside the window, min 2023-07-01).

3. **`expected_conversion_rate` never exceeds 14.69**, well under the DECIMAL(5,2) field's nominal ceiling and confirming it's stored as a percentage (0-100 scale), not a 0-1 fraction. No negatives, no out-of-range values. Just documenting the actual observed range (0.55-14.69) since the dictionary doesn't state which convention applies.

## Confirmed correct (no action)

- Column inventory, row count (200, matches dictionary), dedup: all clean. Zero duplicate raw Bronze rows.
- NOT NULL audit: all 7 declared-required columns, zero nulls in Bronze or Silver, zero cast-introduced nulls.
- Nullable columns (4): population rates as expected (`description` 80.5%, `promoted_product` 89%, `target_segment` 60.5%, `target_country` 44.5%, `budget` 84.5%, `expected_conversion_rate` 93%), zero values dropped by any cast.
- `target_country`: full canonicalization coverage -- "Mexico" (Bronze) correctly becomes "México" (Silver), same as every other table.
- `start_date`/`end_date`: correct `DATE` casts, zero campaigns where `end_date <= start_date`, zero starts before or after the declared window.
- `budget`: correct `DOUBLE` cast, range $6,355.31-$499,954.38, no negatives.
- `promoted_product`/`target_segment`: **full overlap** with the real `products.product_type` and `customers.segment` domains found in earlier deep dives -- these campaigns genuinely target real product/segment categories, not placeholder text.
- `campaign_name`: zero duplicates across 200 rows (not dictionary-required, checked anyway).
- `description`: 39/200 null (19.5%), populated values all 32-48 characters -- consistent, no anomaly.

## Status

The contract changes above are applied in `contracts.py`.
