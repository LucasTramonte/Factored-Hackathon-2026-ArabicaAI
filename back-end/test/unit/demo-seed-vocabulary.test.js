/** The fictitious demo charges must name merchants the extractor is told about, or suggestions can never match them. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VOCABULARY } from '../../src/modules/intake/ai-transport.js';

const seed = readFileSync(new URL('../../seeds/seed_fictitious.sql', import.meta.url), 'utf8');
const update = readFileSync(new URL('../../scripts/demo-merchant-names.sql', import.meta.url), 'utf8');
const merchants = [...seed.matchAll(/INSERT INTO transactions\([^)]*\) VALUES \('[^']*','[^']*','[^']*',NULL,'([^']*)'/g)].map(m => m[1]);

test('every fictitious demo charge names a vocabulary merchant', () => {
  assert.equal(merchants.length, 26);
  for (const name of merchants) assert.ok(Object.hasOwn(VOCABULARY.merchants, name), name);
});

test('the remote update sets exactly the names the seed holds, on demo customers only', () => {
  const set = new Set([...update.matchAll(/SET merchant_name='([^']*)'/g)].map(m => m[1]));
  assert.deepEqual([...set].sort(), [...new Set(merchants)].sort());
  for (const line of update.split('\n').filter(l => l.startsWith('UPDATE'))) {
    assert.match(line, /customer_id IN \('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco'\);$/);
  }
});
