/** Stop Git builds before deployment while the D1 binding is a local placeholder. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const config = await readFile(resolve(import.meta.dirname, '../wrangler.jsonc'), 'utf8');
if (config.includes('00000000-0000-0000-0000-000000000000')) {
  throw new Error('Create the remote D1 database and replace the placeholder database_id before deployment');
}
