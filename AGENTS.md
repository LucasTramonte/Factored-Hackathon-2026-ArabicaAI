# AGENTS.md

## Mandatory Engineering Rules

These rules apply to every coding agent working in this repository.

- Treat partitioned fact CSVs as large data. Stream or process in bounded chunks, project columns, and filter partitions early.
- Before implementing a large-data operation, state its memory model. Prefer `O(chunk_size)` or `O(unique_dimension_keys)` memory; avoid `O(total_fact_rows)` unless explicitly justified.
- Never materialize all keys from a multi-million-row fact table. Materialize small referenced dimensions when practical and stream fact-side membership checks.
- Share work across checks when it improves correctness or runtime, but do not trade away clear ownership or safety merely to reduce passes.
- Use risk-based testing. Core parsing, contracts, quality checks, keys, partitions, joins, aggregations, bug fixes, and memory-sensitive code require test-first or an equivalent focused regression test.
- For joins, declare the analytical grain and cardinality before joining. Aggregate fact tables before customer-level joins when a many-to-many relationship is possible.
- Long-running scans should report meaningful progress at table or file boundaries without logging every row.
- Raw data is read-only. Generated reports, caches, and temporary outputs must remain ignored and must not enter commits accidentally.
- Public modules, classes, and functions require concise docstrings that explain purpose, inputs, outputs, and important invariants. Do not add comments that merely narrate obvious code; comments should explain non-obvious rationale or trade-offs.
- Before a full-dataset run, use the progression in `.github/skills/testing-data-pipelines/SKILL.md` and prove the behavior on a small fixture.

See [ARCHITECTURE.md](ARCHITECTURE.md) for verified implementation decisions and `.github/skills/` for focused procedures.

## Project Overview

This project contains the LATAM Bank synthetic dataset for the Factored Hackathon 2026.

The dataset is stored primarily as CSV files and contains transactional, customer, contact-center, digital-banking, complaint, marketing, and reference data.

Before working with the raw CSV files, consult:

- `Docs/LATAM_BANK_DATA_DICTIONARY.md` — canonical schema and relationships.
- `Docs/LATAM_BANK_DATASET.md` — dataset overview, scope, and known characteristics.
- `Docs/FACTORED_HACKATHON_2026.md` — hackathon requirements, evaluation criteria, and constraints.

The data dictionary is the primary source of truth for table names, column names, types, and relationships.

---

# Data Discovery

## Rule: Identify the Table Before Reading the CSV

Do not search or scan every CSV file by default.

For every data-related request:

1. Identify the business concept.
2. Map the concept to the relevant table.
3. Confirm the required columns in `Docs/LATAM_BANK_DATA_DICTIONARY.md`.
4. Locate the corresponding CSV file.
5. Read only the required columns and rows.
6. Apply filters as early as possible.

Never invent table or column names.

If the documentation and the actual CSV headers disagree, inspect the CSV headers and report the discrepancy.

---

# Table Discovery Map

Use this map as the first lookup layer.

| Business Need | Primary Table |
|---|---|
| Customer profile | `customers` |
| Customer products | `products` |
| Financial transactions | `transactions` |
| Contact-center interactions | `call_center_interactions` |
| Call transcripts / NLP | `call_transcripts` |
| Satisfaction / NPS | `satisfaction_surveys` |
| Digital banking behavior | `digital_events` |
| Complaints / claims | `complaints` |
| Campaign deliveries and conversions | `campaign_sends` |
| Campaign metadata | `marketing_campaigns` |
| Bank branches | `branches` |
| Service agents | `service_agents` |
| Currency conversion | `daily_exchange_rates` |

---

# Use Case → Tables

Use these mappings when translating a natural-language request into data operations.

## Customer Analytics

Typical questions:

- Customer segmentation
- Churn analysis
- Customer lifetime value
- Customer behavior
- Cross-sell / up-sell opportunities

Start with:

```text
customers
products
transactions
digital_events
call_center_interactions
```

Common key:

```text
customer_id
```

---

## Contact Center

Typical questions:

- First Call Resolution (FCR)
- Agent performance
- Call volume
- Resolution rates
- Escalations
- Sentiment
- Customer satisfaction
- Contact reasons

