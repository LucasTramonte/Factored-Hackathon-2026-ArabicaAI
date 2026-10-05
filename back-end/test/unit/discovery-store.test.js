/** Execute the discovery query against SQLite rather than matching SQL text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createStore } from '../../src/store/d1.js';

function setup(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.exec("INSERT INTO customers(customer_id,display_name) VALUES('owner','Synthetic Owner'),('other','Synthetic Other')");
  const calls = [];
  const store = createStore({ prepare: sql => ({ bind: (...params) => ({ all: async () => {
    calls.push({ sql, params });
    return { results: db.prepare(sql).all(...params).map(row => ({ ...row })) };
  } }) }) });
  const insert = (id, { owner = 'owner', merchant = 'Streaming', amount = '85000.00', currency = 'ARS',
    date = '2026-04-15T12:00:00Z', source = null } = {}) => {
    db.prepare('INSERT INTO transactions(transaction_id,customer_id,merchant_name,amount,currency,occurred_at,source_occurred_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, owner, merchant, amount, currency, date, source);
  };
  const search = async criteria => (await store.searchOwnedTransactions('owner', criteria)).map(row => row.transaction_id);
  return { db, store, calls, insert, search };
}

for (const [operator, expected] of Object.entries({ eq: ['equal'], gt: ['above'], gte: ['above', 'equal'], lt: ['below'], lte: ['below', 'equal'] })) {
  test(`${operator} compares stored decimal amounts numerically at the boundary`, async t => {
    const { insert, search } = setup(t);
    insert('below', { amount: '9.99' }); insert('equal', { amount: '10.00' }); insert('above', { amount: '100.00' });
    assert.deepEqual(await search({ amount_operator: operator, amount: 10 }), expected);
    assert.deepEqual(await search({ amount_operator: 'gte', amount: 0 }), ['above', 'below', 'equal']);
  });
}

test('Streaming/April/ARS regression combines every predicate, inclusive dates and strict more-than', async t => {
  const { insert, search } = setup(t);
  insert('start', { date: '2026-04-01T00:00:00Z', merchant: 'STREAMING service', amount: '85000.01' });
  insert('end', { date: '2026-04-30T23:59:59Z', merchant: 'my Streaming', amount: '100000.00' });
  insert('equal');
  insert('early', { date: '2026-03-31T23:59:59Z', amount: '90000.00' });
  insert('late', { date: '2026-05-01T00:00:00Z', amount: '90000.00' });
  insert('currency', { currency: 'BRL', amount: '90000.00' });
  insert('merchant', { merchant: 'Other shop', amount: '90000.00' });
  insert('foreign', { owner: 'other', amount: '90000.00' });
  assert.deepEqual(await search({ merchant_hint: 'sTrEaMiNg', date_from: '2026-04-01', date_to: '2026-04-30',
    currency: 'ARS', amount_operator: 'gt', amount: 85000 }), ['end', 'start']);
});

test('either date endpoint works alone and a reversed range finds nothing', async t => {
  const { insert, search } = setup(t);
  insert('before', { date: '2026-03-31T23:59:59Z' }); insert('on'); insert('after', { date: '2026-05-01T00:00:00Z' });
  assert.deepEqual(await search({ date_from: '2026-04-01' }), ['after', 'on']);
  assert.deepEqual(await search({ date_to: '2026-04-30' }), ['on', 'before']);
  assert.deepEqual(await search({ date_from: '2026-05-01', date_to: '2026-04-01' }), []);
});

test('empty criteria still enforce ownership, stable ordering and four-row ambiguity sentinel', async t => {
  const { insert, store, calls, search } = setup(t);
  insert('foreign-newest', { owner: 'other', date: '2026-06-01T00:00:00Z' });
  for (const id of ['c', 'b', 'a']) insert(id);
  insert('newest', { date: '2026-05-01T00:00:00Z' }); insert('oldest', { date: '2026-01-01T00:00:00Z' });
  for (const criteria of [undefined, null, {}, { merchant_hint: null, date_from: null, date_to: null, currency: null, amount_operator: null, amount: null }]) {
    const before = calls.length;
    assert.deepEqual(await search(criteria), ['newest', 'a', 'b', 'c']);
    assert.equal(calls.length - before, 1, 'one database round trip per lookup');
  }
  assert.deepEqual(await store.searchOwnedTransactions('missing', {}), []);
});

test('lookup preserves source timestamps and amount strings and projects only charge fields', async t => {
  const { insert, store } = setup(t);
  insert('source-a', { date: null, source: '2026-04-15T13:00:00', amount: '10.50' });
  insert('source-b', { date: null, source: '2026-04-15T14:00:00' });
  assert.deepEqual(await store.searchOwnedTransactions('owner', {}), [
    { transaction_id: 'source-b', merchant_name: 'Streaming', amount: '85000.00', currency: 'ARS', occurred_at: null, source_occurred_at: '2026-04-15T14:00:00' },
    { transaction_id: 'source-a', merchant_name: 'Streaming', amount: '10.50', currency: 'ARS', occurred_at: null, source_occurred_at: '2026-04-15T13:00:00' }
  ]);
});

test('SQL-shaped merchant and customer values stay parameters and cannot cross owners or mutate data', async t => {
  const { db, insert, store, calls, search } = setup(t);
  const merchant = "Shop' OR 1=1 --";
  insert('literal', { merchant }); insert('other-match', { owner: 'other', merchant }); insert('ordinary');
  assert.deepEqual(await search({ merchant_hint: merchant }), ['literal']);
  assert.ok(!calls.at(-1).sql.includes(merchant));
  assert.deepEqual(calls.at(-1).params, ['owner', '%' + merchant.toLowerCase() + '%']);
  assert.deepEqual(await store.searchOwnedTransactions("owner' OR 1=1 --", {}), []);
  assert.deepEqual(await search({ merchant_hint: "'; DROP TABLE transactions; --" }), []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM transactions').get().n, 3);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});


test('LIKE wildcard characters in a hint are literal and cannot broaden the match', async t => {
  const { insert, search } = setup(t);
  insert('percent', { merchant: '50% off' }); insert('not-percent', { merchant: '50XYZ off' });
  insert('underscore', { merchant: 'shop_one' }); insert('not-underscore', { merchant: 'shopXone' });
  insert('backslash', { merchant: 'shop\\one' });
  assert.deepEqual(await search({ merchant_hint: '50%' }), ['percent']);
  assert.deepEqual(await search({ merchant_hint: 'shop_' }), ['underscore']);
  assert.deepEqual(await search({ merchant_hint: 'shop\\' }), ['backslash']);
});

for (const split of ['development', 'acceptance']) {
  test(`${split} corpus candidate IDs match the Worker lookup in order`, async t => {
    const { db, insert, search } = setup(t);
    const cases = readFileSync(new URL(`../../../evals/support_assist/discovery-${split}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
    for (const row of cases.filter(row => row.expected.criteria)) {
      db.exec('DELETE FROM transactions');
      for (const tx of row.fixture_transactions) insert(tx.transaction_id, { merchant:tx.merchant_name, amount:tx.amount,
        currency:tx.currency, date:tx.occurred_at, source:tx.source_occurred_at ?? null });
      assert.deepEqual(await search(row.expected.criteria), row.expected_candidate_ids, row.id);
    }
  });
}

/** Sofía's full inventory (seeds/fictitious.json, issue #141) plus another customer's identical Streaming Music charge. */
function sofia(t) {
  const s = setup(t);
  for (const [id, merchant, amount, date] of [['demo-tx-031', 'Boutique Moda', '2980.00', '2026-10-02T16:40'], ['demo-tx-030', 'Streaming Music', '24.90', '2026-09-30T03:00'],
    ['demo-tx-029', 'Restaurante El Buen Sabor', '112.00', '2026-09-27T20:16'], ['demo-tx-028', 'Restaurante El Buen Sabor', '112.00', '2026-09-27T20:15'],
    ['demo-tx-027', 'Mercado Central', '64.30', '2026-09-24T09:10']]) s.insert(id, { merchant, amount, currency: 'BRL', date: date + ':00+00:00' });
  s.insert('foreign-030', { owner: 'other', merchant: 'Streaming Music', amount: '24.90', currency: 'BRL', date: '2026-09-30T03:00:00+00:00' });
  return s;
}
const none = { merchant_hint: null, date_from: null, date_to: null, currency: null, amount_operator: null, amount: null };

