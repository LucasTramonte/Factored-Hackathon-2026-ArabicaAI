/** Case-request validation: exact types, code-point bounds, and no prototype tricks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCaseRequest } from '../../src/modules/customer/validation.js';
import { validateStartRequest, REASONS } from '../../src/modules/intake/validation.js';

const ok = { transaction_id: 'demo-tx-001', customer_statement: 'I do not recognize this charge.',
  customer_confirmed: true, idempotency_key: '0f8fad5b-d9cb-469f-a165-70867728950e' };

test('a well-formed request is normalized', () => {
  assert.deepEqual(validateCaseRequest({ ...ok, customer_statement: '  I do not recognize this charge.  ' }).value, {
    transactionId: 'demo-tx-001', statement: 'I do not recognize this charge.',
    idempotencyKey: '0f8fad5b-d9cb-469f-a165-70867728950e' });
});

test('confirmation must be exactly boolean true', () => {
  for (const value of [false, 'true', 1, null, undefined, {}, [true]]) {
    assert.equal(validateCaseRequest({ ...ok, customer_confirmed: value }).error?.status, 422, String(value));
  }
});

test('statement bounds count code points, not UTF-16 units', () => {
  assert.ok(validateCaseRequest({ ...ok, customer_statement: '😀'.repeat(10) }).value);
  assert.ok(validateCaseRequest({ ...ok, customer_statement: '😀'.repeat(2000) }).value);
  for (const statement of ['😀'.repeat(9), '😀'.repeat(2001), ' '.repeat(50), 'x'.repeat(9), 42, null, ['long enough text']]) {
    assert.equal(validateCaseRequest({ ...ok, customer_statement: statement }).error?.status, 422);
  }
});

test('transaction id and idempotency key are strictly typed', () => {
  for (const patch of [{ transaction_id: '' }, { transaction_id: 7 }, { transaction_id: 'x'.repeat(101) },
    { idempotency_key: 'not-a-uuid' }, { idempotency_key: '0f8fad5b-d9cb-069f-a165-70867728950e' },
    { idempotency_key: 12345 }]) {
    assert.equal(validateCaseRequest({ ...ok, ...patch }).error?.status, 422, JSON.stringify(patch));
  }
});

test('non-object bodies and prototype keys never pass', () => {
  for (const body of [null, 'text', 3, [], JSON.parse('{"__proto__": {"customer_confirmed": true}}')]) {
    assert.equal(validateCaseRequest(body).error?.status, 422);
  }
  const polluted = JSON.parse(`{"__proto__": {"customer_confirmed": true}, ${JSON.stringify(ok).slice(1, -1).replace('"customer_confirmed":true', '"customer_confirmed":false')}}`);
  assert.equal(validateCaseRequest(polluted).error?.status, 422);
  assert.equal(({}).customer_confirmed, undefined);
});

test('SQL-looking text is accepted as data', () => {
  const statement = "'); DELETE FROM cases; -- I do not recognize it";
  assert.equal(validateCaseRequest({ ...ok, customer_statement: statement }).value.statement, statement);
});

test('lone UTF-16 surrogates are rejected before they reach storage', () => {
  assert.equal(validateCaseRequest({ ...ok, customer_statement: 'I do not know this \ud800 charge at all' }).error?.status, 422);
  assert.equal(validateCaseRequest({ ...ok, transaction_id: 'tx-\udc00' }).error?.status, 422);
  assert.ok(validateCaseRequest({ ...ok, customer_statement: 'Emoji pairs are fine 😀😀😀' }).value);
});

const start = { language: 'es', mode: 'guided', report_type: 'unrecognized_charge', reason: 'not_mine',
  customer_statement: 'No reconozco este cargo.', idempotency_key: '0f8fad5b-d9cb-469f-a165-70867728950e' };

test('a guided start requires one reason from the closed list (ADR-010)', () => {
  const { reason, ...missing } = start;
  assert.deepEqual(validateStartRequest(missing).error, { status: 422, detail: 'Provide exactly the guided report fields' });
  for (const value of ['nope', 'NOT_MINE', 1]) {
    assert.deepEqual(validateStartRequest({ ...start, reason: value }).error, { status: 422, detail: 'Choose one of the report reasons' }, String(value));
  }
  assert.equal(validateStartRequest({ ...start, reason: 'duplicate' }).value.reason, 'duplicate');
});

test('the reasons list mirrors the migration CHECK', () => {
  const sql = readFileSync(new URL('../../migrations/0016_report_reason.sql', import.meta.url), 'utf8');
  const group = sql.match(/IN \(([^)]*)\)/)[1];
  assert.deepEqual(REASONS, [...group.matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
});
