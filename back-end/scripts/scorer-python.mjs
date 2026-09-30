/** Interpreter for the stdlib-only episode scorer (evals/intake/episodes.py), shared by the exporter and its tests. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * ``INTAKE_PYTHON`` when set and non-empty; else the repository's ``.venv/bin/python`` if it exists (after
 * ``make setup``); else ``python3`` from PATH. The scorer needs only the Python 3.10+ standard library.
 */
export function scorerPython(env = process.env, root = ROOT) {
  if (env.INTAKE_PYTHON) return env.INTAKE_PYTHON;
  const venv = resolve(root, '.venv/bin/python');
  return existsSync(venv) ? venv : 'python3';
}
