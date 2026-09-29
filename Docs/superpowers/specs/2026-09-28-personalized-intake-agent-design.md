# Personalized unrecognized-charge intake agent: design

Roberto, 28 September 2026. Status: proposed, for team review. Claims the unowned AI/Agent workstream.

## 1. Product decision

One workflow, end to end: an authenticated customer reports a charge they do not recognize, confirms the transaction, and receives an accepted case reference and next steps. A human agent receives a complete handoff package. The system never decides fraud, blocks a card, or refunds.

**Differentiator: one agent, assembled per customer.** At session start the service builds a *context card* from Silver and injects it into the agent's system prompt. The card changes how the agent speaks and what it already knows about the customer. It never changes what the agent may do.

```
system prompt = fixed rules (identical for every customer)
              + context card (per customer, from Silver)
              + tools (identical, scoped to the session's customer_id)
```

This follows the team's V1 (Notion 27/09) and the intake contract in `Docs/intake/customer-and-measurement-contract.md`.

## 1a. Prerequisites and scope of this plan

- PR #8 (`feat/suspicious-charge-evaluation`: contract, 42 cases, checklist baseline, `baseline.score()`) and PR #10 (`data_profiles/fraud_readiness_findings.md`) must be merged into `main` first. Step 0 of the plan is that merge; every "Have" below assumes it.
- Andres's PR #9 (33 reviewed ES/PT cases) is used when merged; it is not a blocker.
- This spec covers **Roberto's slice**: agent service, context card, case store, guardrails, event log, evaluation runner, and the thin HTML pages needed to demonstrate them. Frontend decision: plain HTML + JS served by FastAPI, no build step. Angular (Lucas's proposal) can replace the pages later against the same API; that is a separate plan with its own owner. Deployment is also separate.

## 2. User story

As Valentina, a Basic-segment customer in Colombia logged into the bank's web app, I want to say in my own words that I do not recognize a charge and be helped by an assistant that already knows who I am, what I hold, and how I speak, so that I confirm the right transaction once, get an accepted case reference, and know what happens next.

| Step | Who | What happens |
|---|---|---|
| 1 Login | code | The session supplies `customer_id`. It is never read from message text. |
| 2 Context card | code | One DuckDB query builds the card (section 4). |
| 3 Greeting | AI | Personalized greeting in the customer's language variant, naming products held. |
| 4 Report | customer | Free text in Spanish or Portuguese. |
| 5 Retrieval | AI + code | The AI extracts amount, date, currency, merchant. Code searches only this customer's transactions. |
| 6 Clarify | AI | 0 matches: ask again. N matches: list them, ask which. 1 match: ask to confirm. Never pick by ordering. |
| 7 Approve | customer | Confirms the transaction and their statement. |
| 8 Accept | code | Case row is committed. Only then is a reference minted. Retries reuse the existing case (section 6a). |
| 9 Next steps | AI + code | Reference, what happens next, and channel. Handoff package is stored for the agent. |

Out of scope, routed with an explicit message: recognized billing disputes, account inquiries, unsupported languages, and anything not an unrecognized charge.

## 3. Personalization rules

Two layers, kept apart in code and in the prompt:

- **Style** (may vary): language variant (es-MX, es-CO, es-AR, pt-BR), currency and date format, formality, pace.
- **Content and permissions** (never vary): which tools exist, what needs confirmation, when to hand off, what is refused.

Style is a *default* set by the card, then adapted to how the customer actually writes. A customer who writes informally gets informal replies whatever their age band. The 60+ defaults are accessibility defaults, not assumptions: one question per turn, short sentences, explicit confirmation before each step, formal address (*usted* / *o senhor*), no inference of unstated details. Younger defaults: *tú* / *você*, compact, direct.

## 4. Context card

Built by one deterministic query over Silver at session start, shown in the UI's "why did it say that" panel.

