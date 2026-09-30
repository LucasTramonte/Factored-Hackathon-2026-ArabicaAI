# Task 5 completion: idle closure, export and cost evidence (2026-09-30)

This finishes Task 5 of the [backend completion plan](../superpowers/plans/2026-09-29-intake-backend-completion.md) on top of the checkpoint in [the handoff](2026-09-30-intake-backend-handoff.md) and [its report](2026-09-30-task-5-checkpoint-report.md). The work is on branch `claude/gifted-einstein-mi8vh3`, starting from `052ba28`. It was verified locally only. **Independent Task 5 review is still pending.** Task 6 remains gated and the frontend deferred. There was no remote D1, deploy, model call, frozen or withheld case access, or credential file read.

## Commits

| Commit | Scope |
|---|---|
| `3841b8c` | `test: qualify guided D1 budgets and storage; add FK-ordered demo reset` |
| `2a4684f` | `feat: page intake exports and idle sweeps with bounded, quiet operator CLIs` |
| `f695b15` | `ci: run the Worker suite with a stdlib Python scorer` |
| (this commit) | ADR-004, back-end README, event contract, recent-transactions proposal, spec status, plan boxes, this note |

## What changed and why

- **Budget checks** (`back-end/test/integration/budget.test.js`, `back-end/test/run-local.mjs`). The fixes follow the checkpoint findings: the detail path is `/agent/intake-detail?protocol=`, the queue contract is `agentIntakeList` with `items`, and the fixture uses the production evidence shape `{transaction: null, tool_status: 'ok'}`. The tests now measure every guided endpoint, including incomplete replay, both customer episodes, one idle page, a no-op sweep, one export page, and the 50 + 50 tied queue. The budget file runs last, in its own `node --test` call; the runner orders files itself, so sorting the list was not enough. That way its 200 fixture rows can't change earlier suites.
- **Replay 42 > 40.** No scan is involved. Every replay statement plans as an index `SEARCH`. Seven lookups (reservation lookup ×2, receipt read-back, four event `INSERT … SELECT`s) each read one more row once a following index entry exists: 35 on an empty store, 42 at every larger size measured, up to 25,006 episodes. The ceiling is now 45, with the per-statement breakdown in ADR-004. A `UNIQUE` owner index was tried on a scratch copy and did not help, so there is no schema change.
- **Export** (`back-end/scripts/export-intake-events.mjs`, `back-end/src/store/d1.js`). The checkpoint exporter published only the first page: its limit-2 run exported 2 of 5 episodes. It now walks every keyset page (at most 100 pages of 100 episodes) into one file, scores it, and publishes it atomically, or fails and keeps the previous artifact. The cursor must be a lowercase RFC 4122 UUID; the old pattern accepted 36 hyphens. The destination must resolve inside `data/intake-events` inside `data/`. A scratch copy of the checkpoint code did publish through a base symlink to an outside directory; that path is now rejected with regressions.
- **Idle closure** (`back-end/scripts/close-idle-intakes.mjs`, `back-end/src/store/d1.js`). The end event records the deadline, min(activity + 10 min, session expiry), so sweep cadence no longer changes latency. The script sweeps up to 100 atomic pages at one cutoff and reports `complete`. A new regression drives a real committed reservation through sweeps: it stays `handoff_pending`, and only the live same-owner session finishes it.
- **Generic CLI output** (`back-end/scripts/intake-store.mjs`). In this container, Wrangler's proxy notice and Node's `punycode` warning reached stderr. The CLIs now import Wrangler lazily after setting `WRANGLER_LOG=none`, `WRANGLER_WRITE_LOGS=false`, `WRANGLER_SEND_METRICS=false` and `process.noDeprecation`. Tests assert exact stderr for argument errors, a real D1 failure (`no such table`) and a scorer that echoes content. Miniflare had also written `.wrangler/cache/cf.json` into the working directory. Its cache now sits beside the ignored D1 state, and `.wrangler/` is ignored everywhere.
- **Storage and reset** (`back-end/test/unit/intake-storage.test.js`, `back-end/scripts/reset-demo-activity.sql`). Storage per episode is measured with `dbstat` and bounded in CI. The old `DELETE FROM cases; DELETE FROM sessions;` now fails on `intake_handoffs.complete_case_id`. The new script deletes in foreign-key order. It was checked against the migrations in a unit test and against a local Miniflare D1, where activity went to 0 with 2 customers and 3 transactions kept.
- **CI** (`.github/workflows/quality.yml`). The web job now sets up Python 3.10 with the pinned `setup-python` action and runs the Worker tests with `INTAKE_PYTHON: python`. `evals/intake/episodes.py` is stdlib-only and parses with the 3.10 grammar.
- **Documentation.** The documentation commit covers:
  - `Docs/ADRs/ADR-004-intake-capacity-and-cost.md`: dated notes and the measured guided section.
  - `back-end/README.md`: routes, operator scripts, reset and limits.
  - `Docs/intake/intake-events.md`: the producer, timing, ledger, idle rule, export cutoff and allowlist, and retention.
  - `Docs/Plans/recent-transactions-resolution-decision.md`: an unaccepted proposal without an ADR number.
  - The spec status line and the plan boxes.

## Measured (local D1; details in ADR-004)

Figures are queries / rows read / rows written / round trips. Where two read values appear, the first is an empty store and the second is with neighbouring rows present.

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
| idle page of 100 / no-op sweep | 2 / 800 / 400 / 1 and 2 / 5 / 0 / 1 | 2 / 880 / 400 / 1 and 2 / 10 / 0 / 1 |
| export page of 100 | 1 / 409–473 / 0 / 1 | 1 / 700 / 0 / 1 |

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
  - `DATA_QUALITY.md` DF-002 calls the random-draw cause "confirmed in Bronze". The proposal treats that as an inference; the finding text was not edited.
- **Environment:** Miniflare still fetches `cf.json` from Cloudflare when a local binding starts. It is cached under ignored directories.
