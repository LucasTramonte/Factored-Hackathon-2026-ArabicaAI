/** Deployment configuration that the capacity decisions in ADR-004 depend on. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const config = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../wrangler.jsonc'), 'utf8'));

test('Smart Placement runs the Worker next to D1', () => {
  assert.equal(config.placement?.mode, 'smart');
});

test('observability is kept in the file so deploys never reset it', () => {
  assert.equal(config.observability?.logs?.enabled, true);
  assert.equal(config.observability?.traces?.enabled, true);
});

test('only API and HTML document paths run the Worker first; bundles stay free', () => {
  const paths = config.assets.run_worker_first;
  assert.ok(Array.isArray(paths));
  for (const p of ['/', '/index.html', '/agent', '/healthz', '/demo/*', '/transactions', '/cases', '/agent/*']) assert.ok(paths.includes(p), p);
  assert.ok(!paths.some(p => p === '/*' || p.endsWith('.js') || p.endsWith('.css')));
});
