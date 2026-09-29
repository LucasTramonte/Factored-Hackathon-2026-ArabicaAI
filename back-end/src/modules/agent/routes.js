/** Agent routes: a separate simulated session and a read-only view of accepted cases. */
import { fail, json } from '../../http.js';
import { readSession, startSession } from '../../auth/session.js';

const PAGE = 50;

/** POST /demo/agent-session: start a simulated agent session. */
export async function startAgentSession(request, env, store) {
  return json({ role: 'agent', mode: 'simulated_login' }, 200,
    { 'Set-Cookie': await startSession(request, store, 'agent') });
}

/** GET /agent/cases: newest accepted cases with their transaction evidence. */
export async function listAgentCases(request, env, store) {
  if (!await readSession(request, store, 'agent')) return fail(401, 'Start a demo agent session first');
  const rows = await store.listAgentCases(PAGE + 1);
  return json({ items: rows.slice(0, PAGE).map(row => ({ ...row, customer_confirmed: row.customer_confirmed === 1 })),
    has_more: rows.length > PAGE, scope: 'synthetic_demo_only' });
}
