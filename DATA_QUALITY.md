# Data quality and findings register

This is the team's single list of what we learned about the supplied LATAM Bank dataset that changes, limits or supports a decision. The automated gate in [`data_pipelines/quality/`](data_pipelines/quality/README.md) checks every build for readiness (tables, row counts, keys, domains, links). This register records what those checks and targeted queries *mean*: the evidence, the impact on metrics and on the intake service, and how each finding is handled.

Every number here comes from a query in [`data_profiles/findings/queries/`](data_profiles/findings/queries/) run by `make findings` on the full Silver build (quality run `20260929T113804Z`, ready, 0 errors) on 2026-09-29. DF-016 to DF-018 were added on 2026-09-30 from the same build (findings run `20260930T033230Z`), and DF-019 later that day (findings run `20260930T192858Z`). Results are aggregates only. The dataset is synthetic (dataset summary, p. 5), so "unrealistic" below means unlike a real bank, not wrong in the file.

## How to read it

- **Scope** says which rows a query may read ([ADR-005](Docs/ADRs/ADR-005-evaluation-data-protocol.md)):
  - `design` queries see only business timestamps before **2026-01-01**. Their results can inform the design of prompts, fixtures, thresholds and any learned component.
  - `full` queries check structural properties (schema, links, domains) over every row. They are not fitted to anything and apply the same way to every period.
  - Holdout rows (2026-01-01 → 2026-06-18) are never used to design anything.
- **Severity:**
  - *High*: blocks or changes a metric or a product decision.
  - *Medium*: limits a claim or forces an explicit assumption.
  - *Low*: informational.
- **Status:**
  - *Open*: the cause is unconfirmed or the handling is undecided.
  - *Handled in Silver*: fixed by a Silver transformation.
  - *Handled at metric level*: the data stays as it is, and metrics exclude or suppress it.
  - *Accepted limitation*: it can't be fixed with this data, and we state it wherever it matters.

## Summary

