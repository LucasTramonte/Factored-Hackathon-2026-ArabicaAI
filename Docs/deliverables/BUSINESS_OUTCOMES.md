# Business Outcomes

This document is the discovery gate between the data foundation and the analytical or agent workflow. It records hypotheses to validate from the supplied synthetic data. It does not claim that an outcome has been measured until the relevant analysis and held-out evaluation are complete.

## How To Use This Document

For each candidate outcome, follow this chain:

```text
business outcome
    -> business question
    -> decision supported
    -> KPI and denominator
    -> required tables and grain
    -> transformations and quality gates
    -> analysis deliverable
    -> possible agent capability
```

Do not build a workflow only because a table or model is available. Select a workflow after comparing demand, customer impact, operational feasibility, data quality, and evaluation quality.

## Outcome 1: Reduce Unresolved Transaction Disputes

### Business question

Which transaction-dispute requests generate the most follow-up, SLA risk, repeat contact, or human-review demand, and which parts of intake can be completed safely before handoff?

### Decision supported

Whether to prioritize transaction-dispute intake, especially unrecognized charges and incorrect charges, as the first customer-service workflow.

### Customer outcome

The customer provides the necessary dispute context once, receives only verified transaction facts, and is transferred with a complete case summary when automation cannot decide the outcome.

### Business outcome

Reduce avoidable follow-up and improve intake completeness without increasing unauthorized disclosure, incorrect case classification, or missed escalation.

### KPIs

- Dispute cases by category and subcategory.
- Follow-up rate.
- Resolution and closure rate.
- SLA-breach rate.
- Repeat-complainer rate.
- Resolution time.
- Resolution satisfaction.
- Correct escalation rate.
- Safe automated-intake rate over all in-scope cases.

### Required data and grain

- `complaints`: complaint-level grain.
- `call_center_interactions`: interaction-level grain.
- `transactions`: transaction-level grain, aggregated before customer or complaint joins.
- `customers`: customer attributes only where authorized and necessary.
- `products`: product context.

### Required analysis

1. Establish complaint and interaction denominators after quality exclusions.
2. Rank dispute categories by volume, follow-up, SLA breach, and severity.
3. Link complaints to originating interactions only when the relationship is valid.
4. Link a dispute to transactions only through a defensible identifier or constrained temporal/product rule; do not infer a transaction from customer ID alone.
5. Segment outcomes by channel, country, product type, and language coverage.

### Success criteria

A workflow candidate is viable if it has meaningful demand, a clear deterministic intake boundary, explicit human-review conditions, and held-out tests for normal, ambiguous, unauthorized, and tool-failure cases.

### Constraints and unknowns

The data may not contain a direct complaint-to-transaction key. Complaint records can be open or in process, and late arrivals may affect freshness. These limitations must be reported rather than hidden.

## Outcome 2: Reduce Repeat Contact For High-Demand Service Reasons

### Business question

Which contact reasons are associated with unresolved interactions, follow-up, negative sentiment, or repeat contact within a defined window?

### Decision supported

Whether to support transactional/account inquiries as a low-risk baseline workflow or use selected reasons as clarification and routing capabilities around dispute intake.

### Customer outcome

The customer receives a relevant first response or a clear next step without repeating the same request across channels.

### Business outcome

Improve first-contact resolution and reduce avoidable handling time while preserving appropriate escalation.

### KPIs

- Contact volume by reason.
- First-contact resolution rate.
- Follow-up rate.
- Repeat contact within 7 days, if the data supports that linkage.
- Wait and handling time completeness.
- Escalation quality.
- CSAT or equivalent satisfaction measure.

### Required data and grain

- `call_center_interactions`: interaction-level grain.
- `satisfaction_surveys`: survey-level grain, aggregated carefully to interaction or customer.
- `complaints`: complaint-level outcomes when linked by `origin_interaction_id`.
- `call_transcripts`: transcript-level evidence for language or intent analysis only where available.

### Success criteria

The analysis must distinguish containment from resolution and must report denominators for automated attempts, transfers, and unresolved cases.

