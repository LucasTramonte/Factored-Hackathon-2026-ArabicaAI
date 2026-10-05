/** Bounded transaction discovery: one model extraction followed by a deterministic lookup of only the session customer's charges. */
import { fail, json, readJsonBody } from '../../http.js';
import { requireSession } from '../../auth/session.js';
import { assistEnabled, ASSIST_TIMEOUT_MS, runAssist } from './assist.js';

export async function discoverTransactions(request, env, store, _ctx, generate = runAssist) {
  const session = await requireSession(request, store, 'customer');
  if (!session) return fail(401, 'Start a demo session first');
  const parsed = await readJsonBody(request); if (parsed.error) return parsed.error;
  const v = parsed.value;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== 'description,language'
    || typeof v.description !== 'string' || !v.description.isWellFormed() || v.description.includes('\0') || !v.description.trim() || [...v.description].length > 2000
    || !['es','pt','en'].includes(v.language)) return fail(422,'Provide exactly description and language');
  if (!assistEnabled(env,'discovery') || await store.customerSource(session.customer_id) !== 'fictitious') return fail(503,'Transaction discovery is unavailable');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), ASSIST_TIMEOUT_MS);
  let result;
  try { result = await generate(env,{mode:'discovery',language:v.language,input:{description:v.description}},{signal:controller.signal}); }
  finally { clearTimeout(timer); }
  if (controller.signal.aborted || !result.ok) return fail(503,'Transaction discovery is unavailable');
  if ((await requireSession(request,store,'customer'))?.customer_id !== session.customer_id) return fail(401,'Start a demo session first');
  const items = await store.searchOwnedTransactions(session.customer_id,result.value.criteria);
  return json({criteria:result.value.criteria,missing_fields:result.value.missing_fields,confidence:result.value.confidence,
    status:items.length === 0 ? 'none' : items.length > 3 ? 'ambiguous' : 'candidates',items:items.slice(0,3)});
}
