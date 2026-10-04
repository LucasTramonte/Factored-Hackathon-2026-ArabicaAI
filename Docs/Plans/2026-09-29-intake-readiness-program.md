# Intake readiness program implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task by task.

**Goal:** Produce reproducible evidence that the deployed Worker safely completes the deterministic intake flow, close the retention and accessibility gaps, freeze an independently authored Spanish/Portuguese evaluation set, and leave one explicitly gated read-only resolution path.

**Architecture:** Keep the existing Cloudflare Worker, D1, Angular client, Gold seed, Python scorer and Node test harness. Add one D1 migration for intake episodes/events, one authenticated intake-start call, one reset/export path using the installed Wrangler CLI, and documentation/evidence artifacts. Reuse `/transactions`; do not introduce another service, queue, analytics store, model, or dependency.

**Tech stack:** Cloudflare Worker and D1, JavaScript/Node 22, Angular, Python/pytest, existing Make targets and Wrangler dependency.

**Spec:** `Docs/intake/intake-events.md`, `Docs/intake/customer-and-measurement-contract.md`, `Docs/requirements-traceability.md`, `Docs/ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md`, and the seven priorities agreed on 2026-09-29.

## Global constraints

- Preserve the current safety boundary: identity comes from the session, every transaction lookup is customer-scoped, the customer explicitly confirms, and the only side effect is a case for human review.
- Keep customer identifiers, statements, transaction details and names out of event exports. Operational D1 tables may retain references needed for authorization; the exported JSONL must pass the scorer allowlist.
- Report actual values. The deterministic V1 has zero model calls and zero tokens. A case-store commit is one tool call. Do not estimate provider cost or claim dispute resolution.
- Use source currency and source timestamps. Do not convert amounts or imply a timezone absent from source data.
- Keep event and reset data bounded in D1. No in-memory collection of fact-table keys is introduced.
- One concern per PR. Run `make intake-test` before each merge and update `Docs/requirements-traceability.md` when a gap closes.

## Review focus

- Event ordering, retry deduplication, and atomicity around case acceptance.
- Authentication and ownership checks on every new route.
- Whether each metric's numerator, denominator, language split and unknown state are explicit.
- Whether reset behavior deletes only demo operational data and preserves reviewed seeds/provenance.
- Whether screenshots and reports can be reproduced from a named commit and seed version without credentials or customer content.
- Whether every Worker deploy proves its required D1 migrations are already applied, so code cannot run ahead of schema again.

## Recommended execution order

The numbered priorities describe business value. The implementation order below follows dependencies:

```text
PR #18 merged + review/merge PR #19
          |
          v
ADR-002 decision -----> Worker events
                               |
                               v
retention/reset ------> accessibility
          |                    |
          +--------+-----------+
                   v
        judge evidence pack
                   |
                   v
       optional read-only inquiry
```

The frozen ES/PT set can be authored in parallel by an independent reviewer, but it is not opened to the implementer until it is frozen.

## Task 0: Review and merge PR #19 safely

