import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const scriptPath = (name) => fileURLToPath(new URL(`../skills/standards/scripts/${name}`, import.meta.url));
export const tempDir = () => mkdtempSync(join(tmpdir(), 'standards-test-'));
export const readJsonl = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
export const writeJsonl = (file, rows) => writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function git(cwd, args, env = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

export function gitRepo(commits, remote) {
  const dir = tempDir();
  git(dir, ['init', '-q', '-b', 'main']);
  if (remote) git(dir, ['remote', 'add', 'origin', remote]);
  for (const c of commits) {
    for (const [path, content] of Object.entries(c.files)) writeFileSync(join(dir, path), content);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', c.message], { GIT_AUTHOR_DATE: c.date, GIT_COMMITTER_DATE: c.date });
  }
  return dir;
}

export function runNode(script, args, cwd) {
  return spawnSync(process.execPath, [scriptPath(script), ...args], { cwd, encoding: 'utf8' });
}

const ok = (stdout = '') => ({ missing: false, status: 0, stdout, stderr: '' });
export const missing = { missing: true, status: null, stdout: '', stderr: '' };
export const failed = (stderr) => ({ missing: false, status: 1, stdout: '', stderr });

// Serves forge CLI calls from a map of api path to response body, and runs git for real
// against the temp repo. `cli` lists the CLIs to pretend are installed and signed in.
export function fakeRunner({ responses = {}, cli = {}, onApi } = {}) {
  return (cmd, args, opts) => {
    if (cmd === 'git') {
      const r = spawnSync('git', args, { cwd: opts?.cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
      return { missing: false, status: r.status, stdout: r.stdout, stderr: r.stderr };
    }
    const state = cli[cmd];
    if (!state) return missing;
    if (args[0] === '--version') return ok(`${cmd} version 0.0.0`);
    if (args[0] === 'auth') return state === 'signed-out' ? failed('not logged in') : ok();
    if (args[0] === 'api') {
      const path = args[3];
      const override = onApi?.(cmd, path);
      if (override) return override;
      return path in responses ? ok(JSON.stringify(responses[path])) : failed('HTTP 404: Not Found');
    }
    throw new Error(`unexpected call ${cmd} ${args.join(' ')}`);
  };
}
