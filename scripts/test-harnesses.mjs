#!/usr/bin/env node
// Smoke test: in each installed harness, a temp home with only the auth copied in, the
// repo's skills installed, and one prompt that invokes `standards` with no argument.
// Passes when the reply holds the menu from SKILL.md. A pass also proves the harness loads
// a skill carrying the `argument-hint` extension key.
//
//   node scripts/test-harnesses.mjs [--harness claude,codex,opencode] [--keep]
//
// Needs real auth and spends real quota, so it stays out of CI. Run it before each release.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessEnv, privateDir, spawnGuarded } from '../plugins/standards/skills/standards/scripts/prune.mjs';

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

const USAGE = `usage: node scripts/test-harnesses.mjs [--harness claude,codex,opencode] [--keep]

Runs the standards skill with no argument in each installed harness and checks the reply
holds its menu. Needs each harness's login and spends real quota. --keep leaves the temp homes,
with every login copy deleted from them. With CLAUDE_CODE_OAUTH_TOKEN set (from claude setup-token),
claude takes its login from the environment and none is copied to disk.`;

// Login copies a kept temp home must not carry.
const LOGIN_FILES = ['claude/.credentials.json', 'codex/auth.json', 'data/opencode/auth.json'];

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

// A bare temp home has no keychain, so the OS asks the user to reset one whenever a harness stores its
// login. Linking the real keychain folder keeps the home isolated and the token writes silent.
function tempHome(dir) {
  mkdirSync(join(dir, 'Library'), { recursive: true });
  const keychains = join(HOME, 'Library/Keychains');
  if (existsSync(keychains)) symlinkSync(keychains, join(dir, 'Library/Keychains'));
  return dir;
}

function install(harness, env) {
  const r = spawnSync('sh', [join(repo, 'scripts/install.sh'), '--harness', harness, '--apply'], { env, encoding: 'utf8' });
  if (r.status !== 0 || !/applied: [1-9]/.test(r.stdout)) throw new Error(`install.sh failed: ${r.stdout}${r.stderr}`);
}

async function run(cmd, argv, cwd, env, scratch) {
  const r = await spawnGuarded(cmd, argv, { cwd, env, timeoutMs: TIMEOUT_MS, track: scratch.track });
  return { out: r.stdout, err: r.stderr, code: r.timedOut ? `killed (timeout ${TIMEOUT_MS / 1000}s)` : r.signal ? `killed (${r.signal})` : r.code };
}

