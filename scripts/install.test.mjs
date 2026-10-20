import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readlinkSync, lstatSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const made = [];
process.once('exit', () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const tempHome = () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-'));
  made.push(dir);
  return dir;
};
const skill = join(repo, 'plugins/standards/skills/standards');

// The opencode folder resolves only when opencode is on PATH or its config folder exists,
// so the config folder is made here for machines without opencode.
function install(home, ...args) {
  mkdirSync(join(home, 'cfg/opencode'), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, 'codex'), XDG_CONFIG_HOME: join(home, 'cfg') };
  return execFileSync('sh', [join(repo, 'scripts/install.sh'), ...args], { env, encoding: 'utf8' });
}

test('dry run prints the plan and writes nothing', () => {
  const home = tempHome();
  const out = install(home, '--harness', 'codex');
  assert.match(out, /^link codex: .*\/codex\/skills\/standards -> /m);
  assert.equal(existsSync(join(home, 'codex/skills')), false);
});

test('apply links each skill and a second apply changes nothing', () => {
  const home = tempHome();
  assert.match(install(home, '--harness', 'all', '--apply'), /applied: 2 linked, 0 unchanged, 0 skipped/);
  assert.equal(readlinkSync(join(home, 'codex/skills/standards')), skill);
  assert.equal(readlinkSync(join(home, 'cfg/opencode/skills/standards')), skill);
  assert.match(install(home, '--harness', 'all', '--apply'), /applied: 0 linked, 2 unchanged, 0 skipped/);
});

test('never overwrites a folder that is not a symlink', () => {
  const home = tempHome();
  mkdirSync(join(home, '.agents/skills/standards'), { recursive: true });
  assert.match(install(home, '--harness', 'agents', '--apply'), /skipped agents: .* is not a symlink/);
  assert.equal(lstatSync(join(home, '.agents/skills/standards')).isSymbolicLink(), false);
});

test('a dry run shows where a symlink it would replace points now', () => {
  const home = tempHome();
  mkdirSync(join(home, '.agents/skills'), { recursive: true });
  symlinkSync(join(home, 'other-standards'), join(home, '.agents/skills/standards'));
  assert.match(install(home, '--harness', 'agents'), /^relink agents: .*\/\.agents\/skills\/standards -> .* \(was -> .*\/other-standards\)$/m);
});
