/** The contract validator must actually reject violations, or every contract check is vacuous. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertContract } from '../support/contract.js';

const receipt = { protocol: '11111111-2222-4333-8444-555555555555', transaction_id: 'tx', status: 'accepted',
  accepted_at: '2026-09-29T12:00:00.000Z', replayed: false, scope: 'synthetic_demo_only', next_step: 'Await review' };

test('a valid receipt passes', () => assertContract('caseReceipt', receipt));

test('violations are reported', () => {
  for (const bad of [{ ...receipt, extra: 1 }, { ...receipt, status: 'refunded' }, { ...receipt, replayed: 'no' },
    { ...receipt, protocol: 'CS-1' }, (({ protocol, ...rest }) => rest)(receipt)]) {
    assert.throws(() => assertContract('caseReceipt', bad), /violated/);
  }
  assert.throws(() => assertContract('transactionList', { items: [{ transaction_id: 'x', occurred_at: null,
    source_occurred_at: null, merchant_name: 'm', amount: '1.234', currency: 'ARS' }], has_more: false, coverage: 'c' }), /amount/);
  assert.throws(() => assertContract('nope', {}), /Unknown contract/);
});
