

![[Workflow - Cloudflare intake.excalidraw]]


---

## Decision

Build **one** workflow end-to-end, not four: **suspicious charge / unrecognized-charge intake, with evidence retrieval and human handoff.**

The system authenticates the customer, extracts intent and filters from a natural-language message, queries `transactions` for candidate matches scoped strictly to that customer, and either asks a clarifying question or produces a structured case for a human agent. It never determines fraud, blocks a card, or issues a refund on its own.

The other three candidate workflows (general complaint intake, transaction/account inquiry, contact-center agent assist) are sketched as vertical slices on the same shared platform, same orchestration, same identity layer, same output contract, but are not the primary deliverable.

## Why this workflow

- **Volume is real and specific.** Within the 67,095 logged complaints, the two largest categories are unrecognized charge (12,297) and undue charge (12,194) , together roughly a third of all complaints, and both map directly onto this workflow's intent.
- **It has the most deterministic data path.** `transactions` has a clean, documented `customer_id` FK and a stable grain (1 row = 1 transaction). Evidence retrieval against it is easy to verify: did the agent find the right row, extract the right fields, escalate when it should have?
- **It keeps the dangerous decision out of the model.** `is_fraud` and `fraud_score` exist on `transactions`, but their computation timing and provenance are unverified , using them as a feature or letting the model act on them risks leakage and, worse, an autonomous fraud call. The architecture routes around this by design: the system finds and packages evidence, a human decides.
- **It doesn't depend on a join that doesn't exist.** `complaints.origin_interaction_id → call_center_interactions.interaction_id` is documented in the data dictionary as a foreign key, but empirically **all 67,095 complaints have it null**, schema says the link exists, the data says it never gets populated. Any workflow built on reconstructing "this call led to this complaint" is not implementable with this dataset. Suspicious-charge intake avoids the problem entirely by re-deriving evidence live from `transactions` instead of relying on a historical join.

## Why not the alternatives as primary

- **General complaint intake** has the highest raw volume (117,021 / 686,296 interactions, 17.05%) but no reliable link to a specific transaction and no clean gold-label source, its FCR figure (43.60%) and follow-up rate (62.97%) come from history, not from a workflow we control.
- **Transaction/account inquiry** is the cleanest data path of all four, but it's a read-only benchmark, not a workflow with a real decision or handoff. It's used as the deterministic baseline, not the headline deliverable.
- **Contact-center agent assist** has good joinability (`interaction_id` links interactions → transcripts → surveys cleanly) but its labels (`detected_intents`, `reason_category`) are of unverified provenance, they may already be model output, which would make them invalid as ground truth.
- **Autonomous fraud detection** was considered and rejected outright. Base rate is 0.0975% (4,316 / 4,425,008), any classifier at that prevalence needs an explicit review-budget framing, not an accuracy number, and the label/feature timing problem above makes it unsafe to build a decision path on top of it this cycle.

## Requirements

### Functional

- Extract intent + slots (date, amount, currency, merchant) from free-text customer input
- Query transactions scoped **only** to the authenticated `customer_id`, never derived from message text
- Disambiguate when multiple transactions match
- Ask a clarifying question when a required field is missing, rather than guessing
- Produce a structured handoff payload when the case isn't safely auto-resolvable
- Never autonomously declare fraud, block a card, or issue a refund
- Support Spanish (MX/CO/AR) and Portuguese

### Non-functional

- **Security** : `customer_id` always from the authenticated session; zero cross-customer access is a hard requirement, not a target
- **Safety** : no autonomous blocking, refunding, or fraud determination; `is_fraud`/`fraud_score` excluded from the decision path until provenance is confirmed
- **Reliability** : bounded tool retries, fail-closed on tool error (routes to handoff, never a fabricated answer)
- **Auditability** : every case carries `case_id`, `tool_calls`, source records, `model_version`, `timestamp`
- **Data quality** : `amount_usd` is null on 57.34% of transactions (often native-USD rows); fall back to `daily_exchange_rates` keyed on `currency`, and confirm whether `transaction_date` or `process_date` determines the applicable rate before computing anything

## Contracts

**Input**

```json
{
  "message": "I don't recognize a charge of 850 on Tuesday",
  "channel": "App"
}
```

The server derives `customer_id` and authentication status from the validated session; neither is accepted as a caller-controlled authorization field.

**Tool output** (internal — never shown raw to the customer)

```json
{
  "matches": [{
    "transaction_id": "TX456",
    "transaction_date": "2026-09-22T14:03:00Z",
    "amount": 850.00,
    "currency": "MXN",
    "amount_usd": null,
    "transaction_type": "Purchase",
    "merchant_name": "Store XYZ",
    "transaction_status": "Approved"
  }]
}
```

`is_fraud` and `fraud_score` are never included in this output.

**Handoff payload**

```json
{
  "case_id": "CASE-789",
  "customer_id": "C123",
  "intent_category": "unrecognized_charge",
  "transaction_candidates": [{ "transaction_id": "TX456", "amount": 850.00, "currency": "MXN", "merchant_name": "Store XYZ" }],
  "confirmed_facts": ["customer authenticated", "transaction located"],
  "missing_information": [],
  "risk_flags": ["customer_reported_unrecognized_charge"],
  "requested_action": "human_review",
  "workflow_status": "handed_off"
}
```

## Known data gaps

- `complaints.origin_interaction_id` : documented FK, 0% populated (0/67,095)
- No complaint ↔ transaction join key exists
- `amount_usd` null on 57.34% of transactions : needs currency-aware fallback
- `fraud_score` / `is_fraud` : computation timing unverified, kept out of the decision path
- All 171,321 transcripts are Spanish : Portuguese test cases must be authored, not mined
- 78,788 interactions are flagged both "resolved" and "needs follow-up" simultaneously : FCR definition is ambiguous in the source data
- Fraud base rate is 0.0975% : any learned component needs a review-budget metric, not accuracy

## Primary KPI

**Safe complete intake rate** = cases with a safe, complete intake outcome / all in-scope intake cases.

Guardrails, always reported with denominators: unsafe outcomes, missed/unnecessary escalation, p50/p95 latency, cost per attempt, cost per success, breakdown by language.

## Next steps

- [ ] Confirm workflow + intended-customer definition with the full team (owner: Roberto — due: TBD)
- [ ] Validate narrow suspicious-charge intents against real complaint categories with Andrés (owner: Andrés — due: TBD)
- [ ] Audit `amount_usd` normalization, currency/geography aliases, and label/feature timing before any fraud-adjacent modeling (owner: Roberto — due: TBD)
- [ ] Define baseline vs. learned intent/slot extraction on the same held-out cases (owner: Lucas — due: TBD)
- [ ] Build Spanish + Portuguese evaluation cases, since Portuguese has zero transcript coverage (owner: Andrés — due: TBD)
- [ ] Implement authenticated data/tool layer and the handoff contract above (owner: Manoella — due: TBD)
- [ ] Run the 2–4 hour spike per workflow (10–20 cases, define input, define gold output, run real queries, check joins/missingness/leakage) before committing a full week to implementation

## Open questions

- Fraud-prevention label timing
- Agent benchmarking approach
- Sentiment and accent-based routing scope
- Demographic segmentation — not yet validated, do not build on it without explicit sign-off
