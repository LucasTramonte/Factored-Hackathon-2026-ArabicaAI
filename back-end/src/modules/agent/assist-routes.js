/** Unsaved assistance for one acknowledged synthetic report; humans alone send messages and change status. */
import { fail, json, readCookies, readJsonBody } from '../../http.js';
import { COOKIE, requireSession, tokenHash } from '../../auth/session.js';
import { UUID } from '../intake/validation.js';
import { assistEnabled, ASSIST_TIMEOUT_MS, ASSIST_VERSION, runAssist } from '../intake/assist.js';

const FALLBACK = { es: 'La ayuda no está disponible. Puedes continuar con la revisión manual.',
  pt: 'A ajuda está indisponível. Você pode continuar a revisão manual.',
  en: 'Assistance is unavailable. You can continue the manual review.' };

/** POST exact protocol/language/request_id, one reserved attempt, then live-session and snapshot revalidation. */
export async function reviewerAssist(request, env, store, ctx, generate = runAssist) {
  const started = Date.now();
  if (!await requireSession(request, store, 'agent')) return fail(401, 'Start a demo agent session first');
  if (new URL(request.url).search) return fail(422, 'Unexpected parameters');
  const parsed = await readJsonBody(request);
  if (parsed.error) return parsed.error;
  const value = parsed.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'language,protocol,request_id'
    || typeof value.protocol !== 'string' || !UUID.test(value.protocol) || typeof value.request_id !== 'string' || !UUID.test(value.request_id)
    || !['es','pt','en'].includes(value.language)) return fail(422, 'Provide exactly protocol, language and request_id');
  const fallback = () => fail(503, FALLBACK[value.language]);
  if (!assistEnabled(env, 'reviewer')) return fallback();
  const protocol = value.protocol.toLowerCase(), requestId = value.request_id.toLowerCase();
  const context = await store.findReviewerContext(protocol);
  if (!context) return fail(404, 'Intake handoff not found');
  if (context.status === 'closed') return fail(409, 'This report is closed');
  if (context.source !== 'fictitious') return fallback();
  const snapshot = { status: context.status, message_count: context.message_count };
  const sessionHash = await tokenHash(readCookies(request)[COOKIE.agent]);
  const reserved = await store.reserveAssist({ requestId, sessionHash, mode: 'reviewer', protocol, now: Date.now(), version: ASSIST_VERSION });
  if (reserved === 'duplicate') return fail(409, 'This request_id was already used');
  if (reserved === 'limited') return fail(429, 'Too many assistance requests', { 'Retry-After': '60' });
  // Existing incomplete reports store statement and supplied details together. Preserve that exact text; no delimiter guessing.
  const controller = new AbortController();
  const remaining = ASSIST_TIMEOUT_MS - (Date.now() - started);
  if (remaining <= 0) controller.abort();
  const timer = setTimeout(() => controller.abort(), Math.max(0, remaining));
  let result;
  try {
    result = await generate(env, { mode: 'reviewer', language: value.language,
      input: { statement: context.customer_statement, details: '', messages: JSON.parse(context.messages_json), status: context.status } }, { signal: controller.signal });
  } finally { clearTimeout(timer); }
  const live = await requireSession(request, store, 'agent');
  const current = live && await store.assistSnapshot(protocol);
  const stale = !current || current.status !== snapshot.status || current.message_count !== snapshot.message_count;
  await store.finishAssist({ requestId, outcome: stale ? 'stale' : Date.now() - started >= ASSIST_TIMEOUT_MS ? 'timeout' : result.ok ? 'success' : result.kind,
    latencyMs: Date.now() - started, usage: result.usage, version: ASSIST_VERSION });
  if (!live) return fail(401, 'Start a demo agent session first');
  if (stale) return fail(409, 'This report changed; refresh before generating again');
  if (controller.signal.aborted || !result.ok || Date.now() - started >= ASSIST_TIMEOUT_MS) return fallback();
  return json({ ...result.value, language: value.language, snapshot });
}
