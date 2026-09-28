# Marketing and Product: Gold readiness request

**Status:** proposed data contract for the data engineer and product owner. The current report reads verified Silver; this document does not authorize a new attribution or lifetime-value claim.

## Customer decision first

Start with a read-only account/payment inquiry. A customer must receive an accurate answer or a safe handoff. Measure the share of eligible, assigned customers who reach a backend-confirmed answer without a wrong answer, avoidable retry or unsafe action. The present data have no case-level inquiry start or confirmed completion, so there is no outcome baseline or measured gain. The dispute-intake workflow is a separate human-handoff experiment.

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

1. **Inquiry outcome event:** stable `case_id`, authenticated `customer_id`, task type, eligible/assignment timestamp, randomized variant, start, backend-confirmed answer, failure, correction, retry, human handoff and safety result. Define one assigned customer denominator and a fixed follow-up window. No client-controlled authentication fields.
2. **Acquisition lineage:** stable prospect/lead ID, lead creation and qualification times, consent at contact, campaign assignment and non-exposure, verified new-customer event, durable lead-to-customer link and source-system version. Distinguish customer registration from an acquired customer.
3. **Economics ledger:** fully loaded sales/marketing spend by date, channel, campaign, currency and cost scope; reconcile `send_cost` with budget to avoid double count. Add bank revenue, servicing cost, credit loss and other material cost by customer and date, with currency and FX provenance.
4. **Lifecycle history:** effective-dated customer and product statuses, closure/reactivation events, and eligibility rules. A current `Active` label cannot reconstruct past retention.
5. **Channel exposure and outcome:** timestamped assignment/exposure, channel, campaign, customer/prospect key, holdout status and independently verified outcome. Preserve attribution windows and exclusions.

## Proposed Gold grains and acceptance checks

Gold is justified to publish **conformed, audited metrics after these sources exist**. It cannot create missing outcomes or financial semantics from Silver joins. Suggested outputs are `gold.fact_inquiry_episode` (one case), `gold.fact_campaign_assignment` (one assigned customer/experiment/campaign), `gold.fact_verified_outcome` (one backend outcome), `gold.fact_customer_contribution_month` (one customer/currency/month), and `gold.fact_customer_lifecycle_month` (one eligible customer/month). Keep raw source values in Bronze and typed transformations in Silver.

Require unique keys, effective-date validity, immutable assignment, balance between randomized groups, explicit unknowns, owner-safe product links, reconciliation to Silver counts, currency coverage and cost-component accounting. Gold queries must use business timestamps; the `process_date` partition is not event time. Publish numerators, denominators, censoring, source lineage and contract version. If any source is absent, mark CAC/LTV/attribution/retention unavailable rather than publishing a proxy under that name.

## Statistical decision gate

Instrument the inquiry first. Freeze the primary verified completion measure, harm guardrails, minimum useful effect, power and observation window before randomization. Randomize by customer, analyze all assigned eligible customers, account for repeat contacts per customer, check assignment imbalance and missing outcomes, then compare treatment with control using an effect size and uncertainty interval. A descriptive 0.56% recorded send response or 6.62% generic funnel submit/view rate is not an inquiry baseline. Build targeting or attribution models only after a valid outcome, leakage-safe time split, historical consent and an incremental comparison are available.
