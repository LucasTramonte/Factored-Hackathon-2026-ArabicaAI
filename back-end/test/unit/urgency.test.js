/** urgencyOf: a stated fixed threshold per currency, or above the customer's own p95 with at least 5 others. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { urgencyOf } from '../../src/modules/intake/urgency.js';
import config from '../../src/config/urgency.json' with { type: 'json' };

const tx = (amount, currency = 'BRL') => ({ amount, currency });
const others = (amounts, currency = 'BRL') => amounts.map(a => tx(a, currency));

test('the fixed threshold applies per currency, inclusive, on string amounts', () => {
  for (const [currency, limit] of Object.entries(config.fixed)) {
    assert.equal(urgencyOf(tx(String(limit), currency), [], config), 'high', currency);
    assert.equal(urgencyOf(tx((limit - 0.01).toFixed(2), currency), [], config), 'normal', currency);
  }
  assert.equal(urgencyOf(tx('3890.00'), [], config), 'high');
});

test('above the p95 (nearest rank) of at least 5 same-currency others is high; at the p95 is not', () => {
  const five = others(['10.00', '20.00', '30.00', '40.00', '50.00']); // nearest-rank p95 of 5 is the 5th value
  assert.equal(urgencyOf(tx('50.01'), five, config), 'high');
  assert.equal(urgencyOf(tx('50.00'), five, config), 'normal');
  const twenty = others(Array.from({ length: 20 }, (_, i) => String(i + 1))); // p95 rank 19 -> 19
  assert.equal(urgencyOf(tx('19.50'), twenty, config), 'high');
  assert.equal(urgencyOf(tx('19.00'), twenty, config), 'normal');
});

test('fewer than 5 same-currency others leave only the fixed rule; other currencies do not count', () => {
  assert.equal(urgencyOf(tx('400.00'), others(['1.00', '1.00', '1.00', '1.00']), config), 'normal');
  const mixed = [...others(['1.00', '1.00', '1.00', '1.00']), tx('1.00', 'USD'), tx('1.00', 'COP')];
  assert.equal(urgencyOf(tx('400.00'), mixed, config), 'normal');
});

test('an unknown currency uses the relative rule only', () => {
  assert.equal(urgencyOf(tx('999999999', 'XYZ'), [], config), 'normal');
  assert.equal(urgencyOf(tx('60', 'XYZ'), others(['10', '20', '30', '40', '50'], 'XYZ'), config), 'high');
});

test('the policy names every served currency with a positive round amount and a demo block line', () => {
  for (const currency of ['BRL', 'USD', 'COP', 'ARS', 'MXN']) assert.ok(config.fixed[currency] > 0, currency);
  assert.equal(config.relative_min_others, 5);
  assert.match(config.demo_block_line, /\(demo\)$/);
});
