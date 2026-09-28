# Marketing and Product: customer-backward decision brief

**Status: Proposed test, not a launched product.** Evidence run: [private report hub](../data_foundation/reports/index.html); aggregate definitions and source counts are in its [JSON](../data_foundation/reports/aggregates.json) and [manifest](../data_foundation/reports/manifest.json).

## Customer problem

A customer should receive relevant messages only when permitted and should be able to complete routine digital tasks without confusion. The supplied synthetic data show many sends and digital events, but they do not tell us whether a campaign improved a customer's outcome or whether a `Purchase` event represents a new bank product.

## Proposed customer benefit

Test a clear, consent-respecting message and a supported digital path for one defined task. The experience should show the customer what happened, what remains to do, and how to reach a human when the task fails. Select the task and cohort with a product owner before implementation.

## Evidence available today

- Send-level delivery, open, click, and recorded conversion counts exist in Silver. Current consent and segment are snapshots; neither proves what was true at send time.
- Product ownership and linked-app flags describe the current product snapshot. Transaction activity can be associated with a product only when its owner matches and the transaction is not dated before product opening.
- Digital events can support a session engagement funnel. Product-linked event ownership is overwhelmingly inconsistent, so product-type feature usage and acquisition claims are withheld.
- The separate complaint intake case has its own population and decision path. Marketing targeting scores do not measure its value.

## Hard questions before committing to a feature

1. What exact customer task and verified backend completion event will count as success?
2. Can consent at send time, campaign assignment, control exposure, and a durable outcome link be recorded safely?
3. Which event labels and session rules reflect a real digital task, especially with anonymous events and missing `action` values?
4. What is the recovery path and what happens to customers outside the tested cohort?

## Test and acceptance measures

Instrument eligible customers, assignment, message delivery, task start, backend-confirmed completion, failure, retry, and human handoff. Define an exclusion and missingness report before launch. Compare a randomized control and treatment on verified completion and customer harm metrics, with a stated time window and one customer-level denominator. Audit consent at send time. The present report is descriptive and cannot substitute for that test.

## Unit-economics measurement contract

The current Silver snapshot cannot calculate CAC, LTV, LTV/CAC, CAC versus average ticket, lead-to-customer conversion or retention. `send_cost` and campaign `budget` are incomplete, lack a documented common currency and may overlap. A campaign objective named `Acquisition` is not a verified new-customer event. `conversion_value` is neither attributed bank revenue nor a margin series; transaction amounts are customer cash flows, not bank earnings.

For a future cohort, record an eligible lead ID and timestamp, campaign assignment, verified customer-creation event and stable lead-to-customer key. Capture fully loaded sales and marketing costs by date, channel and currency. Capture customer contribution after servicing cost, credit loss and other material costs, together with exit status and a fixed observation horizon. Then report lead-to-customer conversion, CAC, margin-adjusted LTV, LTV/CAC and payback on the **same acquisition cohort**. Treat 3:1 as a heuristic to examine alongside payback and risk, not a pass/fail target for this bank.

The current report's monthly plots use `send_date` from July 2023 through June 18, 2026. June 2026 is incomplete and conversions may arrive after a send. Delivery, opens, clicks, page views and send-level recorded conversions remain operational diagnostics. They do not settle whether the next investment belongs in lead generation, acquisition conversion or retention.

## Current workflow and modeling order

The first customer task to instrument is a read-only account/payment inquiry: verify the answer from the backend, record failure and correction, and offer handoff. A product funnel diagnostic can identify where customers stop, but its current generic PageView → Click → FormSubmit baseline does not measure inquiry resolution. The dispute population supports a separate intake-to-human test; card service and credit eligibility require their own case and policy evidence.

Start with the outcome instrumentation, then a customer-randomized A/B test of the supported journey. Campaign effectiveness and product usage should be tied to verified outcomes. Defer channel attribution, targeting and personalization models until the outcome, historical consent, assignment and holdout data exist. Set a minimum useful effect and power before the test, report an intention-to-treat difference with uncertainty and harm guardrails, and do not claim gain from descriptive response rates. See the [Gold readiness request](Plans/marketing-product-gold-contract.md) for the audited keys and new source contracts.

The offline report now filters monthly send response and owner-safe approved transaction activity by year and month. It shows adjacent-month transaction activity continuation as an **activity proxy**, never historical customer retention. Current product ownership and the digital session funnel remain full-snapshot measures outside that filter.
