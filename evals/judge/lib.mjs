import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SKILL_DIR = join(REPO_ROOT, 'plugins', 'standards', 'skills', 'standards');
export const script = (name) => join(SKILL_DIR, 'scripts', name);

export const ARMS = ['none', 'A', 'B'];

export class JudgeError extends Error {}

export function args(argv, options, usage) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true });
  } catch (e) {
    throw new JudgeError(`${e.message}\n${usage}`);
  }
}

export function need(values, names, usage) {
  for (const n of names) if (values[n] === undefined) throw new JudgeError(`--${n} is required\n${usage}`);
}

export function run(cmd, argv, { cwd, input, allowFail = false } = {}) {
  const r = spawnSync(cmd, argv, { cwd, input, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new JudgeError(`${cmd} ${argv.join(' ')} exited ${r.status}: ${(r.stderr || '').trim().split('\n')[0]}`);
  }
  return r;
}

export const ghJson = (path) => JSON.parse(run('gh', ['api', path]).stdout);

export function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export const writeJson = (file, value) => writeAtomic(file, JSON.stringify(value, null, 2) + '\n');
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
export const readJsonl = (file) =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
export const writeJsonl = (file, rows) => writeAtomic(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));

// Integer-like keys such as numeric logins sort first in a JS object, so read order from the values.
export function tally(items, key) {
  const counts = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
}

// Deterministic so a rerun samples the same items.
export function seededShuffle(items, seed) {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Runs fn only when the file at metaUrl is the script node was started with, so tests can import it.
export function main(fn, metaUrl, usage) {
  if (process.argv[1] !== fileURLToPath(metaUrl)) return;
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage);
    return;
  }
  try {
    fn(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof JudgeError)) throw e;
    console.error(`judge: ${e.message}`);
    process.exit(1);
  }
}