| ID | Finding | Scope | Severity | Status | Owner |
|---|---|---|---|---|---|
| [DF-001](#df-001-source-text-fields-are-fixed-templates) | Source text fields are fixed templates | full | High | Accepted limitation | Lucas |
| [DF-002](#df-002-complaint-product-links-point-to-other-customers) | Complaint product links point to other customers | full | High | Handled at metric level | Manoella |
| [DF-003](#df-003-claimed-amounts-are-not-linked-to-transactions) | Claimed amounts are not linked to transactions | full | High | Accepted limitation | Lucas |
| [DF-004](#df-004-processing-partition-precedes-the-event-date-for-early-hour-events) | Processing partition precedes the event date for early-hour events | design | Medium | Open | Manoella |
| [DF-005](#df-005-mexican-customers-transact-only-in-usd) | Mexican customers transact only in USD | design | Medium | Accepted limitation | Lucas |
| [DF-006](#df-006-closed-merchant-list-with-one-category-each) | Closed merchant list with one category each | design | Low | Accepted limitation | Lucas |
| [DF-007](#df-007-amounts-always-carry-cents) | Amounts always carry cents | design | Low | Accepted limitation | Lucas |
| [DF-008](#df-008-card-purchases-are-a-minority-of-transactions) | Card purchases are a minority of transactions | design | Medium | Handled at metric level | Lucas |
| [DF-009](#df-009-about-46-of-purchases-are-abroad) | About 4.6% of purchases are abroad | design | Low | Accepted limitation | Lucas |
| [DF-010](#df-010-unrecognized-charge-demand-is-stable) | Unrecognized-charge demand is stable | design | Low | Supports ADR-002 | Lucas |
| [DF-011](#df-011-30-of-customers-have-no-detected-accent) | 30% of customers have no detected accent | full | Low | Handled at metric level | Lucas |
| [DF-012](#df-012-ambiguous-reports-are-rare-and-double-charges-absent) | Ambiguous reports are rare and double charges absent | design | Medium | Accepted limitation | Lucas |
| [DF-013](#df-013-a-third-of-credit-card-holding-buyers-hold-multiple-credit-cards) | A third of credit-card-holding buyers hold multiple credit cards | design | Medium | Accepted limitation | Lucas |
| [DF-014](#df-014-purchases-fall-outside-the-cards-validity-dates) | Purchases fall outside the card's validity dates | design | Medium | Open | Manoella |
| [DF-015](#df-015-bronze-profile-findings-re-checked-in-silver) | Bronze-profile findings re-checked in Silver | full | Low | Mixed | Manoella |
| [DF-016](#df-016-branch-reference-columns-do-not-resolve) | Branch reference columns do not resolve | full | Medium | Handled at metric level | Manoella |
| [DF-017](#df-017-a-few-business-codes-are-shared-by-two-entities) | A few business codes are shared by two entities | full | Low | Accepted limitation | Manoella |
| [DF-018](#df-018-categorical-values-are-in-spanish-where-the-dictionary-lists-english) | Categorical values are in Spanish where the dictionary lists English | full | Low | Handled at metric level | Manoella |
| [DF-019](#df-019-foreign-purchase-countries-are-stored-in-english) | Foreign purchase countries are stored in English | full | Medium | Handled in the written policy (pending review) | Manoella |
| [DF-020](#df-020-one-clock-for-every-country-no-daily-rhythm) | One clock for every country, no daily rhythm | design | Medium | Accepted limitation | Manoella |
| [DF-021](#df-021-disputing-customers-have-few-recent-purchases) | Disputing customers have few recent purchases | design | High | Handled in the Gold cohort | Manoella |
| [DF-022](#df-022-unrecognized-charge-customers-by-country-segment-and-accent) | Unrecognized-charge customers by country, segment and accent | design | Low | Supports the Gold cohort | Manoella |
| [DF-023](#df-023-amounts-share-one-usd-scale-and-claimed-currencies-ignore-the-customers-country) | Amounts share one USD scale, and claimed currencies ignore the customer's country | design | Medium | Open | Manoella |

## Findings

### DF-001 Source text fields are fixed templates

- **Evidence:** `fact_complaints.description` has 5 distinct values in 67,095 rows, one per subcategory (e.g. "Queja relacionada con transactions"). `fact_call_transcripts.customer_text` has 42 distinct values in 171,321 rows, all `es`. All 42 are used by more than one of the 6 contact reasons.
- **Impact:** a model trained or validated on this text would learn a lookup, not language; complaint text *is* its label. No text model is trained on source text, source phrases can't serve as held-out cases, and dispute phrasing has to be authored.
- **Handling:** the intake evaluation uses an authored, blind, frozen ES/PT set (ADR-005). Portuguese is synthetic in every case.
- **Also documented in:** [bronze profile](data_profiles/bronze_data_profile/bronze_profile.md) (description domain); Andrés's viability notebook on branch `feat/Andres-NLP` (not merged).

### DF-002 Complaint product links point to other customers

- **Evidence:** every one of the 44,570 complaints with an `affected_product_id` points to a product owned by a different customer. The other 22,525 have no product. Transactions are clean: 4,425,008 of 4,425,008 product links match their owner.
- **Impact:** a complaint can't be tied to a card, account or product type. Any join from complaints to products silently mixes customers.
- **Handling:** suppressed at metric level, as recorded in the [quality parity record](data_pipelines/quality/PARITY.md), which also lists the same pattern for digital events (1,094,226 of 1,094,242). The quality gate reports it as `product_owner_mismatch` on every build.
- **Cause (confirmed in Bronze):** the source fills `affected_product_id` and `digital_events.product_id` with a product drawn at random from the whole product table. The product-type mix of cited products matches the full table within a point, digital events match their owner 16 times in 1,094,242 (chance level), and 8,351 of the 44,570 cited products (18.7%) were opened after the complaint was filed. It is a generation artefact, not a pipeline bug. See the [follow-up report](data_profiles/data_deep_dive/reports/complaints_product_owner_mismatch_followup.md).

### DF-003 Claimed amounts are not linked to transactions

- **Evidence:** of 12,297 `Cargo no reconocido` complaints, 4,090 have a `claimed_amount`, and 183 of those have no currency. The amounts range from 55.06 to 4,999.90 in every currency, including 989 in MXN, a currency no transaction uses (DF-005). **None of the 4,090** equals a transaction of the same customer and currency in the 180 days before the complaint. Silver also drops `origin_interaction_id`, which is 100% null in Bronze.
- **Impact:** we can't tell which charge a customer disputed, or how long after the charge they complained. Complaint amounts can't size losses or recoveries.
- **Handling:** the intake evaluation's 45-day lookback window is a stated assumption, not a measurement. ADR-002 already notes that no complaint links to a transaction.
- **Also documented in:** ADR-001 (coverage of the monetary fields).

### DF-004 Processing partition precedes the event date for early-hour events

- **Evidence:** in the design window, 933,847 of 3,738,506 transactions (25%) sit in the partition of the previous day. All of them have event hours 00–06, and the rest have hours 06–23. In complaints, 19,054 of 56,736 (34%) are affected, with hours 00–08. The offset differs by table: about 6 hours for transactions, about 8 for complaints.
- **Impact:** `process_date` is not an event date, and the timestamps' time zone is unknown. One of the two clocks is shifted, and we can't tell which.
- **Handling:** event-time filters and every split use the business timestamp, never `process_date` (AGENTS.md, ADR-005). The intake service shows timestamps as time-zone-free wall time.
- **Next step:** check the Bronze files and the source partition layout to confirm the cause.

### DF-005 Mexican customers transact only in USD

- **Evidence:** in the design window, 100% of approved purchases by Mexican customers are in USD, and no MXN transaction or product exists. Colombia is 89.9% COP and 10.1% USD, and Argentina is 90.0% ARS and 10.0% USD. Purchase currency always equals the card's currency.
- **Impact:** unlike a real Mexican bank. The MXN complaint amounts in DF-003 are not evidence either way, because claimed currencies ignore the customer's country (DF-023). No claim about Mexican local-currency behaviour is possible.
- **Handling:** stated as a limitation. Fixtures mirror it.

### DF-006 Closed merchant list with one category each

- **Evidence:** the design window has 24 merchant names, each with exactly one category, and every one appears in all 6 purchase countries. 5.0% of purchases have no merchant name but keep a category.
- **Impact:** merchant matching is exact over a closed list. A missing merchant is reported as missing, never invented (measurement contract).
- **Handling:** stated as a limitation. Fixtures use this list and show the category when the merchant is missing.

### DF-007 Amounts always carry cents

- **Evidence:** in the design window, 99% of purchase amounts have cents in every currency, COP included. The ranges look uniform: USD 5.00–500.00 (p50 252.20), ARS 1,750.05–174,999.31 (p50 88,303.46), COP 20,006.90–1,999,997.03 (p50 1,011,764.16).
- **Impact:** COP with cents is unlike real use. Uniform ranges mean amounts carry no signal about merchant or customer.
- **Handling:** stated as a limitation. The service keeps the source amount string.

### DF-008 Card purchases are a minority of transactions

- **Evidence:** in the design window, approved purchases are 22.5% of all transactions. The rest are approved withdrawals (20.1%), transfers (18.6%), payments (15.4%), deposits (12.7%), adjustments and fees (2.7%), plus declined, pending and reversed rows (about 8% together).
- **Impact:** a customer's "cargo" may be a withdrawal, a fee or a pending charge, none of which the intake service shows.
- **Handling:** V1 lists approved card purchases only (Gold slice filter). Reports about other movements are routed with an explicit message, consistent with ADR-002's scope.

### DF-009 About 4.6% of purchases are abroad

- **Evidence:** in the design window, 4.57% of approved purchases happen outside the customer's country: in the USA, Spain or Brazil (0.9% each), or in one of the other two bank countries.
- **Impact:** "a charge in Brazil I didn't make" is a natural report, and it's only decidable if the purchase country is visible.
- **Handling:** evaluation fixtures carry `transaction_country`. The service doesn't show it yet, which is a gap to close before a live comparison.

### DF-010 Unrecognized-charge demand is stable

- **Evidence:** in the design window, `Cargo no reconocido` is 18.2%, 18.2% and 18.4% of complaints in 2023, 2024 and 2025. By country the range is 18.2–18.4%, and by segment 18.1–18.9%.
- **Impact:** the demand evidence behind ADR-002 doesn't depend on the period chosen. No segment or country complains more, so a segment comparison measures how the *system* treats segments, not demand.
- **Handling:** supports ADR-002.

### DF-011 30% of customers have no detected accent

- **Evidence:** in the customer snapshot, `detected_accent` is null for 29.6% (Argentina), 30.0% (Colombia) and 29.9% (Mexico). All other values match the country.
- **Impact:** a locale derived from accent needs a fallback.
- **Handling:** the context card falls back to country, then to `es-419`.
- **Also documented in:** Andrés's personalization profile (PR #9).

### DF-012 Ambiguous reports are rare and double charges absent

- **Evidence:** in the design window, a customer makes 1 approved purchase in a typical month (p90: 2). 0.43% of purchases repeat the same merchant within 7 days, and no customer has two purchases with the same merchant and amount on the same day.
- **Impact:** real data would almost never produce an ambiguous match or a double charge, so an evaluation drawn from it couldn't test either.
- **Handling:** the evaluation is a coverage set with deliberately denser, more ambiguous fixtures, and it reports results by scenario family. "Charged twice" reports are authored, and routed as recognized billing disputes.

### DF-013 A third of credit-card-holding buyers hold multiple credit cards

- **Evidence:** among customers with approved design-window purchases who hold at least one credit card in the current product snapshot, 32.0% hold more than one credit card (maximum 6). Among those purchasers who hold at least one debit card, 13.8% hold more than one debit card. Each percentage uses holders of that card type as its denominator; purchasers with zero cards of that type are excluded.
- **Impact:** "my credit card" doesn't identify a unique card for about a third of credit-card-holding purchasers in this snapshot. This does not establish card holdings at the time of a past purchase.
- **Handling:** evaluation fixtures carry card type and the last four digits.

### DF-014 Purchases fall outside the card's validity dates

- **Evidence:** in the design window, 21.6% of approved purchases are dated before their card's `opening_date` and 27.1% after its `expiration_date`, at the same rates for credit and debit. All are on products whose current status is `Active`.
- **Impact:** opening and expiration dates can't validate or filter transactions, and product dates in the snapshot don't describe the product's history.
- **Corroborated:** over all 4,425,008 transactions (not just design-window purchases), 18.7% are dated before their product's `opening_date`, by 1 to 1,094 days (median 321). See the [quality warnings follow-up](data_profiles/data_deep_dive/reports/quality_report_warnings_followup.md).
- **Handling:** no filter uses card validity.
- **Next step:** check whether Bronze snapshots carry different dates per month.

### DF-015 Bronze-profile findings re-checked in Silver

The [bronze profile findings](data_profiles/bronze_data_profile/bronze_profile_findings.md) were re-run against Silver:

| Bronze finding | Silver result | Status |
|---|---|---|
| `México` / `Mexico` spelling split | 6 values: Argentina, Brazil, Colombia, México, Spain, USA | Handled in Silver |
| `contact_reason` duplicates `reason_category` | Identical in all 686,296 interactions (confirmed row by row in the [call-center deep dive](data_profiles/data_deep_dive/reports/call_center_interactions_table_report.md)) | Open: keep one |
| Future-dated `customers.last_updated` | 9,316 customers after 2026-06-18, up to 2027-06-15 | Open |
| `amount_usd` 57% null | 35 null; 99,442 of 4,425,008 (2.25%) estimated from FX and flagged | Handled in Silver; keep the flag |
| `origin_interaction_id` 100% null | Column dropped | Handled in Silver (see DF-003) |
| Literal `nan` in campaign subjects | None left | Handled in Silver |

### DF-016 Branch reference columns do not resolve

- **Evidence:** `dim_customers.registration_branch_id` is populated for all 150,000 customers with 150,000 distinct values, and only 5 of them are real branches. `dim_service_agents.assigned_branch_id` is populated for 833 of 1,200 agents (833 distinct values), and 2 are real branches. The orphan values have the same shape as real branch IDs (`SUC-XXXXXXXX`). Every other branch or agent reference resolves.
- **Impact:** neither column is a usable foreign key. A branch-level metric joined on them would drop or misattribute almost every row.
- **Handling:** no metric joins on these columns. The quality gate reports both as `foreign_key_orphans` on every build, and the [Silver README](data_pipelines/silver/README.md) and the Silver schema diagram mark them.

### DF-017 A few business codes are shared by two entities

- **Evidence:** 6 `product_number` values in 400,000 products and 13 `employee_code` values in 1,200 agents each belong to exactly two different IDs. No code is used three times.
- **Impact:** these codes can't be used as lookup keys without the ID. At this scale they look like random collisions in generation.
- **Handling:** joins use `product_id` and `agent_id`. Both codes are in the quality gate's `unique_fields`, so the gate reports the collisions on every build.

### DF-018 Categorical values are in Spanish where the dictionary lists English

- **Evidence:** `product_type`, `document_type` (`Pasaporte`, no `CURP`), `geographic_zone` (only `Urbana`), `reason_category` and `detected_sentiment` hold Spanish values, while the dictionary lists English labels. `comment_sentiment` in satisfaction surveys is in English.
- **Impact:** a domain check or filter written from the dictionary would reject every row, or silently match none.
- **Handling:** the quality gate's domains for `reason_category` and `detected_sentiment` use the observed values; `product_type`, `document_type` and `geographic_zone` are not gated. Code that filters these columns uses the source spelling, e.g. `Tarjeta Crédito`, `Queja`.

### DF-019 Foreign purchase countries are stored in English

- **Evidence:** Bronze and Silver store the three foreign purchase countries in English: `USA` (40,621 rows), `Spain` (40,542) and `Brazil` (40,472). The home countries are in Spanish. Bronze also has 40,515 rows spelled `Mexico`, which Silver canonicalizes to `México` (DF-015). In the design window, purchases in those three foreign countries are 23,110 of 842,103 approved purchases (2.74%, from DF-009).
- **Impact:** customers name countries in Spanish or Portuguese ("Estados Unidos", "EE.UU.", "EUA", "España", "Brasil"). The written policy compared strings exactly, so a correctly understood "a charge in Brazil I didn't make" never matched its purchase. None of the development fixtures has a purchase country, so the development gate couldn't show this.
- **Handling:** the policy (`evals/intake/frozen_es_pt_v1/label_rules.py`) compares both sides as ISO 3166-1 codes through a closed ES/PT/EN map, and unknown names never match. Recomputing every committed frozen answer with it changes none. That check runs only locally, where the withheld file exists, and barely exercises the map, since only one frozen situation states a country. Unit tests cover the map itself. It needs the unexposed reviewer's approval (ADR-006, decision 5). Development cases with a purchase country are still missing, and an unexposed author has to write them.

### DF-020 One clock for every country, no daily rhythm

- **Evidence** (design window, run `20261001T020908Z`):
  - **No daily rhythm.** Transactions are spread almost evenly over the 24 hours in every country: the quietest hour has 98–99% of the busiest hour's count (Mexico 1,872,519 events, Colombia 1,122,261, Argentina 743,726). Complaints are similar, at 84–93% (28,197 / 17,225 / 11,314 events).
  - **Same rollover everywhere.** The storage partition rolls over at the same stored hour in all three countries: 06:00 for transactions, 08:00 for complaints. Events before that hour are filed under the previous day. The full transaction range runs from 2023-06-17 06:01:30 to 2026-06-18 05:59:41.
- **Interpretation:** timestamps don't follow each country's local time. Mexico is UTC−6, Colombia UTC−5 and Argentina UTC−3, yet the rollover hour is the same for all three, and the offset depends on the table, not the country. We wrote a test that shifts each country's hourly profile to fit Mexico's, but it has no power here: with a flat profile any shift fits about as well, so it was dropped and is reported here instead. Which clock the source used is not stated by the data.
- **Handling:** the Gold slice serves the Bronze timestamp string as zone-free source time (`source_occurred_at`), and the interface labels it as such. `process_date` is used only to prune partitions (DF-004).

### DF-021 Disputing customers have few recent purchases

- **Population:** 9,009 `Cargo no reconocido` complaints created between 2023-10-15 and 2025-12-31. Complaints before 2023-10-15 are excluded because their 120-day history would start before the data does.
- **Numerator:** the same customer's approved purchases in the window (c − W, c] before the complaint, for W = 30, 45, 90 and 120 days.
- **Evidence:**
  - **Purchases per customer.** The median is 0 in every window and every country. At 120 days the p90 is 2 and the p99 is 5.
  - **No purchase at all.** In the 45 days before the complaint, 79.0% of complaints have none; in the 120 days before, 61.1% do.
  - **Age of the last purchase.** Where one exists, the most recent purchase is 41 days old at the median, 109 days at p95 and 118 days at p99.
  - **Over the whole dataset,** the median customer has 10 approved purchases in three years.
- **Impact:**
  - **Lookback can't be measured.** The age of the disputed charge itself isn't in the data (DF-003). The p95 and p99 above are the closest proxy: how far back a customer would have to look to see anything at all.
  - **No window passes our rule.** We wrote it before running: at most 5% of complaints with no purchase, and a median of at least 3 purchases. None of the four windows meets it.
- **Handling:**
  - **The fallback applies.** The serving window is the 120-day cap. The Gold cohort keeps only customers with at least 3 approved purchases in that window, so every demo customer has a list to choose from.
  - **This is a selection, not a property of the population.** Most disputing customers in this data would see one purchase or none.

### DF-022 Unrecognized-charge customers by country, segment and accent

- **Evidence:**
  - **By country.** 10,013 distinct customers filed a `Cargo no reconocido` complaint in the design window: Mexico 5,001 (49.9%), Colombia 3,031 (30.3%) and Argentina 1,981 (19.8%).
  - **By segment and accent.** The query reports the full country × segment × accent rollup, and missing values are labelled `(none)` so they can't be mistaken for subtotals.
- **Handling:** these shares are the reference for the Gold cohort's country mix. The cohort's own shares are reported against them in the slice manifest.

### DF-023 Amounts share one USD scale, and claimed currencies ignore the customer's country

- **Evidence** (design window, run `20261001T030222Z`):
  - **Purchases sit on one USD scale.** Once converted, the median approved purchase is about USD 252 in every country and currency: Mexico USD 252.09 (420,916 purchases), Colombia COP 1,011,764 = USD 252.93, Argentina ARS 88,303 = USD 252.27. The USD purchases in Colombia and Argentina are USD 251.73 and 255.24. Mexican amounts are therefore dollar-sized, not peso amounts labelled USD.
  - **Claimed currencies are spread evenly in every country.** Among `Cargo no reconocido` complaints with a claimed amount, each country splits almost evenly across MXN, USD, COP and ARS. Mexico has COP 424, MXN 423, USD 394 and ARS 391. Argentina has USD 178, MXN 174, ARS 172 and COP 147. The median amount is 2,094–2,952 whatever the currency.
- **Interpretation:** the generator appears to draw amounts in USD and convert them for Colombia and Argentina, but not for Mexico. It also draws a complaint's currency independently of the customer. So the MXN claims say nothing about how Mexican customers transact.
- **Impact on the product:**
  - **The live guided flow:** none. The customer picks the charge from their own list, which shows each amount with its currency code.
  - **The written policy** (`evals/intake/frozen_es_pt_v1/POLICY.md`, `label_rules._currency`) maps "pesos" from a Mexican customer to a currency they don't hold. The answer is therefore "clarify, no candidates". That is faithful to this data, but "pesos" is how a Mexican customer naturally names an amount. Once the model reads free text online, every Mexican report that states pesos would ask the customer again, and Mexico is 48.7% of the served cohort. Ignoring the currency would not help, because the amounts are dollar-sized.
  - **The frozen evaluation** uses the same rule. Its fixtures mirror DF-005, so the cases that depend on it test this data, not real Mexican usage.
- **Handling:** open.
  - **Factored question:** is USD for Mexico intended?
  - **Until then:** the policy stays unchanged, because changing it would change frozen labels and needs Manoella's approval. The online clarifying message should say which currency the customer's card uses, so the second answer can match.

## Disclosure

On 2026-09-29, before ADR-005 fixed the design window, Lucas and an AI assistant profiled several of these facts once over the full period. For every fact used in evaluation design, the full-period and design-window values agree to one decimal place, so nothing learned from the holdout window changed a design choice. From now on, evaluation design uses only the design-window results above.

## Adding or updating a finding

1. Add `data_profiles/findings/queries/DF-0NN_short_name.sql` with the header lines `-- id:`, `-- title:`, `-- scope: design|full` and `-- memory:`. Design queries must filter on the business timestamp with `$design_end`, and a test fails if they don't.
2. Run `make findings`, which writes to the ignored `data/findings_runs/<UTC time>/results.json`. Paste only reviewed aggregates here, never row-level data.
3. Add the row to the summary and a section with evidence, impact, handling, status and owner. If the finding is already written up elsewhere, link to it rather than repeating it.
4. Open a PR and say which quality run the numbers come from.
