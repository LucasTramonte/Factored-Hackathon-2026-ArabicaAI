# `satisfaction_surveys` deep dive -- Bronze vs. Silver

Findings from `10_deep_dive_satisfaction_surveys.ipynb`, run against the real production DuckDB (`bronze.satisfaction_surveys` / `silver.fact_satisfaction_surveys`, 212,759 rows).

## Headline finding -- neither the dictionary's nor `table_specs.py`'s description of `main_score` is quite right

Section 7's per-`survey_type` breakdown:

| survey_type | n | real min | real max | distinct values |
|---|---|---|---|---|
| CSAT | 127,856 | 1 | 4 | 4 (1,2,3,4) |
| NPS | 63,668 | 2 | 7 | 6 (2,3,4,5,6,7) |
| CES | 21,235 | 1 | 4 | 4 (1,2,3,4) |

- The **dictionary's** per-type ranges ("1-5 for CSAT, 0-10 for NPS") are both wrong: CSAT never reaches 5 (tops out at 4), and NPS never gets close to 0-10 (real range is 2-7).
- **`table_specs.py`'s "1-7 integer scale spanning CSAT/NPS/CES"** is technically true only in the union sense -- the overall column does span 1 to 7 once you combine all three survey types (CSAT/CES top out at 4, NPS reaches up to 7) -- but it's misleading as a per-type description, since no single survey type actually uses the full 1-7 range.

**Best description of reality**: `main_score` is on a 1-4 scale for CSAT and CES, and a 2-7 scale for NPS. No code fix follows from this (there's no `required`/domain gap -- `main_score` is already required and it's a numeric range, not an enum), but it's worth correcting the mental model if `table_specs.py`'s comment is ever cleaned up.

## Second finding -- `nps_category` never contains "Promoter" in real data

Bronze's domain (section 5): `Detractor` (45,007), `Passive` (15,387), and **no `Promoter` rows at all** -- only 2 of the dictionary's declared 3 categories appear in the data.

Section 8 explains why, cross-checked against `main_score`:

| nps_category | min_score | max_score | n |
|---|---|---|---|
| Detractor | 2 | 6 | 45,007 |
| Passive | 7 | 7 | 15,387 |

Standard NPS bucketing is Promoter 9-10 / Passive 7-8 / Detractor 0-6. Here the real NPS score only ever reaches 7 (see headline finding above), so every row that would need an 8-10 score to earn "Promoter" simply doesn't exist -- **the ceiling on `main_score` for NPS surveys structurally prevents `nps_category` from ever being "Promoter."** The category logic itself is internally consistent (score 7 -> Passive, 2-6 -> Detractor, matches the boundary exactly), it's just that the underlying score never gets high enough to produce the top bucket. Not a code-quality issue in this pipeline -- it's a property of the source data -- but worth flagging since a dashboard or model that expects to see "Promoter" values will never get any.

## Code fix candidates

**1. `send_channel` is dictionary NOT NULL, confirmed 0 nulls (Bronze and Silver), and missing from `contracts.py`'s `required` tuple.** Safe one-line addition.

**2. Three domains, all confirmed clean:**

| Column | Real values | Matches dictionary? |
|---|---|---|
| `survey_type` | CSAT, NPS, CES | Exact match |
| `send_channel` | Email, SMS, App, IVR, Web | Exact match |
| `comment_sentiment` | Positive, Neutral, Negative (+ 52.41% NULL, expected -- nullable) | Exact match -- **English this time**, unlike `call_center_interactions.detected_sentiment` which was Spanish |

`nps_category`'s domain is trickier: real data only ever produces `Detractor`/`Passive` (see finding above), but the dictionary declares `Promoter` too, and it's a legitimate value the source *could* produce if the score ceiling ever changes. Recommend gating on the full dictionary set `{"Promoter", "Passive", "Detractor"}` rather than the narrower observed set, so the contract doesn't have to change if `Promoter` ever shows up.

Want me to add `send_channel` to `required` and all four domains?

## Other findings (no action)

1. **Row count: 212,759 vs. the dictionary's declared 250,000** -- no duplicates, consistent with the established pattern of unreliable dictionary row counts.

