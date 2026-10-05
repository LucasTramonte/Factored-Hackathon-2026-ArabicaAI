/** The four new evaluator identities receive isolated, repeatable fictitious charge scenarios. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const EVALUATORS = ['demo-sofia', 'demo-pablo', 'demo-lucia', 'demo-tomas'];
const identities = JSON.parse(readFileSync(new URL('../../src/config/identities.json', import.meta.url), 'utf8'));
const data = JSON.parse(readFileSync(new URL('../../seeds/fictitious.json', import.meta.url), 'utf8'));
const seed = readFileSync(new URL('../../seeds/seed_fictitious.sql', import.meta.url), 'utf8');

/** Load the committed seed over the real migrations, with foreign keys enforced. */
function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.exec(seed);
  return db;
}

for (const customer of EVALUATORS) {
  test(`${customer} has five owned charges covering duplicate, bank-flag and urgency scenarios`, t => {
    const db = setup(t);
    const identity = identities.customers.filter(c => c.customer_id === customer);
    assert.equal(identity.length, 1);
    assert.equal(identity[0].source, 'fictitious');
    assert.deepEqual({ ...db.prepare('SELECT customer_id,display_name,source FROM customers WHERE customer_id=?').get(customer) }, identity[0]);
    const charges = db.prepare('SELECT * FROM transactions WHERE customer_id=? ORDER BY transaction_id').all(customer);
    assert.equal(charges.length, 5);
    assert.equal(new Set(charges.map(c => c.transaction_id)).size, 5);
    const authored = data.transactions.filter(c => c.customer_id === customer);
    assert.equal(authored.length, 5);
    for (const charge of charges) {
      const expected = authored.find(c => c.transaction_id === charge.transaction_id);
      assert.ok(expected, charge.transaction_id);
      assert.deepEqual({ ...charge }, { ...expected, source_occurred_at: null, bank_flagged: expected.bank_flagged ? 1 : 0 });
      assert.equal(charge.currency, 'BRL');
    }
    const [purchase, first, duplicate, subscription, large] = charges;
    assert.ok(Number(purchase.amount) > 0 && Number(purchase.amount) < 2500);
    assert.equal(first.merchant_name, duplicate.merchant_name);
    assert.equal(first.amount, duplicate.amount);
    assert.equal(Date.parse(duplicate.occurred_at) - Date.parse(first.occurred_at), 60000);
    assert.deepEqual(charges.filter(c => c.bank_flagged === 1), [subscription]);
    assert.match(subscription.occurred_at, /T03:00:00\+00:00$/);
    assert.ok(Number(subscription.amount) < 2500, 'the proactive flag does not depend on high value');
    assert.ok(Number(large.amount) > 2500);
    db.exec(seed);
    assert.deepEqual(db.prepare('SELECT * FROM transactions WHERE customer_id=? ORDER BY transaction_id').all(customer), charges);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });

  test(`${customer}'s committed seed rejects transaction ownership drift`, t => {
    const db = setup(t);
    const charge = db.prepare('SELECT transaction_id FROM transactions WHERE customer_id=? ORDER BY transaction_id LIMIT 1').get(customer);
    db.prepare("UPDATE transactions SET customer_id='demo-ana' WHERE transaction_id=?").run(charge.transaction_id);
    assert.throws(() => db.exec(seed), /NOT NULL constraint failed/);
  });
}