test('Sofía: exact, case, word order and described merchant all reach demo-tx-030 (issue #141)', async t => {
  const { search } = sofia(t);
  for (const merchant_hint of ['Streaming Music', 'streaming music', 'STREAMING MUSIC', 'Streaming music', 'music streaming',
    'music streaming subscription', 'streaming subscription', 'Streaming']) {
    assert.deepEqual(await search({ ...none, merchant_hint }), ['demo-tx-030'], merchant_hint);
  }
});

test('Sofía: merchant with amount, with date, and with both identifies the unique charge in ES, PT and EN', async t => {
  const { search } = sofia(t);
  const about25 = { currency: 'BRL', amount_operator: 'approx', amount: 25 }, endOfSeptember = { date_from: '2026-09-25', date_to: '2026-09-30' };
  for (const merchant_hint of ['music streaming subscription', 'music service', 'música', 'suscripción de música', 'assinatura de música']) {
    assert.deepEqual(await search({ ...none, merchant_hint, ...about25 }), ['demo-tx-030'], merchant_hint + ' + amount');
    assert.deepEqual(await search({ ...none, merchant_hint, ...endOfSeptember }), ['demo-tx-030'], merchant_hint + ' + date');
    assert.deepEqual(await search({ ...none, merchant_hint, ...about25, ...endOfSeptember }), ['demo-tx-030'], merchant_hint + ' + both');
  }
  assert.deepEqual(await search({ ...none, ...about25 }), ['demo-tx-030'], 'about 25 BRL alone is already specific for Sofía');
  assert.deepEqual(await search({ ...none, merchant_hint: 'music', currency: 'BRL', amount_operator: 'eq', amount: 25 }), [], 'exactly 25 stays exact');
});

