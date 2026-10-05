/** Strict structured discovery output, independent of model phrasing or provider availability. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAssist } from '../../src/modules/intake/assist.js';
import { assertContract } from '../support/contract.js';

const emptyCriteria = { merchant_hint: null, date_from: null, date_to: null, currency: null, amount_operator: null, amount: null };
const extraction = (criteria = {}, extra = {}) => ({ intent: 'transaction_search',
  criteria: { ...emptyCriteria, ...criteria }, missing_fields: [], confidence: 0.9, ...extra });
const parse = value => parseAssist('discovery', JSON.stringify(value));

for (const operator of ['eq', 'approx', 'gt', 'gte', 'lt', 'lte']) {
  test(`discovery preserves ${operator}, including zero and fractional amounts`, () => {
    for (const amount of [0, 0.01, 85000]) {
      const value = extraction({ merchant_hint: 'Streaming', date_from: '2026-04-01', date_to: '2026-04-30',
        currency: 'ARS', amount_operator: operator, amount });
      assert.deepEqual(parse(value), value);
    }
  });
}

test('unknown criteria, confidence endpoints and three distinct missing fields are accepted', () => {
  for (const confidence of [0, 1]) {
    const value = extraction({}, { confidence, missing_fields: ['merchant', 'date', 'amount'] });
    assert.deepEqual(parse(value), value);
  }
  assert.equal(parse(extraction({ merchant_hint: '😀'.repeat(100) })).criteria.merchant_hint, '😀'.repeat(100));
});

const invalidCriteria = {
  'empty merchant': { merchant_hint: '' }, 'blank merchant': { merchant_hint: ' \t' },
  'oversized Unicode merchant': { merchant_hint: '😀'.repeat(101) },
  'unpaired surrogate': { merchant_hint: '\ud800' }, 'NUL': { merchant_hint: 'shop\0' },
  'numeric merchant': { merchant_hint: 12 }, 'boolean merchant': { merchant_hint: true },
  'malformed start date': { date_from: '2026-4-01' }, 'malformed end date': { date_to: 'April 30' },
  'numeric date': { date_from: 20260401 }, 'lowercase currency': { currency: 'ars' },
  'long currency': { currency: 'USDT' }, 'unknown operator': { amount_operator: 'between', amount: 10 },
  'SQL operator': { amount_operator: '> 0 OR 1=1 --', amount: 10 },
  'amount without operator': { amount: 0 }, 'operator without amount': { amount_operator: 'eq' },
  'negative amount': { amount_operator: 'eq', amount: -0.01 },
  'string amount': { amount_operator: 'eq', amount: '85000' },
  'boolean amount': { amount_operator: 'eq', amount: true },
  'extra ownership': { customer_id: 'another-customer' }, 'extra SQL': { sql: 'SELECT * FROM transactions' }
};
for (const [name, criteria] of Object.entries(invalidCriteria)) {
  test(`discovery rejects ${name}`, () => assert.throws(() => parse(extraction(criteria)), SyntaxError));
}

test('discovery rejects missing keys at either level and non-object criteria', () => {
  for (const key of Object.keys(extraction())) {
    const value = extraction(); delete value[key];
    assert.throws(() => parse(value), key);
  }
  for (const key of Object.keys(emptyCriteria)) {
    const value = extraction(); delete value.criteria[key];
    assert.throws(() => parse(value), key);
  }
  for (const criteria of [null, [], 'merchant', 0]) assert.throws(() => parse(extraction({}, { criteria })));
});

for (const [name, extra] of Object.entries({
  'non-search intent with criteria': { intent: 'transaction_confirmation' }, 'wrong action': { action: 'refund' },
  'prose': { answer: 'Refunded' }, 'missing fields not an array': { missing_fields: 'date' },
  'unknown field': { missing_fields: ['customer_id'] }, 'duplicate fields': { missing_fields: ['date', 'date'] },
  'too many fields': { missing_fields: ['merchant', 'date', 'amount', 'currency'] },
  'negative confidence': { confidence: -0.01 }, 'excess confidence': { confidence: 1.01 },
  'string confidence': { confidence: '0.9' }, 'null confidence': { confidence: null }
})) test(`discovery rejects ${name}`, () => assert.throws(() => parse(extraction({}, extra)), SyntaxError));

test('discovery consumes complete JSON and rejects non-finite JSON numbers', () => {
  const raw = JSON.stringify(extraction());
  for (const content of [null, {}, '', 'null', '[]', `prefix ${raw}`, `\`\`\`json\n${raw}\n\`\`\``, `${raw}${raw}`,
    raw.replace('"confidence":0.9', '"confidence":1e400'),
    JSON.stringify(extraction({ amount_operator: 'gt', amount: 1 })).replace('"amount":1', '"amount":1e400')]) {
    assert.throws(() => parseAssist('discovery', content));
  }
});

test('search intent classification requires criteria, while all other intents require null', () => {
  for (const intent of ['transaction_search', 'transaction_clarification', 'transaction_correction']) {
    const value = extraction({}, { intent });
    assert.deepEqual(parse(value), value);
    assert.throws(() => parse({ ...value, criteria: null }), SyntaxError);
  }
  for (const intent of ['transaction_confirmation', 'greeting_or_casual', 'unsupported', 'safety_or_injection']) {
    const value = extraction({}, { intent, criteria: null });
    assert.deepEqual(parse(value), value);
    assert.throws(() => parse({ ...value, criteria: emptyCriteria }), SyntaxError);
  }
  for (const intent of ['refund', null, ['transaction_search']]) assert.throws(() => parse(extraction({}, { intent })), SyntaxError);
});

test('calendar validation accepts leap days and same-day searches but rejects impossible or reversed dates', () => {
  for (const date of ['2024-02-29', '2000-02-29', '2026-04-30']) {
    const value = extraction({ date_from: date, date_to: date }); assert.deepEqual(parse(value), value);
  }
  for (const date of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00']) {
    for (const key of ['date_from', 'date_to']) assert.throws(() => parse(extraction({ [key]: date })), date);
  }
  assert.throws(() => parse(extraction({ date_from: '2026-05-01', date_to: '2026-04-30' })), SyntaxError);
  for (const merchant_hint of ['<b>Shop</b>', 'https://example.test', 'HTTP://example.test']) {
    assert.throws(() => parse(extraction({ merchant_hint })), SyntaxError);
  }
});

test('discovery response contract rejects leaked prose, excess candidates and invalid metadata', () => {
  const { criteria, missing_fields, confidence } = extraction();
  const tx = { transaction_id: 'synthetic-tx', merchant_name: 'Shop', amount: '10.00', currency: 'ARS',
    occurred_at: null, source_occurred_at: null };
  const value = { criteria, missing_fields, confidence, status: 'candidates', items: [tx] };
  assertContract('transactionDiscovery', value);
  for (const bad of [{ ...value, text: 'Model prose' }, { ...value, status: 'confirmed' },
    { ...value, items: [tx, tx, tx, tx] }, { ...value, confidence: 1.01 },
    { ...value, missing_fields: ['date', 'date'] }, { ...value, criteria: { ...criteria, customer_id: 'foreign' } },
    { ...value, items: [{ ...tx, customer_id: 'foreign' }] }]) {
    assert.throws(() => assertContract('transactionDiscovery', bad), /violated/);
  }
});
