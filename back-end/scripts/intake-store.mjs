/** Native Wrangler binding bridge: store queries and atomic D1 batches remain in d1.js. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createStore } from '../src/store/d1.js';

/**
 * Silence third-party diagnostics before Wrangler loads, so an operator CLI prints only its own generic lines.
 * Wrangler's logger (its proxy notice and any D1 or configuration error text), its on-disk debug log and Node
 * deprecation warnings would otherwise share the CLI's streams. Call it first in a CLI entry point only.
 */
export function quietThirdPartyDiagnostics() {
  process.env.WRANGLER_LOG = 'none';
  process.env.WRANGLER_WRITE_LOGS = 'false';
  process.env.WRANGLER_SEND_METRICS = 'false';
  process.noDeprecation = true;
}

/**
 * Run ``work(store)`` against the configured local v3 D1 by default; only an explicit ``remote: true`` enables
 * a remote binding. Wrangler is imported lazily so a CLI can quiet it first.
 */
export async function withIntakeStore({ remote = false, config = resolve(import.meta.dirname, '../wrangler.jsonc') }, work) {
  const [{ getPlatformProxy }, { readWranglerConfig }] = await Promise.all([import('wrangler'), import('./predeploy.mjs')]);
  // Miniflare caches its request metadata relative to the working directory; keep it beside the ignored D1 state.
  process.env.MINIFLARE_CACHE_DIR ??= resolve(config, '../.wrangler/cache');
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