test('generic or unrelated words never select an unrelated merchant; repeated matches stay for the customer to choose', async t => {
  const { search } = sofia(t);
  assert.deepEqual(await search({ ...none, merchant_hint: 'restaurant' }), ['demo-tx-029', 'demo-tx-028'], 'the duplicate pair, newest first');
  for (const merchant_hint of ['subscription', 'charge', 'payment', 'Spotify', 'music restaurant', 'cinema']) {
    assert.deepEqual(await search({ ...none, merchant_hint }), [], merchant_hint);
  }
});

test('approx keeps stored amounts within 10% of the stated amount, boundaries included', async t => {
  const { insert, search } = setup(t);
  for (const [id, amount] of [['low-out', '22.49'], ['low-in', '22.50'], ['near', '24.90'], ['high-in', '27.50'], ['high-out', '27.51']]) insert(id, { amount });
  assert.deepEqual((await search({ amount_operator: 'approx', amount: 25 })).sort(), ['high-in', 'low-in', 'near']);
});

test('a described merchant never crosses owners and its values stay bound parameters', async t => {
  const { store, calls } = sofia(t);
  assert.deepEqual((await store.searchOwnedTransactions('other', { ...none, merchant_hint: 'music streaming subscription' })).map(r => r.transaction_id), ['foreign-030']);
  assert.deepEqual(await store.searchOwnedTransactions('missing', { ...none, merchant_hint: 'music streaming subscription' }), []);
  assert.ok(!/music|streaming/i.test(calls.at(-1).sql), 'hint words and merchant names are parameters, not SQL');
  assert.equal(calls.at(-1).params[0], 'missing');
});

test('every shared merchant-hint case matches exactly its expected names in SQL (parity with discovery_score.py)', async t => {
  const { db, insert, search } = setup(t);
  const { merchants, cases } = JSON.parse(readFileSync(new URL('../fixtures/merchant-hints.json', import.meta.url), 'utf8'));
  for (const { hint, expected } of cases) {
    db.exec('DELETE FROM transactions');
    merchants.forEach((merchant, i) => insert('m' + String(i).padStart(2, '0'), { merchant }));
    const ids = await search({ merchant_hint: hint });
    assert.ok(expected.length < 4, 'cases stay under the ambiguity sentinel');
    assert.deepEqual(ids.map(id => merchants[Number(id.slice(1))]).sort(), [...expected].sort(), hint);
  }
});

test('the concept list covers exactly the dataset merchant vocabulary with normalized, non-generic words', async () => {
  const concepts = JSON.parse(readFileSync(new URL('../../src/config/merchant-concepts.json', import.meta.url), 'utf8'));
  const { VOCABULARY } = await import('../../src/modules/intake/ai-transport.js');
  const { norm } = await import('../../src/modules/intake/matcher.js');
  assert.deepEqual(Object.keys(concepts.merchants).sort(), Object.keys(VOCABULARY.merchants).sort());
  for (const [merchant, words] of Object.entries(concepts.merchants)) {
    assert.ok(words.length > 0, merchant);
    for (const w of words) { assert.equal(norm(w), w, w); assert.ok(!concepts.generic.includes(w), w); }
  }
  for (const w of concepts.generic) assert.equal(norm(w), w, w);
});

test('dataset charges, stored with only the source timestamp, still match a date range on the day the customer sees', async t => {
  const { insert, search } = setup(t);
  insert('dataset-in', { date: null, source: '2026-09-30T21:39:00', merchant: 'Streaming Music', amount: '24.90', currency: 'BRL' });
  insert('dataset-out', { date: null, source: '2026-10-01T00:10:00', merchant: 'Streaming Music', amount: '24.90', currency: 'BRL' });
  assert.deepEqual(await search({ merchant_hint: 'music streaming', date_from: '2026-09-25', date_to: '2026-09-30', currency: 'BRL', amount_operator: 'approx', amount: 25 }), ['dataset-in']);
});
