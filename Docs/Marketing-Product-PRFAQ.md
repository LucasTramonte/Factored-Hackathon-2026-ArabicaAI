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

## What the Monte Carlo exercise means

The observed rates are exact counts from the supplied synthetic snapshot. For each metric, I paired January 2024 with January 2025, through December, and drew 12 pairs with replacement 20,000 times. Each draw recalculates the two rates from summed numerators and denominators, then subtracts 2024 from 2025. The random seed is 20260928 for Marketing and 20260929 for Product. Only complete 2024 and 2025 enter. The [code](../data_foundation/src/marketing_product_insights.py), [source aggregates](../data_foundation/reports/aggregates.json) and [derived JSON](../data_foundation/reports/marketing-product-insights.json) reproduce the result.

**Key assumption:** the 12 observed calendar-month pairs can be reweighted as exchangeable units. Pairing months partly respects seasonality; it does not remove within-year trends, serial dependence, changing customer composition or repeated observations of the same customer. P20/P50/P80 show how the result moves when different months get more weight. P2.5–P97.5 is also just a resampling range. It is **not** a 95% confidence interval, a customer-level uncertainty estimate, a production forecast or the probability of an effect. Twenty thousand draws reduce simulation noise; they do not create 20,000 independent months.

A check without random draws supports a narrower reading. Leaving out any one month, the Product difference remains between +2.95 and +3.22 percentage points. It is +2.86 in Jan–Jun and +3.26 in Jul–Dec. For Marketing, the leave-one-month-out difference runs from -0.061 to -0.023 points, but the half-year comparison changes from -0.085 in Jan–Jun to +0.005 in Jul–Dec. The annual Marketing direction is therefore not stable across halves. These checks do not fix channel measurement or customer-cohort bias.

## Causal audit and next evidence

Using the [causal-auditor checklist](https://github.com/RobsonTigre/everyday-causal-skills/blob/main/skills/causal-auditor/SKILL.md) as an investigative review, the decisive finding is that **there is no identified intervention or counterfactual in these aggregates**. No feature rollout or campaign assignment can be linked to the measured change. Calling either difference an impact estimate would fail at the identification step.

- **Assumptions — serious for uncertainty claims:** monthly pairs may be correlated and are not a random sample of production months. Reweighting them cannot quantify generalization uncertainty.
- **Identification — blocking for impact claims:** product activity might reflect cohort mix, account age, economics or data generation; campaign response might reflect channel mix or recording changes. The current aggregate cannot separate these from an intervention.
- **Data — serious for decisions:** product-linked digital events have 1,094,226 owner disagreements among 1,094,242 identified links, and the 2024–2025 customer cohorts are not held fixed. Marketing has no historical consent or month-by-channel outcome cross-tab.
- **Statistics — serious for interval claims:** there are only 12 paired months, possibly correlated, with customers repeated across months. The percentile range must stay descriptive; it cannot stand in for a clustered or time-series confidence interval.
- **External validity — blocking for production estimates:** the dataset is synthetic and may not represent real bank customers, traffic or behavior.

The smallest credible impact test is a named customer task or message with a verified backend outcome, customer-level assignment to treatment and holdout, historical eligibility and consent, and a prespecified analysis at the assignment unit. First repair the identity and event definitions; then calculate an effect and its uncertainty from that design. The [Gold data request](Plans/marketing-product-gold-contract.md) lists the missing source grains for acquisition, contribution and lifecycle measures.
