/**
 * Notification email: AES-GCM for the stored address and an SES v2 sender. Bodies carry references only, never a
 * customer's statement. Nothing sends unless all SES settings are present, and ``sendEmail`` never throws.
 */
import { AwsClient } from 'aws4fetch';

const b64 = bytes => btoa(Array.from(new Uint8Array(bytes), b => String.fromCharCode(b)).join(''));
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

/** The 256-bit key from ``env.EMAIL_KEY`` (base64); throws when it is missing or not 32 bytes. */
async function key(env) {
  const raw = unb64(env.EMAIL_KEY ?? '');
  if (raw.length !== 32) throw new Error('EMAIL_KEY must be 32 bytes, base64');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypt with a fresh 12-byte IV; returns ``base64(iv).base64(ciphertext)``. Throws without a valid key. */
export async function encrypt(text, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return b64(iv) + '.' + b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), new TextEncoder().encode(text)));
}

/** Decrypt a blob from ``encrypt``; throws on a missing key, a wrong key or any tampering (GCM tag). */
export async function decrypt(blob, env) {
  const [iv, ct] = String(blob).split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await key(env), unb64(ct ?? '')));
}

/**
 * Send one email (plain text, plus HTML when given) through SES v2. Returns ``{ ok: true, messageId }``, ``{ ok: false }`` on any failure,
 * or ``{ ok: false, skipped: true }`` (no request made) when an SES setting is missing. Never throws.
 */
export async function sendEmail(env, { to, subject, text, html }, fetchImpl = fetch) {
  const { SES_ACCESS_KEY_ID: accessKeyId, SES_SECRET_ACCESS_KEY: secretAccessKey, SES_REGION: region, SES_FROM: from } = env;
  if (!accessKeyId || !secretAccessKey || !region || !from) return { ok: false, skipped: true };
  try {
    const aws = new AwsClient({ accessKeyId, secretAccessKey, service: 'ses', region });
    const signed = await aws.sign(`https://email.${region}.amazonaws.com/v2/email/outbound-emails`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ FromEmailAddress: from, Destination: { ToAddresses: [to] }, Content: { Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Text: { Data: text, Charset: 'UTF-8' }, ...(html && { Html: { Data: html, Charset: 'UTF-8' } }) } } } })
    });
    const res = await fetchImpl(signed);
    if (!res.ok) return { ok: false };
    return { ok: true, messageId: (await res.json().catch(() => ({}))).MessageId ?? null };
  } catch {
    return { ok: false };
  }
}
