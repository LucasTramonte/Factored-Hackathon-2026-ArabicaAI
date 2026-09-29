# ADR-001 — Prioritize a read-only inquiry workflow for evaluation

- **Status:** Proposed — team selection remains open
- **Date:** 2026-09-26
- **Deciders:** ArabicaAI team
- **Related:** [ADR-002](ADR-002-v1-workflow-unrecognized-charge-intake.md) proposes the V1 scope the team has been building since 2026-09-27

## Context and evidence

The hackathon asks for one focused banking service workflow with a normal resolution path, an ambiguous case, human handoff, and measured safe automated resolution. The synthetic data supports several candidates but does not prove business improvement. Roberto's [exploration at commit f719428](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/blob/f7194286cfd084116cfce10bf9a2614c12c501fa/reports/2026-09-26/team-meeting-brief.md) and a separate read-only scan of the installed CSVs found:

| Observation | Reproduced denominator and interpretation |
|---|---|
| Contact demand | `Transaccional`: 240,056/686,296 interactions (34.98%); `Queja`: 117,021/686,296 (17.05%). Both are broad labels, not verified narrow intents. |
| Complaint-contact friction | `Queja` has 51,021/117,021 documented resolved flags (43.60%), 73,686/117,021 follow-up flags (62.97%), and 11,733/117,021 escalation flags (10.03%). It supplies 66,000/160,266 recorded unresolved contacts (41.18%). The resolved flag is not independently verified repeat-contact resolution; 78,788 contacts are both resolved and marked for follow-up. |
| Complaint cases | 12,297/67,095 complaints are labeled `Cargo no reconocido`. All 67,095 have blank `origin_interaction_id`, and the schema has no complaint-to-transaction key. These cannot be counted as a subset of the `Queja` contacts or linked to labeled fraud transactions. |
| Fraud labels | 4,316/4,425,008 transactions (0.0975%) have `is_fraud=True`. This is prevalence, not model performance or a measured preventable loss. |
| Gross labeled value | 3,986 labeled transactions have `Approved` status; 3,900 have a usable USD amount, totaling approximately **$6.13 million** across the dataset. Across all statuses, 4,222/4,316 have usable USD values totaling approximately **$6.67 million**. `Purchase` and `Payment` account for approximately $0.93 million of the approved total. Approval does not prove settlement, unrecovered loss, or preventability. |
| Monetary limits | Native-USD transaction `amount` was used as USD; otherwise the supplied `amount_usd` was used. The latter is blank on 2,537,456/4,425,008 rows (57.34%), including all 2,437,979 native-USD rows. The reference daily rate differs from the supplied USD conversion by over 1% on 955,218/1,886,980 comparable rows, so missing values were not filled from it. |
| Complaint monetary fields | Only 4,090/12,297 (33.3%) `Cargo no reconocido` cases have `claimed_amount`; 909/12,297 (7.4%) have `compensation_granted`; 8,221/12,297 (66.9%) lack currency. These fields do not establish fraud losses or reimbursements for labeled transactions. |

The independent scan used transaction, interaction, and complaint event dates spanning 2023-06-17 to 2026-06-18. It streamed projected CSV columns, retained the small customer dimension, and used disk-backed primary-key tracking. No blank or duplicate primary IDs were found in the five reviewed tables (`customers`, `call_center_interactions`, `call_transcripts`, `complaints`, `transactions`). Each fact retained its own analytical grain; no fact-to-fact customer join was made. Counts are observations of a synthetic dataset, not real-bank rates.

## Proposed decision

Use a **narrow, authenticated, read-only transaction/account inquiry** as the primary automated-resolution path. Demonstrate **complaint or suspicious-charge intake with human handoff** as the safety and escalation path. Investigate fraud prevention separately, after confirming label availability, feature timing, and false-positive cost. No automated blocking, refund, or fraud determination follows from these counts.

This recommendation favors a workflow that can show a verified normal resolution while retaining the high-friction complaint path. It does not claim that broad `Transaccional` contacts are already classified into supported intents, or that a handoff counts as safe automated resolution. A complete intake is a useful secondary outcome; the challenge's primary safe-resolution denominator remains all in-scope cases.

## Alternatives and consequences

- **Complaint intake as the sole primary workflow:** addresses observed service friction, but the broad label, missing linkage, and handoff-centered outcome leave the normal-resolution and financial-benefit case unproved.
- **Fraud-prevention triage as the primary workflow:** has transaction labels and gross-value scale, but lacks settlement, recovery, decision-time label, and preventability evidence. Transaction value must not be called fraud loss or savings.
- **Proposed inquiry plus handoff:** supports an honest resolution-and-escalation demonstration, but still needs narrow intent labels, authorized tools, Spanish and Portuguese cases, and held-out evaluation.

## Acceptance or revision gate

The team should select the workflow after reviewing narrow intents, safe action boundaries, and a held-out set with normal, ambiguous, unauthorized, and handoff cases in Spanish and Portuguese. Compare a fixed baseline and the proposed system on the same cases. Report safe automated resolution over all in-scope cases, attempted-automation share, unsafe outcomes, missed and unnecessary transfers, p50/p95 latency, and cost with sample sizes. Revise this ADR if better linkage or outcome evidence changes the ranking.
