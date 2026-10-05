/** Mock-only assistance trust boundaries; no live provider or persisted generated text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportPKCS8, generateKeyPair } from 'jose';
import { runAssist, ASSIST_TIMEOUT_MS, ASSIST_VERSION, parseAssist, boundedReviewerInput } from '../../src/modules/intake/assist.js';
import { resetTokenCache } from '../../src/modules/intake/vertex-auth.js';
const { privateKey } = await generateKeyPair('RS256', { extractable: true });
const env = { ASSIST_REVIEWER_ENABLED:'1', ASSIST_CUSTOMER_ENABLED:'1', VERTEX_PROJECT:'synthetic-project', VERTEX_PROJECT_NUMBER:'123',
  VERTEX_SERVICE_ACCOUNT:'test@synthetic-project.iam.gserviceaccount.com', VERTEX_WIF_ISSUER:'https://example.test', VERTEX_WIF_KID:'test', VERTEX_WIF_SIGNING_KEY:await exportPKCS8(privateKey) };
const value = { summary:'Customer disputes a charge.', missing_fields:['date'], draft:'Please tell us the date.' };
const args = { mode:'reviewer', language:'en', input:{statement:'I dispute this charge.', details:'', messages:[], status:'received'} };
const json = x => new Response(JSON.stringify(x));
function mock(content=JSON.stringify(value), usage={prompt_tokens:30,completion_tokens:20}) {
  const calls=[];
  return { calls, fetcher:async (url, init) => { calls.push({url,init});
    if(url.endsWith('/v1/token')) return json({access_token:'sts'});
    if(url.endsWith(':generateAccessToken')) return json({accessToken:'token',expireTime:new Date(Date.now()+3600000).toISOString()});
    return json({choices:[{message:{content},finish_reason:'stop'}], ...(usage && {usage})});
  }};
}
test('switches default off and accept exactly 1, with zero calls',async()=>{
  for(const flag of [undefined,'0','true',1]) { const g=mock(); const r=await runAssist({...env,ASSIST_REVIEWER_ENABLED:flag},args,{fetcher:g.fetcher}); assert.equal(r.kind,'config_error'); assert.equal(r.usage.llm_calls,0); assert.equal(g.calls.length,0); }
});
test('one schema-constrained model call; prompt version and bounded context stay separate from extractor',async()=>{
  resetTokenCache();const g=mock();const r=await runAssist(env,args,{fetcher:g.fetcher});assert.equal(r.ok,true);assert.deepEqual(r.value,{...value,context_truncated:false});assert.deepEqual(r.usage,{llm_calls:1,known_input_tokens:30,known_output_tokens:20,usage_unavailable_calls:0});
  const model=g.calls.at(-1);const body=JSON.parse(model.init.body);assert.equal(body.max_tokens,1024);assert.equal(body.response_format.type,'json_schema');assert.equal(model.init.redirect,'manual');assert.match(ASSIST_VERSION,/support-assist-v1/);assert.equal(g.calls.length,3);
});
test('strict output rejects wrappers, extra keys, bad Unicode, HTML/injection-shaped structures and invalid fields',()=>{
  for(const x of ['prefix '+JSON.stringify(value),JSON.stringify({...value,tool:'refund'}),JSON.stringify({...value,draft:'\ud800'}),JSON.stringify({...value,draft:'<script>alert(1)</script>'}),JSON.stringify({...value,missing_fields:['date','date']}),JSON.stringify({...value,summary:''}),JSON.stringify({...value,draft:'x'.repeat(2001)})]) assert.throws(()=>parseAssist('reviewer',x));
  assert.deepEqual(parseAssist('customer','{"intent":"status","field":null}'),{intent:'status',field:null});
  const criteria={merchant_hint:'Streaming',date_from:'2026-04-01',date_to:'2026-04-30',currency:'ARS',amount_operator:'gt',amount:85000};
  assert.equal(parseAssist('discovery',JSON.stringify({intent:'transaction_search',criteria,missing_fields:[],confidence:.9})).criteria.amount_operator,'gt');
  assert.equal(parseAssist('discovery',JSON.stringify({intent:'safety_or_injection',criteria:null,missing_fields:[],confidence:.9})).criteria,null);
  for (const x of [{intent:'transaction_search',criteria:null,missing_fields:[],confidence:.9},{intent:'greeting_or_casual',criteria,missing_fields:[],confidence:.9},{intent:'refund',criteria:null,missing_fields:[],confidence:.9},
    {intent:'transaction_search',action:'search_transactions',criteria,missing_fields:[],confidence:.9},{intent:'transaction_search',criteria:{...criteria,currency:'ars'},missing_fields:[],confidence:.9},
    {intent:'transaction_search',criteria:{...criteria,amount_operator:null},missing_fields:[],confidence:.9},{intent:'transaction_search',criteria:{...criteria,date_from:'2026-02-30'},missing_fields:[],confidence:.9},
    {intent:'transaction_search',criteria:{...criteria,date_from:'2026-05-01'},missing_fields:[],confidence:.9},{intent:'transaction_search',criteria:{...criteria,merchant_hint:'<b>x</b>'},missing_fields:[],confidence:.9},
    {intent:'transaction_search',criteria,missing_fields:['date','date'],confidence:.9},{intent:'transaction_search',criteria,missing_fields:[],confidence:1.1}]) assert.throws(()=>parseAssist('discovery',JSON.stringify(x)),JSON.stringify(x));
  for(const x of [{intent:'status',field:'date'},{intent:'refund',field:null},{intent:'human',field:null,draft:'x'}]) assert.throws(()=>parseAssist('customer',JSON.stringify(x)));
});
test('reviewer keeps original statement/details and newest eight messages; trims oldest selected text first',()=>{
  const r=boundedReviewerInput({statement:'😀'.repeat(2000),details:'d'.repeat(2000),status:'received',messages:Array.from({length:10},(_,i)=>({author:i%2?'agent':'customer',body:String(i).repeat(1000)}))});
  assert.equal(r.context_truncated,true);assert.equal(r.messages.length,8);assert.equal(r.messages.at(-1).body,'9'.repeat(1000));assert.equal(r.messages.reduce((n,m)=>n+[...m.body].length,0),4000);assert.equal([...r.statement].length,2000);
});
test('customer body projects only question and vocabulary, never arbitrary history',async()=>{
  resetTokenCache();const g=mock('{"intent":"human","field":null}');const r=await runAssist(env,{mode:'customer',language:'pt',input:{question:'Preciso de ajuda',history:'PRIVATE'}},{fetcher:g.fetcher});assert.equal(r.ok,true);const body=JSON.parse(g.calls.at(-1).init.body);assert.equal(body.max_tokens,128);assert.ok(!JSON.stringify(body).includes('PRIVATE'));
});
test('invalid output keeps known usage; missing/partial/invalid usage stays unknown; failures never retry',async()=>{
  for(const usage of [null,{prompt_tokens:3},{prompt_tokens:-1,completion_tokens:2},{prompt_tokens:1.5,completion_tokens:2}]) {resetTokenCache();const g=mock('invalid',usage);const r=await runAssist(env,args,{fetcher:g.fetcher});assert.equal(r.kind,'invalid_output');assert.equal(r.usage.usage_unavailable_calls,1);assert.equal(g.calls.length,3);}
  resetTokenCache();const g=mock('invalid');const r=await runAssist(env,args,{fetcher:g.fetcher});assert.equal(r.usage.known_input_tokens,30);
  resetTokenCache();let calls=0;const r2=await runAssist(env,args,{fetcher:async url=>{calls++;if(url.endsWith('/v1/token'))return json({access_token:'sts'});if(url.endsWith(':generateAccessToken'))return json({accessToken:'token',expireTime:new Date(Date.now()+3600000).toISOString()});return new Response('PRIVATE',{status:429});}});assert.equal(r2.kind,'provider_error');assert.equal(r2.usage.usage_unavailable_calls,1);assert.equal(calls,3);
});
test('external abort covers authentication and prevents a later provider call',async()=>{
  resetTokenCache();const controller=new AbortController();let reached;const started=new Promise(r=>reached=r);let signal;
  const pending=runAssist(env,args,{signal:controller.signal,fetcher:async(_,init)=>{signal=init.signal;reached();return new Promise(()=>{});}});await started;controller.abort();const r=await pending;assert.equal(r.kind,'timeout');assert.equal(r.usage.llm_calls,0);assert.equal(signal.aborted,true);
});
test('auth and provider share one overall deadline including hanging response reads',async t=>{
  resetTokenCache();t.mock.timers.enable({apis:['setTimeout']});let reached;const atProvider=new Promise(r=>reached=r);let providerSignal;
  const g=mock();const fetcher=async(url,init)=>{if(url.endsWith('/v1/token')){t.mock.timers.tick(4000);return g.fetcher(url,init);}if(!url.endsWith('/chat/completions'))return g.fetcher(url,init);providerSignal=init.signal;reached();return new Promise(()=>{});};
  const pending=runAssist(env,args,{fetcher});await atProvider;t.mock.timers.tick(ASSIST_TIMEOUT_MS-4001);let settled=false;pending.then(()=>settled=true);await new Promise(r=>setImmediate(r));assert.equal(settled,false);t.mock.timers.tick(1);const r=await pending;assert.equal(r.kind,'timeout');assert.equal(providerSignal.aborted,true);assert.equal(r.usage.llm_calls,1);assert.equal(r.usage.usage_unavailable_calls,1);
});
test('deadline aborts a hanging response body and cannot later change returned unknown usage',async t=>{
  resetTokenCache();t.mock.timers.enable({apis:['setTimeout']});let ready;const reading=new Promise(r=>ready=r);let cancelled=false;const g=mock();
  const fetcher=async(url,init)=>{if(!url.endsWith('/chat/completions'))return g.fetcher(url,init);return new Response(new ReadableStream({start(){ready();},cancel(){cancelled=true;}}));};
  const pending=runAssist(env,args,{fetcher});await reading;await new Promise(r=>setImmediate(r));t.mock.timers.tick(ASSIST_TIMEOUT_MS);const result=await pending;assert.equal(result.kind,'timeout');assert.equal(result.usage.usage_unavailable_calls,1);await new Promise(r=>setImmediate(r));assert.equal(cancelled,true);
});
test('invalid inputs and missing configuration never reach authentication; malformed/oversized provider bodies remain unknown',async()=>{
  for(const input of [{...args,input:{...args.input,statement:'\ud800'}},{mode:'customer',language:'en',input:{question:''}},{...args,language:'fr'}]){const g=mock();assert.equal((await runAssist(env,input,{fetcher:g.fetcher})).kind,'config_error');assert.equal(g.calls.length,0);}
  const g=mock();assert.equal((await runAssist({...env,VERTEX_WIF_SIGNING_KEY:''},args,{fetcher:g.fetcher})).kind,'config_error');assert.equal(g.calls.length,0);
  for(const data of [new Uint8Array([255]),'x'.repeat(65537),'{']){resetTokenCache();const m=mock();const r=await runAssist(env,args,{fetcher:(url,init)=>url.endsWith('/chat/completions')?Promise.resolve(new Response(data)):m.fetcher(url,init)});assert.equal(r.kind,'provider_error');assert.equal(r.usage.usage_unavailable_calls,1);}
});
test('partial usage preserves independently known tokens while keeping the call unknown',async()=>{
  resetTokenCache();const g=mock(JSON.stringify(value),{prompt_tokens:30});const r=await runAssist(env,args,{fetcher:g.fetcher});assert.equal(r.usage.known_input_tokens,30);assert.equal(r.usage.known_output_tokens,0);assert.equal(r.usage.usage_unavailable_calls,1);
});
test('existing idle sweep invokes assistance cleanup once even when episode maxPages is 100',async()=>{
  const {closeIdleIntakes}=await import('../../scripts/close-idle-intakes.mjs');let calls=0;
  const store={closeIdleIntakes:async()=>[],hasDueIdleIntakes:async()=>false,closeStaleSuggestionRuns:async()=>[],metrics:()=>({}),sweepAssistRuns:async bounds=>{calls++;assert.equal(bounds.limit,100);return {abandoned:100,deleted:100};}};
  const result=await closeIdleIntakes(store,{now:Date.now(),maxPages:100});assert.equal(calls,1);assert.equal(result.assist_abandoned,100);assert.equal(result.assist_deleted,100);
});
test('malformed or oversized open provider streams are cancelled without waiting for cancellation',async()=>{
  for(const chunk of [new Uint8Array([255]),new Uint8Array(65537)]) {
    resetTokenCache();let cancelled=false;const g=mock();
    const stream=new ReadableStream({start(controller){controller.enqueue(chunk);},cancel(){cancelled=true;return new Promise(()=>{});}});
    const result=await runAssist(env,args,{fetcher:(url,init)=>url.endsWith('/chat/completions')?Promise.resolve(new Response(stream)):g.fetcher(url,init)});
    assert.equal(result.kind,'provider_error');assert.equal(result.usage.usage_unavailable_calls,1);assert.equal(cancelled,true);
  }
});

const discoveryValue = { intent: 'transaction_search',
  criteria: { merchant_hint: 'Streaming', date_from: '2026-04-01', date_to: '2026-04-30', currency: 'ARS', amount_operator: 'gt', amount: 85000 },
  missing_fields: [], confidence: 0.9 };

for (const mode of ['discovery']) {
  test(`${mode} uses its dedicated schema and projects only bounded input in each language`, async () => {
    const { PROMPTS, SCHEMAS } = await import('../../src/modules/intake/assist-prompts.js');
    for (const language of ['es', 'pt', 'en']) {
      resetTokenCache();
      const output = discoveryValue;
      const g = mock(JSON.stringify(output));
      const key = 'description';
      const text = '😀'.repeat(2000);
      const result = await runAssist({ ...env, ASSIST_DISCOVERY_ENABLED: '1' },
        { mode, language, input: { [key]: text, customer_id: 'PRIVATE', history: 'PRIVATE', transactions: ['PRIVATE'] } }, { fetcher: g.fetcher });
      assert.equal(result.ok, true);
      assert.deepEqual(result.value, output);
      const calls = g.calls.filter(call => call.url.endsWith('/chat/completions'));
      assert.equal(calls.length, 1);
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.max_tokens, 256);
      assert.equal(body.messages[0].content, PROMPTS[mode]);
      assert.deepEqual(body.response_format.json_schema, { name: `support_${mode}`, strict: true, schema: SCHEMAS[mode] });
      const context = JSON.parse(body.messages[1].content);
      assert.deepEqual(Object.keys(context).sort(), ['language', key, 'operators', 'intents'].sort());
      assert.equal(context[key], text); assert.equal(context.language, language);
      assert.ok(!JSON.stringify(body).includes('PRIVATE'));
    }
  });

  test(`${mode} rejects invalid input before any authentication or model call`, async () => {
    for (const text of ['', ' \t', '\ud800', 'a\0b', '😀'.repeat(2001), 12, null]) {
      const g = mock();
      const result = await runAssist({ ...env, ASSIST_DISCOVERY_ENABLED: '1' },
        { mode, language: 'en', input: { description: text } }, { fetcher: g.fetcher });
      assert.equal(result.kind, 'config_error'); assert.equal(result.usage.llm_calls, 0); assert.equal(g.calls.length, 0);
    }
  });
}

test('discovery extraction stays off unless its own flag is exactly the string 1', async () => {
  for (const flag of [undefined, '0', 'true', true, 1]) {
    const g = mock();
    const result = await runAssist({ ...env, ASSIST_DISCOVERY_ENABLED: flag },
      { mode: 'discovery', language: 'en', input: { description: 'Streaming in April' } }, { fetcher: g.fetcher });
    assert.equal(result.kind, 'config_error'); assert.equal(g.calls.length, 0);
  }
});

test('the discovery flag alone enables discovery independently of customer and reviewer assistance', async () => {
  resetTokenCache();
  const g = mock(JSON.stringify(discoveryValue));
  const result = await runAssist({ ...env, ASSIST_CUSTOMER_ENABLED: undefined, ASSIST_REVIEWER_ENABLED: undefined, ASSIST_DISCOVERY_ENABLED: '1' },
    { mode: 'discovery', language: 'en', input: { description: 'Streaming in April' } }, { fetcher: g.fetcher });
  assert.equal(result.ok, true, 'ADR-016 defines discovery as independently enabled');
  assert.equal(g.calls.filter(call => call.url.endsWith('/chat/completions')).length, 1);
});
