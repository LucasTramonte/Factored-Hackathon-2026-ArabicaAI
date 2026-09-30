# Intake Backend Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution or superpowers:subagent-driven-development for explicitly selected delegated execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Worker’s guided intake, durable complete/technical/incomplete handoffs, agent detail/history and privacy-safe episode evidence, then add the gated online extraction transport when its behavioral dependencies are available.

**Architecture:** Extend the existing Worker/D1 store with additive episode, turn, handoff and event tables. Preserve `/cases` and the current frontend; new guided APIs are independently usable through local HTTP tests. The learned adapter and matching policy are supplied through the unexposed behavioral-review boundary, not rewritten by this exposed implementer.

**Tech Stack:** JavaScript ES modules, Node >=22, Cloudflare Worker/D1, existing Wrangler, JSON Schema subset validator, Python stdlib/pytest scorer. No new dependency.

**Spec:** `Docs/superpowers/specs/2026-09-29-intake-online-completion-design.md` (Roberto approved; fresh-review findings resolved in `acaccd7`).

## Global constraints

- Frontend implementation is excluded. Shared API JSON Schema is in scope; Angular components, styles and translation work are not.
- One online runtime; all SQL in `back-end/src/store/d1.js`; additive migrations applied locally before remote.
- Preserve current `/cases`, `/transactions`, `/agent/cases` response shapes and existing budgets. Use separate new endpoints/contracts for new fields.
- Identity, ownership, language binding, confirmation history and lookup status are server-controlled. Re-authentication may resume only the same customer’s episode.
- A protocol/reference is returned only after durable handoff/case read-back. Unknown acceptance keeps the original key and payload.
- Durable technical/incomplete handoff is terminal; recovery starts a distinct episode. No second chain/end event.
- Provider errors are not retried; only the approved adapter’s one invalid-output retry is permitted within a shared 10 s deadline. p95 qualification remains 3 s.
- Never change extractor prompt, parsing, thresholds, model, frozen labels or corpus; no model/frozen calls, remote migration/import/deploy/tag in this plan.
- Keep operational data through October 31. Expired sessions still purge. Events contain opaque references only.
- Native execution is recommended because the tasks share transactional state and store/contract files; task review happens before final integration.

## Review focus

- Same-owner session renewal versus different-customer session swap: resume the former, reject the latter (Task 2).
- Timeout after a committed write: replay exactly one receipt with no duplicate events (Task 3).
- Agent evidence for an incomplete handoff: return missing evidence without an accidental inner-join disappearance (Task 4).
- Ended episodes with unknown provider usage: keep them in denominators and report unknown totals explicitly (Tasks 1/5).
- Nested retry multiplication or fallback after terminal handoff: preserve provider attempt count and start a distinct guided episode (Tasks 3/6).

## Execution boundaries

Tasks 1–5 can build a guided backend without AI or a larger Gold import. Task 6 waits for the blind builder/Manoella’s compatible extraction-and-policy adapter and serving-field contract, recorded development decisions, and exact registered parameters. Model activation waits additionally for the frozen comparison and release decision. Current Gold rows lacking card/category/country fields cannot implement those matching filters.

Recent-transactions resolution is a separate extension: reuse existing retrieval instrumentation, draft its scope/coverage/denominator ADR, and keep its resolution numerator unavailable until frontend display acknowledgment exists. Do not turn this into an extra independent subsystem inside these tasks.

## Task 1: Versioned events with unknown usage

**Files:** Modify `evals/intake/episodes.py`, `evals/intake/test_episodes.py`, `Docs/intake/intake-events.md`.
**Interfaces:** Preserve `summarize(events)` and CLI input/output. Accept existing v1 events unchanged; add v2 end events with nullable total `input_tokens`/`output_tokens`, required integer `known_input_tokens`, `known_output_tokens`, `usage_unavailable_calls`, and existing measured `duration_ms`, `llm_calls`, `tool_calls`. In v2, any unavailable call makes totals null; known subtotals remain nonnegative measured integers. All events in one episode must have one version. Combined summary token totals are null when an ended episode has unknown totals; report known subtotals and unavailable calls separately. `usage_unknown_episodes` includes ended unknown-usage and pending episodes.

