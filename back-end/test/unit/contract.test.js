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

test('the context card shape is part of the session contract', () => {
  const card = { version: 1, snapshot_at: '2026-09-29T00:00:00+00:00', first_name: 'Ana', locale_hint: 'es-AR',
    products: [{ product_type: 'Credit card', last4: '4444', currency: 'ARS' }] };
  const session = context_card => ({ customer_id: 'demo-ana', mode: 'simulated_login', context_card });
  assertContract('customerSession', session(card));
  assertContract('customerSession', session(null));
  assertContract('customerSession', session({ ...card, first_name: null, products: [{ product_type: 'Account', last4: null, currency: null }] }));
  for (const bad of [{ ...card, version: 2 }, { ...card, product_number: '4111222233334444' },
    { ...card, locale_hint: 'estonian' }, (({ products, ...rest }) => rest)(card),
    { ...card, products: [{ ...card.products[0], last4: '22223333' }] },
    { ...card, products: [{ ...card.products[0], balance: 10 }] }]) {
    assert.throws(() => assertContract('customerSession', session(bad)), /violated/);
  }
});
