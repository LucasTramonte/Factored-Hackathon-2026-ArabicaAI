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
