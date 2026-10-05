/** New standard schema keywords keep exact assistance responses constrained in contract checks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertContract } from '../support/contract.js';
test('assistance contracts reject unknown vocabulary, duplicate fields and snapshot range errors', () => {
  const valid = { summary: 'Resumen', draft: 'Pregunta', missing_fields: ['merchant'], language: 'es', snapshot: { status: 'received', message_count: 0 }, context_truncated: false };
  assertContract('reviewerAssist', valid);
  for (const bad of [ { ...valid, language: 'fr' }, { ...valid, missing_fields: ['merchant','merchant'] },
    { ...valid, missing_fields: ['other'] }, { ...valid, snapshot: { status: 'received', message_count: -1 } },
    { ...valid, snapshot: { status: 'received', message_count: 51 } }, { ...valid, extra: true } ]) assert.throws(() => assertContract('reviewerAssist', bad), /violated/);
});
test('customer contract validates every intent/field combination without allowing provider prose',()=>{
 for(const intent of ['status','next_step','provide_details','human','unsupported'])for(const field of [null,'merchant','amount','currency','date','description']){
  const value={intent,field,language:'en',snapshot:{status:'received',message_count:0}};
  if(intent==='provide_details'||field===null)assertContract('customerAssist',value);else assert.throws(()=>assertContract('customerAssist',value),/violated/);
 }
 assert.throws(()=>assertContract('customerAssist',{intent:'status',field:null,language:'en',snapshot:{status:'received',message_count:0},text:'Refunded'}),/violated/);
});
