# Findings from the bronze profile results
The `year` BIGINT thing turns out to be systematic, not a one-off: it shows up on **every fact table** (all 7), while `day`/`month` stay VARCHAR. That's explainable and harmless — DuckDB's Hive-partition type inference keeps `day='01'`/`month='01'` as text to preserve the leading zero, but infers `year=2024` as BIGINT since there's no ambiguity. Not a data-quality issue, just a partition-column type quirk your Silver layer should just `CAST(... AS VARCHAR)` or `AS INTEGER` explicitly rather than assume.

Past that, a few things in this profile are genuinely new and worth designing Silver rules around:

**Real findings**

| Finding | Where | Why it matters |
|---|---|---|
| Country spelling split across accented/unaccented AND extra countries | `transactions.transaction_country`: 'México' (2.1M) vs **'Mexico'** (40,515) counted separately, plus USA/Spain/Brazil showing up (cross-border transactions); `digital_events.ip_country` same accented/unaccented split (6.2M vs 1.0M); `marketing_campaigns.target_country` only has unaccented 'Mexico' | This silently splits one country into two groups in any GROUP BY — same class of bug as the earlier `customers.country` accent issue, but this time it's *inside* the fact tables themselves, and the country set isn't just 3 anymore |
| Literal `"nan"` baked into a business string | `campaign_sends.subject`: `'¡Oferta especial en nan!'` (38,142 rows) | A NULL product name got string-formatted into a template upstream. The null-like sentinel check catches *standalone* `'nan'` values but not this — it's a substring inside otherwise-valid text, so it needs its own targeted Silver rule (e.g. regex/LIKE match) |
| Fully empty column | `complaints.origin_interaction_id`: 100% null, 0 distinct values | Dead column — candidate to drop in Silver rather than carry forward |
| Likely-duplicate columns | `call_center_interactions.contact_reason` and `.reason_category` have byte-for-byte identical value distributions | Worth checking whether these are truly redundant before deciding to keep both |
| Future-dated timestamps | `customers.last_updated` sample includes `'2027-04-08'`, `'2026-06-12'` | Dataset otherwise runs through 2026-06-17 — a `2027` value is either a real future-scheduled update or a data-generation artifact; worth a min/max check before trusting it |
| Booleans stored as text | `has_atms`, `was_resolved`, `is_fraud`, etc. (all `'True'`/`'False'` strings) | Straightforward Silver rule: cast this whole family to real BOOLEAN |
| Multi-value field | `service_agents.languages`: `'español, inglés, portugués'` | Comma-separated — needs unnesting/flagging if you ever want to filter/join on individual languages |
| Currency still needs conversion | `products.currency`, `transactions.currency`, `complaints.currency` (3-4 distinct currencies each) | Confirms the FX-join pattern from `customer_analytics.ipynb` needs to live in Silver as a first-class step, not a per-notebook fix |
| `amount_usd` still 57.34% null | `transactions.amount_usd` | Same open item as before — Silver needs to decide: keep the FX-fallback join, or compute `amount_usd` itself in Silver from `amount` + `currency` + `daily_exchange_rates` rather than trusting the source column |

Everything else looks clean: postal codes are only 70-80% numeric because Latin American formats mix alphanumeric and numeric (expected, keep as VARCHAR), `document_number` similarly (DNI/CC vs. passport formats), and every real date/timestamp column parses at 100% where populated — so date casting in Silver should be simple.