# `digital_events` deep dive -- Bronze vs. Silver

Findings from `11_deep_dive_digital_events.ipynb`, run against the real production DuckDB (`bronze.digital_events` / `silver.fact_digital_events`, 15,620,994 rows).

## Headline finding -- the dictionary is wrong by 56%, but `table_specs.py`'s own comment had the real number exactly right

Section 2 resolved the conflict flagged going in: the dictionary declares 10,000,000 rows; `table_specs.py`'s comment above `digital_events_spec` says "15.6M rows." **The real Bronze count is 15,620,994 -- `table_specs.py`'s comment is correct, and the dictionary is off by 5,620,994 rows (56% more data than declared).** In relative terms this is second only to `daily_exchange_rates` (3,000 declared vs. 13,164 real, +339%); `transactions` is about 11.5% off. Worth flagging that whoever wrote the `table_specs.py` comment had clearly already looked at the real data -- that comment is a more trustworthy source than the dictionary for this table specifically.

## Second finding -- the `process_date` rollback mechanism is now fully and cleanly confirmed

Section 10's hour-of-day cross-tab gives the cleanest possible confirmation of the timezone-offset theory first raised in `transactions`:

| hour_of_day | same_day | rolled_back |
|---|---|---|
| 0-5 | 0 | 100% rolled back every hour |
| 6 | 626,336 | 28,075 (boundary sliver) |
| 7-23 | 100% same_day every hour | 0 |

This is a textbook clean cutoff: every event generated between midnight and 6am gets `process_date` rolled back one day, every event from 7am onward doesn't, and hour 6 is the boundary that splits (95.7% same-day / 4.3% rolled-back within that single hour). 3,930,816/15,620,994 rows (25.16%) are affected overall -- same shape and same root cause as `transactions`' already-confirmed finding, just reproduced independently on a different table. This is not a defect, it's a consistent artifact of how `event_date` timestamps were generated relative to UTC. (Note: this doesn't explain `satisfaction_surveys`' much higher 79.5% rollback rate from the last table -- that one wasn't re-checked here and may have a different cause; flagging so it doesn't get assumed to be "the same thing" without verification.)

## Code fix candidates

**1. `is_mobile` is dictionary NOT NULL, confirmed 0 nulls (Bronze and Silver), and missing from `contracts.py`'s `required` tuple.** Safe one-line addition. Section 8 also confirms it's a clean, deterministic function of `channel` (Android App/iOS App/Mobile Web -> `True`, Desktop Web -> `False`, zero exceptions across all 15.6M rows) -- so the column is trustworthy, not just present.

**2. Four domains, all confirmed clean:**

| Column | Real values | Matches dictionary? |
|---|---|---|
| `event_type` | PageView, Click, Login, Logout, FormSubmit, Error, **Purchase** | Dictionary text was truncated in the PDF ("PageView, Click, FormSubmit, Login, Logout, Error, ...") -- real data has one more value than the visible list, `Purchase` |
| `event_category` | Authentication, Navigation, Product, Transaction | Exact match (dictionary text was also truncated but the 4 real values match the 4 visible ones) |
| `channel` | Android App, iOS App, Desktop Web, Mobile Web | Exact match |
| `platform` | Android, iOS, Windows, Linux, MacOS (+ 5.00% NULL, expected -- nullable) | Exact match |

**Contract change applied** (`contracts.py`): `is_mobile` is required, and `channel`, `event_category`, `event_type` and `platform` are gated domains.

## Other findings (no action)

1. **Row count is the headline finding above -- 15,620,994 vs. dictionary's declared 10,000,000.** No duplicate raw Bronze rows.

2. **`ip_country` canonicalization confirmed working correctly, same fix pattern as `transactions.transaction_country`**: Bronze has the same `México`/`Mexico` spelling split (6,242,893 + 1,038,174 = 7,281,067 raw rows), and Silver correctly merges both into a single canonical `México` (7,281,067 -- exact match). No fix needed here, this is Silver logic already working as intended; just confirming it directly rather than assuming it carried over from `transactions`.

3. **UTM columns don't populate strictly all-or-nothing.** Of the 839,045/839,134/838,917 rows with any UTM field populated (~5.4% of the table, consistent with digital events mostly being organic traffic), only 757,411 have all three fields, while **125,565 rows have a partial set** (missing one or two of `utm_source`/`utm_medium`/`utm_campaign` despite having at least one populated). Not a violation -- none of the three is dictionary NOT NULL -- but worth knowing if any downstream campaign-attribution logic assumes all three always arrive together.

4. **`session_id` cardinality looks clean and tightly bounded**: 1,837,415 distinct sessions across 15,620,994 events, averaging 8.5 events/session (min 2, median 9, max 15) -- no runaway outlier session dominating the table.

5. **2,060 rows have an `event_date` past the declared 2026-06-17 window end** (latest is 2026-06-18 06:04:05) -- same small-overshoot pattern seen in `call_center_interactions` (175 rows) and `satisfaction_surveys` (153 rows), just proportionally larger here given the table's size (still only 0.013% of rows). No rows before the window start.

6. **`ip_address` is a valid-looking IPv4 in 100% of the 14,840,139 populated rows** (simple regex check, no malformed values). `page_url`/`element_id`/`action` all line up sensibly in the sample (e.g. `/payments` -> `payment_form` -> `initiate_payment`) -- consistent, well-formed synthetic generation, no format concerns.

## Confirmed correct (no action)

- Column inventory: all 25 Silver columns present, types all correct (`event_value`/`duration_seconds` -> DOUBLE, `is_mobile` -> BOOLEAN, dates typed correctly).
- Dedup: 0 duplicate raw Bronze rows.
- NOT NULL audit: all 8 dictionary-declared columns clean, zero nulls in Bronze or Silver (including `is_mobile`, see fix candidate above).
- **Both FKs reproduced directly, zero orphans**: `customer_id` (11,875,548/11,875,548 populated) and `product_id` (1,440,338/1,440,338 populated).
- **`is_mobile`/`channel` relationship is fully deterministic**, zero exceptions.
- Nullable-column population rates all match cleanly between Bronze and Silver, no cast-introduced drift anywhere across all 17 nullable columns.
- `event_value`/`duration_seconds`: no negatives, ranges 10.01-4,999.98 and 5.0-300.0.
- **Window check**: zero rows before the declared window start.

## Status

The contract changes above are applied in `contracts.py`.
