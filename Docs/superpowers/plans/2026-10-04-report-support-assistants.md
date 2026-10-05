# Report Support Assistants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make report conversations understandable, accelerate human replies, and answer bounded customer questions without inventing actions or outcomes.

**Architecture:** Retain Angular → Cloudflare Worker → D1. Add factual status help to the existing report view, then one bounded Vertex draft operation for reviewers and one intent-classification operation for customers. Human messages retain their existing storage and delivery paths; AI results are transient and separately labeled.

**Tech Stack:** Node 22+, existing Angular, Worker JavaScript, D1, Vertex workload identity federation; no new runtime or framework.

**Spec:** [Approved design](../specs/2026-10-04-report-support-assistant-design.md). User approved the design on October 4, 2026. This execution plan still requires review before implementation/model activation.

## Global constraints

- The only online runtime is the Worker; SQL stays in `back-end/src/store/d1.js`.
- Separate switches for reviewer assist and customer assist; both default off. Phase 1 has no model dependency.
- No generated HTML, no arbitrary URL fetches, no money movement, no automatic closure and no “fixed/refunded” claim unsupported by stored facts.
- Operational logs contain references, outcomes, latency, token usage and prompt/model version; never statements, messages, drafts, tokens or customer identifiers.
- No new runtime, agent framework, vector database, web search, fine-tuning, streaming transport or WebSockets for the initial release.
- Preserve existing session separation, report ownership, 50-message/2,000-code-point human-thread limits, read-only closure, retry idempotency, email privacy and extraction behavior.
- Synthetic-demo activation only. Broader case text is a new model-input scope requiring the proposed ADR's approval; existing extraction approval is not permission for it.

## Review focus

1. A report closes or receives a new message during generation: discard stale results and prevent a stale assisted send (Tasks 3–5).
2. Logout, identity/report change or language change during an outstanding request: clear AI state and discard its late response (Tasks 1, 4, 5).
3. Customer text contains instructions, HTML, another report's reference or a refund demand: treat it as untrusted content, never authority or executable tools (Tasks 2, 3, 5, 6).
4. Provider timeouts or repeated/concurrent clicks: retain manual support, bound billing and do not duplicate messages or calls for one request ID (Tasks 2–5).
5. A saved message, unsaved draft and automated status answer look similar: label authorship and persistence accurately at narrow widths and for screen readers (Tasks 1, 4, 5).

## Execution and PR sequence

One coordinator holds the source briefing. One coder per task, strictly sequential; independent spec review then quality review after each task, maximum three correction rounds. Each brief includes the approved spec, this plan, exact file ownership, consumed/produced interfaces and test evidence. Never revert another worker's changes.

Three phase PRs: Tasks 1; Tasks 2–4; Tasks 5–6. Create each branch from current `main` after the prior phase merges; do not rebase or force-push reviewed branches. The existing design branch contains documentation only and is not a production feature branch.

Before opening each PR: Conventional Commit title, type label (plus accessibility for UI work), author assignee, another teammate reviewer, next open version milestone resolved from CONTRIBUTING.md/GitHub. Attach every PR to this chat. Humans review/merge and approve activation. The normal green-main pipeline deploys. Verify the live deployment version and app after every merge; do not manually upload local development assets.

## Fixed interfaces and limits

These values are proposed release constraints for review with this plan, not measured performance claims.

- `Language = 'es' | 'pt' | 'en'`; `Snapshot = { status: 'received' | 'in_review' | 'closed', message_count: number }`. The existing append-only message limit makes count a monotonic snapshot within a report; status transitions are forward-only.
- `ASSIST_REVIEWER_ENABLED` and `ASSIST_CUSTOMER_ENABLED`: exactly `'1'` enables each path; absence/off means disabled.
- One generation attempt per UUID `request_id`, one call maximum, 10,000 ms overall deadline including authentication and provider time. No automatic retries. A deliberate retry uses a new request ID and consumes its own budget.
- Shared assistant cap: 200 reserved attempts per UTC day; per session and feature: at most 5 in a rolling minute. Failed/abandoned calls retain their slot. Existing extractor cap remains separate. Count missing provider usage as unknown, not zero.
- Reviewer input: original statement up to 2,000 code points, details up to 2,000, newest 8 human messages with a combined 4,000-code-point ceiling (truncate oldest selected content first), total dynamic text at most 8,000 code points. Preserve author labels/order and return `context_truncated`. Do not include unrelated customer history or transaction lists.
- Reviewer output: `{summary: string, missing_fields: Field[], draft: string}`; summary ≤600 and draft ≤2,000 code points; ≤5 unique fields. Provider output ceiling 1,024 tokens. Reject empty/unknown/malformed keys and invalid Unicode. `Field = 'merchant' | 'amount' | 'currency' | 'date' | 'description'`.
- Customer input: current question only, 1–2,000 code points, selected language and approved intent/field vocabulary. No transcript or transaction data goes to the model. Output ceiling 128 tokens; `{intent: 'status' | 'next_step' | 'provide_details' | 'human' | 'unsupported', field: Field | null}`. A field is allowed only for `provide_details`. No generated prose reaches the customer.
- `POST /agent/intake-assist` body exactly `{protocol, language, request_id}`. Agent-only; server loads report/context. Success: `{summary, missing_fields, draft, language, snapshot, context_truncated}`.
- `POST /intake/handoff/{reference}/assist` body exactly `{question, language, request_id}`. Customer-only; ownership checked in D1. Success: `{intent, field, language, snapshot}`; browser renders approved localized copy with freshly read owned report facts.
- Both endpoints: 401 invalid/expired/wrong-role session; customer foreign/missing reference identical 404; 422 malformed input; 429 cap/rate limit with Retry-After; 409 closed reviewer target, stale snapshot or reused request ID; 503 disabled/provider failure with generic localized manual fallback. No provider payload in errors. Existing method/path policy handles unsupported verbs/paths.
- Generation results are never stored as human messages. Add only bounded call metadata for atomic reservations/accounting; no saved AI transcript or draft bodies.

