/** Guided reports use authenticated ownership and durable start receipts, without model calls. */
import { readSession } from '../../auth/session.js';
import { fail, json, readJsonBody } from '../../http.js';
import { validateStartRequest } from './validation.js';

/** POST /intake/start: start or replay an explicit guided report; never return a case protocol. */
export async function startIntake(request, env, store) {
  const current = await readSession(request, store, 'customer');
  if (!current) return fail(401, 'Start a demo session first');
  const body = await readJsonBody(request);
  if (body.error) return body.error;
  const checked = validateStartRequest(body.value);
  if (checked.error) return fail(checked.error.status, checked.error.detail);
  let result;
  try {
    result = await store.startIntake({ ...checked.value, customerId: current.customer_id,
      now: Date.now(), expiresAt: current.expires_at });
  } catch {
    return fail(503, 'Start not confirmed; retry with the same idempotency key');
  }
  if (result.conflict) return fail(409, 'Key already used with different content');
  const { episode, replayed } = result;
  if (!episode) return fail(503, 'Start not confirmed; retry with the same idempotency key');
  return json({ ...JSON.parse(episode.response_json), replayed }, replayed ? 200 : 201);
}
