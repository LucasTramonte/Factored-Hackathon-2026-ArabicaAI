# Product Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the product in the team page "ArabicaAI Product Flow" by the 2026-10-05 submission: a hardened base, email one-time-code sign-in on Amazon Cognito, a promise-first screen, reports that outlive the session, a status a person can change, email notifications on every change, an urgency lane, and the extractor reading the not-found answers in shadow.

**Architecture:** One online runtime stays: the Cloudflare Worker with D1 (ADR-003). Cloudflare Zero Trust (Access) is removed from the hostname. Identity moves to Amazon Cognito: the browser runs Cognito's native passwordless `EMAIL_OTP` flow against the user pool, receives an ID token, and hands it to the Worker once; the Worker verifies the token against the pool's JWKS, maps the Cognito user to a customer or agent, and mints the same HttpOnly session cookie it uses today. From there identity comes from the session only, as now. Roles come from Cognito groups (`customer`, `agent`; `admin` and `auditor` defined with no routes). Amazon SES sends every email from the Worker through a signed HTTPS call; nothing else on AWS is touched this week. Each change is a route, a column or a screen; SQL stays in `back-end/src/store/d1.js`.

**Tech Stack:** Cloudflare Worker (ES modules, Node 22 tests), D1 migrations, Angular 20 standalone + signals, Amazon Cognito User Pool (Essentials tier, `USER_AUTH` flow with `EMAIL_OTP`), Amazon SES v2 API, `jose` (JWT verification, one new Worker dependency), `aws4fetch` (SigV4 for SES, one new Worker dependency). No model online.

**Source documents:** the team page (artifact "ArabicaAI Product Flow"), Lucas's `auth-stack-decision (1).md` (sections 6 to 11), ADR-002 to ADR-006, `Docs/intake/intake-events.md`, `AGENTS.md`.

**Owners and dates:** Worker side of every phase and the AWS setup: Lucas (Roberto reviews). Client side of every phase: Roberto. Rehearsal: Manoella and Lucas. Dates: Oct 2: Tasks 0.1, 0.4 (small, no deploy gap), 1.0 to 1.5, 1.7 and the SES production-access request (3.0). Oct 3: Phase 2, Tasks 3.1 to 3.2, then 0.2 and 0.3. Oct 3 to 4: Phase 4, 3.3, Phase 5 if time allows. Oct 4: Phase 6. Oct 5 is buffer only.

**Cut line if time runs out:** the demo is Tasks 0.1 and 0.4, Phase 1 without 1.6, Phase 2, and 3.0 to 3.2. Phase 4 completes André's story and is the first likely slip. Then 0.2 and 0.3. Task 1.6 (agents on Cognito) ships only if Phase 2 lands by Oct 3 noon; the team gate on `/agent` is defensible for judging. Phase 5 drops first if Phase 4 is still open on Oct 4 morning.

**Reviewed twice on the evening of 2026-10-01** by an independent plan review against the code; its blocking findings are folded in (no unique index on `cases`, no second session read per request, no deploy gap between phases, bounded audit writes, no `enum` in the contract validator).

---

## Rules that apply to every task

