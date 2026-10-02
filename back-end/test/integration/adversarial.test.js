/**
 * Attempts to break sign-in, sessions, isolation and idempotency against the real local D1.
 * A test passes only when the attack fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertContract } from '../support/contract.js';
import { base, client, closeReport, idToken } from '../support/client.js';

const API = { '/demo/identities': 'GET', '/demo/session': 'POST', '/auth/logout': 'POST', '/transactions': 'GET', '/cases': 'POST', '/intake/start': 'POST',
  '/intake/confirm': 'POST', '/intake/handoff': 'POST', '/demo/agent-session': 'POST', '/agent/cases': 'GET', '/agent/intakes': 'GET',
  '/agent/intake-detail': 'GET', '/agent/intake-status': 'POST', '/reports': 'GET', '/reports/update': 'POST' };
const wrong = 'Basic ' + Buffer.from('local-reviewer:wrong').toString('base64');
const uuid = () => crypto.randomUUID();

async function loggedIn(customerId = 'demo-ana') {
  const c = client();
  assert.equal((await c.call('/demo/session', { customer_id: customerId })).status, 200);
  return c;
}

const NON_CUSTOMER = path => path.startsWith('/demo/') || path.startsWith('/agent/');

test('agent routes have no Basic gate: without an agent session the handler answers 401, other methods 405', async () => {
  const ana = await loggedIn();
  for (const path of Object.keys(API).filter(path => path.startsWith('/agent/'))) {
    for (const headers of [{}, { Authorization: wrong }, { Authorization: 'Bearer x' }, { Cookie: ana.cookie },
      { Cookie: ana.cookie.replace('demo_session', 'demo_agent_session') }]) {
      for (const method of ['GET', 'POST', 'HEAD', 'OPTIONS', 'DELETE']) {
        const res = await fetch(base + path, { method, headers });
        const label = `${method} ${path} with ${JSON.stringify(headers)}`;
        assert.equal(res.headers.get('WWW-Authenticate'), null, label);
        assert.equal(res.headers.get('set-cookie'), null, label);
        if (method !== API[path]) {
          assert.equal(res.status, 405, label);
          assert.equal(res.headers.get('Allow'), API[path]);
        } else {
          assert.equal(res.status, 401, label);
          assert.deepEqual(await res.json(), { detail: 'Start a demo agent session first' });
        }
      }
    }
  }
});

test('agent sign-in: a verified agent-group token starts an agent session; any other token never does', async () => {
  const agent = client({ authorization: 'Bearer ' + await idToken('agent@test', { groups: ['agent'] }) });
  const signedIn = await agent.call('/demo/agent-session', { role: 'admin' });
  assert.equal(signedIn.status, 200);
  assertContract('agentSession', signedIn.body);
  assert.equal(signedIn.body.mode, 'email_otp');
  assert.match(agent.cookie, /^demo_agent_session=[0-9a-f]{64}$/);
  const session = client();
  session.cookie = agent.cookie;
  assert.equal((await session.call('/agent/intakes')).status, 200);
  assert.equal((await session.call('/transactions')).status, 401, 'an agent session is not a customer session');

  const customer = await client({ authorization: 'Bearer ' + await idToken('demo-ana') }).call('/demo/agent-session', {});
  assert.equal(customer.status, 403);
  assert.deepEqual(customer.body, { detail: 'This account is not an agent in the demo' });
  assert.equal(customer.headers.get('set-cookie'), null);
  const token = await idToken('agent@test', { groups: ['agent'] });
  const at = token.length - 5;
  const tampered = token.slice(0, at) + (token[at] === 'A' ? 'B' : 'A') + token.slice(at + 1);
  for (const [authorization, status] of [['Bearer ' + tampered, 401], ['Bearer x', 422], [wrong, 422]]) {
    const res = await client({ authorization }).call('/demo/agent-session', {});
    assert.equal(res.status, status, authorization.slice(0, 12));
    assert.equal(res.headers.get('set-cookie'), null);
  }
});

test('customer routes: without a session the allowed method gets the session 401, others 405', async () => {
  for (const [path, allowed] of Object.entries(API).filter(([path]) => !NON_CUSTOMER(path))) {
    for (const authorization of [null, wrong]) {
      for (const method of ['GET', 'POST', 'HEAD', 'OPTIONS', 'DELETE']) {
        const res = await fetch(base + path, { method, headers: authorization ? { Authorization: authorization } : {} });
        assert.equal(res.headers.get('WWW-Authenticate'), null, `${method} ${path}`);
        if (method !== allowed) {
          assert.equal(res.status, 405, `${method} ${path}`);
          assert.equal(res.headers.get('Allow'), allowed);
        } else if (path === '/auth/logout') {
          assert.equal(res.status, 204, 'logout without a session reveals nothing');
        } else {
          assert.equal(res.status, 401, `${method} ${path}`);
          assert.deepEqual(await res.json(), { detail: 'Start a demo session first' });
          assert.equal(res.headers.get('set-cookie'), null);
        }
      }
    }
  }
});

test('wrong methods get 405 and unknown API paths get JSON 404', async () => {
  for (const [path, allowed] of Object.entries(API)) {
    const method = allowed === 'GET' ? 'POST' : 'GET';
    const res = await fetch(base + path, { method });
    assert.equal(res.status, 405, `${method} ${path}`);
    assert.equal(res.headers.get('Allow'), allowed);
  }
  for (const path of ['/cases/', '/cases/x', '/agent/', '/agent/cases/extra', '/demo/other', '/transactions/1', '/intake', '/intake/',
    '/intake/confirm/extra', '/agent/intakes/extra', '/agent/intake-detail/x', '/reports/', '/reports/x']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 404, path);
    assertContract('error', await res.json());
  }
});

test('/auth/session: POST only, and a token-less call never reaches verification', async () => {
  const none = await fetch(base + '/auth/session', { method: 'POST' });
  assert.equal(none.status, 422);
  assertContract('error', await none.json());
  const get = await fetch(base + '/auth/session');
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST');
});

test('email sign-in: only a correctly signed token for a loaded customer starts a session, and only for that customer', async () => {
  const ana = client({ authorization: 'Bearer ' + await idToken('demo-ana') });
  const signedIn = await ana.call('/auth/session', { customer_id: 'demo-carla' });
  assert.equal(signedIn.status, 200);
  assertContract('emailSession', signedIn.body);
  assert.equal(signedIn.body.customer_id, 'demo-ana');
  assert.doesNotMatch(signedIn.text, /test@example|eyJ/);
  const gated = client();
  gated.cookie = ana.cookie;
  const own = await gated.call('/transactions');
  assert.equal(own.status, 200);
  assert.ok(own.body.items.some(t => t.transaction_id === 'demo-tx-001'));
  assert.deepEqual(own.body, (await (await loggedIn('demo-ana')).call('/transactions')).body, 'same rows as Ana');
  const asAgent = client();
  asAgent.cookie = `demo_agent_session=${ana.cookie.split('=')[1]}`;
  assert.equal((await asAgent.call('/agent/cases')).status, 401, 'customer token used as agent');
  gated.cookie = ana.cookie.replace('demo_session', 'demo_agent_session');
  assert.equal((await gated.call('/agent/intakes')).status, 401);

  const unknown = await client({ authorization: 'Bearer ' + await idToken('CLI-NOT-LOADED') }).call('/auth/session', {});
  assert.equal(unknown.status, 403);
  assert.deepEqual(unknown.body, { detail: 'This account is not enrolled in the demo' });
  assert.equal(unknown.headers.get('set-cookie'), null);
  const agentGroup = await client({ authorization: 'Bearer ' + await idToken('demo-ana', { groups: ['agent'] }) }).call('/auth/session', {});
  assert.equal(agentGroup.status, 403);

  const token = await idToken('demo-ana');
  const at = token.length - 5;
  const tampered = token.slice(0, at) + (token[at] === 'A' ? 'B' : 'A') + token.slice(at + 1);
  const forged = await client({ authorization: 'Bearer ' + tampered }).call('/auth/session', {});
  assert.equal(forged.status, 401);
  assert.deepEqual(forged.body, { detail: 'Sign-in could not be verified' });
  assert.equal(forged.headers.get('set-cookie'), null);
});

test('path tricks never create a case without a session, nor through a non-canonical path with one', async () => {
  const ana = await loggedIn();
  const body = JSON.stringify({ transaction_id: 'demo-tx-001', customer_statement: 'I do not recognize this charge.',
    customer_confirmed: true, idempotency_key: uuid() });
  for (const path of ['//cases', '/CASES', '/cases?x=1', '/transactions/../cases', '/./cases', '/cases%2F']) {
    // fetch normalises dot segments, so those reach /cases itself: with a session that is the real route.
    const canonical = new URL(base + path).pathname === '/cases';
    for (const cookie of canonical ? [''] : ['', ana.cookie]) {
      const res = await fetch(base + path, { method: 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body });
      assert.notEqual(res.status, 201, path);
      assert.doesNotMatch(await res.text(), /"protocol"/, path);
    }
  }
});

test('health never leaks internals', async () => {
  const text = await (await fetch(base + '/healthz')).text();
  assert.doesNotMatch(text, /sqlite|d1|error|stack/i);
  assert.equal((await fetch(base + '/healthz', { method: 'POST' })).status, 405);
});

test('sessions: actors cannot swap, forged or expired tokens fail, login revokes the old token', async () => {
  const ana = await loggedIn();
  const token = ana.cookie.split('=')[1];
  const asAgent = client();
  asAgent.cookie = `demo_agent_session=${token}`;
  assert.equal((await asAgent.call('/agent/cases')).status, 401, 'customer token used as agent');

  const agent = client();
  await agent.call('/demo/agent-session', {});
  const agentToken = agent.cookie.split('=')[1];
  const asCustomer = client();
  asCustomer.cookie = `demo_session=${agentToken}`;
  assert.equal((await asCustomer.call('/transactions')).status, 401, 'agent token used as customer');

  for (const forged of ['f'.repeat(64), token.slice(0, 63) + (token.at(-1) === 'a' ? 'b' : 'a'), token.toUpperCase(),
    token + '0', `${'f'.repeat(64)}; demo_session=${token}`, process.env.EXPIRED_TOKEN]) {
    const c = client();
    c.cookie = `demo_session=${forged}`;
    assert.equal((await c.call('/transactions')).status, 401, `token ${forged.slice(0, 12)}…`);
  }

  const before = ana.cookie;
  await ana.call('/demo/session', { customer_id: 'demo-ana' });
  assert.notEqual(ana.cookie, before);
  const stale = client();
  stale.cookie = before;
  assert.equal((await stale.call('/transactions')).status, 401, 'old token survives a new login');
  assert.equal((await ana.call('/transactions')).status, 200);
});

test('login rejects identities outside the allowlist, including ones that exist in data', async () => {
  const c = client();
  for (const customer_id of ['demo-carla', 'CLI-OTHER', '', null, 42, ['demo-ana'], "demo-ana' OR '1'='1"]) {
    const res = await c.call('/demo/session', { customer_id });
    assert.equal(res.status, 422, String(customer_id));
    assertContract('error', res.body);
  }
  assert.equal((await c.call('/demo/session', '{bad json')).status, 422);
});

test('dataset customers are listed from D1 and log in; other D1 rows and unlisted ids are refused', async () => {
  const ids = await client().call('/demo/identities');
  assert.equal(ids.status, 200);
  assertContract('identityList', ids.body);
  const listed = new Map(ids.body.items.map(x => [x.customer_id, x]));
  assert.deepEqual(listed.get('CLI-COHORT-1'), { customer_id: 'CLI-COHORT-1', display_name: 'Zoë O.', country: 'México' });
  assert.equal(listed.get('demo-ana').country, null);
  assert.ok(!listed.has('demo-hidden'), 'a fictitious D1 row that is not committed is never offered');
  assert.equal((await client().call('/demo/session', { customer_id: 'demo-hidden' })).status, 422);
  assert.equal((await client().call('/demo/session', { customer_id: 'CLI-COHORT-9' })).status, 422);
  const zoe = await loggedIn('CLI-COHORT-1');
  const rows = await zoe.call('/transactions');
  assertContract('transactionList', rows.body);
  assert.equal(rows.body.coverage, 'dataset_cohort');
  assert.deepEqual(rows.body.items.map(x => x.transaction_id), ['cohort-tx-1']);
  assert.equal((await loggedIn('demo-ana').then(c => c.call('/transactions'))).body.coverage, 'fictitious_demo_data_only');
  // Another cohort customer's charge and a missing one look the same.
  const make = transaction_id => ({ transaction_id, customer_statement: 'No reconozco este cargo.',
    customer_confirmed: true, idempotency_key: uuid() });
  const foreign = await zoe.call('/cases', make('cohort-tx-2'));
  const missing = await zoe.call('/cases', make('cohort-tx-9'));
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, missing.body);
});

test('isolation: a foreign transaction and a missing one look identical', async () => {
  const bruno = await loggedIn('demo-bruno');
  const make = transaction_id => ({ transaction_id, customer_statement: 'I do not recognize this charge.',
    customer_confirmed: true, idempotency_key: uuid() });
  const foreign = await bruno.call('/cases', make('demo-tx-001'));
  const missing = await bruno.call('/cases', make('demo-tx-999'));
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(foreign.body, missing.body);
  assert.ok(!(await bruno.call('/transactions')).body.items.some(x => x.transaction_id === 'demo-tx-001'));
});

test('hostile input is stored as data or rejected, never executed', async () => {
  const ana = await loggedIn();
  const statement = "'); DELETE FROM cases; DROP TABLE sessions; -- not mine";
  const res = await ana.call('/cases', { transaction_id: 'demo-tx-002', customer_statement: statement,
    customer_confirmed: true, idempotency_key: uuid() });
  assert.equal(res.status, 201);
  const agent = client();
  await agent.call('/demo/agent-session', {});
  const listed = await agent.call('/agent/cases');
  assert.ok(listed.body.items.some(x => x.customer_statement === statement));
  assert.equal((await ana.call('/transactions')).status, 200, 'sessions table still exists');

  const huge = await ana.call('/cases', JSON.stringify({ transaction_id: 'demo-tx-002', customer_statement: 'x'.repeat(20_000),
    customer_confirmed: true, idempotency_key: uuid() }));
  assert.equal(huge.status, 413);
  for (const body of ['{"customer_confirmed": true', '[]', '"text"',
    '{"__proto__": {"customer_confirmed": true}, "transaction_id": "demo-tx-002", "customer_statement": "I do not recognize this charge.", "idempotency_key": "0f8fad5b-d9cb-469f-a165-70867728950e"}']) {
    assert.equal((await ana.call('/cases', body)).status, 422, body.slice(0, 30));
  }
});

test('concurrent submissions with one key create exactly one case', async () => {
  const ana = await loggedIn();
  const request = { transaction_id: 'demo-tx-002', customer_statement: 'Parallel retries of the same report.',
    customer_confirmed: true, idempotency_key: uuid() };
  const results = await Promise.all(Array.from({ length: 10 }, () => fetch(base + '/cases', {
    method: 'POST', headers: { Cookie: ana.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(request) }).then(async r => ({ status: r.status, body: await r.json() }))));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
  assert.equal(new Set(results.map(r => r.body.protocol)).size, 1);
  for (const r of results) assertContract('caseReceipt', r.body);
});

const guidedStart = (c, language = 'es') => c.call('/intake/start', { language, mode: 'guided', report_type: 'unrecognized_charge',
  customer_statement: language === 'es' ? 'No reconozco este cargo.' : 'Não reconheço esta cobrança.', idempotency_key: uuid() });

test('path tricks on the guided routes never confirm without a session or return evidence through a non-canonical path', async () => {
  const ana = await loggedIn();
  const episode = (await guidedStart(ana)).body.episode_id;
  const confirm = JSON.stringify({ episode_id: episode, transaction_id: 'demo-tx-001', customer_confirmed: true, idempotency_key: uuid() });
  for (const path of ['//intake/confirm', '/INTAKE/confirm', '/intake/confirm?x=1', '/intake/../intake/confirm', '/./intake/confirm',
    '/intake/confirm%2F', '/intake//confirm', '/intake/handoff?kind=incomplete']) {
    // Dot segments and query strings reach the real route, where only a session may confirm.
    const canonical = ['/intake/confirm', '/intake/handoff'].includes(new URL(base + path).pathname);
    for (const cookie of canonical ? [''] : ['', ana.cookie]) {
      const res = await fetch(base + path, { method: 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: confirm });
      assert.notEqual(res.status, 201, path);
      assert.doesNotMatch(await res.text(), /"protocol"/, path);
    }
  }
  const agent = client(); await agent.call('/demo/agent-session', {});
  // fetch resolves dot segments, so that one reaches /agent/intakes itself: with an agent session it is the real route.
  // Redirects are not followed: a look-alike may redirect to the real route (which then needs the session), never answer with data.
  for (const path of ['//agent/intake-detail?protocol=' + episode, '/AGENT/intakes', '/%61gent/intakes', '//agent/intakes', '/agent/../agent/intakes',
    '/agent/intakes%2F']) {
    for (const cookie of path.includes('..') ? ['', ana.cookie] : ['', ana.cookie, agent.cookie]) {
      const res = await fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
      assert.doesNotMatch(await res.text(), /customer_statement|"items"|No reconozco/, `${path} ${res.status}`);
      const loc = res.headers.get('location');
      assert.ok(loc === null || (new URL(loc, base).origin === base && /^\/(?!\/)/.test(new URL(loc, base).pathname)), path);
    }
  }
  const real = await ana.call('/intake/confirm', JSON.parse(confirm));
  assert.equal(real.status, 201, 'the real route still works with the session');
  await closeReport(real.body.protocol); // releases demo-tx-001 for later tests
});

test('isolation on guided routes: foreign and missing episodes or transactions look identical', async () => {
  const ana = await loggedIn(); const bruno = await loggedIn('demo-bruno');
  const anaEpisode = (await guidedStart(ana)).body.episode_id;
  const brunoEpisode = (await guidedStart(bruno, 'pt')).body.episode_id;
  const confirm = (episode_id, transaction_id) => ({ episode_id, transaction_id, customer_confirmed: true, idempotency_key: uuid() });
  const handoff = episode_id => ({ episode_id, kind: 'incomplete', idempotency_key: uuid() });
  for (const [route, foreign, missing] of [
    ['/intake/confirm', confirm(anaEpisode, 'demo-tx-003'), confirm(uuid(), 'demo-tx-003')],
    ['/intake/handoff', handoff(anaEpisode), handoff(uuid())],
    ['/intake/confirm', confirm(brunoEpisode, 'demo-tx-001'), confirm(brunoEpisode, 'demo-tx-999')]]) {
    const a = await bruno.call(route, foreign), b = await bruno.call(route, missing);
    assert.equal(a.status, 404, route); assert.equal(b.status, 404, route);
    assert.equal(a.text, b.text, `${route}: foreign and missing bodies are identical`);
    assertContract('error', a.body);
  }
  assert.equal((await ana.call('/intake/handoff', handoff(anaEpisode))).status, 201, "ana's episode was never touched");
});

test('concurrent identical incomplete handoffs create one reservation and one receipt', async () => {
  const ana = await loggedIn();
  const episode = (await guidedStart(ana)).body.episode_id;
  const body = { episode_id: episode, kind: 'incomplete', idempotency_key: uuid() };
  const results = await Promise.all(Array.from({ length: 10 }, () => fetch(base + '/intake/handoff', {
    method: 'POST', headers: { Cookie: ana.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }))));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
  assert.equal(new Set(results.map(r => r.body.protocol)).size, 1);
  for (const r of results) assertContract('intakeReceipt', r.body);
  const agent = client(); await agent.call('/demo/agent-session', {});
  const detail = await agent.call('/agent/intake-detail?protocol=' + results[0].body.protocol);
  assert.deepEqual(detail.body.history.map(e => e.event), ['intake_started', 'handoff_created', 'intake_ended'], 'one chain');
});

test('divergent concurrent confirmations and handoff on one episode leave exactly one reservation and chain', async () => {
  const ana = await loggedIn();
  const agent = client(); await agent.call('/demo/agent-session', {});
  for (let trial = 0; trial < 3; trial++) {
    const episode = (await guidedStart(ana)).body.episode_id;
    const bodies = [['/intake/confirm', { episode_id: episode, transaction_id: 'demo-tx-001', customer_confirmed: true, idempotency_key: uuid() }],
      ['/intake/confirm', { episode_id: episode, transaction_id: 'demo-tx-002', customer_confirmed: true, idempotency_key: uuid() }],
      ['/intake/handoff', { episode_id: episode, kind: 'incomplete', idempotency_key: uuid() }]];
    const results = await Promise.all([...bodies, ...bodies].map(([path, body]) => fetch(base + path, {
      method: 'POST', headers: { Cookie: ana.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) }).then(async r => ({ path, body, status: r.status, json: await r.json() }))));
    const won = results.filter(r => r.status === 201);
    assert.equal(won.length, 1, `trial ${trial}: ${results.map(r => r.status)}`);
    assert.ok(results.every(r => [200, 201, 409].includes(r.status)), results.map(r => r.status).join());
    const winner = won[0];
    for (const r of results) {
      if (r.status === 200) { assert.equal(r.body, winner.body, 'only the identical duplicate replays'); assert.equal(r.json.protocol, winner.json.protocol); }
      if (r.status === 409) assert.notEqual(r.body, winner.body);
    }
    assert.equal(results.filter(r => r.status === 200).length, 1);
    const detail = await agent.call('/agent/intake-detail?protocol=' + winner.json.protocol);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.history.filter(e => e.event === 'intake_ended').length, 1, 'one end event');
    assert.equal(detail.body.history.filter(e => e.event === 'handoff_created').length, 1, 'one reservation');
    for (const [path, body] of bodies) {
      const again = await ana.call(path, body);
      assert.equal(again.status, body === winner.body ? 200 : 409, 'retries agree with the outcome');
    }
    if (winner.path === '/intake/confirm') await closeReport(winner.json.protocol); // the next trial races on both charges again
  }
});

test('logout revokes the session server-side, for every holder of the token', async () => {
  const c = await loggedIn();
  const copy = client();
  copy.cookie = c.cookie;
  assert.equal((await c.call('/transactions')).status, 200);
  const out = await c.call('/auth/logout', {});
  assert.equal(out.status, 204);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await c.call('/transactions')).status, 401);
  assert.equal((await copy.call('/transactions')).status, 401);
});
