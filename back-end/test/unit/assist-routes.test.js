/** Default-off guards and complete-request deadline without external credentials or provider calls. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewerAssist } from '../../src/modules/agent/assist-routes.js';
const request = () => new Request('https://demo.example/agent/intake-assist', { method: 'POST', headers: { Cookie: 'demo_agent_session=' + 'a'.repeat(64) }, body: JSON.stringify({ protocol: crypto.randomUUID(), request_id: crypto.randomUUID(), language: 'en' }) });
test('absent and non-string-one switches stop before context, reservation or provider', async () => {
  const store = { findSession: async () => ({ expires_at: Date.now() + 60000 }), findReviewerContext: () => assert.fail('no context'), reserveAssist: () => assert.fail('no reservation') };
  for (const enabled of [undefined, '0', 'true', 1, true]) {
    const response = await reviewerAssist(request(), { ASSIST_REVIEWER_ENABLED: enabled }, store, null, () => assert.fail('no model'));
    assert.equal(response.status, 503); assert.match((await response.json()).detail, /manual review/);
  }
});

test('elapsed context time aborts generation immediately and discards a late result', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let finished;
  const store = { findSession: async () => ({ expires_at: 200000 }),
    findReviewerContext: async () => { t.mock.timers.tick(10000); return { source: 'fictitious', status: 'received', message_count: 0, customer_statement: 'Original report text', messages_json: '[]' }; },
    reserveAssist: async () => 'reserved', assistSnapshot: async () => ({ status: 'received', message_count: 0 }),
    finishAssist: async value => { finished = value; } };
  const response = await reviewerAssist(request(), { ASSIST_REVIEWER_ENABLED: '1' }, store, null, async (env, args, options) => {
    assert.equal(options.signal.aborted, true);
    return { ok: false, kind: 'timeout', usage: { llm_calls: 0, known_input_tokens: 0, known_output_tokens: 0, usage_unavailable_calls: 0 } };
  });
  assert.equal(response.status, 503); assert.equal(finished.outcome, 'timeout'); assert.equal(finished.latencyMs, 10000);
});
