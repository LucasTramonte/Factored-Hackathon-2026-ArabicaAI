# `call_transcripts` deep dive -- Bronze vs. Silver

Findings from `09_deep_dive_call_transcripts.ipynb`, run against the real production DuckDB (`bronze.call_transcripts` / `silver.fact_call_transcripts`, 171,321 rows).

## Real data-integrity issue -- `duration_seconds` is declared NOT NULL but 14.03% of rows are actually null

**Different from the usual "just add it to `required`" pattern**: `transcription_model` (also missing from `required`) is genuinely clean, but `duration_seconds` is not -- **24,029/171,321 rows (14.03%) have a NULL `duration_seconds` in both Bronze and Silver**, despite the dictionary declaring it NOT NULL. This isn't a cast problem (Silver's null count exactly matches Bronze's), and it isn't a data-integrity problem either -- section 9's cross-check shows that **whenever `duration_seconds` IS populated, it matches the parent `call_center_interactions` row's own `duration_seconds` exactly, 147,292/147,292 times, zero exceptions**. So the values that exist are trustworthy; the column is just genuinely, consistently under-populated relative to what the dictionary promises. Given the project's now-established pattern of the dictionary being wrong in specific, verifiable ways, this reads the same way: **don't add `duration_seconds` to `contracts.py`'s `required`** (it would immediately flag 24,029 real, currently-normal rows every run) -- document it as a known gap between the dictionary and the real data instead.

## Code fix candidates

**1. `transcription_model` is dictionary NOT NULL, confirmed 0 nulls (Bronze and Silver), and missing from `contracts.py`'s `required`.** Safe one-line addition (unlike `duration_seconds` above).

**2. Two domains, both confirmed clean:**

| Column | Real values | Matches dictionary? |
|---|---|---|
| `transcription_model` | AWS Transcribe (43,117), Whisper v3 (42,803), Google STT (42,740), Azure Speech (42,661) -- near-even 25/25/25/25 split | Dictionary only gave examples ("Whisper, Google STT, etc.") rather than a fixed list; real values are more specific (`Whisper v3`, not `Whisper`) and include two more vendors than the examples named |
| `audio_quality` | High, Medium, Low (+ 5.04% NULL, expected -- nullable) | Exact match |

Want me to add `transcription_model` to `required` and both domains?

## Other findings (no action)

1. **`full_text` and `agent_text` contain the known unrendered template placeholder in literally every row (100.00%), while `customer_text` never does (0.00%).** This sharpens `table_specs.py`'s comment, which described the issue in general terms -- it's not scattered across some rows, it's total and column-specific: the agent-facing/full transcript text is templated and never got its placeholders (`{monto}`, `{moneda}`, `{limite}`) filled in, while whatever generates `customer_text` doesn't have this bug at all. Worth passing along as a sharper root-cause description if this ever gets fixed upstream.

2. **`detected_language` has zero variation -- 100% `"es"`.** Same shape as `branches.geographic_zone` (100% "Urbana") and a few other single-value columns found earlier -- not a violation, just a column that currently carries no information.

3. **`mentioned_entities` remains 100% valid JSON across all 154,157 populated rows** (`json_valid()` never fails), and its embedded `"products"` field draws from the same real product-type domain seen in `products`/`marketing_campaigns` (`Cuenta Ahorro`, `Tarjeta Crédito`, etc., or `null`) -- consistent, no parsing surprises.

4. **`main_topics` reuses the same category labels as `call_center_interactions.reason_category`/`contact_reason`** (Comercial, Queja, Técnico, Producto, etc.) -- consistent naming across the two related fact tables, worth knowing if you ever build a topic-rollup that should treat these as the same taxonomy.

5. `customer_text`, `agent_text`, and `main_topics` are declared nullable but are 100% populated in practice -- same pattern already seen repeatedly (`agent_id`/`was_resolved`/`detected_sentiment` in `call_center_interactions`, etc.).

## Confirmed correct (no action)

- Column inventory: all 18 Silver columns present, types all correct.
- Dedup: 0 duplicate raw Bronze rows. Row count 171,321 vs. the dictionary's declared 200,000 -- consistent with the by-now-established pattern of unreliable dictionary row counts.
- NOT NULL audit: all columns clean except `duration_seconds` (see above).
- **All three FKs reproduced directly, zero orphans**: `interaction_id`, `customer_id`, `agent_id`.
- **Cross-table consistency (new check for this table): a transcript's `customer_id`/`agent_id` matches its parent interaction's own values 171,321/171,321 times, zero mismatches** -- real integrity between the two fact tables, not just a resolving FK.
- **`process_date` matches the parent interaction's `process_date` 171,321/171,321 times, zero differs** -- unlike `call_center_interactions`' own `process_date`/`interaction_date` pair (which had a real one-day rollback for a third of rows), this table's `process_date` is simply inherited from the interaction and carries no independent drift.
- `accent_confidence`: within the declared 0-1 range (real range 0.75-0.99), zero out-of-range values.
- `duration_seconds`: no negatives, range 30-1,151 seconds (for the 85.97% of rows where it's populated).
- **Window check**: zero rows before or after the declared 2023-06-17/2026-06-17 window on either edge -- the cleanest window result of any fact table checked so far.

## Next

Two code-fix candidates above (`transcription_model` required + 2 domains) -- let me know if you want them applied, then `satisfaction_surveys` (10/13).
