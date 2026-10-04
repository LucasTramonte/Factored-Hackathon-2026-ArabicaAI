/** Deliver one queued notification email after the response. Never throws; the outbox row records the outcome. */
import { decrypt, sendEmail } from './email.js';
import { render } from './templates.js';
import { LOGO_CID, LOGO_PNG_BASE64 } from './logo.js';

/**
 * Read the customer's encrypted address, render the row's ``template`` (default ``received``) in ``language`` with
 * ``reference``, ``status``, ``urgent`` (the call-your-bank paragraph) and ``env.APP_URL`` (the button) and send it with the inline logo, then mark the outbox row ``sent``, ``skipped`` (SES not configured) or
 * ``failed`` (any error, including decryption).
 */
export async function deliver(env, store, { messageId, customerId, language, reference, template = 'received', status, urgent }, send = sendEmail) {
  let outcome = 'failed', providerId = null;
  try {
    const target = await store.findNotificationTarget(customerId);
    const result = await send(env, { to: await decrypt(target.email_enc, env), ...render(template, language, { reference, status, urgent, appUrl: env.APP_URL }),
      inline: [{ cid: LOGO_CID, type: 'image/png', base64: LOGO_PNG_BASE64 }] });
    outcome = result.ok ? 'sent' : result.skipped ? 'skipped' : 'failed';
    providerId = result.messageId ?? null;
  } catch { /* outcome stays failed */ }
  try { await store.markEmail(messageId, outcome, providerId); } catch { /* the row stays queued */ }
}
