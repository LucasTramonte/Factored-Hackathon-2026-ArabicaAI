# LATAM Bank Dataset

**Factored Datathon 2026**\
**Dataset Version:** 1.0.0\
**Generated:** July 2026

## Dataset Overview

  Attribute       Value
  --------------- --------------------------------------------------------
  Total records   \~19,000,000
  Total tables    13
  Countries       Mexico, Colombia, Argentina
  Date range      2023-06-17 to 2026-06-17
  Currencies      MXN, COP, ARS, USD
  Languages       Spanish with Mexican, Colombian, and Argentine accents

The dataset simulates a comprehensive regional banking system operating
across Mexico, Colombia, and Argentina.

It contains realistic banking, customer-service, and digital-interaction
data spanning three years, from June 2023 to June 2026.

The dataset covers:

-   Customer master data.
-   Transaction details.
-   Call-center interactions.
-   Marketing campaigns.
-   Customer complaints.
-   Digital-channel interactions.
-   Customer satisfaction.

The dataset is synthetically generated specifically for the Factored
Datathon 2026.

It intentionally includes data-quality challenges such as:

-   Duplicates.
-   Nulls.
-   Late arrivals.
-   Schema evolution.

## Data Quality Challenges

  Challenge             Rate / Status Description
  ------------------- --------------- -------------------------------------------
  Duplicate records              \~2% Realistic duplicate entries across tables
  Null values                    \~5% Missing data in non-mandatory fields
  Late arrivals                   Yes Partitioned data may arrive late
  Schema evolution                Yes Table schemas may evolve over time

## Tables

### Dimension Tables

  Table                        Rows Description
  ----------------------- --------- ----------------------------------------
  `customers`               150,000 Bank customer dimension table
  `products`                400,000 Active financial products of customers
  `branches`                    350 Physical bank branches
  `service_agents`            1,200 Customer service agents
  `marketing_campaigns`         200 Bank marketing campaigns

### Fact Tables

  -------------------------------------------------------------------------------
  Table                                                Rows Description
  ---------------------------- ---------------------------- ---------------------
  `transactions`                                  5,000,000 Daily financial
                                                            transactions

  `call_center_interactions`                        800,000 Call-center
                                                            interactions with
                                                            customers

  `call_transcripts`                                200,000 Call-center call
                                                            transcripts

  `satisfaction_surveys`                            250,000 Post-interaction
                                                            satisfaction surveys
                                                            (CSAT, NPS)

  `digital_events`                               10,000,000 Digital-channel
                                                            interaction events
                                                            (mobile app, web)

  `complaints`                                       80,000 Complaints and claims
                                                            system (PQR)

  `campaign_sends`                                2,000,000 Individual marketing
                                                            campaign sends
  -------------------------------------------------------------------------------

### Reference Tables

  ---------------------------------------------------------------------------
  Table                                            Rows Description
  ------------------------ ---------------------------- ---------------------
  `daily_exchange_rates`                          3,000 Daily exchange rates
                                                        for currency
                                                        conversion

  ---------------------------------------------------------------------------

## Potential Use Cases

### Customer Analytics

-   Customer segmentation and clustering.
-   Churn prediction models.
-   Customer lifetime value (CLV) analysis.
-   Cross-sell and up-sell opportunity identification.

### Contact Center Optimization

-   First Call Resolution (FCR) improvement.
-   Agent performance analysis and benchmarking.
-   Sentiment trend analysis.
-   Accent-based routing optimization.

### Fraud Detection

-   Transaction fraud detection models.
-   Anomaly detection in spending patterns.
-   Geographic risk modeling.

### Marketing Analytics

-   Campaign effectiveness measurement.
-   Channel attribution modeling.
-   Personalization and targeting models.
-   A/B testing analysis.

### NLP and Text Analytics

-   Topic modeling on call transcripts.
-   Intent classification.
-   Entity extraction from customer interactions.
-   Multilingual accent detection and classification.

### Product Analytics

-   Product adoption and usage analysis.
-   Digital engagement funnel optimization.
-   Feature usage analysis.

## Important Data Characteristics

### Spanish Language Data

All text data, including:

-   Customer names.
-   Addresses.
-   Transcripts.
-   Descriptions.

is in Spanish with regional variations.

### Accent Detection

The dataset includes accent-detection fields for:

-   Mexican.
-   Colombian.
-   Argentine.

These fields enable dialect-aware customer-service analysis.

### Multi-Currency Support

Transactions include:

-   Local currency:
    -   MXN.
    -   COP.
    -   ARS.
-   USD conversion.

USD conversion uses daily exchange rates.

### Date Partitioning

Large fact tables are partitioned by:

-   Year.
-   Month.
-   Day.

This supports efficient processing and querying.

### Referential Integrity

Foreign-key relationships are maintained across tables.

A small percentage of orphaned records may exist for testing.

### Synthetic Data

The dataset is completely synthetic and generated for educational
purposes.

**No real customer information is included.**

### Data Dictionary

For detailed schema information, including:

-   Column descriptions.
-   Data types.
-   Constraints.

refer to the complete `DATA_DICTIONARY.md` file.

## Dataset Metadata

-   **Dataset:** LATAM Bank Dataset
-   **Version:** 1.0.0
-   **Records:** \~19 million
-   **Tables:** 13
-   **Countries:** Mexico, Colombia, Argentina
-   **Coverage:** June 2023 to June 2026
-   **Generated:** July 2026