| Field | Source | Used for |
|---|---|---|
| first name | `dim_customers` | greeting |
| country → variant, currency, date format | `dim_customers.country` | speaking and parsing amounts and dates |
| detected_accent, fallback country | `dim_customers` | language variant (accent is blank for ~30% of customers) |
| age_band (18–29, 30–44, 45–59, 60+) | derived from `dim_customers.date_of_birth` at session time | style defaults only |
| segment | `dim_customers` | tone only; never eligibility or priority (contract: inclusion is not by customer value) |
| products held (type, last 4 digits) | `dim_products` where `customer_id` matches | naming the right product |
| open complaints (status Open, In Process, Escalated) | `fact_complaints` | avoid duplicate cases |
| last contact reason and date | most recent row in `fact_call_center_interactions` | continuity |
| usual channel | most frequent `fact_digital_events.channel` in the last 90 days; fallback "web" | where the reply goes |

**Excluded by design:** income, credit score, `fraud_score`, `is_fraud`, marketing consent, and any risk signal. See `data_profiles/fraud_readiness_findings.md` and Andres's personalization profile.

## 5. Platform components

Ordered by rubric weight. "Have" refers to work already on `main` or in open PRs.

| # | Component | Serves | Have | Build |
|---|---|---|---|---|
| 1 | Customer chat (web, es/pt) | Functioning AI system; ES/PT demos | — | one page: login → chat → reference |
| 2 | Login and session | Controlled automation; expired-session case | — | choose a demo customer; session with expiry |
| 3 | Agent service | Functioning AI; controlled automation | checklist baseline logic; KPI contract | FastAPI: card + LLM + 3 tools (`search_transactions`, `get_open_cases`, `create_case`) |
| 4 | Case store and reference | Verified actions | — | table; two case kinds (section 6a); reference after commit; idempotent |
| 5 | Human agent console | Handoff with request, facts, actions, evidence, open questions | handoff contract | one page listing cases with the package |
| 6 | Guardrails outside the model | Controlled automation; failure handling | designed in contract | session-scoped queries; fraud fields stripped from tool output; out-of-scope refusal; tool inputs validated; fail closed to handoff |
| 7 | Evaluation runner and results page | Measured quality; baseline | 42 + 33 authored ES/PT cases; checklist baseline; KPI definitions | two layers, never mixed (section 8): decision-point scoring with the existing `baseline.score()`, and episode-level runs for safe accepted intake |
| 8 | Event log | Lineage; latency and cost | event names in contract | append-only; case_id, model version, tool calls, input and output tokens per LLM call, timestamps |
| 9 | "Why did it say that" panel | Explainability | same data | show the card and tool results behind each reply |
| 10 | Limitations page | Required by the brief | written already | no PT transcripts; 546 templated texts; no complaint→transaction key; `fraud_score` tie |
| 11 | Red-team cases | Required failure scenarios | — | ~10 cases: injection, unauthorized access, missing data, tool failure, multilingual ambiguity |
| 12 | Data pipeline page | Sound data practice | Bronze → Silver → quality | last quality run status |

Skipped: WhatsApp and voice, learned intent model, offers, cloud deployment, real OAuth, any fraud decision.

## 6. Data flow and boundaries

```
browser ── session ──▶ agent service ──▶ context card (DuckDB, read-only)
                            │
                            ├─▶ LLM (Claude)  ← rules + card + tool schemas
                            │       └─ tool calls, validated by code
                            ├─▶ search_transactions(customer_id from session, slots)
                            ├─▶ get_open_cases(customer_id)
                            └─▶ create_case(...) ──▶ case store ──▶ reference
                                                        └──▶ agent console
                            every step ──▶ event log
```

Deterministic: session, card, tool execution, case commit, reference, logging, permission checks. AI: greeting, extraction, clarification wording, next-steps wording. Human: the decision on the case.

**Who decides scope.** Every agent turn returns a structured object, not only prose: `{intent, action, slots, candidate_ids, confirmed_id, reply_text}`. `action` uses the scorer's vocabulary from `evals/intake/baseline.py`: `authenticate`, `route`, `clarify`, `confirm`, `complete_handoff`, `technical_handoff`, `incomplete_handoff`. Mapping: `unsupported` intent → `route`; accepted intake → `complete_handoff`. The LLM proposes `intent` and `action`; code checks them against the allowed actions for the current state and executes tools itself. An `unsupported` intent is an AI judgement gated by code; those episodes are logged and excluded from the intake denominator per the contract.