- Read `AGENTS.md` "Intake service rules" before starting. Identity from the session only. Route handlers never build SQL. Additive migrations, applied to local D1 in tests first, and **applied `--remote` before the PR that needs them merges** (the deploy guard refuses otherwise; this blocked every deploy on Oct 1).
- Every API change ships with adversarial tests in `back-end/test/`: gate and method matrix, session swap and expiry, isolation, hostile input, idempotency, contract validation against `front-end/contracts/intake-api.schema.json`, and D1 budget ceilings in `test/integration/budget.test.js`. A ceiling increase is justified in ADR-004's implementation notes.
- Events, logs and emails carry references only, never the customer's statement or email address in clear.
- Every UI string exists in `es`, `pt` and `en` in `front-end/src/app/shared/i18n/lang.service.ts`; the `Strings` type makes a missing key a compile error.
- Tests before code. Each task ends with the suites it names green and one scoped commit ending in `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Commands, from the repo root unless stated:
  - Worker unit: `npm --prefix back-end run test:unit`
  - Worker integration (needs built assets once): `npm --prefix front-end run build && npm --prefix back-end run prepare-assets && npm --prefix back-end run test:integration`
  - Angular: `cd front-end && npx ng test --watch=false --browsers=ChromeHeadless`
  - Angular build: `cd front-end && npx ng build` (must print no warning)
  - Docs: `python3 scripts/check_doc_links.py`
- One PR per phase, label by branch prefix, assignee the author, reviewer Manoella (plus Lucas for the Worker). PR body states the tests run with counts.

---

## Phase 0: Harden the base (Lucas's mandatory fixes on the current code)

Branch `fix/base-hardening`. Lucas's section 8 lists fixes "independent of the stack". Each one is mapped here to the line of code it touches today. Nothing in this phase changes the customer-visible flow.

### Task 0.1: Logout and server-side revocation (Lucas 8d)

**Files:**
- Modify: `back-end/src/auth/session.js` (add `endSession`)
- Modify: `back-end/src/store/d1.js` (add `revokeSession`)
- Modify: `back-end/src/router.js` (route `/auth/logout`)
- Modify: `back-end/wrangler.jsonc` (`run_worker_first` adds `/auth`, `/auth/*`)
- Modify: `front-end/proxy.conf.json` (forward `/auth/**`)
- Test: `back-end/test/unit/gate-and-session.test.js`, `back-end/test/integration/adversarial.test.js`

- [ ] **Step 1: Failing unit test** in `gate-and-session.test.js` (`tokenHash` is already imported at the top of that file; the test covers both actors through the `actor` parameter):

```js
test('ending a session deletes exactly the presented token hash and clears the cookie', async () => {
  const { endSession, COOKIE } = await import('../../src/auth/session.js');
  const calls = [];
  const store = { revokeSession: async hash => { calls.push(hash); } };
  const token = 'a'.repeat(64);
  const header = await endSession(new Request('http://localhost:8787/auth/logout', { headers: { Cookie: `${COOKIE.customer}=${token}` } }), store, 'customer'); // localhost: no Secure attribute
  assert.equal(calls.length, 1);
  assert.equal(calls[0], await tokenHash(token));
  assert.match(header, new RegExp(`^${COOKIE.customer}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`));
});
```

- [ ] **Step 2: Run** `npm --prefix back-end run test:unit` → FAIL: `endSession is not a function`.
- [ ] **Step 3: Implement.** In `session.js`:

```js
/** Revoke the presented token for ``actor`` (no-op when absent or malformed) and return the clearing Set-Cookie. */
export async function endSession(request, store, actor) {
  const token = readCookies(request)[COOKIE[actor]];
  if (token && TOKEN.test(token)) await store.revokeSession(await tokenHash(token));
  return cookieHeader(COOKIE[actor], '', request, 0);
}
```

In `d1.js` next to `rotateSession`: `revokeSession: hash => all('DELETE FROM sessions WHERE token_hash=?', hash),`.

In `router.js`, add to `API_ROUTES`: `'/auth/logout': { POST: logout }` where `logout` lives in `src/modules/customer/routes.js`:

```js
/** POST /auth/logout: revoke the presented customer session; always 204, so it reveals nothing. */
export async function logout(request, env, store) {
  return new Response(null, { status: 204, headers: { 'Set-Cookie': await endSession(request, store, 'customer') } });
}
```

Add `'/auth/'` to `API_PREFIXES`; add `"/auth", "/auth/*"` to `run_worker_first`; add `"/auth/**"` to `proxy.conf.json`.

- [ ] **Step 4: Integration test** in `adversarial.test.js`: sign in, call `/transactions` (200), `POST /auth/logout` (204), `/transactions` again → 401; the old cookie replayed by a second client → 401.
- [ ] **Step 5: Run** unit and integration → PASS. Add `logout` to `budget.test.js` CEILING as `[1, 0, 1, 1]` and measure.
- [ ] **Step 6: Commit** `fix(auth): logout revokes the session server-side`.

### Task 0.2: Authentication audit events (Lucas 8d, 8f). Oct 3, after Phase 2.

**Files:**
- Create: `back-end/migrations/0010_auth_audit.sql` (numbered after Phase 1 has merged; Phase 1 adds no migration, so renumber if Phase 3 merges first)
- Modify: `back-end/src/store/d1.js` (`recordAuthEvent`)
- Modify: `back-end/src/auth/session.js` (`requireSession`)
- Modify: `back-end/src/modules/customer/routes.js`, `back-end/src/modules/agent/routes.js` (record on session start and logout)
- Test: `back-end/test/integration/adversarial.test.js` (read through the local store script, as `budget.test.js` does with `scripts/intake-store.mjs`; there is **no** read route)

Bounded on purpose: a row is written only when a cookie **was presented** and was malformed or expired, never when no cookie exists, so an anonymous scanner costs no D1 writes. Only references are stored: the 12-hex session reference and the request id, never the customer id, never an email. No agent-facing read route: Lucas's `agent` boundary is assigned cases only, and `auditor` owns the audit read when it exists.

- [ ] **Step 1: Migration**:

```sql
-- Who authenticated, when, and how it ended. References only: a 12-hex prefix of the session token hash and the
-- request id. Written on session start, logout, and on a presented cookie that was malformed or expired; never on
-- a request with no cookie, so anonymous traffic costs no writes.
CREATE TABLE auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('customer','agent')),
  event TEXT NOT NULL CHECK (event IN ('session_started','session_rejected','session_expired','logged_out')),
  session_ref TEXT NOT NULL CHECK (length(session_ref) = 12),
  request_id TEXT NOT NULL
);
CREATE INDEX auth_events_time ON auth_events(ts DESC);
```

- [ ] **Step 2: Failing integration test**: sign in, call `/transactions` with the pre-seeded expired cookie (`'e'.repeat(64)`), call `/transactions` with **no** cookie, log out; then read `auth_events` through the store script: exactly three rows (`session_started`, `session_expired`, `logged_out`), none for the cookieless call, no `customer_id` column.
- [ ] **Step 3: Implement** `recordAuthEvent({ ts, actor, event, sessionRef, requestId })` as one `INSERT`; `sessionRef = hash.slice(0, 12)`; `requestId = request.headers.get('cf-ray') ?? crypto.randomUUID()`. `requireSession(request, store, actor)` wraps `readSession`: when a well-formed cookie was presented and no live row came back, it records `session_expired` (row existed and expired is indistinguishable from revoked here; the event name is kept) and returns `null`; a malformed cookie records `session_rejected`. Handlers replace their `readSession` call with `requireSession` (one read, as today, plus the conditional write).
- [ ] **Step 4: Keep round trips flat**: the `session_started` INSERT goes inside `rotateSession`'s existing batch and the `logged_out` INSERT inside `revokeSession`, which becomes a two-statement batch. Only the expiry and rejection writes are separate statements (they happen on the 401 path, which has no batch). Run unit and integration → PASS. Budget: `login`, `agentLogin` and `logout` each gain one query and one write, no round trip; record the exact new ceilings in `budget.test.js` and in ADR-004 implementation notes with this task as the reason.
- [ ] **Step 5: Commit** `fix(auth): audit events for session start, expiry, rejection and logout`.

### Task 0.3: Explicit route-to-role table, declarative (Lucas 8b, 8c). Oct 3.

**Files:**
- Modify: `back-end/src/router.js`
- Test: `back-end/test/unit/failure-and-routing.test.js`

The table documents and pins who may call what. Enforcement stays where it is: every handler reads the session itself, and the gate, method and isolation matrices already prove it. A second session read in the router would add a query and a round trip to every request and break the exact D1 ceilings (ADR-004: a ceiling is never raised for convenience).

- [ ] **Step 1: Failing unit test**: import `ROLES` and `ROUTE_ROLES`; assert every key of `API_ROUTES` has a role in `ROLES`; assert `ROLES` contains `admin` and `auditor` and that no route maps to either; assert the module throws at load if a route lacks a role (test by importing a copy with a deliberately missing entry is impractical, so assert `Object.keys(API_ROUTES).every(p => p in ROUTE_ROLES)` and that `router.js` runs the same check at module load).
- [ ] **Step 2: Implement.** In `router.js`:

```js
/** Who may call what. ``public`` needs no session; ``customer`` and ``agent`` need that actor's live session, which
 *  each handler reads itself. ``admin`` and ``auditor`` exist as roles (Lucas's RBAC) and own no route until a
 *  feature needs one. Declarative: adding a route without a role fails at module load. */
