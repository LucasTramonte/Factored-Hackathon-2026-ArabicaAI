# Personalization signal profile

Source: `C:\Users\andre\Desktop\Personal\Hackathones\Factored\branch-personalization\Factored-Hackathon-2026-ArabicaAI\data\latam_bank.duckdb` (Silver tables, read-only).
Generated to decide what `gold.customer_personalization_profile` can safely contain.

Total customers in `silver.dim_customers`: **150,000**

## 1. Signal coverage per customer (cold-start exposure)

| Source | Distinct customers | % of all customers |
|---|---|---|
| fact_call_center_interactions (any interaction ever) | 148,443 | 99.0% |
| fact_call_transcripts (any transcript ever) | 101,951 | 68.0% |
| fact_complaints (any complaint ever) | 54,145 | 36.1% |
| fact_satisfaction_surveys (any survey ever) | 113,640 | 75.8% |
| fact_digital_events (any digital session ever) | 149,997 | 100.0% |
| fact_transactions (any transaction ever) | 134,515 | 89.7% |


Customers with **zero** interactions, complaints, or digital events at all: **0** (0.0% of 150,000). These customers cannot get any behavior-based personalization on first contact; the profile must fall back to `dim_customers` fields (segment, country, accent) only.

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


Customers with both a `dim_customers.detected_accent` and >=1 interaction accent: **104,096**. Their most-common interaction accent matches the profile accent for **104,096 (100.0%)**. This is the evidence for whether `dim_customers.detected_accent` can be trusted as the single source of truth, or whether a per-interaction mode is more reliable.

## 3. Language domain (Spanish/Portuguese requirement check)

| detected_language | transcripts |
|---|---|
| es | 171321 |


Transcripts with a Portuguese `detected_language`: **0**. If this is zero, Portuguese personalization cannot be derived from this dataset and must be reported as a data limitation, not silently skipped.

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


Customers with >=2 interactions in the SAME `reason_category` (ever, not windowed): **112,359** (74.9% of all customers). This is the population for whom a 'you've contacted us about this before' personalization would actually trigger.

Customers with a currently open/in-process/escalated complaint: **42,726** (28.5% of all customers).

## 6. Sentiment and CSAT coverage

`sentiment_score` null rate in interactions: 0/686,296 (0.0%).

`fact_satisfaction_surveys` by type (main_score is on a different scale per type):

| survey_type | surveys | avg_main_score |
|---|---|---|
| CSAT | 127856 | 2.77 |
| NPS | 63668 | 5.31 |
| CES | 21235 | 2.77 |


## 7. Consent gate for proactive personalization

| accepts_marketing | customers |
|---|---|
| False | 75007 |
| True | 74993 |


---
Profiled in 4.6s.
