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
  'generated-time-word': 'time-word',
  'extension-key-unlisted': 'frontmatter-key',
  'frontmatter-key': 'frontmatter-key',
  'frontmatter-missing': 'frontmatter-missing',
  'harness-tool': 'harness-tool',
  'link-broken': 'link-broken',
  'link-escape': 'link-escape',
  'link-space': 'link-broken',
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

const passing = ['clean', 'doc-allow', 'extension-key-allowed', 'generated-quote-allowed', 'generated-vendor-allowed', 'link-placeholder', 'private-term'];

test('every fixture directory has an expectation', () => {
  const dirs = readdirSync(fileURLToPath(new URL('./lint-fixtures', import.meta.url))).filter((d) => !passing.includes(d));
  assert.deepEqual(dirs.sort(), Object.keys(expected).sort());
});

test('clean fixture passes', () => {
  assert.deepEqual(lint(fixture('clean')), []);
});

test('generated standards may name the services their repo runs on', () => {
  assert.deepEqual(lint(fixture('generated-vendor-allowed')), []);
});

test('generated standards may quote a reviewer\'s time word in a blockquote', () => {
  assert.deepEqual(lint(fixture('generated-quote-allowed')), []);
});

test('a time word outside a quote in generated standards still fails, on its own line', () => {
  assert.deepEqual(lint(fixture('generated-time-word')).map((e) => [e.line, e.rule]), [[10, 'time-word']]);
});

test('a link target with a space is checked, and only a {{ }} placeholder is skipped', () => {
  assert.deepEqual(lint(fixture('link-placeholder')), []);
  assert.deepEqual(lint(fixture('link-space')).map((e) => e.message), ['"references/no such file.md" does not resolve']);
});

test('an allowlisted extension key passes', () => {
  assert.deepEqual(lint(fixture('extension-key-allowed')), []);
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

test('a private denylist named by STANDARDS_LINT_PRIVATE_DENYLIST adds its terms to org-term', () => {
  const cli = fileURLToPath(new URL('./lint.mjs', import.meta.url));
  const target = fixture('private-term');
  const without = spawnSync(process.execPath, [cli, target], { encoding: 'utf8', env: { ...process.env, STANDARDS_LINT_PRIVATE_DENYLIST: '' } });
  assert.equal(without.status, 0, without.stdout);
  const withList = spawnSync(process.execPath, [cli, target], { encoding: 'utf8', env: { ...process.env, STANDARDS_LINT_PRIVATE_DENYLIST: `${target}/denylist.json` } });
  assert.equal(withList.status, 1);
  assert.match(withList.stdout, /SKILL\.md:8 org-term "Acme Widgets" /);
  const missing = spawnSync(process.execPath, [cli, target], { encoding: 'utf8', env: { ...process.env, STANDARDS_LINT_PRIVATE_DENYLIST: `${target}/nope.json` } });
  assert.notEqual(missing.status, 0, 'a named list that cannot be read fails instead of passing silently');
  assert.match(missing.stderr, /STANDARDS_LINT_PRIVATE_DENYLIST=.*nope\.json is not a readable JSON file/);
});
