import { readFileSync } from 'node:fs';

// Covers only the keywords the standards schemas use. An unknown keyword throws, so a schema
// that grows a new one fails loudly instead of passing unchecked.
const KNOWN = new Set([
  '$schema', 'title', 'description', 'type', 'enum', 'const', 'required', 'properties',
  'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength',
  'minimum', 'maximum', 'pattern', 'format', 'allOf', 'oneOf', 'not', 'if', 'then',
]);

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

export const loadSchema = (name) =>
  JSON.parse(readFileSync(new URL(`../skills/standards/references/schemas/${name}.schema.json`, import.meta.url), 'utf8'));

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

const matchesType = (v, t) => typeOf(v) === t || (t === 'number' && typeOf(v) === 'integer');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function validate(schema, value, at = '$') {
  const errors = [];
  for (const key of Object.keys(schema)) if (!KNOWN.has(key)) throw new Error(`validator does not support ${key}`);
  const fail = (msg) => errors.push(`${at} ${msg}`);
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => matchesType(value, t))) {
      fail(`is ${typeOf(value)}, expected ${types.join(' or ')}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((e) => equal(e, value))) fail(`is not one of ${JSON.stringify(schema.enum)}`);
  if ('const' in schema && !equal(schema.const, value)) fail(`is not ${JSON.stringify(schema.const)}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) fail(`is shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) fail(`is longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) fail(`does not match ${schema.pattern}`);
    if (schema.format === 'date-time' && !(RFC3339.test(value) && !Number.isNaN(Date.parse(value)))) fail('is not an RFC 3339 date-time');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`is under ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`is over ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`has more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) fail('has duplicate items');
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) fail(`is missing ${key}`);
    for (const [key, v] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...validate(schema.properties[key], v, `${at}.${key}`));
      else if (schema.additionalProperties === false) fail(`has unexpected ${key}`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...validate(schema.additionalProperties, v, `${at}.${key}`));
    }
  }
  for (const sub of schema.allOf ?? []) errors.push(...validate(sub, value, at));
  if (schema.oneOf && schema.oneOf.filter((s) => validate(s, value, at).length === 0).length !== 1) fail('does not match exactly one oneOf branch');
  if (schema.not && validate(schema.not, value, at).length === 0) fail('matches a not schema');
  if (schema.if && validate(schema.if, value, at).length === 0 && schema.then) errors.push(...validate(schema.then, value, at));
  return errors;
}
