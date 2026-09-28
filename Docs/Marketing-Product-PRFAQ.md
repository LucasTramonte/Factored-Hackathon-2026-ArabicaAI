# Marketing and Product: decision brief

**Decision:** Test a complete unrecognized-charge intake with a useful human handoff. This is the team's selected V1, not a measured improvement. [Offline report](../data_foundation/reports/marketing-product.html) · [Intake counts](../data_foundation/reports/intake-decision.html) · [Aggregate JSON](../data_foundation/reports/aggregates.json) · [Run manifest](../data_foundation/reports/manifest.json)

## What matters now

1. **Test the handoff.** The supplied data contain 12,297 Cargo no reconocido complaints; 6,192 arrived through the Call Center (50.35%). There were 4,053 in 2024 and 4,118 in 2025, the two complete calendar years measured by complaint creation date. That is enough to justify testing an agent-ready report. It does not forecast production traffic or show time saved.
2. **Measure the result customers receive.** Campaigns have 9,799 recorded conversion flags on 1,746,801 sends (0.56%). The generic digital funnel has 49,996 ordered form submissions after 755,552 navigation-view sessions (6.62%). Neither records an accepted dispute case. V1 has no end-to-end success baseline or measured AI gain.
3. **Hold acquisition and targeting claims.** The records lack a verified lead-to-customer link, historical consent, bank contribution and reliable digital product ownership. CAC, LTV, true retention, channel attribution and a 3:1 LTV/CAC judgment cannot be calculated by joining the current Silver tables again.

## Start with the customer

A customer sees a charge they do not recognize. They want to identify the transaction, approve an accurate account of the problem, receive a confirmed case reference and know what the human reviewer will do next.

V1 should retrieve evidence under the authenticated customer's identity, clarify the issue, ask for approval, confirm durable backend acceptance and deliver the reference and handoff. The first release does not promise a fraud decision, refund, card block or faster resolution. The complaint-to-interaction link is absent, so call duration and SLA outcomes cannot be assigned to this intake path.

## What can we answer with today's data?

| Question | Answer from the verified snapshot | Decision limit |
| --- | --- | --- |
| Is this complaint label present across full years? | V1 had 4,053 cases in 2024 and 4,118 in 2025. The [monthly counts](../data_foundation/reports/intake-decision.html) use complaint creation date; June 2023 and June 2026 are partial. | Describes this supplied dataset, not expected production volume. |
| Do customers use the Call Center for V1 complaints? | 6,192 / 12,297 V1 complaints (50.35%) have that reception channel. | Reception channel is not a linked call transcript or proof of handoff quality. |
| Can Marketing measure campaign response? | Delivery: 1,642,044 / 1,746,801 sends (94.00%). Known opens: 487,309 / 1,262,572 delivered sends with a known open flag (38.60%). Known clicks: 97,793 / 1,642,044 delivered sends with a known click flag (5.96%). | Recorded conversion is a send flag, not verified acquisition or V1 success. Current consent is a snapshot. |
| Can Product identify safe transaction activity? | 3,597,398 / 4,425,008 transactions pass the product-owner and opening-date checks; 827,610 predate product opening. | Activity is not bank revenue or historical retention. |
| Does the digital funnel show completed intake? | No. Its ordered stages are generic navigation, product click and form submit. | 1,094,226 / 1,094,242 identified digital product links disagree with product ownership; no accepted-case event exists. |

The report's year and month filters apply to send and transaction business dates. Its 54.72% adjacent-month transaction-activity continuation is a customer-month proxy, not contractual retention. Filtered charts do not change the full-snapshot V1 counts above.

## What earns the next decision?

Instrument every eligible intake start, retrieval, clarification, approval, backend acceptance, reference delivery, failure, retry, abandonment and handoff. The primary measure is **safe accepted intake / all eligible starts**, including starts that fail or stop. Also report unsafe outcomes, duplicate cases, missing outcomes and whether an agent can use the handoff.

Compare checklist and AI on the **same held-out, human-reviewed Spanish and Portuguese case families**. Keep translations and related cases in one split. The existing component checks do not establish an end-to-end intake rate or statistical model lift. A later live A/B test needs customer-level assignment, a predefined useful effect and enough observations to estimate it.

Marketing's next useful contribution is a consent-valid message test only after a verified customer outcome and control exist. Product Analytics should start with intake-specific instrumentation. Defer attribution, personalization and targeting models until those links and a leakage-safe comparison exist.

## Data still needed

| Decision | Missing source |
| --- | --- |
| Did the customer receive an accepted case? | Stable episode ID, server-confirmed case ID and outcome events, including failure and abandonment |
| Did a lead become a customer? | Prospect ID, campaign assignment and durable lead-to-customer key with verified creation event |
| Are CAC, LTV or retention improving? | Fully loaded cost and currency, customer contribution after costs, effective-dated lifecycle and fixed cohort horizon |
| Did a channel or targeted message help? | Consent at exposure time, verified independent outcome and an assigned holdout |

The [Gold readiness request](Plans/marketing-product-gold-contract.md) specifies these source grains and checks. Gold can publish audited measures once their underlying events exist; it cannot invent them from current campaign and transaction rows.
