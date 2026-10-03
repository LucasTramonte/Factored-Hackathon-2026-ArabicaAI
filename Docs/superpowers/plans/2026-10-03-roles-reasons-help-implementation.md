# Roles, report reasons and the help entry: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every agent works in **ponytail ultra** (AGENTS.md, "Agent orchestration"): reads `AGENTS.md` and every file it touches in full, uses what exists before writing, makes the smallest change that works, and asks the orchestrator instead of guessing. One coder per task, then a spec QA agent, then a quality QA agent (three rounds at most, then a person decides).

**Goal:** six product asks, end to end:

1. Evaluators are administrators, and the client shows a banner saying so.
2. Roberto, Lucas, Manoella and the evaluators have admin, customer and agent access.
3. Customers have customer access only.
4. Any email that is not enrolled has no access.
5. The report asks *why* the customer doesn't recognise the charge, with options grounded in how Nubank segments disputes and in what our data can support, without slowing the report down.
6. A "?" help entry ("How can we help you today, {name}?") lets a customer report a charge that isn't in their list; that path can only end with a person.

**Architecture:** no new runtime, no model call, one additive migration. Roles stay Cognito groups verified by the Worker (ADR-007); `admin` becomes a superset of `customer` and `agent` in one helper, and the three session responses return the verified roles so the client can show a banner for the life of the tab. The reason is one new column on `intake_episodes`, one required field on `POST /intake/start`, part of the start's idempotency hash, one clause in the urgency policy, and one chip in the agent view. The help entry is client-only: it opens the existing guided chat without a preselected charge, so the only possible endings are the existing incomplete handoff (a person reviews it) or a confirmed charge the customer owns.

**Tech stack:** Cloudflare Worker + D1 (JavaScript, `node --test`, local D1 through `test/run-local.mjs`), Angular 20 signals (Jasmine/Karma), Amazon Cognito groups, the stdlib-only Python seed generator (`pytest`).

**Sources:** problem statement pp. 3 and 5 (a case requiring human intervention; permissions enforced outside model output); ADR-002 (a handoff is not a resolution; nothing blocks a card); ADR-007 (Cognito groups `customer`, `agent`, `admin`, `auditor`; admin-only enrolment); DATA_QUALITY DF-001, DF-024, DF-025; `Docs/intake/intake-events.md`; André's and Diego's feedback (speed, no twenty questions, make the intelligence visible).

---

## 0. How to read this plan

Each task has the same shape:

- **Problem**: what is wrong or missing today, with a concrete example of today's behaviour.
- **Target**: the behaviour after the task, with an example request/response or screen.
- **Files**: exact paths.
- **Steps**: tests first, then the implementation, each with the exact command and the **expected output**. "Green" means the baseline counts below plus the tests the task adds; each step says how many.
- **Acceptance**: what the spec QA agent checks; the quality QA agent checks AGENTS.md's engineering rules on top.
- **Edge cases**: what must keep working.

### Baseline (measured on `main` 8db96ad, 2026-10-03)

| Suite | Command (repo root unless stated) | Today |
|---|---|---|
| Worker unit | `cd back-end && npm run test:unit` | `ℹ tests 163` `ℹ pass 163` `ℹ fail 0` |
| Worker integration on local D1 | `cd back-end && node test/run-local.mjs` | main group `ℹ tests 69` `ℹ pass 69`; budget group `ℹ tests 4` `ℹ pass 4`. The test "pages are public…" needs a client build in ignored `back-end/public/` (`cd front-end && npm run build` produces it); without one it is the only failure (68/69). |
| Angular | `cd front-end && npx ng test --watch=false` | `TOTAL: 147 SUCCESS` |
| Seed generator | `.venv/bin/python -m pytest data_pipelines/gold -q` | `191 passed, 1 skipped` |
| Evaluation code | `.venv/bin/python -m pytest evals -q` | `113 passed, 6 skipped` (not touched by this plan; run once at the end as a regression check) |

A coder states the new counts in each commit body ("unit 163 → 166").

---

## 1. Facts this plan rests on

Verified on `main` 8db96ad and re-checked by a plan reviewer over three rounds. Coders rely on these; if one turns out wrong, stop and ask the orchestrator.

**Roles and sessions**
- `verifyIdToken` returns `{ sub, email, groups, customerId }`; `groups` is `cognito:groups` filtered to strings, `customerId` is `custom:customer_id` when it matches `CUSTOMER_ID` (`back-end/src/auth/cognito.js`). `bearerClaims` wraps it: 422 `Provide the sign-in token` without a well-formed token, 401 `Sign-in could not be verified` on verification failure, 503 `Sign-in is unavailable` when the JWKS is down.
- `POST /auth/session` (`modules/customer/routes.js:startEmailSession`) requires `claims.groups.includes('customer')` **and** `store.customerSource(customerId)` truthy, else 403 `This account is not enrolled in the demo`. Body today: `{ customer_id, mode: 'email_otp', context_card }`.
- `POST /demo/session` (`startCustomerSession`, local picker, only with `DEMO_PICKER=1`) returns `{ customer_id, mode: 'simulated_login', context_card }`.
- `POST /demo/agent-session` (`modules/agent/routes.js:startAgentSession`, lines 16-25) requires `groups.includes('agent')`, else 403 `This account is not an agent in the demo`; locally without a token it is the one-click session. Body today: `{ role: 'agent', mode }`. `signedIn` is a `const` inside `if (!local) { … }`.
- `router.js` exports `ROLES = ['public','customer','agent','admin','auditor']`; no route has role `admin` or `auditor`. `router.js` imports the route modules, which import `cognito.js`: **`cognito.js` must not import `router.js`** (the cycle hits the temporal dead zone at load).
- `sessions.actor` is `customer | agent` (`0001_intake.sql`), `auth_events.actor` too (`0012_auth_audit.sql`). Admin needs no change there: an admin gets a *customer* cookie on the customer view and an *agent* cookie on the agent view, like everyone else.
- Tests that pin today's rule, to be flipped not bypassed: `back-end/test/unit/email-session.test.js` line ~120 asserts `['admin','auditor']` → 403 on the agent session; lines ~113 and ~145 `deepEqual` the agent body `{ role, mode }`; line ~35 `deepEqual`s the customer body. `back-end/test/unit/contract.test.js` line ~28 has a `session()` helper that builds `{ customer_id, mode, context_card }` and expects it to pass `customerSession`. `AGENTS.md` line 46 states the rule in words.
- The contract (`front-end/contracts/intake-api.schema.json`) has **three** session definitions, all `additionalProperties: false`: `customerSession`, `emailSession`, `agentSession`. The contract has response definitions only.
- Client state is **tab-scoped and in memory**. `CustomerService.client` and `card` are signals; the **page** sets them in `enter()` (`customer.page.ts` ~282, where the body is bound to `s`) and clears them in `reset()` (~534). `AgentService` keeps no state; `signIn` returns `void`; `agent.page.ts:refresh()` is `enter(async () => undefined)`, which calls `reset()` without signing in again; `fail()`'s 401 branch (~238-242) is where an expired agent session is dropped.
- Spec spies: `customer.page.spec.ts` has one `createSpyObj<CustomerService>(…, { client: signal(''), card: signal(null) })`; `customer.page.focus.spec.ts` has **six** untyped ones (lines 11, 38, 63, 88, 186, 212); `agent.page.spec.ts:31` spies `AgentService` with `['signIn','intakes','intakeDetail','setStatus']`.
- Point 4 is already true server-side: the pool is `AllowAdminCreateUserOnly=true` with `--prevent-user-existence-errors ENABLED` (`scripts/cognito/setup.sh:19,39`). An unknown email cannot request a code; Cognito answers a generic error that the client maps to 401 (`core/auth/cognito.service.ts:15`) and shows as "could not send the code" (`errSendCode`), never saying whether the address exists. A verified token without `customer` or without a loaded D1 customer gets 403 and no cookie.
- Enrolment: `back-end/scripts/cognito/enroll.sh <email> <customer_id|-> [group]`, one group per call, groups are additive, `custom:customer_id` is immutable. Roberto → `demo-ana`; Lucas → `demo-bruno` (`lucastramonte3@gmail.com`). Manoella and the evaluators have no identity yet.
- Fictitious identities: customers come from `back-end/src/config/identities.json` (`{customer_id, display_name, source}`), charges from `back-end/seeds/fictitious.json` (`{transaction_id, customer_id, occurred_at, merchant_name, amount, currency}`; today 6 rows `demo-tx-001`…`006`, all BRL, Ana 5 and Bruno 1). `.venv/bin/python -m data_pipelines.gold.fictitious_seed` renders `back-end/seeds/seed_fictitious.sql` (generated, never edited by hand). `data_pipelines/gold/test_fictitious_seed.py` fails when the committed SQL drifts from the generator, and asserts the exact customer list (~line 30) and the transaction count `(6,)` (~line 32).
- `budget.test.js` pins `identities: [1, 12, 0, 1]` = queries, rows read, rows written, round trips; rows read equals the `customers` row count of the local fixture (10 today, so 12 is the ceiling).
- SES is in sandbox: report emails reach only verified addresses. Sign-in codes come from Cognito and reach any enrolled email.

