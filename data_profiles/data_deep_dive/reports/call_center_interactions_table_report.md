# `call_center_interactions` deep dive -- Bronze vs. Silver

Findings from `08_deep_dive_call_center_interactions.ipynb`, run against the real production DuckDB (`bronze.call_center_interactions` / `silver.fact_call_center_interactions`, 686,296 rows).

## Headline finding -- `table_specs.py`'s open question is resolved: `contact_reason` and `reason_category` really are the same value stored twice

**Confirmed: `SELECT count(*) ... WHERE contact_reason <> reason_category` returns 0 across all 686,296 rows.** The code comment above the spec flagged this as "strong evidence but unconfirmed at the row level" -- it's now fully confirmed. Every single row has identical values in both columns (both hold the same 6 Spanish categories: Transaccional, Producto, Queja, Técnico, Comercial, Retención). This isn't a code fix by itself (both columns are still faithfully carried through from Bronze, which is correct -- Silver shouldn't invent data by dropping one), but it's worth flagging back to whoever owns `table_specs.py`: this is now a settled fact, not an open question, and a future pipeline change could reasonably drop one of the two columns as genuinely redundant if that's ever a design goal.

## Code fix candidates

**1. `has_recording` is dictionary NOT NULL (confirmed 0 nulls, Bronze and Silver) but missing from `contracts.py`'s `required` tuple.** One-line addition.

**2. Three domains, all confirmed clean (note the two Spanish/English drifts, same class of issue as `document_type`/`product_type`/`geographic_zone` before):**

| Column | Real values | Matches dictionary? |
|---|---|---|
| `interaction_type` | Inbound Call, Outbound Call, Chat, Email, Video | Exact match |
| `reason_category` (and `contact_reason`, identical) | Transaccional, Producto, Queja, Técnico, Comercial, Retención | **Spanish**, not the dictionary's English labels |
| `detected_sentiment` | Neutral, Negativo, Positivo, Muy Negativo, Muy Positivo | **Spanish**, not the dictionary's English labels (Positive/Neutral/Negative/Very Negative) |

`channel` was already gated in `contracts.py` with 6 values including an extra `Web` beyond the dictionary's declared 5 -- **re-verified as still fully accurate**, no fix needed there.

**Contract change applied** (`contracts.py`): `has_recording` is required, and `interaction_type`, `reason_category` and `detected_sentiment` are gated domains with the real Spanish values.

## Other findings (no action)

1. **Row count: 686,296 vs. the dictionary's declared 800,000** -- no duplicates, consistent with the established pattern of unreliable dictionary row counts (`daily_exchange_rates`, `transactions`).

2. **`sentiment_score` maps to `detected_sentiment` in clean, non-overlapping buckets**: Muy Positivo (0.7 to 1.0), Positivo (0.3 to 0.7), Neutral (-0.3 to 0.3), Negativo (-0.7 to -0.3), Muy Negativo (-1.0 to -0.7). This looks like a deterministic derivation (score bucketed into a label) rather than two independently-generated fields -- consistent and worth knowing, not a defect.

3. **`was_resolved`/`requires_followup` cross-tab has no (False, False) combination at all** -- every unresolved interaction requires a follow-up (160,266 rows), while resolved interactions split between needing one anyway (78,788) or not (447,242). Clean operational logic, no unresolved-and-no-followup-needed case exists in the data.

4. **`agent_id` is declared nullable (not every interaction needs an assigned agent) but is actually 100% populated** (686,296/686,296) -- same shape as `was_resolved`/`detected_sentiment`/`sentiment_score`, all declared nullable but never actually null in this table. Not a violation, just worth knowing these fields behave as if required in practice.

5. **`customer_detected_accent` and `agent_used_accent` share the exact same NULL count (204,750, 29.83% each)** -- worth knowing they're likely null together on the same rows (not independently missing), though not confirmed row-by-row here.

6. **`process_date` rolls back one day for 228,318/686,296 rows (33.3%)**, and 175 rows fall slightly past the declared window (latest `interaction_date` 2026-06-18 07:58:13). Same shape of finding as `transactions`' `process_date`/`transaction_date` timezone artifact -- not re-verified against hour-of-day here, but consistent with that same explanation.

## Confirmed correct (no action)

- Column inventory: all 21 Silver columns present, types all correct.
- Dedup: 0 duplicate raw Bronze rows.
- NOT NULL audit: all 12 dictionary-declared columns, zero nulls in Bronze or Silver.
- **Both FKs reproduced directly, zero orphans**: `customer_id` (686,296/686,296) and `agent_id` (686,296/686,296, fully populated despite being a nullable FK).
- `duration_seconds`/`wait_time_seconds`: no negatives, ranges 30-1,204s and 0-424s.
- `sentiment_score`: exactly within the declared -1 to 1 range, zero out-of-range values.
- `mentioned_products`: 39.97% populated, consistent comma-separated `PRD-XXXXXXXXXXXX` format throughout the sample.

## Status

The contract changes above are applied in `contracts.py`.
