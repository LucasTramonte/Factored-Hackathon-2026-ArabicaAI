/** Run the Worker against a fresh, isolated local D1 and compiled UI assets. */
import { cp, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { readWranglerConfig } from '../scripts/predeploy.mjs';
import { issuerFor } from '../src/auth/cognito.js';

if (Number(process.versions.node.split('.')[0]) < 22) {
  throw new Error('Worker tests require Node 22 or newer');
}
const project = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'arabica-worker-'));
const wrangler = resolve(project, 'node_modules/wrangler/bin/wrangler.js');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
function run(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: temp, env, encoding: 'utf8', timeout: 60_000
  });
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
}
const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const selected = server.address().port;
    server.close(() => resolvePort(selected));
  });
});
let server;
const testEnv = {};
try {
  for (const name of ['src', 'migrations', 'public']) {
    await cp(join(project, name), join(temp, name), { recursive: true });
  }
  // Miniflare enforces the rate limit binding locally with one shared key, so the local-D1 suites run without it;
  // the 429 path is covered by the unit test (failure-and-routing.test.js).
  const { ratelimits, ...localConfig } = await readWranglerConfig(join(project, 'wrangler.jsonc'));
  await writeFile(join(temp, 'wrangler.jsonc'), JSON.stringify(localConfig));
  await symlink(join(project, 'node_modules'), join(temp, 'node_modules'), 'dir'); // the Worker bundles jose
  await cp(join(project, 'seeds/seed_fictitious.sql'), join(temp, 'seed_fictitious.sql'));
  // Tests sign ID tokens with a throwaway key for the real pool's issuer and client id (wrangler.jsonc vars);
  // only the key set is local. predeploy refuses COGNITO_TEST_JWKS and DEMO_PICKER in vars, so it lives in .dev.vars only.
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = 'local-test';
  const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }] });
  const { vars } = await readWranglerConfig(join(temp, 'wrangler.jsonc'));
  Object.assign(testEnv, { COGNITO_TEST_PRIVATE_JWK: JSON.stringify({ ...(await exportJWK(privateKey)), kid }),
    COGNITO_TEST_ISSUER: issuerFor(vars), COGNITO_TEST_CLIENT_ID: vars.COGNITO_CLIENT_ID });
  await writeFile(join(temp, '.dev.vars'),
    'DEMO_EXPOSE_DB_METRICS="1"\nDEMO_PICKER="1"\n'
    + `COGNITO_TEST_JWKS='${jwks}'\n`
    // A throwaway address key; no SES secrets are written, so every local send is skipped.
    + `EMAIL_KEY="${randomBytes(32).toString('base64')}"\n`);
  run(['d1', 'migrations', 'apply', 'arabica-intake-demo', '--local']);
  run(['d1', 'execute', 'arabica-intake-demo', '--local', '--file', 'seed_fictitious.sql']);
  run(['d1', 'execute', 'arabica-intake-demo', '--local', '--file', 'seed_fictitious.sql']);
  await writeFile(join(temp, 'drift.sql'), "UPDATE transactions SET amount='1.00' WHERE transaction_id='demo-tx-001';\n");
  run(['d1', 'execute', 'arabica-intake-demo', '--local', '--file', 'drift.sql']);
  const conflict = spawnSync(process.execPath, [wrangler, 'd1', 'execute', 'arabica-intake-demo',
    '--local', '--file', 'seed_fictitious.sql'], { cwd: temp, env, encoding: 'utf8', timeout: 60_000 });
  if (conflict.status === 0) throw new Error('Divergent fixture seed was silently accepted');
  await writeFile(join(temp, 'restore.sql'), "UPDATE transactions SET amount='125.50' WHERE transaction_id='demo-tx-001';\n");
  run(['d1', 'execute', 'arabica-intake-demo', '--local', '--file', 'restore.sql']);
  run(['d1', 'execute', 'arabica-intake-demo', '--local', '--file',
    join(project, 'test/integration/sample_seed.sql')]);
  run(['d1', 'execute', 'arabica-intake-demo', '--local', '--file',
    join(project, 'test/integration/cohort_seed.sql')]);
  // A customer session that expired long ago, so tests can prove expiry is enforced server-side.
  const expiredToken = 'e'.repeat(64);
  const expiredHash = createHash('sha256').update(expiredToken).digest('hex');
  await writeFile(join(temp, 'expired.sql'),
    `INSERT INTO sessions(token_hash,actor,customer_id,expires_at) VALUES('${expiredHash}','customer','demo-ana',1);\n`);
  run(['d1', 'execute', 'arabica-intake-demo', '--local', '--file', 'expired.sql']);
  server = spawn(process.execPath, [wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port)],
    { cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', chunk => { output = (output + chunk.toString()).slice(-4000); });
  }
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for Wrangler. */ }
    await new Promise(done => setTimeout(done, 250));
  }
  if (!ready) throw new Error('Local Worker did not start:\n' + output);
  // Budgets run last, in their own test-runner invocation (the runner orders files itself): they measure against
  // every other suite's retained rows, and their bounded fixtures (100 queue reservations, 100 idle starts)
  // cannot change what earlier suites observe in the shared D1.
  const names = (await readdir(join(project, 'test/integration'))).filter(name => name.endsWith('.test.js')).sort();
  for (const group of [names.filter(name => name !== 'budget.test.js'), names.filter(name => name === 'budget.test.js')]) {
    if (!group.length) continue;
    const tested = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...group.map(name => join(project, 'test/integration', name))], {
      cwd: temp, env: { ...env, ...testEnv, WORKER_TEST_URL: `http://127.0.0.1:${port}`, EXPIRED_TOKEN: 'e'.repeat(64) },
      encoding: 'utf8', timeout: 120_000
    });
    process.stdout.write(tested.stdout ?? '');
    process.stderr.write(tested.stderr ?? '');
    // A spawn failure or timeout leaves status null and output possibly null; report why instead of throwing.
    if (tested.error) process.stderr.write(`${tested.error.message}\n`);
    if (tested.status !== 0) process.exitCode = 1;
  }
} finally {
  if (server && server.exitCode === null) server.kill('SIGTERM');
  await rm(temp, { recursive: true, force: true });
}