**Tool semantics.**
- `search_transactions(customer_id, amount?, date?, currency?, merchant?)`: `customer_id` from the session only. Date matches the calendar day, or a ±3-day window when the customer gave a relative date ("el martes"). Amount matches within 1% of `amount` in the stated currency; currency defaults to the card's country currency. Merchant is a case-insensitive substring. At most 10 candidates are returned; more means clarify. Output fields: `transaction_id, transaction_date, amount, currency, transaction_type, merchant_name, transaction_status`. `is_fraud` and `fraud_score` are never selected.
- `get_open_cases(customer_id)`: reads the case store only. If an open case already covers the confirmed `transaction_id`, the agent reports that reference instead of creating a new case (this prevents cross-session duplicates, which the session-scoped idempotency key alone does not). `fact_complaints` has no transaction key, so it feeds only the card's "open complaints" line.
- `create_case(kind, transaction_id?, customer_statement, missing_evidence?)`: only callable by code after the state machine reaches approval or a handoff condition.
- Session expiry: 15 minutes idle; the expired-session red-team case uses it.

## 6a. Cases, references and idempotency

| Kind | When | Reference | In console |
|---|---|---|---|
| `accepted_intake` | customer confirmed exactly one owned transaction and approved the statement | `CS-YYYY-NNNN`, minted after commit | yes, status `accepted` |
| `technical_handoff` | tool failure or data error, customer still present | `CS-YYYY-NNNN`, minted after commit; the customer needs a number to follow up | yes, status `incomplete`, missing evidence listed |
| `incomplete_handoff` | no confirmed match after two clarifications, customer still present | same | same |
| no case | expired session, unauthenticated, out-of-scope, or customer abandoned before approval | none | no; event log only |

Case kinds match the scorer's handoff actions one to one. Idempotency key: `sha256(customer_id, session_id, kind, transaction_id or "")`. A retry with the same key returns the existing case and reference; nothing is duplicated.

## 7. Error handling

| Situation | Behaviour |
|---|---|
| Expired or missing session | Stop before any data access; ask to log in again. |
| Tool failure or DuckDB error | No fabricated answer. Technical handoff with what is missing. |
| No match after two clarifications | Handoff with the customer's statement and search attempts. |
| Prompt injection in message | Tool arguments come from validated slots, not raw text; customer_id is fixed by session, so injected IDs cannot widen scope. |
| Duplicate submit or retry | Idempotency key returns the existing case and reference. |
| Out-of-scope request | Explicit refusal with the supported alternative; logged as unsupported, excluded from the intake denominator. |

## 8. Testing and evaluation

- Unit tests for card builder, slot parsing, transaction scoping, idempotent case creation, and the action gate.
- **Layer 1, decision points.** Each existing case is one turn with a known state. An adapter turns the agent's structured object into the output shape that `baseline.score()` requires; the plan takes the field list from `score()`'s `required` and `allowed` sets, not from prose (it includes `missing_information`, and `customer_id` only when authenticated). `score()` is extended to accept `baseline='agent'`. That is a small change to PR #8's code. Checklist and agent then share one scorer. Reports: correct next action, unsafe, missed and unnecessary handoff, by language. Gold candidate sets were authored against exact-match retrieval; the agent's 1% amount tolerance and merchant substring can surface extra candidates on decoy rows, turning a gold `confirm` into a safe but "incorrect" `clarify`. The report states this so a lower correct rate is not read as a regression.
- **Layer 2, episodes.** Scripted multi-turn conversations (Andres's 33 scenarios once merged, plus ~10 red-team scripts) run end to end against the live service with a fixed fault schedule. Each episode counts once. Reports: safe accepted intake / all eligible starts, unsafe, duplicates, handoff completeness, p50/p95, cost per attempt. Layer 1 rates are never combined with layer 2 rates.
- Andres's set is the closest thing to independently authored cases; Roberto's 42 are regression material. No target set before the first run.

## 9. Open decisions for the team

1. Case store: SQLite for the local demo unless Lucas's PostgreSQL is already running; the table is the same.
2. LLM: Claude via API, one model, version pinned in every event.
3. Owners: Roberto takes the slice in 1a. Angular replacement of the HTML pages and deployment need named owners.
