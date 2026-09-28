# Marketing and Product: Gold readiness request

**Status:** proposed data contract for the data engineer and product owner. The current report reads verified Silver; this document does not authorize a new attribution or lifetime-value claim.

## Customer decision first

The selected V1 is unrecognized-charge intake with authenticated evidence retrieval, customer approval, durable case acceptance, reference and human handoff. Measure safe accepted intake / all eligible starts, including abandonment and failures. There is no case-level start-to-receipt history in Silver, so this outcome has no observed baseline or model gain. A read-only account/payment inquiry remains a comparison or future workflow, not the selected V1.

## Audited relationships in today's Bronze/Silver

| Path | Grain and key | What it can establish | Limit |
| --- | --- | --- | --- |
| `fact_campaign_sends.send_id → campaign_id → dim_marketing_campaigns.campaign_id` | One deduplicated send; one campaign catalog row | Send metadata, objective, recorded send response | No independently verified customer acquisition or control assignment |
| `fact_campaign_sends.customer_id → dim_customers.customer_id` | Many sends per current customer | Current customer snapshot and registration-date comparison | Consent, segment and status are not historical; 323,060 sends precede current registration date |
| `fact_transactions.product_id → dim_products.product_id`, then require matching `customer_id` | One transaction; one product owner | Owner-safe, post-opening transaction activity | Approved transaction amount is a customer cash flow, not bank contribution; 827,610 transactions predate product opening |
| `dim_marketing_campaigns.promoted_product` | Product-type text, not `product_id` | Campaign description | Cannot identify a purchased product |
| `fact_digital_events.session_id` | Session events | Generic ordered engagement funnel | 1,094,226/1,094,242 identified product links disagree with product owner; no verified task completion |

`send_cost` is populated on 1,484,718/1,746,801 sends and `budget` on 169/200 campaigns. Their common currency, allocation and overlap are undocumented. `conversion_value` is recorded on 9,799 sends but is not defined as bank revenue or margin. The current `customer_status` is a snapshot, so filtering by month does not recover historical retention. Joining sends to transactions on `customer_id` alone creates many-to-many exposure attribution and must not be used for CAC, LTV or campaign ROI.

## Minimal new source contracts before Gold

1. **Intake outcome event:** stable `episode_id` and accepted `case_id`, authenticated `customer_id`, transaction evidence reference, eligible start, clarification, customer approval, backend-confirmed acceptance and reference, failure, retry, abandonment, handoff and safety result. Define all eligible starts as the denominator and a fixed follow-up window. No client-controlled authentication fields. Record experiment assignment only when an experiment actually exists.
2. **Acquisition lineage:** stable prospect/lead ID, lead creation and qualification times, consent at contact, campaign assignment and non-exposure, verified new-customer event, durable lead-to-customer link and source-system version. Distinguish customer registration from an acquired customer.
3. **Economics ledger:** fully loaded sales/marketing spend by date, channel, campaign, currency and cost scope; reconcile `send_cost` with budget to avoid double count. Add bank revenue, servicing cost, credit loss and other material cost by customer and date, with currency and FX provenance.
4. **Lifecycle history:** effective-dated customer and product statuses, closure/reactivation events, and eligibility rules. A current `Active` label cannot reconstruct past retention.
5. **Channel exposure and outcome:** timestamped assignment/exposure, channel, campaign, customer/prospect key, holdout status and independently verified outcome. Preserve attribution windows and exclusions.

## Proposed Gold grains and acceptance checks

Gold is justified to publish **conformed, audited metrics after these sources exist**. It cannot create missing outcomes or financial semantics from Silver joins. Suggested outputs are `gold.fact_intake_episode` (one eligible start, including starts without accepted cases), `gold.fact_campaign_assignment` (one assigned customer/experiment/campaign), `gold.fact_verified_outcome` (one backend outcome), `gold.fact_customer_contribution_month` (one customer/currency/month), and `gold.fact_customer_lifecycle_month` (one eligible customer/month). Keep raw source values in Bronze and typed transformations in Silver.

Require unique keys, effective-date validity, immutable assignment, balance between randomized groups, explicit unknowns, owner-safe product links, reconciliation to Silver counts, currency coverage and cost-component accounting. Gold queries must use business timestamps; the `process_date` partition is not event time. Publish numerators, denominators, censoring, source lineage and contract version. If any source is absent, mark CAC/LTV/attribution/retention unavailable rather than publishing a proxy under that name.

## Statistical decision gate

Instrument the selected intake first. Freeze safe accepted intake / all eligible starts, harm guardrails, observation window and duplicate policy. Compare checklist and AI on the same held-out, human-reviewed ES/PT scenario families, grouping translations and related cases in one split. The team update reports 22/24 versus 4/24 correct-next-action component regressions; these are not integrated success rates or a powered lift estimate. If a live experiment becomes feasible, predefine a minimum useful effect and power, randomize by customer, retain all assigned eligible starts, check assignment balance and missing outcomes, and report effect size with uncertainty. A descriptive 0.56% send response or 6.62% generic funnel submit/view rate is not an intake baseline. Build targeting or attribution models only after a valid outcome, leakage-safe time split, historical consent and an incremental comparison are available.