- [ ] Write `test_v2_unknown_usage_preserves_denominator_and_known_subtotals`: an ended failed episode with one unavailable call and known 7/2 tokens yields eligible_started=1, usage_unknown_episodes=1, total tokens=null, known subtotals=7/2; an existing v1 complete fixture retains its current KPI values. Add rejection checks for mixed episode versions, bool/negative counts, unknown fields and inconsistent zero-unavailable/null-total combinations.
- [ ] Run `.venv/bin/python -m pytest evals/intake/test_episodes.py -q`; confirm the new test fails for unsupported v2.
- [ ] Extend the strict per-version allowlist and aggregation; reuse current sequence/safety checks and bounded O(events) evaluation memory model. Document exact compatibility and missingness semantics.
- [ ] Run `.venv/bin/python -m pytest evals/intake/test_episodes.py -q` and the JSONL CLI tests; all pass, v1 fixtures unchanged.
- [ ] Commit `feat: represent unknown usage in versioned intake events`.

## Task 2: Add guided episode start and durable turn replay

**Files:** Create `back-end/migrations/0004_intake_episodes.sql` (only after confirming Lucas has not reserved 0004), `back-end/src/modules/intake/routes.js`, `back-end/src/modules/intake/validation.js`, `back-end/test/unit/intake.test.js`, `back-end/test/integration/intake.test.js`. Modify `back-end/src/store/d1.js`, `back-end/src/auth/session.js`, `back-end/src/router.js`, `back-end/wrangler.jsonc` API document routing, `front-end/contracts/intake-api.schema.json`.
**Tables:** `intake_episodes` (UUID episode ID, customer FK, opaque session_ref, es/pt language, guided mode, state, created/updated/expiry timestamps); `intake_turns` (episode FK, turn_key, payload_hash, response_json, UNIQUE(episode_id,turn_key)); `intake_events` (episode FK, seq, event_json, UNIQUE(episode_id,seq)). Add owner/update indexes. Statement stays in access-controlled episode storage, never event_json. Opaque session_ref is a distinct random token, never a session credential/hash or customer ID.
**Interfaces:** `POST /intake/start` body `{language, mode:'guided', report_type:'unrecognized_charge', customer_statement, idempotency_key}` creates an explicit supported-language guided report, not automatic free-text classification. Store `startIntake({customerId,language,statement,key,now}) -> {episode,replayed}` and `findIntake(customerId,episodeId) -> row|null`. Unique(customer_id,start_key) plus payload hash prevents conflicting starts. Response `{episode_id,state:'selection_required',language,mode:'guided',replayed}` with no case protocol. Statement 10–2000 Unicode code points; reject extra keys and unsupported languages.

- [ ] Write `guided_start_is_owned_and_idempotent`: two concurrent identical starts return the same episode, one start event and no reference; changed content on the same key yields 409. Reject forged body customer IDs, invalid roles, expired sessions, oversized/malformed/extra-key bodies and unknown methods/paths before storage.
- [ ] Run `cd back-end && npm run test:unit`; confirm missing route/store/schema causes the new check to fail.
- [ ] Implement strict validation and atomic start/event insertion in store batches. Preserve existing readSession callers and extend the internal store result with trusted expires_at if needed for idle closing; never add these fields to old API responses. Derive owner from that session. Retain stable original episode session_ref when a renewed same-owner session resumes; bind its current server expiry on authenticated activity and reject a different owner.
- [ ] Run `cd back-end && npm test` (existing harness applies migration to fresh local D1); add same-owner renewal/different-customer swap assertions and contract validation using existing validator subset. No production data required.
- [ ] Commit `feat: start owned guided intake episodes`.

## Task 3: Confirm and persist terminal handoffs safely

**Files:** Modify Task 2 migration before it is merged/applied remotely (otherwise add a new additive migration), intake routes/validation, `back-end/src/store/d1.js`, new integration test and API schema. Keep old `/cases` implementation unchanged.
**Tables:** `intake_handoffs` (UUID handoff/reference, unique episode FK, optional unique complete_case_id FK to existing cases, kind complete/technical/incomplete, tool status, original statement/evidence JSON, actions/question arrays, destination, priority, accepted_at). Complete links to an existing confirmed owned case; technical/incomplete does not weaken its FK/check constraints.
**Interfaces:** `POST /intake/confirm` body `{episode_id,transaction_id,customer_confirmed:true,idempotency_key}` revalidates live session and current ownership. `POST /intake/handoff` body `{episode_id,kind:'incomplete',idempotency_key}` requests human help without a confirmed transaction. Only server errors create technical kind/tool status; clients cannot forge actions or failure evidence. `persistIntakeHandoff({customerId,episodeId,turnKey,payloadHash,completeCase|null,kind,evidence,actions,questions,usage,now}) -> insert/replay`, then `readIntakeReceipt(customerId,episodeId) -> receipt|null`. Responses have `{episode_id,protocol,kind,accepted_at,replayed,next_step_code}` only after read-back. No refund/block/fraud action.

