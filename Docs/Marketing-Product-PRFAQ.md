# Marketing and Product: customer-backward decision brief

**Status: Team-selected V1 workflow; Marketing/Product analysis remains exploratory.** Evidence run: [private report hub](../data_foundation/reports/index.html); aggregate definitions and source counts are in its [JSON](../data_foundation/reports/aggregates.json) and [manifest](../data_foundation/reports/manifest.json).

## Customer problem

A customer reporting an unrecognized charge needs to identify the right transaction, approve an accurate account of the issue, receive a confirmed case reference, and know what happens next. The team selected this narrow intake and human-handoff workflow for V1. The supplied marketing and digital records do not show whether campaigns or existing features improve that journey.

## Proposed customer benefit

The V1 path is authenticated retrieval → clarification → customer approval → accepted case → reference and next steps for human review. Verify transaction ownership, create a reference only after durable acceptance, prevent duplicates on retry, and record failures and abandonment. It does not decide fraud, issue refunds, block cards or claim automated dispute resolution.

## Evidence available today

- Send-level delivery, open, click, and recorded conversion counts exist in Silver. Current consent and segment are snapshots; neither proves what was true at send time.
- Product ownership and linked-app flags describe the current product snapshot. Transaction activity can be associated with a product only when its owner matches and the transaction is not dated before product opening.
- Digital events can support a session engagement funnel. Product-linked event ownership is overwhelmingly inconsistent, so product-type feature usage and acquisition claims are withheld.
- The selected intake population is 12,297 `Cargo no reconocido` complaints, 6,192 through Call Center. Those descriptive counts justify testing a useful handoff, not an adoption rate, customer benefit or SLA improvement. Marketing targeting scores do not measure its value.

## Hard questions before committing to a feature

1. What confirms authenticated ownership, customer approval and durable case acceptance?
2. How are ambiguous transactions, missing data, duplicate retries and tool failures handled?
3. Which intake-specific events and customer-level denominators will capture every start, including abandonment?
4. Can the receiving agent use the handoff, and can the customer see the reference and next steps?

## Test and acceptance measures

Instrument every eligible intake start, retrieval, clarification, customer approval, durable acceptance, reference delivery, failure, retry and handoff. Primary V1 measure: safe accepted intake / all eligible starts, including failures and abandonment. Report unsafe outcomes, duplicates, handoff completeness, latency and missing assessments. Compare checklist and AI on the same independently reviewed, held-out Spanish/Portuguese scenario families; keep the reported 22/24 versus 4/24 correct-next-action component regressions separate from end-to-end intake results. A later live A/B test needs its own assignment, control and power plan. Handoff is not safe automated dispute resolution.

## Unit-economics measurement contract

The current Silver snapshot cannot calculate CAC, LTV, LTV/CAC, CAC versus average ticket, lead-to-customer conversion or retention. `send_cost` and campaign `budget` are incomplete, lack a documented common currency and may overlap. A campaign objective named `Acquisition` is not a verified new-customer event. `conversion_value` is neither attributed bank revenue nor a margin series; transaction amounts are customer cash flows, not bank earnings.

For a future cohort, record an eligible lead ID and timestamp, campaign assignment, verified customer-creation event and stable lead-to-customer key. Capture fully loaded sales and marketing costs by date, channel and currency. Capture customer contribution after servicing cost, credit loss and other material costs, together with exit status and a fixed observation horizon. Then report lead-to-customer conversion, CAC, margin-adjusted LTV, LTV/CAC and payback on the **same acquisition cohort**. Treat 3:1 as a heuristic to examine alongside payback and risk, not a pass/fail target for this bank.

The current report's monthly plots use `send_date` from July 2023 through June 18, 2026. June 2026 is incomplete and conversions may arrive after a send. Delivery, opens, clicks, page views and send-level recorded conversions remain operational diagnostics. They do not settle whether the next investment belongs in lead generation, acquisition conversion or retention.

## Relationship to the chosen V1 workflow

The 27 September team update describes the selected V1 as **unrecognized-charge intake with confirmed case acceptance and human handoff**. [The intake architecture decision](Factored%20Hackathon%20-%20Arabica%20AI/Architecture%20decision%20%E2%80%94%20suspicious%20charge%20intake.md) specifies the same scope. Earlier [ADR-0001](ADR-0001-workflow-prioritization.md) proposed a read-only inquiry as the primary automated-resolution path; that proposal is not the build priority stated in the team update. A read-only account/payment inquiry is a useful deterministic comparison or future workflow, not a parallel V1.

| Analysis | Direct relevance to V1 | Decision now |
| --- | --- | --- |
| Product adoption and usage | Current ownership and owner-safe transactions support authenticated evidence retrieval; snapshot adoption does not establish dispute intent. | Use validated retrieval fields and chronology; do not segment intake by invalid complaint-product links. |
| Digital funnel and feature usage | Generic PageView → Click → FormSubmit events cannot be rebranded as intake starts or accepted cases; product-linked event ownership is inconsistent. | Instrument intake-specific start, confirmation, approval, acceptance, retry and handoff events. This is the first Product Analytics contribution. |
| Campaign effectiveness and A/B tests | Historical send response has no verified link to a dispute case or safe accepted intake. | Do not use 0.56% send conversion as V1 success. First compare checklist and AI on held-out reviewed cases; consider a live customer experiment only after the service and outcome logging exist. |
| Channel attribution, personalization and targeting | No historical consent or reliable campaign-to-intake outcome link; the current complaint-product links fail ownership checks. | Defer models. Marketing may later test consent-valid education or status messages with a separate outcome and control, without claiming a gain in the V1 intake. |

The next milestone is one end-to-end accepted case plus ambiguous and tool/data-failure demonstrations. Measure the full workflow on held-out cases afterward. The meeting's 22/24 checklist and 4/24 handoff-only figures are **component** results; the 24 newer candidate cases were unscored, so neither figure estimates V1 safe accepted intake or a statistical model gain. The offline report's year/month filters describe historical sends and transaction activity, not historical intake outcomes. CAC/LTV work and the [Gold readiness request](Plans/marketing-product-gold-contract.md) remain separate future data needs.
