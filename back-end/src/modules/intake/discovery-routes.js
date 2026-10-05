/** Bounded transaction discovery: one model interpretation, then a deterministic lookup of only the session customer's charges. */
import { fail, json, readCookies, readJsonBody } from '../../http.js';
import { COOKIE, requireSession, tokenHash } from '../../auth/session.js';
import { UUID } from './validation.js';
import { assistEnabled, ASSIST_TIMEOUT_MS, DISCOVERY_VERSION, runAssist } from './assist.js';
import { DISCOVERY_SEARCH_INTENTS } from './assist-prompts.js';
import { logEvent } from '../../log.js';

const FALLBACK = { es:'La búsqueda no está disponible. Puedes elegir el cargo en tu lista o pedir revisión sin cargo.', pt:'A busca está indisponível. Você pode escolher a cobrança na sua lista ou pedir análise sem cobrança.', en:'Search is unavailable. You can choose the charge from your list or ask for review without a charge.' };
const NARROW = { es:'Indica el comercio, la fecha o el monto del cargo.', pt:'Informe o estabelecimento, a data ou o valor da cobrança.', en:'Give the merchant, date or amount of the charge.' };
/** Cheap deterministic blocklist: obvious instruction attacks never reach a reservation or the model. */
const obviousInjection = text => /ignore (all |previous |system )?instructions|reveal (the )?(prompt|secret)|\b(select|drop|delete)\b.{0,30}\b(from|table)\b|act as (an? )?(admin|another customer)/i.test(text);

/** Interpret one description for the customer's own open intake episode and return at most three of their stored charges. */
export async function discoverTransactions(request, env, store, ctx, generate = runAssist) {
  const started = Date.now();
  const session = await requireSession(request, store, 'customer');
  if (!session) return fail(401, 'Start a demo session first');
  if (new URL(request.url).search) return fail(422, 'Unexpected parameters');
  const parsed = await readJsonBody(request); if (parsed.error) return parsed.error;
  const v = parsed.value;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== 'description,episode_id,language,request_id'
    || typeof v.description !== 'string' || !v.description.isWellFormed() || v.description.includes('\0') || !v.description.trim() || [...v.description].length > 2000
    || !['es','pt','en'].includes(v.language) || typeof v.request_id !== 'string' || !UUID.test(v.request_id)
    || typeof v.episode_id !== 'string' || !UUID.test(v.episode_id)) return fail(422, 'Provide exactly description, language, request_id and episode_id');
  const episode = await store.findIntake(session.customer_id, v.episode_id.toLowerCase());
  if (!episode) return fail(404, 'Report not found');
  const fallback = () => fail(503, FALLBACK[v.language]);
  if (!assistEnabled(env, 'discovery') || await store.customerSource(session.customer_id) !== 'fictitious') return fallback();
  const log = (outcome, extra = {}) => logEvent('transaction_discovery', { outcome, language: v.language, ms: Date.now() - started, ...extra });
  if (obviousInjection(v.description)) { log('safety_or_injection', { blocked: 'local' }); return fail(422, NARROW[v.language]); }
  const requestId = v.request_id.toLowerCase(), sessionHash = await tokenHash(readCookies(request)[COOKIE.customer]);
  // ponytail: reserved under the customer feature (migration 0030 allows two modes); the version string tells discovery rows apart.
  const reserved = await store.reserveAssist({ requestId, sessionHash, mode: 'customer', protocol: episode.episode_id, now: Date.now(), version: DISCOVERY_VERSION });
  if (reserved === 'duplicate') return fail(409, 'This request_id was already used');
  if (reserved === 'limited') return fail(429, 'Too many assistance requests', { 'Retry-After': '60' });
  const controller = new AbortController(), remaining = ASSIST_TIMEOUT_MS - (Date.now() - started);
  if (remaining <= 0) controller.abort();
  const timer = setTimeout(() => controller.abort(), Math.max(0, remaining));
  let result;
  try { result = await generate(env, { mode: 'discovery', language: v.language, input: { description: v.description } }, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
  const live = (await requireSession(request, store, 'customer'))?.customer_id === session.customer_id;
  const timedOut = controller.signal.aborted || Date.now() - started >= ASSIST_TIMEOUT_MS;
  const outcome = !live ? 'stale' : timedOut ? 'timeout' : result.ok ? 'success' : result.kind;
  await store.finishAssist({ requestId, outcome, latencyMs: Date.now() - started, usage: result.usage, version: DISCOVERY_VERSION });
  if (!live) { log('stale'); return fail(401, 'Start a demo session first'); }
  if (timedOut || !result.ok) { log(outcome); return fallback(); }
  const { intent, criteria, missing_fields, confidence } = result.value;
  if (!DISCOVERY_SEARCH_INTENTS.includes(intent)) { log(intent); return fail(422, NARROW[v.language]); }
  let items;
  try { items = await store.searchOwnedTransactions(session.customer_id, criteria); }
  catch { log('search_failure', { intent }); return fallback(); }
  const status = items.length === 0 ? 'none' : items.length > 3 ? 'ambiguous' : 'candidates';
  log(status, { intent, candidates: Math.min(items.length, 3) });
  return json({ criteria, missing_fields, confidence, status, items: items.slice(0, 3) });
}
