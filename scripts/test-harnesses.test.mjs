import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./test-harnesses.mjs', import.meta.url));

/** Runs test-harnesses in a child with one fake harness that copies a login; TMPDIR is a fresh folder. */
function childRun(body, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-test-'));
  const tmp = join(dir, 'tmp');
  const pidFile = join(dir, 'agent.pid');
  const script = join(dir, 'child.mjs');
  writeFileSync(script, `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const { main } = await import(${JSON.stringify(SCRIPT)});
    const fake = {
      command: 'sh',
      auth: () => null,
      setup(tmp) {
        mkdirSync(join(tmp, 'claude'));
        writeFileSync(join(tmp, 'claude/.credentials.json'), 'SECRET', { mode: 0o600 });
        return { cmd: 'sh', argv: ['-c', ${JSON.stringify(body)}.replace('PIDFILE', ${JSON.stringify(pidFile)})], env: process.env };
      },
    };
    process.exitCode = await main(${JSON.stringify(args)}, { fake });
  `);
  mkdirSync(tmp);
  const child = spawn(process.execPath, [script], { env: { ...process.env, TMPDIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal, out })));
  const started = new Promise((done, fail) => {
    const poll = setInterval(() => {
      if (existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()) {
        clearInterval(poll);
        done(Number(readFileSync(pidFile, 'utf8')));
      }
    }, 20);
    exited.then(() => { clearInterval(poll); fail(new Error('the child exited before its agent started')); });
  });
  started.catch(() => {});
  return { child, exited, started, tmp };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} removes every temp home and login copy and kills the harness`, async () => {
    const { child, exited, started, tmp } = childRun('echo $$ > PIDFILE; exec sleep 30');
    const pid = await started;
    const [scratch] = readdirSync(tmp);
    assert.equal(statSync(join(tmp, scratch)).mode & 0o777, 0o700);
    child.kill(signal);
    assert.equal((await exited).signal, signal);
    assert.deepEqual(readdirSync(tmp), []);
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(alive(pid), false);
  });
}

test('--keep keeps the temp home without its login copy', async () => {
  const menu = readFileSync(fileURLToPath(new URL('../plugins/standards/skills/standards/SKILL.md', import.meta.url)), 'utf8').split(/^## Menu$/m)[1].match(/```text\n([\s\S]*?)```/)[1];
  const { exited, tmp } = childRun(`echo $$ > PIDFILE; printf '%s' ${JSON.stringify(menu).replace(/\$/g, '\\$')}`, ['--keep']);
  const { code, out } = await exited;
  assert.equal(code, 0, out);
  assert.match(out, /^PASS fake .* \(kept (.+)\)$/m);
  const keptAt = /\(kept (.+)\)$/m.exec(out)[1];
  assert.ok(existsSync(join(keptAt, 'output.txt')));
  assert.equal(existsSync(join(keptAt, 'claude/.credentials.json')), false);
  assert.deepEqual(readdirSync(tmp).filter((n) => !n.startsWith('harness-kept-')), [], 'the private scratch is gone');
});
