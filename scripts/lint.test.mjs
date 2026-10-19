import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lint } from './lint.mjs';

const fixture = (name) => fileURLToPath(new URL(`./lint-fixtures/${name}`, import.meta.url));

const expected = {
  'absolute-date': 'absolute-date',
  'body-tokens': 'body-tokens',
  'compatibility-length': 'compatibility-length',
  'description-length': 'description-length',
  'description-missing': 'description-missing',
  'doc-scope': 'time-word',
  'fence-length': 'fence-length',
  'frontmatter-key': 'frontmatter-key',
  'frontmatter-missing': 'frontmatter-missing',
  'harness-tool': 'harness-tool',
  'link-broken': 'link-broken',
  'link-escape': 'link-escape',
  'marketplace-plugins': 'marketplace-plugins',
  'model-name': 'model-name',
  'name-dir': 'name-dir',
  'name-format': 'name-format',
  'name-length': 'name-length',
  'name-missing': 'name-missing',
  'no-skills': 'no-skills',
  'node-modules': 'package-file',
  'org-term': 'org-term',
  'package-file': 'package-file',
  'script-schema': 'script-schema',
  'time-word': 'time-word',
  'url-allowlist': 'url-allowlist',
  'vendor-name': 'vendor-name',
};

test('every fixture directory has an expectation', () => {
  const dirs = readdirSync(fileURLToPath(new URL('./lint-fixtures', import.meta.url))).filter((d) => d !== 'clean');
  assert.deepEqual(dirs.sort(), Object.keys(expected).sort());
});

test('clean fixture passes', () => {
  assert.deepEqual(lint(fixture('clean')), []);
});

for (const [name, rule] of Object.entries(expected)) {
  test(`${name} fails only ${rule}`, () => {
    const rules = [...new Set(lint(fixture(name)).map((e) => e.rule))];
    assert.deepEqual(rules, [rule]);
  });
}

test('cli prints file:line rule message and exits non-zero', () => {
  const cli = fileURLToPath(new URL('./lint.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [cli, fixture('time-word')], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^\S*time-word[\\/]demo[\\/]SKILL\.md:6 time-word "currently" /m);
});

test('cli exits zero on a clean folder', () => {
  const cli = fileURLToPath(new URL('./lint.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [cli, fixture('clean')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout);
  assert.equal(run.stdout, '');
});
