/**
 * Deploy guard, run by `npm run deploy` before `wrangler deploy`. It stops the deploy while the
 * D1 binding is a local placeholder, or while the remote database lacks a migration that this
 * code ships with. PR #19 once deployed a Worker that read `context_cards` before migration 0003
 * was applied, and login returned 503 until the migration ran. The guard fails closed: if the
 * remote state cannot be read, the deploy stops.
 */
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { experimental_readRawConfig as readRawConfig } from 'wrangler';

const ROOT = resolve(import.meta.dirname, '..');

/** The raw Wrangler configuration, parsed by Wrangler itself so JSONC comments and trailing commas work. */
export async function readWranglerConfig(path = resolve(ROOT, 'wrangler.jsonc')) {
  return (await readRawConfig({ config: path })).rawConfig;
}

/** Migration file names in `migrations/`, sorted as Wrangler applies them. */
export async function localMigrations() {
  return (await readdir(resolve(ROOT, 'migrations'))).filter(f => f.endsWith('.sql')).sort();
}

/** Local migrations the remote has not recorded as applied. */
export function pendingMigrations(files, applied) {
  const done = new Set(applied);
  return files.filter(f => !done.has(f));
}

/** Applied names from `wrangler d1 execute --json`; throws on any answer it does not recognise. */
export function appliedFromWranglerJson(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const rows = Array.isArray(parsed) && parsed.length === 1 && parsed[0]?.success === true ? parsed[0].results : null;
  if (!Array.isArray(rows) || !rows.every(r => typeof r?.name === 'string')) {
    throw new Error('Could not read the remote D1 migration state; refusing to deploy');
  }
  return rows.map(r => r.name);
}

async function main() {
  const config = await readWranglerConfig();
  const db = config.d1_databases?.[0];
  if (!db || db.database_id === '00000000-0000-0000-0000-000000000000') {
    throw new Error('Create the remote D1 database and replace the placeholder database_id before deployment');
  }
  const wrangler = resolve(ROOT, 'node_modules/wrangler/bin/wrangler.js');
  const out = execFileSync(process.execPath, [wrangler, 'd1', 'execute', db.database_name, '--remote', '--json',
    '--command', 'SELECT name FROM d1_migrations ORDER BY id'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const pending = pendingMigrations(await localMigrations(), appliedFromWranglerJson(out));
  if (pending.length) {
    throw new Error(`Remote D1 is missing migrations ${pending.join(', ')}. After they pass the local tests, run `
      + `npx wrangler d1 migrations apply ${db.database_name} --remote, then retry the deploy. `
      + 'See CONTRIBUTING.md (migrations go remote before merge).');
  }
  console.log(`Remote D1 has all ${(await localMigrations()).length} migrations; deploying`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
