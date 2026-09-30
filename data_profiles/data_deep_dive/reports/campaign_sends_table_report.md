# `campaign_sends` deep dive -- Bronze vs. Silver (13/13 -- last one)

Findings from `13_deep_dive_campaign_sends.ipynb`, run against the real production DuckDB (`bronze.campaign_sends` / `silver.fact_campaign_sends`, 1,746,801 rows).

## Headline -- the cleanest table in the whole series

No code-fix candidates this time. Every check that's flagged a real gap on the previous 12 tables came back clean here:

- **`contracts.py`'s `required` was already complete** -- all 9 dictionary-declared NOT NULL columns, confirmed 0 nulls in both Bronze and Silver.
- **The one known bug in this table, `subject`'s templated-`"nan"` text, is fully and cleanly fixed.** Section 7: exactly 38,142 Bronze rows had the literal broken text (`'¡Oferta especial en nan!'`), all 38,142 are `NULL` in Silver, zero still show the broken text, zero `"nan"` leaks through anywhere else, and the word-boundary regex has zero false positives (no legitimate subject merely containing "nan" as a substring got wrongly wiped). This is as clean a fix verification as this project gets.
- **The engagement funnel is perfectly consistent**: zero rows have `was_opened` without `was_delivered`, zero have `was_clicked` without `was_opened`, zero have `had_conversion` without `was_clicked`. `send_status` and `was_delivered` are also perfectly deterministic (`Sent` -> always `True`; `Blocked`/`Bounced`/`Failed` -> always `False`).
- **`click_count` is fully consistent with `was_clicked`**: always `NULL` when `False` (never `0`), always populated 1-5 when `True`.
- **Date sequencing is perfectly clean**: zero rows have `open_date` before `send_date`, `click_date` before `open_date`, or `conversion_date` before `click_date` -- unlike `complaints`' 492-row inversion in the last table.
- **Both FKs** (`campaign_id`, `customer_id`) resolve with zero orphans.
- **`open_country`'s canonicalization logic is in place** (same transform as `transaction_country`/`ip_country`), though this table's raw data happens not to have the México/Mexico spelling split those other tables did -- Bronze and Silver values are identical here, nothing to fix, nothing broken.

## Other findings (no action)

1. **Row count: 1,746,801 vs. the dictionary's declared 2,000,000** -- no duplicates, consistent with the established unreliable-dictionary-count pattern.

2. **`process_date` differs from `send_date`'s date part in 436,429/1,746,801 rows (24.98%)** -- same ~25% shape as `transactions`/`digital_events`'s confirmed-clean timezone-rollback artifact, not independently re-verified by hour-of-day here but consistent with that mechanism.

3. **512 rows have a `send_date` past the declared window end** (latest is 2026-06-18 05:59:53) -- same small-overshoot pattern seen in most other fact tables.

4. **`was_clicked` is declared nullable but is 100% populated in practice** (1,746,801/1,746,801, always `True` or `False`, never `NULL`) -- same recurring "nullable but actually always populated" pattern as `agent_id` in `call_center_interactions`, `interaction_id`/`agent_id` in `satisfaction_surveys`, etc. `was_opened`, by contrast, genuinely is null on 27.72% of delivered sends (open tracking not always available) -- worth the contrast since it shows the pipeline isn't defaulting every boolean, just this one.

5. Column count note: the table actually has **22 Bronze/Silver columns**, not 21 as I said going in -- my column count in the setup markdown was off by one (miscounted from the dictionary), but the notebook's own inventory check (section 1) used the correct, complete 22-column list and confirmed an exact match either way. No impact on any finding, just a correction for the record.

## Confirmed correct (no action)

- Column inventory: all 22 Silver columns present, types all correct.
- Dedup: 0 duplicate raw Bronze rows.
- NOT NULL audit: all 9 dictionary-declared columns clean.
- Domain checks: `send_channel` (Email, SMS, WhatsApp, Push, Voice) and `send_status` (Sent, Failed, Bounced, Blocked) both exact matches to the dictionary.
- `conversion_value`/`send_cost`: no negatives, ranges 100.88-4,999.75 and 0.0001-0.30.
- **Window check**: 0 rows before the declared window start.

## Next

No fixes to apply from this table. That's all 13 bronze/silver table pairs covered.
