# `daily_exchange_rates` deep dive -- Bronze vs. Silver

Findings from `06_deep_dive_daily_exchange_rates.ipynb`, run against the real production DuckDB (`bronze.daily_exchange_rates` / `silver.dim_fx_rates`, 13,164 rows). Pipeline-wise this is the cleanest table yet -- every mechanical check (rename, dedup, NOT NULL, cast, rate ordering, coverage, the derived view) came back perfect. The one real finding is a big documentation error, not a pipeline bug.

## Headline finding -- the dictionary's declared row count is wrong by 4.4x

**Dictionary declares 3,000 rows. Real Bronze has 13,164, and it's not a duplication artifact** -- 13,164 distinct `(date, source_currency, target_currency)` keys, zero dupes. The real shape is fully explained by the data itself: **1,097 distinct dates × 12 ordered currency pairs = 13,164 exactly.** 1,097 days is precisely the dataset's 3-year window (2023-06-17 to 2026-06-17 inclusive), and 12 is every ordered pair among the 4 declared currencies excluding same-to-same (4 x 3 = 12) -- i.e. this table is a **complete daily matrix**, not a sparse sample. Every currency pair has exactly 1,097/1,097 days covered, no gaps anywhere (section 7's coverage check).

This isn't a pipeline defect -- Silver's row count matches Bronze's distinct-key count exactly, so the pipeline is faithfully carrying through whatever is in Bronze. It's the data dictionary's stated row count that's stale or wrong. Worth flagging back to whoever maintains the dictionary/dataset-generation docs; nothing to fix in code, since `contracts.py` doesn't hardcode the dictionary's row count anywhere.

## Code fix candidate -- currency domain, confirmed clean

**`source_currency`/`target_currency` only ever take the 4 declared values (MXN, COP, ARS, USD), in every one of the 12 valid ordered pairs, with zero same-to-same rows.** Not currently gated in `contracts.py`. Same "free to add, already clean" reasoning as the domain additions on `marketing_campaigns`/`service_agents`/`branches`. Want me to add it?

## Other findings (no action)

1. **`buy_rate`, `sell_rate`, and `rate_source` (`source` in Bronze) are 100% populated** (13,164/13,164 each), even though the dictionary marks all three nullable (no `NOT NULL`). Not a violation -- just informational: this reference table apparently never actually omits them in practice, unlike the genuinely-nullable fields seen in other tables.

2. **Rate ordering is perfectly consistent everywhere**: `buy_rate <= exchange_rate <= sell_rate` holds for all 13,164 rows, zero exceptions. This is a 3-column relationship the current framework has no generic way to express (it's not a domain, FK, or uniqueness check) -- worth keeping in mind as a *potential* future framework capability if a similar ordering constraint turns up in a later table, but not proposing a new check machinery for a single already-clean table.

## Confirmed correct (no action)

- **Rename mapping**: `bronze.date` -> `silver.rate_date`, `bronze.source` -> `silver.rate_source` both applied correctly; every other column keeps its name. Column inventory: no missing, no extra columns.
- **Composite-key dedup**: 0 raw Bronze rows share a `(date, source_currency, target_currency)` key -- nothing for the `QUALIFY` dedup to actually collapse in this data, but it's a correct no-op.
- NOT NULL audit: all 4 declared-required columns (`date`/`source_currency`/`target_currency`/`exchange_rate`), zero nulls in Bronze or Silver.
- Cast correctness: `rate_date` -> `DATE`, `exchange_rate`/`buy_rate`/`sell_rate` -> `DOUBLE`, all correct, zero non-positive rates. Per-pair magnitudes look like plausible real-world FX rates (e.g. USD->COP averaging ~3,997, MXN->USD averaging ~0.059).
- Date window: zero rows before or after the declared 2023-06-17 to 2026-06-17 window -- the *first* table so far with perfect window containment on both edges.
- **`silver.v_fx_latest_to_usd` reproduces exactly by hand** -- the view's logic (latest rate per source currency, restricted to `target_currency = 'USD'`) matches a from-scratch reconstruction row for row. All 3 non-USD currencies (ARS, COP, MXN) have a path to USD; no silent gaps for anything downstream (like `products`) that joins against it.

## Next

One code-fix candidate above (currency domain) -- let me know if you want it applied, then `transactions` (7/13).
