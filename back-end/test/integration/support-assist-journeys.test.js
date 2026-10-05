/** Ten scripted two-party synthetic journeys on real local Worker/D1, with loopback model output only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { client } from '../support/client.js';
import { assertContract } from '../support/contract.js';
const uuid = () => crypto.randomUUID();
const languages = ['es','pt','en','es','pt','en','es','pt','en','es'];
const copy = {
  es: { statement:'No reconozco la compra en Tienda Lluvia.', message:'Encontré el comprobante; falta confirmar el importe.', edited:'Mensaje revisado por una persona: ¿puedes confirmar el importe del comprobante?', note:'Revisión humana terminada. Contacta al banco si necesitas más ayuda.', followup:'Todavía necesito ayuda con la compra y solicito otra revisión.' },
  pt: { statement:'Não reconheço a compra na Loja Chuva.', message:'Achei o recibo; ainda falta confirmar a quantia.', edited:'Mensagem revisada por uma pessoa: pode confirmar a quantia do recibo?', note:'Revisão humana encerrada. Procure o banco se precisar de mais ajuda.', followup:'Ainda preciso de ajuda com a compra e peço outra revisão.' },
  en: { statement:'I do not recognize the purchase at Rain Shop.', message:'I found the receipt; its amount still needs confirmation.', edited:'Message reviewed by a person: can you confirm the receipt amount?', note:'Human review is finished. Contact the bank if you need further help.', followup:'I still need help with this purchase and request another review.' }
};
for (const [index,language] of languages.entries()) test(`synthetic two-party journey ${index+1} (${language})`, async () => {
  const words = copy[language], customer = client(), reviewer = client();
  assert.equal((await customer.call('/demo/session',{customer_id:'demo-ana'})).status,200);
  assert.equal((await reviewer.call('/demo/agent-session',{})).status,200);
  const startBody = { language,mode:'guided',report_type:'unrecognized_charge',reason:'not_mine',customer_statement:words.statement,idempotency_key:uuid() };
  const start = await customer.call('/intake/start',startBody); assert.equal(start.status,201);
  const handoff = await customer.call('/intake/handoff',{episode_id:start.body.episode_id,kind:'incomplete',idempotency_key:uuid()});
  assert.equal(handoff.status,201); assertContract('intakeReceipt',handoff.body);
  const protocol = handoff.body.protocol, path = `/intake/handoff/${protocol}/messages`, assist = `/intake/handoff/${protocol}/assist`;
  const posted = await customer.call(path,{body:words.message,idempotency_key:uuid()}); assert.equal(posted.status,201);
  const savedAt = performance.now();
  let thread = await customer.call(path); assertContract('messageThread',thread.body);
  assert.equal(thread.body.items.length,1); assert.equal(thread.body.items.at(-1).author,'customer'); // persisted waiting state
  const status = await customer.call(assist,{question:'status',language,request_id:uuid()});
  assert.equal(status.status,200); assertContract('customerAssist',status.body);
  const owned = (await customer.call('/reports')).body.items.find(row=>row.protocol===protocol);
  assert.equal(status.body.snapshot.status,owned.status); assert.equal(status.body.snapshot.message_count,thread.body.items.length);
  assert.equal((await customer.call(path)).body.items.length,1,'automatic status is not a human message');
  const prepared = await reviewer.call('/agent/intake-assist',{protocol,language,request_id:uuid()});
  assert.equal(prepared.status,200); assertContract('reviewerAssist',prepared.body);
  assert.equal((await customer.call(path)).body.items.length,1,'draft is not saved');
  assert.notEqual(words.edited,prepared.body.draft);
  const reply = {protocol,body:words.edited,idempotency_key:uuid(),expected_snapshot:prepared.body.snapshot};
  assert.equal((await reviewer.call('/agent/intake-messages',reply)).status,201);
  assert.equal((await reviewer.call('/agent/intake-messages',reply)).status,200,'same human send replays once');
  thread = await customer.call(path); assert.equal(thread.body.items.length,2); assert.deepEqual(thread.body.items.map(row=>row.author),['customer','agent']);
  assert.equal(thread.body.items.at(-1).body,words.edited);
  const scriptedReplyElapsed = performance.now()-savedAt; // script schedule, never human response/handling time
  const outage = await customer.call(assist,{question:'MOCK-PROVIDER',language,request_id:uuid()});
  assert.equal(outage.status,503); assert.deepEqual(Object.keys(outage.body),['detail']);
  assert.equal((await customer.call('/reports')).body.items.find(row=>row.protocol===protocol).status,'received');
  assert.equal((await customer.call(path,{body:words.message,idempotency_key:uuid()})).status,201,'manual support persists during provider outage');
  assert.equal((await reviewer.call('/agent/intake-messages',{...reply,idempotency_key:uuid()})).status,409,'changed message count blocks stale assisted send');
  const delayed = customer.call(assist,{question:'MOCK-DELAY status',language,request_id:uuid()});
  // Wait until this specific synthetic provider question has arrived; no arbitrary scheduling sleep.
  for (const until=Date.now()+3000;;) {
    const seen = await (await fetch(process.env.VERTEX_MOCK_URL+'/__vertex')).json();
    if (seen.at(-1)?.question==='MOCK-DELAY status') break;
    assert.ok(Date.now()<until,'delayed provider request reached loopback');
    await new Promise(done=>setTimeout(done,20));
  }
  assert.equal((await customer.call('/auth/logout',{})).status,204);
  assert.equal((await customer.call('/demo/session',{customer_id:'demo-bruno'})).status,200);
  assert.equal((await delayed).status,401,'old identity cannot receive late classification');
  const foreign = await customer.call(path), missing = await customer.call(`/intake/handoff/${uuid()}/messages`);
  assert.equal(foreign.status,404); assert.deepEqual(foreign.body,missing.body);
  assert.equal((await customer.call(assist,{question:'status',language,request_id:uuid()})).status,404);
  assert.equal((await customer.call('/demo/session',{customer_id:'demo-ana'})).status,200);
  assert.equal((await customer.call(path)).body.items.length,3,'owned persisted conversation survives new session');
  assert.equal((await reviewer.call('/agent/intake-status',{protocol,status:'in_review'})).status,200);
  assert.equal((await reviewer.call('/agent/intake-status',{protocol,status:'closed',closing_note:words.note})).status,200);
  const closed = (await customer.call('/reports')).body.items.find(row=>row.protocol===protocol);
  assert.equal(closed.status,'closed'); assert.equal(closed.closing_note,words.note);
  assert.equal((await customer.call(path)).body.can_post,false);
  assert.equal((await customer.call(path,{body:words.message,idempotency_key:uuid()})).status,409);
  assert.equal((await reviewer.call('/agent/intake-assist',{protocol,language,request_id:uuid()})).status,409);
  const followup = await customer.call('/intake/start',{...startBody,customer_statement:words.followup,previous_protocol:protocol,idempotency_key:uuid()});
  assert.equal(followup.status,201);
  const next = await customer.call('/intake/handoff',{episode_id:followup.body.episode_id,kind:'incomplete',idempotency_key:uuid()});
  assert.equal(next.status,201); assert.notEqual(next.body.protocol,protocol);
  // Use existing store read, not a second SQL path; relation is one follow-up episode → one source handoff.
  const { withIntakeStore } = await import('../../scripts/intake-store.mjs');
  const { resolve } = await import('node:path');
  await withIntakeStore({config:resolve(process.cwd(),'wrangler.jsonc')},async store=>{
    const source=await store.findOwnedIntakeHandoff('demo-ana',start.body.episode_id), linked=await store.findIntake('demo-ana',followup.body.episode_id);
    assert.equal(source.status,'closed'); assert.equal(linked.previous_handoff_id,source.handoff_id);
  });
  for(const status of ['in_review','closed']) assert.equal((await reviewer.call('/agent/intake-status',{protocol:next.body.protocol,status,...(status==='closed'?{closing_note:words.note}:{})})).status,200);
  console.log('SUPPORT_ASSIST_LOCAL_JOURNEY '+JSON.stringify({journey:index+1,language,passed:true,evidence_kind:'local_mock',scripted_reply_elapsed_ms:Math.round(scriptedReplyElapsed),human_response_ms:null,human_handling_ms:null,baseline_handling_ms:null}));
});
