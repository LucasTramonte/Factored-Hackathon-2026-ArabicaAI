/** Agent routes: a separate simulated session and a read-only view of accepted cases. */
import { fail, json } from '../../http.js';
import { readSession, startSession } from '../../auth/session.js';
import { UUID } from '../intake/validation.js';

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

/** GET /agent/intakes: newest acknowledged handoffs, including technical and incomplete receipts. */
export async function listAgentIntakes(request, env, store) {
  if (!await readSession(request, store, 'agent')) return fail(401, 'Start a demo agent session first');
  const rows = await store.listIntakeHandoffs(PAGE + 1);
  return json({ items: rows.slice(0, PAGE), has_more: rows.length > PAGE, scope: 'synthetic_demo_only' });
}

/** GET /agent/intake-detail: access-controlled source statement, owned evidence and persisted service history. */
export async function getAgentIntakeDetail(request, env, store) {
  if (!await readSession(request, store, 'agent')) return fail(401, 'Start a demo agent session first');
  const params = new URL(request.url).searchParams;
  const protocol = params.get('protocol');
  if ([...params.keys()].join() !== 'protocol' || !UUID.test(protocol ?? '')) {
    return fail(422, 'Provide exactly one valid protocol');
  }
  const row = await store.findIntakeHandoff(protocol);
  if (!row) return fail(404, 'Intake handoff not found');
  const evidence = JSON.parse(row.evidence_json).transaction;
  const transaction = row.verified_transaction_id && evidence?.transaction_id === row.verified_transaction_id
    ? Object.fromEntries(['transaction_id', 'occurred_at', 'source_occurred_at', 'merchant_name', 'amount', 'currency'].map(key => [key, evidence[key]])) : null;
  const events = await store.listIntakeHistory(row.episode_id);
  const historyKeys = ['seq', 'event', 'ts', 'transaction_ref', 'case_ref', 'kind', 'tool_status', 'accepted_by', 'outcome', 'missing'];
  const history = events.slice(0, 100).map(({ event_json }) => {
    const event = JSON.parse(event_json);
    return Object.fromEntries(historyKeys.filter(key => key in event).map(key => [key, event[key]]));
  });
  return json({ protocol: row.protocol, episode_id: row.episode_id, kind: row.kind, tool_status: row.tool_status,
    destination: row.destination, priority: row.priority, accepted_at: row.accepted_at, language: row.language,
    customer_statement: row.customer_statement, verified_evidence: { transaction },
    actions_taken: JSON.parse(row.actions_json), unresolved_questions: JSON.parse(row.questions_json),
    history, history_has_more: events.length > 100, scope: 'synthetic_demo_only' });
}
