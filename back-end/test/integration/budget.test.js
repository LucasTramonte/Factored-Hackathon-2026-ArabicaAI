/**
 * Per-request D1 budgets for one customer episode and one agent read. The ceilings are the
 * measured values plus a small margin. A new table scan or an extra query fails here before it
 * reaches the Free-plan limits in ADR-004. The measured numbers are printed for that ADR.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client } from '../support/client.js';

// Ceilings per request: [queries, rows_read, rows_written]. D1 Free allows 50 queries per invocation.
const CEILING = {
  login: [4, 8, 6],
  list: [2, 25, 0],
  create: [4, 12, 6],
  agentLogin: [3, 6, 6],
  agentList: [2, 250, 0]
};

function within(name, m) {
  assert.ok(m, `${name}: X-D1-Metrics header missing (is DEMO_EXPOSE_DB_METRICS set?)`);
  const [q, r, w] = CEILING[name];
  assert.ok(m.queries <= q && m.rows_read <= r && m.rows_written <= w,
    `${name} exceeded budget: ${JSON.stringify(m)} > queries ${q}, rows_read ${r}, rows_written ${w}`);
  return m;
}

test('a customer episode and an agent read stay within the D1 budget', async () => {
  const c = client();
  const measured = {};
  measured.login = within('login', (await c.call('/demo/session', { customer_id: 'demo-ana' })).metrics);
  measured.list = within('list', (await c.call('/transactions')).metrics);
  measured.create = within('create', (await c.call('/cases', { transaction_id: 'demo-tx-001',
    customer_statement: 'Budget probe: I do not recognize this charge.', customer_confirmed: true,
    idempotency_key: crypto.randomUUID() })).metrics);
  const agent = client();
  measured.agentLogin = within('agentLogin', (await agent.call('/demo/agent-session', {})).metrics);
  measured.agentList = within('agentList', (await agent.call('/agent/cases')).metrics);
  const episode = ['login', 'list', 'create'].reduce((sum, k) => ({
    requests: sum.requests + 1, queries: sum.queries + measured[k].queries,
    rows_read: sum.rows_read + measured[k].rows_read, rows_written: sum.rows_written + measured[k].rows_written
  }), { requests: 0, queries: 0, rows_read: 0, rows_written: 0 });
  console.log('D1_BUDGET ' + JSON.stringify({ per_request: measured, customer_episode: episode }));
});
