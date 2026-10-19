#!/usr/bin/env node
// Smoke test: in each installed harness, a temp home with only the auth copied in, the
// repo's skills installed, and one prompt that invokes `standards` with no argument.
// Passes when the reply holds the menu from SKILL.md. A pass also proves the harness loads
// a skill carrying the `argument-hint` extension key.
//
//   node scripts/test-harnesses.mjs [--harness claude,codex,opencode] [--keep]
//
// Needs real auth and spends real quota, so it stays out of CI. Run it before each release.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const HOME = homedir();
const TIMEOUT_MS = 600_000;
const CLAUDE_MODEL = process.env.TEST_CLAUDE_MODEL ?? 'haiku';
// opencode's OAuth providers don't route from a temp home, so the run uses a free model
// served by opencode's own provider.
const OPENCODE_MODEL = process.env.TEST_OPENCODE_MODEL ?? 'opencode/big-pickle';
const PROMPT =
  'Use the `standards` skill with no argument, exactly as if I had typed `/standards` with nothing after it. ' +
  'Follow its instructions for that case and reply with exactly what it tells you to show. ' +
  'Do not run any other command and do not change any file.';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const hIdx = args.indexOf('--harness');
const only = hIdx >= 0 ? args[hIdx + 1].split(',') : null;

/** The menu lines from the fenced block under `## Menu`, whitespace collapsed. */
function menuLines() {
  const text = readFileSync(join(repo, 'plugins/standards/skills/standards/SKILL.md'), 'utf8');
  const block = text.split(/^## Menu$/m)[1]?.match(/```text\n([\s\S]*?)```/)?.[1];
  if (!block) throw new Error('no menu block under "## Menu" in standards SKILL.md');
  return block.split('\n').map(norm).filter(Boolean);
}
const norm = (s) => s.replace(/[`*|]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

function onPath(bin) {
  return (process.env.PATH ?? '').split(delimiter).some((d) => existsSync(join(d, bin)));
}

/** A clean env: the caller's PATH and basics, with every home and key override dropped. */
function cleanEnv(extra) {
  const drop = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.includes(k)));
  return { ...env, ...extra };
}

function install(harness, env) {
  const r = spawnSync('sh', [join(repo, 'scripts/install.sh'), '--harness', harness, '--apply'], { env, encoding: 'utf8' });
  if (r.status !== 0 || !/applied: [1-9]/.test(r.stdout)) throw new Error(`install.sh failed: ${r.stdout}${r.stderr}`);
}

function run(cmd, argv, cwd, env) {
  return new Promise((done) => {
    const child = spawn(cmd, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ out, err, code: signal ? `killed (${signal}, timeout ${TIMEOUT_MS / 1000}s)` : code });
    });
  });
}

// Each harness: auth() returns a skip reason or null; setup() builds the temp home and
// returns the command to run.
const HARNESSES = {
  claude: {
    auth() {
      this.creds = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' })
        .stdout?.trim();
      if (!this.creds && existsSync(join(HOME, '.claude/.credentials.json'))) {
        this.creds = readFileSync(join(HOME, '.claude/.credentials.json'), 'utf8').trim();
      }
      return this.creds ? null : 'not logged in (no stored credentials)';
    },
    setup(tmp) {
      const cfg = join(tmp, 'claude');
      mkdirSync(cfg);
      writeFileSync(join(cfg, '.credentials.json'), `${this.creds}\n`);
      chmodSync(join(cfg, '.credentials.json'), 0o600);
      // Claude Code installs through the marketplace; --plugin-dir loads the same plugin folder.
      return {
        cmd: 'claude',
        argv: ['-p', PROMPT, '--model', CLAUDE_MODEL, '--plugin-dir', join(repo, 'plugins/standards'),
          '--permission-mode', 'bypassPermissions', '--max-turns', '8'],
        env: cleanEnv({ CLAUDE_CONFIG_DIR: cfg }),
      };
    },
  },
  codex: {
    auth() {
      return existsSync(join(HOME, '.codex/auth.json')) ? null : 'not logged in (no auth.json)';
    },
    setup(tmp) {
      const codexHome = join(tmp, 'codex');
      mkdirSync(codexHome);
      copyFileSync(join(HOME, '.codex/auth.json'), join(codexHome, 'auth.json'));
      const env = cleanEnv({ HOME: join(tmp, 'home'), CODEX_HOME: codexHome });
      mkdirSync(env.HOME);
      install('codex', env);
      // stdin stays closed: codex exec waits on an open stdin.
      return {
        cmd: 'codex',
        argv: ['exec', '--skip-git-repo-check', '-s', 'read-only', '-c', 'model_reasoning_effort="low"', PROMPT],
        env,
      };
    },
  },
  opencode: {
    auth() {
      return existsSync(join(HOME, '.local/share/opencode/auth.json')) ? null : 'not logged in (no auth.json)';
    },
    setup(tmp) {
      const env = cleanEnv({
        HOME: join(tmp, 'home'),
        XDG_CONFIG_HOME: join(tmp, 'config'),
        XDG_DATA_HOME: join(tmp, 'data'),
        XDG_CACHE_HOME: join(tmp, 'cache'),
        XDG_STATE_HOME: join(tmp, 'state'),
      });
      for (const d of [env.HOME, join(env.XDG_CONFIG_HOME, 'opencode'), join(env.XDG_DATA_HOME, 'opencode'), join(env.XDG_CACHE_HOME, 'opencode')]) {
        mkdirSync(d, { recursive: true });
      }
      copyFileSync(join(HOME, '.local/share/opencode/auth.json'), join(env.XDG_DATA_HOME, 'opencode/auth.json'));
      install('opencode', env);
      return { cmd: 'opencode', argv: ['run', '--standalone', '-m', OPENCODE_MODEL, PROMPT], env };
    },
  },
};

async function check(name, menu) {
  const h = HARNESSES[name];
  if (!onPath(name)) return { name, status: 'skip', reason: `${name} not on PATH` };
  const noAuth = h.auth();
  if (noAuth) return { name, status: 'skip', reason: noAuth };
  const tmp = mkdtempSync(join(tmpdir(), `harness-${name}-`));
  try {
    const proj = join(tmp, 'proj');
    mkdirSync(proj);
    spawnSync('git', ['init', '-q', proj]);
    const { cmd, argv, env } = h.setup(tmp);
    const r = await run(cmd, argv, proj, env);
    writeFileSync(join(tmp, 'output.txt'), `${r.out}\n--- stderr ---\n${r.err}`);
    const said = norm(r.out);
    const missing = menu.filter((line) => !said.includes(line));
    const tail = `${r.out}\n${r.err}`.trim().split('\n').slice(-20).join('\n');
    if (!missing.length) return { name, status: 'pass', reason: `menu printed (${menu.length} lines), exit ${r.code}`, tmp };
    const hint = /argument-hint/i.test(r.err + r.out) ? '; output mentions argument-hint' : '';
    return { name, status: 'fail', reason: `exit ${r.code}; ${missing.length}/${menu.length} menu lines missing${hint}`, missing, tail, tmp };
  } catch (e) {
    return { name, status: 'fail', reason: `runner error: ${e.message}`, tmp };
  } finally {
    if (!keep) rmSync(tmp, { recursive: true, force: true });
  }
}

const menu = menuLines();
const names = Object.keys(HARNESSES).filter((n) => !only || only.includes(n));
const results = await Promise.all(names.map((n) => check(n, menu)));
for (const r of results) {
  console.log(`${r.status.toUpperCase().padEnd(4)} ${r.name.padEnd(8)} ${r.reason}${keep && r.tmp ? ` (kept ${r.tmp})` : ''}`);
  if (r.status === 'fail') {
    for (const m of r.missing ?? []) console.log(`       missing: ${m}`);
    if (r.tail) console.log(r.tail.replace(/^/gm, '       | '));
  }
}
const fails = results.filter((r) => r.status === 'fail').length;
console.log(`harnesses: ${results.filter((r) => r.status === 'pass').length} pass, ${fails} fail, ${results.filter((r) => r.status === 'skip').length} skip`);
process.exit(fails ? 1 : 0);
