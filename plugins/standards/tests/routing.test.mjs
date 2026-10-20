import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const cases = JSON.parse(readFileSync(new URL('./routing.json', import.meta.url), 'utf8'));
const skill = readFileSync(new URL('../skills/standards/SKILL.md', import.meta.url), 'utf8');

test('every routing case expects a command SKILL.md lists, or a non-command outcome', () => {
  const commands = [...skill.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(commands, ['mine', 'write', 'review', 'prune', 'doctor']);
  const allowed = new Set([...commands, 'menu', 'ask', 'error', 'no-match']);
  const ids = new Set();
  for (const c of cases.cases) {
    assert.ok(allowed.has(c.expect), `${c.id} expects ${c.expect}`);
    assert.ok(c.request?.trim(), `${c.id} has a request`);
    assert.ok(!ids.has(c.id), `${c.id} is unique`);
    ids.add(c.id);
  }
  assert.deepEqual(commands.filter((c) => !cases.cases.some((x) => x.expect === c)), [], 'every command has a case');
});