### Constraints and unknowns

Most interactions have no transcript, some operational fields are null, and the data dictionary's documented volume differs from the local file inventory.

## Outcome 3: Improve Digital Self-Service Completion

### Business question

Which digital journeys show errors, repeated help or account views, payment/transfer initiation without completion, or subsequent support demand?

### Decision supported

Whether a product or service workflow should use digital-context retrieval, targeted guidance, or a self-service intervention.

### Customer outcome

Customers complete supported account, payment, transfer, or product actions with fewer failed attempts and clearer recovery guidance.

### Business outcome

Increase successful digital completion and reduce avoidable contact-center demand.

### KPIs

- Session-level funnel completion.
- Error rate by event journey.
- Help-view rate.
- Payment and transfer completion rate.
- Product adoption and linked-app coverage.
- Subsequent contact rate within a defined temporal window.

### Required data and grain

- `digital_events`: session-level grain for funnel analysis.
- `products`: product-level grain.
- `call_center_interactions`: interaction-level outcomes.
- `customers`: authorized segmentation context.

### Required analysis

Aggregate events to session or customer-day before joining to service interactions. Define the funnel states before counting conversion. Validate that event timestamps and process partitions do not create leakage.

### Success criteria

A proposed intervention must demonstrate a measurable completion or contact-reduction hypothesis and must not claim causality from descriptive event sequences alone.

### Constraints and unknowns

The event data is observational. A digital event preceding a contact does not by itself establish that the event caused the contact.

## Outcome 4: Improve Campaign Targeting Without Overclaiming Causality

### Business question

Which campaign objectives, channels, segments, and products are associated with delivery, engagement, conversion, and cost differences?

### Decision supported

Whether campaign context should inform a targeting or personalization analysis, and whether a valid experiment or quasi-experimental design is possible.

### Customer outcome

Customers receive relevant, consent-respecting communications through appropriate channels.

### Business outcome

Improve qualified conversion or cost efficiency without increasing unwanted contact, complaints, or unfair treatment.

### KPIs

- Delivery rate.
- Open rate.
- Click rate.
- Conversion rate.
- Cost per delivered message.
- Cost per conversion.
- Conversion by objective, channel, product, country, and target segment.
- Post-campaign complaint or support-contact rate where a valid attribution window exists.

### Required data and grain

- `campaign_sends`: send-level grain.
- `marketing_campaigns`: campaign-level metadata.
- `customers`: consent and segment context.
- `products`: product ownership and status.
- `digital_events`: downstream engagement only with an explicit attribution design.

### Success criteria

Report descriptive associations unless treatment assignment, control groups, exposure timing, and attribution windows support a causal claim. A/B testing is not established merely because multiple campaigns or channels exist.

### Constraints and unknowns

The current data does not visibly guarantee randomized assignment or a no-exposure control population. Personalization must respect `accepts_marketing`, authorization, fairness review, and data minimization.

## Workflow Selection Gate

Before implementing an agent or a major analytical workflow, score each candidate against:

| Criterion | Required question |
|---|---|
| Demand | Is the problem frequent enough to matter? |
| Customer impact | What happens when the system is wrong or slow? |
| Business value | Which decision or cost does the analysis change? |
| Data sufficiency | Are the required fields, keys, and labels available? |
| Automation boundary | Can deterministic rules define what is safe to automate? |
| Human handoff | Can unresolved cases be transferred with useful evidence? |
| Evaluation | Can the outcome be measured on held-out cases? |
| Scope | Can the workflow be demonstrated without solving the entire bank? |

The V1 workflow is unrecognized-charge intake with human handoff, accepted in [ADR-002](../ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md) (2026-09-29). Its value remains a hypothesis to measure; the choice of workflow is decided.

## Open Questions

- Which workflow has the clearest transaction or account-level evidence for a safe tool call?
- Which outcomes can be evaluated with existing labels rather than model-based judgments?
- Which language and country segments have enough data for comparison?
- What data-quality findings materially change each KPI denominator?
- Which actions require confirmation, abstention, or human transfer?
