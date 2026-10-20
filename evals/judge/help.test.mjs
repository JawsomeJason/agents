import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

for (const name of ['agree.mjs', 'grade.mjs', 'shape-b.mjs', 'split.mjs', 'stage.mjs', 'lens.mjs']) {
  test(`${name} --help prints usage and exits 0`, () => {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL(`./${name}`, import.meta.url)), '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^usage: ${name.replace('.', '\\.')} `));
  });
}
