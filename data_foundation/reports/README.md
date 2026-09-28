# Evidence report hub

Open [the offline report hub](index.html) to review the [Marketing and Product analysis](marketing-product.html), the [corrected intake decision](intake-decision.html), and their [aggregate JSON](aggregates.json). The [manifest](manifest.json) records the verified Silver database, full quality run, source scope, table counts, and generation time. These files contain aggregate counts only and make no external requests.

## Findings to carry into a decision

- Marketing: 1,746,801 valid Silver sends; delivery is 1,642,044/1,746,801 (94.00%). Known opens are 487,309/1,262,572 delivered sends with a known open flag (38.60%). Recorded conversions are 9,799/1,746,801 sends (0.56%). These are recorded send outcomes, not independently linked purchases or incremental lift. The 379,472 unknown open flags are visible rather than counted as closed.
- Targeting checks: 8,277 sends fall outside campaign dates. Current customer consent is false for 874,417 send records, but the current snapshot cannot establish consent at send time. The target-country and target-segment mismatches are feasibility warnings, not evidence of ineffective targeting.
- Product: 339,965 products are currently active. The transaction linkage has matching owners, but 827,610/4,425,008 transactions predate their product opening date; eligible post-opening activity uses the remaining 3,597,398. Current product status and linked-app flags are snapshot measures. Activity counts include all transaction statuses; they are recorded events, not confirmed completed purchases.
- Digital: the event table has 15,620,994 records. Customer/product ownership disagrees in 1,094,226/1,094,242 identified product links, so no product-type digital usage is shown. The report presents an ordered session engagement funnel: 755,552 Navigation views, 337,895 later Product clicks, and 49,996 later Transaction form submissions. It excludes 498,785 sessions mixing anonymous and identified events. These stages do not infer acquisition from `Purchase`.
- Intake: the V1 `Cargo no reconocido` population is 12,297, including 6,192 via Call Center. The broader `Cargo no reconocido` plus `Cobro indebido` population is 24,491. SLA breach is descriptive; no complaint-to-interaction causal or time-saving claim is supported. Bronze has zero populated `origin_interaction_id` links among 67,095 complaints.

After a Silver fix, all 2,437,979 native-USD transactions have a non-null `amount_usd` with `amount_usd_is_estimated=false`; 220,501 native-USD products have no conversion gap for populated current balances. The full quality run passed 336 checks with zero errors and six warnings. The warnings include the digital product-link mismatch, complaint product-link mismatch, and pre-opening transactions used as explicit metric restrictions here. Source fields, currency and campaign attribution need further validation before any customer or financial outcome claim.

## Rebuild

After Bronze → Silver → quality completes, run from the repository root:

```bash
make report QUALITY_REPORT=data/quality_runs/<run-id>/quality_results.json
```

`make report` writes an ignored run under `data_foundation/runs/`. It requires the full ready quality report for the same DuckDB. Curated files in this directory are committed only after reconciling their totals with the JSON and inspecting the offline HTML. See [the customer-backward decision brief](../../Docs/Marketing-Product-PRFAQ.md) for the proposed controlled test.
