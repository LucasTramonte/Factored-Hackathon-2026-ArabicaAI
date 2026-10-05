/**
 * POST /auth/access-request (migration 0031): an evaluator who isn't enrolled asks the team for access. Run over the Worker's
 * own migrations in SQLite with a fake sender, so every email that would leave is visible. Adversarial: hostile bodies, the
 * method and path matrix, a concurrent burst for one address, the daily cap, missing configuration, a failed send, what D1 and
 * the log keep, the contract and the D1 cost.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createStore } from '../../src/store/d1.js';
import { route } from '../../src/router.js';
import { DAILY_CAP, requestAccess } from '../../src/modules/access/routes.js';
import { assertContract } from '../support/contract.js';

const ENV = { ACCESS_REQUEST_TO: 'team@example.com', SES_ACCESS_KEY_ID: 'AKIDEXAMPLE', SES_SECRET_ACCESS_KEY: 'secret',
  SES_REGION: 'us-east-2', SES_FROM: 'ArabicaAI <from@example.com>' };
const PATH = 'https://demo.example/auth/access-request';

function setup() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  const store = createStore({ prepare: sql => ({ bind: (...p) => ({ all: () => ({ results: db.prepare(sql).all(...p) }) }) }),
    batch: async statements => { db.exec('BEGIN'); try { const r = statements.map(s => s.all()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } });
  const sent = [];
  let ok = true;
  const send = async (env, mail) => { sent.push(mail); return ok ? { ok: true, messageId: 'm' } : { ok: false }; };
  const ask = async (body, { env = ENV, raw, url = PATH } = {}) => {
    const response = await requestAccess(new Request(url, { method: 'POST', body: raw ?? JSON.stringify(body) }), env, store, undefined, send);
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { db, store, sent, ask, failSends: () => { ok = false; }, restoreSends: () => { ok = true; } };
}
const rows = db => db.prepare('SELECT * FROM access_requests').all();

/** Every console.log line written while ``fn`` runs. */
async function logged(fn) {
  const lines = [], original = console.log;
  console.log = line => lines.push(String(line));
  try { await fn(); } finally { console.log = original; }
  return lines;
}

