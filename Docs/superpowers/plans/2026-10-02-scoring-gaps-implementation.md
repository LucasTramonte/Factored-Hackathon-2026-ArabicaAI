# Scoring gaps: frozen comparison, normal resolution path, live metrics: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every agent works in **ponytail ultra** (AGENTS.md, "Agent orchestration"), runs on Opus 5.5 (`model: "opus"`), reads `AGENTS.md` and the code it touches in full, and asks the orchestrator instead of guessing.

**Goal:** close the three gaps the scoring guide still sees as empty: (A) a frozen, pre-registered AI-vs-rules comparison, (B) a normal resolution path with a measurable numerator, (C) published live metrics with denominators by language.

**Architecture:** no new runtime and no new service. (A) uses the existing harness (`evals/intake/run.py`, `prereg.py`, `make_clean_checkout.py`) and changes one request parameter in `intake_agent/extractor/workers_ai.py`, made by a blind builder. (B) adds one D1 table, one endpoint and one scorer. (C) runs the existing export and writes the numbers down.

**Tech stack:** Python 3 stdlib (evals), Cloudflare Worker + D1 (JavaScript, `node --test`), Angular (client acknowledgement), Workers AI `@cf/openai/gpt-oss-20b`.

**Sources:** problem statement pp. 3, 5–6 (normal resolution path; safe automated resolution over all in-scope cases; cost per success "not defined" at zero); ADR-002 (handoff ≠ resolution); ADR-004 (cost per attempt, D1 ceilings); ADR-005 (frozen protocol); ADR-006 decision 5 and amendments 1, 2 and 5 (latency trigger fired; lower `reasoning`; report 60 and 52); `Docs/Plans/recent-transactions-resolution-decision.md` (draft for B); `Docs/intake/intake-events.md` (C).

---

## Facts this plan rests on (verified 2026-10-02 against the code)

- **No `extractor-v1` tag exists** (`git tag -l` → `v0.1.0`). v1 was never pre-registered, so the lower-reasoning build is the first registered version and keeps the name `extractor-v1`, as the frozen README and runner commands already say. The default-reasoning build stays in `DEV_LOG.md` as a pre-registration iteration.
- **The runner already scores both references.** `evaluate()` scores `handoff` and `checklist` on every case next to any `--system` (`evals/intake/run.py:73-79`). One frozen run gives the checklist, the always-handoff reference and the extractor. Output: `summary` (rows with `baseline`, `repetition`, `language`, `correct`, `correct_rate_ci95` (Wilson), `unsafe`, `latency_p95_interval_ms`, …), `cases` (every execution, `repetition` `None` for the references, 1–3 for the system) and `majority` (one row per case for the system).
- **The withheld frozen files are on Lucas's machine only.** Publishing them is his step.
- **Model quota:** the free Workers AI allocation served fewer than ~280 calls per UTC day. The dev latency re-check needs ~180 calls (160 model-calling executions decide, per DEV_LOG attempt 2), and the frozen run ~180. On Free they run on two UTC days, each right after 00:00 UTC (19:00 Bogotá): Oct 3 and Oct 4. Submissions close Oct 5. DEV_LOG iteration 2 shows a "Reasoning: low" prompt line cut p50 but not the service tail, so `low` may not pass and a second attempt would push the frozen run to deadline day. **Workers Paid ($5/month) removes the gate and allows both runs on Oct 3. The team decides that before Oct 3 00:00 UTC.**
- **The live flow calls no model.** Exported `duration_ms` is the episode span including customer think time (`intake-events.md`, "Usage"). Cost per attempted case is already in ADR-004 ($0 on Free; $5 ÷ episodes a month on Paid).
- **Sessions carry no language.** `requireSession` returns `findSession`'s `{customer_id, expires_at}` (`back-end/src/auth/session.js:30-40`). A view is bound to its customer; its random `view_ref` is the capability, so no session ref is stored.
- **The client loads `/transactions` on every sign-in and resume** (`customer.page.ts` `resume()`), so a live page load is not a customer request for charges.
- **#72, #73 and #74 are merged** (`0906b09`); English is in the scorer. All branches start from `main`. Remote migration 0014 must be applied before 0015.
- D1 binding `DB`, database `arabica-intake-demo` (`back-end/wrangler.jsonc`). Remote reads and writes are human steps.

