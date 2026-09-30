/**
 * Per-request D1 budgets for one customer episode and one agent read. The ceilings are the
 * measured values plus a small margin. A new table scan or an extra query fails here before it
 * reaches the Free-plan limits in ADR-004. The measured numbers are printed for that ADR.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client } from '../support/client.js';

// Ceilings per request: [queries, rows_read, rows_written, round_trips]. D1 Free allows 50 queries per invocation;
// round trips drive latency (about 150 ms each when the Worker runs far from D1).
const CEILING = {
  login: [5, 10, 6, 3],
  list: [2, 25, 0, 2],
  create: [4, 12, 6, 4],
  agentLogin: [3, 6, 6, 1],
  agentList: [2, 250, 0, 2],
  intakeStart: [6, 8, 13, 2],
  intakeStartReplay: [6, 6, 3, 2],
  intakeConfirm: [18, 60, 25, 8],
  intakeConfirmReplay: [17, 40, 0, 7],
  intakeIncomplete: [14, 45, 17, 7],
  intakeQueue: [2, 325, 0, 2], // <=100 retained reservations, including 50 pending; no universal scan bound.
  completeDetail: [3, 15, 0, 3],
  incompleteDetail: [3, 10, 0, 3]
};

function within(name, m) {
  assert.ok(m, `${name}: X-D1-Metrics header missing (is DEMO_EXPOSE_DB_METRICS set?)`);
  const [q, r, w, t] = CEILING[name];
  assert.ok(m.queries <= q && m.rows_read <= r && m.rows_written <= w && m.round_trips <= t,
    `${name} exceeded budget: ${JSON.stringify(m)} > queries ${q}, rows_read ${r}, rows_written ${w}, round_trips ${t}`);
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


const startBody = () => ({ language:'es',mode:'guided',report_type:'unrecognized_charge',
  customer_statement:'No reconozco este cargo.',idempotency_key:crypto.randomUUID() });

test('guided endpoints and a full customer episode preserve measured D1 budgets', async () => {
  const c = client(); const measured = {};
  measured.login = within('login',(await c.call('/demo/session',{customer_id:'demo-ana'})).metrics);
  measured.list = within('list',(await c.call('/transactions')).metrics);
  const body = startBody();const start = await c.call('/intake/start',body);assert.equal(start.status,201);
  measured.start = within('intakeStart',start.metrics);
  measured.startReplay = within('intakeStartReplay',(await c.call('/intake/start',body)).metrics);
  const confirmation = {episode_id:start.body.episode_id,transaction_id:'demo-tx-001',customer_confirmed:true,idempotency_key:crypto.randomUUID()};
  const complete = await c.call('/intake/confirm',confirmation);assert.equal(complete.status,201);
  measured.confirm = within('intakeConfirm',complete.metrics);
  measured.confirmReplay = within('intakeConfirmReplay',(await c.call('/intake/confirm',confirmation)).metrics);
  const pending = await c.call('/intake/start',startBody());
  const incomplete = await c.call('/intake/handoff',{episode_id:pending.body.episode_id,kind:'incomplete',idempotency_key:crypto.randomUUID()});assert.equal(incomplete.status,201);
  measured.incomplete = within('intakeIncomplete',incomplete.metrics);
  const agent = client();await agent.call('/demo/agent-session',{});
  measured.queue = within('intakeQueue',(await agent.call('/agent/intakes')).metrics);
  measured.completeDetail = within('completeDetail',(await agent.call('/agent/intakes/'+complete.body.protocol)).metrics);
  measured.incompleteDetail = within('incompleteDetail',(await agent.call('/agent/intakes/'+incomplete.body.protocol)).metrics);
  const episode = ['login','list','start','confirm'].reduce((sum,k)=>({requests:sum.requests+1,
    queries:sum.queries+measured[k].queries,rows_read:sum.rows_read+measured[k].rows_read,
    rows_written:sum.rows_written+measured[k].rows_written,round_trips:sum.round_trips+measured[k].round_trips}),
    {requests:0,queries:0,rows_read:0,rows_written:0,round_trips:0});
  assert.ok(episode.queries<=31&&episode.rows_read<=95&&episode.rows_written<=44&&episode.round_trips<=15);
  console.log('D1_GUIDED_BUDGET '+JSON.stringify({per_request:measured,customer_episode:episode}));
});

test('50-row queue scan budget is qualified against 50 terminal and 50 pending tied reservations', async () => {
  const {withIntakeStore} = await import('../../scripts/intake-store.mjs');
  const {resolve} = await import('node:path');
  const {assertContract} = await import('../support/contract.js');
  // Bounded fixture: no source data, exactly 100 reservations with identical timestamps.
  const now = Date.parse('2027-01-01T12:00:00.000Z');const sessionHash='9'.repeat(64);
  await withIntakeStore({config:resolve(process.cwd(),'wrangler.jsonc')},async store=>{
    await store.rotateSession({now:Date.now(),oldHash:null,newHash:sessionHash,actor:'customer',customerId:'demo-ana',expiresAt:now+3600000});
    for(let i=0;i<100;i++) {
      const {episode} = await store.startIntake({customerId:'demo-ana',language:'es',statement:'No reconozco este cargo.',key:crypto.randomUUID(),now,expiresAt:now+3600000});
      const {handoff} = await store.persistIntakeHandoff({customerId:'demo-ana',episodeId:episode.episode_id,
        turnKey:crypto.randomUUID(),payloadHash:'budget',sessionHash,kind:'incomplete',evidence:null,actions:[],questions:[],usage:{tool_calls:0,operation_duration_ms:0},now});
      assert.ok(handoff);
      if(i<50){const receipt=await store.readIntakeReceipt('demo-ana',episode.episode_id,{sessionHash,now});
        assert.equal(await store.finishIntakeHandoff({customerId:'demo-ana',episode,receipt,sessionHash,now,operationDuration:0,toolCalls:0}),true);}
    }
  });
  const agent=client();await agent.call('/demo/agent-session',{});
  const queue=await agent.call('/agent/intakes');assert.equal(queue.status,200);assertContract('agentIntakeQueue',queue.body);
  assert.equal(queue.body.handoffs.length,50);assert.equal(queue.body.has_more,true);
  within('intakeQueue',queue.metrics);
  console.log('D1_FULL_QUEUE '+JSON.stringify({terminal:50,pending:50,tied:true,...queue.metrics}));
});
