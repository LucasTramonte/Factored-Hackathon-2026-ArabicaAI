/** Bounded synthetic intake demo on Workers; D1 holds cases and sessions. */
const CUSTOMER_IDS = new Set(['demo-ana', 'demo-bruno', 'CLI-U53R5AZVLET0']);
const SESSION_MS = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}

function fail(status, detail) { return json({ detail }, status); }
function cookies(request) {
  return Object.fromEntries((request.headers.get('Cookie') || '').split(';').map(x => x.trim())
    .filter(x => x.includes('=')).map(x => { const at = x.indexOf('='); return [x.slice(0, at), x.slice(at + 1)]; }));
}
function cookieHeader(name, token, request) {
  const local = ['localhost', '127.0.0.1'].includes(new URL(request.url).hostname);
  return `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${local ? '' : '; Secure'}`;
}
async function tokenHash(token) {
  const bytes = new TextEncoder().encode(token);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(x => x.toString(16).padStart(2, '0')).join('');
}
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function bodyJson(request) {
  try { return await request.json(); } catch { return null; }
}
function basicAllowed(request, env) {
  if (!env.DEMO_ACCESS_USERNAME || !env.DEMO_ACCESS_PASSWORD) return null;
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Basic ')) return false;
  try {
    const decoded = atob(auth.slice(6));
    const at = decoded.indexOf(':');
    return at > 0 && decoded.slice(0, at) === env.DEMO_ACCESS_USERNAME
      && decoded.slice(at + 1) === env.DEMO_ACCESS_PASSWORD;
  } catch { return false; }
}
async function session(request, env, actor) {
  const token = cookies(request)[actor === 'agent' ? 'demo_agent_session' : 'demo_session'];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return env.DB.prepare('SELECT customer_id FROM sessions WHERE token_hash=? AND actor=? AND expires_at>?')
    .bind(await tokenHash(token), actor, Date.now()).first();
}
async function startSession(request, env, actor, customerId = null) {
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(Date.now()).run();
  const name = actor === 'agent' ? 'demo_agent_session' : 'demo_session';
  const old = cookies(request)[name];
  if (old && /^[0-9a-f]{64}$/.test(old)) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await tokenHash(old)).run();
  }
  const token = newToken();
  await env.DB.prepare('INSERT INTO sessions(token_hash,actor,customer_id,expires_at) VALUES(?,?,?,?)')
    .bind(await tokenHash(token), actor, customerId, Date.now() + SESSION_MS).run();
  return cookieHeader(name, token, request);
}
async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === '/healthz' && method === 'GET') {
    await env.DB.prepare('SELECT 1').first();
    return json({ status: 'ok' });
  }
  const gate = basicAllowed(request, env);
  if (gate === null) return fail(503, 'Demo access gate is not configured');
  if (!gate) return new Response('Team access required', {
    status: 401, headers: { 'WWW-Authenticate': 'Basic realm="ArabicaAI demo"', 'Cache-Control': 'no-store' }
  });
  if (path === '/demo/session' && method === 'POST') {
    const body = await bodyJson(request);
    if (!body || !CUSTOMER_IDS.has(body.customer_id)) return fail(422, 'Select an allowed demo identity');
    const customer = await env.DB.prepare('SELECT 1 FROM customers WHERE customer_id=?')
      .bind(body.customer_id).first();
    if (!customer) return fail(503, 'Demo identity is not loaded');
    return json({ customer_id: body.customer_id, mode: 'simulated_login' }, 200,
      { 'Set-Cookie': await startSession(request, env, 'customer', body.customer_id) });
  }
  if (path === '/transactions' && method === 'GET') {
    const current = await session(request, env, 'customer');
    if (!current) return fail(401, 'Start a demo session first');
    const rows = await env.DB.prepare(
      'SELECT transaction_id, occurred_at, source_occurred_at, merchant_name, amount, currency '
      + 'FROM transactions WHERE customer_id=? '
      + 'ORDER BY occurred_at DESC, source_occurred_at DESC, transaction_id LIMIT 21'
    ).bind(current.customer_id).all();
    return json({ items: rows.results.slice(0, 20), has_more: rows.results.length > 20,
      coverage: 'fictitious_demo_data_only' });
  }
  if (path === '/cases' && method === 'POST') {
    const current = await session(request, env, 'customer');
    if (!current) return fail(401, 'Start a demo session first');
    const body = await bodyJson(request);
    if (!body || body.customer_confirmed !== true) return fail(422, 'Explicit confirmation is required');
    const statement = typeof body.customer_statement === 'string' ? body.customer_statement.trim() : '';
    if (statement.length < 10 || statement.length > 2000) return fail(422, 'Describe the charge in 10–2000 characters');
    if (typeof body.transaction_id !== 'string' || !body.transaction_id || body.transaction_id.length > 100
        || typeof body.idempotency_key !== 'string' || !UUID.test(body.idempotency_key)) {
      return fail(422, 'Invalid transaction or request key');
    }
    const owned = await env.DB.prepare('SELECT 1 FROM transactions WHERE customer_id=? AND transaction_id=?')
      .bind(current.customer_id, body.transaction_id).first();
    if (!owned) return fail(404, 'Transaction not found for this session');
    let inserted;
    try {
      inserted = await env.DB.prepare(
        'INSERT INTO cases(case_id,customer_id,transaction_id,idempotency_key,customer_statement,customer_confirmed) '
        + 'VALUES(?,?,?,?,?,1) ON CONFLICT(customer_id,idempotency_key) DO NOTHING RETURNING case_id'
      ).bind(crypto.randomUUID(), current.customer_id, body.transaction_id,
        body.idempotency_key, statement).first();
    } catch {
      return fail(503, 'Acceptance not confirmed; retry with the same idempotency key');
    }
    const row = await env.DB.prepare(
      'SELECT case_id,transaction_id,customer_statement,status,accepted_at FROM cases '
      + 'WHERE customer_id=? AND idempotency_key=?'
    ).bind(current.customer_id, body.idempotency_key).first();
    if (!row) return fail(503, 'Acceptance not confirmed; retry with the same idempotency key');
    if (row.transaction_id !== body.transaction_id || row.customer_statement !== statement) {
      return fail(409, 'Key already used with different content');
    }
    return json({ protocol: row.case_id, transaction_id: row.transaction_id, status: row.status,
      accepted_at: row.accepted_at, replayed: !inserted, scope: 'synthetic_demo_only',
      next_step: 'Await review in the demo agent view; no refund initiated' }, inserted ? 201 : 200);
  }
  if (path === '/demo/agent-session' && method === 'POST') {
    return json({ role: 'agent', mode: 'simulated_login' }, 200,
      { 'Set-Cookie': await startSession(request, env, 'agent') });
  }
  if (path === '/agent/cases' && method === 'GET') {
    if (!await session(request, env, 'agent')) return fail(401, 'Start a demo agent session first');
    const rows = await env.DB.prepare(
      'SELECT c.case_id AS protocol,c.customer_id,u.display_name,c.transaction_id,t.merchant_name, '
      + 't.occurred_at,t.source_occurred_at,t.amount,t.currency,c.customer_statement, '
      + 'c.customer_confirmed,c.status,c.accepted_at FROM cases c '
      + 'JOIN customers u ON u.customer_id=c.customer_id '
      + 'JOIN transactions t ON t.transaction_id=c.transaction_id AND t.customer_id=c.customer_id '
      + 'ORDER BY c.accepted_at DESC,c.case_id LIMIT 51'
    ).all();
    return json({ items: rows.results.slice(0, 50).map(x => ({ ...x, customer_confirmed: !!x.customer_confirmed })),
      has_more: rows.results.length > 50, scope: 'synthetic_demo_only' });
  }
  if (['/demo', '/transactions', '/cases', '/agent', '/healthz', '/docs', '/redoc', '/openapi.json']
    .some(x => path === x || path.startsWith(x + '/'))) return fail(404, 'Not found');
  if (method !== 'GET' && method !== 'HEAD') return fail(405, 'Method not allowed');
  return env.ASSETS.fetch(request);
}

export default {
  /** Route every request through the team gate; never expose database errors or raw cases. */
  async fetch(request, env) {
    try { return await route(request, env); }
    catch { return fail(503, 'Demo service unavailable; retry later'); }
  }
};