## Branches (cascade, one PR each)

| Part | Branch | Base | Label | Reviewer |
|---|---|---|---|---|
| A | `eval/extractor-v1` | `main` | `evaluation` | Manoella (behaviour change), Roberto (non-behavioural) |
| C | `eval/live-metrics` | `main` | `evaluation` | Lucas |
| B | `feat/charges-resolution` | `main` | `enhancement` | Lucas |

Every PR: `--assignee @me`, and it ends with **"Human steps before merge"**. Agents never tag, merge, deploy or run `--remote`.

## File map

| File | Part | Responsibility |
|---|---|---|
| `evals/intake/preregistration/extractor-v1-builder-instructions.md` | A | append the latency revision, verbatim |
| `intake_agent/extractor/workers_ai.py`, `test_workers_ai.py`, `DEV_LOG.md`, `evals/intake/preregistration/extractor-v1.md` | A | builder only |
| `evals/intake/frozen_report.py`, `test_frozen_report.py` | A | re-summarise one run on the 52 unexposed cases with `run._summary`; McNemar |
| `Docs/deliverables/EVALUATION.md`, `SYSTEM_DESIGN.md`, `Docs/ADRs/ADR-006-…md` | A, B, C | results, as measured |
| `Docs/ADRs/ADR-009-recent-charges-resolution.md`, `Docs/ADRs/README.md` | B | the draft promoted to an ADR (Proposed) |
| `back-end/migrations/0015_charge_views.sql` | B | one table |
| `back-end/src/store/d1.js`, `back-end/scripts/reset-demo-activity.sql` | B | two statements; the reset clears the new table |
| `back-end/src/modules/customer/routes.js`, `back-end/src/router.js` | B | record a view; `POST /transactions/displayed` |
| `front-end/contracts/`, the customer page and its spec | B | contract; send `lang`; acknowledge after render |
| `back-end/test/unit/…`, `back-end/test/integration/charges-resolution.test.js`, `budget.test.js` | B | statements, adversarial matrix, D1 ceilings |
| `Docs/ADRs/ADR-004-intake-capacity-and-cost.md` | B | dated note justifying the budget change |
| `evals/inquiry/__init__.py`, `score.py`, `test_score.py` | B | the inquiry scorer |

---

## Part A: the frozen AI-vs-rules comparison

### Task A.1: the builder's revision (orchestrator)

**Files:** Modify `evals/intake/preregistration/extractor-v1-builder-instructions.md` (append only).

- [ ] **Step 1:** Append verbatim. Like the rest of the file, its writer is exposed, so it carries only the interface, the process and development-split facts, and reviewers can check that.

