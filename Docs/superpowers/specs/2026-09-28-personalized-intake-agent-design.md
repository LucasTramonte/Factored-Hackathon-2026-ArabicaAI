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
| 8 Accept | code | Case row is committed. Only then is a reference minted. Retries reuse the existing case. |
| 9 Next steps | AI + code | Reference, what happens next, and channel. Handoff package is stored for the agent. |

Out of scope, routed with an explicit message: recognized billing disputes, account inquiries, unsupported languages, and anything not an unrecognized charge.

## 3. Personalization rules

Two layers, kept apart in code and in the prompt:

- **Style** (may vary): language variant (es-MX, es-CO, es-AR, pt-BR), currency and date format, formality, pace.
- **Content and permissions** (never vary): which tools exist, what needs confirmation, when to hand off, what is refused.

Style is a *default* set by the card, then adapted to how the customer actually writes. A customer who writes informally gets informal replies whatever their age band. The 60+ defaults are accessibility defaults, not assumptions: one question per turn, short sentences, explicit confirmation before each step, formal address (*usted* / *o senhor*), no inference of unstated details. Younger defaults: *tú* / *você*, compact, direct.

## 4. Context card

Built by one deterministic query over Silver, cached for the session, shown in the UI's "why did it say that" panel.

| Field | Source | Used for |
|---|---|---|
| first name | `dim_customers` | greeting |
| country → variant, currency, date format | `dim_customers.country` | speaking and parsing amounts and dates |
| detected_accent, fallback country | `dim_customers` | language variant (accent is blank for ~30% of customers) |
| age_band (18–29, 30–44, 45–59, 60+) | `dim_customers` | style defaults only |
| segment | `dim_customers` | tone only |
| products held (type, last 4 digits) | `dim_products` where `customer_id` matches | naming the right product |
| open complaints | `fact_complaints` | avoid duplicate cases |
| last contact reason and date | `fact_call_center_interactions` | continuity |
| preferred channel | `fact_digital_events` | where the reply goes |

**Excluded by design:** income, credit score, `fraud_score`, `is_fraud`, marketing consent, and any risk signal. See `data_profiles/fraud_readiness_findings.md` and Andres's personalization profile.

## 5. Platform components

Ordered by rubric weight. "Have" refers to work already on `main` or in open PRs.

| # | Component | Serves | Have | Build |
|---|---|---|---|---|
| 1 | Customer chat (web, es/pt) | Functioning AI system; ES/PT demos | — | one page: login → chat → reference |
| 2 | Login and session | Controlled automation; expired-session case | — | choose a demo customer; session with expiry |
| 3 | Agent service | Functioning AI; controlled automation | checklist baseline logic; KPI contract | FastAPI: card + LLM + 3 tools (`search_transactions`, `get_open_cases`, `create_case`) |
| 4 | Case store and reference | Verified actions | — | table; reference after commit; idempotent by (customer, transaction, statement hash) |
| 5 | Human agent console | Handoff with request, facts, actions, evidence, open questions | handoff contract | one page listing cases with the package |
| 6 | Guardrails outside the model | Controlled automation; failure handling | designed in contract | session-scoped queries; fraud fields stripped from tool output; out-of-scope refusal; tool inputs validated; fail closed to handoff |
| 7 | Evaluation runner and results page | Measured quality; baseline | 42 + 33 authored ES/PT cases; checklist baseline; KPI definitions | run checklist and agent on the same cases; report safe accepted intake, unsafe, missed and unnecessary handoff, p50/p95, cost, by language |
| 8 | Event log | Lineage; latency and cost | event names in contract | append-only; case_id, model version, tool calls, timestamps |
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

- Unit tests for card builder, slot parsing, transaction scoping, idempotent case creation.
- Same authored ES/PT case set for checklist and agent (Roberto's 42, Andres's 33 once merged, ~10 red-team). Andres's set is the closest thing to independently authored cases; the rest is regression material.
- Report per the contract: counts and denominators by language; zero unsafe as a gate; p50/p95 and cost per attempt. No target set before the first run.

## 9. Open decisions for the team

1. Stack: Lucas proposed Angular + FastAPI + PostgreSQL. A single-page chat and console could ship faster with plain HTML or a minimal React page; the backend stays FastAPI either way.
2. LLM: Claude via API, one model, version pinned in every event.
3. Owner: Roberto proposes to own the agent service, evaluation runner and guardrails; UI and deployment need a named owner.