- [ ] Write `confirmed_case_and_handoff_chain_commit_once`: concurrent confirmed submissions persist one existing case, one handoff, one confirmed/created/accepted/end chain; foreign transaction yields 404. An injected read-back failure returns 503 without protocol and same-key retry retrieves the original receipt. Changed payload/key conflicts cannot replace a terminal handoff.
- [ ] Run unit check first and verify it fails for missing persistence; implement atomic conditional writes and events through D1 batches, with UNIQUE constraints handling races. Do not emulate atomicity with a process-global JS lock.
- [ ] Write `terminal_incomplete_handoff_recovery_uses_new_episode`: durable incomplete/technical handoffs end routed/technical_failure, not accepted; replay yields original receipt. A later explicit guided start has a distinct ID/key and leaves original usage/outcome intact. Unresolved write acceptance cannot create another handoff for that episode.
- [ ] Run `cd back-end && npm test`; contract/isolation/adversarial/read-back/replay checks pass. Document tool read retry as at most one bounded transient retry; no retry of authorization/configuration/conflict errors.
- [ ] Commit `feat: persist verified complete and incomplete intake handoffs`.

## Task 4: Read-only agent detail and service history

**Files:** Modify `back-end/src/modules/agent/routes.js`, `back-end/src/store/d1.js`, router/API schema and integration tests.
**Interfaces:** `GET /agent/intakes` returns at most 50 newest handoffs plus `has_more`; `GET /agent/intake-detail?protocol=<uuid>` returns kind, source statement, available verified evidence, server actions/questions, receiving service, priority and ordered persisted service history. Store `listIntakeHandoffs(limit)`, `findIntakeHandoff(protocol)`, `listIntakeHistory(episodeId)`. Agent session only; no customer or anonymous access. Old `/agent/cases` remains compatible.

- [ ] Write `agent_detail_includes_incomplete_handoff_without_transaction`: both complete and incomplete appear; absent evidence is explicit null/missing questions rather than fake values or a dropped row. Customer/session swaps get 401; POST/PUT attempts get 405. Queue/detail contract rejects extra data; all reads use the existing authenticated agent boundary.
- [ ] Run unit tests to confirm missing handlers fail; add bounded store queries with left joins only for optional complete-case evidence and owner-aware transaction joins.
- [ ] Run `cd back-end && npm test`; verify history is actual service transitions, never manufactured human action or mutable status.
- [ ] Commit `feat: expose read-only intake handoff detail and history`.

## Task 5: Export, close idle episodes and verify costs

**Files:** Create `back-end/scripts/export-intake-events.mjs`, `back-end/scripts/close-idle-intakes.mjs`; modify store queries, event docs, `back-end/test/integration/intake.test.js`, `back-end/test/integration/budget.test.js`, `Docs/ADRs/ADR-004-intake-capacity-and-cost.md`, and `back-end/README.md`. Draft `Docs/Plans/recent-transactions-resolution-decision.md` as the proposed separate ADR content without assuming an accepted ADR number.
**Interfaces:** Both scripts default local and require explicit `--remote` for remote work; this plan executes local only. `closeIdleIntakes({now,limit:100})` conditionally ends idle episodes after min(last activity+600000 ms, bound current session expiry); repeated sweeps/replays emit no duplicate end. It must not declare unresolved case writes abandoned without reconciling read-back. `exportIntakeEvents({afterEpisode,limit:100})` paginates complete per-episode event groups to strict v2 JSONL; filters a reviewed allowlist and validates with the existing scorer. No raw D1 CLI response in diagnostic logs.