test('a request emails the team once, as typed, with a fixed subject; D1 keeps only a hash and the log only the outcome', async () => {
  const { db, sent, ask } = setup();
  const lines = await logged(async () => {
    const res = await ask({ email: ' Judge.One@Factored.ai ', name: 'Judge One', note: 'Assigned to ArabicaAI' });
    assert.equal(res.status, 200);
    assertContract('accessRequestReceipt', res.body);
    assert.deepEqual(res.body, { status: 'received' });
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'team@example.com');
  assert.equal(sent[0].subject, 'ArabicaAI demo: access request');
  assert.match(sent[0].text, /^Email: Judge\.One@Factored\.ai$/m);
  assert.match(sent[0].text, /^Name: Judge One$/m);
  assert.match(sent[0].text, /^Note: Assigned to ArabicaAI$/m);
  assert.match(sent[0].text, /Nothing was enrolled/);
  assert.equal(sent[0].html, undefined, 'plain text only: nothing the requester typed is rendered as HTML');
  const stored = JSON.stringify(rows(db));
  assert.equal(rows(db).length, 1);
  assert.match(rows(db)[0].email_hash, /^[0-9a-f]{64}$/);
  assert.ok(!/judge|factored/i.test(stored), 'no address, name or note in D1');
  assert.deepEqual(lines.map(l => JSON.parse(l)), [{ event: 'access_request', outcome: 'sent' }]);
});

test('the same address again the same day, in any case, answers the same and sends no second email', async () => {
  const { sent, ask } = setup();
  assert.equal((await ask({ email: 'judge@factored.ai' })).status, 200);
  for (const email of ['judge@factored.ai', 'JUDGE@factored.ai', ' judge@FACTORED.AI ']) {
    const again = await ask({ email, note: 'second try' });
    assert.deepEqual([again.status, again.body], [200, { status: 'received' }], email);
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text.includes('(not given)') && sent[0].text.includes('(none)'), true, 'optional fields are labelled when absent');
});

test('a concurrent burst for one address sends exactly one email', async () => {
  const { db, sent, ask } = setup();
  const answers = await Promise.all(Array.from({ length: 10 }, () => ask({ email: 'burst@factored.ai' })));
  assert.deepEqual(answers.map(a => a.status), Array(10).fill(200));
  assert.equal(sent.length, 1);
  assert.equal(rows(db).length, 1);
});

test('hostile or malformed bodies are 422 and touch neither D1 nor the team inbox', async () => {
  const { db, sent, ask } = setup();
  const bodies = [null, [], 'judge@factored.ai', {}, { email: '' }, { email: 'judge' }, { email: 'judge@' }, { email: '@factored.ai' },
    { email: 'judge@factored' }, { email: 'a b@factored.ai' }, { email: 'judge@factored.ai\r\nBcc: x@y.z' }, { email: '`id`@factored.ai' },
    { email: 'a$(id)@factored.ai' }, { email: '<script>@factored.ai' }, { email: 'judge@-factored.ai' }, { email: 7 },
    { email: 'x'.repeat(65) + '@factored.ai' }, { email: 'judge@' + 'a'.repeat(250) + '.ai' }, { email: 'judge@factored.ai', role: 'admin' },
    { email: 'judge@factored.ai', customer_id: 'demo-ana' }, { email: 'judge@factored.ai', name: 'x'.repeat(101) },
    { email: 'judge@factored.ai', note: 'x'.repeat(501) }, { email: 'judge@factored.ai', note: 5 }, { email: 'judge@factored.ai', name: ['a'] },
    { email: 'judge@factored.ai', note: 'a\0b' }, { email: 'judge@factored.ai', name: '\uD800' }];
  for (const body of bodies) assert.equal((await ask(body)).status, 422, JSON.stringify(body));
  assert.equal((await ask(null, { raw: '{"email":' })).status, 422, 'invalid JSON');
  assert.equal((await ask(null, { raw: JSON.stringify({ email: 'judge@factored.ai', note: 'x'.repeat(17000) }) })).status, 413, 'body over 16 KB');
  assert.equal((await ask({ email: 'judge@factored.ai' }, { url: PATH + '?email=x@y.z' })).status, 422, 'query string');
  assert.deepEqual([sent.length, rows(db).length], [0, 0]);
  const longest = await ask({ email: 'judge@factored.ai', name: 'n'.repeat(100), note: '\u{1F600}'.repeat(500) });
  assert.equal(longest.status, 200, 'limits count code points');
});

test(`at most ${DAILY_CAP} addresses a day reach the team; the next is 429 with Retry-After and sends nothing`, async () => {
  const { db, sent, ask } = setup();
  for (let i = 0; i < DAILY_CAP; i++) assert.equal((await ask({ email: `judge${i}@factored.ai` })).status, 200);
  const over = await ask({ email: 'one-more@factored.ai' });
  assert.equal(over.status, 429);
  assertContract('error', over.body);
  assert.equal(over.headers.get('Retry-After'), '3600');
  assert.equal(sent.length, DAILY_CAP);
  assert.equal((await ask({ email: 'judge0@factored.ai' })).status, 200, 'an address that already asked still gets its answer');
  db.prepare('UPDATE access_requests SET day=?').run(new Date(Date.now() - 86400000).toISOString().slice(0, 10));
  assert.equal((await ask({ email: 'one-more@factored.ai' })).status, 200, 'a new UTC day starts a new count');
});

test('without a valid recipient or any SES setting the route is 503 before D1 or SES', async () => {
  const { db, sent, ask } = setup();
  const variants = [{ ...ENV, ACCESS_REQUEST_TO: undefined }, { ...ENV, ACCESS_REQUEST_TO: 'not an address' },
    { ...ENV, ACCESS_REQUEST_TO: 'a@b.c\r\nBcc: x@y.z' }, ...['SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY', 'SES_REGION', 'SES_FROM'].map(k => ({ ...ENV, [k]: '' }))];
  for (const env of variants) {
    const res = await ask({ email: 'judge@factored.ai' }, { env });
    assert.equal(res.status, 503);
    assertContract('error', res.body);
  }
  assert.deepEqual([sent.length, rows(db).length], [0, 0]);
});

test('a failed send is 503 and releases the reservation, so the same person can retry', async () => {
  const { db, sent, ask, failSends, restoreSends } = setup();
  failSends();
  assert.equal((await ask({ email: 'judge@factored.ai' })).status, 503);
  assert.equal(rows(db).length, 0);
  restoreSends();
  assert.equal((await ask({ email: 'judge@factored.ai' })).status, 200);
  assert.equal(sent.length, 2);
});

test('rows older than seven days are deleted by the next request', async () => {
  const { db, ask } = setup();
  db.prepare("INSERT INTO access_requests(email_hash,day,token,created_at) VALUES ('old','2020-01-01','t',0),('recent',?,'t',0)")
    .run(new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10));
  assert.equal((await ask({ email: 'judge@factored.ai' })).status, 200);
  assert.deepEqual(rows(db).map(r => r.email_hash).filter(h => h.length < 64), ['recent']);
});

test('the route is public and POST-only, with no sub-paths, and costs one D1 round trip', async () => {
  const { store } = setup();
  const res = await route(new Request(PATH, { method: 'GET' }), {}, store);
  assert.deepEqual([res.status, res.headers.get('Allow')], [405, 'POST']);
  assert.equal((await route(new Request(PATH + '/x', { method: 'POST', body: '{}' }), {}, store)).status, 404);
  const unconfigured = await route(new Request(PATH, { method: 'POST', body: JSON.stringify({ email: 'judge@factored.ai' }) }), {}, store);
  assert.equal(unconfigured.status, 503, 'reachable without any session');
  const fresh = setup();
  await fresh.ask({ email: 'judge@factored.ai' });
  const { queries, roundTrips } = fresh.store.metrics();
  assert.deepEqual([queries, roundTrips], [3, 1], 'retention delete, conditional insert and read-back in one batch');
});
