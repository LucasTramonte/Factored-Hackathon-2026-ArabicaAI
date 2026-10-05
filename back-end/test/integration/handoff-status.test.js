/** A person moves a handoff received → in_review → closed; each first step queues one email to the customer. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { client, idToken } from '../support/client.js';
import { assertContract } from '../support/contract.js';

const config = () => resolve(process.cwd(), 'wrangler.jsonc');
async function signedInReport() {
  const ana = client({ authorization: 'Bearer ' + await idToken('demo-ana') });
  assert.equal((await ana.call('/auth/session', {})).status, 200);
  const episode = (await ana.call('/intake/start', { language: 'es', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
    customer_statement: 'No reconozco este cargo.', idempotency_key: crypto.randomUUID() })).body.episode_id;
  const receipt = await ana.call('/intake/handoff', { episode_id: episode, kind: 'incomplete', idempotency_key: crypto.randomUUID() });
  assert.equal(receipt.status, 201);
  const agent = client(); assert.equal((await agent.call('/demo/agent-session', {})).status, 200);
  return { ana, agent, receipt: receipt.body };
}
async function rows(receipt) {
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  return withIntakeStore({ config: config() }, async store => ({
    history: await store.listStatusHistory(receipt.protocol),
    emails: (await store.findEmails('demo-ana', receipt.reference_short)).filter(r => r.template !== 'received').map(r => r.template) }));
}

test('received → in_review → closed, once each, with history, emails and the customer and agent views', async () => {
  const { ana, agent, receipt } = await signedInReport();
  const move = status => agent.call('/agent/intake-status', { protocol: receipt.protocol, status, ...(status === 'closed' ? { closing_note: 'Review finished; please contact the bank if you still need help.' } : {}) });
  assert.equal((await move('closed')).status, 409, 'received → closed skips a step');
  const first = await move('in_review');
  assert.equal(first.status, 200); assertContract('intakeTransition', first.body);
  assert.equal(first.body.status, 'in_review');
  let seen = await rows(receipt);
  assert.equal(seen.history.length, 1); assert.deepEqual(seen.emails, ['in_review']);
  const replay = await move('in_review');
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, first.body);
  seen = await rows(receipt);
  assert.equal(seen.history.length, 1, 'a replay adds no history'); assert.deepEqual(seen.emails, ['in_review'], 'nor an email');
  const queue = await agent.call('/agent/intakes'); assertContract('agentIntakeList', queue.body);
  assert.equal(queue.body.items.find(x => x.protocol === receipt.protocol).status, 'in_review');
  const closed = await move('closed');
  assert.equal(closed.status, 200); assertContract('intakeTransition', closed.body);
  assert.equal((await move('in_review')).status, 409, 'never backwards');
  seen = await rows(receipt);
  assert.deepEqual(seen.history.map(r => r.status), ['in_review', 'closed']); assert.deepEqual(seen.emails, ['in_review', 'closed']);
  assert.ok(seen.history.every(r => /^[0-9a-f]{12}$/.test(r.agent_session_ref)));
  const detail = await agent.call('/agent/intake-detail?protocol=' + receipt.protocol);
  assertContract('agentIntakeDetail', detail.body); assert.equal(detail.body.status, 'closed');
  const reports = await ana.call('/reports'); assertContract('reportList', reports.body);
  const mine = reports.body.items.find(x => x.protocol === receipt.protocol);
  assert.equal(mine.status, 'closed'); assert.equal(mine.next_step, 'closed_by_person');
});

test('intake-status refuses unknown protocols, customer sessions, no session and extra keys', async () => {
  const { ana, agent, receipt } = await signedInReport();
  const missing = await agent.call('/agent/intake-status', { protocol: crypto.randomUUID(), status: 'in_review' });
  assert.equal(missing.status, 404); assertContract('error', missing.body);
  const asCustomer = client(); asCustomer.cookie = ana.cookie.replace('demo_session=', 'demo_agent_session=');
  assert.equal((await asCustomer.call('/agent/intake-status', { protocol: receipt.protocol, status: 'in_review' })).status, 401);
  assert.equal((await ana.call('/agent/intake-status', { protocol: receipt.protocol, status: 'in_review' })).status, 401);
  for (const body of [{ protocol: receipt.protocol, status: 'in_review', customer_id: 'demo-ana' }, { protocol: receipt.protocol, status: 'refunded' }, { protocol: receipt.protocol }]) {
    const res = await agent.call('/agent/intake-status', body); assert.equal(res.status, 422, JSON.stringify(body)); assertContract('error', res.body);
  }
  assert.deepEqual((await rows(receipt)).history, []);
});

test('ten concurrent identical transitions record one history row and queue one email', async () => {
  const { agent, receipt } = await signedInReport();
  const results = await Promise.all(Array.from({ length: 10 }, () => agent.call('/agent/intake-status', { protocol: receipt.protocol, status: 'in_review' })));
  assert.deepEqual(results.map(r => r.status), Array(10).fill(200));
  assert.equal(new Set(results.map(r => r.body.changed_at)).size, 1);
  const seen = await rows(receipt);
  assert.equal(seen.history.length, 1); assert.deepEqual(seen.emails, ['in_review']);
});


test('closing requires a valid explanation, trims it, and keeps the first note immutable', async () => {
  const { ana, agent, receipt } = await signedInReport();
  const move = body => agent.call('/agent/intake-status', { protocol: receipt.protocol, status: 'closed', ...body });
  await agent.call('/agent/intake-status', { protocol: receipt.protocol, status: 'in_review' });
  for (const closing_note of [undefined, null, '', '  ', '😀'.repeat(2001), '\u0000', '\ud800']) {
    assert.equal((await move(closing_note === undefined ? {} : { closing_note })).status, 422);
  }
  assert.equal((await rows(receipt)).history.length, 1);
  const note = '<script>alert(1)</script> 😀 ' + '😀'.repeat(1968);
  const first = await move({ closing_note: '  ' + note + '  ' });
  assert.equal(first.status, 200);
  const replay = await move({ closing_note: note });
  assert.deepEqual(replay.body, first.body);
  assert.equal((await move({ closing_note: 'Another explanation' })).status, 409);
  const detail = await agent.call('/agent/intake-detail?protocol=' + receipt.protocol);
  assertContract('agentIntakeDetail', detail.body);
  assert.equal(detail.body.closing_note, note);
  const reports = await ana.call('/reports'); assertContract('reportList', reports.body);
  assert.equal(reports.body.items.find(x => x.protocol === receipt.protocol).closing_note, note);
  const seen = await rows(receipt);
  assert.deepEqual(seen.history.map(x => x.status), ['in_review', 'closed']);
  assert.deepEqual(seen.emails, ['in_review', 'closed']);
  assert.ok(!JSON.stringify(detail.body.history).includes(note));
});

test('two reviewers racing close keep only the winning explanation and one history/email', async () => {
  const { agent, receipt } = await signedInReport();
  await agent.call('/agent/intake-status', { protocol: receipt.protocol, status: 'in_review' });
  const other = client(); await other.call('/demo/agent-session', {});
  const notes = ['First reviewer explanation', 'Second reviewer explanation'];
  const responses = await Promise.all([agent, other].map((reviewer, i) => reviewer.call('/agent/intake-status',
    { protocol: receipt.protocol, status: 'closed', closing_note: notes[i] })));
  assert.deepEqual(responses.map(x => x.status).sort(), [200, 409]);
  const detail = await agent.call('/agent/intake-detail?protocol=' + receipt.protocol);
  assert.equal(detail.body.closing_note, notes[responses.findIndex(x => x.status === 200)]);
  const seen = await rows(receipt);
  assert.equal(seen.history.filter(x => x.status === 'closed').length, 1);
  assert.equal(seen.emails.filter(x => x === 'closed').length, 1);
});


test('2000 Unicode code points are accepted; an earlier closed null note stays immutable and owned', async () => {
  const { ana, agent, receipt } = await signedInReport();
  await agent.call('/agent/intake-status', { protocol: receipt.protocol, status: 'in_review' });
  const closing_note = '😀'.repeat(2000);
  assert.equal((await agent.call('/agent/intake-status', { protocol: receipt.protocol, status: 'closed', closing_note })).status, 200);
  const report = (await ana.call('/reports')).body.items.find(x => x.protocol === receipt.protocol);
  assert.equal([...report.closing_note].length, 2000);
  const foreign = client(); await foreign.call('/demo/session', { customer_id: 'demo-bruno' });
  assert.ok(!(await foreign.call('/reports')).body.items.some(x => x.protocol === receipt.protocol));
  const legacy = await signedInReport();
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  await withIntakeStore({ config: config() }, async store => {
    for (const [from, to] of [['received', 'in_review'], ['in_review', 'closed']]) {
      await store.transitionHandoff({ protocol: legacy.receipt.protocol, from, to, now: Date.now(), agentSessionRef: 'a'.repeat(12), emailId: crypto.randomUUID() });
    }
  });
  assert.equal((await legacy.agent.call('/agent/intake-status', { protocol: legacy.receipt.protocol, status: 'closed', closing_note: 'New explanation' })).status, 409);
  assert.equal((await legacy.agent.call('/agent/intake-detail?protocol=' + legacy.receipt.protocol)).body.closing_note, null);
  assert.equal((await legacy.ana.call('/reports')).body.items.find(x => x.protocol === legacy.receipt.protocol).closing_note, null);
});


test('close explanation cannot be written with forged, expired or swapped session authority', async () => {
  const { ana, agent, receipt } = await signedInReport();
  await agent.call('/agent/intake-status', { protocol: receipt.protocol, status: 'in_review' });
  const expiredToken = 'd'.repeat(64);
  const { tokenHash } = await import('../../src/auth/session.js');
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  await withIntakeStore({ config: config() }, async store => store.rotateSession({ now: Date.now(), oldHash: null,
    newHash: await tokenHash(expiredToken), actor: 'agent', customerId: null, expiresAt: 1, requestId: crypto.randomUUID() }));
  for (const cookie of ['', 'demo_agent_session=' + 'f'.repeat(64), 'demo_agent_session=' + expiredToken,
    ana.cookie.replace('demo_session=', 'demo_agent_session='), agent.cookie.replace('demo_agent_session=', 'demo_session=')]) {
    const attacker = client(); attacker.cookie = cookie;
    assert.equal((await attacker.call('/agent/intake-status', { protocol: receipt.protocol, status: 'closed', closing_note: 'Unauthorized note' })).status, 401);
  }
  assert.equal((await agent.call('/agent/intake-detail?protocol=' + receipt.protocol)).body.closing_note, null);
  assert.equal((await rows(receipt)).history.length, 1);
});
