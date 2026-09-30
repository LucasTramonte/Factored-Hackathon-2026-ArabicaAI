/** Native Wrangler binding bridge: store queries and atomic D1 batches remain in d1.js. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { readWranglerConfig } from './predeploy.mjs';
import { createStore } from '../src/store/d1.js';

/** Default to the configured local v3 store; only an explicit remote flag enables a remote D1 binding. */
export async function withIntakeStore({ remote = false, config = resolve(import.meta.dirname, '../wrangler.jsonc') }, work) {
  const raw = await readWranglerConfig(config);
  const db = raw.d1_databases?.find(binding => binding.binding === 'DB');
  if (!db) throw new Error('Intake database unavailable');
  const temp = await mkdtemp(join(tmpdir(), 'intake-binding-'));
  let proxy;
  try {
    const configPath = join(temp, 'wrangler.json');
    await writeFile(configPath, JSON.stringify({ name: raw.name, account_id: raw.account_id,
      compatibility_date: raw.compatibility_date, d1_databases: [{ ...db, remote }] }));
    proxy = await getPlatformProxy({ configPath, envFiles: [], remoteBindings: remote,
      persist: { path: resolve(config, '../.wrangler/state/v3') } });
    return await work(createStore(proxy.env.DB));
  } finally {
    await proxy?.dispose();
    await rm(temp, { recursive: true, force: true });
  }
}
