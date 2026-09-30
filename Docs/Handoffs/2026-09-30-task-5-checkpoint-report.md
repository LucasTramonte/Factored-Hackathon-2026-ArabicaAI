> Historical capture before controller checkpoint commits. References to uncommitted files, old HEAD and old branch describe the capture time. These changes are now saved in `ba7d062` on `codex/intake-backend-completion`. See the companion handoff for current state. Task 5 was later completed on top of this checkpoint; see the [Task 5 completion note](2026-09-30-task-5-completion.md).

# Task 5 partial recovery report

Status: INCOMPLETE / UNREVIEWED. User requested a save/commit/push checkpoint and Markdown handoff instead of completing implementation. Controller owns that commit/push/handoff; this recovery agent did not commit or push. Product edits and test execution stopped after the instruction. HEAD remains `f649395d22ff79462cbb3b861f18bd9fa07dd6bf`, branch `codex/intake-online-design`.

Workspace: `<implementation worktree>`.

## Requirements and source context read

Read exact Task 5 brief, global constraints and approved completion design; did not read whole implementation plan. Used TDD, verification-before-completion, Workers and Wrangler skill instructions. Startup reading performed directly because parent prohibited own agents: source index, all four original PDFs in full through pdftotext with dictionary pages 4–13 revisited after output truncation; visually inspected kickoff p6 timeline and dictionary p4 overflowing product table; BUSINESS_OUTCOMES, ARCHITECTURE, REPRODUCIBILITY and ADR002–004. No credential-bearing updated dictionary, AWS credential files, frozen corpus or model calls accessed.

Task grounding: problem statement pp3–6 requires grounded authenticated ES/PT clarification/handoff, actual verified actions, failures in results and explicit denominators. p6 separates handoff/containment from resolution. Dictionary p7 transaction keys/ownership and nullable USD; pp11–12 complaint grain has no transaction key. Summary pp2–5 documents synthetic Spanish data rather than Portuguese demand. Source index verified newer dictionary schema unchanged. ADR002 accepted deterministic unrecognized-charge intake with human handoff; inquiry resolution is a separately required decision, not implied by HTTP success.

Verified current official `getPlatformProxy` persistence semantics and explicit remote-binding control at https://developers.cloudflare.com/workers/wrangler/api/ (persist path includes v3 explicitly; remoteBindings default true, so bridge passes false by default). Installed Wrangler4.143.0 types support envFiles, persist and remoteBindings. Node24.14.1. Read official D1 pricing and limits: https://developers.cloudflare.com/d1/platform/pricing/ and https://developers.cloudflare.com/d1/platform/limits/ . No remote migration/import/deploy/tag, provider request, new dependency or automation.

## Current uncommitted product changes

Inherited partial edits preserved:

- `back-end/src/store/d1.js`: bounded closeIdleIntakes and keyset exportIntakeEvents methods. Close emits v2 abandoned/not_assessed end only for due selection_required episodes without a reservation; pending reservations skipped. Export includes pending starts and terminal episodes in complete ordered groups, limits100 episodes /102 event overflow sentinel /4096chars per event.
- `back-end/migrations/0005_intake_evidence_indexes.sql`: additive partial deadline expression index and queue accepted_at/protocol expression index; applied by existing fresh local-D1 harness only. Queue index removes protocol tie-sort but pending density still affects scans.
- `back-end/scripts/intake-store.mjs`: native installed-Wrangler D1 bridge, local by default, explicit --remote controls remote binding; temporary minimal configuration avoids assets/vars/secrets and envFiles=[]; dispose/cleanup finally.
- `back-end/scripts/close-idle-intakes.mjs`: manual bounded page CLI, generic errors only; no scheduler.
- `back-end/scripts/export-intake-events.mjs`: strict reviewed producer/reference/field allowlist, existing Python scorer validation, atomic rename under ignored data/intake-events, prior validated artifact retained on failure. Captured scorer stdout/stderr; no raw D1 CLI response handling.
- `back-end/test/integration/intake.test.js`: native-binding/shared-local-D1 idle/export integration, privacy and scorer denominator checks.
- `back-end/test/unit/intake-evidence.test.js`: real SQLite fixture/scorer tests for idle/expired/active/pending, once-only closure, pagination, terminal failure/safe fixture acceptance/unknown usage, hostile fields/references, CLI generic errors and atomic artifact retention.

Recovery additions:

- Fixed close update to target the same limited indexed due page as insert; inherited update could update more than limit when preexisting end rows existed. Added failing/passing regression covering limit1 with two such rows. Split JSON object into json_patch of two json_object calls, each below official32-argument limit.
- Replaced unit test's absolute Python fallback with ROOT/.venv/bin/python; INTAKE_PYTHON overrides it for worktree execution.
- Added invalid/oversize/overflow/scorer-failure artifact-retention checks (real scorer owns value/sequence validation).
- Modified `back-end/test/integration/budget.test.js`: legacy ceilings unchanged; provisional new ceilings, new full guided endpoint/episode test, and100-reservation fixture (50terminal/50pending, equal timestamps). THESE NEW CHECKS ARE UNFINISHED AND CURRENT FULL SUITE IS RED. Do not present provisional ceilings as accepted evidence.

Tracked diff stat excludes untracked new files:3 files,118insertions/1deletion. No docs requested by Task5 have been changed yet.

## Commands/tests actually run and results

Root commands used workspace above; npm commands used its back-end directory. INTAKE_PYTHON was `<original checkout>/.venv/bin/python`.

1. Scratch recovery RED: copied bounded source/scripts/migrations/evals/test into `<temporary scratch directory>`, symlinked installed node_modules and replaced scratch d1.js with `git show f649395:back-end/src/store/d1.js`. Current working files never reverted. `INTAKE_PYTHON=... node --test "$(cat /tmp/task5-red-path)/back-end/test/unit/intake-evidence.test.js" > /tmp/task5-recovered-red.log 2>&1`: tests2/pass0/fail2. First assertion says bounded idle closure missing (actualundefined vsfunction); second export fails because base store has no export method. Initial worker RED logs were not recovered; these are newly observed recovery checks, not claimed original TDD chronology. Shell command also displayed log afterward, so returned combined shell exit0 despite recorded failing test output.
2. `INTAKE_PYTHON=... node --test back-end/test/unit/intake-evidence.test.js` against inherited partial working feature: exit0,tests2/pass2/fail0.
3. `INTAKE_PYTHON=... npm test > /tmp/task5-inherited-npm.log 2>&1`: exit0;unit58/pass58/fail0;localD1 integration25/pass25/fail0. Fresh isolated harness applies0001–0005 before seeds/Worker. Legacy customer episode10queries/10read/7write unchanged. Integration exporter17episodes/read79/onequery/oneroundtrip. No remote execution.
4. Added page-bound and artifact-invalid regressions. `INTAKE_PYTHON=... node --test back-end/test/unit/intake-evidence.test.js > /tmp/task5-bounds-red.log 2>&1`: exit1;tests4/pass2/fail2. Correct regression fails close return2 whenlimit1. Other failure was a TEST mistake: seq99 is allowed nonnegative sequence, scorer does not require seq0; corrected test to seq-1, not product behavior.
5. Same command to `/tmp/task5-bounds-red-final.log`: exit1;tests4/pass3/fail1; only correct close bound regression2!=1 remains.
6. After bounded-update fix and JSON argument split, same command to `/tmp/task5-bounds-green.log`: exit0;tests4/pass4/fail0. No cancellations/skips/todos.
7. Latest `INTAKE_PYTHON=... npm test > /tmp/task5-budget-npm.log 2>&1`: exit1;unit60/pass60/fail0;localD1 integration27/pass25/fail2. EXACT failures:
   - `guided endpoints and a full customer episode preserve measured D1 budgets`: intakeConfirmReplay reads42 exceeds provisional40 (queries17/write0/roundtrips7).
   - `50-row queue scan budget is qualified against 50 terminal and 50 pending tied reservations`: Unknown contract agentIntakeQueue. Correct existing contract is agentIntakeList.
   No cancellations/skips/todos. Existing native node:sqlite ExperimentalWarning appears; output is not pristine.

Latest npm was launched after a command-directory mistake: attempted corrective Python/rg commands had duplicated back-end prefix while cwd already back-end, so correction never applied; subsequent npm still ran. This is why the issues below remain. Do not treat path mistakes or unknown-contract failure as feature RED evidence.

## Latest local counters (queries / rows read / rows written / round trips)

From latest RED full suite; these are observations, not final qualified capacity:

- Legacy login4/2/3/3; list2/4/0/2; create4/4/4/4; agentlogin2/1/3/1; legacy agentlist2/17/0/2. Legacy customer episode10/10/7 (3API requests).
- Guided start6/6/13/2; startreplay6/4/3/2.
- Complete confirmation18/54/25/8; completereplay17/42/0/7; incomplete14/38/17/7.
- Small new queue2/5/0/2; completedetail3/12/0/3; incompletedetail3/6/0/3.
- Combined start +findIntake +twoidle sweeps printed10queries/read21/write17/roundtrips4; NOT an isolated per-sweep budget.
- Export100episodes1query/read417/write0/roundtrip1; earlier17episode page read79.
- Full50row queue metrics and full guided episode aggregation were not printed because new tests failed before those outputs. No storage measurement performed.