- [ ] Write `idle_close_and_export_keep_pending_and_unknown_visible`: fake clock closes idle once, retains active/persistence-unknown episodes as pending, rejects event field injection, and exports terminal failure plus safe acceptance without identifiers/statements. CLI failure emits no raw content or partial accepted artifact.
- [ ] Run failing unit checks; implement bounded indexed SQL pages, guarded local scripts and existing scorer validation. Export writes to ignored artifact paths. Do not introduce a scheduled automation or remote cron.
- [ ] Run `cd back-end && npm test` and `.venv/bin/python -m pytest evals/intake/test_episodes.py -q`. Feed local JSONL to `python -m evals.intake.episodes`; assert eligible_started includes pending/failed episodes and unknown tokens stay unknown.
- [ ] Measure query/read/write/round-trip counts for each new endpoint, full new episode and 50-row agent queue. Preserve old ceilings and add justified new ceilings from measurements, below the 50-query invocation limit. Update ADR-004 with measured storage/usage and replacement capacity assumptions; never raise a failing ceiling without explaining the work.
- [ ] Draft the inquiry ADR’s scope, coverage, eligible attempts and session-bound idempotent display acknowledgment. Backend retrieval success is not resolution; numerator unavailable until separately implemented frontend acknowledgment and team decision. Record original Bronze mismatches as observed source anomalies; random generation is an inference, not proven generator provenance.
- [ ] Commit `feat: export bounded intake episode evidence`.

## Task 6: Gated online extraction transport (external dependency)

**Files:** Create `back-end/src/modules/intake/ai-transport.js` and unit tests; modify intake routes/router/config/contracts and docs only after compatible adapter exists. Blind builder supplies `back-end/src/modules/intake/extraction.js` (prompt construction/parsing/validation) and the policy matching interface; this plan’s exposed executor does not write those behaviors.
**Required interface for unexposed handoff:** `extractApproved({message,language,asOf,vocabulary,invoke,deadline}) -> {extracted,usage}` with approved exact model/prompt hashes/parameters and usage `{llm_calls,known_input_tokens,known_output_tokens,usage_unavailable_calls}`. `decideApproved({extracted,ownedTransactions,trustedConfirmation,lookupStatus,asOf}) -> {action,candidate_ids,missing}` must preserve approved policy and serving coverage. Agree this interface with the builder/Manoella before consuming it; do not implement an approximate replacement if they deliver another signature.
**Transport interface:** `invokeBinding(env,model,body,{deadline,signal}) -> provider envelope`, no parser and no independent retry. `INTAKE_AI_ENABLED` defaults false; absent approved artifacts/qualification blocks the feature. Structured guided APIs remain available regardless.

- [ ] Verify the behavioral adapter, serving contract, ownership review and registration dependencies are available. If absent, report Task 6 gated and continue no further model integration. No dummy parsing/module that makes the gated build appear complete.
- [ ] Write stub tests `disabled_mode_never_calls_ai`, `provider_failure_has_no_transport_retry`, `invalid_output_retry_uses_shared_10000ms_deadline`, `transport_excludes_identity_and_transactions`, and `terminal_failure_recovery_is_distinct_episode`. Assert provider-attempt counts and total deadline exactly; malformed output never reaches store or customer replies.
- [ ] Run failing unit tests; implement only transport/lifecycle/configuration while consuming the approved behavioral module unchanged. Authenticate/recheck owned evidence outside it; responses use stable contract codes, no generated customer reply text.
- [ ] Run Worker unit/local-D1 contracts/isolation/budgets and development-only approved parity checks through the unexposed owner. No live Workers AI or frozen calls by this executor. Update measured capacity if integration adds requests/queries.
- [ ] Commit `feat: add disabled-by-default intake AI transport`. Do not enable, deploy or tag it; Lucas integrates after the frozen qualification and recorded release decision.

## Final handoff

- [ ] Run `make intake-test`, episode scorer/CLI suites, `git diff --check`, and inspect staged changes for frontend, prompt/parsing or private artifacts.
- [ ] Obtain a fresh whole-branch review before marking implementation ready. Resolve only verified findings; preserve Manoella’s behavior ownership.
- [ ] Update PR #29 around the implemented scope, exact validation and remaining Task 6/inquiry activation dependencies; attach all created PRs to this chat. Never describe a gated task as implemented or frontend display as verified.
- [ ] Ask the user to review this plan and choose native or subagent-driven execution before product implementation, as required by the requested writing-plans workflow.
