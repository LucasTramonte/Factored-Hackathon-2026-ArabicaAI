/** Session-only customer classification; never supplies report facts or messages to a model. */
import { fail, json, readCookies, readJsonBody } from '../../http.js';
import { COOKIE, requireSession, tokenHash } from '../../auth/session.js';
import { UUID } from './validation.js';
import { SHORT_REFERENCE } from '../../store/d1.js';
import { assistEnabled, ASSIST_TIMEOUT_MS, ASSIST_VERSION, runAssist } from './assist.js';
const FALLBACK = { es:'La ayuda no está disponible. Puedes consultar el estado o escribir al equipo.', pt:'A ajuda está indisponível. Você pode consultar o status ou escrever à equipe.', en:'Assistance is unavailable. You can check status or write to the team.' };
/** Classify one current question on a freshly owned synthetic report, returning only validated vocabulary and fresh snapshot. */
export async function customerAssist(request, env, store, ctx, generate = runAssist) {
  const started = Date.now();
  const session = await requireSession(request, store, 'customer');
  if (!session) return fail(401, 'Start a demo session first');
  const url = new URL(request.url);
  if (url.search) return fail(422, 'Unexpected parameters');
  const segment = url.pathname.slice('/intake/handoff/'.length, -'/assist'.length);
  const ref = UUID.test(segment) ? { protocol:segment.toLowerCase(),short:'' } : SHORT_REFERENCE.test(segment) ? {protocol:'',short:segment} : null;
  if (!ref) return fail(404, 'Report not found');
  const parsed = await readJsonBody(request); if (parsed.error) return parsed.error;
  const value = parsed.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'language,question,request_id'
    || typeof value.question !== 'string' || !value.question.isWellFormed() || value.question.includes('\0') || !value.question.trim() || [...value.question].length > 2000
    || !['es','pt','en'].includes(value.language) || typeof value.request_id !== 'string' || !UUID.test(value.request_id)) return fail(422, 'Provide exactly question, language and request_id');
  const owned = () => store.findCustomerAssist({customerId:session.customer_id,...ref});
  const context = await owned(); if (!context) return fail(404, 'Report not found');
  const fallback = () => fail(503,FALLBACK[value.language]);
  if (!assistEnabled(env,'customer') || context.source !== 'fictitious') return fallback();
  if ((await requireSession(request,store,'customer'))?.customer_id !== session.customer_id) return fail(401,'Start a demo session first');
  const requestId = value.request_id.toLowerCase();
  const sessionHash = await tokenHash(readCookies(request)[COOKIE.customer]);
  const reserved = await store.reserveAssist({requestId,sessionHash,mode:'customer',protocol:context.protocol,customerId:session.customer_id,now:Date.now(),version:ASSIST_VERSION});
  if (reserved === 'duplicate') return fail(409,'This request_id was already used');
  if (reserved === 'limited') {
    if ((await requireSession(request,store,'customer'))?.customer_id !== session.customer_id) return fail(401,'Start a demo session first');
    const target = await owned();
    if (!target) return fail(404,'Report not found');
    if (target.source !== 'fictitious') return fallback();
    return fail(429,'Too many assistance requests',{'Retry-After':'60'});
  }
  const controller = new AbortController(), remaining = ASSIST_TIMEOUT_MS - (Date.now()-started);
  if (remaining <= 0) controller.abort();
  const timer = setTimeout(()=>controller.abort(),Math.max(0,remaining));
  let result;
  try {
    const beforeCall = await requireSession(request,store,'customer');
    const target = beforeCall?.customer_id === session.customer_id && await owned();
    result = !target || target.source !== 'fictitious' ? {ok:false,kind:'config_error',usage:{llm_calls:0,known_input_tokens:0,known_output_tokens:0,usage_unavailable_calls:0}} : await generate(env,{mode:'customer',language:value.language,input:{question:value.question}},{signal:controller.signal}); }
  finally { clearTimeout(timer); }
  const live = await requireSession(request,store,'customer');
  const current = live?.customer_id === session.customer_id && await owned();
  const stale = !current || current.source !== 'fictitious';
  await store.finishAssist({requestId,outcome:stale?'stale':Date.now()-started>=ASSIST_TIMEOUT_MS?'timeout':result.ok?'success':result.kind,latencyMs:Date.now()-started,usage:result.usage,version:ASSIST_VERSION});
  if (!live || live.customer_id !== session.customer_id) return fail(401,'Start a demo session first');
  if (!current) return fail(404,'Report not found');
  if (stale || controller.signal.aborted || !result.ok || Date.now()-started>=ASSIST_TIMEOUT_MS) return fallback();
  return json({...result.value,language:value.language,snapshot:{status:current.status,message_count:current.message_count}});
}
