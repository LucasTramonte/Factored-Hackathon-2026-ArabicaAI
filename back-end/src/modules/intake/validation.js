/** Explicit guided-start validation; no free-text classification or client-supplied identity. */
/** RFC 4122 UUID (versions 1-8), the shape of every client key, episode id and protocol. Input is case-insensitive;
 * callers store and compare the lowercase form, so a case-changed retry replays instead of forking. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = 'customer_statement,idempotency_key,language,mode,reason,report_type';
/** Why the customer doesn't recognise the charge (ADR-010); the migration's CHECK mirrors this list. */
export const REASONS = ['not_mine', 'duplicate', 'wrong_amount', 'cancelled_or_not_received', 'subscription', 'card_lost_or_stolen', 'other'];
const invalid = detail => ({ error: { status: 422, detail } });

/** Require the guided fields and optional previous_protocol UUID; no identity or internal handoff id is accepted. */
export function validateStartRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return invalid('Provide exactly the guided report fields');
  const linked = Object.hasOwn(body, 'previous_protocol');
  if (Object.keys(body).sort().join() !== (linked ? KEYS.replace('mode,', 'mode,previous_protocol,') : KEYS)) {
    return invalid('Provide exactly the guided report fields');
  }
  if (!['es', 'pt', 'en'].includes(body.language) || body.mode !== 'guided' || body.report_type !== 'unrecognized_charge') {
    return invalid('Select an ES/PT/EN guided unrecognized-charge report');
  }
  if (!REASONS.includes(body.reason)) return invalid('Choose one of the report reasons');
  const statement = checkText(body.customer_statement);
  if (statement.error) return statement;
  if (typeof body.idempotency_key !== 'string' || !UUID.test(body.idempotency_key)) return invalid('Invalid request key');
  if (linked && (typeof body.previous_protocol !== 'string' || !UUID.test(body.previous_protocol))) return invalid('Invalid previous report protocol');
  return { value: { language: body.language, statement: statement.value, key: body.idempotency_key.toLowerCase(), reason: body.reason,
    ...(linked && { previousProtocol: body.previous_protocol.toLowerCase() }) } };
}

/** Customer free text: well-formed Unicode without U+0000, trimmed to 10–2000 code points. */
function checkText(text) {
  if (typeof text !== 'string' || !text.isWellFormed()) return invalid('Statement must be valid Unicode text');
  if (text.includes('\u0000')) return invalid('Statement must not contain U+0000');
  const value = text.trim();
  const length = [...value].length;
  if (length < 10 || length > 2000) return invalid('Describe the charge in 10–2000 characters');
  return { value };
}

/**
 * Accept only explicit confirmation or incomplete handoff fields; failure evidence stays server-controlled.
 * An incomplete handoff may carry ``details`` (what the customer remembers, same rules as the statement);
 * the route appends them to the stored statement.
 */
export function validateHandoffRequest(body, complete) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return invalid('Provide exactly the handoff fields');
  const keys = Object.keys(body).sort().join();
  const withDetails = !complete && keys === 'details,episode_id,idempotency_key,kind';
  if (keys !== (complete ? 'customer_confirmed,episode_id,idempotency_key,transaction_id' : 'episode_id,idempotency_key,kind') && !withDetails) return invalid('Provide exactly the handoff fields');
  if (typeof body.episode_id !== 'string' || !UUID.test(body.episode_id) || typeof body.idempotency_key !== 'string' || !UUID.test(body.idempotency_key)) return invalid('Invalid episode or request key');
  if (complete ? body.customer_confirmed !== true || typeof body.transaction_id !== 'string' || !body.transaction_id || body.transaction_id.length > 100 || !body.transaction_id.isWellFormed() || body.transaction_id.includes('\u0000') : body.kind !== 'incomplete') return invalid('Explicit owned confirmation or incomplete handoff required');
  const details = withDetails ? checkText(body.details) : { value: null };
  if (details.error) return details;
  return { value: { episodeId: body.episode_id.toLowerCase(), turnKey: body.idempotency_key.toLowerCase(), transactionId: complete ? body.transaction_id : null, details: details.value } };
}