```markdown
---

## Revision 2026-10-02: latency (ADR-006 amendments 1 and 2)

On development the latency trigger fired: over the 160 model-calling executions, the p95 interval's upper bound was 4,432 ms (> 3,000 ms); quality was 180/180, 0 unsafe. Keep the model, the prompt and the parsing. Change only the documented reasoning level of `@cf/openai/gpt-oss-20b`:

1. Read Cloudflare's current model page and API schema for the reasoning parameter. Record the URL, the date, the exact request field and its documented default in `DEV_LOG.md`. Don't guess; if the REST API doesn't accept it, stop and report.
2. Send the lowest documented level (`low`) explicitly, with a unit test in `test_workers_ai.py` asserting the request body carries it. Keep `MAX_TOKENS`, temperature, the timeout and the retry.
3. Right after a 00:00 UTC reset, in one go, run amendment 1's protocol on development only:
   `python -m evals.intake.run --split development --repetitions 10 --system extractor-v1=intake_agent.extractor.workers_ai:extract --output data_foundation/runs/latency-v1-low/results.json`
   Decide latency on the 160 model-calling executions (as attempt 2 did); report the runner's pooled 180 as supplemental.
4. Report against every ADR-006 trigger: ≥16/18 correct, 0 unsafe, ≥95% schema-valid, p95 interval upper bound ≤3,000 ms, ≤10% instability. If a trigger fails, stop and report; don't change the prompt or try another level without the orchestrator.
5. If all pass, copy `TEMPLATE.md` to `extractor-v1.md` and fill in every field (add `reasoning=low` to the parameters). This replaces step 2 of "Pre-register" above: don't run `prereg fill` and don't tag. `fill` records the commit it runs on, so it runs in the team's branch.
```

- [ ] **Step 2:** commit `docs(eval): builder revision for the latency trigger` on `eval/extractor-v1`; push.

### Task A.2: blind build in a history-free snapshot

- [ ] **Step 1 (orchestrator):** `python -m evals.intake.preregistration.make_clean_checkout --dest <scratchpad>/clean-v1 --ref eval/extractor-v1`. Expected: withheld paths reported absent, one reachable commit.
- [ ] **Step 2:** dispatch one fresh Opus agent whose working directory is the snapshot and whose prompt is the full text of `extractor-v1-builder-instructions.md` and nothing else. Credentials come from the human's environment (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`), never pasted into a prompt.
- [ ] **Step 3 (builder, before the reset):** code, unit test, `python -m pytest intake_agent evals/intake -q` green.
- [ ] **Step 4 (builder, 00:00 UTC Oct 3):** the dev run; DEV_LOG entry with every trigger; if all pass, `extractor-v1.md` filled from `TEMPLATE.md`. Commit in the snapshot.
- [ ] **Step 5 (orchestrator):** `git -C <snapshot> diff --name-only $(git -C <snapshot> rev-list --max-parents=0 HEAD) HEAD` must list only `intake_agent/extractor/workers_ai.py`, `test_workers_ai.py`, `DEV_LOG.md` and `evals/intake/preregistration/extractor-v1.md`.
  1. Copy `workers_ai.py`, `test_workers_ai.py` and `DEV_LOG.md` in; `python -m pytest intake_agent evals/intake -q` green; commit `feat(extractor): low reasoning level after the latency trigger (ADR-006 am. 2)`. This is the commit that will be tagged.
  2. Copy `extractor-v1.md` in and, on that commit, run the builder's command from the instructions' "Pre-register" section plus `--param reasoning=low` (`python -m evals.intake.preregistration.prereg fill --file … --param temperature=0 --param reasoning=low …`). It records HEAD.
  3. Commit `eval: pre-register extractor-v1` (it only adds a file, which the check allows). Push; open the PR.
- [ ] **Gate:** if a trigger fails, Part A stops and the next rung is the team's decision (ADR-006 decision 3). The attempt is reported in DEV_LOG either way.

QA: spec QA checks only the reasoning field changed and every trigger is reported; quality QA covers Roberto's non-behavioural scope (secrets, error paths, tests).

**Human steps before merge (A, first PR):** Manoella approves the behaviour change in the PR (ADR-006 decision 5); Roberto reviews non-behavioural aspects; a person tags the commit recorded in the registration block and pushes it: `git tag extractor-v1 <commit from the block> && git push origin extractor-v1`; then `python -m evals.intake.preregistration.prereg check --file evals/intake/preregistration/extractor-v1.md` → "Registration OK".

### Task A.3: publish the frozen set (Lucas)

