# Proactive alert on a high charge: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every agent works in **ponytail ultra** (AGENTS.md, "Agent orchestration"), runs on Opus 5.5 (`model: "opus"`), reads `AGENTS.md` and the code it touches in full, and asks the orchestrator instead of guessing. One coder per task, strictly sequential; two QA agents per task (spec, then code quality), at most three rounds each.

**Goal:** André (Factored) asked for "the proactive thing": the feeling that the bank reached out first. The team made it a must-have: a proactive email or an on-site prompt, segmented to the most urgent cases. This plan builds the smallest version that gives that feeling. When a customer signs in and one of their listed charges meets the stated urgency amount policy, the home shows one dismissible, accessible banner: "Vimos un cargo alto de 3.890,00 BRL en Eletronicos Demo. ¿Lo reconoces?" It has two answers, **Sí, es mío** and **No lo reconozco → reportar**. The second opens the guided chat on that charge. The agent queue marks reports that came from the banner, and three counts measure it: offered, answered and converted.

**Architecture:** no new runtime, service, cron or model (ADR-002, ADR-003). It uses one additive migration (0022), one extra statement batch in `GET /transactions?lang=` (the read that already serves the 21 rows the urgency rule uses), one new customer route under the existing `/transactions/` prefix, one column carried to the agent queue, and one Angular banner. Nothing refunds, blocks or decides. The banner only asks, and a "report" answer starts the normal guided intake, which still needs the customer's explicit confirmation.

**What this answers (André, Factored Slack, 2026-10-01):**
- He would panic at a $5,000 charge.
- He wouldn't trust an agent that says "Done", and would ask for a representative after "20+ questions".
- He gets "a receipt and that's it", then has to chase the bank.
- He wants "proactive reach from the bank to make me feel comfortable".

How the plan maps to that:

