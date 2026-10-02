/** The deploy guard must stop a Worker from running ahead of its D1 schema (the PR #19 login outage). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoLocalVars, localMigrations, pendingMigrations, appliedFromWranglerJson, readWranglerConfig } from '../../scripts/predeploy.mjs';

test('every local migration file is known to the guard, in order', async () => {
  const files = await localMigrations();
  assert.ok(files.length >= 3);
  assert.deepEqual(files, [...files].sort());
  assert.ok(files.every(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)));
});

test('pending migrations are the local files the remote has not recorded', () => {
  const files = ['0001_a.sql', '0002_b.sql', '0003_c.sql'];
  assert.deepEqual(pendingMigrations(files, ['0001_a.sql', '0002_b.sql', '0003_c.sql']), []);
  assert.deepEqual(pendingMigrations(files, ['0001_a.sql', '0002_b.sql']), ['0003_c.sql']);
  assert.deepEqual(pendingMigrations(files, []), files);
  assert.deepEqual(pendingMigrations(files, ['0001_a.sql', '0002_b.sql', '0003_c.sql', '0004_newer.sql']), []);
});

test('the remote answer is parsed strictly; anything unexpected is a failure, not "nothing pending"', () => {
  const ok = JSON.stringify([{ results: [{ name: '0001_a.sql' }, { name: '0002_b.sql' }], success: true }]);
  assert.deepEqual(appliedFromWranglerJson(ok), ['0001_a.sql', '0002_b.sql']);
  for (const bad of ['', 'not json', '[]', '{}', JSON.stringify([{ success: false, results: [] }]),
    JSON.stringify([{ success: true, results: [{ id: 1 }] }])]) {
    assert.throws(() => appliedFromWranglerJson(bad), /migration state/, bad);
  }
});

test('the guard reads wrangler.jsonc as JSONC: comments and trailing commas are accepted', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'wrangler-')), 'wrangler.jsonc');
  writeFileSync(path, `{
    // a comment, and a URL inside a string: https://example.com
    "name": "demo", /* block comment */
    "d1_databases": [{ "binding": "DB", "database_name": "db", "database_id": "abc", }],
  }`);
  const config = await readWranglerConfig(path);
  assert.equal(config.d1_databases[0].database_name, 'db');
  assert.equal(config.name, 'demo');
});

test('the guard refuses a config that would ship the local test JWKS or the demo picker', async () => {
  assert.throws(() => assertNoLocalVars({ vars: { COGNITO_REGION: 'r', COGNITO_TEST_JWKS: '{"keys":[]}' } }), /COGNITO_TEST_JWKS/);
  for (const value of ['1', '0', '']) assert.throws(() => assertNoLocalVars({ vars: { COGNITO_REGION: 'r', DEMO_PICKER: value } }), /DEMO_PICKER/);
  assert.doesNotThrow(() => assertNoLocalVars({ vars: { COGNITO_REGION: 'r' } }));
  assert.doesNotThrow(() => assertNoLocalVars({}));
  const shipped = await readWranglerConfig();
  assert.doesNotThrow(() => assertNoLocalVars(shipped));
});
