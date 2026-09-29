# ArabicaAI · Team meeting brief
26 September 2026 · Synthetic data · Full required-table coverage verified

**Recommendation:** discuss a narrow complaint/suspicious-charge intake and human-handoff workflow, with transactional inquiries as a lower-risk comparator. Keep fraud-prevention modeling as a separate feasibility decision.

**Three findings**

1. **Volume:** 240,056/686,296 contacts (34.98%) are `Transaccional`, with 91.51% documented FCR. The label is broad; it does not identify specific disputes.
2. **Friction:** 117,021 contacts are `Queja`. Documented FCR is 51,021/117,021 (43.60%); follow-up is 73,686/117,021 (62.97%). These contacts contribute 66,000/160,266 recorded unresolved interactions (41.18%).
3. **Fraud:** 4,316/4,425,008 transactions are labeled fraud (0.0975%). This rare target requires precision/recall and review-budget metrics; accuracy alone would be misleading. No prevention model has been evaluated.

| Candidate | Why consider it | What must be proved next |
|---|---|---|
| Complaint / suspicious-charge intake | Strong service friction; 12,297 separate complaints labeled `Cargo no reconocido` | Narrow intent labels, safe intake boundary, authenticated transaction selection and useful human handoff |
| Transaction/account inquiry | Largest contact group; potential read-only scope | Which specific intents and verified answers the data supports |
| Fraud-prevention triage | 4,316 labels for investigation | Label/feature timing, time-based validation, leakage-safe baseline and false-positive cost |

**Material limits:** all 67,095 complaints lack originating-interaction IDs; no direct complaint-to-transaction key exists. Do not combine these populations. Stored `amount_usd` is missing for 57.34% of transactions, largely because native-USD rows leave that field blank; normalize from `amount` explicitly before modeling. `fraud_score` timing is unknown. All 171,321 transcript language labels are Spanish; Portuguese cases remain necessary. Documented FCR is a supplied flag, not independently verified repeat-contact resolution.

**Leave the meeting with:** one workflow and safe boundary; one primary KPI plus baseline; owners and a next demo milestone. Proposed owners: Roberto—evidence and fraud timing audit; Andrés—intent/slot labels; Lucas—KPI/baseline/evaluation; Manoella—data/tool infrastructure. Team confirmation is still needed.

**Evidence:** 4,389 CSVs checked against S3 inventory; event dates 17 June 2023–18 June 2026. No duplicate/blank IDs found in the five analyzed tables. Twelve regression tests and full notebook execution passed. [Open the analysis](contact-center-fraud-exploration.html) or [editable notebook](contact-center-fraud-exploration.ipynb). These descriptive findings do not demonstrate reduced fraud, operational improvement or ROI.
