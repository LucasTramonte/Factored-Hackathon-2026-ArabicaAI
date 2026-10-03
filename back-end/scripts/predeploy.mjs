/**
 * Deploy step, run by `npm run deploy` (in `.github/workflows/deploy.yml`) before `wrangler deploy`. It stops the
 * deploy while the D1 binding is a local placeholder or ``vars`` would ship a local-only or personal value. Then it
 * brings remote D1 up to the migrations this code ships with: pending migrations that are additive (new tables,
 * indexes or columns that old code can ignore) are applied here, before the new Worker exists, so the running Worker
 * never meets a schema it lacks. A pending migration that is not additive (DROP, RENAME, a table rebuild, an UPDATE or DELETE of existing rows, a NOT NULL
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
 * The statements of a migration, with every quoted literal emptied (``'a;b'`` → ``''``) and
 * comments removed, so neither quoted text nor a comment can hide or fake a keyword. ``;`` ends a statement only outside
 * quotes, and a CREATE TRIGGER statement runs to its ``END``. ``unterminated`` is true for a quote or block comment that
 * never closes, which the caller treats as not additive (fail closed).
 */
function statementsOf(sql) {
  const statements = [];
  let current = '';
  const end = () => { const text = current.trim().replace(/\s+/g, ' '); if (text) statements.push(text); current = ''; };
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1; // a doubled quote is an escape
      if (j >= sql.length) return { statements, unterminated: true };
      current += c + c; i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const newline = sql.indexOf('\n', i);
      current += ' '; i = newline === -1 ? sql.length : newline;
    } else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) return { statements, unterminated: true };
      current += ' '; i = close + 2;
    } else if (c === ';' && !(/^\s*CREATE\s+(TEMP\w*\s+)?TRIGGER\b/i.test(current) && !/\bEND\s*$/i.test(current))) {
      end(); i++;
    } else {
      current += c; i++;
    }
  }
  end();
  return { statements, unterminated: false };
}

/**
 * Why a migration is not additive, or [] when it is. Additive means the Worker already running keeps working once it
 * is applied, and a Worker rollback needs nothing undone: CREATE TABLE / INDEX / TRIGGER / VIEW, ALTER TABLE … ADD
 * COLUMN (a NOT NULL one needs a DEFAULT) and INSERT of new rows. Anything that drops, renames, rebuilds, or rewrites or
 * deletes existing rows (UPDATE, DELETE) is for a person: no rollback restores the old values.
 */
export function additiveProblems(sql) {
  const { statements, unterminated } = statementsOf(sql);
  if (unterminated) return ['an unterminated quote or comment: the statements after it cannot be checked'];
  const problems = [];
  for (const statement of statements) {
    const head = statement.toUpperCase();
    if (/\b(DROP|RENAME)\b/.test(head)) problems.push(`drops or renames: ${statement.slice(0, 80)}`);
    else if (/^ALTER TABLE /.test(head) && !/^ALTER TABLE [^ ]+ ADD (COLUMN )?/.test(head)) problems.push(`alters a table: ${statement.slice(0, 80)}`);
    else if (/^ALTER TABLE /.test(head) && /\bNOT NULL\b/.test(head) && !/\bDEFAULT\b/.test(head)) problems.push(`adds a NOT NULL column without a default: ${statement.slice(0, 80)}`);
    else if (!/^(ALTER TABLE|CREATE (UNIQUE )?INDEX|CREATE TABLE|CREATE TRIGGER|CREATE VIEW|INSERT|PRAGMA)\b/.test(head)) problems.push(`not additive: ${statement.slice(0, 80)}`);
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