| His point | What already exists on `main` | What this plan adds |
|---|---|---|
| The bank reaches out first; the customer doesn't search | Nothing before a report | The alert on sign-in for that charge (Tasks 1, 3); optional email (Task 5) |
| High-stakes charges first ($5,000) | The urgency lane: high reports head the agent queue, and the receipt shows the call-your-bank line (`intake/routes.js:114-158`, `d1.js:442-452`) | The same fixed-amount tier chooses who gets the alert (Decision 1) |
| A person's tone, never "Done" | The receipt says a person will review it, and nothing claims a resolution (ADR-002; `templates.js` "Una persona lo revisará") | The alert's copy says the bank noticed and that a person reviews any report. It never says resolved, blocked or refunded. The queue tells the agent the bank started the contact (Task 2) |
| One or two taps, no questionnaire | Reason chips, one statement, one confirmation (ADR-010) | From the alert, the charge is preselected and the statement prefilled. The customer taps "No lo reconozco", picks a reason, sends, and ticks "confirm" (Task 3) |
| Proactive progress, not chasing | Status emails at `received`, `in_review` and `closed` (#63, #64; `notify/templates.js`); "Email me an update" and status chips in "Tus reportes" (`customer.page.html:171-191`) | The alert opens that chain for urgent charges, so the bank speaks first and keeps speaking. The plan adds no new progress channel. |

**Deadline:** the team targets **2026-10-04 12:00 Bogotá** (17:00 UTC); submissions close 2026-10-05. Tasks 1–4 are the MVP. Task 5 (email) runs only if the team decides yes (Decision 2).

---

## Decisions the team must make (before Task 1)

1. **Which charges trigger the banner.** **Recommended: the fixed-amount tier only** (`urgency.json: fixed`). The full stated policy (fixed **or** above the customer's own p95) would fire for almost every cohort customer. With 21 same-currency purchases, the p95 rule (`urgency.js:11-13`, nearest rank over the 20 others) always marks the customer's **top two** charges as high. With 6–20 peers it marks at least the top one. That is "your biggest purchase", not "the most urgent cases". `card_lost_or_stolen` (`urgency.json: high_reasons`) is something the customer says while reporting, so nothing can trigger on it before a report. The fixed tier is a subset of the stated policy, so nothing new is invented.
   - Consequence: the 5 fictitious identities with a BRL ≥ 2,500 charge get the banner (`demo-ana`, `demo-carla`, `demo-diego`, `demo-elena`, `demo-marco`), and `demo-bruno` (BRL 32.00 only) is the negative control (`back-end/seeds/fictitious.json`). Cohort customers rarely see it, because purchases stop at about USD 509 (DF-024), which is honest.
   - Choosing the full policy instead is a one-line swap in Task 1 (`urgencyOf` over the 21 rows instead of the fixed filter).
2. **Email as well, or the banner only.** **Recommended: banner only for noon. Task 5 is the optional "we noticed" email.** Why:
   - Nothing in the demo can trigger an email *before* sign-in. Charges are a static reviewed seed (no charge feed), and the Worker has no cron (`wrangler.jsonc` has no `triggers`). So the email would go out at sign-in, while the customer is already looking at the banner.
   - `email_outbox.template` has a CHECK for four templates (`migrations/0009_notifications.sql`), and SQLite can't widen a CHECK additively, so the email needs its own table.
   - Only SES-verified recipients receive mail (sandbox, `Docs/Plans/auth-runbook.md:76,157`).
   - In its favour: the email is the strongest "someone reached out" signal for a judge with a verified inbox, and it adds no quota risk. It is sent at most once per charge, and only from a sign-in, which Cognito caps at 50 a day per account (ADR-004 dated note, line 334). That is well inside the SES sandbox send quota.

Not a decision, recorded for the team: **Manoella's dashboard defines no further segment computable from D1.**
- The merged report (PR #94, `Docs/deliverables/PRODUCT_REPORT.md` §4, `data_foundation/queries/product/PR-08_segment_complaints.sql`) cuts by `customers.segment`. It finds that no segment is handled differently ("Premium complaints stay unresolved and breach SLAs as often as anyone's"), and D1 has no segment column (`Docs/Plans/insights-report.md` §2; `migrations/0001`, `0006`).
- Her unmerged notebooks (`origin/feat/manoella-customer-analysis`, `customer_analysis_notebooks/2_high_value_core_validation.ipynb`) define a "validated high-value core" (11.6%, 2 of 3 of RFM / KMeans / CLV). It is built from Bronze, uses a fitted clustering, is not quality-gated and is not restricted to the ADR-005 design window.
- Bringing it online would need a reviewed Gold column and a seed change. It is skipped here and listed under "Skipped".

---

## Facts this plan rests on (verified 2026-10-03 against `main` at `5e1dd55`)

- **The urgency rule is pure and reusable.** `urgencyOf(chosen, others, config)` (`back-end/src/modules/intake/urgency.js:8-14`) returns high when `amount >= config.fixed[currency]` (line 10), or when at least 5 same-currency peers exist and the amount is above their nearest-rank p95 (lines 11-13). Policy: `back-end/src/config/urgency.json` (`fixed` BRL 2500, MXN 10000, COP 2000000, ARS 500000, USD 500; `high_reasons: ["card_lost_or_stolen"]`; `demo_block_line`).
- **At confirmation the rule sees exactly what `GET /transactions` already reads.** `finishIntake` uses `store.listTransactions(customerId, 21)` minus the chosen charge (`intake/routes.js:114-115`). `listTransactions` reads `PAGE + 1 = 21` rows and serves 20 (`customer/routes.js:14-15,139-143`). The banner's candidates come from those served `items`, with no extra read.
- **A banner charge will be high on its receipt too.** With the fixed tier, `urgencyOf` is high regardless of peers, so a report from the banner gets the block line (`intake/routes.js:158`) and heads the agent queue (`store/d1.js:442-452`).
- **One open report per charge** is enforced in the reservation batch (`d1.js:85-93`, `OPEN_REPORT` at line 51). The banner hides any charge that has any case for this customer (`cases_customer_transaction` index, `migrations/0011`).
- **The view record already exists** (ADR-009): `GET /transactions?lang=` inserts a `charge_views` row and returns `view_ref` (`customer/routes.js:144-153`). The banner hangs off the same `?lang=` request, which the client always sends.
- **Sessions:** `findSession` returns `customer_id, expires_at, admin` (`d1.js:172-173`). Evaluators are admins (ADR-007 decision 10, line 26) and share the demo identities. Routes derive a session hash with `tokenHash(readCookies(request).demo_session)` (`intake/routes.js:118`). Audit tables store its 12-hex prefix as `session_ref` (`migrations/0021_admin_act_as.sql`).
- **Events can't carry new fields.** The scorer rejects fields outside the contract (`Docs/intake/intake-events.md`, Rules). So, as with `charge_views` (ADR-009) and `report_feedback` (migration 0019), the metric lives in an access-controlled table and is read only as aggregates. It is never an intake event or a log line.
- **Agent queue rows pass straight through** (`agent/routes.js:34-37` returns `listIntakeHandoffs` rows). The contract `agentIntake` has `additionalProperties: false` (`front-end/contracts/intake-api.schema.json:405-406`), and so does `transactionList` (line 253-261).
- **Budget ceilings** for `GET /transactions?lang=` are `listView: [3, 26, 2, 3]` (`back-end/test/integration/budget.test.js:28-29`). Any increase is justified in ADR-004 (AGENTS.md).
- **The reset script** must clear every activity table (`back-end/scripts/reset-demo-activity.sql`).
- **The client:**
  - Home template: `front-end/src/app/features/customer/customer.page.html:98-194`.
  - `openChat(transactionId)` preselects a charge (`customer.page.ts:424-…`).
  - `loadTransactions()` (`customer.page.ts:385-390`).
  - Strings in `front-end/src/app/shared/i18n/lang.service.ts`, with `blockCardCall` at lines 48, 165 and 276.
  - Agent queue row chips: `front-end/src/app/features/agent/agent.page.html:66-69`.
- **The latest migration is `0021_admin_act_as.sql`.** No open PR adds a migration (#98, #99 are docs/client only).
- **The Worker never emails without a target.** Notification targets exist only for email sign-ins (`customer/routes.js:116-119`), and `deliver` marks `failed` or `skipped` without throwing (`notify/dispatch.js`).

## Branch

| Branch | Base | Label | Assignee | Reviewers |
|---|---|---|---|---|
| `feat/proactive-alert` | `main` | `enhancement`, `accessibility` | `@me` | Lucas (Worker, D1), Manoella (the metric and segment wording) |

One PR, Conventional title `feat: a proactive alert on a high charge, answered from the home`. It ends with **"Human steps before merge"**. Agents never run `--remote`, deploy, tag or merge.

## File map

| File | Task | Responsibility |
|---|---|---|
| `back-end/migrations/0022_proactive_prompts.sql` | 1 | table `proactive_prompts`; `intake_handoffs.from_prompt` |
| `back-end/src/modules/intake/urgency.js` | 1 | `alertCandidates(items, config)` (pure) |
| `back-end/src/store/d1.js` | 1, 2 | `offerAlert`, `answerAlert`; `from_prompt` in the reservation and the queue |
| `back-end/src/modules/customer/routes.js`, `back-end/src/router.js` | 1 | `alert` on `GET /transactions?lang=`; `POST /transactions/alert` |
| `back-end/scripts/reset-demo-activity.sql` | 1 | clear `proactive_prompts` |
| `front-end/contracts/intake-api.schema.json` | 1, 2 | `transactionList.alert`, `alertAnswer`, `agentIntake.from_prompt` |
| `back-end/test/unit/urgency.test.js`, `back-end/test/integration/proactive.test.js`, `budget.test.js` | 1, 2 | candidates, adversarial matrix, ceilings |
| `back-end/src/modules/agent/routes.js`, `front-end/src/app/features/agent/agent.page.{html,ts,spec.ts}` | 2 | "from alert" chip |
| `front-end/src/app/features/customer/customer.page.{html,ts,css,spec.ts}`, `customer.service.ts`, `shared/i18n/lang.service.ts`, `shared/models/intake.model.ts` | 3 | the banner |
| `Docs/ADRs/ADR-002-…md`, `ADR-004-…md`, `Docs/deliverables/EVALUATION.md` | 4 | dated notes; the metric and its query |
| `back-end/migrations/0023_proactive_emails.sql`, `back-end/src/notify/templates.js`, `dispatch.js` | 5 (optional) | the "we noticed" email |

---

## Task 1: offer and answer the alert (Worker + D1)

**Problem:** nothing tells a customer about a high charge until they report it themselves.

**Target:** `GET /transactions?lang=` returns `alert: { transaction_id, block_card_line } | null`. It holds at most one charge: the newest served charge at or above the fixed amount for its currency that has no case for this customer and that this session hasn't answered, and that no non-admin session of this customer has answered "mine". `POST /transactions/alert { transaction_id, answer }` records the session's one answer (`mine` | `report` | `dismissed`).

**Files:** see the file map (Task 1 rows).

**Migration 0022 (additive):**

```sql
-- A proactive alert on a high charge (fixed tier of config/urgency.json, DF-024), one row per session per charge offered.
-- session_ref is the 12-hex prefix of the session hash (as auth_events); admin copies sessions.admin so metrics can leave
-- evaluators out. The answer is the customer's tap, never a statement; no row is an event. Nothing blocks or refunds (ADR-002).
CREATE TABLE proactive_prompts (
  customer_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  session_ref TEXT NOT NULL CHECK (length(session_ref) = 12),
  admin INTEGER NOT NULL CHECK (admin IN (0, 1)),
  offered_at INTEGER NOT NULL,
  answer TEXT CHECK (answer IN ('mine', 'report', 'dismissed')),
  answered_at INTEGER,
  PRIMARY KEY (customer_id, transaction_id, session_ref),
  FOREIGN KEY (customer_id, transaction_id) REFERENCES transactions(customer_id, transaction_id),
  CHECK ((answer IS NULL) = (answered_at IS NULL))
);
-- A complete report confirmed after this session answered "report" on that charge's alert.
ALTER TABLE intake_handoffs ADD COLUMN from_prompt INTEGER NOT NULL DEFAULT 0 CHECK (from_prompt IN (0, 1));
```

**Why the dismissal is stored per session (decided here):**
- Evaluators are admins sharing six demo identities. If a dismissal or "mine" were global, the first evaluator would hide the banner from every later one.
- So `dismissed` hides it for the rest of that session only, and comes back at the next sign-in, which suits an unanswered urgent charge.
- `mine` from a **non-admin** session hides it for that customer for good.
- `report` leads to a case, and a case always hides the banner.

- [ ] **Step 1: failing tests first.**
  - `test/unit/urgency.test.js`: `alertCandidates` returns, newest first, only items with `amount >= fixed[currency]`. It returns none for a currency the policy doesn't name, and it ignores `high_reasons`.
  - `test/integration/proactive.test.js`, against local D1 with the fictitious seed. **Expected first run: FAIL** (route missing, `alert` absent). Cases:
    1. `demo-ana` `GET /transactions?lang=es` → `alert.transaction_id === 'demo-tx-006'` (BRL 3,890.00), `block_card_line === policy.demo_block_line`, contract `transactionList` valid.
    2. `demo-bruno` → `alert === null`. Without `?lang`, `alert === null` and nothing is written.
    3. A reload in the same session → the same alert, still one row.
    4. `answer: 'dismissed'` → 200, and the next list in that session → `null`. A new non-admin session → the alert is back.
    5. `answer: 'mine'` from a non-admin session → a new session gets `null`. The same answer from an admin session hides it only in that session.
    6. `answer: 'report'`, then `/intake/start` and `/intake/confirm` on `demo-tx-006` in the same session → receipt `urgency: 'high'`, and the next list → `null` (a case exists).
    7. Hostile and isolation cases:
       - another customer's `transaction_id` → 404;
       - a charge never offered in this session → 404;
       - extra keys, a non-string id, an unknown answer or an id over 100 chars → 422;
       - no session → 401;
       - GET, PUT and DELETE on `/transactions/alert` → 405 with `Allow: POST`.
    8. Repeating the same answer → 200, with the first `answered_at` kept. A different answer → 409.
    9. Concurrent first answers (`Promise.all` of `mine` and `dismissed`) → exactly one 200 and one 409, and one stored answer.
    10. An expired or revoked session between offer and answer → 401, and nothing is written.
- [ ] **Step 2: implementation.**
  - `urgency.js`, add:

    ```js
    /** Served charges at or above the policy's fixed amount for their currency, newest first (proactive alert, Decision 1). */
    export const alertCandidates = (items, config) => items.filter(t => Number(t.amount) >= config.fixed[t.currency]).map(t => t.transaction_id);
    ```
  - `d1.js`, `offerAlert({ customerId, sessionRef, admin, candidates, now })`: one `batch` with two statements, using `json_each(?)` over the candidate ids.
    1. `INSERT … SELECT` the first eligible candidate (ordered by `json_each.key`) `ON CONFLICT DO NOTHING`. Eligible means: no `cases` row for (customer, charge); no answered row for (customer, charge, this session); and no `answer='mine' AND admin=0` row for (customer, charge).
    2. The same eligibility `SELECT` of the first unanswered row for this session → `transaction_id` or none.

    Skip the call when `candidates` is empty, so customers like `demo-bruno` pay nothing.
  - `d1.js`, `answerAlert({ customerId, sessionRef, transactionId, answer, now, sessionHash })`: `UPDATE … SET answer, answered_at WHERE` (key) `AND answer IS NULL AND EXISTS(live session by sessionHash for customerId)` `RETURNING`, then a read of the row in the same batch. The route maps the result:
    - no row → 404;
    - a row whose answer differs from the sent one → 409;
    - otherwise → 200 `{ transaction_id, answer, answered_at }` (ISO).
  - `customer/routes.js listTransactions`: inside the `language !== null` branch, after the view insert, `try { alert = … } catch {}`. A failed offer serves the list with `alert: null`, just as a failed view record is "a missing numerator, not an outage". Always return `alert` (null without `?lang`). New `answerAlert` handler, mirroring `acknowledgeDisplay` (exact keys, `UUID`-free id check like `validateHandoffRequest`'s `transaction_id` rule).
  - `router.js`: `'/transactions/alert': { POST: answerAlert }` and `ROUTE_ROLES['/transactions/alert'] = 'customer'`. The prefix is already listed.
  - `reset-demo-activity.sql`: `DELETE FROM proactive_prompts;` before `DELETE FROM sessions;`.
  - Contract:
    - `transactionList.required += "alert"`, `alert: { type: ["object","null"], additionalProperties: false, required: ["transaction_id","block_card_line"], … }`;
    - new `alertAnswer` def.
- [ ] **Step 3:** `cd back-end && npm test` → all green. Then re-measure `listView` and set its ceiling plus a new `listViewAlert` (the `demo-ana` path) and `alertAnswer` entry in `budget.test.js`, measured with no margin and with a one-line comment each.

**Acceptance:** cases 1–10 pass, the contract is validated in every response, the budget suite is green with new measured ceilings, and `npm test` passes.

**Edge cases:**
- Two high charges: the newest is offered first; once it's answered, the next one appears on the next load.
- A charge outside the 20 served rows is never offered.
- An admin act-as session rotates the session, so the alert appears again for the evaluator acting as the customer, as intended.
- A renewed session loses the `from_prompt` link (Task 2). Accepted and documented.

## Task 2: the agent queue marks reports from the alert

**Problem:** the agent can't tell, and the dashboard can't count, which reports the bank prompted.

**Target:** the reservation sets `intake_handoffs.from_prompt = 1` for a **complete** report when the same session answered `report` on that charge's alert. `GET /agent/intakes` and `/agent/intake-detail` return `from_prompt: boolean`, and the queue row shows a chip "Desde aviso" / "Desde aviso" / "From alert".

- [ ] **Step 1: failing tests.**
  - `proactive.test.js`:
    - the case-6 report → `queue.items[0].from_prompt === true` (it also heads the high lane);
    - a report on `demo-tx-006` without a `report` answer → `false`;
    - a `report` answer in session A with confirmation in session B → `false`;
    - contracts `agentIntakeList` and `agentIntakeDetail` are valid.
  - `agent.page.spec.ts`: the chip renders only for `from_prompt: true`, with an accessible text label (not colour alone).
- [ ] **Step 2:** in `reserveIntakeHandoff`'s handoff `INSERT` (`d1.js:94-100`), add the `from_prompt` column. Its value is `EXISTS(SELECT 1 FROM proactive_prompts WHERE customer_id=? AND transaction_id=? AND session_ref=substr(?,1,12) AND answer='report')` for `kind === 'complete'`, and `0` otherwise. Add `h.from_prompt` to `listIntakeHandoffs` and `findIntakeHandoff`. In `agent/routes.js`, map it to a boolean. In the contract, add `agentIntake.required += "from_prompt"` (boolean), and the same in `agentIntakeDetail`. Add the agent page chip and its strings.
- [ ] **Step 3:** `cd back-end && npm test`; `cd front-end && npm test -- --watch=false`. Re-measure the `create`/confirm budget entries if the reservation's rows read changed, and note it.

**Acceptance:** the flag is set only by a same-session `report` answer on the same charge, it is never client-supplied, and the chip and contracts pass.

## Task 3: the banner on the customer home

**Problem:** the customer must see the alert, answer it in one tap and land in the guided chat.

**Target:** above the home `topbar`, an `<aside class="alert-banner" aria-labelledby="alert-title">` shows when `alert` is set, its charge is in `transactions()`, the chat is closed and the charge has no report in `reports()`:
- **Title:** `Vimos un cargo alto de {amount} {currency} en {merchant}. ¿Lo reconoces?` (pt: `Vimos uma cobrança alta de … em …. Você a reconhece?`; en: `We noticed a large charge of … at …. Do you recognize it?`).
- **Reassurance line:** `Si no lo reconoces, repórtalo aquí: una persona del banco revisará tu reporte y te escribiremos en cada paso.` (pt/en equivalents). This is true: the agent queue holds the report and the existing status emails follow. It never says "resuelto", "bloqueado" or "reembolso".
- **Line:** `blockCardCall` + the returned `block_card_line`, then `blockCardNote` ("Este servicio no bloquea tarjetas.").
- **Buttons:** `Sí, es mío`, `No lo reconozco, reportar`, and a close button with `aria-label="Cerrar aviso"`.

It renders with no `role="alert"` and takes no focus on load (no focus theft at sign-in). It is a landmark that screen-reader users reach from the region list. It never says a person wrote it: the copy says "we noticed", which is true of the service.

- [ ] **Step 1: failing specs** (`customer.page.spec.ts`):
  - the banner renders from a list with `alert` and not with `alert: null`;
  - it is hidden when the charge has a report;
  - **report** posts `{ transaction_id, answer: 'report' }`, then calls `openChat(transaction_id)`, so the chat opens with that charge preselected and focus moves to the chat heading. The statement is prefilled only when it is empty, as `reportAgain` does (`customer.page.ts:604-612`), with `alertStatement`: "No reconozco el cargo de {amount} {currency} en {merchant}; el banco me avisó." The customer can edit it. The reason chip stays the customer's own choice (ADR-010 `reason_source`), so the path is: reason, send, confirm;
  - **mine** and **close** post `mine` / `dismissed`, remove the banner and move focus to the `h1`, with a polite `role="status"` line: "Gracias, lo anotamos." / "Obrigado, anotamos." / "Thanks, noted.";
  - a failed POST still hides the banner for this page load. The answer is best effort and never blocks reporting; `report` still opens the chat.
  - All three buttons are keyboard operable, and their text and labels exist in es, pt and en.
- [ ] **Step 2:**
  - `customer.service.ts`: `answerAlert(transactionId, answer)` → `POST /transactions/alert`.
  - `intake.model.ts`: `alert` on the list type.
  - `customer.page.ts`: an `alert` signal set in `loadTransactions()`, plus `answerAlert(answer)`. It is reset on logout and on act-as, as `transactions` is.
  - The template block, CSS from existing tokens (`ar-panel ar-panel-warn`, `ar-btn`, `ar-btn-secondary`), and the strings in `lang.service.ts`.
- [ ] **Step 3:** `cd front-end && npm test -- --watch=false` green; `make intake-test` green. Manual check at 360 px with VoiceOver (or the axe run used in `Docs/Evidence/accessibility-audit.md`): no horizontal scroll, contrast passes, the region is announced.

**Acceptance:** sign in as `demo-ana` locally (`make intake-seed-local`, `DEMO_PICKER=1`) and the banner shows the BRL 3,890.00 charge. "No lo reconozco" leads, after the reason and confirmation, to a high receipt with the block line, and the agent queue shows it first with "From alert". `demo-bruno` sees no banner.

## Task 4: the metric and the records

**Problem:** the dashboard needs "proactive-originated reports" with honest denominators, and the decision needs its record.

**Target:**
- `EVALUATION.md`, under the live metrics: a "Proactive alert" paragraph with the definitions below and the query a person runs.
- `ADR-002` implementation notes: a dated note ("2026-10-04: a proactive alert asks about a charge at the fixed amount tier; it only asks, a 'report' answer starts the normal guided intake; nothing blocks, refunds or decides").
- `ADR-004`: a dated note justifying the new ceilings (one batch on `?lang=` only when a candidate exists; one write per session per offered charge).

**Definitions** (descriptive; non-admin sessions only; counts, not rates, while n < 30, as `PRODUCT_REPORT.md` §4 suppresses small cells):

| Measure | Numerator | Denominator |
|---|---|---|
| Offered | sessions with a `proactive_prompts` row (`admin = 0`) | sessions that loaded `?lang=` with a candidate (the same rows) |
| Answered: report / mine / dismissed / no answer | rows by `answer` (NULL = no answer) | offered rows |
| Converted | `intake_handoffs.from_prompt = 1`, acknowledged | rows answered `report` |
| Share of high reports from the alert | `from_prompt = 1` | acknowledged handoffs with `urgency = 'high'` |

Query (a person runs it; agents never use `--remote`):

```sh
cd back-end && npx wrangler d1 execute arabica-intake-demo --remote --json --command "SELECT admin, COUNT(*) offered, COUNT(answer) answered, SUM(answer='report') report, SUM(answer='mine') mine, SUM(answer='dismissed') dismissed FROM proactive_prompts GROUP BY admin; SELECT SUM(h.from_prompt) from_alert, COUNT(*) high FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) WHERE e.state=h.kind||'_handoff' AND h.urgency='high';"
```

**Limits stated next to the numbers:**
- "Offered" means served, not proven displayed. The client always renders the home after the list, and ADR-009's display acknowledgement covers the view, not the banner.
- A renewed session loses the `from_prompt` link.
- The live sample is team and evaluator sessions, mostly admins.

- [ ] **Step:** write the three doc edits; `make intake-test` stays green (docs only).

**Acceptance:** each figure has its population, numerator, denominator and exclusions (AGENTS.md "Current data workflow", step 5).

## Task 5 (only if Decision 2 is "yes"): the "we noticed" email

**Target:** the first time a charge is offered to a **non-admin** session of a customer with a notification target, one email is queued: "We noticed a large charge" with the charge's amount, currency and merchant. It never includes the statement, and it links to the sign-in. It goes out at most once per (customer, charge), ever, and is sent with `ctx.waitUntil` like the `received` email.

- [ ] **Migration 0023:**
  - `proactive_emails(customer_id, transaction_id, message_id UNIQUE, created_at, provider_status CHECK IN ('queued','sent','failed','skipped'), provider_message_id, PRIMARY KEY(customer_id, transaction_id))`;
  - `INSERT … ON CONFLICT DO NOTHING RETURNING message_id` in the same `offerAlert` batch, only when `admin = 0` and `EXISTS(notification_targets)`.
- [ ] **`templates.js`:** a `noticed` template in es, pt and en, with the existing footer ("No se ha iniciado ningún reembolso…") and the `URGENT` paragraph. `render` gains `{amount, currency, merchant}` slots, used only by `noticed`.
- [ ] **`dispatch.js`:** a `mark` parameter (default `store.markEmail`), so the noticed row is marked in `proactive_emails` without a second outbox.
- [ ] **Tests:**
  - first offer queues one and a reload queues none;
  - an admin session queues none;
  - no target queues none;
  - a failed send leaves the list served;
  - `render('noticed', …)` contains no statement, and its `{…}` slots are filled.
- [ ] **Limits stated:** only SES-verified recipients receive it (sandbox). It is sent at sign-in, not before: there is no charge feed or cron in the demo.

---

## Human steps before merge

1. **No manual migration step.** Since #84, the deploy workflow applies pending additive migrations (0022, and 0023 if Task 5 ships) before the new Worker goes live; the additive check in CI must pass. Nobody runs `--remote` for them.
2. Review: Lucas (Worker, D1, budgets) and Manoella (metric definitions, the segment note).
3. Task 5 only: verify each demo-day recipient in SES (`Docs/Plans/auth-runbook.md:76`).
4. After deploy: sign in as one evaluator identity with a BRL ≥ 2,500 charge and check the banner, the receipt and the queue chip. Then run the Task 4 query once.

## Risks

- **Over-alerting** if Decision 1 picks the full policy (see above). The fixed tier keeps the alert rare and explainable.
- **The demo shares identities.** Per-session dismissal keeps the banner visible to each evaluator. A non-admin "mine" hides it for good for that customer, by design.
- **Budget:** one more batch on `?lang=` only for customers with a candidate. It is measured in the budget suite and justified in ADR-004.
- **Copy:** the banner must never imply a person wrote it, that the card was blocked, or that fraud was decided (ADR-002). QA checks the three languages for this.
- **Time:** Tasks 1–3 touch the Worker, the contract and the client. If noon is at risk, ship Tasks 1 and 3 first (the banner alone delivers the feeling), with Task 2's chip and Task 4's docs as a follow-up PR the same day.

## Skipped (and when to add it)

- **A pre-sign-in email or push:** add it when a charge feed or a Workers Cron Trigger exists. The seed is static today.
- **Manoella's high-value core as a segment:** add it after it is rebuilt on Silver in the design window, reviewed, and carried as a Gold column in the seed.
- **A display acknowledgement for the banner:** add it if "offered" vs "seen" matters for a decision. ADR-009's pattern (`displayed_at`) is the template.
- **An intake event field for origin:** add it if the scorer contract is versioned to v3. Until then the flag lives on the handoff.
- **An alert for the relative (own-p95) rule or for `card_lost_or_stolen`:** the first fires on almost everyone, and the second is only known during a report.
