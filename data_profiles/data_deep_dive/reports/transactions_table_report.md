# `transactions` deep dive -- Bronze vs. Silver

Findings from `07_deep_dive_transactions.ipynb`, run against the real production DuckDB (`bronze.transactions` / `silver.fact_transactions`, 4,425,008 rows). First fact table, first table over a million rows, and the most logic-heavy Silver build checked so far (the `amount_usd` fallback + `amount_usd_is_estimated` flag). Two follow-up investigations included below, both resolved with a confirmed root cause rather than left as a guess.

## Follow-up finding 1 -- `currency` never includes MXN, traced all the way back to `products`

**Root cause confirmed, not a `transactions` bug.** `currency` only ever takes 3 of the 4 declared values (USD, COP, ARS) across all 4.4M rows. The investigation:

1. **`transaction_country` vs. `currency` shows no clean mapping** -- every country (including México) has a mix of all 3 currencies, just heavily skewed toward one (México: 99.07% USD, Argentina: 90.5% ARS, Colombia: 92.9% COP).
2. **`currency` always equals the owning product's own `currency`, with zero exceptions** -- joining `transactions` to `dim_products` shows only 3 possible pairs (ARS-ARS, COP-COP, USD-USD), never a mismatch. So a transaction's currency isn't independently chosen; it's fully inherited from its product.
3. **`dim_products` itself has zero MXN-currency products** -- 400,000/400,000 products split exactly across USD (220,501), COP (107,975), and ARS (71,524). No MXN anywhere.

**Conclusion: MXN was never generated as a product currency anywhere in the dataset, so it can never appear in a transaction either.** This isn't a `transactions`-pipeline defect -- it's a data-generation gap that traces back to `products`, and the `products` deep dive (table 2/13) didn't check `currency`'s domain at the time, so this is a gap in that earlier pass, not a new bug. Nothing to fix in the `transactions` contract; if anything, worth revisiting `products`' `currency` domain note. Not proposing a code fix here since narrowing `currency`'s domain to exclude MXN would bake in a real limitation of the *data*, not the pipeline, and MXN is still a dictionary-valid value that could appear in a future data refresh.

## Follow-up finding 2 -- 25% of rows have `process_date` one day behind `transaction_date`, confirmed as a clean time-of-day artifact

**Confirmed, not random.** Every one of the 1,106,307 "rolled-back" rows has `transaction_date`'s hour between 0 and 6; every "matches" row has hour 6 or later (with a 51-row sliver exactly at hour 6 landing on the rolled-back side -- a boundary artifact, not noise). This is a clean, near-total split at hour 6, consistent with `process_date` being computed using a UTC-6-ish offset (matching México, the dataset's westernmost of the three countries) against a `transaction_date` that's otherwise stored as raw local wall-clock time. Practical consequence: any report joining on `process_date` as if it always equals `CAST(transaction_date AS DATE)` will misattribute ~25% of transactions to the wrong calendar day for early-morning activity. Not a pipeline bug (Silver types both columns correctly and doesn't invent this gap -- it's already present as authored), just a real behavior worth documenting for anyone building daily reports off this table.

## Code fix candidates

**1. `transaction_country` is dictionary NOT NULL (confirmed 0 nulls, Bronze and Silver) but missing from `contracts.py`'s `required` tuple.** One-line addition.

**2. Four domains, all confirmed clean except one naming drift:**

| Column | Real values | Matches dictionary? |
|---|---|---|
| `transaction_category` | Food, Services, Other, Transport, Entertainment, Health (+ 60.9% NULL, expected -- nullable field) | Exact match |
| `channel` | POS, ATM, Web, App, Branch, Transfer | Exact match |
| `transaction_status` | Approved, Declined, Pending, Reversed | Exact match |
| `transaction_type` | Purchase, Withdrawal, Transfer, Payment, Deposit, **Adjustment** | **Drift**: dictionary declares `Advance`, real data has `Adjustment` instead. Same class of issue as `campaign_type`/`product_type` drift seen earlier -- if gating this domain, the real value (`Adjustment`) needs to be used, not the dictionary's stated one. |

Want me to add `transaction_country` to `required` and all four domains (using the real `transaction_type` values)?

## Other findings (no action)

1. **Row count: 4,425,008 vs. the dictionary's declared 5,000,000** -- no duplicates, so not a dedup issue. Fits the same pattern already seen in `daily_exchange_rates` (dictionary row counts aren't reliable) -- `table_specs.py`'s own docstring already flags the dictionary as "found wrong three times before this pipeline existed," so this is consistent with that, not a new concern.

2. **1,352 rows (0.03%) fall slightly past the declared window end**, latest `transaction_date` being 2026-06-18 05:59:41 vs. the window's stated 2026-06-17 cutoff -- same minor overshoot pattern seen in `marketing_campaigns`' `end_date`. This also fully explains the 35 residual `amount_usd` nulls in finding 3 below (those rows fall on 2026-06-18, one day past `dim_fx_rates`' own coverage).

3. **`latitude`/`longitude` show the same near-(0,0) corruption pattern found in `branches`, but at much smaller scale**: 16,481/814,415 populated rows (2.02%) vs. `branches`' 47.7%. Worth knowing this isn't isolated to `branches` -- it may be a shared quirk of however this synthetic dataset generates coordinates -- but at 2% here it's a much smaller share of an already-sparse column (only 19.37% of rows have coordinates at all).

4. **`fraud_score`/`is_fraud` show a mostly clean signal separation**: non-fraud transactions never exceed a score of 30.00, while flagged-fraud transactions average 49.46 (range 0.01-99.99). There's some low-end overlap (a fraud=True transaction can score as low as 0.01), which is expected for a risk *score* rather than a deterministic rule -- not a violation.

## Confirmed correct (no action)

- Column inventory: all 22 Silver columns present (21 typed + the derived `amount_usd_is_estimated`), types all correct.
- Dedup: 0 duplicate raw Bronze rows.
- NOT NULL audit: all 12 dictionary-declared columns, zero nulls in Bronze or Silver, zero cast-introduced nulls.
- **All three FKs reproduced directly, zero orphans**: `customer_id` (4,425,008/4,425,008), `product_id` (4,425,008/4,425,008), `branch_id` (1,387,932/1,387,932 populated) -- the cleanest FK result of any table checked so far, closing the loop on the earlier claim that `transactions.branch_id` resolves perfectly.
- `amount`: no negatives, no zeros, range $5.00-$39,999,828.48.
- **`amount_usd` fallback**: Bronze's documented 57.34% null rate confirmed exactly against live data (2,537,456/4,425,008). Silver's fallback fills all but 35 rows (0.00%), and those 35 are fully explained (see finding 2 above).
- **`amount_usd_is_estimated`**: reproduced by hand from the raw Bronze + FX join logic, **zero mismatches against all 4,425,008 rows**. 2.25% of transactions are USD-fallback-estimated.
- `transaction_country`: full canonicalization coverage ("Mexico" -> "México"). Also confirms ~2.75% of transactions occur in USA/Spain/Brazil -- outside the three core countries, plausible for cross-border activity, not an error.
- `merchant_name`/`merchant_category`: populate exclusively for `transaction_type = 'Purchase'` (95% of Purchase rows, 0% of every other type) -- clean logical consistency, not scattered.
- `response_code`: mostly "00" (approved), consistent with the 95% population rate and the transaction_status mix.

## Next

Two code-fix candidates above (`transaction_country` required + 4 domains) -- let me know if you want them applied, then `call_center_interactions` (8/13).