- [ ] **Human steps (Lucas, on the machine holding the files):** `python evals/intake/frozen_es_pt_v1/rehearse_publication.py` (hashes must match `COMMITMENT.json`); commit the withheld files, `evals/intake/frozen_es_pt_v1.json` and `evals/intake/frozen_es_pt_v1/exposed_cases.json` (the 8 case IDs of amendment 5, a JSON list); tag `eval-es-pt-v1`. Then `python -m pytest evals/intake -q` runs the artifact tests instead of skipping them.

### Task A.4: the unexposed re-summary helper

**Files:** Create `evals/intake/frozen_report.py`, `evals/intake/test_frozen_report.py`.

- [ ] **Step 1: failing test**

```python
from evals.intake.frozen_report import unexposed, paired


def row(case_id, baseline, correct, rep=None, language='es'):
    return dict(case_id=case_id, baseline=baseline, repetition=rep, correct=correct, safe=True, safe_complete=False,
                missed_handoff=False, unnecessary_handoff=False, latency_ms=1.0, split='frozen', language=language,
                session_language=language, gold={'completion_ready': False, 'action': 'clarify'})


def test_unexposed_drops_exposed_cases_and_reuses_run_summary():
    result = {'cases': [row('a', 'checklist', True), row('b', 'checklist', False)],
              'majority': [row('a', 'x', False, 'majority'), row('b', 'x', True, 'majority')]}
    out = unexposed(result, exposed={'a'})
    checklist = next(s for s in out if s['baseline'] == 'checklist' and s['language'] == 'all')
    assert (checklist['cases'], checklist['correct']) == (1, 0)


def test_paired_counts_discordant_cases():
    result = {'cases': [row('a', 'checklist', True), row('b', 'checklist', False)],
              'majority': [row('a', 'x', False, 'majority'), row('b', 'x', True, 'majority')]}
    assert paired(result, 'x', exposed=set()) == (1, 1)
```

- [ ] **Step 2:** `python -m pytest evals/intake/test_frozen_report.py -q` → FAIL (module missing).
- [ ] **Step 3: implementation** (the split key comes from the frozen corpus; match whatever `SPLITS` value its cases carry)

```python
"""Frozen-set results without the exposed cases (ADR-006 amendment 5), reusing the runner's own summary."""
import argparse, json
from evals.intake.run import _summary
from evals.intake.stats import mcnemar_exact


def _rows(result):
    """References come from ``cases`` (one execution each); a registered system from ``majority`` (one row per case)."""
    return [r for r in result['cases'] if r['repetition'] is None] + result['majority']


def unexposed(result, exposed):
    """``run._summary`` rows (Wilson interval included) per baseline and language over the cases not in ``exposed``."""
    rows = [r for r in _rows(result) if r['case_id'] not in exposed]
    return [_summary(r0['split'], name, language, r0['repetition'], group)
            for name in sorted({r['baseline'] for r in rows})
            for language in ('all', 'es', 'pt')
            for group in [[r for r in rows if r['baseline'] == name and language in ('all', r['session_language'])]]
            if group for r0 in [group[0]]]


def paired(result, system, exposed):
    """Discordant pairs (checklist right and system wrong, system right and checklist wrong) for McNemar."""
    by = {(r['case_id'], r['baseline']): r['correct'] for r in _rows(result) if r['case_id'] not in exposed}
    ids = {c for c, b in by if b == system}
    return (sum(by[c, 'checklist'] and not by[c, system] for c in ids),
            sum(by[c, system] and not by[c, 'checklist'] for c in ids))


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('result'); p.add_argument('--system', required=True)
    p.add_argument('--exposed', required=True)
    a = p.parse_args()
    result, exposed = json.load(open(a.result)), set(json.load(open(a.exposed)))
    b, c = paired(result, a.system, exposed)
    print(json.dumps({'unexposed': unexposed(result, exposed), 'mcnemar': {'b': b, 'c': c, 'p': mcnemar_exact(b, c)},
                      'mcnemar_all': dict(zip('bc', paired(result, a.system, set())))}, indent=2))
```

