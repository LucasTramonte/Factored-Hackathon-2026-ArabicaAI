# Silver Build

Turns raw `bronze.*` (all-VARCHAR, straight from S3) into typed, cleaned `silver.*` tables, driven
by what `profile_bronze.py` actually found in the data -- not the data dictionary, which this
project has already found wrong three times before this pipeline existed.

## What's implemented

All 13 Bronze tables now have a Silver spec:

| Table | What it demonstrates |
|---|---|
| `dim_customers` | plain dimension: string/date/double typing, country canonicalization, boolean parsing |
| `dim_branches` | + TIME casting, integer casting |
| `dim_products` | + currency conversion using the **latest available** FX rate (a snapshot row has no natural "as of" date) |
| `fact_transactions` | + currency conversion using the **exact-date** FX rate, and fills the 57.34% of `amount_usd` Bronze itself leaves null |
| `fact_campaign_sends` | + the literal `"nan"`-in-`subject` text bug fix |
| `dim_service_agents` | plain dimension: same pattern as `dim_branches` |
| `dim_marketing_campaigns` | plain dimension: the 200-row campaign catalog `fact_campaign_sends.campaign_id` joins against |
| `fact_call_center_interactions` | drops the Hive partition columns; `contact_reason`/`reason_category` carried through unchanged despite an apparent duplication (see note below) |
| `fact_call_transcripts` | text fields (`full_text`, etc.) passed through as-is, including unrendered template placeholders like `{monto}` -- not "fixed", since guessing real values would fabricate data |
| `fact_satisfaction_surveys` | `main_score` kept as a plain integer across three different survey scales (CSAT/NPS/CES) rather than normalized |
| `fact_complaints` | drops `origin_interaction_id` (100% null / 0 distinct in the Bronze profile) |
| `fact_digital_events` | same country-canonicalization fix as `transaction_country`, applied to `ip_country`; the largest table at 15.6M Bronze rows |

Plus `silver.dim_fx_rates` (typed `daily_exchange_rates`) and a `silver.v_fx_latest_to_usd` view
(the view stays unprefixed -- the `dim_`/`fact_` convention applies to base tables, not helper
views on top of them), built before anything that needs currency conversion.

**Naming convention**: every Silver table name is prefixed by its kind -- `dim_` for dimensions,
`fact_` for facts (`TableSpec.kind` in `table_specs.py` drives the prefix; see
`TableSpec.silver_table_name()` in `silver.py`). The unprefixed `name` field is still used
internally to look up the matching `bronze.<name>` source table and for the `--tables` CLI filter
-- only the actual `CREATE TABLE` target gets prefixed.

**Open question worth checking against real data**: `call_center_interactions.contact_reason` and
`.reason_category` showed byte-for-byte identical AGGREGATE distributions in the Bronze profile (6
categories, matching row counts). Both columns are carried through unchanged rather than assuming
one is a safe drop -- confirm with
`SELECT count(*) FROM silver.fact_call_center_interactions WHERE contact_reason <> reason_category`
(should return 0 if they really are duplicates) before dropping either one.

## Real bugs this fixes

Found by `profile_bronze.py` against the actual data, not assumed:

1. **`'México'` vs `'Mexico'`** counted as two different countries in `fact_transactions.transaction_country`
   (2.1M vs 40,515 rows) and `digital_events.ip_country` — `COUNTRY_CANONICAL` in `config.py` fixes this
   for every country-bearing column, not just those two.
2. **Literal `"nan"` baked into text**: `fact_campaign_sends.subject` has 38,142 rows reading
   `'¡Oferta especial en nan!'` — an unrendered NULL product name got string-formatted into a
   template upstream. `strip_templated_nan()` nulls these out via a word-boundary regex (verified
   against DuckDB directly — it does NOT misfire on a word that merely *contains* "nan", e.g. a
   hypothetical branch named "Nantucket").
3. **`amount_usd` null for 57.34% of transactions**: filled via `amount * that day's FX rate`
   whenever the source value is missing, with a companion `amount_usd_is_estimated` flag so
   downstream analysis can tell real vs. Silver-derived amounts apart rather than treating them as
   equally trustworthy.
4. **`TRY_CAST('NaN' AS DOUBLE)` succeeds** (DuckDB follows IEEE 754) **and `TRY_CAST('Infinity' AS DATE)` succeeds too** (becomes `9999-12-31`) — every cast in `transforms.py` runs through
   `null_like_guard()` first, which catches `'NaN'`, `'N/A'`, `'unknown'`, and a dozen other
   missing-value sentinels *before* casting, not after.
5. **Booleans stored as literal `'True'`/`'False'` text** — `as_boolean()` parses them properly,
   and anything unparseable becomes NULL (unknown), not `False` (a false negative would misrepresent
   real data, e.g. `is_fraud`).

## Design choices

- **Full rebuild every run, not incremental.** Bronze's incremental watermark logic exists to avoid
  re-reading S3 over the network on every run. Silver only touches the local `.duckdb` file — no
  network involved — and DuckDB is fast enough locally that rebuilding even the largest table
  (`digital_events`, 15.6M rows, once specced) from Bronze should take seconds, not minutes. Full
  rebuild is also simpler and can never drift from what Bronze currently holds. If this ever proves
  too slow in practice, the fix is a Silver-side watermark mirroring Bronze's — not a workaround
  here.
