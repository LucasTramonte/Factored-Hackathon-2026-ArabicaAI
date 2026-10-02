/** Deployment configuration that the capacity decisions in ADR-004 depend on. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWranglerConfig } from '../../scripts/predeploy.mjs';

const config = await readWranglerConfig();

test('Smart Placement (adaptive) is enabled so Cloudflare can move the Worker nearer D1', () => {
  assert.equal(config.placement?.mode, 'smart');
});

test('observability is kept in the file so deploys never reset it', () => {
  assert.equal(config.observability?.logs?.enabled, true);
  assert.equal(config.observability?.traces?.enabled, true);
});

test('only API and HTML document paths run the Worker first; bundles stay free', () => {
  const paths = config.assets.run_worker_first;
  assert.ok(Array.isArray(paths));
  for (const p of ['/', '/index.html', '/agent', '/healthz', '/demo/*', '/transactions', '/cases', '/intake', '/intake/*', '/agent/*', '/reports', '/reports/*']) assert.ok(paths.includes(p), p);
  assert.ok(!paths.some(p => p === '/*' || p.endsWith('.js') || p.endsWith('.css')));
});

test('run_worker_first and the router agree: every API path runs the Worker, and nothing else does', async () => {
  const { API_ROUTES, API_PREFIXES, API_NAMESPACES, DOCUMENT_PATHS } = await import('../../src/router.js');
  const patterns = config.assets.run_worker_first;
  const exact = new Set(patterns.filter(p => !p.endsWith('/*')));
  const prefixes = new Set(patterns.filter(p => p.endsWith('/*')).map(p => p.slice(0, -1)));
  const covered = path => exact.has(path) || [...prefixes].some(prefix => path.startsWith(prefix));
  for (const path of [...Object.keys(API_ROUTES), ...API_NAMESPACES, ...DOCUMENT_PATHS, '/healthz']) assert.ok(covered(path), `${path} must run the Worker first`);
  for (const prefix of API_PREFIXES) assert.ok(prefixes.has(prefix), `${prefix}* must run the Worker first`);
  for (const path of exact) assert.ok(API_ROUTES[path] || API_NAMESPACES.has(path) || DOCUMENT_PATHS.has(path) || path === '/healthz', `${path} runs the Worker but has no route`);
  for (const prefix of prefixes) assert.ok(API_PREFIXES.includes(prefix), `${prefix}* runs the Worker but is not an API prefix`);
});

test('look-alike paths outside the API namespaces reach the static assets, not the API', async () => {
  const { route } = await import('../../src/router.js');
  const env = { ASSETS: { fetch: () => new Response('asset') } };
  for (const path of ['/intakeX', '/intakes', '/intake-foo', '/casesX', '/transactionsX', '/reportsX']) {
    const response = await route(new Request('https://demo.example' + path), env, {});
    assert.equal(response.status, 200, path); assert.equal(await response.text(), 'asset', path);
  }
  for (const path of ['/intake', '/intake/', '/intake/x']) assert.equal((await route(new Request('https://demo.example' + path), env, {})).status, 404, path);
});