export const ROLES = ['public', 'customer', 'agent', 'admin', 'auditor'];
export const ROUTE_ROLES = {
  '/demo/identities': 'public', '/demo/session': 'public', '/auth/logout': 'public',
  '/transactions': 'customer', '/cases': 'customer', '/intake/start': 'customer', '/intake/confirm': 'customer', '/intake/handoff': 'customer',
  '/demo/agent-session': 'public', '/agent/cases': 'agent', '/agent/intakes': 'agent', '/agent/intake-detail': 'agent'
};
for (const path of Object.keys(API_ROUTES)) {
  if (!ROLES.includes(ROUTE_ROLES[path])) throw new Error(`Route ${path} has no role`);
}
```

Phases 1 to 4 add their routes to this table in the same commit that adds them.

- [ ] **Step 3: Run** unit → PASS. **Commit** `fix(router): explicit route-to-role table; admin and auditor declared`.

### Task 0.4: Identity listing only in local development (Lucas 8e). Oct 2, **shipped inside the Phase 1 PR**.

Shipping this alone would return 404 on `/demo/identities` and `/demo/session` in production while `/auth/session` does not exist yet, and nobody could sign in on the live URL. So the code lands now on the Phase 1 branch and deploys with Task 1.2.

**Files:**
- Modify: `back-end/src/modules/customer/routes.js` (`listIdentities`, `startCustomerSession`)
- Modify: `back-end/test/run-local.mjs` (`.dev.vars` adds `DEMO_PICKER="1"`)
- Modify: `back-end/README.md` (variables table)
- Test: `back-end/test/unit/failure-and-routing.test.js`

- [ ] **Step 1: Failing unit test**: with `env = {}` both `GET /demo/identities` and `POST /demo/session` return 404 `{detail:'Not found'}`; with `env.DEMO_PICKER === '1'` they behave as today.
- [ ] **Step 2: Implement**: first line of both handlers: `if (env.DEMO_PICKER !== '1') return fail(404, 'Not found');`. `wrangler.jsonc` gets no `DEMO_PICKER`, so the route is absent in production once this deploys with Phase 1.
- [ ] **Step 3: Run** all Worker suites → PASS. **Commit** `fix(customer): demo identity picker only when DEMO_PICKER=1`.

### Task 0.5: (removed) one open report per charge

A unique index on `cases(customer_id, transaction_id)` would break the suite (every test confirms Ana's `demo-tx-001` from a fresh episode, and `/cases` creates `demo-tx-002` twice) and the demo (the fictitious seed gives Ana two charges), and `cases.status` is always `accepted`, so "open" would never end. The product rule moves to Phase 4 (Task 4.4) as a route-level check against the handoff status, once a report can be closed.

### Task 0.6: Runbook rule and deploy guard message

**Files:**
- Modify: `CONTRIBUTING.md` (PR checklist: "a PR that adds a migration applies it `--remote` before merge and says so in the body")
- Modify: `back-end/scripts/predeploy.mjs` (error text names the exact command, already does; add a line pointing to the runbook)
- Modify: `Docs/Plans/intake-demo.md` ("Deployed preview": the Oct 1 incident in two lines)

- [ ] **Step 1: Edit the three files**, run `python3 scripts/check_doc_links.py` → "All relative Markdown links resolve."
- [ ] **Step 2: Commit** `docs: migrations go remote before merge; the Oct 1 blocked deploy recorded`.

### Task 0.7: Phase 0 PRs

- [ ] **Oct 2, PR A** (`fix/base-hardening`): Tasks 0.1 and 0.6 only. No migration. `gh pr create --label bug --assignee @me --reviewer ManoellaR --reviewer Robertzu43 --title "fix: server-side logout; migrations go remote before merge"`.
- [ ] **Oct 3, PR B** (`fix/auth-audit-and-roles`): Tasks 0.2 and 0.3. Apply the audit migration to remote D1 first (Lucas): `cd back-end && CLOUDFLARE_ACCOUNT_ID=09752dbbdf4da990a77d1bf3574cf710 npx wrangler d1 migrations apply arabica-intake-demo --remote`. Body lists Lucas's items 8b, 8c, 8d, 8f with the task that closes each, and the tests with counts.

---

## Phase 1: Email sign-in on Amazon Cognito, no Zero Trust

Branch `feat/cognito-email-signin`. Lucas's item 8a. Cloudflare Access is removed from the hostname; the Basic gate is removed from `/` and from customer routes and kept on `/agent`, `/demo/*` and the operator routes until Task 1.6 moves agents to Cognito too. Task 0.4 ships in this PR.

Request SES production access on Oct 2 as well (Task 3.0): approval can take more than a day.

### Task 1.0: AWS setup (Lucas, manual, recorded in `Docs/Plans/intake-demo.md`)

- [ ] Create a Cognito User Pool `arabicaai-demo` in `us-east-2`, Essentials tier. Sign-in: email. Self sign-up: **off**. Authentication flows: `USER_AUTH` with `EMAIL_OTP` enabled, password sign-in **off**. Email sender: Cognito default for now (50 messages a day is enough for judging; switch to SES when Task 3.0's identity is verified). App client `arabicaai-web`, public client, no secret, `ALLOW_USER_AUTH` only. Groups: `customer`, `agent`, `admin`, `auditor`.
- [ ] Record the pool id, region and app client id in `back-end/wrangler.jsonc` under `vars`: `COGNITO_REGION`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` (public values, not secrets). Record the JWKS URL: `https://cognito-idp.<region>.amazonaws.com/<pool>/.well-known/jwks.json`.
- [ ] Order matters: add the custom attribute `custom:customer_id` (string, immutable) **before** creating the app client, or add it to the client's readable attributes afterwards; a custom attribute added later is not readable by an existing client and would be missing from the ID token. The pool must be Essentials or Plus (Lite has no choice-based sign-in).
- [ ] Enrollment: create each user with `aws cognito-idp admin-create-user --user-pool-id … --username <email> --user-attributes Name=email,Value=<email> Name=email_verified,Value=true Name=custom:customer_id,Value=<cohort customer id> --message-action SUPPRESS`, then `admin-add-user-to-group --group-name customer`. Agents: `custom:customer_id` absent, group `agent`. Add the custom attribute `custom:customer_id` (string, immutable) to the pool first. The team's three members and the three judges' emails are enrolled; the judges each map to one cohort customer with at least five purchases. `admin-create-user` leaves the user in `FORCE_CHANGE_PASSWORD`: verify with one real team address on Oct 2 that the `EMAIL_OTP` sign-in completes from that state; if it does not, run `admin-set-user-password --permanent` with a random password to move the user to `CONFIRMED`. Record the outcome in the runbook.
- [ ] Remove the Cloudflare Access application from the hostname (Zero Trust dashboard). Keep the `DEMO_ACCESS_*` secrets until Task 1.6.

### Task 1.1: Token verification module

**Files:**
- Create: `back-end/src/auth/cognito.js`
- Modify: `back-end/package.json` (dependency `jose`)
- Test: `back-end/test/unit/cognito.test.js`

- [ ] **Step 1: Failing unit test.** Generate an RS256 key pair with `jose` in the test, build a JWKS, sign an ID token with `iss`, `aud`, `token_use: 'id'`, `email`, `email_verified: true`, `cognito:groups: ['customer']`, `custom:customer_id: 'demo-ana'`, `exp` in the future. Assert `verifyIdToken(token, { jwks, issuer, clientId })` returns `{ sub, email, groups: ['customer'], customerId: 'demo-ana' }`. Then assert it rejects: wrong `aud`; wrong `iss`; `token_use: 'access'`; expired; `email_verified: false`; alg `none`; a token signed by a different key.
- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement**:

```js
/** Verifies a Cognito ID token and returns the trusted claims the Worker uses. Identity never comes from the body. */
import { createRemoteJWKSet, createLocalJWKSet, jwtVerify } from 'jose';

import { CUSTOMER_ID } from '../modules/customer/validation.js'; // move the regex there from customer/routes.js; one definition
let remote;
export function jwksFor(env) {
  remote ??= createRemoteJWKSet(new URL(`https://cognito-idp.${env.COGNITO_REGION}.amazonaws.com/${env.COGNITO_USER_POOL_ID}/.well-known/jwks.json`));
  return remote;
}
export function issuerFor(env) { return `https://cognito-idp.${env.COGNITO_REGION}.amazonaws.com/${env.COGNITO_USER_POOL_ID}`; }

