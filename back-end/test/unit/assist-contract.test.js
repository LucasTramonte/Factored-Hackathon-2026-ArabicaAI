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
