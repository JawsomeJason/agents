import assert from 'node:assert/strict';
import { test } from 'node:test';
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
