# Personalization signal profile

Source: `data/full_local/latam_bank.duckdb` (Silver tables, read-only).
Generated to decide what `gold.customer_personalization_profile` can safely contain.

Total customers in `silver.dim_customers`: **150,000**

## 1. Signal coverage per customer (cold-start exposure)

| Source | Distinct dimension customers | % of all customers | Orphan fact IDs |
|---|---|---|---|
| fact_call_center_interactions | 148,443 | 99.0% | 0 |
| fact_call_transcripts | 101,951 | 68.0% | 0 |
| fact_complaints | 54,145 | 36.1% | 0 |
| fact_satisfaction_surveys | 113,640 | 75.8% | 0 |
| fact_digital_events | 149,997 | 100.0% | 0 |
| fact_transactions | 134,515 | 89.7% | 0 |

Every customer has at least one interaction, complaint or digital event, so there is no fully cold-start population. Coverage is below 80% for `fact_call_transcripts` (68.0%), `fact_complaints` (36.1%), `fact_satisfaction_surveys` (75.8%); those sources can refine a profile but cannot be any customer's only signal. No fact customer ID is missing from `dim_customers`.

## 2. Accent signal: domain and cross-source agreement

`dim_customers.detected_accent` domain:

| detected_accent | customers |
|---|---|
| mexican | 52505 |
|  | 44817 |
| colombian | 31666 |
| argentine | 21012 |

`fact_call_center_interactions.customer_detected_accent` domain:

| customer_detected_accent | interactions |
|---|---|
| mexican | 240674 |
|  | 204750 |
| colombian | 144712 |
| argentine | 96160 |

`fact_call_transcripts.detected_accent` domain:

| detected_accent | transcripts |
|---|---|
|  | 63083 |
| mexican | 54152 |
| colombian | 32284 |
| argentine | 21802 |

Where both exist (104,096 customers) the profile accent matches the most common interaction accent every time, so `dim_customers.detected_accent` can be trusted when present. The profile accent is blank for 44,817 customers (29.9%), so the profile needs a fallback chain: `dim_customers` -> mode of interaction accent -> mode of transcript accent -> null (never a guessed default).

## 3. Language domain (Spanish/Portuguese requirement check)

| detected_language | transcripts |
|---|---|
| es | 171321 |

None of the 171,321 transcripts has a Portuguese `detected_language`. Portuguese personalization cannot be derived or validated from this dataset; it has to be demonstrated with hand-authored cases and reported as a data limitation.

## 4. Segment, country, and digital-channel domains

`dim_customers.segment`:

| segment | customers |
|---|---|
| Basic | 89756 |
| Plus | 37547 |
| Premium | 15207 |
| Student | 7490 |

`dim_customers.country`:

| country | customers |
|---|---|
| México | 74907 |
| Colombia | 45251 |
| Argentina | 29842 |

`fact_digital_events.channel` (for preferred-channel personalization):

| channel | events |
|---|---|
| Android App | 5476164 |
| iOS App | 3899497 |
| Desktop Web | 3128851 |
| Mobile Web | 3116482 |

Segment shares: `Basic` 59.8%, `Plus` 25.0%, `Premium` 10.1%, `Student` 5.0%. The smallest segment (`Student`) has the least evidence for any segment-based tone rule. Segment is a current snapshot, not the segment at the time of past contacts. Countries: `México` 49.9%, `Colombia` 30.2%, `Argentina` 19.9%. Digital channels: `Android App` 35.1%, `iOS App` 25.0%, `Desktop Web` 20.0%, `Mobile Web` 20.0% of 15,620,994 events.

## 5. Repeat-contact and complaint signal strength

`fact_call_center_interactions.reason_category` volume:

| reason_category | interactions | distinct_customers |
|---|---|---|
| Transaccional | 240056 | 119646 |
| Producto | 150863 | 95245 |
| Queja | 117021 | 81336 |
| Técnico | 102899 | 74536 |
| Comercial | 54879 | 45979 |
| Retención | 20578 | 19274 |

112,359 customers (74.9%) have >=2 interactions in the same `reason_category` (ever, not windowed). 42,726 (28.5%) currently have an open, in-process or escalated complaint; complaint status is a snapshot.

## 6. Sentiment and CSAT coverage

`fact_satisfaction_surveys` by type (main_score is on a different scale per type):

| survey_type | surveys | avg_main_score | min | max |
|---|---|---|---|---|
| CSAT | 127856 | 2.77 | 1 | 4 |
| NPS | 63668 | 5.31 | 2 | 7 |
| CES | 21235 | 2.77 | 1 | 4 |

`sentiment_score` is null for 0/686,296 interactions (0.0%) and present for 148,443 customers (99.0%). `main_score` ranges per survey type: `CSAT` 1-4; `NPS` 2-7; `CES` 1-4. It must not be averaged across types; use one column per type.

## 7. Consent gate for proactive personalization

| accepts_marketing | customers |
|---|---|
| False | 75007 |
| True | 74993 |

`accepts_marketing`: True 50.0%, False 50.0%, null 0. It is the current consent snapshot, so it can gate proactive personalization now but says nothing about consent at past contact dates. Reactive personalization (answering what the customer asked) does not need this gate.

## 8. Recommended variables for gold.customer_personalization_profile

| Variable | Source | Evidence | Decision |
|---|---|---|---|
| preferred_accent | dim_customers -> interaction mode -> transcript mode | 100.0% agreement over 104,096 comparable customers; 29.9% blank in the dimension | Include, with the 3-step fallback and null as last resort |
| preferred_language | call_transcripts.detected_language | 0.0% Portuguese of 171,321 transcripts | Include for Spanish only; Portuguese is a documented data gap |
| segment, country | dim_customers | 0 null segments, 0 null countries; current snapshot | Include directly as tone inputs, never for eligibility |
| preferred_digital_channel | mode of fact_digital_events.channel | 100.0% customer coverage; 4 channels over 15,620,994 events | Include |
| repeat_contact_flag | fact_call_center_interactions by reason_category | 74.9% of customers qualify | Include |
| open_complaint_flag | fact_complaints.status (snapshot) | 28.5% of customers | Include |
| avg_sentiment_score | fact_call_center_interactions.sentiment_score | 0.0% null; 99.0% customer coverage | Include |
| csat_avg / nps_avg / ces_avg | fact_satisfaction_surveys, split by survey_type | 3 survey types on different scales | Include as separate columns, never blended |
| accepts_marketing | dim_customers (current snapshot) | True 50.0%, null 0 | Include as a gate for proactive offers, not a style |
| credit_score, estimated_monthly_income, fraud_score, days_past_due | dim_customers / products / transactions | Out of scope by team decision | Excluded |

---
Profiled in 4.8s.
