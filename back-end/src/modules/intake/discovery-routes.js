/** Bounded transaction discovery: one model extraction followed by a deterministic lookup of only the session customer's charges. */
import { fail, json, readJsonBody } from '../../http.js';
import { requireSession } from '../../auth/session.js';
import { assistEnabled, ASSIST_TIMEOUT_MS, runAssist } from './assist.js';
import { logEvent } from '../../log.js';

/** Cheap deterministic blocklist prevents obvious instruction attacks from reaching either model call. */
const obviousInjection = text => /ignore (all |previous |system )?instructions|reveal (the )?(prompt|secret)|\b(select|drop|delete)\b.{0,30}\b(from|table)\b|act as (an? )?(admin|another customer)/i.test(text);

export async function discoverTransactions(request, env, store, _ctx, generate = runAssist) {
  const session = await requireSession(request, store, 'customer');
  if (!session) return fail(401, 'Start a demo session first');
  const parsed = await readJsonBody(request); if (parsed.error) return parsed.error;
  const v = parsed.value;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== 'description,language'
    || typeof v.description !== 'string' || !v.description.isWellFormed() || v.description.includes('\0') || !v.description.trim() || [...v.description].length > 2000
    || !['es','pt','en'].includes(v.language)) return fail(422,'Provide exactly description and language');
  if (!assistEnabled(env,'discovery') || await store.customerSource(session.customer_id) !== 'fictitious') return fail(503,'Transaction discovery is unavailable');
  const started=Date.now(), controller = new AbortController(), timer = setTimeout(() => controller.abort(), ASSIST_TIMEOUT_MS);
  if (obviousInjection(v.description)) { logEvent('transaction_discovery',{outcome:'safety_or_injection',fallback:'local_safety',total_ms:Date.now()-started}); return fail(422,'Transaction discovery cannot process that request'); }
  let routed, result, routerMs=0;
  try {
    const routerStarted=Date.now();
    routed=await generate(env,{mode:'discovery_router',language:v.language,input:{message:v.description}},{signal:controller.signal}); routerMs=Date.now()-routerStarted;
    if (!routed.ok || !['transaction_search','transaction_clarification','transaction_correction'].includes(routed.value.intent)) {
      logEvent('transaction_discovery',{outcome:routed.ok?routed.value.intent:routed.kind,fallback:'router',router_ms:Date.now()-routerStarted,total_ms:Date.now()-started});
      return fail(422,'Provide the merchant, date or amount of the transaction');
    }
    result = await generate(env,{mode:'discovery',language:v.language,input:{description:v.description}},{signal:controller.signal});
  }
  finally { clearTimeout(timer); }
  if (controller.signal.aborted || !result.ok) { logEvent('transaction_discovery',{outcome:controller.signal.aborted?'timeout':result.kind,fallback:'interpreter',total_ms:Date.now()-started}); return fail(503,'Transaction discovery is unavailable'); }
  if ((await requireSession(request,store,'customer'))?.customer_id !== session.customer_id) return fail(401,'Start a demo session first');
  const searchStarted=Date.now(); let items;
  try { items = await store.searchOwnedTransactions(session.customer_id,result.value.criteria); }
  catch { logEvent('transaction_discovery',{outcome:'search_failure',intent:routed.value.intent,total_ms:Date.now()-started}); return fail(503,'Transaction discovery is unavailable'); }
  logEvent('transaction_discovery',{outcome:items.length?'success':'no_match',intent:routed.value.intent,router_ms:routerMs,search_ms:Date.now()-searchStarted,total_ms:Date.now()-started});
  return json({criteria:result.value.criteria,missing_fields:result.value.missing_fields,confidence:result.value.confidence,
    status:items.length === 0 ? 'none' : items.length > 3 ? 'ambiguous' : 'candidates',items:items.slice(0,3)});
}