/** ``{ sub, email, groups, customerId }`` or throws. ``jwks`` may be a local set in tests. */
export async function verifyIdToken(token, { jwks, issuer, clientId }) {
  const { payload } = await jwtVerify(token, jwks, { issuer, audience: clientId, algorithms: ['RS256'], clockTolerance: 30 });
  if (payload.token_use !== 'id') throw new Error('not an id token');
  if (payload.email_verified !== true || typeof payload.email !== 'string') throw new Error('email not verified');
  const groups = Array.isArray(payload['cognito:groups']) ? payload['cognito:groups'].filter(g => typeof g === 'string') : [];
  const customerId = payload['custom:customer_id'];
  return { sub: payload.sub, email: payload.email, groups,
    customerId: typeof customerId === 'string' && CUSTOMER_ID.test(customerId) ? customerId : null };
}
```

`npm --prefix back-end install jose@5` (pin the version `npm` resolves). `createLocalJWKSet` is used by the test.

- [ ] **Step 4: Run** → PASS. **Commit** `feat(auth): verify Cognito ID tokens`.

### Task 1.2: `POST /auth/session` mints the Worker session from a verified token (sent as `Authorization: Bearer`)

**Files:**
- Modify: `back-end/src/modules/customer/routes.js` (`startEmailSession`)
- Modify: `back-end/src/modules/agent/routes.js` (`startAgentSession` accepts the token path when configured)
- Modify: `back-end/src/router.js` (`'/auth/session': { POST: startEmailSession }`, role `public`)
- Modify: `back-end/src/store/d1.js` (`customerSource` already exists; add `upsertNotificationTarget` in Phase 3, not here)
- Test: `back-end/test/unit/failure-and-routing.test.js`, `back-end/test/integration/adversarial.test.js`

- [ ] **Step 1: Failing unit test.** With an injected verifier (the handler takes `verify = verifyIdToken` as its last parameter, like `startIntake` takes `approved`), a request with `Authorization: Bearer <token>` and an empty body whose claims carry `groups: ['customer']`, `customerId: 'demo-ana'` returns 200, the same JSON shape as `/demo/session` with `mode: 'email_otp'`, and a `Set-Cookie` for `demo_session`. The token travels in the header, never in the body, so Lucas's rule holds literally and no body logging can capture it. Rejections: missing or malformed header → 422; token over 4096 chars → 422; verifier throws → 401 `{detail:'Sign-in could not be verified'}`; claims with no `customer` group → 403; `customerId` not loaded in D1 → 403 `{detail:'This account is not enrolled in the demo'}`; any JSON body → ignored.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**:

```js
/** POST /auth/session: exchange a verified Cognito ID token for the Worker's own customer session. */
export async function startEmailSession(request, env, store, ctx, verify = verifyIdToken) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return fail(422, 'Provide the sign-in token');
  let claims;
  try { claims = await verify(token, { jwks: jwksFor(env), issuer: issuerFor(env), clientId: env.COGNITO_CLIENT_ID }); }
  catch { return fail(401, 'Sign-in could not be verified'); }
  if (!claims.groups.includes('customer') || !claims.customerId) return fail(403, 'This account is not enrolled in the demo');
  if (!await store.customerSource(claims.customerId)) return fail(403, 'This account is not enrolled in the demo');
  const card = contextCard(await store.findContextCard(claims.customerId));
  const cookie = await startSession(request, store, 'customer', claims.customerId);
  return json({ customer_id: claims.customerId, mode: 'email_otp', context_card: card }, 200, { 'Set-Cookie': cookie });
}
```

The email address is never stored here. Add the route to `ROUTE_ROLES` as `public`.

- [ ] **Step 4: Integration test**: `run-local.mjs` cannot reach Cognito, so the integration runner sets `COGNITO_TEST_JWKS` in `.dev.vars` to a local JWKS JSON generated at startup with `jose`, and `jwksFor(env)` returns `createLocalJWKSet(JSON.parse(env.COGNITO_TEST_JWKS))` when that variable is set. The test signs a token for `demo-ana`, calls `/auth/session`, then `/transactions` → 200 with only Ana's rows; a token for a customer id not in D1 → 403; a tampered token → 401. **Only** the test runner may set `COGNITO_TEST_JWKS`; `predeploy.mjs` refuses to deploy if `wrangler.jsonc` `vars` contains it.
- [ ] **Step 5: Contract**: add a separate `emailSession` definition to `front-end/contracts/intake-api.schema.json` with the same properties as `customerSession` and `mode: { "const": "email_otp" }` (the test validator in `test/support/contract.js` supports `const` and `pattern`, not `enum`); `assertContract('emailSession', body)` in the test. Budget: `emailLogin` ceiling equals `login`.
- [ ] **Step 5b: Client API**: `ApiService.request` gains an optional `headers` argument so `signInWithToken` can send `Authorization: Bearer`.
- [ ] **Step 6: Run** all → PASS. **Commit** `feat(auth): Worker session from a verified Cognito ID token`.

### Task 1.3: Client sign-in: email, then code

**Files:**
- Create: `front-end/src/app/core/auth/cognito.service.ts`
- Modify: `front-end/src/app/features/customer/customer.service.ts` (`signInWithToken`)
- Modify: `front-end/src/app/features/customer/customer.page.ts`, `.html` (login step: email field → code field; picker removed from the login step; kept behind `environment.demoPicker` for local only)
- Modify: `front-end/src/app/shared/i18n/lang.service.ts` (strings: `emailLabel`, `sendCode`, `codeLabel`, `codeSent`, `verify`, `signInFailed`, `notEnrolled`, `resendCode`)
- Create: `front-end/src/app/core/auth/cognito.config.ts` (the public pool region, pool id and client id; `demoPicker = isDevMode()` from `@angular/core`, no `environments/` folder and no `fileReplacements` needed)
- Test: `front-end/src/app/core/auth/cognito.service.spec.ts`, `front-end/src/app/features/customer/customer.page.spec.ts`

- [ ] **Step 1: Failing service spec.** `CognitoService.requestCode('ana@example.com')` POSTs to `https://cognito-idp.<region>.amazonaws.com/` with header `X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth` and header `Content-Type: application/x-amz-json-1.1` and body `{ AuthFlow: 'USER_AUTH', ClientId, AuthParameters: { USERNAME: 'ana@example.com', PREFERRED_CHALLENGE: 'EMAIL_OTP' } }` and keeps the returned `Session`. The app client is public with no secret, so no `SECRET_HASH`. `submitCode('123456')` POSTs `RespondToAuthChallenge` with `ChallengeName: 'EMAIL_OTP'`, `ChallengeResponses: { USERNAME, EMAIL_OTP_CODE: '123456' }`, `Session`, and resolves to `AuthenticationResult.IdToken`. A `NotAuthorizedException` or `CodeMismatchException` rejects with `ApiError(401)`; `UserNotFoundException` **also** rejects with `ApiError(401)` (no enumeration in the UI). Use `fetch` with a stubbed `window.fetch` in the spec.
- [ ] **Step 2: Run** `npx ng test` → FAIL. **Step 3: Implement** the service (about 40 lines, no SDK; the Cognito JSON API over `fetch`). `CustomerService.signInWithToken(idToken)` → `POST /auth/session`.
- [ ] **Step 4: Failing page specs** (budget half a day: `customer.page.spec.ts` has 43 specs and 14 lines touch the picker or sign-in): the login step shows an email input and "Send code"; after `requestCode` resolves, the code input and "Verify" appear and focus moves to the code input; a 401 shows `signInFailed` under the field and keeps the email; success goes `home`. The picker is absent unless `environment.demoPicker`. Update the existing sign-in specs accordingly (`start()` still precedes the login step while the intro exists).
- [ ] **Step 5: Implement** the template and component. The code input: `inputmode="numeric" autocomplete="one-time-code" maxlength="6"`, labelled. Both buttons disabled while busy; a visible status line while waiting. Reduced motion respected (nothing new animates).
- [ ] **Step 6: Run** Angular specs and build → PASS, no warnings. **Commit** `feat(client): email one-time-code sign-in on Cognito`.

### Task 1.4: Gate changes: `/` and customer routes public, agent routes keep the team gate

