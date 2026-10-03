/** The deploy guard must stop a Worker from running ahead of its D1 schema (the PR #19 login outage). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { additiveProblems, assertNoLocalVars, localMigrations, pendingMigrations, appliedFromWranglerJson, readWranglerConfig } from '../../scripts/predeploy.mjs';

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
  assert.throws(() => assertNoLocalVars({ vars: { SES_FROM: 'Demo <someone@example.com>' } }), /secret put SES_FROM/);
  assert.doesNotThrow(() => assertNoLocalVars({ vars: { COGNITO_REGION: 'r' } }));
  assert.doesNotThrow(() => assertNoLocalVars({}));
  const shipped = await readWranglerConfig();
  assert.doesNotThrow(() => assertNoLocalVars(shipped));
});

test('the deploy applies only additive migrations; anything that drops, renames or rebuilds is for a person', () => {
  for (const sql of ['CREATE TABLE t (id INTEGER PRIMARY KEY);', 'CREATE UNIQUE INDEX i ON t(id);',
    "ALTER TABLE t ADD COLUMN c TEXT NOT NULL DEFAULT 'x' CHECK (c IN ('x','y'));", 'ALTER TABLE t ADD COLUMN d TEXT;',
    "-- a comment; with a semicolon\nINSERT INTO t VALUES (1); UPDATE t SET id = 2 WHERE id = 1;"]) {
    assert.deepEqual(additiveProblems(sql), [], sql);
  }
  for (const [sql, why] of [['DROP TABLE t;', /drops or renames/], ['ALTER TABLE t RENAME TO u;', /drops or renames/],
    ['ALTER TABLE t DROP COLUMN c;', /drops or renames/], ['ALTER TABLE t ADD COLUMN c TEXT NOT NULL;', /NOT NULL column without a default/],
    ['DELETE FROM t;', /not additive/], ['CREATE TABLE t2 (id INTEGER); /* rebuild */ DROP TABLE t;', /drops or renames/]]) {
    assert.match(additiveProblems(sql).join(), why, sql);
  }
});

test('every migration after the 0014 rebuild is additive, so the deploy can apply it unattended', async () => {
  // 0014 rebuilt intake_episodes to widen a CHECK; it was applied by hand and is the only exception (ADR-008).
  for (const file of (await localMigrations()).filter(f => f > '0014_english_reports.sql')) {
    const sql = await readFile(new URL('../../migrations/' + file, import.meta.url), 'utf8');
    assert.deepEqual(additiveProblems(sql), [], `${file} is not additive: split it, or a person applies it before the deploy`);
  }
});
