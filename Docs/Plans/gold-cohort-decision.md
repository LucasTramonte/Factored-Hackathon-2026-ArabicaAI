# Gold serving cohort: decision proposal

- **Status:** Draft proposal. The cohort is Manoella's decision ([online completion design](../superpowers/specs/2026-09-29-intake-online-completion-design.md)), and nothing here is accepted yet.
- **Date:** 2026-09-30
- **Deciders:** Manoella R (owner), Lucas Tramonte, Roberto Z
- **Related:** [ADR-003](../ADRs/ADR-003-intake-single-runtime-worker-d1.md), [ADR-004](../ADRs/ADR-004-intake-capacity-and-cost.md), [ADR-005](../ADRs/ADR-005-evaluation-data-protocol.md), [Gold slice](../../data_pipelines/gold/README.md), [freshness policy](freshness-policy.md), [roadmap phases 2 and 4](intake-roadmap.md)
- **Evidence:** [DF-020](../../DATA_QUALITY.md#df-020-cohort-sampling-frame-by-country-and-segment), findings run `20260930T214611Z` on the full Silver build (quality run `20260929T231714Z`: ready, 0 errors).

Today the Gold slice serves at most 100 approved purchases from a single business day, for 1 dataset customer. The rest of the demo runs on 2 fictitious customers. This note proposes how to replace that with a real cohort of customers. It answers the PR #17 questions that Lucas's scale plan of 29 September left open, using measured data rather than averages.

## Proposal

1. **Frame (who can be chosen).** A customer from the `dim_customers` snapshot with at least one approved purchase before 2026-01-01. That gives **82,097 customers**. Every one of their 842,103 design-window purchases is on a card the customer owns: `purchases_off_owner` is 0 in every cell.
2. **Size.** **1,000 customers**, with quotas proportional to country × segment and assigned by largest remainder (table below). The frame's mix is Mexico 49.9 / Colombia 30.2 / Argentina 19.9 and Basic 59.9 / Plus 25.0 / Premium 10.2 / Student 5.0. That is the 50/30/20 and 60/25/10/5 split in the scale plan, now measured.
3. **Oversampling on purpose.** In each cell, half the quota (502 in total) comes from customers with at least one `Cargo no reconocido` complaint before 2026-01-01, and the other half from customers without one. In the frame only **6.77%** of purchasers have such a complaint, so the cohort holds about **7× the natural share**. The rate is flat across segments (6.6–7.4%) and countries, so oversampling doesn't skew any segment (consistent with DF-010).
4. **Served rows.** Serve every approved purchase of each cohort customer across the full source history, 2023-06-17 → 2026-06-18. Each customer has 12.1 on average (p50 10, p90 22, maximum 64), so **about 12,100 rows**. For 11.9% of customers the first page of 20 shows `has_more`. Amounts, currency and timestamps are served exactly as in Bronze, as today.
5. **Selection is reproducible.** Order customers within each cell by `sha256(customer_id || seed)`, with the seed written in the manifest, and take the quota. Random draws in SQL are not used. The manifest records per-cell frame counts, quotas and the number actually selected, and it reconciles each cell's served rows to Silver by `transaction_date`.

| Country | Basic | Plus | Premium | Student | Total |
|---|---|---|---|---|---|
| México | 298 (149) | 126 (63) | 51 (26) | 25 (12) | 500 |
| Colombia | 181 (90) | 75 (38) | 31 (16) | 15 (8) | 302 |
| Argentina | 119 (60) | 50 (25) | 19 (10) | 10 (5) | 198 |
| **Total** | 598 | 251 | 101 | 50 | **1,000** |

The number in brackets is how many customers with an unrecognized-charge complaint the cell takes. The smallest supply is 68 complainers for Argentina/Student, which needs 5, so every cell can be filled.

## Why these choices

- **Only design-window facts pick the cohort (ADR-005).** Both membership and the complaint flag use business timestamps before 2026-01-01. The served rows do include 2026 purchases, because the newest charges are what a customer would recognize. But serving a row is not designing: nothing is tuned against the cohort, and the frozen evaluation uses its own fixtures, not D1.
- **Proportional quotas keep the demo honest.** A proportional sample looks like the dataset in every country and segment. The complaint oversample is the only deliberate distortion, and it is stated once, in the manifest.
- **Complaints can't choose the charge.** Linking a complaint to a transaction works at customer level only (DF-002, DF-003). The flag says "this customer disputed something", never which purchase it was.

## What it means for the product and the metrics

- **No metric is computed over the cohort.** Its complaint share is set by design, and 1,000 split across 12 cells leaves only 10 customers in the smallest one. The cohort is for demonstrating, not measuring.
- **Mexico is half the demo, and it is all USD** (DF-005). The UI and the recorded demo should show at least one Colombian (COP) and one Argentine (ARS) customer.
- **Card identity stays unresolved for some customers.** About a third of credit-card holders have more than one credit card (DF-013). The context card already carries the last four digits.

## Load and capacity (estimates, to be measured before any remote load)

- **Rows written:** about 12,100 transactions plus one `sample_provenance` row each, and 1,000 customers and 1,000 context cards, with index writes counted. At about 5 writes per served purchase that is **about 65,000 rows written**. That fits the Free limit of 100,000 a day, but not with that day's demo traffic on top. **Load it on its own day,** after measuring the real figure on a fresh local D1 with the budget method (ADR-004, implementation notes).
- **Size:** about 12,100 × 214 B for transactions (ADR-004), plus provenance and cards: an estimated **3–5 MB**, far below 500 MB.
- **After the load**, S3-level traffic (34,356 rows written a day, ADR-004) fits Free. Loading every customer (996,168 purchases) still requires Workers Paid (ADR-004 §2).
- **Correction to the scale plan:** it estimated 6.6 purchases per customer. That averages over all 150,000 customers, including the 45% with no purchase at all. The cohort requires at least one purchase, so it carries about 12 per customer.

## Work this needs (roadmap phases 2 and 4)

- **Gold (`data_pipelines/gold/intake_slice.py`).**
  - Today it takes one business day, 1–100 rows and the allowlisted customers only. It needs cohort selection, a served window instead of a single day, and a row cap sized to the cohort.
  - `check_quality_gate` requires the transactions watermark to *equal* the business day. For a cohort it must instead require a watermark at least as late as the last served business day ([freshness policy](freshness-policy.md), rule 3).
  - It also needs a full quality run, not a focused one, so that the relationship checks run.
- **Identity.** `back-end/src/config/identities.json` holds 3 entries, and the Worker and Gold both read it. The cohort needs either 1,000 allowlisted entries or a separate cohort allowlist that the Gold build generates and the Worker trusts. Login also needs a picker that works with 1,000 people, for example by country and segment. This is Roberto's front-end scope.
- **Seed size.** A D1 statement is limited to 100 KB, so the seed must emit one statement per row, as it does now, and the load must be checked against the limits. It is not split into daily chunks, because one day's quota is enough.
- **Tests.** Add a fixture with several cells: quotas, the hash ordering, the design-window flag (a holdout complaint must not change membership), and reconciliation to Silver.

## Decisions requested

1. Frame and size: 1,000 customers with at least one design-window purchase. **Proposed: accept.**
2. Complaint oversample: half of each cell. **Proposed: accept**, stated in the manifest, with no metric computed on the cohort.
3. Served window: full history. **Proposed: accept.** The alternative, a recent window, would leave some customers with an empty list.
4. Identity mechanism: a generated cohort allowlist, or growing `identities.json`. **Proposed: a generated allowlist**, with the Worker reading the same file. This needs a small ADR-003 note.
5. The selection seed value, and who approves the manifest before `--remote`.

## Reproduce

```bash
make findings                                   # or, for this query only:
.venv/bin/python -m data_profiles.findings.run_findings --only DF-020
```

The quota table follows from DF-020's `purchasers` and `purchasers_with_cnr` columns using largest remainder. The full-history row counts (12.1 average, p50 10, p90 22, maximum 64, 11.9% over 20) come from a one-off aggregate query on the same build. It joins design-window purchasers 1:1 to their full-history purchase counts, and it is not yet a committed finding.