Start with:

```text
call_center_interactions
```

Add:

```text
call_transcripts
```

when textual information is required.

Add:

```text
satisfaction_surveys
```

when satisfaction or NPS is required.

Add:

```text
complaints
```

when formal complaints, resolutions, or SLA information is required.

---

## Fraud Detection

Typical questions:

- Fraud detection
- Transaction anomalies
- Spending anomalies
- Geographic risk
- Fraud scoring

Start with:

```text
transactions
```

Important fields include:

```text
transaction_date
process_date
customer_id
product_id
transaction_type
transaction_category
amount
currency
amount_usd
transaction_country
transaction_city
transaction_status
is_fraud
fraud_score
```

---

## Marketing Analytics

Typical questions:

- Campaign effectiveness
- Delivery rates
- Open rates
- Click rates
- Conversion
- Channel performance
- Customer targeting

Start with:

```text
campaign_sends
marketing_campaigns
```

Use:

```text
customers
```

when customer attributes are required.

---

## NLP / Text Analytics

Typical questions:

- Topic modeling
- Intent classification
- Entity extraction
- Sentiment analysis
- Accent detection
- Transcript analysis

Start with:

```text
call_transcripts
```

Relevant fields may include:

```text
full_text
customer_text
agent_text
detected_language
detected_accent
accent_confidence
detected_keywords
mentioned_entities
detected_intents
main_topics
```

Use `call_center_interactions` to connect transcript information with interaction outcomes.

---

# Table Categories

## Fact Tables

Event and transaction tables:

```text
transactions
call_center_interactions
call_transcripts
satisfaction_surveys
digital_events
complaints
campaign_sends
```

## Dimension / Entity Tables

Entity and descriptive tables:

```text
customers
products
branches
service_agents
marketing_campaigns
```

## Reference Tables

Lookup and conversion data:

```text
daily_exchange_rates
```

---

# Key Relationships

Use the documented foreign keys in `Docs/LATAM_BANK_DATA_DICTIONARY.md`.

## Customer

```text
customers.customer_id
    ↓
products.customer_id
transactions.customer_id
call_center_interactions.customer_id
call_transcripts.customer_id
satisfaction_surveys.customer_id
digital_events.customer_id
complaints.customer_id
campaign_sends.customer_id
```

## Interaction

```text
call_center_interactions.interaction_id
    ↓
call_transcripts.interaction_id
satisfaction_surveys.interaction_id
complaints.origin_interaction_id
```

## Product

```text
products.product_id
    ↓
transactions.product_id
digital_events.product_id
complaints.affected_product_id
```

## Agent

```text
service_agents.agent_id
    ↓
call_center_interactions.agent_id
call_transcripts.agent_id
satisfaction_surveys.agent_id
complaints.assigned_agent_id
```

## Campaign

```text
marketing_campaigns.campaign_id
    ↓
campaign_sends.campaign_id
```

## Branch

```text
branches.branch_id
    ↓
customers.registration_branch_id
products.opening_branch_id
service_agents.assigned_branch_id
transactions.branch_id
complaints.related_branch_id
```

---

# CSV Reading Strategy

The dataset is large. Avoid unnecessary full-file reads.

## Prefer Column Projection

If only a few columns are needed, load only those columns.

Example:

```python
pd.read_csv(
    csv_path,
    usecols=[
        "customer_id",
        "transaction_date",
        "amount",
        "currency"
    ]
)
```

Avoid:

```python
pd.read_csv(csv_path)
```

when the full schema is unnecessary.

---

## Filter Early

Apply restrictive filters as early as possible.

Preferred workflow:

```text
CSV
 ↓
select required columns
 ↓
filter relevant dates / records
 ↓
transform
 ↓
aggregate
 ↓
join
 ↓
analyze
```

Avoid loading and joining entire fact tables before filtering.

---

# Large Tables

The dataset contains approximately 19 million records.

The largest tables are:

| Table | Approx. Records |
|---|---:|
| `digital_events` | 10M |
| `transactions` | 5M |
| `campaign_sends` | 2M |
| `call_center_interactions` | 800K |
| `satisfaction_surveys` | 250K |
| `call_transcripts` | 200K |
| `complaints` | 80K |

