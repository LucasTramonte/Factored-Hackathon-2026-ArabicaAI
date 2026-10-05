/**
 * Minimal validator for the JSON Schema subset used in front-end/contracts:
 * type (including null), const, pattern, minLength/maxLength in code points, required,
 * properties, additionalProperties: false, items, maxItems and local $ref.
 * It exists so contract checks need no extra dependency. Unknown keywords throw.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SUPPORTED = new Set(['type', 'const', 'pattern', 'minLength', 'maxLength', 'required', 'properties',
  'additionalProperties', 'items', 'maxItems', '$ref', 'description', 'enum', 'minimum', 'maximum', 'uniqueItems']);
const schemaPath = resolve(import.meta.dirname, '../../../front-end/contracts/intake-api.schema.json');
export const contract = JSON.parse(readFileSync(schemaPath, 'utf8'));

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function check(schema, value, path, errors) {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) throw new Error(`Unsupported schema keyword ${key} at ${path}`);
  }
  if (schema.$ref) {
    const name = schema.$ref.replace('#/$defs/', '');
    return check(contract.$defs[name], value, path, errors);
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: unexpected enum value`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if ('const' in schema && value !== schema.const) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.type) {
    const allowed = [].concat(schema.type);
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      errors.push(`${path}: type ${actual} not in ${allowed}`);
      return;
    }
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) errors.push(`${path}: duplicate items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${path}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) check(schema.properties[key], item, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property ${key}`);
    }
  }
}

/** Throw with every violation when ``value`` does not satisfy ``$defs[name]``. */
export function assertContract(name, value) {
  if (!contract.$defs[name]) throw new Error(`Unknown contract ${name}`);
  const errors = [];
  check(contract.$defs[name], value, name, errors);
  if (errors.length) throw new Error(`Contract ${name} violated:\n` + errors.join('\n'));
}