**Files:**
- Modify: `back-end/src/router.js` (gate only `DOCUMENT_PATHS` entry `/agent`, `/demo/*`, `/agent/*`)
- Modify: `back-end/README.md` (Access removed; which paths the Basic gate still covers; the Cognito variables)
- Test: `back-end/test/unit/failure-and-routing.test.js` (gate matrix: `/` and `/auth/session`, `/transactions` without the Basic header are not 401 from the gate; `/agent`, `/demo/identities`, `/agent/intakes` still are)

- [ ] **Step 1: Failing test, Step 2: implement**: `const TEAM_GATED = pathname === '/agent' || pathname.startsWith('/demo/') || pathname.startsWith('/agent/');`. Customer routes rely on the session (Task 0.3 enforces it).
- [ ] **Step 3: Abuse bound on `/auth/session`**: it does one JWKS fetch (cached by `jose`) and one D1 read per call. Add a unit test that an invalid token never reaches the store (`customerSource` not called).
- [ ] **Step 4: Rewrite the gate-matrix tests that assume the gate on customer routes**: `intake-handoff.test.js:26-28` asserts 401 for every method without the Basic header (a GET without auth now becomes 405, a POST 401 from the session); the "path tricks" cases in `adversarial.test.js` likewise. Keep the matrix for `/agent/*` and `/demo/*`. The integration client's extra Basic header on public routes is ignored and stays.
- [ ] **Step 5: Run** all Worker suites → PASS. **Commit** `feat(router): customer paths public behind the session; team gate kept on agent and demo paths`.

### Task 1.5: Promise line first, caption on the charges

**Files:**
- Modify: `front-end/src/app/features/customer/customer.page.html` (intro: the promise under the word from the first frame, no delay; login: promise above the email field)
- Modify: `front-end/src/styles.css` (`.intro-promise` visible at 0 s; reduced-motion unchanged)
- Modify: `front-end/src/app/shared/i18n/lang.service.ts` (`promiseLine`, `windowCaption`)
- Test: `customer.page.spec.ts`

Strings (decision 1 pending; these are the safe wording):
- es `promiseLine`: "¿Un cargo que no reconoces? Tranquilo, nos encargamos." · pt: "Uma cobrança que você não reconhece? Fique tranquilo, a gente cuida." · en: "A charge you don't recognize? No worries, we've got it from here."
- es `windowCaption`: "Tus compras aprobadas de los últimos 120 días, de la más reciente a la más antigua." · pt: "Suas compras aprovadas dos últimos 120 dias, da mais recente à mais antiga." · en: "Your approved purchases from the last 120 days, newest first."

- [ ] **Step 1: Failing spec**: on first render the intro contains an element with the promise text and it is not hidden (`getComputedStyle(...).visibility !== 'hidden'`, opacity 1); the login step contains it above the email field; the charges box caption equals `windowCaption`.
- [ ] **Step 2: Implement**, run specs and build → PASS. Measure contrast of the new line in both themes with `Docs/Evidence/contrast_ratios.py` and record in `Docs/Evidence/accessibility-audit.md`.
- [ ] **Step 3: Commit** `feat(client): the promise is the first line on the first screen; charges caption cites the window`.

### Task 1.6: Agents sign in through Cognito too (group `agent`)

**Files:**
- Modify: `back-end/src/modules/agent/routes.js` (`startAgentSession` accepts `{ id_token }`, requires group `agent`, records the audit event; the no-body path stays only when `DEMO_PICKER === '1'`)
- Modify: `back-end/src/router.js` (Basic gate dropped from `/agent` and `/agent/*`; `ROUTE_ROLES` unchanged)
- Modify: `front-end/src/app/features/agent/agent.page.*` (email and code form before the queue, reusing `CognitoService`)
- Test: unit and integration (an agent token with group `customer` only → 403; a customer token on `/agent/intakes` → 401)

- [ ] **Steps**: failing tests → implement → run all → `Set the DEMO_ACCESS_* secrets aside: delete from the Worker after this deploys` recorded in the README → **Commit** `feat(agent): agents sign in with Cognito; team gate retired`.

### Task 1.7: ADR-007 and docs

**Files:**
- Create: `Docs/ADRs/ADR-007-customer-identity-cognito-email-otp.md` (Status Proposed; deciders Lucas, Roberto, Manoella; Context cites Lucas's document sections 6 to 11 and the brief's "trusted test session or identity service"; Decision: Cognito EMAIL_OTP, Worker session as the only identity source, roles from groups, no Zero Trust, SES as delivery only; Consequences: a second provider and two public ids in config; Alternatives: Cloudflare Access (rejected: application must own the boundary), Worker-owned OTP (rejected: our own code for what Cognito does), Cognito hosted UI redirect (rejected: leaves our page); Supersedes ADR-003 decision 5)
- Modify: `Docs/ADRs/README.md` (index row), `Docs/ADRs/ADR-003-intake-single-runtime-worker-d1.md` (status note on decision 5), `AGENTS.md` (identity rules: enrolment lives in Cognito; `identities.json` keeps the fictitious set for local), `Docs/deliverables/SYSTEM_DESIGN.md` ("Identity and access"), `front-end/README.md`, `Docs/Plans/intake-demo.md` (enrolment runbook)

- [ ] Write, `python3 scripts/check_doc_links.py`, **Commit** `docs: ADR-007 customer identity on Cognito email OTP`.

### Task 1.8: Phase 1 PR and deploy

- [ ] Add the `vars` to `wrangler.jsonc`; no new migration in this phase. Open the PR (label `enhancement`, reviewers Manoella and Lucas). After merge: Lucas confirms the Workers Build deployed (`npx wrangler deployments list`), signs in with his own enrolled email on the live URL, and runs the remote checklist in `back-end/README.md`.

---

## Phase 2: Reports that outlive the tab

Branch `feat/customer-reports`.

### Task 2.1: `GET /reports`

**Files:**
- Modify: `back-end/src/store/d1.js` (`listCustomerHandoffs(customerId, limit)`)
- Modify: `back-end/src/modules/intake/routes.js` (`listReports`)
- Modify: `back-end/src/router.js` (`'/reports': { GET: listReports }`, role `customer`), `wrangler.jsonc` `run_worker_first` (`/reports`, `/reports/*`), `proxy.conf.json`
- Modify: `front-end/contracts/intake-api.schema.json` (`reportList`)
- Test: `back-end/test/integration/intake-handoff.test.js`, `adversarial.test.js`, `budget.test.js`

- [ ] **Step 1: Failing integration test**: Ana creates one complete and one incomplete handoff; `GET /reports` returns both, newest first, each with `protocol`, `reference_short`, `kind`, `status: 'received'` (the column arrives in Phase 4; until then the route returns the literal `'received'`), `accepted_at`, `next_step` key (`review_pending`), and **no** `customer_statement`. Bruno's session sees none of them. An expired session → 401.
- [ ] **Step 2: Store**:

```js
listCustomerHandoffs: (customerId, limit) => all(
  'SELECT COALESCE(h.complete_case_id,h.handoff_id) AS protocol,h.reference_short,h.kind,h.tool_status,h.accepted_at '
  + "FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) WHERE e.customer_id=? AND e.state=h.kind||'_handoff' "
  + 'ORDER BY h.accepted_at DESC LIMIT ?', customerId, limit),
```

The `e.state=h.kind||'_handoff'` predicate is the one the agent queue uses: a `handoff_pending` reservation whose receipt was never read back must not appear with a reference the customer never received.

