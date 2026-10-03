# Roles, report reasons and the help entry: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every agent works in **ponytail ultra** (AGENTS.md, "Agent orchestration"): reads `AGENTS.md` and every file it touches in full, uses what exists before writing, makes the smallest change that works, and asks the orchestrator instead of guessing. One coder per task, then a spec QA agent, then a quality QA agent (three rounds at most).

**Goal:** six product asks, end to end:

1. Evaluators are administrators, and the client shows a banner saying so.
2. Roberto, Lucas, Manoella and the evaluators have admin, customer and agent access.
3. Customers have customer access only.
4. Any email that is not enrolled has no access.
5. The report asks *why* the customer doesn't recognise the charge, with options grounded in how Nubank segments disputes and in what our data can support, without slowing the report down.
6. A "?" help entry ("How can we help you today, {name}?") lets a customer report a charge that isn't in their list; that path can only end with a person.

**Architecture:** no new runtime, no model call, one additive migration. Roles stay Cognito groups verified by the Worker (ADR-007); `admin` becomes a superset of `customer` and `agent` in one helper, and the three session responses return the verified roles so the client can show a banner for the life of the tab. The reason is one new column on `intake_episodes`, one required field on `POST /intake/start`, part of the start's idempotency hash, one clause in the urgency policy, and one chip in the agent view. The help entry is client-only: it opens the existing guided chat without a preselected charge, so the only possible endings are the existing incomplete handoff (a person reviews it) or a confirmed charge the customer owns.

**Tech stack:** Cloudflare Worker + D1 (JavaScript, `node --test`, local D1 through `test/run-local.mjs`), Angular 20 signals (Jasmine/Karma specs), Amazon Cognito groups, the stdlib-only Python seed generator (`pytest`).

**Sources:** problem statement pp. 3 and 5 (a case requiring human intervention; permissions enforced outside model output); ADR-002 (a handoff is not a resolution; nothing blocks a card); ADR-007 (Cognito groups `customer`, `agent`, `admin`, `auditor`; admin-only enrolment); DATA_QUALITY DF-001, DF-024, DF-025; `Docs/intake/intake-events.md`; André's and Diego's feedback (speed, no twenty questions, make the intelligence visible).

---

## 1. Facts this plan rests on

Verified on `main` 8db96ad (2026-10-03) and re-checked by a plan reviewer. Coders rely on these; if one turns out wrong, stop and ask.

**Roles and sessions**
- `verifyIdToken` returns `{ sub, email, groups, customerId }`; `groups` is `cognito:groups` filtered to strings, `customerId` is `custom:customer_id` when it matches `CUSTOMER_ID` (`back-end/src/auth/cognito.js`). `bearerClaims` wraps it: 422 without a well-formed token, 401 on verification failure, 503 when the JWKS is down.
- `POST /auth/session` (`modules/customer/routes.js:startEmailSession`) requires `claims.groups.includes('customer')` **and** `store.customerSource(customerId)` truthy, else 403 `This account is not enrolled in the demo`. Body `{ customer_id, mode: 'email_otp', context_card }`.
- `POST /demo/session` (`startCustomerSession`, local picker, `DEMO_PICKER=1` only) returns `{ customer_id, mode: 'simulated_login', context_card }`.
- `POST /demo/agent-session` (`modules/agent/routes.js:startAgentSession`) requires `groups.includes('agent')`, else 403 `This account is not an agent in the demo`; locally without a token it is the one-click session. Body `{ role: 'agent', mode }`.
- `router.js` exports `ROLES = ['public','customer','agent','admin','auditor']` and `ROUTE_ROLES`; no route has role `admin` or `auditor`. `router.js` imports the route modules, which import `cognito.js`: **`cognito.js` must not import `router.js`** (a cycle hits the temporal dead zone at load).
- `sessions.actor` is `customer | agent` (`0001_intake.sql`), `auth_events.actor` too (`0012_auth_audit.sql`); admin needs no change there: an admin gets a *customer* session cookie on the customer view and an *agent* session cookie on the agent view, like today.
- Tests that pin today's rule, to be flipped not bypassed: `back-end/test/unit/email-session.test.js` line ~120 asserts `['admin','auditor']` → 403 on the agent session; lines ~113 and ~145 `deepEqual` the agent body `{ role, mode }`; line ~35 `deepEqual`s the customer body. `AGENTS.md` line 46 states the rule in words ("signs in only a `customer`-group user whose id is loaded in D1").
- The contract (`front-end/contracts/intake-api.schema.json`) has **three** session definitions, all `additionalProperties: false`: `customerSession` (local picker), `emailSession` (`/auth/session`) and `agentSession`. The contract has response definitions only; there are no request schemas.
- Client state is **tab-scoped and in memory**: `CustomerService.client` and `card` are signals (`customer.service.ts`); `resume()` runs only while `client` is set; `AgentService` keeps no state and `signIn` returns `void`. A banner therefore lives as long as the sign-in does and is gone on reload, exactly like the signed-in view itself.
- The spec spies: `customer.page.spec.ts` builds `jasmine.createSpyObj<CustomerService>(…, { client: signal(''), card: signal(null) })` once; `customer.page.focus.spec.ts` builds it three times (lines 11, 38, 63); `agent.page.spec.ts` spies `AgentService` with `['signIn','intakes','intakeDetail','setStatus']`.
- Point 4 is already true server-side: the pool is `AllowAdminCreateUserOnly=true` with `--prevent-user-existence-errors ENABLED` (`scripts/cognito/setup.sh:19,39`). An unknown email cannot request a code; Cognito answers a generic error that the client maps to 401 (`core/auth/cognito.service.ts:15`) and shows as "could not send the code", never saying whether the address exists. A verified token without `customer` or without a loaded D1 customer gets 403 and no cookie. This plan adds **tests and documentation** for that, not code.
- Enrolment: `back-end/scripts/cognito/enroll.sh <email> <customer_id|-> [group]`, one group per call, groups are additive, `custom:customer_id` is immutable. Roberto → `demo-ana`; Lucas → `demo-bruno` (`lucastramonte3@gmail.com`). Manoella and the evaluators have no identity yet.
- Fictitious identities: customers come from `back-end/src/config/identities.json` (`{customer_id, display_name, source}`), charges from `back-end/seeds/fictitious.json` (`{transaction_id, customer_id, occurred_at, merchant_name, amount, currency}`; today 6 rows, `demo-tx-001`…`006`, all BRL). `python -m data_pipelines.gold.fictitious_seed` renders `back-end/seeds/seed_fictitious.sql` (generated, do not edit). `data_pipelines/gold/test_fictitious_seed.py` fails when the committed SQL drifts from the generator **and** asserts the exact customer list after loading, so it changes too.
- SES is in sandbox: report emails reach only verified addresses. Sign-in codes come from Cognito and reach any enrolled email.