Added indexes changed writes from parent prior measures: start11→13, startreplay2→3, complete24→25, incomplete16→17. These increases must be explained in ADR004. Existing row-read values vary with concurrent/retained session population; replay42 vs earlier35 must be understood and qualified rather than blindly increasing ceiling.

## Remaining work and known risks

1. Finish budget test correctness BEFORE interpreting results:
   - agent detail path must be `/agent/intake-detail?protocol=...`; unfinished tests currently use `/agent/intakes/<protocol>`.
   - queue contract agentIntakeList; queue field items, not handoffs.
   - native fixture evidence should match production shape `{transaction:null}` rather than JSON null (current evidence:null would break detail if those fixtures were read).
   - replay provisional read ceiling40 currently fails at42; explain retained session scans/current population and justify any corrected ceiling. Preserve legacy ceilings.
   - qualify <=100reservation fixture and pending/tie density; this is a fixture workload, not an approved import capacity or universal queue scan bound.
2. Measure each new endpoint, full guided episode and50row queue; measure standalone housekeeping/export counts and storage with declared bounded-memory fixture. Export memory bounded at100episodes×101accepted events×4096chars, plus102overflow sentinel per SQL group; scorer buffers only bounded page. No full fact key lists.
3. Review store/export trust/privacy edge cases. Cursor regex permits36hyphen/hex strings lacking UUID structure; can tighten with a regression if relevant. Parent/base path symlink escape may need explicit ignored-destination validation; nested escape is checked but base realpath may itself point outside ignored data. No change made for these potential risks. Idle only covers current guided selection_required state; handoff_pending never abandoned without authority/read-back reconciliation. Future states/AI producer require separate reviewed allowance; current model_version allowlist guided-0.1 only.
4. Complete required docs: ADR004 new measurements/write/storage/capacity assumptions replacing stale10k/day claim; back-end README CLI usage/local flags/limits; intake-events docs cutoff/privacy/timing/tool scope/retention; unaccepted inquiry decision draft at Docs/Plans/recent-transactions-resolution-decision.md with no ADRnumber. Original Bronze owner mismatches are source anomalies; random generation mechanism is an inference, not proven generator provenance (existing older reports overstate it). No analysis rerun yet.
5. Inquiry resolution numerator UNAVAILABLE until separately implemented session-bound idempotent frontend display acknowledgment AND team decision. Backend retrieval success is not resolution; never infer zero or count HTTP success. Frontend excluded.
6. Preserve Task3 limits prominently: lifecycle duration is server walltimestamp start→terminal invocation including thinktime/retries, backward drift clampedzero; monotonic peroperation elapsed lives in restricted usage_json and excludes final acknowledgment roundtrip. Tool ledger counts startstorage/transactionlookup/persist/readback/finalize; auth/session/idempotency housekeeping separateD1 counters. Dualoperation+ledgeroutage usage irrecoverable; no production allattempt costqualification/safetyassessment.
7. Retain operational episodes/turns/handoffs/events/cases through October31; expired sessions still purge. Do not reuse old DELETEcases recipe across FKs. No remote cleanup/automation authorized in this task.
8. Run required final Worker suite and rootPython `-m pytest evals/intake/test_episodes.py -q`; explicitly feed localJSONL through existing scorer and reconcile eligible_started pending/failed and unknown tokens. Python episode suite not run in recovery. No final selfreview, gitdiffcheck or scopedcommit performed.
9. Controller requested spec metadata update only after tested completion: it currently still says Implementation has not started. Reflect Tasks1–5 locally implemented only when true, review pending/complete honestly, Task6 gated andfrontend deferred; do not rewrite requirements.
10. External main557f45d merged designonly PR29 at3d75a9b; runtime unchanged. Do not switch/rebase/push on behalf of recovery. New implementation PR later owned controller. Task6 read-only audit gated by missing approved adapter/servingcontract/registration decisions; no AI invented.

## Process state at checkpoint

Latest unified exec session35768 finished exit1; prior session55684 finished exit0. `pgrep -alf 'task5-budget|arabica-worker|test/run-local|wrangler.*dev|node --test'` returned no matches at checkpoint. No live test/CLI process known; harness removed its isolated temp D1. Scratch recovery directory and logs above remain ignored/outside repo; `/tmp/task5-red-path` points to scratch. No generated artifacts were added to Git. This report is ignored orchestration storage and is the only write after pause/save instruction.