// Each harness: auth() returns a skip reason or null; setup() builds the temp home and
// returns the command to run.
export const HARNESSES = {
  claude: {
    auth() {
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return null;
      this.creds = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' })
        .stdout?.trim();
      if (!this.creds && existsSync(join(HOME, '.claude/.credentials.json'))) {
        this.creds = readFileSync(join(HOME, '.claude/.credentials.json'), 'utf8').trim();
      }
      return this.creds ? null : 'not logged in (no stored credentials)';
    },
    setup(tmp) {
      const cfg = join(tmp, 'claude');
      mkdirSync(cfg, { mode: 0o700 });
      const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (!token) writeFileSync(join(cfg, '.credentials.json'), `${this.creds}\n`, { mode: 0o600, flag: 'wx' });
      // Claude Code installs through the marketplace; --plugin-dir loads the same plugin folder.
      return {
        cmd: 'claude',
        argv: ['-p', PROMPT, '--model', CLAUDE_MODEL, '--plugin-dir', join(repo, 'plugins/standards'),
          '--permission-mode', 'bypassPermissions', '--max-turns', '8'],
        env: harnessEnv({ CLAUDE_CONFIG_DIR: cfg, ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } : {}) }),
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
      const env = harnessEnv({ HOME: join(tmp, 'home'), CODEX_HOME: codexHome });
      tempHome(env.HOME);
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
      const env = harnessEnv({
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
      tempHome(env.HOME);
      install('opencode', env);
      return { cmd: 'opencode', argv: ['run', '--standalone', '-m', OPENCODE_MODEL, PROMPT], env };
    },
  },
};

async function check(name, h, menu, scratch, kept) {
  const bin = h.command ?? name;
  if (!onPath(bin)) return { name, status: 'skip', reason: `${bin} not on PATH` };
  const noAuth = h.auth();
  if (noAuth) return { name, status: 'skip', reason: noAuth };
  const tmp = mkdtempSync(join(scratch.dir, `${name}-`));
  const keptAt = kept ? join(kept, basename(tmp)) : null;
  try {
    const proj = join(tmp, 'proj');
    mkdirSync(proj);
    spawnSync('git', ['init', '-q', proj]);
    const { cmd, argv, env } = h.setup(tmp);
    const r = await run(cmd, argv, proj, env, scratch);
    writeFileSync(join(tmp, 'output.txt'), `${r.out}\n--- stderr ---\n${r.err}`);
    const said = norm(r.out);
    const missing = menu.filter((line) => !said.includes(line));
    const tail = `${r.out}\n${r.err}`.trim().split('\n').slice(-20).join('\n');
    if (!missing.length) return { name, status: 'pass', reason: `menu printed (${menu.length} lines), exit ${r.code}`, tmp: keptAt };
    const hint = /argument-hint/i.test(r.err + r.out) ? '; output mentions argument-hint' : '';
    return { name, status: 'fail', reason: `exit ${r.code}; ${missing.length}/${menu.length} menu lines missing${hint}`, missing, tail, tmp: keptAt };
  } catch (e) {
    return { name, status: 'fail', reason: `runner error: ${e.message}`, tmp: keptAt };
  } finally {
    // A kept home leaves the private scratch, which is removed at exit, with every login copy deleted first.
    if (keptAt) {
      for (const f of LOGIN_FILES) rmSync(join(tmp, f), { force: true });
      renameSync(tmp, keptAt);
    } else rmSync(tmp, { recursive: true, force: true });
  }
}

/** Runs the check in each harness; returns the exit code. */
export async function main(args, harnesses = HARNESSES) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const keep = args.includes('--keep');
  const hIdx = args.indexOf('--harness');
  const only = hIdx >= 0 ? (args[hIdx + 1] ?? '').split(',').filter(Boolean) : null;
  const unknown = only?.filter((n) => !harnesses[n]) ?? [];
  if (only && (!only.length || unknown.length)) {
    console.error(`${only.length ? `unknown harness: ${unknown.join(', ')}` : '--harness needs a value'}; known: ${Object.keys(harnesses).join(', ')}\n${USAGE}`);
    return 2;
  }
  const menu = menuLines();
  // Every temp home and login copy lives in one owner-only folder, removed on exit, on an uncaught error, SIGINT, SIGTERM and SIGHUP.
  const scratch = privateDir(tmpdir(), 'harness-');
  const kept = keep ? mkdtempSync(join(tmpdir(), 'harness-kept-')) : null;
  try {
    const names = Object.keys(harnesses).filter((n) => !only || only.includes(n));
    const results = await Promise.all(names.map((n) => check(n, harnesses[n], menu, scratch, kept)));
    for (const r of results) {
      console.log(`${r.status.toUpperCase().padEnd(4)} ${r.name.padEnd(8)} ${r.reason}${r.tmp ? ` (kept ${r.tmp})` : ''}`);
      if (r.status === 'fail') {
        for (const m of r.missing ?? []) console.log(`       missing: ${m}`);
        if (r.tail) console.log(r.tail.replace(/^/gm, '       | '));
      }
    }
    const fails = results.filter((r) => r.status === 'fail').length;
    const passes = results.filter((r) => r.status === 'pass').length;
    console.log(`harnesses: ${passes} pass, ${fails} fail, ${results.filter((r) => r.status === 'skip').length} skip`);
    // A release check that ran nothing proved nothing, so it does not pass.
    if (!passes && !fails) console.log('no harness ran; nothing was tested');
    return fails || !passes ? 1 : 0;
  } finally {
    scratch.dispose();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
