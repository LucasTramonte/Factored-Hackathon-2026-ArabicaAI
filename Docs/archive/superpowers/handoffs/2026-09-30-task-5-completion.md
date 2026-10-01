# Task 5 completion: idle closure, export and cost evidence (2026-09-30)

This finishes Task 5 of the [backend completion plan](../plans/2026-09-29-intake-backend-completion.md) on top of the checkpoint in [the handoff](2026-09-30-intake-backend-handoff.md) and [its report](2026-09-30-task-5-checkpoint-report.md). The work is on branch `claude/gifted-einstein-mi8vh3` (PR #31), starting from `052ba28`. It was verified locally only. Task 5 was independently reviewed (spec and quality), fixed and re-reviewed with approval. The whole-branch review's findings are addressed in the final fix wave below. Task 6 remains gated and the frontend deferred. There was no remote D1, deploy, model call, frozen or withheld case access, or credential file read.

## Commits

| Commit | Scope |
|---|---|
| `3841b8c` | `test: qualify guided D1 budgets and storage; add FK-ordered demo reset` |
| `2a4684f` | `feat: page intake exports and idle sweeps with bounded, quiet operator CLIs` |
| `f695b15` | `ci: run the Worker suite with a stdlib Python scorer` |
| `7a2a7f1` | `docs: record guided intake capacity and export operations` |
| `f45f5e6` | `fix: harden intake export and idle sweep after Task 5 review` (fix wave) |
| `353c184` | `docs: record the idle-sweep ruling and fix-wave evidence` (fix wave) |
| `ceee33c` | `fix: drop superseded intake indexes and add state checks before merge` (final wave) |
| `7e59da6` | `fix: tighten intake routing, refused reservations, sweep ends and scorer lookup` (final wave) |
| `0e81b8a` | `docs: record the final fix wave and the guided backend's current state` (final wave) |
| `98e4574` | `fix: end eventless idle episodes at sequence 0 and refresh handoff banner` (whole-branch re-review nits) |

## What changed and why

- **Budget checks** (`back-end/test/integration/budget.test.js`, `back-end/test/run-local.mjs`). The fixes follow the checkpoint findings: the detail path is `/agent/intake-detail?protocol=`, the queue contract is `agentIntakeList` with `items`, and the fixture uses the production evidence shape `{transaction: null, tool_status: 'ok'}`. The tests now measure every guided endpoint, including incomplete replay, both customer episodes, one idle page, a no-op sweep, one export page, and the 50 + 50 tied queue. The budget file runs last, in its own `node --test` call; the runner orders files itself, so sorting the list was not enough. That way its 200 fixture rows can't change earlier suites.
- **Replay 42 > 40.** No scan is involved. Every replay statement plans as an index `SEARCH`. Seven lookups (reservation lookup ×2, receipt read-back, four event `INSERT … SELECT`s) each read one more row once a following index entry exists: 35 on an empty store, 42 at every larger size measured, up to 25,006 episodes. The ceiling is now 45, with the per-statement breakdown in ADR-004. A `UNIQUE` owner index was tried on a scratch copy and did not help, so there is no schema change.
- **Export** (`back-end/scripts/export-intake-events.mjs`, `back-end/src/store/d1.js`). The checkpoint exporter published only the first page: its limit-2 run exported 2 of 5 episodes. It now walks every keyset page (at most 100 pages of 100 episodes) into one file, scores it, and publishes it atomically, or fails and keeps the previous artifact. The cursor must be a lowercase RFC 4122 UUID; the old pattern accepted 36 hyphens. The destination must resolve inside `data/intake-events` inside `data/`. A scratch copy of the checkpoint code did publish through a base symlink to an outside directory; that path is now rejected with regressions.
- **Idle closure** (`back-end/scripts/close-idle-intakes.mjs`, `back-end/src/store/d1.js`). The end event records the deadline, min(activity + 10 min, session expiry), as its `ts` and `duration_ms`. *Corrected in the fix wave:* only those two values are deadline-anchored. Whether an episode is abandoned at all depends on when the sweep runs, so the statement in `2a4684f`'s commit message that results do not depend on sweep cadence is superseded. The script sweeps up to 100 atomic pages at one cutoff and reports `complete`. A new regression drives a real committed reservation through sweeps: it stays `handoff_pending`, and only the live same-owner session finishes it.
- **Generic CLI output** (`back-end/scripts/intake-store.mjs`). In this container, Wrangler's proxy notice and Node's `punycode` warning reached stderr. The CLIs now import Wrangler lazily after setting `WRANGLER_LOG=none`, `WRANGLER_WRITE_LOGS=false`, `WRANGLER_SEND_METRICS=false` and `process.noDeprecation`. Tests assert exact stderr for argument errors, a real D1 failure (`no such table`) and a scorer that echoes content. Miniflare had also written `.wrangler/cache/cf.json` into the working directory. Its cache now sits beside the ignored D1 state, and `.wrangler/` is ignored everywhere.
- **Storage and reset** (`back-end/test/unit/intake-storage.test.js`, `back-end/scripts/reset-demo-activity.sql`). Storage per episode is measured with `dbstat` and bounded in CI. The old `DELETE FROM cases; DELETE FROM sessions;` now fails on `intake_handoffs.complete_case_id`. The new script deletes in foreign-key order. It was checked against the migrations in a unit test and against a local Miniflare D1, where activity went to 0 with 2 customers and 3 transactions kept.
- **CI** (`.github/workflows/quality.yml`). The web job now sets up Python 3.10 with the pinned `setup-python` action and runs the Worker tests with `INTAKE_PYTHON: python`. `evals/intake/episodes.py` is stdlib-only and parses with the 3.10 grammar.
- **Documentation.** The documentation commit covers:
  - `Docs/ADRs/ADR-004-intake-capacity-and-cost.md`: dated notes and the measured guided section.
  - `back-end/README.md`: routes, operator scripts, reset and limits.
  - `Docs/intake/intake-events.md`: the producer, timing, ledger, idle rule, export run start and allowlist, and retention.
  - `Docs/Plans/recent-transactions-resolution-decision.md`: an unaccepted proposal without an ADR number.
  - The spec status line and the plan boxes.

## Measured (local D1; details in ADR-004)

This table records the first Task 5 pass, with fix-wave rows marked. Final values after the 0004 edit are in the Final fix wave section below and in ADR-004. Figures are queries / rows read / rows written / round trips. Where two read values appear, the first is an empty store and the second is with neighbouring rows present.

| Unit | Measured | Ceiling |
|---|---|---|
| start | 6 / 6 / 13 / 2 | 6 / 8 / 13 / 2 |
| start replay | 6 / 4 / 3 / 2 | 6 / 6 / 3 / 2 |
| confirm | 18 / 46 → 54 / 25 / 8 | 18 / 60 / 25 / 8 |
| confirm replay | 17 / 35 → 42 / 0 / 7 | 17 / 45 / 0 / 7 |
| incomplete | 14 / 33 → 38 / 17 / 7 | 14 / 42 / 17 / 7 |
| incomplete replay | 14 / 28 → 33 / 0 / 7 | 14 / 36 / 0 / 7 |
| queue, 50 terminal + 50 pending tied | 2 / 203 / 0 / 2 | 2 / 225 / 0 / 2 |
| detail, complete / incomplete | 3 / 12 / 0 / 3 and 3 / 7 / 0 / 3 | 3 / 15 / 0 / 3 and 3 / 10 / 0 / 3 |
| complete episode (login, list, start, confirm) | 30 / 66 / 41 / 15 | 30 / 72 / 41 / 15 |
| incomplete episode (login, list, start, handoff) | 26 / 50 / 33 / 14 | 26 / 56 / 33 / 14 |
| idle page of 100 / no-op sweep (fix wave) | 2 / 1,100 / 400 / 1 and 2 / 6 / 0 / 1 (first pass: 800 and 5) | 2 / 1,210 / 400 / 1 and 2 / 10 / 0 / 1 |
| due probe (fix wave) | 1 / 1 / 0 / 1 | 1 / 3 / 0 / 1 |
| export page | 1 / 2 × episodes + events / 0 / 1 (419 for 100 episodes and 219 events) | 2 × episodes + events + 2 per page (first pass: flat 700) |

- **Legacy ceilings** are unchanged: login 5/10/6/3, list 2/25/0/2, create 4/12/6/4, agent login 3/6/6/1, agent list 2/250/0/2.
- **Storage per complete episode:** 5,161 B at a typical statement, 12,739 B at 2,000 ASCII characters and 21,422 B at 2,000 four-byte code points. For an incomplete episode: 3,482 B, 7,209 B and 11,837 B.
- **Capacity on Free:** rows written binds, at about 2,127 complete episodes a day on the ceiling basis (2,272 measured). The legacy 10,000-a-day figure applies to `/cases` only.
- **Migration 0005's writes:** the idle index adds 2 to start and 1 to replay; the queue index adds 1 per handoff.

## Commands and results (all from the repository root)

| Command | Result |
|---|---|
| `INTAKE_PYTHON=$PWD/.venv/bin/python npm --prefix back-end test` | unit 70/70; integration 25/25, then budget 4/4 |
| `INTAKE_PYTHON=python3 npm --prefix back-end test` (3.11, no venv) | 70/70; 25/25; 4/4 |
| `INTAKE_PYTHON=python3.10 npm --prefix back-end test` | 70/70; 25/25; 4/4 |
| `.venv/bin/python -m pytest evals/intake/test_episodes.py -q` | 14 passed, 75 subtests |
| `uv run --no-project --python /usr/bin/python3.10 --with pytest python -m pytest evals/intake/test_episodes.py -q` (ephemeral environment outside the repository) | 14 passed, 75 subtests |
| `make test` | 202 passed, 31 subtests |
| `make intake-test PYTHON=.venv/bin/python INTAKE_PYTHON=$PWD/.venv/bin/python` | see below |
| `node --check` on every changed JavaScript file; `git diff --check` / `git diff --cached --check` before each commit | clean |

`make intake-test` first stopped at the Angular step with `No binary for ChromeHeadless browser on your platform. Please, set "CHROME_BIN" env variable.` With `CHROME_BIN=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` it stopped with `Running as root without --no-sandbox is not supported`. With `CHROME_BIN` set to an uncommitted wrapper that adds `--no-sandbox`, the whole target passed: Gold pytest 61 passed, Angular 17 SUCCESS, UI build, Worker 70/70 + 25/25 + 4/4. No frontend file changed.

**Scorer reconciliation.** In the integration test, the exported JSONL is rescored with `python -m evals.intake.episodes`. The rescored summary equals the exporter's, `eligible_started` equals the number of exported episodes (18: 5 accepted, 4 routed, 1 abandoned, 8 pending), `usage_unknown_episodes` equals the pending count, and token totals are 0, not null, because the guided flow makes no model call.

A scratch run also covered every outcome on a separate local D1 with the real CLIs. It found 9 episodes in SQL (2 complete, 2 incomplete, 1 technical, 1 abandoned, 1 pending reservation, 2 open). The scorer gave `eligible_started` 9 with outcomes accepted 2, routed 2, technical_failure 1, abandoned 1 and pending 3, and `usage_unknown_episodes` 3. The pending reservation was not closed by the sweep.

**RED evidence.** The new `intake-evidence` tests, run against the `052ba28` store and scripts in a scratch copy, failed 8 of 12. The failures were:
- the missing `complete` flag
- the sweep-time `ts` (17:00 instead of the 12:10 deadline)
- 2 of 5 episodes exported
- the hyphen cursor accepted
- no data-root seam
- the proxy and `punycode` stderr, in two tests
- the old close result shape

## Not done, and open risks

- **Reviews:** the independent Task 5 spec and quality review, and the fresh whole-branch review, are still needed.
- **Measurement limits:**
  - The guided endpoints have no remote, CPU or latency measurement.
  - All figures are local counters on bounded fixtures (up to 25,006 episodes), not production evidence or an approved Gold import size.
  - Pending-reservation density has no structural bound, which affects queue reads.
- **Not changed:**
  - The cost workbook still models the legacy flow and was not regenerated.
  - The start renewal `UPDATE` costs 3 writes on a first start; that saving is not made.
  - The register labels the random-draw cause for DF-002 "confirmed in Bronze". The proposal treats the cause as an inference, while the mismatch itself is observed. `DATA_QUALITY.md` was not edited.
- **Environment:** Miniflare still fetches `cf.json` from Cloudflare when a local binding starts. It is cached under ignored directories.

## Fix wave after independent review (2026-09-30)

The independent Task 5 spec and quality reviews both returned CHANGES REQUIRED, with no Critical finding. This wave applied the controller's list on top of `7a2a7f1`. The implementer did not push; the controller pushed the branch. Nothing was run remotely, or sent to a model, and no frontend file changed.

### Rulings recorded

- **Idle abandonment is applied only by the manual sweep.** The online confirm and handoff path does not enforce the deadline. Enforcing `MIN(updated_at+600000, expires_at)` in the reservation would break the reviewed Task 2/3 invariant that a renewed same-owner session resumes its episode (a confirm from a renewed session doesn't rebind `expires_at`). Changing that is a team decision.
  - *Consequence:* outcome classification and duration depend on sweep timing. The operator procedure is to sweep immediately before export, at the same cutoff.
  - *Cost if wrong:* outcome counts depend on sweep discipline, and enforcing it online would need a team decision plus a Task 2/3 behaviour change.
- **A same-key start replay returns the original immutable start receipt** (`state: selection_required`), even after abandonment or handoff. After abandonment, with no reservation, a later confirm returns 409 "Episode is no longer open". After a handoff, a different key or content gets 409 "Episode already submitted with different content or key", and the same key and content replays the receipt (200). Documentation only; no behaviour change.

### Changes

- **Export cost check** (`budget.test.js`): the per-page ceiling is 2 × episodes + events + 2. It is measured on a first page that is not the whole table and on a page after a cursor. The ADR-004 formula is corrected. A scratch store of 130 episodes shows an injected `intake_episodes` full scan reading 530 rows. That passed the old flat 700 and now fails its computed ceiling of 402.
- **Destination boundary:** the export now also rejects a `data` that is the repository or one of its ancestors, and a resolved parent inside the repository but outside `data/`. The regression is the reviewer's two-link case: data → the repository's parent, and `<parent>/intake-events` → `back-end/src`.
- **`--now`:** rejected when empty, signed, fractional, in exponent form, or more than 60 s past the clock. The CLI checks this before opening the store (`sweepOptions`), and the store also refuses a cutoff beyond `maxNow`, which defaults to now + 60 s and can be overridden for fake-clock tests.
- **Allowlist:** `scenario` is dropped for `guided-0.1`; an injected `scenario: 'demo-ana'` now fails the export.
- **Idle sweep:**
  - The end event is appended at the next sequence number, found with a MAX lookup that SQLite answers from the index.
  - The state update requires the episode's latest event to be the abandoned end.
  - `complete` now comes from a final `hasDueIdleIntakes` probe, not from page size.
  - Regressions: a non-terminal event at seq 1 (previously stuck), and a stub store whose short page leaves due work behind (`complete: false`).
- **Exporter errors:** they carry `cause`; the CLI still prints exactly `Export failed`. The negative tests now assert the intended cause (`Invalid event`, `Invalid reference`, `Invalid group`, `Invalid destination`, `Invalid bounds`, `Page bound reached`, or scorer `Command failed`). The oversize case now uses an allowed field, so it can't pass through the allowlist instead. CLI numbers are validated strictly before any store is opened (`exportOptions`). An integration contrast shows the same D1 exporting with valid flags and failing with `--max-pages 0`, `101`, `--limit 0` or `1.5`.
- **File writes:** each page uses `FileHandle.writeFile` (full write), followed by `sync()` before close and rename.
- **Output field:** the export's `cutoff` is renamed `started_at`, because it labels the run start and is not a data bound. The idle CLI keeps `cutoff`, which is its real cutoff.
- **Documentation:**
  - `intake-events.md`: guided `duration_ms` is an episode span, and scorer latency measures that span; the idle ruling; replay receipts; ledger exceptions for 404 and 401-after-lookup.
  - `back-end/README.md`: the same rules for operators.
  - ADR-004:
    - the 47-row basis for the 2,127/day figure
    - the retention procedure replacing the old recipe, with a dated note
    - the export's 10,000-episode bound versus S3's roughly 26,000 over the window, recorded as a limitation
    - technical-path scratch figures (14/38/17/7, replay 15/33/0/7, detail 3/7/0/3; not CI-enforced)
    - the superseded 0004 indexes (13→11, 25→22, 17→14 writes when dropped in a scratch D1; kept, dropping needs a team decision)
    - the legacy-only 10,000 capacity in the observability line
  - Also updated: root `README.md` capacity line, `requirements-traceability.md` S8, and the DF-002 caveat in the proposal.

### Measurements that changed

- **Idle page:** 800 → 1,100 rows read (writes unchanged at 400). It is identical at CI size and at 5,004 and 25,006 episodes. The ceiling is 1,210.
- **No-op sweep:** 5 → 6 reads.
- **Due probe (new):** 1 / 1 / 0 / 1.
- **Unchanged:** every customer and agent endpoint.

### Commands and results (fix wave)

| Command | Result |
|---|---|
| `INTAKE_PYTHON=python3 npm --prefix back-end test` | unit 74/74; integration 25/25, then budget 4/4 |
| `INTAKE_PYTHON=$PWD/.venv/bin/python npm --prefix back-end test` | unit 74/74; integration 25/25, then budget 4/4 |
| `.venv/bin/python -m pytest evals/intake/test_episodes.py -q` | 14 passed, 75 subtests |
| `node --check` on the changed JavaScript files; `git diff --check` | clean |

**Failing-first evidence:** the updated `intake-evidence` file (16 tests), run against `7a2a7f1`'s store and scripts in a scratch copy, failed 11 of 16.

## Final fix wave after the whole-branch review (2026-09-30)

A fresh whole-branch review of `origin/main...353c184` returned CHANGES REQUIRED: 1 Important and 8 Minor. The Task 5 re-reviews approved, with minor nits. This single final wave addressed the list. The implementer did not push; the controller pushed the branch. Nothing was run remotely, no model was called, no frontend source changed, and no frozen case was read.

### Disposition

| Finding | Disposition |
|---|---|
| I1 `npm test` needed `.venv` | **Fixed.** `back-end/scripts/scorer-python.mjs` resolves `INTAKE_PYTHON`, then `<root>/.venv/bin/python` if it exists, then `python3`. The exporter and the unit and integration tests share it, and a unit test covers the order. `back-end/README.md` states the Workers Builds deployer action: `python3` on `PATH`, or set `INTAKE_PYTHON`. Verified in a scratch clone without `.venv` or `INTAKE_PYTHON`: `npm test` unit 79/79, integration 29/29, budget 4/4. |
| M1 `/intake` prefix | **Fixed.** The prefix is now `/intake/` plus the bare `/intake` namespace, so `/intakes`, `/intakeX` and `/intake-foo` reach the assets. Unit tests check `run_worker_first` against the router in both directions, plus the look-alike paths. |
| M2 legacy `/agent/cases` lists pending complete cases | **Documented, not changed.** Per the controller's ruling, the plan's global constraints preserve the legacy `/agent/cases`. `back-end/README.md` (agent routes), `intake-events.md` (Legacy case list) and ADR-004's limitations say that `/agent/intakes` is authoritative and that pending reservations stay pending in the denominator until retried. |
| M3 refused reservation always 503 | **Fixed.** The attempt is recorded, then a fresh read decides: 401 (no live same-owner session), 409 "Episode is no longer open" (closed without a reservation), otherwise 503. Unit tests cover session expiry within the SQL, a racing sweep, a vanished transaction and a failing re-read. The `intake-events.md` ledger exceptions are updated. |
| M4 superseded indexes | **Fixed by editing 0004 before merge**, per the controller's decision. `intake_episodes_updated` and `intake_handoffs_queue` are removed. CHECKs are added on `state` (the six written states), `destination = 'case_service'` and `priority = 'normal'`. The superseded-index note is replaced by a dated note. The README and ADR-004 tell anyone with a pre-merge local D1 to recreate it. |
| M5 AGENTS.md matrix for new routes | **Fixed.** The confirm, handoff, queue and detail routes are in the adversarial gate/credential/405 matrix. The suite adds guided path tricks, identical bodies for foreign and missing episodes or transactions, 10 concurrent identical handoffs (one 201, nine 200, one chain), and 3 trials of 6 concurrent divergent confirm/confirm/handoff requests (exactly one 201, one identical 200, the rest 409; one reservation and one end event; retries agree). |
| (e) second end event | **Fixed.** The sweep never inserts an end when the latest event is already `intake_ended`. An existing abandoned end closes the state without a second event; another end blocks the change and stays visible as due work. The test asserts exactly one end event. |
| (c) next sequence evaluated twice | **Fixed.** The latest event is read once per episode through a derived table that SQLite cannot flatten (it has a LIMIT and the outer query a WHERE); the plan shows a co-routine with index SEARCHes. Measured reads stay 1,100 per 100-episode page: saving the second lookup paid for the end-event guard. ADR-004 wording matches. |
| M8 duplicated UUID regex / packed tests | **Partly fixed.** The agent detail route reuses the exported `UUID` from intake validation. Reformatting the packed single-line tests is **declined** (churn), per the controller's ruling. |
| M6 stale docs | **Fixed:** the root README status block; `intake-roadmap.md` rows (classify outcome, tool error, case kinds, human review, offline evaluation); traceability S6; the review-status lines in the spec (one sentence), the plan and this note; the plan's PR #29 item, annotated without changing the requirement. |
| M7 personal paths | **Fixed.** `<implementation worktree>`, `<original checkout>` and `<temporary scratch directory>` replace the personal paths in both handoff documents. |
| (a) 409 wording | **Fixed** in `intake-events.md`, the `back-end/README.md` route table and this note. "Episode is no longer open" applies only after abandonment, with no reservation. After a handoff, a different key or content gets "Episode already submitted with different content or key", and the same key and content replays 200. |
| (b) DF-002 caveat | **Fixed**, with the same wording in the proposal and this note. |
| (d) push wording | **Fixed.** |

### Re-measured (old → new; local D1, CI run; ceilings never loosened)

- **start:** 6 / 6 / 13 / 2 → 6 / 7 / 11 / 2, ceiling 6 / 8 / 11 / 2 (writes were 13).
- **start replay:** 6 / 4 / 3 / 2 → 6 / 5 / 2 / 2, ceiling 6 / 6 / 2 / 2.
- **confirm:** 18 / 54 / 25 / 8 → 18 / 56 / 22 / 8, ceiling 18 / 60 / 22 / 8.
- **incomplete:** 14 / 38 / 17 / 7 → 14 / 40 / 14 / 7, ceiling 14 / 42 / 14 / 7.
- **Unchanged:** confirm replay 42, incomplete replay 33, details 12 and 7, and the 50 + 50 queue 203.
- **Complete episode:** 30 / 66 / 41 / 15 → 30 / 69 / 36 / 15, ceiling 30 / 72 / 36 / 15.
- **Incomplete episode:** 26 / 50 / 33 / 14 → 26 / 53 / 28 / 14, ceiling 26 / 56 / 28 / 14.
- **Where the reads come from:** the CHECKs add one counted read per statement that writes an episode row, separated by applying old and new 0004 to separate scratch D1s. The removed indexes cut 2–3 writes per request.
- **Idle page of 100:** 2 / 1,100 / 400 / 1 → 2 / 1,100 / 300 / 1, ceiling 2 / 1,210 / 300 / 1. The no-op sweep (6) and due probe (1) are unchanged.
- **Storage per complete episode** (typical / 2,000 ASCII / 2,000 four-byte): 5,161 / 12,739 / 21,422 B → 4,997 / 12,534 / 21,299 B, bounds 5,500 / 13,800 / 23,400. Incomplete: 3,482 / 7,209 / 11,837 → 3,318 / 7,045 / 11,674 B, bounds 3,700 / 7,800 / 12,900.
- **Capacity per complete episode with one agent look:**
  - measured 282 / 44 → 285 / 39 rows read / written;
  - at the ceilings, 318 / 47 → 318 / 42;
  - Free capacity by rows written: 2,127 → **2,380 a day** (measured basis 2,272 → 2,564).
- **S1–S4 writes a day:** 799 / 6,815 / 38,446 / 384,460 → 714 / 6,090 / 34,356 / 343,560. S4 still exceeds the Free write quota, so Workers Paid is needed.
- **Storage after 32 days at S3** (typical / 2,000 ASCII / 4-byte): 149 / 367 / 615 MB → 144 / 361 / 613 MB.
- **Query plans:** over the 38 distinct statements of a full flow, all are index SEARCHes except the two newest-first list walks under LIMIT.

### Commands and results (final wave)

| Command | Result |
|---|---|
| `INTAKE_PYTHON=python3 npm --prefix back-end test` | unit 79/79; integration 29/29, then budget 4/4 |
| `env -u INTAKE_PYTHON npm test` in a scratch clone without `.venv` | unit 79/79; integration 29/29, then budget 4/4 |
| `CHROME_BIN=<scratch>/chrome-nosandbox INTAKE_PYTHON=python3 make intake-test PYTHON=.venv/bin/python` | Gold 61 passed; Angular 17 SUCCESS; UI build; Worker 79 + 29 + 4 |
| `.venv/bin/python -m pytest evals/intake -q` | 88 passed, 5 skipped (withheld frozen artifacts), 162 subtests |
| `make test` | 202 passed, 31 subtests |
| `node --check` on the changed JavaScript files; `git diff --check` | clean |