**The guided report**
- Client steps (`customer.page.ts`): `describe` (report language radios + statement) → `choose` (own charges, preselected when opened from a charge; "I can't find the charge") → `details` (one extra turn) → `receipt`. `send()` freezes `{ customer_statement, idempotency_key, language, mode: 'guided', report_type: 'unrecognized_charge' }`; `clearChat()` resets every chat signal and the log to `[{ from: 'bot', key: 'chatHello' }]`; `openChat(transactionId?)` restarts a finished chat **only when a charge is given**; the FAQ is a `faqs` list of link buttons.
- `POST /intake/start` (`intake/validation.js`) accepts exactly `KEYS = 'customer_statement,idempotency_key,language,mode,report_type'`; 17 back-end test files, 2 client specs, `customer.page.ts` and `intake.model.ts` carry that exact body (`git grep -l report_type back-end/test front-end/src`). `customer.page.spec.ts` line ~331 asserts the exact key list.
- `store.startIntake` (`d1.js` ~136-168) inserts the episode and hashes `[language, statement]` as `payload_hash` for idempotency; a replay with the same key and a different hash is a 409.
- Urgency is decided in `intake/routes.js` (~line 100): `urgencyOf(evidence, others, URGENCY)` from `intake/urgency.js` (pure: fixed tier per currency, or above the customer's own p95 with ≥ 5 peers), only when `kind === 'complete'`; `d1.js` ~82 forces `normal` for other kinds. `URGENCY` is `config/urgency.json` = `{ fixed: {MXN, COP, ARS, USD, BRL: 2500}, relative_min_others: 5, demo_block_line }`. The receipt carries `block_card_line` only when urgency is high. The client has the words `blockCardCall` and `blockCardNote` (`lang.service.ts:36`) but not the number.
- `store.findIntake(customerId, episodeId)` loads the episode row the handoff route uses (`episode.customer_statement`, `episode.state`, `episode.usage_json`); the coder confirms it selects `*` so `episode.reason` is available.
- Agent list: `d1.js:listIntakeHandoffs` selects explicit columns from `intake_handoffs h JOIN intake_episodes e`; the route passes rows through. Agent detail: `d1.js:findIntakeHandoff` selects explicit columns; `agent/routes.js:getAgentIntakeDetail` builds the body explicitly. Contract `agentIntake` and `agentIntakeDetail` are `additionalProperties: false`.
- `ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT … CHECK` has precedent in `0013_urgency.sql`; `test/unit/intake-storage.test.js` applies every migration file automatically; `data_pipelines/gold/intake_slice.py:MIGRATIONS` does the same for the seed test.
- Events: `reason` will not be an event field, so `intake-events.md` v2, the export allowlist and the scorer are untouched.

**Why the reasons are authored**
- `fact_complaints.subcategory` has five values (`Cargo no reconocido`, `Cobro indebido`, `Problema con app`, `Atención en sucursal`, `Calidad de servicio`) and only the first is ours; `description` is one template per subcategory (DF-001); dispute outcomes are templates with no transaction link (DF-025). Nothing in the data says *why* a customer didn't recognise a charge. So the options are authored, following the segmentation Nubank's app applies to a disputed card purchase (first "did you make this purchase?", then: not recognised, charged twice, a different amount, cancelled or not received, a subscription that keeps charging, card lost or stolen). ADR-010 records that they will be re-cut when real statements exist. What our data does support is the amount-tier urgency policy (DF-024), which the reasons extend by one clause.

**i18n and design system**
- Every string exists in es, pt and en in `front-end/src/app/shared/i18n/lang.service.ts`; `Strings` is keyed on the Spanish object, so a missing key fails the build. `LangService.lang()` is the interface language; the report language is `reportLang()` on the page. Prefilled statements must follow the **report** language.
- Chips are `.ar-chip` with `-ok/-warn/-err` variants and radios are `.ar-check` (`front-end/src/styles.css:135-146`). The chat panel is fixed at `right: 24px; bottom: 84px` (`customer.page.css:4`). `narrow()` is the 1180 px layout switch at which the open chat makes the page inert.

---

## 2. Branches, PRs and who reviews

| Part | Branch | Base | Label | Reviewer |
|---|---|---|---|---|
| R: roles, admin banner, evaluator identities | `feat/admin-roles` | `main` | `enhancement` | Lucas (auth) |
| S: report reasons | `feat/report-reasons` | `main` | `enhancement` | Manoella (product) |
| H: the "?" help entry | `feat/help-entry` | `feat/report-reasons` | `enhancement` | Manoella |

R and S share only `lang.service.ts` and `intake.model.ts` (additions at different keys; the cascade merges them). Every PR: `--assignee @me`, label, reviewer, tests listed with counts, and a closing **"Human steps before merge"**. Agents never tag, merge, deploy, run `--remote`, or change a real person's Cognito groups without the orchestrator's go.

## 3. File map

| File | Part | Responsibility |
|---|---|---|
| `back-end/src/auth/cognito.js` | R | `hasRole(groups, role)` and `rolesOf(groups)`; no import from `router.js` |
| `back-end/src/modules/customer/routes.js`, `modules/agent/routes.js` | R | use `hasRole`; `roles` on the three session bodies |
| `front-end/contracts/intake-api.schema.json` | R, S | `roles` on `customerSession`, `emailSession`, `agentSession`; `reason` on `agentIntake`, `agentIntakeDetail` |
| `back-end/test/unit/email-session.test.js` | R | flipped and extended sign-in tests (the access matrix) |
| `front-end/src/app/features/customer/customer.service.ts`, `features/agent/agent.service.ts` | R | a `roles` signal next to `client`; `AgentService.signIn` returns the body |
| `customer.page.{ts,html,css}`, `agent.page.{ts,html,css}`, `lang.service.ts`, `shared/models/intake.model.ts`, the page specs | R | inline banner on each page; spies gain `roles` |
| `back-end/src/config/identities.json`, `back-end/seeds/fictitious.json`, `seed_fictitious.sql`, `data_pipelines/gold/test_fictitious_seed.py` | R | four evaluator identities with charges |
| `Docs/ADRs/ADR-007-…md` (Proposed, editable), `back-end/README.md`, `AGENTS.md` line 46 | R | decision 8, the access matrix, the enrolment runbook |
| `back-end/migrations/0016_report_reason.sql` | S | `intake_episodes.reason` |
| `back-end/src/modules/intake/validation.js`, `intake/routes.js`, `store/d1.js`, `agent/routes.js`, `config/urgency.json` | S | `REASONS`; required field; stored; hashed; urgency clause; returned to agents |
| `customer.page.{ts,html}`, `styles.css`, `lang.service.ts`, `intake.model.ts`, `customer.service.spec.ts`, page specs | S | reason chips + prefilled statement + lost-card line |
| `agent.page.{ts,html}`, `lang.service.ts`, `intake.model.ts`, `agent.page.spec.ts` | S | reason chip in the queue and the detail |
| `Docs/ADRs/ADR-010-report-reasons-and-help-entry.md`, `Docs/ADRs/README.md`, `Docs/intake/intake-events.md`, `Docs/deliverables/DATA_QUALITY.md` (DF-024) | S, H | the product decision; "stored, not exported"; the urgency clause |
| `customer.page.{ts,html,css}`, `lang.service.ts`, page specs | H | the "?" button and the general chat mode |
| `Docs/deliverables/SYSTEM_DESIGN.md` | H | two sentences on the help entry and its human-only ending |

---

## Part R: roles, the admin banner and evaluator access

### Task R.1: `admin` is a superset; sessions return the verified roles (Worker)

**Files:** modify `back-end/src/auth/cognito.js`, `back-end/src/modules/customer/routes.js`, `back-end/src/modules/agent/routes.js`, `front-end/contracts/intake-api.schema.json`, `back-end/test/unit/email-session.test.js`, `back-end/test/unit/contract.test.js` (its `session()` helper, line ~28, builds `{ customer_id, mode, context_card }` and expects it to pass `customerSession`: add `roles: ['customer']` to it, or making `roles` required breaks that test).

- [ ] **Step 1: tests first** (`email-session.test.js`). Read the whole file. Then:

  (a) In the first customer test, the expected body becomes `{ customer_id: 'demo-ana', mode: 'email_otp', context_card: null, roles: ['customer'] }`.

  (b) Add, after it:

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

  (c) In the agent block: the two `deepEqual`s on the agent body gain `roles: ['agent']` (token) and `roles: ['agent']` (local one-click). The 403 loop drops `['admin','auditor']` and keeps `[['customer'], [], ['auditor'], ['Agent']]`. Add:

```js
test('an admin token gets an agent session too', async () => {
  const r = await agent('Bearer ' + jwt, async () => ({ ...claims, groups: ['admin'], customerId: null }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { role: 'agent', mode: 'email_otp', roles: ['admin'] });
  assertContract('agentSession', r.body);
});
```

- [ ] **Step 2:** `cd back-end && npm run test:unit` → the edited and new tests fail (`roles` missing; 403 where 200 is expected).

- [ ] **Step 3: implementation.** In `cognito.js`, after `verifyIdToken`:

```js
const GRANTED = ['customer', 'agent', 'admin', 'auditor'];
/** The verified groups that are roles, in a fixed order. ``admin`` is listed as itself; ``hasRole`` makes it imply the rest. */
export const rolesOf = groups => GRANTED.filter(r => groups.includes(r));
/** ``admin`` may do anything a customer, agent or auditor may (ADR-007, decision 8). */
export const hasRole = (groups, role) => groups.includes(role) || groups.includes('admin');
```

  `customer/routes.js`: import `hasRole, rolesOf`; in `startEmailSession` replace `!claims.groups.includes('customer')` with `!hasRole(claims.groups, 'customer')` and add `roles: rolesOf(claims.groups)` to the body; in `startCustomerSession` add `roles: ['customer']`. `agent/routes.js`: import them. `signedIn` is a `const` inside `if (!local)`, so hoist the roles:

```js
let roles = ['agent'];
if (!local) {
  const signedIn = await bearerClaims(request, env, verify);
  if (signedIn.error) return signedIn.error;
  if (!hasRole(signedIn.claims.groups, 'agent')) return fail(403, 'This account is not an agent in the demo');
  roles = rolesOf(signedIn.claims.groups);
}
return json({ role: 'agent', mode: local ? 'simulated_login' : 'email_otp', roles }, 200, { 'Set-Cookie': await startSession(request, store, 'agent') });
```

  Update the three docstrings in one clause each.

  Contract: add to `customerSession`, `emailSession` and `agentSession` (`required` and `properties`):

```json
"roles": { "type": "array", "uniqueItems": true, "items": { "enum": ["customer", "agent", "admin", "auditor"] } }
```

- [ ] **Step 4:** `npm run test:unit` green. Then `mkdir -p public && node test/run-local.mjs; rmdir public` (the "pages are public" test fails without a client build; nothing else may). The gate matrix in `adversarial.test.js` already covers both session routes for method and path; the budget suite is unaffected (no new query).

- [ ] **Step 5:** `git add back-end/src/auth/cognito.js back-end/src/modules/customer/routes.js back-end/src/modules/agent/routes.js back-end/test/unit/email-session.test.js back-end/test/unit/contract.test.js front-end/contracts/intake-api.schema.json && git commit -m "feat(auth): admin implies customer and agent; sessions return the verified roles"` (trailer per the repo rule).

### Task R.2: the banner (client)

**Files:** modify `front-end/src/app/features/customer/customer.service.ts`, `features/agent/agent.service.ts`, `features/customer/customer.page.{ts,html,css}`, `features/agent/agent.page.{ts,html,css}`, `shared/i18n/lang.service.ts`, `shared/models/intake.model.ts`; specs `customer.service.spec.ts`, `agent.service.spec.ts`, `customer.page.spec.ts`, `agent.page.spec.ts`, `customer.page.focus.spec.ts`.

  **Who owns the state.** Customer side: `client` and `card` are signals on `CustomerService` that the **page** sets in `enter()` (`customer.page.ts` ~282) and clears in `reset()` (~534); the service never sees the session body. `roles` follows that exactly: a `roles` signal on the service, written by the page in `enter()` and cleared in `reset()`. Setting it inside the service would leak another customer's roles on the `errOtherCustomer` path (~267-279). Agent side: the service keeps no state, so the **page** owns `readonly roles = signal<Role[]>([])`, set from the body that `AgentService.signIn` now returns; no service signal.

- [ ] **Step 1: failing specs.**
  - `agent.service.spec.ts`: `signIn('id.token')` resolves to the body.
  - `customer.page.spec.ts`: after `enter()` with a session `{ …, roles: ['admin'] }` the spy's `roles` signal holds `['admin']` and the home step renders `aside.role-banner[role=status]` containing `t().adminChip` and a link to `/agent`; with `['customer']` no `.role-banner` exists; `reset()` (sign in as another customer) clears it. The `createSpyObj` in `customer.page.spec.ts` (1) and all **six** in `customer.page.focus.spec.ts` (lines 11, 38, 63, 88, 186, 212; they are untyped, so a missing `roles` makes the template throw) gain `roles: signal([])`.
  - `agent.page.spec.ts`: with the spy's `signIn` resolving `{ role: 'agent', mode: 'email_otp', roles: ['admin'] }`, the page renders `.role-banner` with a link to `/`; with `roles: ['agent']` it does not.
- [ ] **Step 2:** `cd front-end && npx ng test --watch=false` → fail.
- [ ] **Step 3: implementation.**

  `intake.model.ts`:

```ts
export type Role = 'customer' | 'agent' | 'admin' | 'auditor';
export interface CustomerSession { customer_id: string; mode: 'simulated_login' | 'email_otp'; context_card?: ContextCard | null; roles: Role[]; }
export interface AgentSession { role: 'agent'; mode: 'simulated_login' | 'email_otp'; roles: Role[]; }
```

  `customer.service.ts`: `readonly roles = signal<Role[]>([]);` next to `client`. `customer.page.ts`: in `enter()` the body is bound to `s` (~266; `session` there is the callback), so next to `this.client.set(s.customer_id)` (~283) write `this.service.roles.set(s.roles)`; in `reset()`, `this.service.roles.set([])`; `readonly roles = this.service.roles;`. `agent.service.ts`:

```ts
signIn(idToken?: string): Promise<AgentSession> {
  return this.api.request<AgentSession>('/demo/agent-session', {}, idToken ? { Authorization: 'Bearer ' + idToken } : {});
}
```

  `agent.page.ts`: `readonly roles = signal<Role[]>([]);` and in `enter()` the `start` callbacks become `async () => this.roles.set((await this.service.signIn(token?)).roles)`. Do **not** clear it in `reset()`: `refresh()` is `enter(async () => undefined)`, which calls `reset()` and never re-signs in, so the banner would vanish on Refresh. Clear it in `fail()`'s 401 branch (~238-242), next to the existing `this.reset()`.

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

  CSS, once per page file (or once in `styles.css` as `.role-banner` if both pages share it; prefer `styles.css`): `display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 16px; border-radius: var(--radius-md); background: var(--surface-sunken); color: var(--ink-muted); font: 400 14px/20px var(--font-sans);` and `.role-banner a { color: var(--link); font-weight: 500; }`. Tokens only; no new colours.

  Strings, next to `agentView`:

| key | es | pt | en |
|---|---|---|---|
| `adminChip` | administración · evaluación | administração · avaliação | admin · evaluation |
| `adminOnCustomer` | Eres administrador/a de la demo. Esta es la experiencia del cliente; en la vista de agente revisas los reportes que llegan. | Você é administrador/a da demo. Esta é a experiência do cliente; na visão do agente você analisa os relatos que chegam. | You are a demo administrator. This is the customer experience; the agent view is where incoming reports are reviewed. |
| `adminOnAgent` | Eres administrador/a de la demo. Esta es la vista de agente; vuelve a la vista de cliente para reportar un cargo. | Você é administrador/a da demo. Esta é a visão do agente; volte à visão do cliente para relatar uma cobrança. | You are a demo administrator. This is the agent view; go back to the customer view to report a charge. |

- [ ] **Step 4:** `npx ng test --watch=false` green; `npm run build` compiles; at 390 px width the banner wraps with no horizontal scroll.
- [ ] **Step 5:** commit `feat(client): administrators see an evaluation banner on both views`.

### Task R.3: four evaluator identities

**Files:** modify `back-end/src/config/identities.json`, `back-end/seeds/fictitious.json`, `data_pipelines/gold/test_fictitious_seed.py`; regenerate `back-end/seeds/seed_fictitious.sql`.

- [ ] **Step 1:** add to `identities.json` `customers`, after Bruno: `demo-carla` "Carla (demo)", `demo-diego` "Diego (demo)", `demo-elena` "Elena (demo)", `demo-marco` "Marco (demo)", all `"source": "fictitious"`. Update the drift test (`test_fictitious_seed.py`): the expected customer list (~line 30) and the transaction count `(6,)` → `(26,)` (~line 32); run it first to see it fail.
- [ ] **Step 2:** add 20 charges to `fictitious.json` (`demo-tx-007`…`026`, BRL like the existing rows, dates 2026-09-22 to 2026-09-30). Each identity gets the same five shapes so every evaluator can try every reason: a normal purchase; a pair with the same merchant and amount one minute apart ("charged twice"); a small recurring-looking charge ("subscription"); one amount at or above the BRL fixed tier of `config/urgency.json` (2,500.00) so the urgency lane shows. For example Carla: `Mercado Demo 142.80`, `Restaurante Demo 96.00` ×2 (14:10 and 14:11), `Streaming Demo 29.90`, `Viagens Demo 2890.00`. Vary merchants and amounts per identity; keep amounts as strings with two decimals.
- [ ] **Step 3:** `.venv/bin/python -m data_pipelines.gold.fictitious_seed` → "Wrote back-end/seeds/seed_fictitious.sql"; `git diff --stat` shows only additions in the SQL; `.venv/bin/python -m pytest data_pipelines/gold -q` green.
- [ ] **Step 4:** `cd back-end && npm run test:unit && (mkdir -p public && node test/run-local.mjs; rmdir public)`. `budget.test.js` pins `identities: [1, 12, 0, 1]` (rows read = the customers table); with four more customers it becomes 16: pin the measured value and say so in the commit body (no code path changed).
- [ ] **Step 5:** commit `data(seed): four fictitious evaluator identities with charges for every reason`.

### Task R.4: docs and the enrolment runbook

**Files:** `Docs/ADRs/ADR-007-customer-identity-cognito-email-otp.md`, `back-end/README.md`, `AGENTS.md` (line 46), `back-end/scripts/cognito/enroll.sh` header.

- [ ] ADR-007, Decision, new point 8: "**`admin` is a superset.** An admin token may start a customer session (with its own `custom:customer_id`, which must be loaded) and an agent session. `auditor` stays reserved. Both session responses list the verified roles, and the client shows an evaluation banner when they include `admin`. Tests: `back-end/test/unit/email-session.test.js`." Implementation notes: the enrolment commands below.
- [ ] `AGENTS.md` line 46: "`POST /auth/session` signs in only a `customer`- or `admin`-group user whose id is loaded in D1".
- [ ] `back-end/README.md`, new "Access" section:

| Who | Cognito groups | Customer view | Agent view | Banner | Test |
|---|---|---|---|---|---|
| Customer | `customer` + a loaded `custom:customer_id` | yes | no (403) | no | `email-session.test.js`: "any other group is one 403" |
| Agent | `agent` | no (403) | yes | no | "a token without customer or admin … is 403" |
| Team and evaluators | `admin` + a loaded `custom:customer_id` | yes | yes | yes | "an admin … is also a customer"; "an admin token gets an agent session too" |
| Anyone else | not enrolled | no code is sent (Cognito's generic answer; the client says "could not send") | same | — | `cognito.test.js` / `cognito.service.spec.ts` 401 mapping |

  Add: "The sign-in never reveals whether an address exists (`prevent-user-existence-errors`)."
- [ ] `enroll.sh` header: "Admins: `enroll.sh <email> <customer_id> admin` (an admin also needs a customer id to use the customer view)."
- [ ] Commit `docs(auth): admin role, access matrix and enrolment runbook`.

**Human steps before merge (R):**
1. Lucas agrees to ADR-007 decision 8 in the PR.
2. Load the new identities into remote D1 **before** anyone is enrolled on them: `cd back-end && npx wrangler d1 execute arabica-intake-demo --remote --file seeds/seed_fictitious.sql` (idempotent upserts). Say so in the PR.
3. Enrol after the merge is deployed (the banner must exist). `enroll.sh` adds a group and keeps the existing ones:
   ```sh
   sh back-end/scripts/cognito/enroll.sh rzuniga@aptsny.co demo-ana admin
   sh back-end/scripts/cognito/enroll.sh lucastramonte3@gmail.com demo-bruno admin
   sh back-end/scripts/cognito/enroll.sh <manoella's email> demo-carla admin
   sh back-end/scripts/cognito/enroll.sh <evaluator 1> demo-diego admin    # then demo-elena, demo-marco
   ```
   Needed from the team: Manoella's and the three evaluators' emails.
4. SES sandbox: an evaluator receives the report emails only after clicking a verification email (`aws sesv2 create-email-identity --email-identity <email> --profile arabica --region us-east-2`). The PR and the submission state that sign-in works for every enrolled email, and that notification emails need that verification or SES production access (denied once).

---

## Part S: why the customer doesn't recognise the charge

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

**Files:** create `back-end/migrations/0016_report_reason.sql`; modify `back-end/src/modules/intake/validation.js`, `back-end/src/store/d1.js`, `back-end/src/modules/intake/routes.js`, `back-end/src/modules/agent/routes.js`, `back-end/src/config/urgency.json`, `front-end/contracts/intake-api.schema.json`; tests `back-end/test/unit/validation.test.js`, `intake-storage.test.js`, `test/integration/intake.test.js`, `urgency.test.js`, `agent-intake.test.js`, and the `startBody` helpers in every test that posts `report_type` (`git grep -l report_type back-end/test`).

```sql
-- Why the customer doesn't recognise the charge (ADR-010). One closed list; the default keeps old rows valid.
ALTER TABLE intake_episodes ADD COLUMN reason TEXT NOT NULL DEFAULT 'not_mine'
  CHECK (reason IN ('not_mine','duplicate','wrong_amount','cancelled_or_not_received','subscription','card_lost_or_stolen','other'));
```

- [ ] **Step 1: failing tests.**
  - `unit/validation.test.js` today covers only `validateCaseRequest`; import `validateStartRequest, REASONS` from `../../src/modules/intake/validation.js` and add: without `reason` → `.error` `{status: 422, detail: 'Provide exactly the guided report fields'}`; `reason: 'nope'`, `'NOT_MINE'`, `1` → 422 `Choose one of the report reasons`; `reason: 'duplicate'` → `.value.reason === 'duplicate'`; and `REASONS` equals the quoted list inside `0016_report_reason.sql` (read the file, take the `CHECK (reason IN (...))` group with `/IN \(([^)]*)\)/`, then `/'([a-z_]+)'/g` on that group only, because the whole file also has `DEFAULT 'not_mine'`; compare arrays) so the two can't drift. `unit/intake.test.js` line ~70 (the invalid-body loop asserted by status) gains `{ ...body, reason: 'nope' }`.
  - `intake.test.js` (local D1): start with `reason: 'duplicate'` → 201, and `GET /agent/intake-detail` after the handoff shows `reason: 'duplicate'`; **a replay with the same key and `reason: 'other'` → 409** `Key already used with different content`; the queue row (`GET /agent/intakes`) carries `reason`; both responses pass `assertContract`.
  - `urgency.test.js` (integration): a confirmed charge below every threshold with `reason: 'card_lost_or_stolen'` → receipt `urgency: 'high'` with `block_card_line`, the row heads the queue, and `findEmails` shows one `received` template queued (the `urgent` paragraph is added at send time, so it is not stored; assert exactly what the existing high-amount test asserts); the same reason on an incomplete handoff → `normal`. `unit/urgency.test.js`: the policy test also asserts `config.high_reasons` deep-equals `['card_lost_or_stolen']`.
  - Update every `startBody` helper with `reason: 'not_mine'` so the 17 files keep passing; `intake.test.js`'s "wrong fields" loop gains `{ ...body, reason: 'nope' }`.
  Do the 17 `startBody` one-liners (`reason: 'not_mine'`) as a **separate first commit** (`test(intake): start bodies carry the reason`) so the feature diff stays readable; S.1 then touches about ten files.
- [ ] **Step 2:** `npm run test:unit` and the local run → fail on the new assertions only.
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

  `d1.js:startIntake`: take `reason`; `payloadHash = await tokenHash(JSON.stringify([language, statement, reason]))`; add `reason` to the INSERT column list and values. `listIntakeHandoffs` and `findIntakeHandoff`: select `e.reason`. `agent/routes.js:getAgentIntakeDetail`: `reason: row.reason` in the body (the list passes rows through already).

  `urgency.json`: `"high_reasons": ["card_lost_or_stolen"]`. `intake/routes.js` ~line 100:

```js
if (kind === 'complete') urgency = URGENCY.high_reasons.includes(episode.reason) ? 'high'
  : urgencyOf(evidence, (await store.listTransactions(customerId, 21).catch(() => [])).filter(t => t.transaction_id !== transactionId), URGENCY);
```

  (`urgencyOf` stays pure; its unit tests are untouched.) Contract: `agentIntake` and `agentIntakeDetail` gain required `"reason": { "enum": [the seven] }`.

- [ ] **Step 4:** `npm run test:unit && (mkdir -p public && node test/run-local.mjs; rmdir public)` green. `budget.test.js`: the start writes one more column in the same statement and the handoff reads a column it already loads, so no ceiling moves; if one does, pin the measured value and explain it in the commit.
- [ ] **Step 5:** commit `feat(intake): a report carries the reason the customer gives (migration 0016)`.

### Task S.2: one-tap reasons in the chat (client)

**Files:** modify `front-end/src/app/features/customer/customer.page.{ts,html}`, `front-end/src/styles.css`, `shared/i18n/lang.service.ts`, `shared/models/intake.model.ts`; specs `customer.page.spec.ts` (the exact-keys assertion at ~331 and the three start bodies), `customer.service.spec.ts`.

- [ ] **Step 1: failing specs** (`customer.page.spec.ts`, inside the existing guided-report describe):
  - (a) the describe step renders a `fieldset.chat-reasons` with seven radios named `reason`, legend `t().reasonLegend`, the first value `not_mine`, none checked;
  - (b) checking `duplicate` sets the statement textarea to the Spanish `reasonFillDuplicate` when the report language is `es`, and to the Portuguese one when the report language is `pt`;
  - (c) typing a custom statement, then checking another chip, leaves the typed text;
  - (d) Send with a statement but no reason shows `t().chatReasonValidation` and never calls `startIntake`;
  - (e) the start body keys are exactly `['customer_statement','idempotency_key','language','mode','reason','report_type']` and `reason` is the checked one;
  - (f) checking `card_lost_or_stolen` appends one guide line `chatLostCard` to the log, once;
  - (g) `newReport()` clears the reason and the prefill.
- [ ] **Step 2:** `npx ng test --watch=false` → fail.
- [ ] **Step 3: implementation.**

  `intake.model.ts`:

```ts
export const REASONS = ['not_mine', 'duplicate', 'wrong_amount', 'cancelled_or_not_received', 'subscription', 'card_lost_or_stolen', 'other'] as const;
export type Reason = typeof REASONS[number];
export interface IntakeStartBody { customer_statement: string; idempotency_key: string; language: IntakeLang; mode: 'guided'; report_type: 'unrecognized_charge'; reason: Reason; }
```

  `lang.service.ts`: add `stringsFor(lang: Lang): Strings { return STRINGS[lang]; }` (the prefill must follow the report language, not the interface).

  `customer.page.ts`:

```ts
/** Reason → its label and its one-line statement; the statement is filled in the report language. */
const REASON_LABEL = { not_mine: 'reasonNotMine', duplicate: 'reasonDuplicate', wrong_amount: 'reasonWrongAmount', cancelled_or_not_received: 'reasonCancelled',
  subscription: 'reasonSubscription', card_lost_or_stolen: 'reasonLostCard', other: 'reasonOther' } as const satisfies Record<Reason, keyof Strings>;
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

  In `send()`, before the length check: `if (!this.reason()) { this.chatError.set(this.t().chatReasonValidation); return; }`, and the body gains `reason: this.reason()!`. In `clearChat()`: `this.reason.set(null); this.prefill = '';`. If `other` is picked with an empty field, focus the statement (`afterNextRender`, the pattern already used for `detailsField`).

  `customer.page.html`, in the `describe` fieldset, between the language radios and the statement label:

```html
<fieldset class="chat-reasons"><legend class="ar-field-label">{{ t().reasonLegend }}</legend>
  @for (r of reasons; track r) {
    <label class="ar-chip-choice"><input type="radio" name="reason" [value]="r" [checked]="reason() === r" (change)="pickReason(r)" required><span>{{ t()[reasonLabel[r]] }}</span></label>
  }
</fieldset>
```

  `styles.css` (design system, next to `.ar-check`):

```css
.chat-reasons, .ar-chip-choices { display: flex; flex-wrap: wrap; gap: 8px; }
.ar-chip-choice { position: relative; } .ar-chip-choice input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
.ar-chip-choice span { display: inline-flex; padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; font: 500 14px/20px var(--font-sans); color: var(--ink); background: var(--surface); }
.ar-chip-choice input:checked + span { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-strong); }
.ar-chip-choice input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: 2px; }
```

  (Use the token names that exist in `styles.css :root`; if `--accent-soft` or `--focus` don't exist, use the ones the design system already uses for selected and focused states.)

  Strings (es / pt / en):

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

- [ ] **Step 4:** `npx ng test --watch=false` green; keyboard: Tab reaches the group, arrows move between chips, Space selects; at 390 px the chips wrap with no horizontal scroll; `npm run build` compiles.
- [ ] **Step 5:** commit `feat(client): one-tap reason prefills the report`.

### Task S.3: agents see the reason

**Files:** `front-end/src/app/features/agent/agent.page.{ts,html}`, `shared/i18n/lang.service.ts`, `shared/models/intake.model.ts`; spec `agent.page.spec.ts`.

- [ ] **Step 1: failing specs.** A queue row renders `span.reason-chip` with the reason's label; `card_lost_or_stolen` adds `ar-chip-err`; the detail `dl` has a row `t().reasonLabel` → label.
- [ ] **Step 2:** fail. **Step 3:** `AgentIntake` gains `reason: Reason`; the page exposes `reasonLabel = REASON_LABEL` (export it from `intake.model.ts` so both pages share it, with `import type { Strings } from '../i18n/lang.service'`, which creates no cycle because `lang.service` does not import the model). Row: `<span class="ar-chip reason-chip" [class.ar-chip-err]="item.reason === 'card_lost_or_stolen'">{{ t()[reasonLabel[item.reason]] }}</span>` after the kind chip. Detail: `<div><dt>{{ t().reasonLabel }}</dt><dd>{{ t()[reasonLabel[d.reason]] }}</dd></div>` before the language row. String `reasonLabel`: "Motivo" / "Motivo" / "Reason". Fixtures in `agent.page.spec.ts` gain `reason`.
- [ ] **Step 4:** specs green. **Step 5:** commit `feat(agent): the queue and the detail show the customer's reason`.
- [ ] **Docs:** `Docs/intake/intake-events.md`, guided-flow section, one sentence: "`reason` (ADR-010) is stored on the episode and shown to agents; it is not an event field, so the v2 contract and the export are unchanged." `DATA_QUALITY.md` DF-024 handling: "Since ADR-010, a confirmed charge reported as `card_lost_or_stolen` is also `high` (`config/urgency.json: high_reasons`)." Commit `docs(intake): the reason is stored, not exported; the urgency clause`.