**The guided report**
- Client steps (`customer.page.ts`): `describe` (report-language radios + statement) → `choose` (own charges; preselected when the chat opened from a charge; "I can't find the charge") → `details` (one extra turn) → `receipt`. `send()` freezes `{ customer_statement, idempotency_key, language, mode: 'guided', report_type: 'unrecognized_charge' }` and refuses statements under 10 code points with `chatValidationShort`. `clearChat()` resets every chat signal and the log to `[{ from: 'bot', key: 'chatHello' }]`. `openChat(transactionId?)` restarts a finished chat **only when a charge is given** (`restart = !!transactionId && …`). The chat-log `<li>` renders `'key' in line ? t()[line.key] : line.text`. `opener` is the element that opened the chat; `closeChat()` restores focus to it.
- `POST /intake/start` (`intake/validation.js`) accepts exactly `KEYS = 'customer_statement,idempotency_key,language,mode,report_type'`; anything else is 422 `Provide exactly the guided report fields`. 17 back-end test files, 2 client specs, `customer.page.ts` and `intake.model.ts` carry that exact body (`git grep -l report_type back-end/test front-end/src`). `customer.page.spec.ts` ~331 asserts the exact key list. `unit/validation.test.js` covers only `validateCaseRequest`; the start 422s are asserted by status in `unit/intake.test.js:69-74`.
- `store.startIntake` (`d1.js` ~136-168) inserts 13 columns and hashes `[language, statement]` as `payload_hash`; a replay with the same key and a different hash is 409 `Key already used with different content`. `store.findIntake` selects `*`, so a new column is available as `episode.<column>` in the handoff route.
- Urgency is decided in `intake/routes.js` ~line 100: `urgencyOf(evidence, others, URGENCY)` (`intake/urgency.js`, pure: the fixed tier per currency, else above the customer's own p95 with ≥ 5 same-currency peers), only when `kind === 'complete'`; `d1.js` ~82 forces `normal` for other kinds. `URGENCY` is the static import of `config/urgency.json` = `{ fixed: {MXN: 10000, COP: 2000000, ARS: 500000, USD: 500, BRL: 2500}, relative_min_others: 5, demo_block_line }`. The receipt carries `block_card_line` only when urgency is high. The "urgent" paragraph of the received email is added at send time (`notify/templates.js`), never stored; `findEmails` in tests sees `template: 'received'`.
- Agent list: `d1.js:listIntakeHandoffs` builds one `lane()` SELECT string used for both lanes; the route passes rows through. Agent detail: `d1.js:findIntakeHandoff` selects explicit columns and `agent/routes.js:getAgentIntakeDetail` builds the body explicitly. Contract `agentIntake` and `agentIntakeDetail` are `additionalProperties: false`.
- `ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT … CHECK` has precedent (`0013_urgency.sql`); `test/unit/intake-storage.test.js` and `data_pipelines/gold/intake_slice.py:MIGRATIONS` apply every migration file automatically.
- Events: `reason` will not be an event field, so `intake-events.md` v2, the export allowlist and the scorer are untouched.

**Why the reasons are authored**
- `fact_complaints.subcategory` has five values (`Cargo no reconocido`, `Cobro indebido`, `Problema con app`, `Atención en sucursal`, `Calidad de servicio`) and only the first is ours; `description` is one template per subcategory (DF-001); dispute outcomes are templates with no transaction link (DF-025). Nothing in the data says *why* a customer didn't recognise a charge. The options are therefore authored, following the segmentation Nubank's app applies to a disputed card purchase (first "did you make this purchase?", then: not recognised, charged twice, a different amount, cancelled or not received, a subscription that keeps charging, card lost or stolen). ADR-010 records that they will be re-cut when real statements exist. What our data does support is the amount-tier urgency policy (DF-024), which the reasons extend by one clause.

**i18n and design system**
- Every string exists in es, pt and en in `front-end/src/app/shared/i18n/lang.service.ts`; `Strings` is keyed on the Spanish object, so a missing key fails the build. `LangService.lang()` is the interface language; `reportLang()` on the page is the report language; a prefilled statement must follow the **report** language. `displayName()`, `this.lang`, `RouterLink` exist on both pages.
- Design-system classes: `.ar-chip` with `-ok/-warn/-err`, `.ar-check` radios, `.ar-btn`, `.ar-btn-secondary` (`front-end/src/styles.css`). Tokens that exist in `:root`: `--surface`, `--surface-sunken`, `--ink`, `--ink-muted`, `--line`, `--hairline`, `--accent`, `--accent-soft`, `--accent-strong`, `--on-accent`, `--focus`, `--link`, `--radius-md`, `--radius-sm`, `--font-sans`, `--font-mono`. There is **no** `--shadow-*` token. The chat panel is fixed at `right: 24px; bottom: 84px` (`customer.page.css:4`). `narrow()` is the 1180 px layout switch at which the open chat makes the page inert.

---

## 2. Branches, PRs and who reviews

| Part | Branch | Base | Label | Reviewer |
|---|---|---|---|---|
| R: roles, admin banner, evaluator identities | `feat/admin-roles` | `main` | `enhancement` | Lucas (auth) |
| S: report reasons | `feat/report-reasons` | `main` | `enhancement` | Manoella (product) |
| H: the "?" help entry | `feat/help-entry` | `feat/report-reasons` | `enhancement` | Manoella |

R and S share only `lang.service.ts` and `intake.model.ts` (additions at different places; the cascade merges them). Every PR: `--assignee @me`, label, reviewer, the test counts, and a closing **"Human steps before merge"**. Agents never tag, merge, deploy, run `--remote`, or change a real person's Cognito groups without the orchestrator's go.

## 3. File map

| File | Part | Responsibility |
|---|---|---|
| `back-end/src/auth/cognito.js` | R | `hasRole(groups, role)` and `rolesOf(groups)`; no import from `router.js` |
| `back-end/src/modules/customer/routes.js`, `modules/agent/routes.js` | R | use `hasRole`; `roles` on the three session bodies |
| `front-end/contracts/intake-api.schema.json` | R, S | `roles` on `customerSession`, `emailSession`, `agentSession`; `reason` on `agentIntake`, `agentIntakeDetail` |
| `back-end/test/unit/email-session.test.js`, `contract.test.js` | R | the access matrix as tests; the `session()` helper gains `roles` |
| `front-end/src/app/features/customer/customer.service.ts`, `features/agent/agent.service.ts` | R | a `roles` signal next to `client`; `AgentService.signIn` returns the body |
| `customer.page.{ts,html}`, `agent.page.{ts,html}`, `styles.css`, `lang.service.ts`, `shared/models/intake.model.ts`, the page specs | R | inline banner on each page; spies gain `roles` |
| `back-end/src/config/identities.json`, `back-end/seeds/fictitious.json`, `seed_fictitious.sql`, `data_pipelines/gold/test_fictitious_seed.py`, `budget.test.js` | R | four evaluator identities with charges; the `identities` ceiling |
| `Docs/ADRs/ADR-007-…md` (Proposed, editable), `back-end/README.md`, `AGENTS.md` line 46, `enroll.sh` header | R | decision 8, the access matrix, the enrolment runbook |
| `back-end/migrations/0016_report_reason.sql` | S | `intake_episodes.reason` |
| `back-end/src/modules/intake/validation.js`, `intake/routes.js`, `store/d1.js`, `agent/routes.js`, `config/urgency.json` | S | `REASONS`; required field; stored; hashed; urgency clause; returned to agents |
| the 17 test files with a start body, `unit/validation.test.js`, `unit/intake.test.js`, `integration/intake.test.js`, `urgency.test.js`, `unit/urgency.test.js` | S | bodies carry `reason`; the new assertions |
| `customer.page.{ts,html}`, `styles.css`, `lang.service.ts`, `intake.model.ts`, `customer.page.spec.ts`, `customer.service.spec.ts` | S | reason chips + prefilled statement + lost-card line |
| `agent.page.{ts,html}`, `lang.service.ts`, `intake.model.ts`, `agent.page.spec.ts` | S | reason chip in the queue and the detail |
| `Docs/ADRs/ADR-010-report-reasons-and-help-entry.md`, `Docs/ADRs/README.md`, `Docs/intake/intake-events.md`, `Docs/deliverables/DATA_QUALITY.md` (DF-024) | S, H | the product decision; "stored, not exported"; the urgency clause |
| `customer.page.{ts,html,css}`, `lang.service.ts`, page specs | H | the "?" button and the general chat mode |
| `Docs/deliverables/SYSTEM_DESIGN.md`, `back-end/README.md` | H | the help entry and its human-only ending |

---

## Part R: roles, the admin banner and evaluator access

### Problem (asks 1–4)

Today there are two kinds of people in the demo and nothing in between:

- An email in group `customer` with a loaded `custom:customer_id` can sign in at `/` and sees only its own charges. If that same person opens `/agent` and signs in, the Worker answers **403 `This account is not an agent in the demo`**.
- An email in group `agent` can sign in at `/agent`. If it tries `/`, the Worker answers **403 `This account is not enrolled in the demo`**, because it has no customer id.
- Roberto and Lucas are in **both** groups, so they can use both views, but nothing on screen says they are team or evaluators, and the groups `admin` and `auditor` exist in Cognito and in `ROLES` without doing anything. Giving an evaluator access today means two enrolment commands and a demo identity per evaluator, and there are only two fictitious identities (Ana, Bruno), both taken.
- Nobody can get in without being enrolled (the pool only accepts admin-created users and hides whether an email exists), but no test or document says so, so an evaluator reading the repo cannot tell whether that is true.

**Example today.** Lucas signs in at `/` with `lucastramonte3@gmail.com`; the page greets "Olá, Bruno" with Bruno's charges and nothing else. He opens `/agent`, signs in again, and sees the queue. From the screens, he looks like an ordinary customer and an ordinary agent.

### Target

- One Cognito group, `admin`, grants both views: `POST /auth/session` accepts an `admin` token whose `custom:customer_id` is loaded; `POST /demo/agent-session` accepts an `admin` token. Customers and agents keep exactly today's rights.
- The three session responses carry `roles`, the verified groups that are roles:

```json
POST /auth/session  (Authorization: Bearer <id token in groups ["admin"], custom:customer_id "demo-carla">)
200 {"customer_id":"demo-carla","mode":"email_otp","context_card":null,"roles":["admin"]}

POST /demo/agent-session  (same token)
200 {"role":"agent","mode":"email_otp","roles":["admin"]}

POST /auth/session  (token in groups ["agent"])
403 {"detail":"This account is not enrolled in the demo"}      (unchanged)

POST /demo/agent-session  (token in groups ["customer"])
403 {"detail":"This account is not an agent in the demo"}        (unchanged)
```

- When `roles` includes `admin`, both views show a banner under the top bar:

```
[ admin · evaluation ]  You are a demo administrator. This is the customer experience; the agent view
                        is where incoming reports are reviewed.   Agent view →
```

- Four more fictitious identities exist (Carla, Diego, Elena, Marco) with charges shaped so that every reason of Part S can be tried.
- A README table says who can do what, each row backed by a named test.

### Task R.1: `admin` is a superset; sessions return the verified roles (Worker)

**Files:** modify `back-end/src/auth/cognito.js`, `back-end/src/modules/customer/routes.js`, `back-end/src/modules/agent/routes.js`, `front-end/contracts/intake-api.schema.json`, `back-end/test/unit/email-session.test.js`, `back-end/test/unit/contract.test.js`.

- [ ] **Step 1: tests first** (`email-session.test.js`; read the whole file). Its helpers are `call(authorization, verify, s = store(), body)` for the customer route and `agent(authorization, verify, e = env, body)` for the agent route; `store(source)` returns a fake whose `customerSource` resolves to `source`, so `store(null)` makes the "not loaded" case.

  (a) First customer test: the expected body becomes `{ customer_id: 'demo-ana', mode: 'email_otp', context_card: null, roles: ['customer'] }`.

  (b) Add after it:

```js
test('an admin with its own customer id is also a customer; roles carry only known groups', async () => {
  const r = await call('Bearer ' + jwt, async () => ({ ...claims, groups: ['admin', 'weird'] }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.roles, ['admin']);
  assertContract('emailSession', r.body);
  assert.match(r.cookie, /^demo_session=/);
});

test('a token without customer or admin, or without a loaded customer, is 403 with no cookie and no session write', async () => {
  for (const [groups, source] of [[['agent'], 'fictitious'], [['auditor'], 'fictitious'], [['customer'], null], [['admin'], null]]) {
    const r = await call('Bearer ' + jwt, async () => ({ ...claims, groups }), store(source));
    assert.equal(r.status, 403, groups.join() + ' ' + source);
    assert.deepEqual(r.body, { detail: 'This account is not enrolled in the demo' });
    assert.equal(r.cookie, null);
    assert.ok(!r.calls.some(c => c[0] === 'rotateSession'));
  }
});
```

  (c) Agent block: the two `deepEqual`s on the agent body gain `roles: ['agent']` (both the token case and the local one-click case). The 403 loop becomes `[['customer'], [], ['auditor'], ['Agent']]`. Add:

```js
test('an admin token gets an agent session too', async () => {
  const r = await agent('Bearer ' + jwt, async () => ({ ...claims, groups: ['admin'], customerId: null }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { role: 'agent', mode: 'email_otp', roles: ['admin'] });
  assertContract('agentSession', r.body);
});
```

  (d) `contract.test.js` ~28: the `session()` helper gains `roles: ['customer']`, because `roles` becomes required.

- [ ] **Step 2: see them fail.** `cd back-end && npm run test:unit`. Expected: `ℹ tests 166`, `ℹ fail` between 4 and 6: the two edited `deepEqual`s fail with `roles` missing, the admin tests fail with `403 !== 200`, and `contract.test.js` still passes (a key present in the fixture is fine until the contract requires it). If a different test fails, stop: a helper name changed.

- [ ] **Step 3: implementation.** `cognito.js`, after `verifyIdToken`:

```js
const GRANTED = ['customer', 'agent', 'admin', 'auditor'];
/** The verified groups that are roles, in a fixed order. ``admin`` is listed as itself; ``hasRole`` makes it imply the rest. */
export const rolesOf = groups => GRANTED.filter(r => groups.includes(r));
/** ``admin`` may do anything a customer, agent or auditor may (ADR-007, decision 8). */
export const hasRole = (groups, role) => groups.includes(role) || groups.includes('admin');
```

  `customer/routes.js`: import `hasRole, rolesOf`; in `startEmailSession` replace `!claims.groups.includes('customer')` with `!hasRole(claims.groups, 'customer')` and add `roles: rolesOf(claims.groups)` to the body; in `startCustomerSession` add `roles: ['customer']`.

  `agent/routes.js`: `signedIn` is a `const` inside `if (!local)`, so hoist the roles:

```js
export async function startAgentSession(request, env, store, ctx, verify = verifyIdToken) {
  const local = env.DEMO_PICKER === '1' && !request.headers.has('Authorization');
  let roles = ['agent'];
  if (!local) {
    const signedIn = await bearerClaims(request, env, verify);
    if (signedIn.error) return signedIn.error;
    if (!hasRole(signedIn.claims.groups, 'agent')) return fail(403, 'This account is not an agent in the demo');
    roles = rolesOf(signedIn.claims.groups);
  }
  return json({ role: 'agent', mode: local ? 'simulated_login' : 'email_otp', roles }, 200,
    { 'Set-Cookie': await startSession(request, store, 'agent') });
}
```

  Update the three docstrings by one clause each ("an `admin` token counts as both"). Contract: add to `customerSession`, `emailSession` and `agentSession`, in `required` and `properties`:

```json
"roles": { "type": "array", "uniqueItems": true, "items": { "enum": ["customer", "agent", "admin", "auditor"] } }
```

- [ ] **Step 4: green.** `npm run test:unit` → `ℹ tests 166` `ℹ pass 166` `ℹ fail 0`. Then `node test/run-local.mjs` → main `ℹ tests 69` `ℹ pass 69` (68 without a client build in `public/`), budget `ℹ tests 4` `ℹ pass 4`. The gate matrix in `adversarial.test.js` already covers both session routes for method and path; no new query, so no ceiling moves.

- [ ] **Step 5: commit.**
  `git add back-end/src/auth/cognito.js back-end/src/modules/customer/routes.js back-end/src/modules/agent/routes.js back-end/test/unit/email-session.test.js back-end/test/unit/contract.test.js front-end/contracts/intake-api.schema.json && git commit -m "feat(auth): admin implies customer and agent; sessions return the verified roles"` with the Co-Authored-By trailer and the counts in the body.

**Acceptance:** the four bodies in the Target (admin customer 200, admin agent 200, agent-only customer 403, customer-only agent 403) are each one test; `roles` never contains an unknown group; no 403 writes a session (`rotateSession` absent from the store calls); identity still comes only from the verified claims (the body is ignored; the existing test proves it). **Edge cases:** the local one-click agent session returns `roles: ['agent']` without a token; a token with `groups: []` is 403 on both routes; `auditor` alone is 403 on both (reserved).

### Task R.2: the banner (client)

**Who owns the state.** Customer side: `client` and `card` are signals on `CustomerService` that the **page** writes in `enter()` and clears in `reset()`; the service never sees the session body. `roles` follows that exactly: a `roles` signal on the service, written by the page next to `client`. Setting it inside the service would leak another customer's roles on the `errOtherCustomer` path (~267-279). Agent side: the service keeps no state, so the **page** owns `readonly roles = signal<Role[]>([])`, set from the body that `AgentService.signIn` now returns; no service signal.

**Files:** modify `front-end/src/app/features/customer/customer.service.ts`, `features/agent/agent.service.ts`, `features/customer/customer.page.{ts,html}`, `features/agent/agent.page.{ts,html}`, `front-end/src/styles.css`, `shared/i18n/lang.service.ts`, `shared/models/intake.model.ts`; specs `agent.service.spec.ts`, `customer.page.spec.ts`, `agent.page.spec.ts`, `customer.page.focus.spec.ts`.

- [ ] **Step 1: failing specs.**
  - `agent.service.spec.ts`: `signIn('id.token')` resolves to the body the API returned.
  - `customer.page.spec.ts`: after `enter()` with a session `{ customer_id: 'demo-ana', mode: 'email_otp', context_card: null, roles: ['admin'] }` the spy's `roles` signal holds `['admin']` and the home step renders `aside.role-banner[role=status]` containing the text of `t().adminChip` and an `a[href="/agent"]`; with `roles: ['customer']` there is no `.role-banner`; after `reset()` (signing in as another customer) the signal is `[]`. The `createSpyObj` in `customer.page.spec.ts` and all **six** in `customer.page.focus.spec.ts` (lines 11, 38, 63, 88, 186, 212; untyped, so a missing `roles` makes the template throw) gain `roles: signal([])`.
  - `agent.page.spec.ts`: with the spy's `signIn` resolving `{ role: 'agent', mode: 'email_otp', roles: ['admin'] }`, the page renders `.role-banner` with an `a[href="/"]`; with `roles: ['agent']` it does not; after `refresh()` the banner is still there.
- [ ] **Step 2: see them fail.** `cd front-end && npx ng test --watch=false`. Expected: compile errors first (`roles` does not exist on the types), then `Executed 150 of 150 (3 FAILED)` once the types exist and before the templates do.
- [ ] **Step 3: implementation.**

  `intake.model.ts`:

```ts
export type Role = 'customer' | 'agent' | 'admin' | 'auditor';
export interface CustomerSession { customer_id: string; mode: 'simulated_login' | 'email_otp'; context_card?: ContextCard | null; roles: Role[]; }
export interface AgentSession { role: 'agent'; mode: 'simulated_login' | 'email_otp'; roles: Role[]; }
```

  `customer.service.ts`: `readonly roles = signal<Role[]>([]);` next to `client`. `customer.page.ts`: in `enter()` the body is bound to `s` (~266; `session` there is the callback), so next to `this.client.set(s.customer_id)` (~283) write `this.service.roles.set(s.roles)`; in `reset()`, `this.service.roles.set([])`; expose `readonly roles = this.service.roles;`.

  `agent.service.ts`:

```ts
/** An agent session from a Cognito ID token (groups ``agent`` or ``admin``); without one, the local one-click session (``DEMO_PICKER`` only). */
signIn(idToken?: string): Promise<AgentSession> {
  return this.api.request<AgentSession>('/demo/agent-session', {}, idToken ? { Authorization: 'Bearer ' + idToken } : {});
}
```

  `agent.page.ts`: `readonly roles = signal<Role[]>([]);` and in the two `enter()` callers the `start` callbacks become `async () => this.roles.set((await this.service.signIn(token?)).roles)`. Do **not** clear it in `reset()`: `refresh()` is `enter(async () => undefined)`, which calls `reset()` and never signs in again, so the banner would vanish on Refresh. Clear it in `fail()`'s 401 branch next to the existing `this.reset()`.

  `customer.page.html`, first child of `<main class="home-main">`:

```html
@if (roles().includes('admin')) {
  <aside class="role-banner" role="status">
    <span class="ar-chip">{{ t().adminChip }}</span><span>{{ t().adminOnCustomer }}</span>
    <a [routerLink]="frozen() ? null : '/agent'">{{ t().agentView }}</a>
  </aside>
}
```

  `agent.page.html`, right after the `.topbar` div:

```html
@if (roles().includes('admin')) {
  <aside class="role-banner" role="status">
    <span class="ar-chip">{{ t().adminChip }}</span><span>{{ t().adminOnAgent }}</span>
    <a routerLink="/">{{ t().customer }}</a>
  </aside>
}
```

  `styles.css`, once (both pages use it):

```css
.role-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 16px; border-radius: var(--radius-md); background: var(--surface-sunken); color: var(--ink-muted); font: 400 14px/20px var(--font-sans); }
.role-banner a { color: var(--link); font-weight: 500; }
```

  Strings, next to `agentView` in each language block:

| key | es | pt | en |
|---|---|---|---|
| `adminChip` | administración · evaluación | administração · avaliação | admin · evaluation |
| `adminOnCustomer` | Eres administrador/a de la demo. Esta es la experiencia del cliente; en la vista de agente revisas los reportes que llegan. | Você é administrador/a da demo. Esta é a experiência do cliente; na visão do agente você analisa os relatos que chegam. | You are a demo administrator. This is the customer experience; the agent view is where incoming reports are reviewed. |
| `adminOnAgent` | Eres administrador/a de la demo. Esta es la vista de agente; vuelve a la vista de cliente para reportar un cargo. | Você é administrador/a da demo. Esta é a visão do agente; volte à visão do cliente para relatar uma cobrança. | You are a demo administrator. This is the agent view; go back to the customer view to report a charge. |

- [ ] **Step 4: green.** `npx ng test --watch=false` → `TOTAL: 150 SUCCESS`. `npm run build` compiles with no new warnings. At 390 px the banner wraps onto two lines and the page has no horizontal scroll.
- [ ] **Step 5: commit** `feat(client): administrators see an evaluation banner on both views`.

**Acceptance:** admin sees the banner on both views; customer and agent never see it; the banner never covers a control (it is in normal flow above the top bar); the link follows the existing `frozen()` guard on the customer page; after `refresh()` on the agent page the banner stays; after an expired agent session (401) it goes. **Edge cases:** a reload drops the banner together with the signed-in view (tab-scoped state; stated in the PR); the local one-click agent session shows no banner.

**Example screen (es, customer view, admin):** under the top bar a grey strip: `administración · evaluación` chip, then "Eres administrador/a de la demo. Esta es la experiencia del cliente; en la vista de agente revisas los reportes que llegan." then the link "Vista de agente".

### Task R.3: four evaluator identities

**Problem.** Two fictitious identities exist and both are taken (Roberto → Ana, Lucas → Bruno). Manoella and three evaluators need an identity each, with charges that let them try every reason of Part S and the urgency lane.

**Files:** modify `back-end/src/config/identities.json`, `back-end/seeds/fictitious.json`, `data_pipelines/gold/test_fictitious_seed.py`, `back-end/test/integration/budget.test.js`; regenerate `back-end/seeds/seed_fictitious.sql`.

- [ ] **Step 1: the drift test first.** In `test_fictitious_seed.py` change the expected customer list (~line 30) to the six identities in id order (`demo-ana`, `demo-bruno`, `demo-carla`, `demo-diego`, `demo-elena`, `demo-marco` with their display names) and the transaction count `(6,)` → `(26,)` (~line 32). Run `.venv/bin/python -m pytest data_pipelines/gold -q` → `2 failed, 189 passed, 1 skipped` (the drift test and the load test).
- [ ] **Step 2: identities.** Add to `identities.json` `customers`, after Bruno: `demo-carla` "Carla (demo)", `demo-diego` "Diego (demo)", `demo-elena` "Elena (demo)", `demo-marco` "Marco (demo)", each `"source": "fictitious"`.
- [ ] **Step 3: charges.** Add 20 rows to `fictitious.json` (`demo-tx-007`…`026`, BRL like the existing rows, dates 2026-09-22 to 2026-09-30, amounts as strings with two decimals). Each identity gets the same five shapes:

| shape | why | Carla (example) |
|---|---|---|
| a normal purchase | the "not mine" and "wrong amount" reasons | `Mercado Demo` 142.80, 2026-09-22T11:05:00+00:00 |
| the same merchant and amount one minute apart | "charged twice" | `Restaurante Demo` 96.00 at 14:10 and 14:11 on 2026-09-24 |
| a small recurring-looking charge | "subscription" | `Streaming Demo` 29.90, 2026-09-26T03:00:00+00:00 |
| one at or above the BRL fixed tier (2,500.00) | the urgency lane | `Viagens Demo` 2890.00, 2026-09-29T18:40:00+00:00 |

  Vary merchants and amounts per identity (Diego: `Padaria Demo` 18.50, `Posto Demo` 210.00 ×2, `Musica Demo` 19.90, `Moveis Demo` 3150.00; Elena: `Farmacia Demo` 63.20, `Taxi Demo` 42.00 ×2, `Nuvem Demo` 34.90, `Joalheria Demo` 2650.00; Marco: `Livraria Demo` 88.00, `Cafe Demo` 24.00 ×2, `Jornal Demo` 15.90, `Eletro Demo` 4120.00).
- [ ] **Step 4: regenerate and test.** `.venv/bin/python -m data_pipelines.gold.fictitious_seed` → `Wrote back-end/seeds/seed_fictitious.sql`. `git diff --stat back-end/seeds/seed_fictitious.sql` shows additions only. `.venv/bin/python -m pytest data_pipelines/gold -q` → `191 passed, 1 skipped`.
- [ ] **Step 5: the Worker suites.** `cd back-end && npm run test:unit` → 166 pass (with R.1 on the branch). `node test/run-local.mjs`: the budget test's `identities` ceiling `[1, 12, 0, 1]` fails because rows read is now 14 (10 fixture customers + 4); pin `[1, 16, 0, 1]` and say in the commit body that no code path changed. Re-run → 69/69 and 4/4.
- [ ] **Step 6: commit** `data(seed): four fictitious evaluator identities with charges for every reason`.

**Acceptance:** six fictitious identities; 26 charges; every new identity has the four shapes; the seed is idempotent (the load test runs it twice); the drift test passes; the only budget change is `identities` rows read. **Edge cases:** the dataset cohort identities are untouched; `DEMO_PICKER` lists the new identities locally.

### Task R.4: docs and the enrolment runbook

**Problem.** The access rule lives in code and in one sentence of `AGENTS.md`; there is no table saying who can do what, and no runbook for enrolling an evaluator.

**Files:** `Docs/ADRs/ADR-007-customer-identity-cognito-email-otp.md`, `back-end/README.md`, `AGENTS.md` (line 46), `back-end/scripts/cognito/enroll.sh` header.

- [ ] ADR-007, Decision, new point 8: "**`admin` is a superset.** An admin token may start a customer session (with its own `custom:customer_id`, which must be loaded) and an agent session. `auditor` stays reserved. Both session responses list the verified roles, and the client shows an evaluation banner when they include `admin`. Tests: `back-end/test/unit/email-session.test.js`." Implementation notes: the enrolment commands from the human steps below.
- [ ] `AGENTS.md` line 46: "`POST /auth/session` signs in only a `customer`- or `admin`-group user whose id is loaded in D1".
- [ ] `back-end/README.md`, new "Access" section:

| Who | Cognito groups | Customer view | Agent view | Banner | Test |
|---|---|---|---|---|---|
| Customer | `customer` + a loaded `custom:customer_id` | yes | no (403) | no | `email-session.test.js` "any other group is one 403" |
| Agent | `agent` | no (403) | yes | no | "a token without customer or admin … is 403" |
| Team and evaluators | `admin` + a loaded `custom:customer_id` | yes | yes | yes | "an admin … is also a customer"; "an admin token gets an agent session too" |
| Anyone else | not enrolled | no code is sent (Cognito's generic answer; the client says "could not send") | same | — | `cognito.test.js` and `cognito.service.spec.ts` 401 mapping |

  Add: "The sign-in never reveals whether an address exists (`prevent-user-existence-errors`)."
- [ ] `enroll.sh` header: "Admins: `enroll.sh <email> <customer_id> admin` (an admin also needs a customer id to use the customer view)."
- [ ] Commit `docs(auth): admin role, access matrix and enrolment runbook`.

**Human steps before merge (R):**
1. Lucas agrees to ADR-007 decision 8 in the PR.
2. Load the new identities into remote D1 **before** anyone is enrolled on them (an admin whose id is not loaded gets 403): `cd back-end && npx wrangler d1 execute arabica-intake-demo --remote --file seeds/seed_fictitious.sql`. Expected: 26 statements, no errors; the upserts are idempotent. Say so in the PR.
3. Enrol after the merge is deployed (so the banner exists). `enroll.sh` adds a group and keeps the existing ones:
   ```sh
   sh back-end/scripts/cognito/enroll.sh rzuniga@aptsny.co demo-ana admin
   sh back-end/scripts/cognito/enroll.sh lucastramonte3@gmail.com demo-bruno admin
   sh back-end/scripts/cognito/enroll.sh <manoella's email> demo-carla admin
   sh back-end/scripts/cognito/enroll.sh <evaluator 1> demo-diego admin    # then demo-elena, demo-marco
   ```
   Expected per line: `created <email>` (or `exists <email>`) then `<email> in group admin`. Needed from the team: Manoella's and the three evaluators' emails.
4. SES sandbox: an evaluator receives the report emails only after clicking a verification email: `aws sesv2 create-email-identity --email-identity <email> --profile arabica --region us-east-2` (prints `False` until they click). The PR and the submission state that sign-in works for every enrolled email, and that notification emails need that verification or SES production access (denied once).

---

## Part S: why the customer doesn't recognise the charge

### Problem (ask 5)

Today the report starts with a free-text box: "Describe lo que pasó", placeholder "No reconozco esta compra...", minimum 10 characters. Everything the customer knows about *why* they don't recognise the charge is buried in that text, so:

- the agent reads a sentence instead of seeing a category at a glance;
- the service cannot treat a lost or stolen card differently from a disputed subscription;
- the fastest possible report still requires typing a sentence.

**Example today.** Ana opens the chat from "Eletronicos Demo 3890.00 BRL", types "no hice esta compra", sends, picks the charge, confirms. The agent sees `Relato del cliente: no hice esta compra` and nothing else about the kind of problem.

Our data cannot tell us the distribution of reasons (§1), so the options are authored from the way Nubank's app segments a disputed purchase and from what a bank can act on.

### Target

- The describe step shows seven chips above the statement:

```
¿Por qué no lo reconoces?
( No hice esta compra ) ( Me cobraron dos veces ) ( El monto es distinto ) ( Cancelé o no recibí )
( Una suscripción sigue cobrando ) ( Perdí la tarjeta o me la robaron ) ( Otro motivo )

Describe lo que pasó
[ No reconozco este cargo; no hice esta compra.                                       ]
                                                                            [ Enviar ]
```

  Tapping a chip fills the statement with a one-line sentence in the report language. The customer can edit it or send it as is. A full report is then: tap → Enviar → pick the charge → Confirmar. No typing.

- The start request carries the reason:

```json
POST /intake/start
{"customer_statement":"Me cobraron dos veces la misma compra.","idempotency_key":"5d1f…","language":"es","mode":"guided","report_type":"unrecognized_charge","reason":"duplicate"}
201 {"episode_id":"…","state":"selection_required","language":"es","mode":"guided","replayed":false}

POST /intake/start  (same key, "reason":"other")
409 {"detail":"Key already used with different content"}

POST /intake/start  ("reason":"nope")
422 {"detail":"Choose one of the report reasons"}

POST /intake/start  (no "reason")
422 {"detail":"Provide exactly the guided report fields"}
```

- The agent queue row shows a reason chip (`me cobraron dos veces`), the detail a "Motivo" row; `GET /agent/intakes` items and `GET /agent/intake-detail` carry `"reason":"duplicate"`.
- "Perdí la tarjeta o me la robaron" adds one guide line at once ("Si tu tarjeta sigue activa, llama a tu banco para bloquearla…") and, on a confirmed charge, the receipt is `urgency: "high"` with the block line, even for a small amount.

### Task S.0: ADR-010 (orchestrator)

`Docs/ADRs/ADR-010-report-reasons-and-help-entry.md`, Proposed, deciders Lucas, Roberto, Manoella; add it to `Docs/ADRs/README.md`.

Decision:
1. Every guided report carries one `reason` from a closed list of seven: `not_mine`, `duplicate`, `wrong_amount`, `cancelled_or_not_received`, `subscription`, `card_lost_or_stolen`, `other`. The customer picks it with one tap; `not_mine` is offered first.
2. Picking a reason prefills an editable one-line statement in the report language, so a complete report needs no typing: tap → send → choose the charge → confirm.
3. `card_lost_or_stolen` shows the "call your bank" words at once (the number still arrives with the receipt, as today) and, on a confirmed charge, raises urgency to `high` (an addition to DF-024's amount-tier policy, in `config/urgency.json` as `high_reasons`). Nothing blocks a card (ADR-002).
4. The reason is stored on the episode and shown to agents. It is not an event field: the v2 contract, the export and the scorer are unchanged.
5. The "?" help entry opens the same guided chat without a preselected charge. A charge that isn't in the list can only end as an incomplete handoff reviewed by a person; the Worker still checks ownership of any confirmed charge.
6. The reasons are authored. Our data has one relevant subcategory and template text (DF-001, DF-025), so it cannot segment the reason; the list follows the segmentation Nubank's app applies to a disputed card purchase and will be re-cut when real statements exist.

Alternatives: a free-text reason classifier (rejected: no model online, ADR-002 and ADR-006; reopen when the extractor is on); asking the reason after the charge is chosen (rejected: the statement comes first today and the prefill needs the reason); more than seven options (rejected: André's "no twenty questions").

### Task S.1: the column, the validation, the store, the urgency clause, the agent view (Worker)

**Files:** create `back-end/migrations/0016_report_reason.sql`; modify `back-end/src/modules/intake/validation.js`, `back-end/src/store/d1.js`, `back-end/src/modules/intake/routes.js`, `back-end/src/modules/agent/routes.js`, `back-end/src/config/urgency.json`, `front-end/contracts/intake-api.schema.json`; tests `back-end/test/unit/validation.test.js`, `unit/intake.test.js`, `unit/urgency.test.js`, `test/integration/intake.test.js`, `urgency.test.js`, `agent-intake.test.js`, plus the `startBody` helpers in every test that posts `report_type` (`git grep -l report_type back-end/test`, 17 files).

```sql
-- Why the customer doesn't recognise the charge (ADR-010). One closed list; the default keeps old rows valid.
ALTER TABLE intake_episodes ADD COLUMN reason TEXT NOT NULL DEFAULT 'not_mine'
  CHECK (reason IN ('not_mine','duplicate','wrong_amount','cancelled_or_not_received','subscription','card_lost_or_stolen','other'));
```

- [ ] **Step 1: failing tests.**
  - `unit/validation.test.js` today covers only `validateCaseRequest`; import `validateStartRequest, REASONS` from `../../src/modules/intake/validation.js` and add: without `reason` → `.error` `{status: 422, detail: 'Provide exactly the guided report fields'}`; `reason: 'nope'`, `'NOT_MINE'`, `1` → 422 `Choose one of the report reasons`; `reason: 'duplicate'` → `.value.reason === 'duplicate'`; and `REASONS` equals the quoted list inside the migration's `CHECK (reason IN (...))` group (read the file, take the group with `/IN \(([^)]*)\)/`, then `/'([a-z_]+)'/g` on that group only, because the whole file also has `DEFAULT 'not_mine'`), so the two can't drift.
  - `unit/intake.test.js` ~70 (the invalid-body loop asserted by status): add `{ ...body, reason: 'nope' }`.
  - `integration/intake.test.js` (local D1): start with `reason: 'duplicate'` → 201; the handoff's `GET /agent/intake-detail` shows `reason: 'duplicate'`; **a replay with the same key and `reason: 'other'` → 409** `Key already used with different content`; `GET /agent/intakes` rows carry `reason`; both agent responses pass `assertContract`; the stored `intake_events` rows for the episode contain no `reason` key.
  - `integration/urgency.test.js`: a confirmed charge below every threshold with `reason: 'card_lost_or_stolen'` → receipt `urgency: 'high'` with `block_card_line`, the row heads the queue, and `findEmails` shows one `received` template queued (the urgent paragraph is added at send time and is not stored; assert what the existing high-amount test asserts); the same reason on an incomplete handoff → `normal`. `unit/urgency.test.js`: the policy test also asserts `config.high_reasons` deep-equals `['card_lost_or_stolen']`.
  - The 17 `startBody` helpers (and any literal start body in those files) gain `reason: 'not_mine'`.
- [ ] **Step 2: see them fail.** `npm run test:unit` → the validation tests fail (`REASONS` undefined, `.value.reason` undefined) and every start body is now 422 (`KEYS` still excludes `reason`); `node test/run-local.mjs` → most intake tests fail the same way. This intermediate state is expected and lasts one step.
- [ ] **Step 3: implementation.**

  `validation.js`:

```js
const KEYS = 'customer_statement,idempotency_key,language,mode,reason,report_type';
/** Why the customer doesn't recognise the charge (ADR-010); the migration's CHECK mirrors this list. */
export const REASONS = ['not_mine', 'duplicate', 'wrong_amount', 'cancelled_or_not_received', 'subscription', 'card_lost_or_stolen', 'other'];
…
  if (!REASONS.includes(body.reason)) return invalid('Choose one of the report reasons');
…
  return { value: { language: body.language, statement: statement.value, key: body.idempotency_key.toLowerCase(), reason: body.reason } };
```

  `d1.js:startIntake`: destructure `reason`; `payloadHash = await tokenHash(JSON.stringify([language, statement, reason]))`; add `reason` to the INSERT column list and the values (13 → 14 placeholders). `listIntakeHandoffs`'s `lane()` and `findIntakeHandoff`: select `e.reason` (one string covers both lanes). `agent/routes.js:getAgentIntakeDetail`: `reason: row.reason` in the body (the list passes rows through already).

  `urgency.json`: `"high_reasons": ["card_lost_or_stolen"]`. `intake/routes.js` ~line 100:

```js
if (kind === 'complete') urgency = URGENCY.high_reasons.includes(episode.reason) ? 'high'
  : urgencyOf(evidence, (await store.listTransactions(customerId, 21).catch(() => [])).filter(t => t.transaction_id !== transactionId), URGENCY);
```

  (`urgencyOf` stays pure; `URGENCY` is a static JSON import and no test stubs it.) Contract: `agentIntake` and `agentIntakeDetail` gain required `"reason": { "enum": ["not_mine","duplicate","wrong_amount","cancelled_or_not_received","subscription","card_lost_or_stolen","other"] }`.

- [ ] **Step 4: green.** `npm run test:unit` → about `ℹ tests 171`, `fail 0`. `node test/run-local.mjs` → main about `pass 72` (the new integration tests), budget `4/4`. The start writes one more column in the same statement and the handoff reads a column it already loads, so no ceiling moves; if one does, pin the measured value and explain it in the commit.
- [ ] **Step 5: two commits, so the feature diff stays readable.** First `test(intake): start bodies carry the reason` (the 17 files plus `validation.js`'s `KEYS` and `REASONS`), then `feat(intake): a report carries the reason the customer gives (migration 0016)` (everything else).

**Acceptance:** the four responses in the Target (201; 409 on a different reason; 422 unknown; 422 missing); the agent list and detail carry `reason` and pass the contract; lost-card on a confirmed small charge → high with the block line; lost-card on an incomplete handoff → normal; `REASONS` and the CHECK cannot drift (test); no event carries `reason`. **Edge cases:** rows from before the migration read `not_mine` (DEFAULT); a replay with the same key and the same reason still returns 200 `replayed: true`; the shadow extractor path is untouched.

### Task S.2: one-tap reasons in the chat (client)

**Files:** modify `front-end/src/app/features/customer/customer.page.{ts,html}`, `front-end/src/styles.css`, `shared/i18n/lang.service.ts`, `shared/models/intake.model.ts`; specs `customer.page.spec.ts` (the exact-keys assertion at ~331 and the start bodies) and `customer.service.spec.ts` (its start body).

- [ ] **Step 1: failing specs** (`customer.page.spec.ts`, inside the existing guided-report `describe`):
  - (a) the describe step renders `fieldset.chat-reasons` with seven `input[name=reason]`, legend `t().reasonLegend`, the first value `not_mine`, none checked;
  - (b) checking `duplicate` sets the statement textarea to the Spanish `reasonFillDuplicate` when the report language is `es`, and to the Portuguese one when it is `pt`;
  - (c) typing "Compré en otra tienda ese día." then checking another chip leaves the typed text;
  - (d) Send with a statement but no reason shows `t().chatReasonValidation` and never calls `startIntake`;
  - (e) the start body keys are exactly `['customer_statement','idempotency_key','language','mode','reason','report_type']` and `reason` is the checked one;
  - (f) checking `card_lost_or_stolen` appends one guide line `chatLostCard` to the log, and checking it again does not add a second;
  - (g) `newReport()` clears the reason and the prefill.
- [ ] **Step 2: see them fail.** `npx ng test --watch=false` → the exact-keys assertion at ~331 fails first (no `reason`), then the seven new specs.
- [ ] **Step 3: implementation.**

  `intake.model.ts`:

```ts
import type { Strings } from '../i18n/lang.service';  // type-only: lang.service does not import the model, so no cycle
export const REASONS = ['not_mine', 'duplicate', 'wrong_amount', 'cancelled_or_not_received', 'subscription', 'card_lost_or_stolen', 'other'] as const;
export type Reason = typeof REASONS[number];
/** Reason → short label key; shared by the customer chips and the agent view. */
export const REASON_LABEL = { not_mine: 'reasonNotMine', duplicate: 'reasonDuplicate', wrong_amount: 'reasonWrongAmount', cancelled_or_not_received: 'reasonCancelled',
  subscription: 'reasonSubscription', card_lost_or_stolen: 'reasonLostCard', other: 'reasonOther' } as const satisfies Record<Reason, keyof Strings>;
export interface IntakeStartBody { customer_statement: string; idempotency_key: string; language: IntakeLang; mode: 'guided'; report_type: 'unrecognized_charge'; reason: Reason; }
```

  `lang.service.ts`: `stringsFor(lang: Lang): Strings { return STRINGS[lang]; }` (the prefill follows the report language, not the interface).

  `customer.page.ts`:

```ts
/** Reason → its one-line statement, filled in the report language. ``other`` has none. */
const REASON_FILL = { not_mine: 'reasonFillNotMine', duplicate: 'reasonFillDuplicate', wrong_amount: 'reasonFillWrongAmount', cancelled_or_not_received: 'reasonFillCancelled',
  subscription: 'reasonFillSubscription', card_lost_or_stolen: 'reasonFillLostCard' } as const;
…
readonly reasons = REASONS;
readonly reasonLabel = REASON_LABEL;
readonly reason = signal<Reason | null>(null);
/** The last text a chip wrote, so a chip never overwrites what the customer typed. */
private prefill = '';

pickReason(r: Reason): void {
  this.reason.set(r);
  this.chatError.set('');
  if (this.chatStatement.trim() === '' || this.chatStatement.trim() === this.prefill) {
    this.prefill = r === 'other' ? '' : this.lang.stringsFor(this.reportLang())[REASON_FILL[r]];
    this.chatStatement = this.prefill;
  }
  if (r === 'card_lost_or_stolen' && !this.log().some(l => 'key' in l && l.key === 'chatLostCard')) this.log.update(l => [...l, { from: 'bot', key: 'chatLostCard' }]);
}
```

  In `send()`, before the length check: `if (!this.reason()) { this.chatError.set(this.t().chatReasonValidation); return; }`, and the body gains `reason: this.reason()!`. In `clearChat()`: `this.reason.set(null); this.prefill = '';`. When `other` is picked with an empty field, focus the statement (the `afterNextRender` pattern already used for `detailsField`).

  `customer.page.html`, in the `describe` fieldset, between the language radios and the statement label:

```html
<fieldset class="chat-reasons"><legend class="ar-field-label">{{ t().reasonLegend }}</legend>
  @for (r of reasons; track r) {
    <label class="ar-chip-choice"><input type="radio" name="reason" [value]="r" [checked]="reason() === r" (change)="pickReason(r)" required><span>{{ t()[reasonLabel[r]] }}</span></label>
  }
</fieldset>
```

  (The outer fieldset's `[disabled]="busy() || !!frozen()"` disables the chips too; the `(change)` + `[checked]` pattern is the one the `report-lang` radios use.)

  `styles.css`, next to `.ar-check`:

```css
.chat-reasons { display: flex; flex-wrap: wrap; gap: 8px; }
.ar-chip-choice { position: relative; } .ar-chip-choice input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
.ar-chip-choice span { display: inline-flex; padding: 6px 12px; border: var(--hairline) solid var(--line); border-radius: 999px; font: 500 14px/20px var(--font-sans); color: var(--ink); background: var(--surface); }
.ar-chip-choice input:checked + span { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-strong); }
.ar-chip-choice input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: 2px; }
```

  Strings (es / pt / en), next to `describe`:

| key | es | pt | en |
|---|---|---|---|
| `reasonLegend` | ¿Por qué no lo reconoces? | Por que você não a reconhece? | Why don't you recognise it? |
| `reasonNotMine` | No hice esta compra | Não fiz esta compra | I didn't make this purchase |
| `reasonDuplicate` | Me cobraron dos veces | Cobraram duas vezes | Charged twice |
| `reasonWrongAmount` | El monto es distinto | O valor é diferente | Wrong amount |
| `reasonCancelled` | Cancelé o no recibí | Cancelei ou não recebi | Cancelled or not received |
| `reasonSubscription` | Una suscripción sigue cobrando | Uma assinatura continua cobrando | A subscription keeps charging |
| `reasonLostCard` | Perdí la tarjeta o me la robaron | Perdi o cartão ou foi roubado | Card lost or stolen |
| `reasonOther` | Otro motivo | Outro motivo | Something else |
| `reasonFillNotMine` | No reconozco este cargo; no hice esta compra. | Não reconheço esta cobrança; não fiz esta compra. | I don't recognise this charge; I didn't make this purchase. |
| `reasonFillDuplicate` | Me cobraron dos veces la misma compra. | Cobraram duas vezes a mesma compra. | I was charged twice for the same purchase. |
| `reasonFillWrongAmount` | El monto cobrado es distinto al que pagué. | O valor cobrado é diferente do que paguei. | The amount charged is different from what I paid. |
| `reasonFillCancelled` | Cancelé la compra o nunca recibí el producto o servicio. | Cancelei a compra ou nunca recebi o produto ou serviço. | I cancelled the purchase or never received the product or service. |
| `reasonFillSubscription` | Una suscripción que cancelé sigue cobrándome. | Uma assinatura que cancelei continua me cobrando. | A subscription I cancelled keeps charging me. |
| `reasonFillLostCard` | Perdí mi tarjeta o me la robaron y no reconozco este cargo. | Perdi meu cartão ou ele foi roubado e não reconheço esta cobrança. | My card was lost or stolen and I don't recognise this charge. |
| `chatReasonValidation` | Elige por qué no reconoces el cargo. | Escolha por que você não reconhece a cobrança. | Choose why you don't recognise the charge. |
| `chatLostCard` | Si tu tarjeta sigue activa, llama a tu banco para bloquearla: este servicio no bloquea tarjetas. El número llega con tu comprobante. | Se o seu cartão continua ativo, ligue para o seu banco para bloqueá-lo: este serviço não bloqueia cartões. O número chega com o seu comprovante. | If your card is still active, call your bank to block it: this service does not block cards. The number comes with your receipt. |

  Every prefill is over 10 code points, so the 10–2000 rule holds.

- [ ] **Step 4: green.** `npx ng test --watch=false` → `TOTAL: 157 SUCCESS` (147 + 3 from R.2 if merged + 7). Keyboard: Tab reaches the group, arrows move between chips, Space selects. At 390 px the chips wrap with no horizontal scroll. `npm run build` compiles.
- [ ] **Step 5: commit** `feat(client): one-tap reason prefills the report`.

**Acceptance:** the Target screen; tap → send works with no typing; a typed statement is never overwritten; no reason → inline error and no request; the body is exactly the six keys; the lost-card line appears once; `newReport()` resets. **Edge cases:** switching the report language after a chip re-fills only if the field still holds the prefill (re-run `pickReason` on language change: one line); the `other` chip with an empty field keeps the 10-character rule and focuses the field.

**Example (pt):** the customer taps "Cobraram duas vezes"; the field reads "Cobraram duas vezes a mesma compra."; Enviar; the choose step lists the charges with "Restaurante Demo 96,00 BRL" twice; the customer picks one, ticks the confirmation, Confirmar; the receipt shows the reference.

### Task S.3: agents see the reason

**Files:** `front-end/src/app/features/agent/agent.page.{ts,html}`, `shared/i18n/lang.service.ts`, `shared/models/intake.model.ts`; spec `agent.page.spec.ts`.

- [ ] **Step 1: failing specs.** A queue row renders `span.reason-chip` with the reason's label; `card_lost_or_stolen` adds `ar-chip-err`; the detail `dl` has a row `t().reasonLabel` → label. The fixtures in `agent.page.spec.ts` gain `reason`.
- [ ] **Step 2:** `npx ng test --watch=false` → compile error (`reason` missing on `AgentIntake`), then 2 failures.
- [ ] **Step 3:** `AgentIntake` gains `reason: Reason`; the page exposes `readonly reasonLabel = REASON_LABEL;`. Row, after the kind chip: `<span class="ar-chip reason-chip" [class.ar-chip-err]="item.reason === 'card_lost_or_stolen'">{{ t()[reasonLabel[item.reason]] }}</span>`. Detail, before the language row: `<div><dt>{{ t().reasonLabel }}</dt><dd>{{ t()[reasonLabel[d.reason]] }}</dd></div>`. String `reasonLabel`: "Motivo" / "Motivo" / "Reason".
- [ ] **Step 4:** green (+2). **Step 5:** commit `feat(agent): the queue and the detail show the customer's reason`.
- [ ] **Docs:** `Docs/intake/intake-events.md`, guided-flow section, one sentence: "`reason` (ADR-010) is stored on the episode and shown to agents; it is not an event field, so the v2 contract and the export are unchanged." `DATA_QUALITY.md` DF-024 handling: "Since ADR-010, a confirmed charge reported as `card_lost_or_stolen` is also `high` (`config/urgency.json: high_reasons`)." Commit `docs(intake): the reason is stored, not exported; the urgency clause`.

**Example (agent view):** queue row `[completo] [recibido] [me cobraron dos veces] AR-7K3M-2Q9X 2026-10-03 14:12:08 UTC`; a lost-card row shows the red `perdí la tarjeta o me la robaron` chip next to the red `Prioridad alta` chip.

**Human steps before merge (S):**
1. The three deciders agree to ADR-010 in the PR.
2. Remote migration 0016 before merge: `cd back-end && npx wrangler d1 time-travel info arabica-intake-demo && npx wrangler d1 migrations apply arabica-intake-demo --remote`. Expected: the bookmark line, then `0016_report_reason.sql` listed and applied. Say so in the PR body (the deploy guard refuses to deploy otherwise, as on 2026-10-01).

---

## Part H: "How can we help you today, {name}?"

### Problem (ask 6)

Today the only way into a report is the "Reportar este cargo" button on a charge row. When a charge has an open report, its button disappears. So a customer who sees a charge on their bank statement that is **not** in the list (the demo serves the newest 20), or who has already reported every listed charge, has no button to press. The chat does have "No encuentro el cargo", but only after the chat is open, and the chat only opens from a charge.

**Example today.** Bruno has one charge, `Cafe Demo 32.00 BRL`. He reports it. Now his home screen shows the charge with a status chip and no button. If he wants to report a `99.00` charge he saw elsewhere, there is nothing to click.

### Target

A round "?" button sits bottom-right on the home screen, always. It opens the same chat in **general mode**:

```
Guía: ¿Cómo te ayudamos hoy, Bruno? Si es un cargo que no ves en tu lista, cuéntanos el comercio,
      el monto y la fecha aproximada. Después revisas tus cargos y, si no está, una persona lo revisa contigo.

¿Por qué no lo reconoces?  ( No hice esta compra ) …
Describe lo que pasó
[                                                                                      ]
                                                                            [ Enviar ]
```

After Enviar the choose step lists the charges as today, but with the buttons swapped: **No encuentro el cargo** is the primary button and *Confirmar este cargo* the secondary. "No encuentro el cargo" asks once what the customer remembers and ends in an incomplete handoff: receipt kind `incomplete`, the agent queue shows it as `incompleto`, and in the exported events the episode ends `routed`. Nothing automated happens to money or cards. If the customer does spot the charge in the list after all, confirming it still goes through the Worker's ownership check, exactly as today.

**No server change.** The general path uses the same `POST /intake/start`, `/intake/handoff` and `/intake/confirm`.

### Task H.1: the "?" button and the general chat (client)

**Files:** modify `front-end/src/app/features/customer/customer.page.{ts,html,css}`, `shared/i18n/lang.service.ts`; specs `customer.page.spec.ts`, `customer.page.focus.spec.ts`.

- [ ] **Step 1: failing specs.**
  - (a) on the home step `button.help-fab` exists with `aria-label` `t().help` and text "?", whether or not every charge has an open report;
  - (b) clicking it opens the chat whose first guide line equals `t().chatHelloGeneral` with `{name}` replaced by the context card's first name (or the display name), no charge is preselected, and on the choose step the "I can't find the charge" button has class `ar-btn` and the confirm button `ar-btn ar-btn-secondary`;
  - (c) after a receipt, clicking "?" starts a fresh chat (today `openChat()` without a charge would reopen the receipt);
  - (d) closing the chat returns focus to the "?" button;
  - (e) opening from a charge after a general chat shows `chatHello` and the normal button order;
  - (f) `newReport()` keeps general mode; `reset()` turns it off.
- [ ] **Step 2:** `npx ng test --watch=false` → 6 failures (`help-fab` not found first).
- [ ] **Step 3: implementation.**

  `customer.page.ts`:

```ts
/** The chat was opened from the "?" entry: no charge is preselected and "I can't find it" is the primary action. */
readonly general = signal(false);
/** The customer's first name for the guide's greeting. */
readonly firstName = computed(() => this.card()?.first_name || this.displayName());

openChat(transactionId?: string, general = false): void {
  this.opener = …;  // unchanged
  const restart = (!!transactionId || general) && !this.busy() && !this.frozen() && (this.chatStep() === 'receipt' || this.chatStep() === 'ended');
  this.general.set(general);  // before clearChat(), which picks the greeting from it
  if (restart) { this.clearChat(); this.chatPanel()?.nativeElement.focus(); }
  else if (general && this.chatStep() === 'describe' && this.log().length === 1) this.log.set([{ from: 'bot', key: 'chatHelloGeneral' }]);
  this.chatOpen.set(true);
  …  // the transactionId branch unchanged
}

/** Guide lines are i18n keys; the greeting carries the customer's first name. */
lineText(line: ChatLine): string {
  return 'key' in line ? this.t()[line.key].replace('{name}', this.firstName()) : line.text;
}
```

  `clearChat()`: `this.log.set([{ from: 'bot', key: this.general() ? 'chatHelloGeneral' : 'chatHello' }])`. `reset()` (another customer signs in): `this.general.set(false)`. The chat-log `<li>` uses `{{ lineText(line) }}` instead of the inline ternary. On the choose step:

```html
<button type="button" [class]="general() ? 'ar-btn ar-btn-secondary' : 'ar-btn'" (click)="frozen() ? run() : confirmCharge()" …>{{ … chatConfirmCharge }}</button>
<button type="button" [class]="general() ? 'ar-btn' : 'ar-btn ar-btn-secondary'" (click)="frozen() ? run() : cannotFind()" …>{{ … chatCannotFind }}</button>
```

  The button, last child of `<main class="home-main">` (so it is inert with the page when the chat dialog is open at narrow widths):

```html
<button type="button" class="help-fab" (click)="openChat(undefined, true)" [attr.aria-label]="t().help" [attr.aria-controls]="chatOpen() ? 'intake-chat' : null" [disabled]="!!frozen()">?</button>
```

  `customer.page.css`:

```css
.help-fab { position: fixed; right: 24px; bottom: 24px; z-index: 19; width: 48px; height: 48px; border-radius: 50%; background: var(--accent); color: var(--on-accent); font: 600 20px/48px var(--font-sans); border: var(--hairline) solid var(--accent-strong); cursor: pointer; }
.help-fab:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
```

  (Every token exists in `styles.css :root`; there is no shadow token. The chat panel sits at `bottom: 84px`, so the two never overlap.)

  Strings:

| key | es | pt | en |
|---|---|---|---|
| `help` | Ayuda | Ajuda | Help |
| `chatHelloGeneral` | ¿Cómo te ayudamos hoy, {name}? Si es un cargo que no ves en tu lista, cuéntanos el comercio, el monto y la fecha aproximada. Después revisas tus cargos y, si no está, una persona lo revisa contigo. | Como podemos ajudar hoje, {name}? Se for uma cobrança que você não vê na sua lista, conte o estabelecimento, o valor e a data aproximada. Depois você revisa suas cobranças e, se não estiver lá, uma pessoa analisa com você. | How can we help you today, {name}? If it's a charge you don't see in your list, tell us the merchant, the amount and the approximate date. Then you check your charges and, if it isn't there, a person reviews it with you. |

- [ ] **Step 4: green.** `npx ng test --watch=false` → +6. The focus spec covers the return of focus; at 390 px nothing overlaps or scrolls sideways.
- [ ] **Step 5: commit** `feat(client): a "?" help entry for charges that aren't in the list`.

**Acceptance:** the Target screen and button order; the greeting names the customer; after a receipt the "?" starts fresh; a chat from a charge is unchanged; focus returns to "?". **Edge cases:** `{name}` falls back to the display name when the card has no first name; a general chat whose customer then spots the charge can confirm it (the swapped classes change emphasis, not behaviour); the "?" is disabled while a request is frozen, like the other entry.

### Task H.2: the fraud note and docs

- [ ] `Docs/deliverables/SYSTEM_DESIGN.md`, solution section, two sentences: the "?" entry lets a customer report a charge they don't see; because no charge the customer owns is confirmed, nothing automated happens and a person reviews the handoff (ADR-002; problem statement p. 3, "a case requiring human intervention"). `back-end/README.md` intake section: "The general entry uses the same `POST /intake/start`; nothing new is deployed." Commit `docs: the help entry and its human-only ending`.

**Human steps before merge (H):** merge S first (the cascade retargets H); review and merge.

---

## 4. Verification on the live site

After each deploy, a person (or the orchestrator with `curl` where no token is needed). `BASE=https://factored-hackathon-2026-arabicaai.lucas-tramonte.workers.dev`.

| Check | Command or action | Expected |
|---|---|---|
| The new build is live | `curl -s -X POST $BASE/demo/agent-session` | `422 {"detail":"Provide the sign-in token"}` (unchanged), and after R: `curl -s -X POST $BASE/transactions/displayed` → `401` |
| Admin sign-in (R) | sign in at `/` with an `admin` email | the greeting plus the grey banner "administración · evaluación"; `/agent` sign-in works and shows its banner |
| Customer only (R) | sign in at `/agent` with a `customer`-only email | "Este correo no es de un agente de la demo" (the 403 mapping) |
| Unknown email (R, point 4) | type `nobody@example.com` at `/` | "No pudimos enviar un código a ese correo" (never "does not exist") |
| Reason stored (S) | report a charge with "Me cobraron dos veces"; open `/agent` | the row shows `me cobraron dos veces`; the detail has "Motivo: Me cobraron dos veces" |
| Lost card (S) | report a 29.90 charge with "Perdí la tarjeta…"; confirm | the guide line about calling the bank appears at once; the receipt says "Prioridad alta" with the demo number; the row heads the queue |
| Help entry (H) | press "?"; describe; send; "No encuentro el cargo"; answer | the receipt kind is `incompleto`; the agent queue shows it as `incompleto` |
| Events unchanged (S) | a person: `cd back-end && node scripts/export-intake-events.mjs --remote --max-pages 100 --output ../data/intake-events/check.jsonl` | the export validates; `grep -c reason ../data/intake-events/check.jsonl` → `0` |

## 5. Risks and limits (state them in the PRs)

- Urgency is policy, not a learned signal: five fixed amounts, a relative rule, and now one reason (DF-024).
- The reasons are authored for the demo; their share in real traffic is unknown (DF-001). They are a product hypothesis to validate with real statements.
- The banner is tab-scoped state, like the sign-in; a reload drops both.
- Evaluators' notification emails need an SES verification click or production access; sign-in codes do not.
- `0016` must be applied to remote D1 before the S merge deploys, or the deploy guard blocks every build (as on 2026-10-01).
- S.1 has a one-step intermediate state where every start body is 422; the two-commit split keeps the feature diff readable, not the intermediate state green.

## 6. Order

| When | What | Who |
|---|---|---|
| Oct 3 morning | S.0; R.1–R.4 and S.1–S.3 in parallel on their two branches | agents |
| Oct 3 midday | H.1–H.2 | agents |
| Oct 3 | PRs reviewed; 0016 and the seed to remote D1; enrol Manoella and the evaluators (emails needed) | team |

Skipped on purpose: admin-only routes (nothing needs one; the banner and the two views are the deliverable); a roles column in `sessions` (the token decides at sign-in, the client only shows); a banner component (one `@if` per page); a help menu with several options (ask 6 is one action; add options when asked); exporting `reason` in events (contract v2 stays frozen for the scorer); a reason classifier (no model online, ADR-002).
