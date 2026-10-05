/**
 * POST /auth/access-request on the local Worker, which has no ACCESS_REQUEST_TO and no SES settings: the route is public and
 * POST-only, validates before anything else, and without its configuration answers 503 without touching D1. The sending,
 * de-duplication and cap paths run in test/unit/access-request.test.js with a fake sender.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client } from '../support/client.js';
import { assertContract } from '../support/contract.js';

const PATH = '/auth/access-request';

test('public and POST-only; every other method is 405 and a sub-path is 404', async () => {
  const c = client();
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const res = await c.call(PATH, method === 'GET' ? undefined : {}, { method });
    assert.deepEqual([res.status, res.headers.get('Allow')], [405, 'POST'], method);
    assertContract('error', res.body);
  }
  assert.equal((await c.call(PATH + '/x', { email: 'judge@example.com' })).status, 404);
});

test('hostile bodies are 422 before the configuration is read; a valid one is 503 locally, with no D1 query', async () => {
  const c = client();
  for (const body of [{}, { email: 'judge@example.com', role: 'admin' }, { email: '`id`@example.com' }, { email: 'a@b.c\r\nBcc: x@y.z' }, '[1]', 'not json']) {
    const res = await c.call(PATH, body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assertContract('error', res.body);
  }
  const res = await c.call(PATH, { email: 'judge@example.com', name: 'Judge', note: 'Assigned to ArabicaAI' });
  assert.equal(res.status, 503);
  assertContract('error', res.body);
  assert.equal(res.metrics?.queries, 0);
  assert.equal(res.headers.get('set-cookie'), null, 'no session is created or read');
});