**Human steps before merge (S):**
1. The three deciders agree to ADR-010 in the PR.
2. Remote migration 0016 before merge: `cd back-end && npx wrangler d1 time-travel info arabica-intake-demo && npx wrangler d1 migrations apply arabica-intake-demo --remote`; say so in the PR body (the deploy guard refuses to deploy otherwise).

---

## Part H: "How can we help you today, {name}?"

### Task H.1: the "?" button and the general chat (client)

**Files:** modify `front-end/src/app/features/customer/customer.page.{ts,html,css}`, `shared/i18n/lang.service.ts`; specs `customer.page.spec.ts`, `customer.page.focus.spec.ts`.

- [ ] **Step 1: failing specs.**
  - (a) on the home step, `button.help-fab` exists with `aria-label` `t().help` and the text "?", whether or not every charge has an open report;
  - (b) clicking it opens the chat with the first guide line equal to `t().chatHelloGeneral` with `{name}` replaced by the context card's first name (or the display name), no charge preselected, and on the choose step the "I can't find the charge" button has class `ar-btn` and the confirm button `ar-btn ar-btn-secondary` (today's classes swapped);
  - (c) after a receipt, clicking "?" starts a fresh chat (today `openChat()` without a charge would reopen the receipt);
  - (d) closing the chat returns focus to the "?" button (the existing `opener` mechanism);
  - (e) opening from a charge still shows `chatHello` and the normal button order;
  - (f) `newReport()` leaves general mode on; `clearChat()` from a charge opener turns it off.
