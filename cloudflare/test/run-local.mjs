/** Run the Worker against a fresh, isolated local D1 and compiled UI assets. */
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
try {
  for (const name of ['src', 'migrations', 'public']) {
    await cp(join(project, name), join(temp, name), { recursive: true });
  }
  for (const name of ['wrangler.jsonc', 'seed_fictitious.sql']) {
    await cp(join(project, name), join(temp, name));
  }
  await writeFile(join(temp, '.dev.vars'),
    'DEMO_ACCESS_USERNAME="local-reviewer"\nDEMO_ACCESS_PASSWORD="local-test-password"\n');
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
    join(project, 'test/sample_seed.sql')]);
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
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for Wrangler. */ }
    await new Promise(done => setTimeout(done, 250));
  }
  if (!ready) throw new Error('Local Worker did not start:\n' + output);
  const tested = spawnSync(process.execPath, ['--test', join(project, 'test/live-flow.test.js')], {
    cwd: temp, env: { ...env, WORKER_TEST_URL: `http://127.0.0.1:${port}` },
    encoding: 'utf8', timeout: 60_000
  });
  process.stdout.write(tested.stdout);
  process.stderr.write(tested.stderr);
  if (tested.status !== 0) process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) server.kill('SIGTERM');
  await rm(temp, { recursive: true, force: true });
}
