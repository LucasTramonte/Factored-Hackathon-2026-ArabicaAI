# Marketing and Product: what the data can support

This is an analysis of the [verified synthetic-data snapshot](../data_foundation/reports/aggregates.json), not a measurement of real bank customers. [Open the offline report](../data_foundation/reports/marketing-product.html) · [Inspect the simulation output](../data_foundation/reports/marketing-product-insights.json) · [Check source and quality provenance](../data_foundation/reports/manifest.json).

## Takeaways for a decision

1. **Product has a behavioral signal worth investigating.** Among customer-months with approved, owner-matched, post-opening transaction activity in the previous month, 361,660/683,195 had activity again in 2024 (52.94%); 429,338/766,683 did in 2025 (56.00%). All 12 matched calendar months were higher in 2025. Resampling month pairs gives P20/P50/P80 changes of +2.88/+3.08/+3.25 percentage points. This is continuity of recorded activity. Cohort mix and causes remain unknown; it is not contractual retention or an app-feature effect. The next question is whether the same customer cohorts can complete a specific digital task reliably.
2. **Current product-linked digital events cannot answer that question.** Product ownership disagrees on 1,094,226/1,094,242 identified digital product links. Another 827,610/4,425,008 transaction rows predate their linked product's opening date. The generic Navigation view → Product click → Transaction form submit sequence has no verified task-completion event. Fix identity and outcome tracking before ranking features, product adoption or digital drop-off.
3. **Marketing channel comparisons need an audit.** WhatsApp and Voice account for 403,673/1,746,801 sends (23.11%) and 379,472 delivered records, yet neither channel has a known open or any recorded click or conversion. Across all campaigns, 874,417 sends went to customers currently marked opted out, and 1,746,801 sends reached 150,000 customer IDs: 11.65 sends per exposed customer on average. Current consent cannot establish consent at send time; these counts do not prove a violation, fatigue or channel failure.
4. **The annual campaign response change is not a clear business decline.** Recorded conversion flags fell from 3,309/591,033 sends (0.560%) in 2024 to 3,057/587,927 (0.520%) in 2025, a change of -0.040 percentage points. Paired-month resampling gives P20/P50/P80 changes of -0.068/-0.040/-0.013 points; its wider P2.5–P97.5 range is -0.103 to +0.025 points. Zero is inside that range, and the current aggregate has no month-by-channel mix to explain the change. These flags do not identify acquired customers or incremental campaign value.

## Which use cases deserve discovery?

| Candidate | What this dataset contributes | Minimum next evidence |
| --- | --- | --- |
| Product: digital task completion and repeat activity | A consistent rise in adjacent-month transaction activity; generic session stages | Stable customer cohorts, repaired product ownership, a named task, backend-confirmed completion and error events, plus customer or agent review |
| Marketing: relevant, consent-respecting contact | Send volume, repeated exposure and a channel-measurement discrepancy | Consent and segment at send time, frequency by customer, channel-specific outcome definitions, a verified customer outcome and a holdout |

I would start Product discovery with **one task that customers need to finish**, and Marketing work with **measurement and consent history**. Neither current analysis justifies a personalization model, channel budget shift, CAC/LTV claim or causal attribution. These are separate opportunities from the team's selected unrecognized-charge intake workflow; the [intake evidence](../data_foundation/reports/intake-decision.html) answers a different question.

## How to read the simulation

For each measure, we paired January 2024 with January 2025, and so on through December. Each of 20,000 Monte Carlo draws resampled 12 month pairs with replacement, then recomputed each year's rate from summed numerators and denominators. The seed is 20260928; the [output JSON](../data_foundation/reports/marketing-product-insights.json) records exact values and settings. The P20/P50/P80 figures describe sensitivity to which months are represented. They are **not** customer-level confidence intervals, forecasts or evidence of causality. Customer-months overlap, sends repeatedly reach the same customers, and the dataset is synthetic.

To claim that a message or feature helps, define the customer outcome first, validate its event and linkage, then compare assigned groups or another defensible counterfactual. A large send count cannot repair a missing outcome. The [Gold data request](Plans/marketing-product-gold-contract.md) lists missing source grains for acquisition, contribution and lifecycle measures.