- [ ] **Step 3: Route** (20 per page, `has_more`), contract entry, `'/reports/'` added to `API_PREFIXES` so unknown subpaths answer JSON 404, budget ceiling `reports: [2, 25, 0, 2]` (session read plus the list, like `list`) measured. Run → PASS. **Commit** `feat(reports): the signed-in customer's own reports`.

### Task 2.2: Client "Tus reportes" from the server

**Files:**
- Modify: `front-end/src/app/features/customer/customer.service.ts` (`reports()`), `customer.page.ts/.html` (load on home and after each receipt; the session-only list is replaced), `intake.model.ts` (`ReportList`), `lang.service.ts` (`statusReceived`, `nextStepReview`)
- Test: `customer.page.spec.ts`

- [ ] Failing spec → implement → run → **Commit** `feat(client): reports list comes from the server and survives the tab`.

### Task 2.3: Phase 2 PR (label `enhancement`).

---

## Phase 3: Email on every change

Branch `feat/notifications`.

### Task 3.0: SES setup (Lucas, manual, recorded in the runbook)

- [ ] Verify a sending identity in SES `us-east-2` (a domain the team controls, or the team address). Request production access or add the judges' addresses as verified recipients while in the sandbox. Create an IAM user `arabicaai-worker-ses` with a policy allowing only `ses:SendEmail` on that identity. Put `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` as Worker secrets (`npx wrangler secret put`), and `SES_REGION`, `SES_FROM` as `vars`. Nothing in the repository.

### Task 3.1: Outbox table and sender module

**Files:**
- Create: `back-end/migrations/0010_notifications.sql`
- Create: `back-end/src/notify/email.js`, `back-end/src/notify/templates.js`
- Modify: `back-end/package.json` (dependency `aws4fetch`)
- Modify: `back-end/src/store/d1.js` (`upsertNotificationTarget`, `findNotificationTarget`, `enqueueEmail`, `markEmail`, `recentEmails`)
- Test: `back-end/test/unit/notify.test.js`

- [ ] **Step 1: Migration**:

```sql
-- Where to reach a customer who signed in by email, and what we sent. The address is AES-GCM encrypted with a
-- Worker secret; the outbox stores template name, language and reference only, never a body or a statement.
CREATE TABLE notification_targets (
  customer_id TEXT PRIMARY KEY REFERENCES customers(customer_id),
  email_enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE email_outbox (
  message_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  template TEXT NOT NULL CHECK (template IN ('received','in_review','closed','update')),
  language TEXT NOT NULL CHECK (language IN ('es','pt','en')),
  reference TEXT NOT NULL,
  provider_status TEXT NOT NULL CHECK (provider_status IN ('queued','sent','failed')),
  provider_message_id TEXT
);
CREATE INDEX email_outbox_recent ON email_outbox(customer_id, reference, created_at DESC);
```

- [ ] **Step 2: Failing unit tests**: `templates.render('received', 'es', { reference: 'AR-2K4M-9XQ7', urgent: false })` returns a subject and a text body that contain the reference, contain "No se ha iniciado ningún reembolso", and contain **no** `{` placeholder; the same for all four templates in the three languages (12 cases, table-driven). `email.encrypt(addr, key)` and `decrypt` round-trip and produce different ciphertext each call (random IV). `sendEmail` posts to `https://email.<region>.amazonaws.com/v2/email/outbound-emails` with a SigV4 `Authorization` header (assert `fetch` was called with it) and body `{FromEmailAddress, Destination:{ToAddresses:[addr]}, Content:{Simple:{Subject:{Data}, Body:{Text:{Data}}}}}`; a non-2xx response resolves `{ ok: false }` and never throws.
- [ ] **Step 3: Implement**. `email.js`:

```js
import { AwsClient } from 'aws4fetch';
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = bytes => btoa(String.fromCharCode(...bytes)); const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
async function key(env) { return crypto.subtle.importKey('raw', unb64(env.EMAIL_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']); }
/** ``iv.ciphertext`` in base64; a fresh IV every time. */
export async function encrypt(text, env) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), enc.encode(text))); return `${b64(iv)}.${b64(ct)}`; }
export async function decrypt(blob, env) { const [iv, ct] = blob.split('.').map(unb64); return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await key(env), ct)); }
/** One SES v2 SendEmail; never throws. Returns ``{ ok, messageId }``. Not configured means ``{ ok: false, skipped: true }``. */
export async function sendEmail(env, { to, subject, text }, fetchImpl = fetch) {
  if (!env.SES_ACCESS_KEY_ID || !env.SES_SECRET_ACCESS_KEY || !env.SES_REGION || !env.SES_FROM) return { ok: false, skipped: true };
  const aws = new AwsClient({ accessKeyId: env.SES_ACCESS_KEY_ID, secretAccessKey: env.SES_SECRET_ACCESS_KEY, service: 'ses', region: env.SES_REGION });
  try {
    const signed = await aws.sign(`https://email.${env.SES_REGION}.amazonaws.com/v2/email/outbound-emails`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ FromEmailAddress: env.SES_FROM, Destination: { ToAddresses: [to] }, Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } } }) });
    const res = await fetchImpl(signed); // ``sign`` returns a Request; the test stubs ``fetchImpl``
    if (!res.ok) return { ok: false };
    return { ok: true, messageId: (await res.json()).MessageId ?? null };
  } catch { return { ok: false }; }
}
```

`templates.js`: a plain object `{ es: { received: { subject, body }, … }, pt: …, en: … }` with `{reference}` and an `{urgent}` paragraph, and `render(template, lang, params)`. Every body ends with the no-refund sentence and "ArabicaAI, demo con datos sintéticos" (per language).

`EMAIL_KEY` is a Worker secret (32 random bytes, base64). The test runner writes a fixed one in `.dev.vars`.

- [ ] **Step 4: Store** methods: `upsertNotificationTarget({ customerId, emailEnc, now })`, `findNotificationTarget(customerId)`, `enqueueEmail({ messageId, now, customerId, template, language, reference })`, `markEmail(messageId, status, providerId)`, `recentEmails(customerId, reference, sinceMs)` (for the resend limit).
- [ ] **Step 5: Run** → PASS. `npm --prefix back-end install aws4fetch@1` pinned. **Commit** `feat(notify): outbox, encrypted target, SES sender and three-language templates`.

### Task 3.2: Capture the address at sign-in; send "received" on every handoff

**Files:**
- Modify: `back-end/src/modules/customer/routes.js` (`startEmailSession` encrypts `claims.email` and upserts the target)
- Create: `back-end/src/notify/dispatch.js` (`notify(env, store, ctx, { customerId, template, language, reference, urgent })`: enqueue → `ctx.waitUntil(send → mark)`)
- Modify: `back-end/src/modules/intake/routes.js` (`handoffIntake` and `confirmIntake` call `notify(... 'received' ...)` after the receipt is read back, never before)
- Test: `back-end/test/integration/intake-handoff.test.js` (after a handoff, `email_outbox` has one `received` row for Ana with `provider_status` `queued` or `failed` (SES unconfigured locally), language equal to the episode language; the receipt latency is unchanged: the response arrives before the row exists is **not** asserted, only that the row exists afterwards), `adversarial.test.js` (a customer who signed in through the local picker has no target and gets no row)

`confirmIntake` and `handoffIntake` currently drop `env` and `ctx` (`intake/routes.js:47-49`); thread both through to `finishIntake` so `notify` and Task 5.2 can use them. The outbox `INSERT` goes **inside** `finishIntakeHandoff`'s existing batch (one more statement, no extra round trip); only the SES call runs in `waitUntil`.

- [ ] Failing tests → implement → budgets: `intakeConfirm` and `intakeHandoff` each gain exactly one query and one write, no round trip; record the new ceilings in `budget.test.js` and ADR-004 → **Commit** `feat(notify): "received" email after each handoff; address captured at sign-in`.

### Task 3.3: "Send me an update"

**Files:**
- Modify: `back-end/src/modules/intake/routes.js` (`requestUpdate`: `POST /reports/update` `{ protocol }`, session customer must own it, at most one `update` per protocol per 5 minutes → 429 otherwise, 202 when queued)
- Modify: `back-end/src/router.js`, `wrangler.jsonc`, `proxy.conf.json`, contract (`updateQueued`)
- Modify: `front-end` reports list: one "Enviarme una actualización" button per row with a status line
- Test: integration (owner 202, non-owner 404, second call within 5 minutes 429, hostile protocol 422), Angular spec

- [ ] Failing tests → implement → **Commit** `feat(notify): the customer can ask for a status email`.

### Task 3.4: Phase 3 PR

- [ ] Apply `0010_notifications.sql` `--remote` first; put `EMAIL_KEY` and the SES secrets in the Worker; open the PR (label `enhancement`). Body states which secrets exist and that no address is stored in clear.

---

## Phase 4: A person changes the state

Branch `feat/handoff-status`.

### Task 4.1: Status column, history and agent transitions

**Files:**
- Create: `back-end/migrations/0011_handoff_status.sql`
- Modify: `back-end/src/store/d1.js` (`transitionHandoff`, `listHandoffStatusHistory`; `listIntakeHandoffs` and `listCustomerHandoffs` select `status`)
- Modify: `back-end/src/modules/agent/routes.js` (`setIntakeStatus`: `POST /agent/intake-status` `{ protocol, status }`)
- Modify: `back-end/src/router.js` (role `agent`), `wrangler.jsonc` (already covered by `/agent/*`), `proxy.conf.json`, contract (`agentIntake` gains `status`; `intakeTransition` response)
- Test: `back-end/test/unit/agent-intake.test.js`, `back-end/test/integration/agent-intake.test.js`

- [ ] **Step 1: Migration**:

```sql
-- A human-owned state per handoff. received → in_review → closed, forward only. "closed" means a person finished the
-- review; the outcome is communicated by the bank's own channel. No refund, block or verdict is recorded here (ADR-002).
ALTER TABLE intake_handoffs ADD COLUMN status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','in_review','closed'));
CREATE TABLE handoff_status_history (
  handoff_id TEXT NOT NULL REFERENCES intake_handoffs(handoff_id),
  status TEXT NOT NULL CHECK (status IN ('in_review','closed')),
  changed_at INTEGER NOT NULL,
  agent_session_ref TEXT NOT NULL CHECK (length(agent_session_ref) = 12),
  UNIQUE(handoff_id, status)  -- forward-only machine: each status is reached at most once, so this is the invariant
);
```

- [ ] **Step 2: Failing tests**: `received → in_review` 200 with `{ protocol, status: 'in_review', changed_at }`; same transition again 200 (idempotent, no new history row); `in_review → closed` 200; `closed → in_review` 409; `received → closed` 409 (skipping is not allowed); unknown protocol 404; customer session 401; body with extra keys 422. History has exactly two rows after the two transitions. The customer's `GET /reports` shows `status: 'closed'` and `next_step: 'closed_by_person'`.
- [ ] **Step 3: Store**: the route receives the public `protocol`, which for a complete handoff is the **case id**, not the handoff id (`listIntakeHandoffs` selects `COALESCE(h.complete_case_id,h.handoff_id) AS protocol`). Every guard therefore resolves it the way `findIntakeHandoff` does: `TARGET = "(SELECT h.handoff_id FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) WHERE (h.complete_case_id=? OR (h.complete_case_id IS NULL AND h.handoff_id=?)) AND e.state=h.kind||'_handoff')"` (the state predicate keeps a pending reservation from being transitioned). One atomic batch with SQL guards (a decision on `meta.changes` cannot sit inside a batch): first `INSERT INTO handoff_status_history(handoff_id,status,changed_at,agent_session_ref) SELECT handoff_id,?,?,? FROM intake_handoffs WHERE handoff_id=TARGET AND status=?` with the expected previous status, then `UPDATE intake_handoffs SET status=? WHERE handoff_id=TARGET AND status=?`, then `SELECT status FROM intake_handoffs WHERE handoff_id=TARGET`. The route reads the final status: no row → 404; equal to the request → 200 (first time or replay, since the guarded insert matches nothing on a replay); otherwise 409. Still one round trip, so the ceiling below holds.
- [ ] **Step 4: Run** → PASS. Budget `agentTransition: [4, 4, 2, 2]` (session read, then the batch) measured. **Commit** `feat(agent): received → in_review → closed with history`.

### Task 4.2: Emails on transition

**Files:**
- Modify: `back-end/src/modules/agent/routes.js` (after a successful transition, `notify(... 'in_review' | 'closed' ...)` for the handoff's customer and language)
- Test: integration (two transitions → two outbox rows with the right templates; a replayed transition adds none)

- [ ] Failing test → implement → **Commit** `feat(notify): emails when a person picks up or closes a report`.

### Task 4.3: Agent view actions and customer status

**Files:**
- Modify: `front-end/src/app/features/agent/agent.page.*`, `agent.service.ts` (`setStatus`), `intake.model.ts`
- Modify: `front-end/src/app/features/customer/customer.page.*` (status chip per report; `closed` explains that the bank contacts you about the outcome)
- Modify: `lang.service.ts` (`statusInReview`, `statusClosed`, `takeCase`, `closeCase`, `closedExplain`)
- Test: `agent.page.spec.ts` (buttons appear by status; a 409 shows the mapped error; focus returns to the row), `customer.page.spec.ts`

- [ ] Failing specs → implement → run specs and build → **Commit** `feat(client): agent takes and closes a report; customer sees the status`.

### Task 4.4: One open report per charge (moved from Phase 0)

**Files:**
- Modify: `back-end/src/store/d1.js` (`openReportForTransaction(customerId, transactionId)`: `SELECT 1 FROM intake_handoffs h JOIN intake_episodes e USING(episode_id) WHERE e.customer_id=? AND h.kind='complete' AND h.status<>'closed' AND e.state='complete_handoff' AND json_extract(h.evidence_json,'$.transaction.transaction_id')=? LIMIT 1`)
- Modify: `back-end/src/modules/intake/routes.js` (`confirmIntake`: before the reservation, 409 `{detail:'This charge already has an open report'}` when the query returns a row; a replay of the same episode and key still returns its receipt first)
- Modify: `back-end/seeds/fictitious.json` (Ana gets `demo-tx-004` and `demo-tx-005`; `demo-tx-003` is Bruno's and `transaction_id` is the primary key), then re-render `back-end/seeds/seed_fictitious.sql` with `data_pipelines/gold/fictitious_seed.py` (the SQL is generated; never edit it by hand). Do **not** touch `test/integration/sample_seed.sql` (it seeds a cohort customer, not Ana).
- Modify the tests that confirm `demo-tx-001` from fresh episodes so each uses a distinct charge or closes the previous report first: `test/integration/budget.test.js:102` (runs last against the retained population, so it must use a charge no earlier test confirmed), `intake-handoff.test.js` (5 uses), `adversarial.test.js` (12 uses), `live-flow.test.js:33` (asserts Ana's set is exactly `{001, 002}`; becomes `{001, 002, 004, 005}`), `intake.test.js`
- Test: `back-end/test/integration/intake-handoff.test.js` (second confirm of the same charge from a new episode → 409; after an agent closes the first report → 201 again), `intake.test.js` (ten concurrent confirms of one charge from distinct episodes → exactly one 201; this is a check-then-write, so document that the batch's existing `NOT EXISTS` on the episode plus this read makes a duplicate possible only in a sub-millisecond race, and that the agent queue shows both if it happens)

- [ ] Failing tests → implement → budgets: `intakeConfirm` gains one query and one round trip (the read precedes the batch); record it → **Commit** `feat(intake): one open report per charge, released when a person closes it`.

### Task 4.5: Phase 4 PR

- [ ] Apply `0011_handoff_status.sql` `--remote` first. PR label `enhancement`. Body states explicitly: no refund, block or verdict action exists.

---

## Phase 5: Urgency lane and shadow reading

Branch `feat/urgency-and-shadow`.

### Task 5.1: Urgency policy

**Files:**
- Create: `back-end/src/modules/intake/urgency.js`, `back-end/src/config/urgency.json`
- Modify: `back-end/migrations/0011_handoff_status.sql` (append: `ALTER TABLE intake_handoffs ADD COLUMN urgency TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('normal','high'));`; `priority` keeps its `CHECK (priority = 'normal')`, which is why a new column is needed), same PR as Phase 4 if it has not merged; otherwise `0012_urgency.sql`
- Modify: `back-end/src/modules/intake/routes.js` (`confirmIntake` computes urgency from the customer's served purchases and the confirmed one), `store/d1.js` (`reserveIntakeHandoff` writes it; lists select it; agent queue orders `urgency='high'` first)
- Modify: receipt contract (`urgency`, `block_card_line`), `templates.js` (`{urgent}` paragraph), agent and customer clients (chip; the "call the bank to block your card" line with the fictitious demo number labelled as such)
- Test: `back-end/test/unit/urgency.test.js`, integration, Angular specs

`urgency.json` (a stated policy, not learned; DF-024): `{ "fixed": { "MXN": 10000, "COP": 1000000, "ARS": 300000, "USD": 500 }, "relative_min_others": 5, "demo_block_line": "+52 55 0000 0000 (demo)" }`.

- [ ] **Step 1: Failing unit test**: `urgencyOf(chosen, others, config)` is `'high'` when `chosen.amount >= fixed[currency]`, or when at least `relative_min_others` other purchases share the currency and `chosen.amount > p95(others)` (nearest-rank); else `'normal'`; amounts are strings, compared as numbers; an unknown currency uses only the relative rule.
- [ ] **Step 2: Implement** (about 20 lines), wire into `confirmIntake`. `finishIntake` reads only `findOwnedTransaction`, so the customer's served set costs **one extra query** (`listTransactions(customerId, 21)`); record it in the `intakeConfirm` ceiling. Write the column, add the receipt line. Templates: the urgent paragraph reads, in es, "Si no reconoces este cargo y la tarjeta sigue activa, llama al banco para bloquearla: {block_line}. Este servicio no bloquea tarjetas." (pt and en equivalents).
- [ ] **Step 3: Run** all → PASS. **Commit** `feat(intake): urgency lane by stated policy; block-your-card line`.

### Task 5.2: Extractor shadow on the not-found answer

**Files:**
- Modify: `back-end/src/modules/intake/routes.js` (`handoffIntake`: when `details` is present and `readyExtractor(env, approved)` returns an extractor, `ctx.waitUntil(extractShadow(...))` on the details text, recording usage only, exactly as `startIntake` does)
- Test: `back-end/test/unit/extractor-switch.test.js` (switch off → no call; switch on → one shadow call with the details text; the response is identical either way)

- [ ] Failing test → implement → **Commit** `feat(intake): shadow extraction on the not-found details`.

### Task 5.3: The shadow reading is visible to the agent

**Files:** `back-end/src/modules/agent/routes.js` (`getAgentIntakeDetail` already returns `history` from `intake_events`; add `model_version` and `llm_calls` from the episode's `intake_ended` event when present), the agent client (one line: "Lectura del modelo: en sombra, N llamadas, versión X" or "ninguna"), contract and specs.

- [ ] Failing test → implement → **Commit** `feat(agent): shadow model reading shown on the case`.

### Task 5.4: Phase 5 PR (label `enhancement`).

---

## Phase 6: Prove it, document it, present it

### Task 6.1: New-data rehearsal (Manoella pipeline, Lucas D1 and deploy)

- [ ] From a clean checkout: `make pipeline` → `make intake-cohort-slice COHORT_DB=… COHORT_QUALITY=… COHORT_AS_OF=<watermark>` → `run_cohort load --target local` → UI check → (after review) one remote part. Record counts, timings and the three stops in `Docs/Evidence/new-data-rehearsal.md`. This closes Diego's question D with evidence.

### Task 6.2: Documents

- [ ] `Docs/deliverables/SYSTEM_DESIGN.md`: "What we built" table gains sign-in, reports, status and notifications; the customer-experience section's "Planned" bullets move to "Built" where true; status date updated.
- [ ] The team page (artifact "ArabicaAI Product Flow"): correct "the `priority` column exists and is never set" to "`priority` is fixed to `normal` by its CHECK; urgency is a new column", and "migration 0009" for the status machine to "0011".
- [ ] `Docs/ADRs/ADR-007-…`: state that failed one-time-code attempts happen at Cognito and are visible in CloudTrail, not in `auth_events`.
- [ ] `Docs/deliverables/SYSTEM_DESIGN.md` and the README diagram note: Cognito and SES boxes, Access removed.
- [ ] `Docs/intake/intake-events.md`: no change to the event vocabulary; a note that status transitions are stored in `handoff_status_history` and are not intake events.
- [ ] `Docs/releases/README.md`: proposed `v0.2.0` "Submission" row with migrations 0009 to 0011, the Worker version and the secrets that must exist.
- [ ] `python3 scripts/check_doc_links.py` green. PR label `documentation`.

### Task 6.3: Pitch and video (Lucas, Roberto reviews)

- [ ] One slide: "rules decide, the model reads, and it stays off the path until it beats the rules on hidden cases". One slide: the judge as the customer (email, code, charges, report, inbox). The video follows the three steps on the live URL with a judge-enrolled address.

### Task 6.4: Final check (Roberto, Oct 4)

- [ ] On the deployed build: ES and PT, the three paths (complete, incomplete with details, technical), 320 px, both themes, a real email received for `received`, `in_review`, `closed` and `update`. Screenshots from the fictitious seed only, refreshed in `Docs/Evidence/screenshots/`.

---

## Open decisions this plan assumes (from the team page)

1. Promise wording: the safe lines above.
2. Email provider: SES from the Worker.
3. Urgency lane: in scope (Phase 5, first to drop).
4. Intro: stays; the promise is visible from the first frame.

Change any of them and the affected tasks change, nothing else.
