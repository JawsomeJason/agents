import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { trimDiff } from './stage.mjs';

const file = (path, size) => `diff --git a/${path} b/${path}\n+++ b/${path}\n${'+x\n'.repeat(size)}`;

test('a diff over budget drops lockfiles and generated code before any source', () => {
  const diff = [file('src/__generated__/graphql.ts', 30), file('src/app.ts', 20), file('pnpm-lock.yaml', 30), file('src/app.test.ts', 20)].join('');
  const { text, omitted } = trimDiff(diff, 250);
  assert.deepEqual(omitted, ['src/__generated__/graphql.ts', 'pnpm-lock.yaml']);
  assert.match(text, /diff --git a\/src\/app\.ts/);
  assert.match(text, /diff --git a\/src\/app\.test\.ts/);
});

test('a diff within budget is kept whole, generated code included', () => {
  const diff = file('src/__generated__/graphql.ts', 5) + file('src/app.ts', 5);
  assert.deepEqual(trimDiff(diff, 10000), { text: diff, omitted: [] });
});

test('staging one arm later keeps the arms staged before it', () => {
  const root = mkdtempSync(join(tmpdir(), 'stage-'));
  const clone = join(root, 'clone');
  const data = join(root, 'data');
  mkdirSync(clone);
  const git = (...a) => spawnSync('git', ['-C', clone, ...a], { encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(clone, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a');
  const commit = git('rev-parse', 'HEAD').stdout.trim();
  mkdirSync(join(data, 'heldout', 'diffs'), { recursive: true });
  writeFileSync(join(data, 'split.json'), JSON.stringify({ heldout: [{ number: '1', base_sha: commit, reviewed_commit: commit }] }));
  writeFileSync(join(data, 'heldout', 'diffs', '1.diff'), file('a.ts', 1));
  const skills = join(root, 'standards-A', 'x-standards');
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, 'SKILL.md'), '# x\n');
  const stage = (...a) => spawnSync(process.execPath, [fileURLToPath(new URL('./stage.mjs', import.meta.url)), '--repo', 'o/r', '--clone', clone, '--data', data, '--workspace', join(root, 'ws'), ...a], { encoding: 'utf8' });
  assert.equal(stage('--arms', 'none').status, 0);
  const r = stage('--arms', 'A', '--standards-a', join(root, 'standards-A'));
  assert.equal(r.status, 0, r.stderr);
  const arms = Object.values(JSON.parse(readFileSync(join(data, 'review', 'manifest.json'), 'utf8'))).map((m) => m.arm).sort();
  assert.deepEqual(arms, ['A', 'none']);
});
