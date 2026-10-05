/**
 * Messages between the reviewing agent and the customer on one report (ADR-015): validation and the HTTP outcome of a
 * post, shared by the customer and agent routes. A message is case content, never an event or a log field.
 */
import { fail, json } from '../../http.js';
import { MESSAGES_PER_REPORT } from '../../store/d1.js';
import { UUID } from './validation.js';

/** Exact monotonic report snapshot used to reject stale assisted sends. */
export const validSnapshot = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join() === 'message_count,status' && ['received','in_review','closed'].includes(v.status)
  && Number.isInteger(v.message_count) && v.message_count >= 0 && v.message_count <= MESSAGES_PER_REPORT;

/** Characters a message may hold after trimming, in code points. */
export const MESSAGE_MAX = 2000;

/**
 * ``{ value: { body, key } }`` for exactly ``{ body, idempotency_key }`` (plus ``protocol`` and optional ``expected_snapshot`` when ``withProtocol``), or
 * ``{ error }`` (422). The body is well-formed Unicode without U+0000, trimmed, 1–2000 code points.
 */
export function validateMessage(value, { withProtocol = false } = {}) {
  const assisted = withProtocol && Object.hasOwn(value ?? {}, 'expected_snapshot');
  const keys = withProtocol ? (assisted ? 'body,expected_snapshot,idempotency_key,protocol' : 'body,idempotency_key,protocol') : 'body,idempotency_key';
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== keys) {
    return { error: fail(422, `Provide exactly ${keys.replaceAll(',', ', ')}`) };
  }
  if (typeof value.idempotency_key !== 'string' || !UUID.test(value.idempotency_key)) return { error: fail(422, 'idempotency_key must be a UUID') };
  if (withProtocol && (typeof value.protocol !== 'string' || !UUID.test(value.protocol))) return { error: fail(422, 'protocol must be a UUID') };
  if (typeof value.body !== 'string' || !value.body.isWellFormed() || value.body.includes('\u0000')) return { error: fail(422, 'Message must be valid Unicode text') };
  const body = value.body.trim();
  const length = [...body].length;
  if (length < 1 || length > MESSAGE_MAX) return { error: fail(422, `Write a message of 1–${MESSAGE_MAX} characters`) };
  if (assisted && !validSnapshot(value.expected_snapshot)) return { error: fail(422, 'Provide a valid expected_snapshot') };
  return { value: { expectedSnapshot: assisted ? value.expected_snapshot : undefined, body, key: value.idempotency_key.toLowerCase(), protocol: value.protocol?.toLowerCase() } };
}

/** The served shape of one stored message: who wrote it and when, never which agent session. */
export const messageJson = ({ message_id, author, body, created_at }) => ({ message_id, author, body, created_at: new Date(created_at).toISOString() });

/** A thread: the report status, whether a post is accepted now, at most ``MESSAGES_PER_REPORT`` messages, oldest first. */
export const threadJson = ({ status, items }) => ({ status, can_post: status !== 'closed' && items.length < MESSAGES_PER_REPORT,
  items: items.slice(0, MESSAGES_PER_REPORT).map(messageJson) });

/**
 * The response to a post: 201 when this call stored the message, 200 for a replay of the same key and body, 409 for the
 * same key with another body, a closed report or a full thread, 404 when the report isn't the caller's to write to.
 */
export function postOutcome(found, messageId, body) {
  if (!found) return fail(404, 'Report not found');
  if (!found.message) {
    if (found.stale) return fail(409, 'This report changed; refresh before sending');
    return found.status === 'closed' ? fail(409, 'This report is closed; messages are read-only')
      : fail(409, `This report already has ${MESSAGES_PER_REPORT} messages`);
  }
  if (found.message.body !== body) return fail(409, 'This idempotency_key was used for another message');
  return json(messageJson(found.message), found.message.message_id === messageId ? 201 : 200);
}
