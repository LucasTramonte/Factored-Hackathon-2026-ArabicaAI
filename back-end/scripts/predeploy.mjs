/**
 * Deploy step, run by `npm run deploy` (the Workers Build deploy command) before `wrangler deploy`. It stops the
 * deploy while the D1 binding is a local placeholder or ``vars`` would ship a local-only or personal value. Then it
 * brings remote D1 up to the migrations this code ships with: pending migrations that are additive (new tables,
 * indexes or columns that old code can ignore) are applied here, before the new Worker exists, so the running Worker
 * never meets a schema it lacks. A pending migration that is not additive (DROP, RENAME, a table rebuild, a NOT NULL
 * column without a default) stops the deploy for a person to apply on purpose. PR #19 once deployed a Worker that read
 * `context_cards` before migration 0003 was applied; in October 2026 five builds failed because a migration merged
 * before anyone applied it by hand. The step fails closed: if the remote state cannot be read, nothing deploys.
 */
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
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

/**
 * Why a migration is not additive, or [] when it is. Additive means the Worker already running keeps working once it
 * is applied: CREATE TABLE / INDEX / TRIGGER / VIEW, ALTER TABLE … ADD COLUMN (a NOT NULL one needs a DEFAULT),
 * INSERT and UPDATE of rows. Anything that drops, renames or rebuilds is for a person.
 */
export function additiveProblems(sql) {
  const statements = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').split(';').map(t => t.trim().replace(/\s+/g, ' ')).filter(Boolean);
  const problems = [];
  for (const statement of statements) {
    const head = statement.toUpperCase();
    if (/\b(DROP|RENAME)\b/.test(head)) problems.push(`drops or renames: ${statement.slice(0, 80)}`);
    else if (/^ALTER TABLE /.test(head) && !/^ALTER TABLE [^ ]+ ADD (COLUMN )?/.test(head)) problems.push(`alters a table: ${statement.slice(0, 80)}`);
    else if (/^ALTER TABLE /.test(head) && /\bNOT NULL\b/.test(head) && !/\bDEFAULT\b/.test(head)) problems.push(`adds a NOT NULL column without a default: ${statement.slice(0, 80)}`);
    else if (!/^(ALTER TABLE|CREATE (UNIQUE )?INDEX|CREATE TABLE|CREATE TRIGGER|CREATE VIEW|INSERT|UPDATE|PRAGMA)\b/.test(head)) problems.push(`not additive: ${statement.slice(0, 80)}`);
  }
  return problems;
}

/**
 * Throws when ``vars`` would ship a local-only variable: ``COGNITO_TEST_JWKS`` lets anyone holding its private key sign in,
 * and ``DEMO_PICKER`` lets anyone become any customer or agent without signing in. ``SES_FROM`` is a person's address,
 * so it is a secret, never a committed var (issue #70). Secrets are not checked here.
 */
export function assertNoLocalVars(config) {
  for (const name of ['COGNITO_TEST_JWKS', 'DEMO_PICKER']) {
    if (config.vars && name in config.vars) throw new Error(`wrangler.jsonc vars contain ${name} (local only); remove it before deploying`);
  }
  if (config.vars && 'SES_FROM' in config.vars) throw new Error('wrangler.jsonc vars contain SES_FROM; set it with `wrangler secret put SES_FROM` instead');
}

async function main() {
  const config = await readWranglerConfig();
  assertNoLocalVars(config);
  const db = config.d1_databases?.[0];
  if (!db || db.database_id === '00000000-0000-0000-0000-000000000000') {
    throw new Error('Create the remote D1 database and replace the placeholder database_id before deployment');
  }
  const wrangler = resolve(ROOT, 'node_modules/wrangler/bin/wrangler.js');
  const run = args => execFileSync(process.execPath, [wrangler, ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const applied = () => appliedFromWranglerJson(run(['d1', 'execute', db.database_name, '--remote', '--json',
    '--command', 'SELECT name FROM d1_migrations ORDER BY id']));
  const files = await localMigrations();
  const pending = pendingMigrations(files, applied());
  if (pending.length) {
    const blocked = (await Promise.all(pending.map(async f => [f, additiveProblems(await readFile(resolve(ROOT, 'migrations', f), 'utf8'))])))
      .filter(([, problems]) => problems.length);
    if (blocked.length) {
      throw new Error(`Remote D1 is missing migrations that are not additive (${blocked.map(([f, p]) => `${f}: ${p[0]}`).join('; ')}). `
        + `A person applies them on purpose: npx wrangler d1 migrations apply ${db.database_name} --remote, then retries the deploy.`);
    }
    // The current Time Travel bookmark, so a bad migration is undone with one command (back-end/README.md, "Rollback").
    try {
      console.log(run(['d1', 'time-travel', 'info', db.database_name]).trim());
    } catch {
      console.warn('Could not read the D1 Time Travel bookmark; restore by timestamp instead (back-end/README.md, "Rollback")');
    }
    console.log(`Applying ${pending.length} additive migration(s) to remote D1 before deploying: ${pending.join(', ')}`);
    run(['d1', 'migrations', 'apply', db.database_name, '--remote']);
    const still = pendingMigrations(files, applied());
    if (still.length) throw new Error(`Remote D1 still lacks ${still.join(', ')} after applying; refusing to deploy`);
  }
  console.log(`Remote D1 has all ${files.length} migrations; deploying`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