**Files:** [PR #19](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/pull/19) and Cloudflare Workers Builds configuration; no feature code in this planning branch.

1. [PR #18](https://github.com/LucasTramonte/Factored-Hackathon-2026-ArabicaAI/pull/18) is already merged at `daf7ed8`; retain its `seq`, pending-episode accounting and `v1_authored` contract as the base for Task 2.
2. PR #19 now performs the #15 rescue and includes migration 0003, Gold context-card generation, Worker session lookup, the `intake_agent` package and late #17 review fixes. Do not open a second rescue PR.
3. Before another push to PR #19, stop `feat/lucas-intake-demo` from being the production build branch or disable its automatic production deploy. The current PR head `130ebfd` was deployed before human approval because that feature branch is still configured as production.
4. Resolve the five correctness/security findings against the current head:

   - malformed, null or non-object `card_json` must degrade to `context_card: null`; stored `card_version` and `snapshot_at` remain authoritative;
   - selected customers with a null `first_name` must fail the Gold load;
   - the response schema must define and require the context-card fields the Worker returns;
   - product numbers shorter than four characters must yield `last4: null`, not the full identifier;
   - session-language input must be validated before it is returned as a language tag.

5. The remaining `CARD_VERSION` constant suggestion is maintainability-only. Apply it if it stays a one-line shared constant; do not create a versioning abstraction for a single schema version.
6. Add regression cases for malformed cards, null names, short product numbers, invalid language strings and the full response contract. Run:

   ```bash
   make intake-test
   .venv/bin/python -m pytest intake_agent data_pipelines/gold/test_intake_slice.py -q
   git diff --check origin/main...HEAD
   ```

   Expected: Gold, Angular and Worker tests pass; all five regression cases fail on `130ebfd` and pass with the fixes; the diff remains limited to #15 plus the stated #17 follow-ups.
7. Merge PR #19, change the production branch to `main`, verify production D1 reports migrations 0001–0003 and repeat login. Delete the two old feature branches only after these checks pass.
8. Keep the context card's `locale_hint` as a UI default. PR #19 does not store a language in the Worker session, so Task 2 must still add an explicit `es`/`pt` session choice and treat it as authoritative.

**Exit gate:** PR #19 is merged into `main`; all review threads are resolved or dismissed with a verified reason; Workers Builds deploys from `main`; production D1 has migrations 0001–0003; customer login returns 200 with a valid card or `null`.

## Task 1: Decide ADR-002 formally

**Files:**

- Modify: `Docs/ADRs/ADR-002-v1-workflow-unrecognized-charge-intake.md`
- Modify: `Docs/ADRs/README.md`
- Modify: `Docs/Plans/intake-roadmap.md`
- Modify: `Docs/requirements-traceability.md`

**Recommended decision:** Accept ADR-002 as the current V1, with its existing limitation that intake with human handoff is not automated dispute resolution. Keep the read-only inquiry as a separately measured V2 candidate.

1. Obtain an explicit `Accept` or `Reject` from the listed deciders. Record the date and names; do not infer consensus from merged code.
2. If accepted, change the status to `Accepted`, retain the limitations and link this plan as follow-up work.
3. If rejected, change the status to `Rejected`, state the replacement decision, and stop Tasks 3 and 7 until their event/outcome definitions are revised.
4. Update the ADR index and remove stale `Proposed` references from the roadmap and traceability matrix.
5. Verify:

   ```bash
   rg -n "ADR-002|Proposed" Docs/ADRs Docs/Plans/intake-roadmap.md Docs/requirements-traceability.md
   git diff --check
   ```

   Expected: ADR-002 has one final status and the index agrees.

**Commit:** `docs: decide ADR-002 intake workflow`

## Task 2: Emit the intake event contract from the real Worker

**Files:**

- Create: `back-end/migrations/0004_intake_events.sql`
- Create: `back-end/src/modules/intake/events.js`
- Create: `back-end/scripts/export-intake-events.mjs`
- Create: `back-end/test/integration/intake-events.test.js`
- Modify: `back-end/src/auth/session.js`
- Modify: `back-end/src/store/d1.js`
- Modify: `back-end/src/modules/customer/routes.js`
- Modify: `back-end/src/router.js`
- Modify: `back-end/src/modules/customer/validation.js`
- Modify: `back-end/scripts/predeploy.mjs`
- Modify: `back-end/test/unit/config.test.js`
- Modify: `back-end/test/run-local.mjs`
- Modify: `back-end/package.json`
- Modify: `evals/intake/episodes.py`
- Modify: `front-end/contracts/intake-api.schema.json`
- Modify: `front-end/src/app/shared/models/intake.model.ts`
- Modify: `front-end/src/app/core/http/api.service.ts`
- Modify: `front-end/src/app/features/customer/customer.service.ts`
- Modify: `front-end/src/app/features/customer/customer.page.ts`
- Modify: `front-end/src/app/features/customer/customer.page.html`
- Modify: `front-end/src/app/features/customer/customer.page.spec.ts`
- Modify: `Docs/intake/intake-events.md`
- Modify: `Docs/Plans/intake-demo.md`
- Modify: `Docs/requirements-traceability.md`

### 2.1 Add the failing contract tests

1. Add an integration test that starts a Spanish session, starts an intake for an owned transaction, creates the case and retries with the same idempotency key. Extend `run-local.mjs` to export the resulting events after the HTTP suite.
2. Assert one ordered chain with consecutive `seq`, one durable case reference, no duplicate chain events on replay, `llm_calls=input_tokens=output_tokens=0`, one case-store tool call and no fields outside the scorer allowlist.
3. Add Portuguese coverage and assert language comes from the authenticated session, not the case body.
4. Add unauthorized, foreign-transaction and conflicting-idempotency cases. Assert they cannot create a case or a misleading accepted event.
5. Add one started but unfinished episode and assert the scorer reports it as `pending` in the denominator.
6. Run:

   ```bash
   cd back-end
   npm test
   ```

   Expected before implementation: failures because `/intakes`, session language and event tables do not exist.

### 2.2 Store the smallest complete event model

1. Add `language` (`es` or `pt`) and a random opaque `session_ref` to customer sessions. The login request selects language; context-card language may set the UI default but cannot override the submitted session choice.
2. Add `intake_episodes` with episode id, operational customer/transaction references, opaque session reference, language, rule version and start time.
3. Add append-only `intake_events` with episode id, integer `seq`, event name, timestamp and validated JSON payload. Enforce `UNIQUE(episode_id, seq)` and the allowed event names in D1.
4. Export only the allowlisted contract object. Never export the operational customer id or statement.

### 2.3 Start and complete an episode

1. Add `POST /intakes`. It requires a customer session and an owned transaction. This explicit user action means “report this unrecognized charge,” which is the deterministic V1 classification point.
2. Return the opaque episode id. The client carries it into `POST /cases`; the server verifies the episode belongs to the current session/customer and transaction.
3. Record `intake_started` at sequence 1.
4. On the first successful case insert, write `transaction_confirmed`, `handoff_created`, `handoff_accepted` and `intake_ended` in the same D1 batch as the accepted case. The case store is the receiving service, so `accepted_by` is `d1_case_store`.
5. Use `INSERT ... SELECT` predicates tied to the newly generated case id so a losing idempotency race cannot emit another request's events. A replay returns the stored receipt and emits nothing.
6. Set safety to `assessed_safe` only when the deterministic gate proves authenticated ownership, explicit confirmation and case-only action. Document that this assessment covers workflow safety, not whether the charge is fraudulent.
7. Use actual elapsed wall time from stored start/end timestamps for episode duration and nonnegative counters from the request. Record zero model usage and one successful case-store call. Keep Cloudflare request CPU/latency separate.
8. Leave an episode without an end event as `pending`. Do not add a cron or Durable Object merely to synthesize abandonment for the demo.

### 2.4 Export and score

1. Add `npm run events:export:local -- --output <path>` using the installed Wrangler CLI. Remote export requires the same explicit confirmation pattern as reset.
2. Add the minimal command-line entry point to `evals/intake/episodes.py`; it reads JSONL and prints/writes `summarize()` output without changing scoring logic.
3. Extend `predeploy.mjs` so a remote deploy fails while D1 migrations are pending. Add a focused unit check for the pending/applied decision. PR #19 documented an actual login outage when the Worker used `context_cards` before migration 0003 was applied; migration 0004 must not repeat it.
4. Pipe the exported JSONL through the existing scorer:

   ```bash
   cd back-end
   npm test
   npm run events:export:local -- --output ../artifacts/intake-events.jsonl
   cd ..
   .venv/bin/python -m evals.intake.episodes artifacts/intake-events.jsonl
   make intake-test
   ```

   Expected: the Worker test suite passes; the scorer accepts the raw export without manual edits; pending, ES/PT, p50/p95 and usage totals are present.

**Commit:** `feat: emit and score Worker intake events`

## Task 3: Define retention and safe demo reset

**Files:**

- Create: `Docs/Policies/demo-data-retention.md`
- Create: `back-end/scripts/reset-demo.mjs`
- Modify: `back-end/package.json`
- Modify: `back-end/README.md`
- Modify: `back-end/test/run-local.mjs`
- Modify: `Docs/requirements-traceability.md`

**Policy proposed for team acceptance:**

- Sessions expire after the existing one hour and are purged during session rotation.
- Cases and intake event rows are retained for at most seven days in the hackathon demo and cleared after the final judging session.
- Reviewed customers, transactions, context cards and sample provenance remain until the seed version is replaced.
- Cloudflare platform logs use the actual configured retention shown in the dashboard; record that value rather than assuming it.
- A reset deletes sessions, events, episodes and cases in foreign-key order. It never deletes seed or provenance rows.

1. Write the policy with table, purpose, contents, owner, retention trigger, deletion method and verification query for each data class.
2. Add `npm run reset:local` as the default. The script must call the installed Wrangler binary and reset only local D1.
3. Permit remote deletion only with both `--remote` and an exact typed database-name confirmation. Print row counts before and after. Never accept credentials as arguments.
4. Extend the local D1 harness to insert one session, episode, event and case, run the reset script, then assert operational counts are zero and seed/provenance counts are unchanged.
5. Run the failing check first, implement the script, then run:

   ```bash
   cd back-end
   npm test
   npm run reset:local
   ```

   Expected: tests pass; reset output names every affected table and confirms preserved seed tables.

**Commit:** `feat: define demo retention and guarded reset`

## Task 4: Freeze a fresh unseen Spanish/Portuguese evaluation set

**Files:**

- Create: `evals/intake/frozen_es_pt_v1.json`
- Create: `evals/intake/frozen_es_pt_v1.manifest.json`
- Create: `Docs/intake/frozen-es-pt-evaluation.md`
- Modify: `evals/intake/run.py`
- Modify: `evals/intake/README.md`

1. Name one reviewer who did not tune the checklist or implementation. The manifest must include reviewer, authoring date, languages, case count, source categories and adjudication status. A blank or team-generic reviewer fails the gate.
2. Give the reviewer the case schema and coverage matrix, not current model outputs. Require balanced ES/PT coverage of:

   - normal single match;
   - ambiguous matches and missing evidence;
   - unauthorized or injected identity;
   - tool failure and timeout;
   - unsupported inquiry/routing;
   - successful complete handoff.

3. Keep the existing `v1_authored` cases as regression material. Do not relabel them held-out or mix their scores into the frozen comparison.
4. Freeze the new cases and gold labels in one commit before anyone tunes against them. Record the JSON SHA-256 in the manifest, tag the commit `eval-es-pt-v1`, and record that tag's commit in the later evidence result. This avoids a self-referential commit hash inside the freeze commit.
5. Run the existing baseline and proposed system once on that frozen commit. Any later fix creates a new result with a new system version; the cases stay unchanged.
6. Verify:

   ```bash
   .venv/bin/python -m pytest evals/intake -q
   .venv/bin/python -m evals.intake.run --cases evals/intake/frozen_es_pt_v1.json
   ```

   Expected: schema/coverage checks pass; results report sample sizes and ES/PT separately; unsafe outcomes and unknowns are never hidden.

**Commit:** `test: freeze independent ES PT intake evaluation`

## Task 5: Complete the accessibility audit and fixes

**Files:**

- Modify: `front-end/src/app/features/customer/customer.page.html`
- Modify: `front-end/src/app/features/customer/customer.page.ts`
- Modify: `front-end/src/app/features/customer/customer.page.spec.ts`
- Modify: `front-end/src/app/features/agent/agent.page.html`
- Modify: `front-end/src/app/features/agent/agent.page.ts`
- Modify: `front-end/src/app/features/agent/agent.page.spec.ts`
- Modify: `front-end/src/styles.css`
- Create: `Docs/Evidence/accessibility-audit.md`

1. Add failing Angular tests for programmatic labels, one page heading, button names, `aria-live` status, `role=alert` errors and focus movement after login/submission errors.
2. Fix native HTML first: real `label` elements, `button` elements, fieldsets/legends and heading order. Add ARIA only where native semantics do not cover the behavior.
3. Make currency codes visible with amounts. Label source timestamps as timezone-unspecified until the source supplies a zone.
4. Preserve visible focus and a logical keyboard order. Move focus to the first error on failure and the case receipt on success.
5. Test at 320 CSS pixels without horizontal scrolling or clipped controls. Check customer and agent pages with keyboard only and one screen reader/browser combination.
6. Record contrast results, browser/OS/screen reader, viewport, failures and fixes in the audit. Do not claim WCAG conformance from unit tests alone.
7. Run:

   ```bash
   cd front-end
   npm test -- --watch=false
   npm run build
   ```

   Expected: tests/build pass and the manual checklist has no unresolved blocker for the demo path.

**Commit:** `fix: make intake demo keyboard and screen-reader usable`

## Task 6: Produce the judge-ready evidence pack

**Files:**

- Create: `back-end/scripts/capture-intake-evidence.mjs`
- Create: `Docs/Evidence/intake-demo/README.md`
- Create: `Docs/Evidence/intake-demo/manifest.json`
- Create: `Docs/Evidence/intake-demo/results.json`
- Create: `Docs/Evidence/intake-demo/screenshots/README.md`
- Modify: `.gitignore` if raw temporary captures need an ignored location

1. Use Node's built-in `fetch` and the existing API contract. Do not add a browser or test dependency.
2. Capture four named paths:

   - successful ES and PT intake with durable receipt;
   - hostname-wide Cloudflare Access/Basic-gate denial plus foreign-transaction rejection after authentication;
   - ambiguity or missing-confirmation path;
   - case-store failure behavior, using the existing controlled local failure test rather than a production debug endpoint.

3. Generate a manifest containing UTC run time, git commit, deployed URL or `local`, Gold seed/slice version, event-contract version, evaluator version and command lines. Exclude credentials, cookies, customer ids and statements.
4. Export Worker events and score them. Save completion denominator/numerator, pending, unsafe/not-assessed, ES/PT split, p50/p95, model/tool usage and D1 query/read/write/round-trip totals. Keep local D1 measurements labeled local. PR #19's single 0–4 ms production observation remains capacity context; it is not a p50/p95 sample or load test.
5. Capture screenshots manually after the accessibility task: Access denial for an unlisted identity, login/language choice, transaction confirmation, durable receipt, agent view and one application-level rejection. Redact browser credentials and use only synthetic demo identities.
6. The README scripts a five-minute demo and links every claim to a result, screenshot or test. It explicitly says the reference is intake for human review, not a resolved dispute.
7. In local mode, have the capture script invoke the existing throwaway Worker/D1 harness in evidence mode; do not assume `make intake-test` leaves a server running. Reproduce from a clean checkout:

   ```bash
   make setup
   make intake-setup
   make intake-test
   node back-end/scripts/capture-intake-evidence.mjs --target local
   ```

   Expected: commands recreate `results.json`; every manifest path exists; `git diff --check` passes; no secret scanner finding is introduced.

**Commit:** `docs: add reproducible intake judging evidence`

## Task 7: Add the optional read-only inquiry workflow

**Gate:** Start only after Tasks 1–6 are complete and ADR-002 explicitly permits a V2 inquiry. If judging time is short, stop after Task 6.

**Smallest useful scope:** “Show my recent transactions” in Spanish and Portuguese. Reuse `GET /transactions`; do not add balances, a free-text classifier, another database query or a financial action.

**Files:**

- Create: `Docs/ADRs/ADR-005-read-only-recent-transactions-inquiry.md`
- Modify: `Docs/ADRs/README.md`
- Modify: `front-end/src/app/features/customer/customer.page.html`
- Modify: `front-end/src/app/features/customer/customer.page.ts`
- Modify: `front-end/src/app/features/customer/customer.page.spec.ts`
- Create: `evals/inquiry/cases.json`
- Create: `back-end/test/integration/inquiry.test.js`
- Create: `Docs/intake/inquiry-measurement.md`
- Modify: `back-end/scripts/capture-intake-evidence.mjs`
- Modify: `Docs/requirements-traceability.md`
- Modify: `Docs/Evidence/intake-demo/README.md`

1. Define one eligible intent and one resolution: an authenticated customer receives their own bounded recent-transaction list with amount, source currency and timestamp limitations disclosed.
2. Add an explicit choice on the demo landing page: recent transactions or report an unrecognized charge. Reuse the current transaction response and component.
3. Add ES/PT evaluation cases for success, unauthenticated access, empty results and tool failure. Run those cases against the real Worker from the evidence script and keep inquiry denominators separate from intake denominators.
4. Define safe automated resolution as: eligible inquiry started, authorized customer-scoped tool succeeds, response is shown, no unsafe outcome and no handoff required. Report numerator and denominator by language.
5. Add a focused result to the evidence pack. Do not call a transaction list a balance, explanation of a charge or dispute resolution.
6. Run:

   ```bash
   cd front-end && npm test -- --watch=false && npm run build
   cd .. && make intake-test
   node back-end/scripts/capture-intake-evidence.mjs --target local
   ```

   Expected: the existing intake flow still passes; inquiry cases have explicit all-case denominators and zero cross-customer disclosure.

**Commit:** `feat: add safe recent-transactions inquiry`

## Program completion checklist

- [x] PR #18 is in `main` at `daf7ed8`.
- [ ] PR #19 is reviewed, fixed and merged into `main`, carrying PR #15's content.
- [ ] Workers Builds deploys from `main` and production D1 migration state is checked before deploy.
- [ ] ADR-002 has a final decision recorded by named deciders.
- [ ] Retention and reset behavior are documented, runnable and verified against preserved seed data.
- [ ] A raw Worker event export passes the existing scorer without hand editing.
- [ ] Retries emit no duplicate chain events; unfinished episodes remain in the denominator.
- [ ] A named independent reviewer froze the ES/PT set before system comparison.
- [ ] Accessibility tests and the manual keyboard/screen-reader/mobile audit pass for the demo path.
- [ ] The evidence pack records commit, seed version, sample sizes, p50/p95, D1 usage, screenshots and limitations.
- [ ] Hostname-wide Access denial and the application-level authorization boundary are both evidenced.
- [ ] The read-only inquiry is shipped only if the six core tasks are complete and its ADR is accepted.

## Suggested PR sequence

| PR | Scope | Depends on |
|---|---|---|
| A | Fix and merge #19; move production builds to `main` | Current `main` |
| B | Decide ADR-002 | Named deciders |
| C | Worker event emission/export | #18 and PR A |
| D | Retention policy and reset | PR C |
| E | Frozen ES/PT set | Independent reviewer |
| F | Accessibility fixes/audit | Current UI contracts |
| G | Judge evidence pack | C–F |
| H | Optional recent-transactions inquiry | B and G |
