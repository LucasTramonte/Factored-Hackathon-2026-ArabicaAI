# Marketing and Product evidence rebuild

**Status: Concluído nesta branch.** A análise usa uma Silver verificada por 336 checks (zero erros), e os HTMLs foram reconciliados com o JSON, uma partição real e o navegador offline.

## Working Backwards decision

The bank customer should receive relevant, consent-respecting messages and complete supported digital tasks with clear recovery paths. Marketing and Product leads need evidence to decide which channels, campaigns and journeys deserve a controlled test. A proposed PR/FAQ will state the customer problem, benefit hypothesis, available evidence, hard questions and success measures. It must not imply a launched feature or a measured improvement.

## Rebuild against verified Silver data

- Use one fresh, reproducible DuckDB run from `silver.dim_customers`, `silver.dim_products`, `silver.dim_marketing_campaigns`, `silver.fact_campaign_sends`, `silver.fact_transactions` and `silver.fact_digital_events`; record Bronze/Silver quality-run identity, source scope, table counts and run timestamp. Avoid stitched aggregates from separate scans.
- Marketing: preserve valid send-grain delivery, known open/click and recorded conversion denominators. Show unknown flags, repeat exposure, current consent snapshots, campaign dates, optional target-country/segment mismatches and send-to-conversion timing. Keep out-of-window sends visible and provide a sensitivity view rather than silently dropping them. Normalize `Mexico`/`México` only for country comparisons. A `subject` containing literal `nan` is not product evidence. Do not infer causal uplift, customer-level attribution, cross-currency ROI or historical consent.
- Product: retain current-snapshot ownership and linked-app coverage. Require product-owner agreement for customer-linked facts; separate transactions before product opening. Suppress the old digital product-type chart and product-linked funnel stage: an independent CSV audit found 1,094,226 mismatches among 1,094,242 identified customer/product event links. Use ordered, interpretable session engagement stages from event type/category and action coverage; no `Purchase` event proves acquisition.
- Time: use business timestamps for event trends, with process partitions for pruning and late-arrival checks. The prior CSV audit found event-day/partition-day differences in 436,429 sends, 1,106,307 transactions and 3,930,816 digital events. Label partial years and snapshot-based opening trends.
- The separate intake dashboard must distinguish `Cargo no reconocido` (12,297) from the combined `Cargo no reconocido` + `Cobro indebido` population (24,491), use `creation_date`, and remove unsupported product segmentation, stationarity and causal SLA/hold-time claims. Its marketing targeting scores do not demonstrate V1 intake value.

## Presentation and release gate

Generate aggregate JSON, an offline Marketing/Product HTML, a corrected decision dashboard and a concise report hub from the same verified run. Every displayed metric needs a population, numerator, denominator, time basis, join grain and limitation. Remove or explicitly mark unsupported measures; no raw identifiers or external requests. Reconcile JSON and HTML, inspect both locally, run focused fixtures then controlled partitions then the full data, and push reviewed artifacts to the private branch. The corrected HTML becomes downloadable only after this gate passes.

The synthetic dataset supports descriptive exploration. It does not establish randomized controls, verified send-to-purchase attribution, a production traffic forecast, or measured customer benefit.

## Release record

The rebuilt [report hub](../../data_foundation/reports/index.html), [aggregate JSON](../../data_foundation/reports/aggregates.json) and [manifest](../../data_foundation/reports/manifest.json) come from one full Silver scan after the native-USD correction. The quality gate passed with six visible warnings. The customer-backward [decision brief](../Marketing-Product-PRFAQ.md) defines the controlled test needed before claiming benefit. The old PDF in a local untracked plans folder was not published.