- [ ] **Step 4:** both tests pass; `python -m pytest evals/intake -q` green.
- [ ] **Step 5:** commit `feat(eval): frozen results without the exposed cases`.

### Task A.5: the single frozen run (after the next reset following the tag; Oct 4 00:00 UTC on Free)

- [ ] **Step 0:** `git fetch origin tag extractor-v1` (the runner's check resolves the tag locally).
- [ ] **Step 1:** one command; it scores the checklist, the always-handoff reference and the extractor (3 repetitions, nothing changed between them), and refuses unless the registration check passes:
  `python -m evals.intake.run --cases evals/intake/frozen_es_pt_v1.json --repetitions 3 --system extractor-v1=intake_agent.extractor.workers_ai:extract --preregistration extractor-v1=evals/intake/preregistration/extractor-v1.md --output data_foundation/runs/frozen-v1/extractor-v1.json`
  A run cut by a 429 is invalid: record it and repeat at the next reset; never merge partial runs.
- [ ] **Step 2:** `python -m evals.intake.frozen_report data_foundation/runs/frozen-v1/extractor-v1.json --system extractor-v1 --exposed evals/intake/frozen_es_pt_v1/exposed_cases.json > data_foundation/runs/frozen-v1/unexposed.json`

### Task A.6: write it down, whatever it says

- [ ] `EVALUATION.md`, new section "Frozen result": for checklist, always-handoff and extractor-v1 (majority) on all 60 and on the 52 unexposed, and each repetition on all 60 (from the run's `summary`), by `es`/`pt`/all: correct k/n with `correct_rate_ci95`, unsafe count, missed and unnecessary handoffs, errors and unavailable usage, latency p50/p95 with `latency_p95_interval_ms` (pooled `all` row), tokens and $ per call at DEV_LOG's rates, instability across repetitions, McNemar b, c, p. Name the relative-date gap. Claims stay inside section 7.
- [ ] ADR-006: a "Result" note (date, commit, tag). `SYSTEM_DESIGN.md` results line links it. `REVIEW_STATUS.md` rows → Done.
- [ ] Commit `docs(eval): frozen comparison results`; second PR on `eval/extractor-v1` (or the same PR if still open), body states the command, date and that nothing changed between repetitions.

---

## Part C: live metrics by language

### Task C.1: export (human), save the summary (agent)

- [ ] **Human step (remote; the close step writes):**
  ```sh
  cd back-end
  node scripts/close-idle-intakes.mjs --remote --max-pages 100
  node scripts/export-intake-events.mjs --remote --max-pages 100 --output ../data/intake-events/live-2026-10-03.jsonl > ../data/intake-events/live-2026-10-03.out.json
  ```
  The export validates the file with the scorer and prints `{episodes, pages, complete, started_at, summary, metrics}`; nothing to re-run. Files stay in ignored `data/`.
- [ ] **Optional human step (service latency):** in the Cloudflare dashboard, Workers → the Worker → Observability, read the request wall-time percentiles for the same window and paste the figures (no screenshot of customer data) into the PR. Without it, the section says plainly that per-request service latency is not reported.

### Task C.2: publish (agent)

- [ ] `EVALUATION.md`, new section "Live service, as measured": one row per `all`, `es`, `pt`, `en`: eligible started (denominator), safe accepted k/n with Wilson (`evals/intake/stats.py:wilson`), unsafe (gate), not assessed, outcomes, clarifications per episode, **episode span** p50/p95 named as such with the think-time caveat, model calls (0). A language with no traffic shows `0 started`, never omitted. Cost per attempted case: cite ADR-004 ($0 on Free; $5 ÷ the month's episodes on Paid), no new arithmetic. State the window (first and last `ts`) and that the population is team and judge traffic, not a customer sample.
- [ ] The two commands as a reproducible block; link from `SYSTEM_DESIGN.md` results.
- [ ] Commit `docs(eval): live metrics by language from the remote export`; open the PR.

---

## Part B: the normal resolution path (recent charges)

### Task B.1: ADR-009 (orchestrator)

- [ ] Promote the draft to `Docs/ADRs/ADR-009-recent-charges-resolution.md` (Proposed; deciders Lucas, Roberto, Manoella), add it to `Docs/ADRs/README.md`, delete the draft (git keeps it). Its five decisions:
  1. Scope as drafted, languages `es`, `pt`, `en`.
  2. Every `GET /transactions?lang=` records a view and returns its `view_ref`; the client acknowledges it after rendering with `POST /transactions/displayed {view_ref}`; agents build both sides.
  3. One table `charge_views` is the stream; a separate scorer `evals/inquiry/score.py`; never mixed with intake.
  4. A first page with `has_more = true` counts when its coverage is declared.
  5. **Population.** The client loads charges on every sign-in, so a live view is a page load, not a request. **In-scope cases are the authored inquiry cases** (each an explicit request, run against local D1 in B.4), and they alone feed safe automated resolution. Live views are reported as descriptive page-load counts and display rates. All inquiry figures are provisional while the ADR is Proposed.
  6. **Unsafe** for an inquiry case: any row of another customer served or acknowledged, or a view recorded or acknowledged without a live customer session.
- [ ] Commit `docs(adr): ADR-009 recent charges as the normal resolution path`.

### Task B.2: migration and statements

**Files:** Create `back-end/migrations/0015_charge_views.sql`; modify `back-end/src/store/d1.js`, `back-end/scripts/reset-demo-activity.sql` (add `DELETE FROM charge_views;`, and `charge_views` to the reset test's table list in `intake-storage.test.js`); unit test next to `back-end/test/unit/intake-storage.test.js` (it applies migrations with `node:sqlite`).

```sql
-- One row per GET /transactions (ADR-009): what was served, and whether the client showed it. Additive.
CREATE TABLE charge_views (
  view_ref TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  language TEXT NOT NULL CHECK (language IN ('es', 'pt', 'en')),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  has_more INTEGER NOT NULL CHECK (has_more IN (0, 1)),
  coverage TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  displayed_at TEXT
);
```

- `d1.js`, next to `listTransactions`: `insertChargeView(row)` and `acknowledgeChargeView(viewRef, customerId, now)` = `UPDATE charge_views SET displayed_at=COALESCE(displayed_at, ?) WHERE view_ref=? AND customer_id=? RETURNING displayed_at` (a replay returns the first time; another customer matches nothing).
- [ ] Steps: failing unit test for both statements (insert, ack, replay keeps the first time, wrong customer returns nothing) → implement → pass → commit `feat(d1): charge_views for the recent-charges path`.

### Task B.3: the endpoints

**Files:** `back-end/src/modules/customer/routes.js`, `back-end/src/router.js`.

- [ ] `listTransactions`: an optional `?lang=`. Missing → no view, `view_ref: null`, so the 38 existing callers and tests stay unchanged; present but not `es|pt|en` → 422. With a valid `lang`, after the read, insert one view (`view_ref = crypto.randomUUID()`) and return `view_ref` in the body. If the insert fails, still return the rows with `view_ref: null` (an unrecorded view is a missing numerator, not an outage).
- [ ] `acknowledgeDisplay`: `requireSession(…, 'customer')` → 401; body exactly `{view_ref: <uuid>}` → else 422; no row returned → 404; else 200 `{view_ref, displayed_at}`.
- [ ] Router: `'/transactions/displayed': { POST: acknowledgeDisplay }`, role `customer`.
- [ ] Commit `feat(api): record charge views and their display acknowledgement`.

### Task B.4: adversarial tests, authored cases, budget

**Files:** Create `back-end/test/integration/charges-resolution.test.js`; modify `budget.test.js`, `front-end/contracts/`, `Docs/ADRs/ADR-004-intake-capacity-and-cost.md`.

- [ ] The matrix (AGENTS.md list): wrong methods (405); no session, agent session and expired session (401); bad `lang` (422), missing `lang` (200, `view_ref: null`, no row); a second customer acknowledging the first's `view_ref` (404, row unchanged); forged, malformed refs and extra fields (422); 20 concurrent acknowledgements of one ref (all 200, one `displayed_at`); both responses validated against `front-end/contracts/`.
- [ ] **The authored inquiry cases are tests in the same file**, one per `es`/`pt`/`en` × normal, empty list, `has_more`, plus expired session, cross-customer acknowledgement and tool failure (store throws). Only when `INQUIRY_OUT` is set (never in CI), each writes its observed outcome (`in_scope`, `attempted`, `displayed`, `coverage`, `unsafe`) as one JSONL line to that path under ignored `data/charge-views/`, the scorer's input.
- [ ] `budget.test.js`: new measured ceilings for `list` (now one write) and `displayed`; the intake `EPISODE_CEILING`s include `list`, so update them. ADR-004: dated note with the new per-request and per-episode figures and the resulting daily capacity, as AGENTS.md requires for any budget increase.
- [ ] `npm test` in `back-end` green; commit `test(api): adversarial matrix and authored cases for charge views`.

### Task B.5: the client

- [ ] Send `lang` (the interface language) on `GET /transactions`. After the rows render, POST `/transactions/displayed` once with the `view_ref`; ignore failures. One Angular spec: renders → posts once; `view_ref: null` → no post.
- [ ] `npm test` in `front-end` green; commit `feat(client): acknowledge displayed charges`.

### Task B.6: scorer and numbers

**Files:** `evals/inquiry/__init__.py`, `evals/inquiry/score.py`, `evals/inquiry/test_score.py`.

- [ ] Test first with three synthetic rows. `score.py` (stdlib) prints per language and `all`: in-scope n; attempted k/n; **safe automated resolution** = displayed, coverage declared and not unsafe, k/n with `evals.intake.stats.wilson`; unsafe count (gate); cost per success = ADR-004 cost × attempts ÷ successes, or `"not defined"` at 0.
- [ ] Live descriptive counts come from one human query (no export script):
  `cd back-end && npx wrangler d1 execute arabica-intake-demo --remote --json --command "SELECT language, row_count, has_more, coverage, retrieved_at, displayed_at FROM charge_views"`.
- [ ] New EVALUATION.md section "Normal resolution path (provisional, ADR-009 Proposed)": authored-case results, then live page loads and display rate by language, kept apart. `SYSTEM_DESIGN.md` results line. Commit `feat(eval): inquiry scorer and recent-charges results`.

**Human steps before merge (B):** the three deciders agree to ADR-009 in the PR; with 0014 already applied remote: `cd back-end && npx wrangler d1 time-travel info arabica-intake-demo` (bookmark), then `npx wrangler d1 migrations apply arabica-intake-demo --remote`, stated in the PR body; after the deploy, the live query above.

---

## Order and calendar

| When (UTC) | What | Who |
|---|---|---|
| Oct 2 | A.1, A.2 steps 1–3, A.4; B.1–B.3 (B and C both branch from `main`) | agents; team decides Free vs Workers Paid |
| Oct 3 00:00 | A.2 step 4 (dev run; on Paid, A.5 follows the same day once tagged) | builder agent |
| Oct 3 | A.2 step 5 PR; tag; A.3 publish; C.1–C.2; B.4–B.6 | agents; Manoella, Lucas, a person for the tag and `--remote` |
| Oct 4 00:00 | A.5 frozen run (on Free) | agent, credentials in the human's environment |
| Oct 4 | A.6 write-up; merges | agents write; people review and merge |

Skipped on purpose: a latency probe for the live Worker (the dashboard covers it if wanted), an export script for charge views (one query is enough at demo volume), and any UI for metrics (EVALUATION.md tables are the deliverable).