- [ ] **Step 2:** fail. **Step 3: implementation.**

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

  `clearChat()`: `this.log.set([{ from: 'bot', key: this.general() ? 'chatHelloGeneral' : 'chatHello' }])`; `reset()` (another customer signs in) also `this.general.set(false)`. The chat-log `<li>` uses `{{ lineText(line) }}` instead of the inline ternary. On the choose step:

```html
<button type="button" [class]="general() ? 'ar-btn ar-btn-secondary' : 'ar-btn'" (click)="frozen() ? run() : confirmCharge()" …>{{ … chatConfirmCharge }}</button>
<button type="button" [class]="general() ? 'ar-btn' : 'ar-btn ar-btn-secondary'" (click)="frozen() ? run() : cannotFind()" …>{{ … chatCannotFind }}</button>
```

  The button, last child of `<main class="home-main">`:

```html
<button type="button" class="help-fab" (click)="openChat(undefined, true)" [attr.aria-label]="t().help" [attr.aria-controls]="chatOpen() ? 'intake-chat' : null" [disabled]="!!frozen()">?</button>
```

  `customer.page.css`: `.help-fab { position: fixed; right: 24px; bottom: 24px; z-index: 19; width: 48px; height: 48px; border-radius: 50%; background: var(--accent); color: var(--on-accent); font: 600 20px/48px var(--font-sans); border: var(--hairline) solid var(--accent-strong); cursor: pointer; } .help-fab:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }` (every token named exists in `styles.css :root`; there is no `--shadow-*` token, so no shadow; the chat panel sits at `bottom: 84px`, so the two never overlap).

  Strings:

