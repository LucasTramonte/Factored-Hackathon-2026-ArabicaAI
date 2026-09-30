/** Explicit guided-start validation; no free-text classification or client-supplied identity. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = 'customer_statement,idempotency_key,language,mode,report_type';
const invalid = detail => ({ error: { status: 422, detail } });

/** Require exactly the guided report fields and 10–2000 well-formed Unicode code points, excluding U+0000 (SQLite length stops there). */
export function validateStartRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== KEYS) {
    return invalid('Provide exactly the guided report fields');
  }
  if (!['es', 'pt'].includes(body.language) || body.mode !== 'guided' || body.report_type !== 'unrecognized_charge') {
    return invalid('Select an ES/PT guided unrecognized-charge report');
  }
  if (typeof body.customer_statement !== 'string' || !body.customer_statement.isWellFormed()) {
    return invalid('Statement must be valid Unicode text');
  }
  if (body.customer_statement.includes('\u0000')) return invalid('Statement must not contain U+0000');
  const statement = body.customer_statement.trim();
  const length = [...statement].length;
  if (length < 10 || length > 2000) return invalid('Describe the charge in 10–2000 characters');
  if (typeof body.idempotency_key !== 'string' || !UUID.test(body.idempotency_key)) return invalid('Invalid request key');
  return { value: { language: body.language, statement, key: body.idempotency_key } };
}

/** Accept only explicit confirmation or incomplete handoff fields; failure evidence stays server-controlled. */
export function validateHandoffRequest(body, complete) {
  const keys = complete ? 'customer_confirmed,episode_id,idempotency_key,transaction_id' : 'episode_id,idempotency_key,kind';
  if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== keys) return invalid('Provide exactly the handoff fields');
  if (typeof body.episode_id !== 'string' || !UUID.test(body.episode_id) || typeof body.idempotency_key !== 'string' || !UUID.test(body.idempotency_key)) return invalid('Invalid episode or request key');
  if (complete ? body.customer_confirmed !== true || typeof body.transaction_id !== 'string' || !body.transaction_id || body.transaction_id.length > 100 || !body.transaction_id.isWellFormed() || body.transaction_id.includes('\u0000') : body.kind !== 'incomplete') return invalid('Explicit owned confirmation or incomplete handoff required');
  return { value: { episodeId: body.episode_id, turnKey: body.idempotency_key, transactionId: complete ? body.transaction_id : null } };
}
