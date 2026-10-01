# Requirements traceability

Roberto, updated 29 September 2026 (PR status refreshed by Lucas the same day). This maps the 23 requirements in the team hub's section 3, "Initial Requirements," to merged evidence, open PRs, and remaining gaps. A merged PR is evidence for the capability it actually implements, not for a broader bank production claim.

Status: ✅ on `main` · 🟡 in an open PR · 🔵 planned with owner · ⚪ missing owner or decision. PR #12 and #13 reached `main` through merged PR #16. PR #17 and PR #18 are merged, and PR #15 and the late #17 fixes reach `main` through open PR #19. Rows that cite #15 or #17 describe code that is in #19.

## Functional requirements

| # | Requirement | Status | Evidence and remaining scope | Owner |
|---|---|---|---|---|
| F1 | Users can log in securely | 🟡 | #17 has expiring, rotating demo sessions behind a team gate; customer selection is simulated. Real bank authentication remains out of scope. | Lucas |
| F2 | Users can access relevant account information | 🟡 | #17 serves own selected charges; #15 adds a load-time card with active products. Full account history is planned in `Docs/Plans/intake-roadmap.md`. | Lucas, Roberto |
| F3 | Users can ask customer-service questions | 🔵 | #17 is a deterministic charge-intake UI, not an open question channel. The smaller agent V1 is specified in #11. | Roberto |
| F4 | System retrieves permitted account information | 🟡 | #8 merged the scoped evaluation harness. #17 scopes transaction reads to the session customer; #15 snapshots a bounded card. More domains need Gold marts. | Lucas, Roberto |
| F5 | System completes eligible service workflows | 🟡 | #17 accepts an unrecognized-charge report for human review. It does not resolve a dispute or perform a safe automated resolution. | Lucas |
| F6 | System requests confirmation before sensitive actions | 🟡 | #17 requires explicit customer confirmation before case insertion; #8 evaluates the confirmation step. | Lucas, Roberto |
| F7 | System escalates cases to a human agent | 🟡 | #17 stores accepted cases and lists them in the agent view. #9 defines scenario-specific handoffs; technical/incomplete outcomes remain planned. | Lucas, Roberto |
| F8 | Users receive confirmation after completed actions | 🟡 | #17 returns a durable case reference only after insert and readback. #16 merged the corresponding event contract. | Lucas, Roberto |

## Non-functional requirements

| # | Requirement | Status | Evidence and remaining scope | Owner |
|---|---|---|---|---|
| N1 | Response time target defined | ⚪ | #17/ADR-004 records measured Worker/D1 latency, but no accepted p50/p95 target. Set a target from a repeatable run. | Team decision |
| N2 | Authentication and authorization implemented | 🟡 | #17 enforces a team gate, expiring sessions, actor roles, and own-transaction checks. Its simulated customer selection is explicitly not bank authentication. | Lucas |
| N3 | Customer data protected | 🟡 | Main has read-only S3 pipeline rules; #17 gates the demo and scopes D1 reads; #15 excludes risk, balance, contact, and identity fields from the card. Retention remains open. | Lucas, Roberto |
| N4 | System is traceable/auditable | 🟡 | Main has pipeline quality and #8 evaluation provenance. #17 records Gold seed provenance; #16 merged the episode event contract and scorer. Runtime event emission is pending. | Roberto, Lucas |
| N5 | System supports expected workload | 🟡 | #17/ADR-004 models bounded traffic scenarios and D1 limits. The bank's production traffic is undisclosed, so these are capacity scenarios rather than forecasts. | Lucas |
| N6 | Monitoring and error handling implemented | 🟡 | #17 has health, fail-closed API errors, Worker observability, and a D1 budget test. Application error counters and #16 episode events are not emitted yet. | Lucas, Roberto |
| N7 | Cost per interaction measured | 🔵 | #17/ADR-004 estimates infrastructure and an AI envelope. #16 leaves `operating_cost` null until actual usage and a price table exist. | Lucas, Roberto |

## Safety and extended requirements