## Task 1 — Message clarity and factual status help (phase 1)

**Files:** modify `front-end/src/app/shared/messages/message-thread.component.ts`, `front-end/src/app/features/customer/customer.page.{ts,html,css}`, `front-end/src/app/shared/i18n/lang.service.ts`; test shared component and customer page specs. Add `customer.page.support.spec.ts` for focused regressions.

**Consumes:** existing `MessageThread`, customer report list, `messages`, refresh and send methods. **Produces:** one visible report/progress header; localized waiting/reply state; `checkReportStatus(protocol: string): Promise<void>` using the existing owned report-list refresh; no new API.

- [ ] Write failing tests: expanded report has one progress header; successful customer post then last customer author shows waiting; failed post preserves draft and never claims saved; subsequent human reply announces receipt once; closed view shows actual closing note or existing missing-note fallback.
- [ ] Add tests for `checkReportStatus`: ES/PT/EN received/in-review/closed explanations match latest returned record, include source update time and checked-at time distinctly, and show a stale/unavailable notice on failure. Assert zero message/status writes and zero model calls.
- [ ] Run `npm --prefix front-end test -- --watch=false --browsers=ChromeHeadless --include='**/customer.page.support.spec.ts'`; confirm intended failures before editing.
- [ ] Implement within existing components. Label thread as messages with the review team; status answer as automatic. Keep waiting state derived from persisted data. Discard late refreshes on session/report changes; use existing focus and announcement patterns.
- [ ] Run focused tests, then full Angular tests/build. Browser-check 320px, 390px and desktop, long messages, keyboard navigation and failed refresh. Perform local customer→human reply→explained closure journey using synthetic records.
- [ ] Obtain spec/quality reviews; commit `fix(customer): clarify report messages and status help`; open phase-1 PR with test evidence. No AI credentials or activation needed.

## Task 2 — Bounded assistance transport and accounting (phase 2)

**Files:** create `back-end/src/modules/intake/assist.js`, `back-end/src/modules/intake/assist-prompts.js`, `back-end/test/unit/assist.test.js`, `back-end/migrations/0030_support_assist_runs.sql`; modify `back-end/src/store/d1.js`; create `Docs/ADRs/ADR-016-report-support-assistants.md` and update ADR index. If migration/ADR numbers are occupied when this phase starts, allocate the next free number and update this plan before coding.

**Consumes:** `credentialConfig/accessToken` from `vertex-auth.js`, compatible `vertexUrl` helper; existing model identifier is a candidate subject to verification. **Produces:** `runAssist(env, {mode, language, input}, {fetcher, signal}): Promise<{ok:true,value,usage}|{ok:false,kind,usage}>`; `mode` is reviewer/customer. `kind` is timeout/provider_error/auth_error/invalid_output/config_error. Usage includes attempted calls and known input/output tokens plus unknown-usage count. Dedicated prompts/schemas never alter extractor parity.

**Store interface:** `reserveAssist({requestId, sessionHash, mode, protocol, now}): Promise<'reserved'|'duplicate'|'limited'>`; `finishAssist({requestId,outcome,latencyMs,usage,version}): Promise<void>`. Store request UUID, hashed session, mode, report reference, creation time, terminal outcome, latency, usage and prompt/model version only. No raw identity, prompt, question, answer or draft. Unique request ID and indexed time/session counters; atomic conditional insert checks both caps. A reserved row counts immediately; stale rows older than 10 minutes become abandoned through the existing bounded idle sweep; retain at most 7 days, deleting at most 100 expired records per sweep.