Treat these tables as large datasets.

When possible:

- Select only required columns.
- Filter by date.
- Process in chunks.
- Aggregate before joining.
- Avoid loading multiple large tables into memory simultaneously.
- Avoid unnecessary copies of large DataFrames.

---

# Date Filtering

Large fact tables use date-based partitioning.

When the user provides a time range:

1. Identify the appropriate date field.
2. Restrict the data to that period.
3. Avoid processing unrelated dates.

Do not assume that every date column represents the physical partition.

Use the documented partition field from the data dictionary.

---

# Join Safety

Never join two fact tables simply because they share `customer_id`.

A customer can have many records in multiple fact tables.

For example:

```text
transactions
```

may contain many transactions per customer, while:

```text
call_center_interactions
```

may contain many interactions per customer.

Joining them directly on:

```text
customer_id
```

can create a many-to-many row explosion.

## Safer Pattern

Aggregate each fact table to the required analytical grain first.

Example:

```text
transactions
    ↓
aggregate by customer_id
    ↓
customer_transaction_features

call_center_interactions
    ↓
aggregate by customer_id
    ↓
customer_interaction_features

customer_transaction_features
+
customer_interaction_features
    ↓
join on customer_id
```

Always check row counts before and after joins.

---

# Analytical Grain

Before performing an analysis, explicitly determine the required grain.

Examples:

```text
Customer-level
→ customer_id

Transaction-level
→ transaction_id

Interaction-level
→ interaction_id

Product-level
→ product_id

Campaign-level
→ campaign_id

Branch-level
→ branch_id

Agent-level
→ agent_id
```

Do not mix grains without explicitly aggregating.

---

# Data Quality

The dataset is synthetic and intentionally includes data-quality challenges.

Before relying on a dataset, check when relevant:

- Missing values
- Duplicate records
- Invalid values
- Unexpected categories
- Date inconsistencies
- Duplicate keys
- Referential-integrity issues
- Orphan records

The dataset documentation indicates that a small percentage of orphan records may exist for testing.

Do not silently remove anomalous records.

If a data-quality issue materially affects the analysis, mention it in the result.

---

# Missing Information

If the requested information is not available:

1. Identify the tables inspected.
2. Identify the missing field or relationship.
3. Do not fabricate the value.
4. Do not silently substitute another metric.
5. Clearly distinguish observed values from derived values.

---

# Schema Rules

Always preserve the exact schema names from the data dictionary.

For example:

```text
customer_id
transaction_date
transaction_status
amount_usd
```

Do not rename them conceptually during SQL generation or data exploration unless the task explicitly requires an alias.

When generating SQL or Python, prefer the exact dataset column names.

---

# Source of Truth

Use the following priority when resolving dataset questions:

1. `Docs/LATAM_BANK_DATA_DICTIONARY.md`
2. Actual CSV headers
3. `Docs/LATAM_BANK_DATASET.md`
4. Derived observations from the data

Do not invent missing schema information.

If sources disagree, report the discrepancy and use the actual CSV schema for execution.

---

# Recommended Agent Workflow

For every data-analysis request, follow this sequence:

```text
1. Understand the question
        ↓
2. Identify the business concept
        ↓
3. Identify the primary table
        ↓
4. Check the data dictionary
        ↓
5. Identify exact columns
        ↓
6. Identify filters
        ↓
7. Identify required joins
        ↓
8. Determine analytical grain
        ↓
9. Read only necessary CSV data
        ↓
10. Validate data quality
        ↓
11. Perform analysis
        ↓
12. Validate the result
        ↓
13. Report methodology and limitations
```

---

# Reproducibility

When presenting an analysis, include when relevant:

- Tables used
- Columns used
- Date range
- Filters
- Join keys
- Aggregation grain
- Number of records considered
- Important data-quality limitations

The goal is for another agent or developer to be able to reproduce the analysis from the same CSV files.

---

# Dataset Constraints

The dataset is synthetic and contains no real customer information.

Text data is in Spanish with regional variations.

The dataset includes accent-related fields for Mexican, Colombian, and Argentine variations.

Transactions include local currency and USD conversion fields.

Do not treat synthetic data as representative of real-world customer populations or banking behavior.