| # | Requirement | Status | Evidence and remaining scope | Owner |
|---|---|---|---|---|
| S1 | Transaction and action logging | 🔵 | #16 merged the event contract; #18 adds explicit sequence order. #17 has durable case rows. The guided backend (#31) writes v2 events to D1 `intake_events` in the same batch as each state change, with a validated export; the legacy `/cases` flow emits none. | Roberto |
| S2 | Audit trail | 🟡 | #17 has case receipts and Gold provenance; #16 merged event references and scoring. No event log for the legacy `/cases` flow; guided episodes keep a per-episode service history (#31). | Lucas, Roberto |
| S3 | Tool permissions enforced outside the LLM | 🟡 | #8 evaluation and #17 D1 routes derive customer identity from the session and enforce ownership outside model text. Agent tools are not implemented. | Lucas, Roberto |
| S4 | Prompt-injection handling | 🔵 | #16 merged the safety split and unsafe-action scorer. A live agent has not yet been tested against it. | Roberto |
| S5 | Unauthorized-access handling | 🟡 | #17 tests forged/expired sessions, actor isolation, and foreign transactions; #16 merged adversarial cases. | Lucas, Roberto |
| S6 | Tool failure fallback | 🟡 | #8 harness models technical handoff; #11 specifies fail-closed runtime behavior. The guided backend (#31) ends a failed owned-transaction lookup in a durable technical handoff (`technical_failure`, `tool_status: failed`) and keeps acceptance unknown (503, same-key retry) when storage or read-back fails. A bounded lookup retry and agent tool calls are not implemented. | Roberto |
| S7 | Human escalation | 🟡 | #17 accepts reports into an agent queue. #9 scenarios define further handoff types; assignment and resolution history remain planned. | Lucas, Roberto |
| S8 | Data retention defined | 🟡 | ADR-004 keeps demo activity with no age-based deletion until judging ends, allows a reset of demo activity before a recorded demo, purges expired sessions at login, and shuts everything down after 2026-10-20. Guided intake episodes, turns, events and handoffs follow the same retention. Deletes follow foreign-key order through `back-end/scripts/reset-demo-activity.sql`, which is unit-tested (the old cases-and-sessions recipe fails since migration 0004), and the event export is documented. Still open: team acceptance, a guard against running the reset before the final export, and segmented exports above 10,000 episodes. | Lucas, team acceptance |

## Decisions still needed

1. **N1:** set a measured p50/p95 target after the first repeatable end-to-end run.
2. **S8:** define retention and reset behavior for cases, sessions, and future event logs.
3. **F1/N2:** choose whether bank-grade identity is required for the hackathon demonstration; the current demo identity is intentionally simulated.
4. **F5:** decide when a normal, safely automated resolution path is needed; #17/ADR-002 records zero such resolutions in V1.
5. **N7:** choose a price table and measure actual usage before reporting cost per interaction.
6. **Learned component:** the brief requires at least one learned component evaluated against a baseline. The ADR-002 trigger is met (checklist 15/25 on `v1_authored`). Extractor v1 ([ADR-006](ADRs/ADR-006-learned-extractor-workers-ai.md), Proposed) exists offline in `intake_agent/extractor/` and is scored against the checklist with `evals/intake/run.py` on the development split. It is not pre-registered or scored on `frozen_es_pt_v1`, and the Worker does not call it (ADR-002).
7. **Submission:** submissions close on 2026-10-05 (kickoff deck, p. 6). The package is a public repository named `factored-hackathon-2026-[team name]`, the deployed link, 4–6 slides and a mandatory short demo and architecture video (p. 18).

## Evidence index

| PR | Evidence |
|---|---|
| #1, #3 | Bronze/Silver pipeline and quality gate on `main` |
| #8 | Evaluation harness and scoped decision-point cases on `main` |
| #9 (open) | Personalization profile and ES/PT scenarios; reviewer fixes pushed |
| #19 (open) | Context cards (#15), late #17 review fixes, D1 migration deploy guard, corrected submission dates |
| #10 | Fraud-data readiness and label limitations on `main` |
| #11 (open) | Smaller Worker/D1 agent V1 spec; load-time card and atomic dedupe |
| #12, #13 → #16 (merged) | Safety and authored scenario splits, event contract, episode KPI scorer on `main` |
| #18 (merged) | Explicit event sequence, pending safety/usage, and `v1_authored` split name on `main` |
| #15 (merged into the intake branch; reaches `main` via #19) | Minimal card built by Gold and read from D1 at session start |
| #17 (merged) | Worker/D1 intake demo, Gold slice, session and case flows, capacity and cost on `main`; its late review fixes are in #19 |
