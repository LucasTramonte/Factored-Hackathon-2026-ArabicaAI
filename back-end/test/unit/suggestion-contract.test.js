/**
 * The contract the AI suggestion docs describe (Docs/Plans/ai-suggestion-plan.md, "How a suggestion is found"): the model's
 * facts are matched deterministically against the customer's own purchases as D1 serves them; 1–3 fits are suggested in
 * transaction_id order (no ranking), more than 3 is ambiguous and shows nothing, and a fact D1 can't check fits nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestionFor } from '../../src/modules/intake/suggestions.js';

const AS_OF = '2026-06-12T12:00:00';
const facts = stated_facts => ({ intent: 'report', stated_facts, invalid: null, demand: null, injection: false });
const buy = (transaction_id, merchant_name, amount, day = '2026-06-10', currency = 'ARS') =>
  ({ transaction_id, merchant_name, amount, currency, occurred_at: null, source_occurred_at: `${day}T10:00:00` });
const own = (...purchases) => ({ country: 'Argentina', purchases });

test('1–3 fits are suggested in transaction_id order, whatever order D1 returned them in; no ranking', () => {
  const purchases = own(buy('T9', 'Uber', '120.00'), buy('T2', 'Uber', '80.00'), buy('T5', 'Farmacia Salud', '50.00'));
  assert.deepEqual(suggestionFor(facts({ merchant: 'Uber' }), purchases, AS_OF), { outcome: 'suggested', ids: ['T2', 'T9'] });
  assert.deepEqual(suggestionFor(facts({ amount: { value: '50.00', approx: false } }), purchases, AS_OF), { outcome: 'suggested', ids: ['T5'] });
});

test('more than 3 fits is ambiguous and shows nothing; nothing fitting, or no usable fact, is no_match', () => {
  const four = own(...['T1', 'T2', 'T3', 'T4'].map(id => buy(id, 'Uber', '10.00')));
  assert.deepEqual(suggestionFor(facts({ merchant: 'Uber' }), four, AS_OF), { outcome: 'ambiguous', ids: [] });
  assert.deepEqual(suggestionFor(facts({ merchant: 'Cine Premium' }), four, AS_OF), { outcome: 'no_match', ids: [] });
  assert.deepEqual(suggestionFor(facts({}), four, AS_OF), { outcome: 'no_match', ids: [] });
});

test('an amount fits exactly, or within 10% when the customer said "about"; another currency never fits', () => {
  const purchases = own(buy('T1', 'Uber', '105.00'), buy('T2', 'Uber', '100.00', '2026-06-10', 'USD'));
  assert.deepEqual(suggestionFor(facts({ amount: { value: '100', approx: false } }), purchases, AS_OF).ids, ['T2']);
  assert.deepEqual(suggestionFor(facts({ amount: { value: '100', approx: true } }), purchases, AS_OF).ids, ['T1', 'T2']);
  assert.deepEqual(suggestionFor(facts({ amount: { value: '100', approx: true }, currency: 'ARS' }), purchases, AS_OF).ids, ['T1']);
});

test('"reais", "real", "reales" or "R$" fits the customer\'s BRL charges; any other word is the evaluated rule\'s, unchanged', () => {
  const purchases = own(buy('T1', 'Mercado Central', '125.50', '2026-06-10', 'BRL'), buy('T2', 'Mercado Central', '125.50', '2026-06-10', 'USD'));
  for (const currency of ['reais', 'Reais', ' R$ ', 'real', 'reales', 'BRL']) {
    assert.deepEqual(suggestionFor(facts({ amount: { value: '125.50', approx: false }, currency }), purchases, AS_OF), { outcome: 'suggested', ids: ['T1'] }, currency);
  }
  assert.deepEqual(suggestionFor(facts({ amount: { value: '125.50', approx: false }, currency: 'dólares' }), purchases, AS_OF).ids, ['T2']);
  const pesos = own(buy('T1', 'Uber', '10.00'));
  for (const currency of ['reais', 'R$', 'constructor', 'yenes']) {
    assert.deepEqual(suggestionFor(facts({ merchant: 'Uber', currency }), pesos, AS_OF), { outcome: 'no_match', ids: [] }, currency);
  }
});

test('a card, last four digits, country or "abroad" fact fits no online purchase: D1 holds none of them', () => {
  const purchases = own(buy('T1', 'Uber', '10.00'));
  for (const extra of [{ card: { type: 'débito' } }, { card: { last4: '4821' } }, { country: 'Argentina' }, { abroad: false }]) {
    assert.deepEqual(suggestionFor(facts({ merchant: 'Uber', ...extra }), purchases, AS_OF), { outcome: 'no_match', ids: [] }, JSON.stringify(extra));
  }
});
