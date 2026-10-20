import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const path = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));

for (const [name, cmd] of [
  ['lint.mjs', process.execPath],
  ['test-harnesses.mjs', process.execPath],
  ['install.sh', 'sh'],
]) {
  test(`${name} --help prints usage and exits 0`, () => {
    const r = spawnSync(cmd, [path(name), '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^usage: /);
  });
}
