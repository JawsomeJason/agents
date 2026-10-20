import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runNode, tempDir } from './helpers.mjs';

for (const script of ['fetch-reviews.mjs', 'questions.mjs', 'cluster.mjs', 'prune.mjs']) {
  test(`${script} --help prints usage and exits 0`, () => {
    const r = runNode(script, ['--help'], tempDir());
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^usage: ${script.replace('.', '\\.')} `));
    assert.equal(r.stderr, '');
  });
}