| key | es | pt | en |
|---|---|---|---|
| `help` | Ayuda | Ajuda | Help |
| `chatHelloGeneral` | ¿Cómo te ayudamos hoy, {name}? Si es un cargo que no ves en tu lista, cuéntanos el comercio, el monto y la fecha aproximada. Después revisas tus cargos y, si no está, una persona lo revisa contigo. | Como podemos ajudar hoje, {name}? Se for uma cobrança que você não vê na sua lista, conte o estabelecimento, o valor e a data aproximada. Depois você revisa suas cobranças e, se não estiver lá, uma pessoa analisa com você. | How can we help you today, {name}? If it's a charge you don't see in your list, tell us the merchant, the amount and the approximate date. Then you check your charges and, if it isn't there, a person reviews it with you. |

  No server change: an unlisted charge can only become an incomplete handoff (`kind: 'incomplete'`, reviewed by a person, `routed` in events), and any confirmed charge is still checked for ownership by the Worker.

- [ ] **Step 4:** `npx ng test --watch=false` green; the focus spec covers the return of focus to the button; at 390 px nothing overlaps or scrolls sideways; the button is inert with the rest of the page while the chat dialog is open at narrow widths (it is inside `.home-main`, which already carries `[inert]`).
- [ ] **Step 5:** commit `feat(client): a "?" help entry for charges that aren't in the list`.

