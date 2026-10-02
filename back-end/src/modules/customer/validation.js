/** Validation for case creation. Types are exact and lengths count Unicode code points, as SQLite does. */

/** Customer ids (committed, dataset or Cognito) are short ASCII codes; anything else is rejected before it reaches D1. */
export const CUSTOMER_ID = /^[A-Za-z0-9-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = detail => ({ error: { status: 422, detail } });

/** ``{ value: { transactionId, statement, idempotencyKey } }`` or ``{ error: { status, detail } }``. */
export function validateCaseRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return invalid('Request body must be a JSON object');
  if (!Object.hasOwn(body, 'customer_confirmed') || body.customer_confirmed !== true) {
    return invalid('Explicit confirmation is required');
  }
  // A lone surrogate would be replaced with U+FFFD when stored as UTF-8, so the read-back would differ.
  if ([body.customer_statement, body.transaction_id].some(v => typeof v === 'string' && !v.isWellFormed())) {
    return invalid('Text must be valid Unicode');
  }
  const statement = typeof body.customer_statement === 'string' ? body.customer_statement.trim() : '';
  const length = [...statement].length;
  if (length < 10 || length > 2000) return invalid('Describe the charge in 10–2000 characters');
  const { transaction_id: transactionId, idempotency_key: idempotencyKey } = body;
  if (typeof transactionId !== 'string' || !transactionId || transactionId.length > 100
      || typeof idempotencyKey !== 'string' || !UUID.test(idempotencyKey)) {
    return invalid('Invalid transaction or request key');
  }
  return { value: { transactionId, statement, idempotencyKey } };
}
