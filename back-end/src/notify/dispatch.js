/** Deliver one queued notification email after the response. Never throws; the outbox row records the outcome. */
import { decrypt, sendEmail } from './email.js';
import { render } from './templates.js';

/**
 * Read the customer's encrypted address, render ``received`` in ``language`` with ``reference`` and send it, then
 * mark the outbox row ``sent``, ``skipped`` (SES not configured) or ``failed`` (any error, including decryption).
 */
export async function deliver(env, store, { messageId, customerId, language, reference }, send = sendEmail) {
  let status = 'failed', providerId = null;
  try {
    const target = await store.findNotificationTarget(customerId);
    const result = await send(env, { to: await decrypt(target.email_enc, env), ...render('received', language, { reference }) });
    status = result.ok ? 'sent' : result.skipped ? 'skipped' : 'failed';
    providerId = result.messageId ?? null;
  } catch { /* status stays failed */ }
  try { await store.markEmail(messageId, status, providerId); } catch { /* the row stays queued */ }
}