### Task H.2: the fraud note and docs

- [ ] `Docs/deliverables/SYSTEM_DESIGN.md`, solution section, two sentences: the "?" entry lets a customer report a charge they don't see; because no charge the customer owns is confirmed, nothing automated happens and a person reviews the handoff (ADR-002; problem statement p. 3, "a case requiring human intervention"). `back-end/README.md` intake section: "The general entry uses the same `POST /intake/start`; nothing new is deployed." Commit `docs: the help entry and its human-only ending`.

**Human steps before merge (H):** merge S first (the cascade retargets H); review and merge.

---

## 4. Verification on the live site (after each deploy, by a person or the orchestrator with curl)

- `POST /transactions/displayed` without a cookie → 401 (sanity: the Worker is the new build).
- Sign in as an admin: the banner shows on `/` and on `/agent`; sign in as a customer-only email: no banner, `/agent` sign-in says "not an agent".
- Report a charge with reason "charged twice": the receipt arrives; in the agent view the row shows the reason chip and the detail its label. Report with "card lost or stolen" on a small charge: the receipt is `high` with the block line, the row heads the queue.
- Press "?": the greeting names the customer; pick "I can't find the charge" → the receipt is incomplete; the agent view shows it as incomplete.
- `node scripts/export-intake-events.mjs --remote …` (a person) still validates: `reason` never appears in events.

## 5. Risks and limits (state them in the PRs)

- Five fixed tier amounts and one reason decide urgency; the reason clause is policy, not a learned signal (DF-024).
- The reasons are authored for the demo; their share in real traffic is unknown (DF-001).
- The banner depends on the sign-in response; a reload drops it with the view (tab-scoped state, like today).
- Evaluators' notification emails need an SES verification click or production access.
- `0016` must be applied to remote D1 before the S merge deploys, or the deploy guard blocks every build (as on 2026-10-01).

## 6. Order

| When | What | Who |
|---|---|---|
| Oct 3 morning | S.0; R.1–R.4 and S.1–S.3 in parallel on their two branches | agents |
| Oct 3 midday | H.1–H.2 | agents |
| Oct 3 | PRs reviewed; 0016 and the seed to remote D1; enrol Manoella and the evaluators (emails needed) | team |

Skipped on purpose: admin-only routes (nothing needs one; the banner and the two views are the deliverable); a roles column in `sessions` (the token decides at sign-in, the client only shows); a banner component (one `@if` per page); a help menu with several options (ask 6 is one action; add options when asked); exporting `reason` in events (contract v2 stays frozen for the scorer); a reason classifier (no model online, ADR-002).