- [ ] Write tests: caps at exact boundaries across concurrent callers; duplicate ID incurs no second call; failed calls retain budget; sessions/features cannot bypass daily cap; bounded cleanup; malformed JSON/extra keys/injection-shaped output rejected; auth and provider share deadline; unknown usage preserved.
- [ ] Run `node --test back-end/test/unit/assist.test.js`; confirm failures.
- [ ] Implement additive metadata schema and SQL in the store only. Add default-off guards. Reuse WIF; no credentials in files/logs. Independently verify model availability, endpoint, schema support, lifecycle and official pricing and record the chosen identifier/version in ADR-016 before live evaluation. Mocked development remains possible without live activation.
- [ ] Implement one-call transport, strict parsers, limits and abort behavior; include prompt/model version in accounting. No automatic retry or generic tool loop.
- [ ] Run unit tests, extractor parity tests and local migrations; test accounting concurrency in native local D1. Record measured added query/read/write/round-trip ceilings in ADR-004 with fixtures. Do not relax old ceilings.
- [ ] Review and commit `feat(assist): add bounded Vertex support operations`. Keep inside phase-2 branch; do not activate.

## Task 3 — Reviewer API and stale-send protection (phase 2)

**Files:** create `back-end/src/modules/agent/assist-routes.js`, `back-end/test/integration/assist.test.js`; modify `back-end/src/router.js`, `back-end/src/modules/intake/messages.js`, `back-end/src/modules/agent/routes.js`, `back-end/src/store/d1.js`, `front-end/contracts/intake-api.schema.json`; extend message-session, message integration and budget tests.

**Consumes:** Task 2 transport/accounting. **Produces:** reviewer endpoint above; allow optional `expected_snapshot: Snapshot` on agent message POST. Existing manual clients without it remain compatible. Extend `postMessage` with optional expected snapshot checked atomically inside its existing insert. Successful same-key/body retries return the original message even after later report changes; a new stale assisted send returns 409.

- [ ] Write local-D1 tests for authenticated agent only, malformed bodies, nonexistent report, closed target, no message/status side effects from generation, revocation during call, new message/status during call and concurrent changes before assisted send. Assert old clients still work and message replay remains idempotent.
- [ ] Run `ONLY=assist.test.js npm --prefix back-end run test:integration` and relevant message tests; confirm failures.
- [ ] Load context from server-owned report/thread, apply bounds, capture snapshot, reserve budget, generate, then revalidate live session and snapshot before returning. Do not reuse a read endpoint that writes review/open markers unintentionally. Return 409 for stale context.
- [ ] Implement atomic snapshot predicate in the existing agent-post insert; retain agent/session audit and all current ownership guards. Reject extra properties and invalid snapshot ranges (count 0–50).
- [ ] Run gate/path/method, role swap/expiry, hostile input, isolation, contract, idempotency and D1 budget checks through `npm --prefix back-end test`; verify no raw content in logs/errors.
- [ ] Review and commit `feat(agent): serve reviewed-case assistance safely`.

## Task 4 — Reviewer copilot UI and pilot gate (phase 2)

**Files:** modify `front-end/src/app/features/agent/agent.{page.ts,page.html,page.css,service.ts}`, shared message component, shared models/i18n and their specs; create `agent.page.assist.spec.ts`; create `evals/support_assist/README.md`, `evals/support_assist/development.jsonl`, `evals/support_assist/acceptance.jsonl`, `evals/support_assist/score.py`; update `Docs/deliverables/EVALUATION.md` and `Docs/Plans/observability-runbook.md`.

**Consumes:** reviewer API and snapshot send. **Produces:** explicit Prepare reply → review/edit → existing human Send flow. Shared composer accepts an optional draft object `{body,scope,version}` and seeds only on explicit reviewer acceptance; it never overwrites unsent manual text without explicit confirmation. Assisted send carries the snapshot; stale 409 retains editable text but requires refresh and a fresh draft/manual review before another send.

- [ ] Test: generation never posts; applying a draft is explicit; summary/missing fields are labeled AI; manual text survives failures; no late result crosses report/session/language scope; stale send rejected; closed report disables generation; controls remain keyboard-accessible.
- [ ] Run focused Angular tests and confirm failures; implement the existing-page UI without a new chatbot shell. Keep manual messaging functional with the switch off or provider unavailable.
- [ ] Author separate development and held-out fixtures using the evaluation gate below; pin immutable acceptance fixture hash before model trials. `score.py` uses stdlib and consumes reviewed JSONL results, never live credentials. Do not tune on acceptance failures; a new prompt version requires a new acceptance set.
- [ ] Run full Angular and backend checks, build and mobile/desktop review. Run synthetic live Vertex pilot only after the ADR/data scope and spending are approved; otherwise leave activation pending explicitly.
- [ ] Review, commit `feat(agent): add human-reviewed reply drafts`, and open phase-2 PR. Human steps: ADR review, live pilot/activation approval, PR approval. Existing WIF should require no broader IAM role; any unexpected permission need must be reviewed, not silently granted.

