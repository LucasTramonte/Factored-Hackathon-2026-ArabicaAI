# Assisted unrecognized-charge intake: V1 agent design

Roberto, 29 September 2026. **Status: proposed for team review.** This adds an AI-assisted conversation to the deterministic Worker/D1 intake demo in PR #17. ADR-002 remains the product boundary: the customer confirms an owned charge, a case is accepted for human review, and no fraud verdict, refund, reversal or card block is performed.

## Scope and runtime

V1 adds assisted search, clarification, confirmation and an agent-facing summary to the existing Angular client and Cloudflare Worker. The Worker owns session checks, tool execution, action gates and case writes. Its D1 database is the only online store. No request or login reads S3, DuckDB or Silver. The model proposes a structured turn; code decides which action is permitted and performs every tool call.

The first release uses the existing deterministic checklist as its baseline. A model is enabled only after an ADR names its provider, permitted data, cost envelope and held-out evaluation. This spec defines that extension, not evidence that it has shipped.

| V1 | Deferred until measured need |
|---|---|
| Session language, Spanish regional variant, date format, active-product display, source-currency transaction evidence | Age/segment tone, last contact, open complaints, usual channel, explanation panel, broad customer profile |
| Customer-scoped search, clarification, explicit confirmation, complete/technical/incomplete handoff, agent summary | Offers, fraud triage, automated dispute resolution |

## Load-time card and language

The bounded, quality-gated Gold load builds one card per allowlisted customer from typed Silver and writes it with a content version and load timestamp to D1. The Worker reads that one row per session. This is a proposed extension to PR #17's Gold slice, not a call to Silver at login. The card is a snapshot **as of its load time**, and the API reports its coverage/version; missing coverage must never be described as a missing bank transaction.

V1 card fields: a display name or first name only when the observed Silver column is present; country-derived Spanish variant (es-MX, es-CO, es-AR); date format for these three countries; and active product type plus last four digits from the observed product number. Product status is a current snapshot. The exact selected Silver columns and missing-value rules belong in the Gold mapping and its tests. The Markdown dictionary omits some observed dimension columns; the original dictionary PDF pp. 3–6 and `data_pipelines/silver/table_specs.py` document them. No age band is used until its source contract and fairness/minimisation review are accepted. Risk/value fields, `fraud_score`, `is_fraud`, income and credit score never enter the card or model prompt.

**Conversation language comes from the active session and customer messages, never the card.** A Portuguese message receives a Portuguese reply even when the card says es-MX. The card may choose a Spanish regional variant only after the session chooses Spanish. The source has no Portuguese customer or transcript population; a PT demo identity and phrases are synthetic evaluation material. Replies return through the authenticated web session, never through a historic digital channel. Currency comes from the transaction being discussed, never from country or a modal product currency.

The demo login is simulated: passing the team gate lets a reviewer choose an allowlisted synthetic customer. That is not bank authentication. Before any real-customer use, bind the session customer ID to a verified principal and enforce that binding on card, transaction, case, retry and agent paths. A model cannot select or override the customer ID. The model receives only the minimum card/evidence fields approved for its provider; provider retention, isolation and deletion terms must be reviewed before enabling the external call.

## Conversation and tools

Each turn returns `{intent, action, slots, candidate_ids, confirmed_id, reply_text}`. The action vocabulary is `authenticate`, `route`, `clarify`, `confirm`, `complete_handoff`, `technical_handoff`, `incomplete_handoff`, matching `evals/intake/baseline.py`. The Worker validates the proposed action against session state and evidence. Prompt text is never authority for tool arguments.

1. `search_transactions`: query only the active session customer's rows in D1's loaded slice. Match an amount against the **original amount in the same source currency**; a stated USD amount matches only a source-USD row. Do not use `amount_usd` or convert local currency for intake. A date refers to the transaction event date, not `process_date`. Return a bounded candidate set with transaction ID, source date, original amount/currency, merchant and status. Zero, several, or incomplete slice coverage require clarification or safe handoff, never an invented match.
2. `get_open_cases`: read the application case store for this customer. Historical `fact_complaints` has no transaction key and cannot deduplicate a reported charge.
3. `create_case`: after explicit confirmation of exactly one owned transaction and approval of the customer statement, atomically insert or reuse an open case. Enforce one open case per `(customer_id, transaction_id)` in D1 with a uniqueness constraint/index; a concurrent conflict returns the existing reference. The request idempotency key also handles same-request retries, but is not the cross-session rule. A reference is returned only after the committed row is read back. Keep the demo's UUID reference unless a separately reviewed migration changes it.

The Worker keeps sessions in D1 across instances, as PR #17 already does. V1 uses its current one-hour absolute expiry; idle expiry is a separate decision. If a write may have committed but its response is lost, retry with the same idempotency key and retrieve the stored reference. On lookup failure, disclose no invented evidence and offer a technical handoff. Never create a complete case from a singleton match alone.

## Cases and human review

| Case kind | Required evidence | Result |
|---|---|---|
| Complete intake | Authenticated owner, one confirmed transaction, source facts, approved statement | Durable reference and agent-facing summary |
| Technical handoff | Tool or coverage failure; missing evidence explicitly listed | Human review, no completed-intake claim |
| Incomplete handoff | Clarification exhausted while customer remains present | Human review with open questions |
| No case | Unauthenticated, expired, withdrawn, abandoned before approval, or out of scope | Safe route/stop |

The agent summary carries source evidence, original customer statement, actions taken, missing fields and next steps. It does not promise a refund or declare fraud. A model may draft wording; the Worker verifies status and reference from D1 before showing acceptance.

## Evaluation and observability

Layer 1 scores decision points with the existing `baseline.score()` action and evidence contract. Layer 2 runs scripted multi-turn episodes through the Worker and computes safe accepted intake over **all eligible starts** from the versioned event contract in `Docs/intake/intake-events.md`. Report ES/PT counts, unsafe outcomes, missed/unnecessary handoffs, p50/p95, actual model/tool calls and cost per attempt. Keep decision-point and episode denominators separate. Use a newly frozen unseen ES/PT set for any checklist-versus-model claim; the current `heldout` split is exposed regression material.

Tests must cover another customer's transaction, a typed customer ID in message text, ambiguous and missing matches, incomplete slice coverage, tool failure, expired session, injection, concurrent cross-session submissions, response loss after commit, and PT session with an es-MX card. The first model release requires no increase in unsafe outcomes against the checklist. Throughput and cost claims follow measured Worker runs, not synthetic contact volume alone.

## Open team decisions

1. Accept this smaller V1 against ADR-002 and PR #17, then name the owner of the Worker/model adapter.
2. Agree the Gold card columns, D1 schema/version and provider data-handling policy before sending any customer-linked context to a model.
3. Set the scripted abandonment timeout and the authoritative `handoff_accepted` producer before reporting the episode KPI.