- **Declarative table specs** (`table_specs.py`), not hand-written SQL per table — same
  config-driven pattern as the bronze pipeline's `config.py` table lists, so adding the next table
  is "write a `TableSpec`", not "write a new script".
- **Defensive dedup** (`QUALIFY row_number() ... = 1` by primary key, latest `_ingested_at` wins) on
  every table, even though Bronze shouldn't produce duplicates in normal operation — cheap
  insurance against a bad re-ingestion.
- **Type-robust transforms**: every `transforms.py` function explicitly `CAST(... AS VARCHAR)`
  before doing text work, because the Bronze profile found a real BIGINT column (`year`, from Hive
  partition inference) despite Bronze being *designed* as all-VARCHAR — same fix already applied to
  `profile_bronze.py` after that crashed it once.

## Setup & running

No AWS credentials needed — Silver only reads/writes the local `.duckdb` file the bronze pipeline
already created.

```bash
python run_silver.py                          # build every specced table
python run_silver.py --tables customers,products   # unprefixed names -- matches TableSpec.name
python run_silver.py --log-level DEBUG
```

Exit code is `0` only if every *specced* table succeeded (`not_implemented` tables don't count as a
failure). Path resolution (`PROJECT_ROOT`/`DATA_DIR`/`DUCKDB_PATH` overrides) works exactly like
`data_pipelines/bronze/` and `profile_bronze.py` — same convention, same defaults, no extra setup.

## Testing

```bash
python -m pytest tests/ -v
```

13 tests, entirely in-memory against synthetic Bronze tables shaped like the real ones (same
columns, same all-VARCHAR-by-default reality, deliberately including the edge cases the profile
surfaced — mixed country spelling, `'nan'` sentinels, duplicate primary keys with different
`_ingested_at`, both FX-join modes). Covers, per table: country canonicalization, dedup,
boolean/time/integer casting, the latest-vs-exact-date FX distinction, the `amount_usd` fallback +
estimated flag, the `"nan"`-in-`subject` fix (including that it does NOT misfire on
"Nantucket"-style lookalikes), Hive-partition-column dropping, `origin_interaction_id` being
dropped from `complaints`, and `main_score` staying an integer in `satisfaction_surveys`.

Also verified end-to-end (not just via the unit-test layer): a full synthetic Bronze database with
all 13 tables run through the actual `run_silver.py` CLI, confirming every table lands under its
correct `dim_`/`fact_`-prefixed name with real transforms applied (country canonicalization,
column drops).

## What's still worth adding

- Confirm the `contact_reason`/`reason_category` duplication in `call_center_interactions` against
  the real (not synthetic) data — see the note above — before deciding whether to drop one.
- Row-count / null-rate sanity checks between Bronze and Silver (e.g. Silver row count should equal
  Bronze row count minus confirmed duplicates, not silently drift) — same category of gap the
  bronze pipeline's own README flags as not yet built.
- Time `fact_digital_events`'s full rebuild against the REAL 15.6M-row Bronze table (not the tiny
  synthetic one used here) to confirm the "local full rebuild is fast enough" assumption this
  README documents actually holds at that size.
- Consider whether `complaints.claimed_amount`/`compensation_granted` need USD conversion the same
  way `products`/`transactions` do — currently left as typed doubles in source currency (see the
  note in `table_specs.py`'s `complaints_spec`), since there's no clean "as of" date and `currency`
  is 67.54% null on this table.

All 13 Bronze tables now have Silver specs. New this round: `dim_service_agents`, `dim_marketing_campaigns`, `fact_call_center_interactions`, `fact_call_transcripts`, `fact_satisfaction_surveys`, `fact_complaints`, `fact_digital_events` — `run_silver.py` and `silver.py` didn't need any changes, since specs are the only thing that changed.

### A few judgment calls worth flagging, since they weren't purely mechanical:

- **`call_center_interactions.contact_reason` / `.reason_category`**: the profile showed identical aggregate distributions across both columns, but that's not proof they're row-for-row duplicates — I kept both rather than guess-dropping one, and left a query in the README to actually confirm it against real data.
- **`complaints.origin_interaction_id`**: dropped. It was 100% null / 0 distinct in the profile — genuinely no information to carry forward.
- **`call_transcripts` text fields**: left untouched, including unrendered template placeholders like `{monto}` in the raw transcript text — "fixing" that would mean fabricating data that isn't there.
- **`complaints.claimed_amount`/`compensation_granted`**: typed to double but not USD-converted (unlike products/transactions) — currency is 67.5% null here and there's no clean single date to join an FX rate against. Flagged in the README as something to revisit if USD comparability turns out to matter.

Verified two ways again: 13 unit tests pass (7 new, one per table, each exercising that table's distinctive behavior), and a full synthetic 13-table Bronze database run through the real CLI confirms every table lands correctly under its `dim_`/`fact_`-prefixed name with transforms actually applied — not just asserted in isolated tests.

One real gap worth timing before you trust it at scale: `fact_digital_events` is specced identically to the others, but I've only run it against a 1-row synthetic table. At 15.6M real Bronze rows it's the one table where the "local full rebuild is fast enough" assumption in `silver.py`'s docstring hasn't actually been tested — worth running for real and checking the timing once you have the full `.duckdb` file in hand.