## Task 5 — Customer question assistant (phase 3)

**Files:** create `back-end/src/modules/intake/assist-routes.js`; modify router/store/contracts, customer service/page/models/i18n; create `front-end/src/app/features/customer/customer.page.assist.spec.ts`; extend `assist.test.js` unit/integration and budget tests.

**Consumes:** Task 1 status rendering, Task 2 classifier/accounting, existing owned report reads and human message route. **Produces:** customer endpoint above; a transient assistant panel with approved localized responses and explicit “Send these details to the team” action that populates, but does not submit, the human composer.

- [ ] Tests: foreign and nonexistent references identical 404; other-customer reference inside question does not change scope; classifier sees only question/language/vocabulary; all intent/field combinations validated; refund/block/fraud requests hand off; no invented response text; no human-thread writes on classification.
- [ ] Test status answers against freshly read owned records, including closure during generation; unsupported/provider errors keep status action/manual messages usable. Test logout/scope/language changes, repeated request IDs and concurrent cap exhaustion.
- [ ] Run focused failing backend/Angular tests. Implement strict classification; render status/next steps from owned report data and approved copy. Return snapshot; refresh facts before display, discard if mismatched. Non-status answers must not imply a state change.
- [ ] Explicitly label session-only AI help versus saved team messages. On closure, use existing closing explanation/follow-up UI. No new persistent chatbot history or author values.
- [ ] Run full API adversarial/contract/budget suites, Angular suite/build and narrow/wide UI checks; review and commit `feat(customer): add bounded report question assistance`.

## Task 6 — End-to-end evaluation and controlled activation (phase 3)

**Files:** extend `evals/support_assist/` fixtures/scorer documentation, `Docs/deliverables/EVALUATION.md`, ADR-016, observability runbook; add `Docs/Evidence/support-assist-pilot.md` with aggregate results only.

**Consumes:** all phase interfaces. **Produces:** a release decision with reproducible evidence; both feature switches remain off until approved.

- [ ] For each feature prepare 30 development cases (10/language) and a separate 60-case acceptance set (20/language), covering the review-focus failures. At least 20 acceptance cases/feature are adversarial or unsupported. Run each acceptance case 3 times with the frozen prompt/model; score all 180 attempts, including timeouts/fallbacks.
- [ ] Acceptance: zero cross-customer leaks, unauthorized writes, fabricated case facts or promised financial outcomes in reviewed outputs; every deterministic status answer matches its stored source. At least 90% correct supported classifications overall and at least 85% per language; every unknown/invalid result falls back safely. Require at least 80% of reviewer drafts rated usable with no factual correction, separately reporting unchanged acceptance and edited acceptance. Any safety failure blocks activation.
- [ ] Proposed performance gate: successful generation p95≤8s and failure/timeout rate≤5%, with all-attempt elapsed distribution reported separately and the 10s hard deadline tested. Phase 1 status target remains the existing <2s request target. Measure actual token usage and unit prices, unknown usage and per-attempt costs; do not substitute extractor timing or cost.
- [ ] Run at least 10 synthetic two-party journeys covering ES/PT/EN: customer message persisted, waiting state, factual status, reviewer draft edited/sent, human reply observed, explained closure, closed follow-up, provider outage and identity switch. Report first-human-response timing separately from automated answers. Compare human handling time against the same tasks without assist; present this small pilot as descriptive, not causal proof.
- [ ] Open phase-3 PR after code checks and both reviews. Human steps list evidence review, PR approval and per-feature activation approval. The deploy applies additive migrations through normal workflow; no agent runs remote migrations.
- [ ] After authorized activation, confirm deployment SHA/frontend assets, login/OTP/logo, locale-specific email requests, message persistence and both assistant switches on the actual production URL. Observe errors/latency/cost; disable only the failing assistant switch if its gate is breached. Manual messages, factual status and existing extraction remain usable.

## Completion and handoff

All tasks start red, finish green, record exact commands/results and commit scoped work. A failed review gets at most three correction rounds before escalation. Do not mark a phase complete solely because CI passes: require the stated UI and data-flow checks. Unperformed live tests stay explicitly pending.

Plan review is the next checkpoint. Preserve the user's requested coordinator/subagent execution method; do not ask them to choose it again. After approval, execute Task 1 first and stop at its PR/human-merge boundary before starting the next phase branch.