2. **`process_date` differs from `survey_date`'s date part in 169,092/212,759 rows (79.5%)** -- notably higher than the rollback rate seen in `transactions` (25%) or `call_center_interactions` (33.3%). Not re-verified against hour-of-day here (that follow-up wasn't run this round), so I can't confirm it's the same timezone-boundary artifact rather than a genuinely different generation pattern (e.g. surveys processed in a batch some time after the survey date). Worth a closer look if this table ever needs precise date-based partitioning logic, but no code-fix implication as-is.

3. **153 rows have a `survey_date` after the declared window end** (latest is 2026-06-19 06:54:58 vs. the declared 2026-06-17 cutoff) -- same small overshoot pattern seen in `call_center_interactions` (175 rows). No rows before the window start.

4. **`interaction_id` and `agent_id` are both declared nullable FKs but are 100% populated in practice** (212,759/212,759 each) -- same recurring pattern as `agent_id`/`was_resolved`/`detected_sentiment` in `call_center_interactions` and `customer_text`/`agent_text`/`main_topics` in `call_transcripts`.

5. **`response_time_hours`** ranges 1.01-35.97 (no negatives) and **`campaign_response_rate`** ranges 15.0-45.0 (within a sane 0-100 bound) -- both clean, no dictionary range was declared to check against precisely, but nothing looks broken.

## Confirmed correct (no action)

- Column inventory: all 19 Silver columns present, types all correct.
- Dedup: 0 duplicate raw Bronze rows.
- NOT NULL audit: all 7 dictionary-declared columns clean, zero nulls in Bronze or Silver (including `send_channel`, see fix candidate above).
- **All three FKs reproduced directly, zero orphans**: `interaction_id` (212,759/212,759), `customer_id` (212,759/212,759), `agent_id` (212,759/212,759).
- **Cross-table consistency: a survey's `customer_id`/`agent_id` matches its parent interaction's own values 212,759/212,759 times, zero mismatches**, when `interaction_id` is populated (which is always, per finding 4 above).
- `question_1_response`/`question_2_response`/`question_3_response`: all within the declared 1-5 range, zero out-of-range values.
- Nullable-column population rates all match cleanly between Bronze and Silver (no cast-introduced drift anywhere).

## Next

Two code-fix candidates above (`send_channel` required + 4 domains, including the `nps_category` union-set recommendation) -- let me know if you want them applied.

That's all 10 tables with dictionary-declared row counts checked so far (still `digital_events`, `complaints`, `campaign_sends` to go). As promised, here's the full running list of pending code fixes across all tables checked so far that haven't been applied yet:

### Pending fixes -- `daily_exchange_rates`
- Add domain `source_currency`/`target_currency` in `{"MXN","COP","ARS","USD"}` (confirmed 100% clean).

### Pending fixes -- `call_center_interactions`
- Add `has_recording` to `required` (confirmed 0 nulls).
- Add domains: `interaction_type` {Inbound Call, Outbound Call, Chat, Email, Video}; `reason_category` {Transaccional, Producto, Queja, Técnico, Comercial, Retención} (Spanish real values -- also covers `contact_reason`, confirmed byte-identical); `detected_sentiment` {Neutral, Negativo, Positivo, Muy Negativo, Muy Positivo} (Spanish real values).

### Pending fixes -- `call_transcripts`
- Add `transcription_model` to `required` (confirmed 0 nulls). **Explicitly do NOT add `duration_seconds`** -- it's dictionary NOT NULL but has a real 14.03% null rate; adding it would create false violations every run.
- Add domains: `transcription_model` {AWS Transcribe, Whisper v3, Google STT, Azure Speech}; `audio_quality` {High, Medium, Low}.

### Pending fixes -- `satisfaction_surveys` (this table)
- Add `send_channel` to `required` (confirmed 0 nulls).
- Add domains: `survey_type` {CSAT, NPS, CES}; `send_channel` {Email, SMS, App, IVR, Web}; `comment_sentiment` {Positive, Neutral, Negative}; `nps_category` {Promoter, Passive, Detractor} (full dictionary set, even though `Promoter` never appears in current data -- see finding above).

Say the word (all of them, or pick which tables) and I'll apply them to `contracts.py` and run the test suite.
