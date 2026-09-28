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
