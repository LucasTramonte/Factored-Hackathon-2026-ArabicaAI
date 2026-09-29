# Requirements traceability

Roberto, 29 September 2026. Maps every requirement in the team hub (Notion, section 3 "Initial Requirements", read 29/09) to where it is satisfied, planned, or unowned. "Done" (✅) means merged to `main`; 🟡 means in an open PR with the number given; "Planned" names the component in the design spec (PR #11, section 5) and its owner if one exists. Update this table when a PR merges or an owner changes; it is the production-readiness evidence for the final submission.

Status key: ✅ done · 🟡 in an open PR · 🔵 planned, owner named · ⚪ planned, no owner · ❌ not planned

## Functional requirements

| # | Requirement | Status | Evidence or plan | Owner |
|---|---|---|---|---|
| F1 | Users can log in securely | ⚪ | Spec component 2: demo login choosing a customer, session with expiry. No real OAuth in scope. | none |
| F2 | Users can access relevant account information | 🟡 | Context card (spec section 4): products held, open complaints, last contact. `intake_agent/context_card.py` (PR #15). | Roberto |
| F3 | Users can ask customer-service questions | 🔵 | Spec component 1: web chat, es/pt. Angular (Lucas's proposal) or plain HTML served by FastAPI. | Lucas / Roberto |
| F4 | System can retrieve permitted customer/account information | 🟡 | Session-scoped `FixtureStore.query` and ownership checks in `evals/intake/baseline.py` and `source_smoke.py` (PR #8). Production tool: spec `search_transactions`, scoped by session `customer_id`; Lucas's architecture decision (`Docs/Factored Hackathon - Arabica AI/`) assigns tools to Manoella. | Roberto (harness), Manoella (tools) |
| F5 | System can complete eligible service workflows | 🔵 | Unrecognized-charge intake end to end: spec section 2 user story, components 3 and 4. | Roberto |
| F6 | System can request confirmation before sensitive actions | 🟡 | Contract: singleton match → `confirm`; case committed only after customer approval (PR #8, spec steps 7-8). Scored by `baseline.score()`. | Roberto |
| F7 | System can escalate cases to a human agent | 🟡 | Three handoff kinds (`HANDOFFS` in `evals/intake/baseline.py` and the contract, PR #8); Andrés's handoff contract in `Docs/intake/v1_scenarios.md` (PR #9); Lucas's architecture decision assigns the handoff contract to Manoella. Console: spec component 5. | Roberto, Andrés, Manoella |
| F8 | Users receive confirmation after completed actions | 🔵 | Reference minted only after the case row commits; `handoff_accepted` event is the durable receipt (PR #13 event contract). Case store is in Roberto's slice (spec 1a); backend integration with Lucas. | Roberto, Lucas |

## Non-functional requirements

| # | Requirement | Status | Evidence or plan | Owner |
|---|---|---|---|---|
| N1 | Response time target defined | ❌ | No target set. Contract says targets come after a measured baseline. Event contract records `duration_ms`; p50/p95 in `episodes.py` (PR #13). Decide a target on 01/10 after the first measured run. | Team decision |
| N2 | Authentication and authorization implemented | ⚪ | Identity is a trusted harness input today (PR #8). Production: spec component 2 plus tool permissions in code (component 6). | none |
| N3 | Customer data protected | 🟡 | S3 read-only, credentials outside source (AGENTS.md); tool evidence limited to `EVIDENCE_FIELDS` in `baseline.py` and column projection in `source_smoke.py` (PR #8); risk fields excluded from the context card by design (PR #10 findings, spec section 4); events carry references, never customer content (PR #13). | Roberto, Manoella |
| N4 | System is traceable/auditable | 🟡 | Provenance hashes in evaluation results (PR #8); quality-run records and Silver audit (`data_foundation`); append-only event log with `case_id`, `model_version`, tool status (PR #13). | Roberto |
| N5 | System supports expected workload | ❌ | Lucas's 28/09 capacity note: dataset volume is not a traffic forecast; investigate daily/hourly peaks by interaction type before sizing. Not started. | Lucas |
| N6 | Monitoring and error handling implemented | ⚪ | Error handling designed (spec section 7: fail closed to technical handoff, idempotent retries). Monitoring: nothing planned beyond the event log. | none |
| N7 | Cost per interaction measured | 🔵 | Tokens and calls per episode in the event contract; `operating_cost` stays `null` until a price table is agreed (PR #13). Lucas's cost worksheet covers infrastructure only. | Roberto (measure), Lucas (prices) |

## Safety and extended requirements

| # | Requirement | Status | Evidence or plan | Owner |
|---|---|---|---|---|
| S1 | Transaction and action logging | 🔵 | Event contract v1 (PR #13); tool calls counted per episode. Emit calls to agree with Lucas. | Roberto |
| S2 | Audit trail | 🔵 | Event log (spec component 8) plus case storage with the customer statement and evidence references (spec component 4, section 6a). | Roberto |
| S3 | Tool permissions enforced outside the LLM | 🟡 | Harness: `decide()` authorizes lookups from session identity only, never from text; `score()` marks any foreign evidence unsafe (PR #8). Production: spec component 6. | Roberto |
| S4 | Prompt-injection handling | 🟡 | Safety split: injection in three shapes plus Andrés's V1-14, all scored, 0 unsafe on the checklist (PR #12). Agent must match. | Roberto |
| S5 | Unauthorized-access handling | 🟡 | `unauthenticated`, `expired_identity`, `foreign_confirmation`, `impersonated_staff` cases (PR #8, #12); `third_party_card` is in the held-out split (PR #12). | Roberto |
| S6 | Tool failure fallback | 🟡 | `technical_handoff` on any tool error, never invented evidence (PR #8); spec section 7. | Roberto |
| S7 | Human escalation | 🟡 | See F7. | Roberto, Andrés, Manoella |
| S8 | Data retention defined | ❌ | Nothing written. Needs a one-paragraph policy: case storage retention, event log retention, and what the demo deletes on reset. | none |

## Gaps with no owner (decide at standup)

1. **F1 / N2 login and session**: someone must own the demo login and session expiry. Without it F1, N2 and the expired-session safety case cannot be demonstrated live.
2. **N6 monitoring**: at minimum, a health endpoint and an error counter surfaced on the evaluation page.
3. **S8 data retention**: one paragraph, but it must exist for the privacy rubric.
4. **N1 response-time target**: set after the first measured run on 01/10, not before.
5. **N5 workload**: Lucas flagged it; nobody scheduled the peak analysis.

## Evidence index

| PR | What it proves |
|---|---|
| #1, #3 | Bronze/Silver pipelines and the quality gate: sound data practice, reproducibility |
| #4 | Marketing and product evidence on Bronze/Silver (Lucas) |
| #6 | Provisional transcript enrichment kept separate from original labels |
| #7 | Marketing and product measurement limits documented |
| #8 (open) | KPI contract v0.2, checklist baseline, 42 decision-point cases, strict scoring |
| #9 (open) | Personalization signal profile; 17 scenarios with ES/PT phrasings; handoff contract |
| #10 | Fraud readiness: `fraud_score` tied to the label, no label timing, fraud decisions excluded |
| #11 (open) | Design spec: one agent per customer, permissions never vary |
| #12 (open) | Held-out and safety splits, 0 unsafe on the checklist |
| #13 (open) | Event contract v1 and episode KPI scorer |
| #15 (open) | Context card module, no callers until #11 is approved |
