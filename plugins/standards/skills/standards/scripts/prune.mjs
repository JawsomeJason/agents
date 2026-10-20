#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ignoreWorkDir } from './questions.mjs';

const USAGE = [
  'usage: prune.mjs <plan|trial|step|status|questions|finish> --standards <dir> --repo <dir> --out <dir> --probes <file> [options]',
  '',
  'commands:',
  '  plan     print the rules, harnesses and the most runs the sampling could take',
  '  trial    run one probe once in the none arm and keep the output apart, uncounted (--section, --harness)',
  '  step     run every batch the sampling still needs, then write the grading questions',
  '  status   print each rule\'s tallies and what it waits on',
  '  questions  write the grading questions for the runs on disk, and run nothing',
  '  finish   apply the decision rules to graded runs and write prune.json',
  '',
  'options:',
  '  --standards <dir>   the generated standards folder (holds SKILL.md and its § files)',
  '  --repo <dir>        the target repo checkout the runs branch from, at its HEAD',
  '  --out <dir>         where run data lives; every command resumes from it',
  '  --probes <file>     probe tasks, one per §, per references/schemas/prune.probes.schema.json',
  '  --harnesses <list>  comma-separated harness names to run (default: every adapter found)',
  '  --skip <name:why>   record a harness as skipped with a reason (repeatable, comma-separated)',
  '  --sections <list>   comma-separated § ids to probe; a bare parent such as §2 takes all its children',
  '  --graders <list>    comma-separated grader names: two voters, then an optional tiebreaker',
  '  --concurrency <n>   parallel runs per harness (default 3)',
  '  --timeout-min <n>   minutes before a run is killed (default 25)',
  '  --backoff-sec <n>   first wait after a throttled provider, doubling up to 8 minutes (default 30)',
  '  --env KEY=VALUE     extra environment for every agent run (repeatable)',
  '  --model name=ID     pin a harness to a model instead of its default (repeatable); the run data records the pin',
  '  --writable <dir>    extra directory an agent may write to (repeatable)',
  '  --prune-json <file> where finish writes prune.json (default: beside the standards SKILL.md)',
  '  --summary <file>    where finish writes the per-rule markdown table',
  '  --calibration <file> human labels, one {question_id, complies} per line, that finish scores the first grader against',
  '  --dry-run           print what step would run, and run nothing',
  '',
  'Known harnesses: codex, opencode, claude. Run with --help for this text.',
  'Set CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token) and claude takes its login from the environment, with no copy on disk.',
].join('\n');

export const ARMS = ['none', 'one-liner', 'full'];
export const BATCH = 5;
export const DELETE_THRESHOLD = 0.9;
export const KEEP_MARGIN = 1;
export const CALIBRATION_MIN = 30;
export const CALIBRATION_PASS = 0.9;
const RULE_ARMS = ['one-liner', 'full'];
const MAX_FAILURES_PER_CELL = 8;
const MAX_THROTTLES_PER_RUN = 3;
// A provider that refuses work for lack of quota says so on a failed exit; the agent's own prose never sets the exit code.
const THROTTLED = /"status":\s*429|rate limit|usage limit|provider\.quota|too many requests/i;
const DIFF_STORE_MAX = 1_000_000;
const QUESTION_DIFF_MAX = 45_000;
const OUTPUT_LOG_MAX = 300_000;
const HOME = homedir();

export class UsageError extends Error {}

const SECTION_ID = /^§\d+(\.\d+)*$/;
const sectionSlug = (s) => `s${s.slice(1).replaceAll('.', '-')}`;
const sectionOrder = (s) => s.slice(1).split('.').map(Number);
const bySection = (a, b) => {
  const x = sectionOrder(a);
  const y = sectionOrder(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
  return 0;
};

function writeAtomic(file, text) {
  ignoreWorkDir(file);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const readJson = (file, what) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new UsageError(`${what} file not found: ${file}`);
    throw new UsageError(`${file} is not valid JSON`);
  }
};

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, i) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        throw new UsageError(`${file}:${i + 1} is not valid JSON`);
      }
    });
}

// ---------------------------------------------------------------------------------------------
// Standards and probes

// The severity tag is for a reviewer reading the index. Telling a writing agent the rule is a nit is a treatment
// of its own, so it stays out of the rule text the arms and the grader see.
const INDEX_LINE = /^- (§\d+(?:\.\d+)*) (.+?)(?: \((nit|minor|major|blocker)\))? \[§\d+(?:\.\d+)*\]\(([^)]+)\)( Read first\.)?\s*$/;

/** Every rule in the standards index: its § id, one-liner, § file path and file text. */
export function loadStandards(dir) {
  const skillFile = join(dir, 'SKILL.md');
  if (!existsSync(skillFile)) throw new UsageError(`no SKILL.md in ${dir}`);
  const rules = [];
  for (const line of readFileSync(skillFile, 'utf8').split('\n')) {
    const m = INDEX_LINE.exec(line);
    if (!m) continue;
    const file = resolve(dir, m[4]);
    if (!existsSync(file)) throw new UsageError(`${skillFile} links ${m[4]} for ${m[1]}, which does not exist`);
    rules.push({ section: m[1], rule: m[2].trim(), severity: m[3] ?? null, indexLine: line.replace(/^- /, '').trim(), readFirst: Boolean(m[5]), file, text: readFileSync(file, 'utf8').trim() });
  }
  if (!rules.length) throw new UsageError(`no index lines of the form "- §N.M rule [§N.M](path)" in ${skillFile}`);
  return rules.sort((a, b) => bySection(a.section, b.section));
}

/** The rules a --sections list names. A parent such as §2 takes §2 and every §2.x. */
export function selectRules(rules, sections) {
  if (!sections?.length) return rules;
  for (const s of sections) if (!SECTION_ID.test(s)) throw new UsageError(`${s} is not a § id such as §2 or §2.1`);
  const chosen = rules.filter((r) => sections.some((s) => r.section === s || r.section.startsWith(`${s}.`)));
  const missing = sections.filter((s) => !rules.some((r) => r.section === s || r.section.startsWith(`${s}.`)));
  if (missing.length) throw new UsageError(`no rule matches ${missing.join(', ')}`);
  return chosen;
}

export function loadProbes(file, rules) {
  const probes = readJson(file, 'probes');
  if (!Array.isArray(probes)) throw new UsageError(`${file} must be a JSON array`);
  const seen = new Set();
  for (const [i, p] of probes.entries()) {
    const where = `${file} probe ${i + 1}`;
    if (typeof p?.section !== 'string' || !SECTION_ID.test(p.section)) throw new UsageError(`${where}: section must be a § id`);
    if (typeof p.probe !== 'string' || !p.probe.trim()) throw new UsageError(`${where}: probe must be a non-empty string`);
    if (Object.keys(p).some((k) => k !== 'section' && k !== 'probe')) throw new UsageError(`${where}: only section and probe are allowed`);
    if (seen.has(p.section)) throw new UsageError(`${where}: duplicate section ${p.section}`);
    seen.add(p.section);
  }
  const missing = rules.filter((r) => !seen.has(r.section)).map((r) => r.section);
  if (missing.length) throw new UsageError(`${file} has no probe for ${missing.join(', ')}`);
  return new Map(probes.map((p) => [p.section, p.probe]));
}

/** The prompt for one arm: the arm's text, a blank line, then the probe. */
export function buildPrompt(arm, rule, probe) {
  if (arm === 'none') return probe;
  if (arm === 'one-liner') return `Project rule: ${rule.rule}\n\n${probe}`;
  if (arm === 'full') return `Project rule: ${rule.text}\n\n${probe}`;
  throw new Error(`unknown arm ${arm}`);
}

// ---------------------------------------------------------------------------------------------
// Decision rules (pure)

/**
 * cells[harness][arm] = { runs, graded } where runs counts finished runs and graded is the
 * ordered list of final verdicts. Returns the next batches to run, whether grading is pending,
 * or the decision.
 */
export function advance(cells, harnesses) {
  // every() is true on an empty list, so with no harness each rule below would pass on zero runs.
  if (!harnesses.length) return { state: 'open', needs: [], pending: false, blocked: 'no harness ran' };
  const needs = [];
  let pending = false;
  const ensure = (arm, target) => {
    for (const h of harnesses) {
      const c = cells[h][arm];
      if (c.runs < target) needs.push({ harness: h, arm, count: target - c.runs });
      else if (c.graded.length < target) pending = true;
    }
    return !needs.length && !pending;
  };
  const first = (h, arm, n) => cells[h][arm].graded.slice(0, n);
  const complied = (list) => list.filter(Boolean).length;
  const open = () => ({ state: 'open', needs, pending });
  const decided = (decision, reason) => ({ state: 'decided', decision, reason });
  const rate = (list) => `${complied(list)}/${list.length}`;
  const perHarness = (arm, n) => harnesses.map((h) => `${h} ${rate(first(h, arm, n))}`).join(', ');

  if (!ensure('none', BATCH)) return open();
  if (harnesses.every((h) => complied(first(h, 'none', BATCH)) === BATCH)) {
    if (!ensure('none', 2 * BATCH)) return open();
    if (harnesses.every((h) => complied(first(h, 'none', 2 * BATCH)) / (2 * BATCH) >= DELETE_THRESHOLD)) {
      return decided('delete', `The none arm complied at least ${DELETE_THRESHOLD * 100}% in every harness (${perHarness('none', 2 * BATCH)}).`);
    }
  }
  if (!ensure('one-liner', BATCH)) return open();
  const failures = (h, arm) => BATCH - complied(first(h, arm, BATCH));
  if (harnesses.every((h) => failures(h, 'one-liner') <= KEEP_MARGIN)) {
    return decided('one-liner', `The one-liner arm failed at most ${KEEP_MARGIN} time in every harness (${perHarness('one-liner', BATCH)}), so no arm can beat it by more than ${KEEP_MARGIN}.`);
  }
  if (!ensure('full', BATCH)) return open();
  const best = (h) => Math.min(...RULE_ARMS.map((a) => failures(h, a)));
  if (harnesses.some((h) => best(h) > KEEP_MARGIN)) {
    const worst = harnesses.filter((h) => best(h) > KEEP_MARGIN).join(', ');
    return decided('weak', `Even the best arm failed more than ${KEEP_MARGIN} time in ${BATCH} in ${worst} (one-liner ${perHarness('one-liner', BATCH)}; full ${perHarness('full', BATCH)}), so the rule needs a check a tool runs.`);
  }
  const arm = RULE_ARMS.find((a) => harnesses.every((h) => failures(h, a) <= best(h) + KEEP_MARGIN));
  return decided(arm, `The ${arm} arm is the cheapest within ${KEEP_MARGIN} failure of the best in every harness (one-liner ${perHarness('one-liner', BATCH)}; full ${perHarness('full', BATCH)}).`);
}

/** Compliance with the rule minus compliance without it, for each rule arm that ran. */
export function liftOf(cells, harnesses) {
  const rows = [];
  const rate = (list) => (list.length ? list.filter(Boolean).length / list.length : null);
  for (const arm of RULE_ARMS) {
    const ran = harnesses.filter((h) => cells[h][arm].graded.length);
    if (!ran.length) continue;
    for (const h of ran) {
      const w = rate(cells[h][arm].graded);
      const n = rate(cells[h].none.graded);
      if (w !== null && n !== null) rows.push({ harness: h, arm, none: n, with: w, lift: round(w - n) });
    }
    const w = rate(ran.flatMap((h) => cells[h][arm].graded));
    const n = rate(ran.flatMap((h) => cells[h].none.graded));
    if (w !== null && n !== null) rows.push({ harness: 'all', arm, none: n, with: w, lift: round(w - n) });
  }
  return rows;
}

const round = (x) => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------------------------------------
// Grading (pure)

/**
 * Two graders vote, and a third breaks a tie. With one grader its vote stands. votes maps a
 * grader name to true, false or undefined (no answer yet).
 */
export function consensus(votes, graders) {
  const [a, b, tiebreak] = graders;
  const va = votes[a];
  if (graders.length === 1) return { verdict: va ?? null, need: va === undefined ? [a] : [], agreed: null, tiebroken: false };
  const vb = votes[b];
  if (va === undefined || vb === undefined) return { verdict: null, need: [a, b].filter((g) => votes[g] === undefined), agreed: null, tiebroken: false };
  if (va === vb) return { verdict: va, need: [], agreed: true, tiebroken: false };
  if (!tiebreak) return { verdict: null, need: [], agreed: false, tiebroken: false, unresolved: true };
  const vt = votes[tiebreak];
  if (vt === undefined) return { verdict: null, need: [tiebreak], agreed: false, tiebroken: false };
  return { verdict: vt, need: [], agreed: false, tiebroken: true };
}

export const runKey = (r) => `${sectionSlug(r.section)}/${r.harness}/${r.arm}/${String(r.run).padStart(2, '0')}`;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * A grading question's id hashes the run's slot with everything the grader judges: the stored diff, the § text and
 * the probe. A redone run, an edited § or a rewritten probe then gets a new question, and its old verdict no longer
 * matches anything.
 */
export const questionId = (r, rule, probe) => `${sha256([runKey(r), r.diff_sha256, sha256(rule.text), sha256(probe)].join('\n')).slice(0, 12)}#complies`;

const CRITERIA = {
  true: 'Every place the diff adds or changes code that this rule governs follows the rule, or the diff touches nothing the rule governs.',
  false: 'Some added or changed code breaks the rule.',
};

/** Puts files a rule most likely governs first and tests last, then cuts the text at a file boundary. */
export function trimDiff(diff, max = QUESTION_DIFF_MAX) {
  if (diff.length <= max) return diff;
  const files = diff.split(/^(?=diff --git )/m);
  const weight = (f) => (TEST_FILE.test(/^diff --git a\/(\S+)/.exec(f)?.[1] ?? '') ? 1 : 0);
  const ordered = [...files].sort((x, y) => weight(x) - weight(y));
  let out = '';
  let dropped = 0;
  for (const f of ordered) {
    if (out.length + f.length <= max) out += f;
    else dropped++;
  }
  return `${out}\n[${dropped} more file diffs left out for length]\n`;
}

const SIBLING_FILE_MAX = 6_000;
const SIBLING_TOTAL_MAX = 30_000;
const SIBLING_COUNT_MAX = 8;
const TEST_FILE = /(_test\.|\.test\.|\.spec\.|(^|\/)tests?\/)/;
const treeCache = new Map();

function treeAt(repo, head) {
  const key = `${repo}@${head}`;
  if (!treeCache.has(key)) treeCache.set(key, git(repo, ['ls-tree', '-r', '--name-only', head]).split('\n').filter(Boolean));
  return treeCache.get(key);
}

const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf('/'), 0));
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const sharedDepth = (a, b) => {
  const x = a.split('/');
  const y = b.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
};

/**
 * Paths of the files a grader needs beside the diff, at the commit the runs branched from, most
 * relevant first: files the rule names, then neighbors of each changed file in its own directory,
 * then the files of its sibling directories, then same-named files elsewhere, nearest first.
 * Changed files and test files are left out; the diff already shows the first and the second teach nothing.
 */
export function siblingPaths(tree, ruleText, changed) {
  const inTree = new Set(tree);
  const changedSet = new Set(changed);
  const chosen = [];
  const add = (p) => {
    if (inTree.has(p) && !changedSet.has(p) && !TEST_FILE.test(p) && !chosen.includes(p)) chosen.push(p);
  };
  for (const m of ruleText.matchAll(/`([\w@./-]+\.\w+)`/g)) add(m[1]);
  const sources = changed.filter((f) => !TEST_FILE.test(f));
  const nearest = (f, list) => [...list].sort((a, b) => sharedDepth(f, b) - sharedDepth(f, a) || a.localeCompare(b));
  for (const f of sources) for (const p of tree.filter((t) => dirOf(t) === dirOf(f))) add(p);
  for (const f of sources) {
    const parent = dirOf(dirOf(f));
    for (const p of nearest(f, tree.filter((t) => dirOf(dirOf(t)) === parent && dirOf(t) !== dirOf(f)))) add(p);
  }
  for (const f of sources) for (const p of nearest(f, tree.filter((t) => baseOf(t) === baseOf(f) && dirOf(t) !== dirOf(f)))) add(p);
  return chosen.slice(0, SIBLING_COUNT_MAX);
}

/** The sibling files' text, each cut to a size, as one block for a grading question. */
export function siblingContext(repo, head, ruleText, changed) {
  const paths = siblingPaths(treeAt(repo, head), ruleText, changed);
  let out = '';
  for (const p of paths) {
    let text = git(repo, ['show', `${head}:${p}`]);
    if (text.length > SIBLING_FILE_MAX) text = `${text.slice(0, SIBLING_FILE_MAX)}\n[file cut at ${SIBLING_FILE_MAX} characters]\n`;
    const block = `--- ${p}\n${text}\n`;
    if (out.length + block.length > SIBLING_TOTAL_MAX) break;
    out += block;
  }
  return out;
}

export function buildQuestion(rule, run, diff, siblings = '', probe = '') {
  const context = siblings ? `\n\nFiles the rule points at and the changed files' siblings, as they stood before the change:\n${siblings}` : '';
  return {
    id: questionId({ ...run, diff_sha256: sha256(diff) }, rule, probe),
    kind: 'yesno',
    section: rule.section,
    prompt: `Does this output follow this rule: ${rule.rule}`,
    criteria: CRITERIA,
    state: `Rule section:\n${rule.text}\n\nDiff produced for a change request:\n${trimDiff(diff)}${context}`,
  };
}

const ANSWERERS = ['judgment-model', 'agent', 'human'];

/** Checks an answers file line by line against the questions it should answer. */
export function checkAnswers(questions, answers) {
  const ids = new Set(questions.map((q) => q.id));
  const problems = [];
  const seen = new Set();
  const good = new Map();
  for (const a of answers) {
    let why = null;
    if (!ids.has(a.question_id)) why = 'answers no question in the questions file';
    else if (seen.has(a.question_id)) why = 'has more than one answer';
    else if (typeof a.answer !== 'boolean') why = 'answer must be true or false';
    else if (typeof a.confidence !== 'number' || a.confidence < 0 || a.confidence > 1) why = 'confidence must be within 0 and 1';
    else if (!ANSWERERS.includes(a.answered_by)) why = `answered_by must be one of ${ANSWERERS.join(', ')}`;
    else if (a.answered_by === 'judgment-model' && !(typeof a.model === 'string' && a.model)) why = 'judgment-model answers need a model';
    seen.add(a.question_id);
    if (why) problems.push({ id: String(a.question_id), detail: why });
    else good.set(a.question_id, a);
  }
  return { problems, answers: good };
}

// ---------------------------------------------------------------------------------------------
// Private scratch

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // the process already exited
    }
  }
}

const EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// Runs the agent in its own process group and kills that whole group when the time runs out or when the
// parent is gone, so an agent outlives neither a parent killed with no chance to clean up nor its timeout.
const WATCHDOG = `
const { spawn } = require('node:child_process');
const [ms, parent, cmd, ...argv] = process.argv.slice(1);
const killGroup = () => { try { process.kill(-process.pid, 'SIGKILL'); } finally { process.exit(137); } };
const child = spawn(cmd, argv, { stdio: 'inherit' });
child.on('error', (e) => { process.stderr.write(e.message + '\\n'); process.exit(127); });
child.on('exit', (code, signal) => process.exit(code ?? 128));
setTimeout(killGroup, Number(ms));
setInterval(() => { if (process.ppid !== Number(parent)) killGroup(); }, 250);
`;

// The parent's own timer fires first while the parent lives; the watchdog's is the backstop.
const WATCHDOG_GRACE_MS = 2000;

/**
 * Spawns cmd under the watchdog, detached into its own process group. Resolves with its output, exit code
 * and whether the timeout killed it. track(child) lets privateDir kill the group on a signal.
 */
export function spawnGuarded(cmd, argv, { cwd, env, timeoutMs, track }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['-e', WATCHDOG, String(timeoutMs + WATCHDOG_GRACE_MS), String(process.pid), cmd, ...argv], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    track?.(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => done({ stdout, stderr: `${stderr}${e.message}`, code: null, signal: null, timedOut }));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ stdout, stderr, code, signal, timedOut });
    });
  });
}

/**
 * One folder per process, readable only by its owner, for every run's temp home and login copy.
 * It is removed on a normal exit, an uncaught error, SIGINT, SIGTERM and SIGHUP, and by dispose(). A signal
 * also kills the agents first: each runs in its own process group, so neither a terminal's Ctrl-C nor the
 * hangup from closing the terminal reaches it.
 */
export function privateDir(parent, prefix = 'standards-prune-') {
  const dir = mkdtempSync(join(parent, prefix));
  const children = new Set();
  const remove = () => {
    for (const pid of children) killGroup(pid);
    rmSync(dir, { recursive: true, force: true });
  };
  const onSignal = (signal) => {
    remove();
    process.kill(process.pid, signal);
  };
  for (const signal of EXIT_SIGNALS) process.once(signal, onSignal);
  process.once('exit', remove);
  return {
    dir,
    track(child) {
      children.add(child.pid);
      child.once('close', () => children.delete(child.pid));
    },
    dispose() {
      for (const signal of EXIT_SIGNALS) process.off(signal, onSignal);
      process.off('exit', remove);
      remove();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Harness adapters

const PASS_ENV = /^(?:PATH|HOME|LANG|LC_\w+|TERM|TMPDIR|USER|SHELL)$/;

/**
 * An agent's environment: the caller's locale, shell and path basics, plus what the adapter adds for its own
 * login and what --env names. Everything else stays out, such as a forge token or a cloud key, because the agent
 * runs the target repo's own scripts with whatever it is handed.
 */
export function harnessEnv(extra) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => PASS_ENV.test(k))), ...extra };
}

// A bare temp home has no keychain, so the OS asks the user to reset one whenever a harness stores its
// login. Linking the real keychain folder keeps the home isolated and the token writes silent.
function tempHome(dir) {
  mkdirSync(join(dir, 'Library'), { recursive: true });
  const keychains = join(HOME, 'Library/Keychains');
  if (existsSync(keychains)) symlinkSync(keychains, join(dir, 'Library/Keychains'));
  return dir;
}

function onPath(bin) {
  return (process.env.PATH ?? '').split(':').some((d) => d && existsSync(join(d, bin)));
}

function findFile(dir, test) {
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const f = findFile(p, test);
      if (f) return f;
    } else if (test(e.name)) return p;
  }
  return null;
}

const jsonLines = (text) => text.split('\n').flatMap((l) => {
  try {
    return l.trim().startsWith('{') ? [JSON.parse(l)] : [];
  } catch {
    return [];
  }
});

// The account's synced skills and plugins, user skills and commands, and MCP servers would otherwise load into
// every arm, the no-rule arm included. Each run records what its session reported loading, as evidence.
export const CLAUDE_ISOLATION = ['--settings', JSON.stringify({ syncClaudeAiSkills: false, syncClaudeAiPlugins: false }), '--disable-slash-commands', '--strict-mcp-config'];

/**
 * An adapter says how to run one prompt headless in a temp home, and how to read the final
 * message and the model ID out of the run. Adding a harness means adding one object here.
 */
export const ADAPTERS = {
  codex: {
    command: 'codex',
    auth: () => (existsSync(join(HOME, '.codex/auth.json')) ? null : 'not logged in (no auth.json)'),
    prepare({ tmp, wt, prompt, writable, model }) {
      const codexHome = join(tmp, 'codex');
      mkdirSync(codexHome);
      tempHome(join(tmp, 'home'));
      copyFileSync(join(HOME, '.codex/auth.json'), join(codexHome, 'auth.json'));
      const add = writable.flatMap((d) => ['--add-dir', d]);
      return { argv: ['exec', '--json', '-s', 'workspace-write', '-C', wt, ...(model ? ['-m', model] : []), ...add, prompt], env: { HOME: join(tmp, 'home'), CODEX_HOME: codexHome } };
    },
    collect({ tmp, stdout }) {
      const events = jsonLines(stdout);
      const messages = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text);
      const session = findFile(join(tmp, 'codex/sessions'), (n) => n.endsWith('.jsonl'));
      const model = session ? /"model":"([^"]+)"/.exec(readFileSync(session, 'utf8'))?.[1] ?? null : null;
      const usage = events.filter((e) => e.type === 'turn.completed').at(-1)?.usage ?? null;
      return { message: messages.at(-1) ?? '', model, usage };
    },
  },
  opencode: {
    command: 'opencode',
    // OAuth providers do not route from a temp home, so the run uses a model served by opencode's own provider.
    // That is a pin, not the harness default, and the runs record it as one.
    pin: { model: () => process.env.PRUNE_OPENCODE_MODEL ?? 'opencode/big-pickle', reason: 'adapter default: OAuth providers do not route from a temp home' },
    auth: () => (existsSync(join(HOME, '.local/share/opencode/auth.json')) ? null : 'not logged in (no auth.json)'),
    prepare({ tmp, prompt, model }) {
      const dirs = { home: join(tmp, 'home'), config: join(tmp, 'config'), data: join(tmp, 'data'), cache: join(tmp, 'cache'), state: join(tmp, 'state') };
      for (const d of [dirs.home, join(dirs.config, 'opencode'), join(dirs.data, 'opencode'), join(dirs.cache, 'opencode'), dirs.state]) mkdirSync(d, { recursive: true });
      copyFileSync(join(HOME, '.local/share/opencode/auth.json'), join(dirs.data, 'opencode/auth.json'));
      tempHome(dirs.home);
      return {
        argv: ['run', '--standalone', '--auto', '--format', 'json', '-m', model, prompt],
        env: { HOME: dirs.home, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state },
      };
    },
    // Its JSON events name no model, so the record carries the model the run was started with.
    collect({ stdout, model }) {
      const texts = jsonLines(stdout).filter((e) => e.type === 'text').map((e) => e.part?.text ?? '');
      return { message: texts.at(-1) ?? '', model, usage: null };
    },
  },
  claude: {
    command: 'claude',
    // A token from `claude setup-token` in CLAUDE_CODE_OAUTH_TOKEN reaches the harness through its environment, and no login is copied to disk.
    auth() {
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return null;
      const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' });
      let creds = r.status === 0 ? r.stdout.trim() : '';
      if (!creds && existsSync(join(HOME, '.claude/.credentials.json'))) creds = readFileSync(join(HOME, '.claude/.credentials.json'), 'utf8').trim();
      ADAPTERS.claude.creds = creds;
      return creds ? null : 'not logged in (no stored credentials)';
    },
    prepare({ tmp, scratch, prompt, model }) {
      tempHome(join(tmp, 'home'));
      const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      let cfg = join(tmp, 'claude');
      if (token) mkdirSync(cfg);
      else {
        // The stored login goes in one config folder per process, inside the private scratch: the harness keys
        // its keychain entry by this path, so a folder per run would leave an entry per run behind.
        cfg = join(scratch, 'claude');
        if (!existsSync(cfg)) {
          mkdirSync(cfg, { mode: 0o700 });
          writeFileSync(join(cfg, '.credentials.json'), `${ADAPTERS.claude.creds}\n`, { mode: 0o600, flag: 'wx' });
        }
      }
      // The scrub keeps the token out of the commands the agent runs.
      const auth = token ? { CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } : {};
      return {
        argv: ['-p', prompt, ...CLAUDE_ISOLATION, '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose', ...(model ? ['--model', model] : [])],
        env: { HOME: join(tmp, 'home'), CLAUDE_CONFIG_DIR: cfg, ...auth },
      };
    },
    collect({ stdout }) {
      const events = jsonLines(stdout);
      const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
      const doc = events.findLast((e) => e.type === 'result');
      const names = (list) => (Array.isArray(list) ? list.map((x) => (typeof x === 'string' ? x : x?.name ?? JSON.stringify(x))) : null);
      const loaded = init ? { skills: names(init.skills), plugins: names(init.plugins), mcp_servers: names(init.mcp_servers) } : null;
      // an unreadable reply leaves the message empty, which the runner counts as a failed attempt
      return { message: doc?.result ?? '', model: Object.keys(doc?.modelUsage ?? {})[0] ?? null, usage: doc?.usage ?? null, loaded };
    },
  },
};

export function detectHarnesses(names, skips, adapters = ADAPTERS) {
  const chosen = names?.length ? names : Object.keys(adapters);
  const out = [];
  for (const name of Object.keys(adapters).filter((n) => !chosen.includes(n))) {
    out.push({ name, status: 'skipped', reason: skips.get(name) ?? 'not requested', version: null, adapter: adapters[name] });
  }
  for (const name of chosen) {
    const adapter = adapters[name];
    if (!adapter) throw new UsageError(`no adapter for harness ${name}; known: ${Object.keys(adapters).join(', ')}`);
    const skipped = skips.get(name);
    if (skipped) {
      out.push({ name, status: 'skipped', reason: skipped, version: null, adapter });
    } else if (!onPath(adapter.command)) {
      out.push({ name, status: 'skipped', reason: `${adapter.command} not on PATH`, version: null, adapter });
    } else {
      const noAuth = adapter.auth();
      const v = spawnSync(adapter.command, ['--version'], { encoding: 'utf8' });
      const version = v.status === 0 ? (v.stdout || v.stderr).trim().split('\n')[0] : null;
      out.push(noAuth ? { name, status: 'skipped', reason: noAuth, version, adapter } : { name, status: 'ran', reason: null, version, adapter });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Isolated runs

const GIT_QUIET = { GIT_TERMINAL_PROMPT: '0' };

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...GIT_QUIET }, ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/**
 * One shallow clone of the target repo's HEAD, with no remote and no history. Worktrees of it
 * give each run a fresh checkout that cannot reach later commits through git.
 */
export function ensureBase(repo, out) {
  const base = join(out, 'cache', 'base');
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  if (!existsSync(join(base, '.git'))) {
    mkdirSync(dirname(base), { recursive: true });
    git(dirname(base), ['clone', '-q', '--depth', '1', pathToFileURL(resolve(repo)).href, base]);
    git(base, ['remote', 'remove', 'origin']);
  }
  const have = git(base, ['rev-parse', 'HEAD']).trim();
  if (have !== head) throw new UsageError(`${base} holds ${have.slice(0, 12)} but the repo HEAD is ${head.slice(0, 12)}; use a fresh --out for a new commit`);
  return { base, head };
}

let worktreeLock = Promise.resolve();
const locked = (fn) => {
  const next = worktreeLock.then(fn, fn);
  worktreeLock = next.catch(() => {});
  return next;
};

const tail = (res) => {
  const t = (res.stderr.trim() || res.stdout.trim()).split('\n').slice(-3).join(' ').slice(-240);
  return t ? `: ${t}` : '';
};

/**
 * Stages everything the agent left in the worktree and returns its diff against the base commit, leaving out
 * the standards folder: the runner deletes it before the agent starts, so that deletion is not the agent's work,
 * and an agent that only writes there changed nothing the probe asked for.
 */
export function captureDiff(wt, head, standardsRel = null) {
  git(wt, ['add', '-A']);
  const scope = ['--', '.', ...(standardsRel ? [`:(exclude)${standardsRel}`] : [])];
  const diff = git(wt, ['diff', '--cached', '--no-color', head, ...scope]);
  const files = git(wt, ['diff', '--cached', '--name-only', head, ...scope]).split('\n').filter(Boolean);
  return { diff, files };
}

/**
 * One agent session in a temp home and a fresh worktree. Returns the finished run record, or
 * { failed } when the session produced nothing usable.
 */
/** The model a harness is pinned to and why: --model first, then the adapter's own pin; null runs the harness default. */
function pinFor(ctx, harness) {
  if (ctx.models.has(harness.name)) return { model: ctx.models.get(harness.name), reason: '--model' };
  return harness.adapter.pin ? { model: harness.adapter.pin.model(), reason: harness.adapter.pin.reason } : null;
}

export async function executeRun(ctx, harness, rule, arm, runNumber, { dest }) {
  ctx.scratch ??= privateDir(ctx.tmpRoot);
  const tmp = mkdtempSync(join(ctx.scratch.dir, 'run-'));
  const wt = join(tmp, 'wt');
  const started = new Date();
  try {
    await locked(() => git(ctx.base, ['worktree', 'add', '-q', '--detach', wt, ctx.head]));
    if (ctx.standardsRel) rmSync(join(wt, ctx.standardsRel), { recursive: true, force: true });
    const prompt = buildPrompt(arm, rule, ctx.probes.get(rule.section));
    const writable = ctx.writable;
    const pin = pinFor(ctx, harness);
    const pinned = pin?.model ?? null;
    const { argv, env } = harness.adapter.prepare({ tmp, scratch: ctx.scratch.dir, wt, prompt, writable, model: pinned });
    // Some harnesses take their working directory from $PWD, which a spawn does not update.
    const res = await spawnGuarded(harness.adapter.command, argv, { cwd: wt, env: harnessEnv({ ...ctx.env, ...env, PWD: wt }), timeoutMs: ctx.timeoutMs, track: ctx.scratch.track });
    if (res.code !== 0 && THROTTLED.test(`${res.stdout}\n${res.stderr}`)) return { failed: `throttled${tail(res)}`, throttled: true, log: `${res.stdout}\n--- stderr ---\n${res.stderr}`.slice(0, OUTPUT_LOG_MAX) };
    const { diff, files } = captureDiff(wt, ctx.head, ctx.standardsRel);
    const got = harness.adapter.collect({ tmp, stdout: res.stdout, stderr: res.stderr, model: pinned });
    const finished = new Date();
    const log = `${res.stdout}\n--- stderr ---\n${res.stderr}`.slice(0, OUTPUT_LOG_MAX);
    if (res.timedOut) return { failed: `timed out after ${Math.round(ctx.timeoutMs / 60000)} minutes`, log };
    if (!files.length) return { failed: `no changes (exit ${res.code})${tail(res)}`, log };
    if (res.code !== 0 && !got.message) return { failed: `exit ${res.code} with no message${tail(res)}`, log };
    mkdirSync(dest, { recursive: true });
    const stored = diff.length > DIFF_STORE_MAX ? `${diff.slice(0, DIFF_STORE_MAX)}\n[diff cut at ${DIFF_STORE_MAX} bytes]\n` : diff;
    writeFileSync(join(dest, 'diff.patch'), stored);
    writeFileSync(join(dest, 'message.txt'), got.message);
    writeFileSync(join(dest, 'output.log'), log);
    const record = {
      section: rule.section,
      harness: harness.name,
      arm,
      run: runNumber,
      model: got.model,
      model_pinned: Boolean(pinned),
      pin_reason: pin?.reason ?? null,
      version: harness.version,
      base_commit: ctx.head,
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      duration_ms: finished - started,
      exit_code: res.code,
      files_changed: files,
      diff_bytes: diff.length,
      diff_sha256: sha256(stored),
      usage: got.usage ?? null,
      loaded: got.loaded ?? null,
    };
    writeAtomic(join(dest, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
    return { record };
  } catch (e) {
    return { failed: `runner error: ${e.message.split('\n')[0]}`, log: e.stack };
  } finally {
    try {
      git(ctx.base, ['worktree', 'remove', '--force', wt]);
    } catch {
      // the worktree was never added, or is already gone
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// State on disk

export const runsDir = (out) => join(out, 'runs');

export function readRuns(out) {
  const root = runsDir(out);
  const runs = [];
  if (!existsSync(root)) return runs;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (existsSync(join(p, 'run.json'))) {
        const run = JSON.parse(readFileSync(join(p, 'run.json'), 'utf8'));
        // A run recorded before diff_sha256 existed is hashed from its stored diff.
        run.diff_sha256 ??= sha256(readFileSync(join(p, 'diff.patch'), 'utf8'));
        runs.push({ ...run, dir: p });
      }
      else walk(p);
    }
  };
  walk(root);
  return runs;
}

/** The finished runs for the rules and harnesses in scope. Runs of anything else stay on disk, ready for a later scope. */
export const scopedRuns = (ctx) => {
  const sections = new Set(ctx.rules.map((r) => r.section));
  return readRuns(ctx.out).filter((r) => sections.has(r.section) && ctx.activeNames.includes(r.harness));
};

const runDir = (out, section, harness, arm, n) => join(runsDir(out), sectionSlug(section), harness, arm, String(n).padStart(2, '0'));

export function readFailures(out) {
  return readJsonl(join(out, 'failures.jsonl'));
}

function graderFile(out, grader, kind) {
  return join(out, 'grading', `${grader}.${kind}.jsonl`);
}

/** Final verdicts per run key, from the graders' answer files. */
export function verdicts(ctx, runs) {
  const { graders, out } = ctx;
  const questionsById = new Map();
  const ruleBy = new Map(ctx.rules.map((x) => [x.section, x]));
  const idOf = (r) => questionId(r, ruleBy.get(r.section), ctx.probes.get(r.section));
  for (const r of runs) questionsById.set(idOf(r), r);
  const answered = new Map(); // grader -> Map(question id -> answer)
  const problems = [];
  for (const g of graders) {
    const file = graderFile(out, g, 'answers');
    const { problems: p, answers } = checkAnswers([...questionsById.keys()].map((id) => ({ id })), readJsonl(file));
    problems.push(...p.map((x) => ({ grader: g, ...x })));
    answered.set(g, answers);
  }
  const byRun = new Map();
  for (const r of runs) {
    const id = idOf(r);
    const votes = Object.fromEntries(graders.map((g) => [g, answered.get(g).get(id)?.answer]));
    byRun.set(runKey(r), { run: r, id, votes, answers: Object.fromEntries(graders.map((g) => [g, answered.get(g).get(id)])), ...consensus(votes, graders) });
  }
  return { byRun, problems };
}

/**
 * A cell grades in run order; a run without a verdict stops the count there, so a later graded
 * run never fills the gap of an earlier ungraded one.
 */
function gradedPrefix(runs, verdictMap) {
  const out = [];
  for (const r of [...runs].sort((a, b) => a.run - b.run)) {
    const v = verdictMap.get(runKey(r));
    if (v?.verdict === null || v?.verdict === undefined) break;
    out.push(v.verdict);
  }
  return out;
}

export function buildCells(runs, verdictMap, harnesses) {
  const cells = Object.fromEntries(harnesses.map((h) => [h, Object.fromEntries(ARMS.map((a) => [a, { runs: 0, graded: [] }]))]));
  for (const h of harnesses) {
    for (const arm of ARMS) {
      const mine = runs.filter((r) => r.harness === h && r.arm === arm);
      cells[h][arm] = { runs: mine.length, graded: gradedPrefix(mine, verdictMap) };
    }
  }
  return cells;
}

function ruleState(ctx, rule, runs, verdictMap) {
  const mine = runs.filter((r) => r.section === rule.section);
  const cells = buildCells(mine, verdictMap, ctx.activeNames);
  return { cells, ...advance(cells, ctx.activeNames) };
}

// ---------------------------------------------------------------------------------------------
// Commands

/** A whole-number option at least min. NaN would start no worker, or kill every run at once, and report success. */
function count(name, value, fallback, min) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be a whole number of at least ${min}, got ${value}`);
  return n;
}

export function createContext(opts, adapters = ADAPTERS) {
  const required = ['standards', 'repo', 'out', 'probes'];
  for (const n of required) if (!opts[n]) throw new UsageError(`--${n} is required\n${USAGE}`);
  const standardsDir = resolve(opts.standards);
  const repo = resolve(opts.repo);
  const out = resolve(opts.out);
  const rules = selectRules(loadStandards(standardsDir), opts.sections);
  const probes = loadProbes(resolve(opts.probes), rules);
  const skips = new Map((opts.skip ?? []).map((s) => {
    const i = s.indexOf(':');
    if (i < 1) throw new UsageError(`--skip wants name:reason, got ${s}`);
    return [s.slice(0, i), s.slice(i + 1)];
  }));
  const harnesses = detectHarnesses(opts.harnesses, skips, adapters);
  const models = new Map((opts.model ?? []).map((m) => {
    const i = m.indexOf('=');
    if (i < 1 || i === m.length - 1) throw new UsageError(`--model wants name=ID, got ${m}`);
    const name = m.slice(0, i);
    if (!adapters[name]) throw new UsageError(`--model names no known harness: ${name}`);
    return [name, m.slice(i + 1)];
  }));
  const rel = relative(repo, standardsDir);
  const env = Object.fromEntries((opts.env ?? []).map((kv) => {
    const i = kv.indexOf('=');
    if (i < 1) throw new UsageError(`--env wants KEY=VALUE, got ${kv}`);
    return [kv.slice(0, i), kv.slice(i + 1)];
  }));
  return {
    standardsDir, repo, out, rules, probes, harnesses, models,
    requested: opts.harnesses?.length ? opts.harnesses : Object.keys(adapters),
    active: harnesses.filter((h) => h.status === 'ran'),
    activeNames: harnesses.filter((h) => h.status === 'ran').map((h) => h.name),
    standardsRel: rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null,
    standardsPath: rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : basename(standardsDir),
    graders: opts.graders ?? [],
    concurrency: count('concurrency', opts.concurrency, 3, 1),
    backoffMs: count('backoff-sec', opts['backoff-sec'], 30, 0) * 1000,
    halted: new Set(),
    timeoutMs: count('timeout-min', opts['timeout-min'], 25, 1) * 60_000,
    tmpRoot: opts['tmp-root'] ?? tmpdir(),
    env,
    writable: (opts.writable ?? []).map((d) => resolve(d)),
    pruneJson: opts['prune-json'] ? resolve(opts['prune-json']) : join(standardsDir, 'prune.json'),
    summary: opts.summary ? resolve(opts.summary) : null,
    calibrationFile: opts.calibration ? resolve(opts.calibration) : null,
    dryRun: Boolean(opts['dry-run']),
    log: opts.log ?? ((s) => console.log(s)),
  };
}

export function plan(ctx) {
  const harnessNote = ctx.harnesses.map((h) => `${h.name} ${h.status === 'ran' ? `(${h.version ?? 'version unknown'})` : `skipped: ${h.reason}`}`).join('; ');
  const perRule = 2 * BATCH + 2 * BATCH; // none 10, one-liner 5, full 5
  const most = ctx.rules.length * ctx.active.length * perRule;
  ctx.log(`${ctx.rules.length} rules, ${ctx.active.length} harnesses: ${harnessNote}`);
  ctx.log(`most runs: ${most} (${perRule} per rule per harness: none 10, one-liner 5, full 5). Fewest: ${ctx.rules.length * ctx.active.length * 2 * BATCH} (none 10, or none 5 and one-liner 5).`);
  return { rules: ctx.rules.length, harnesses: ctx.active.length, most, fewest: ctx.rules.length * ctx.active.length * 2 * BATCH };
}

/**
 * The commit a run branched from. Runs recorded before base_commit existed take the one-commit clone's HEAD, which
 * every run of an --out folder shares, and never the repo's HEAD, which may have moved since.
 */
function baseCommit(ctx, run) {
  if (run.base_commit) return run.base_commit;
  ctx.cachedBase ??= git(join(ctx.out, 'cache', 'base'), ['rev-parse', 'HEAD']).trim();
  return ctx.cachedBase;
}

function writeQuestionFiles(ctx, runs, vmap) {
  const { out, graders } = ctx;
  const ruleBy = new Map(ctx.rules.map((r) => [r.section, r]));
  const summary = {};
  for (const [gi, g] of graders.entries()) {
    const isTiebreak = gi === 2;
    const qs = [];
    for (const r of runs) {
      const v = vmap.byRun.get(runKey(r));
      if (isTiebreak && !(v.votes[graders[0]] !== undefined && v.votes[graders[1]] !== undefined && v.votes[graders[0]] !== v.votes[graders[1]])) continue;
      const rule = ruleBy.get(r.section);
      qs.push(buildQuestion(rule, r, readFileSync(join(r.dir, 'diff.patch'), 'utf8'), siblingContext(ctx.repo, baseCommit(ctx, r), rule.text, r.files_changed ?? []), ctx.probes.get(r.section)));
    }
    // Ids are hashes, so sorting by id mixes arms and harnesses: a grader reading in batches cannot see an arm's runs together.
    qs.sort((x, y) => x.id.localeCompare(y.id));
    const text = qs.map((q) => JSON.stringify(q)).join('\n') + (qs.length ? '\n' : '');
    writeAtomic(graderFile(out, g, 'questions'), text);
    const answeredIds = new Set(readJsonl(graderFile(out, g, 'answers')).map((a) => a.question_id));
    summary[g] = { questions: qs.length, unanswered: qs.filter((q) => !answeredIds.has(q.id)).length };
  }
  return summary;
}

export async function step(ctx) {
  if (!ctx.active.length) throw new UsageError('no harness can run; nothing to do');
  if (!ctx.graders.length) throw new UsageError('--graders is required for step, so it can tell which runs are graded');
  const { base, head } = ctx.dryRun ? { base: null, head: null } : ensureBase(ctx.repo, ctx.out);
  ctx.base = base;
  ctx.head = head;
  const runs = scopedRuns(ctx);
  const vmap = verdicts(ctx, runs);
  for (const p of vmap.problems) ctx.log(`answers problem ${p.grader} ${p.id} ${p.detail}`);
  const failures = readFailures(ctx.out);

  const jobs = [];
  const waiting = [];
  const done = [];
  for (const rule of ctx.rules) {
    const st = ruleState(ctx, rule, runs, vmap.byRun);
    if (st.state === 'decided') {
      done.push(rule.section);
      continue;
    }
    if (st.pending) waiting.push(rule.section);
    for (const n of st.needs) {
      const failedHere = failures.filter((f) => f.kind !== 'throttled' && !THROTTLED.test(f.reason ?? '') && f.section === rule.section && f.harness === n.harness && f.arm === n.arm).length;
      if (failedHere >= MAX_FAILURES_PER_CELL) {
        ctx.log(`${rule.section} ${n.harness} ${n.arm}: ${failedHere} failed attempts, not retrying; see failures.jsonl`);
        continue;
      }
      // Number after the highest run on disk, not the count: a run lost mid-step leaves a gap, and counting would reuse a finished run's number and overwrite it.
      const last = Math.max(0, ...runs.filter((r) => r.section === rule.section && r.harness === n.harness && r.arm === n.arm).map((r) => r.run));
      for (let i = 1; i <= n.count; i++) jobs.push({ rule, harness: ctx.active.find((h) => h.name === n.harness), arm: n.arm, number: last + i });
    }
  }
  ctx.log(`${done.length} rules decided, ${jobs.length} runs to do, ${waiting.length} rules waiting on grading`);
  if (ctx.dryRun) {
    for (const j of jobs) ctx.log(`would run ${j.rule.section} ${j.harness.name} ${j.arm} #${j.number}`);
    return { jobs: jobs.length };
  }

  const dirtBefore = git(ctx.repo, ['status', '--porcelain']);
  try {
    await runJobs(ctx, jobs);
  } finally {
    releaseScratch(ctx);
  }
  if (git(ctx.repo, ['status', '--porcelain']) !== dirtBefore) ctx.log(`WARNING: ${ctx.repo} changed during the step. An agent wrote outside its worktree; restore the repo and redo the runs.`);

  const after = scopedRuns(ctx);
  const vafter = verdicts(ctx, after);
  const files = writeQuestionFiles(ctx, after, vafter);
  const unresolved = [...vafter.byRun.values()].filter((v) => v.unresolved).length;
  if (unresolved) ctx.log(`${unresolved} outputs split the first two graders and no tiebreaker is listed in --graders`);
  for (const [g, s] of Object.entries(files)) ctx.log(`grader ${g}: ${s.unanswered} of ${s.questions} questions unanswered in ${graderFile(ctx.out, g, 'questions')}`);
  writeAtomic(join(ctx.out, 'harnesses.json'), `${JSON.stringify(harnessRecords(ctx, after), null, 2)}\n`);
  return { jobs: jobs.length, files };
}

function releaseScratch(ctx) {
  ctx.scratch?.dispose();
  ctx.scratch = null;
}

async function runJobs(ctx, jobs) {
  const queues = new Map();
  for (const j of jobs) {
    if (!queues.has(j.harness.name)) queues.set(j.harness.name, []);
    queues.get(j.harness.name).push(j);
  }
  const workers = [];
  for (const queue of queues.values()) {
    for (let w = 0; w < ctx.concurrency; w++) {
      workers.push((async () => {
        while (queue.length) {
          const j = queue.shift();
          await oneJob(ctx, j);
        }
      })());
    }
  }
  await Promise.all(workers);
}

async function oneJob(ctx, j) {
  const dest = runDir(ctx.out, j.rule.section, j.harness.name, j.arm, j.number);
  const label = `${j.rule.section} ${j.harness.name} ${j.arm} #${j.number}`;
  let throttles = 0;
  for (let attempt = 1; attempt <= 3;) {
    if (ctx.halted.has(j.harness.name)) return;
    rmSync(dest, { recursive: true, force: true });
    const r = await executeRun(ctx, j.harness, j.rule, j.arm, j.number, { dest });
    if (r.record) {
      ctx.log(`ran ${label}: ${r.record.files_changed.length} files, ${Math.round(r.record.duration_ms / 1000)}s`);
      return;
    }
    const kind = r.throttled ? 'throttled' : 'failed';
    const n = r.throttled ? throttles + 1 : attempt;
    if (r.log) writeAtomic(join(ctx.out, 'failures', `${sectionSlug(j.rule.section)}-${j.harness.name}-${j.arm}-${String(j.number).padStart(2, '0')}-${kind}${n}.log`), r.log);
    appendFileSync(join(ctx.out, 'failures.jsonl'), `${JSON.stringify({ section: j.rule.section, harness: j.harness.name, arm: j.arm, run: j.number, attempt: n, kind, reason: r.failed, at: new Date().toISOString() })}\n`);
    ctx.log(`${kind} ${label} attempt ${n}: ${r.failed}`);
    if (!r.throttled) {
      attempt++;
      continue;
    }
    // A throttled provider is not a bad run: wait it out instead of spending an attempt or leaving a hole in the batch.
    if (++throttles > MAX_THROTTLES_PER_RUN) {
      ctx.halted.add(j.harness.name);
      ctx.log(`halted ${j.harness.name}: the provider keeps refusing work. Runs that finished are kept; rerun step when it recovers.`);
      return;
    }
    await new Promise((done) => setTimeout(done, Math.min(ctx.backoffMs * 2 ** (throttles - 1), 8 * 60_000)));
  }
}

/** Writes the grading questions for the runs on disk, without running anything. */
export function questions(ctx) {
  if (!ctx.graders.length) throw new UsageError('--graders is required for questions');
  const runs = scopedRuns(ctx);
  const files = writeQuestionFiles(ctx, runs, verdicts(ctx, runs));
  for (const [g, f] of Object.entries(files)) ctx.log(`grader ${g}: ${f.unanswered} of ${f.questions} questions unanswered in ${graderFile(ctx.out, g, 'questions')}`);
  return files;
}

export async function trial(ctx, section, harnessName) {
  const rule = ctx.rules.find((r) => r.section === section);
  if (!rule) throw new UsageError(`no rule ${section}`);
  const harness = ctx.active.find((h) => h.name === harnessName);
  if (!harness) throw new UsageError(`harness ${harnessName} is not available`);
  const { base, head } = ensureBase(ctx.repo, ctx.out);
  ctx.base = base;
  ctx.head = head;
  const dest = join(ctx.out, 'trial', `${sectionSlug(section)}-${harnessName}`);
  rmSync(dest, { recursive: true, force: true });
  let r;
  try {
    r = await executeRun(ctx, harness, rule, 'none', 1, { dest });
  } finally {
    releaseScratch(ctx);
  }
  if (!r.record) {
    if (r.log) writeAtomic(join(dest, 'failed.log'), r.log);
    ctx.log(`trial failed: ${r.failed}`);
    return { failed: r.failed };
  }
  ctx.log(`trial ${section} ${harnessName}: ${r.record.files_changed.length} files changed: ${r.record.files_changed.join(', ')}`);
  ctx.log(`diff at ${join(dest, 'diff.patch')}`);
  return { record: r.record, dest };
}

export function status(ctx) {
  const runs = scopedRuns(ctx);
  const vmap = ctx.graders.length ? verdicts(ctx, runs) : { byRun: new Map(), problems: [] };
  const lines = [];
  for (const rule of ctx.rules) {
    const st = ruleState(ctx, rule, runs, vmap.byRun);
    const tally = ctx.activeNames.map((h) => ARMS.map((a) => {
      const c = st.cells[h][a];
      return c.runs ? `${a} ${c.graded.filter(Boolean).length}/${c.graded.length}${c.runs > c.graded.length ? `+${c.runs - c.graded.length}?` : ''}` : null;
    }).filter(Boolean).join(' ')).map((t, i) => `${ctx.activeNames[i]}: ${t || '-'}`).join(' | ');
    const where = st.state === 'decided' ? `decided ${st.decision}` : st.blocked ? `undecided: ${st.blocked}` : st.pending ? 'waits on grading' : `needs ${st.needs.map((n) => `${n.harness} ${n.arm} x${n.count}`).join(', ')}`;
    lines.push(tally ? `${rule.section} ${where} | ${tally}` : `${rule.section} ${where}`);
  }
  for (const l of lines) ctx.log(l);
  return lines;
}

function harnessRecords(ctx, runs) {
  return ctx.harnesses.map((h) => {
    const model = runs.filter((r) => r.harness === h.name && r.model).map((r) => r.model);
    const models = [...new Set(model)];
    const pins = [...new Set(runs.filter((r) => r.harness === h.name && r.model_pinned).map((r) => r.pin_reason ?? '--model'))];
    const pinned = pins.length > 0 || ctx.models.has(h.name);
    return {
      name: h.name, version: h.version, model: models.length === 1 ? models[0] : models.length ? models.join(' | ') : null, model_pinned: pinned,
      ...(pinned ? { pin_reason: pins.join(' | ') || '--model' } : {}), status: h.status, reason: h.reason,
    };
  });
}

export function finish(ctx) {
  if (!ctx.active.length) throw new UsageError('no harness can run; nothing to decide');
  if (!ctx.graders.length) throw new UsageError('--graders is required for finish');
  const runs = scopedRuns(ctx);
  const vmap = verdicts(ctx, runs);
  if (vmap.problems.length) throw new UsageError(`answers files have ${vmap.problems.length} problems; run status to see them`);
  const calibration = ctx.calibrationFile ? calibrate(ctx, vmap) : null;
  const provisional = provisionalReason(ctx, calibration);
  const undecided = [];
  const rules = [];
  for (const rule of ctx.rules) {
    const st = ruleState(ctx, rule, runs, vmap.byRun);
    if (st.state !== 'decided') {
      undecided.push(rule.section);
      continue;
    }
    const tallies = [];
    for (const h of ctx.activeNames) {
      for (const arm of ARMS) {
        const c = st.cells[h][arm];
        if (c.graded.length) tallies.push({ harness: h, arm, runs: c.graded.length, complied: c.graded.filter(Boolean).length });
      }
    }
    rules.push({
      section: rule.section,
      rule: rule.rule,
      probe: ctx.probes.get(rule.section),
      decision: st.decision,
      provisional: provisional !== null,
      tallies,
      lift: liftOf(st.cells, ctx.activeNames),
      reason: st.reason,
    });
  }
  if (undecided.length) throw new UsageError(`${undecided.length} rules are not decided yet: ${undecided.join(', ')}; run status`);

  const graded = [];
  for (const r of [...runs].sort((a, b) => bySection(a.section, b.section) || a.harness.localeCompare(b.harness) || ARMS.indexOf(a.arm) - ARMS.indexOf(b.arm) || a.run - b.run)) {
    const v = vmap.byRun.get(runKey(r));
    if (v.verdict === null) continue;
    const votes = ctx.graders.filter((g) => v.answers[g]).map((g) => ({ grader: g, complied: v.answers[g].answer, confidence: v.answers[g].confidence }));
    const primary = ctx.graders.map((g) => v.answers[g]).find((a) => a?.answered_by === 'judgment-model');
    graded.push({
      section: r.section, arm: r.arm, harness: r.harness, model: r.model ?? null, model_pinned: Boolean(r.model_pinned), date: r.finished_at, run: r.run,
      complied: v.verdict, grader_confidence: primary?.confidence ?? null, votes,
    });
  }
  const commits = [...new Set(runs.map((r) => baseCommit(ctx, r)))];
  if (commits.length > 1) throw new UsageError(`the runs branched from ${commits.length} commits (${commits.map((c) => c.slice(0, 12)).join(', ')}); one prune.json describes one commit, so finish each in its own --out`);
  const record = {
    standards_path: ctx.standardsPath,
    commit: commits[0],
    sampling: { batch: BATCH, delete_threshold: DELETE_THRESHOLD, keep_margin: KEEP_MARGIN },
    grader: graderRecord(ctx, vmap, runs, calibration),
    provisional,
    harnesses: harnessRecords(ctx, runs),
    rules,
    runs: graded,
  };
  const mismatches = reconcile(record);
  if (mismatches.length) throw new Error(`prune.json tallies do not match its runs: ${mismatches.join('; ')}`);
  writeAtomic(ctx.pruneJson, `${JSON.stringify(record, null, 2)}\n`);
  const table = summaryTable(ctx, record);
  if (ctx.summary) writeAtomic(ctx.summary, table);
  ctx.log(`wrote ${ctx.pruneJson}: ${rules.length} rules, ${graded.length} graded runs`);
  return { record, table };
}

/** Recounts every tally from the graded runs; returns one message per cell that disagrees. */
export function reconcile(record) {
  const out = [];
  for (const rule of record.rules) {
    const seen = new Set();
    for (const t of rule.tallies) {
      seen.add(`${t.harness}|${t.arm}`);
      const mine = record.runs.filter((r) => r.section === rule.section && r.harness === t.harness && r.arm === t.arm);
      const complied = mine.filter((r) => r.complied).length;
      if (mine.length !== t.runs || complied !== t.complied) out.push(`${rule.section} ${t.harness} ${t.arm}: tally ${t.complied}/${t.runs}, runs ${complied}/${mine.length}`);
    }
    for (const r of record.runs.filter((x) => x.section === rule.section)) {
      if (!seen.has(`${r.harness}|${r.arm}`)) out.push(`${rule.section} ${r.harness} ${r.arm}: runs without a tally`);
    }
  }
  return out;
}

/** Why the decisions may change, or null: a requested harness that did not run, or a grader that did not pass calibration. */
function provisionalReason(ctx, calibration) {
  const reasons = [];
  const missing = ctx.harnesses.filter((h) => ctx.requested.includes(h.name) && h.status !== 'ran').map((h) => `${h.name} (${h.reason})`);
  if (missing.length) reasons.push(`Decided on ${ctx.active.length} of ${ctx.requested.length} requested harnesses; did not run: ${missing.join(', ')}. Rerun step and finish with them to confirm.`);
  if (!calibration) reasons.push(`The grader was not calibrated against human labels; pass --calibration with at least ${CALIBRATION_MIN}.`);
  else if (!calibration.passed) reasons.push(`The grader agreed with ${calibration.agreed} of ${calibration.labeled} human labels, under ${CALIBRATION_PASS * 100}%.`);
  return reasons.length ? reasons.join(' ') : null;
}

/** Scores the first grader's answers against the human labels in --calibration. */
export function calibrate(ctx, vmap) {
  const labels = readJsonl(ctx.calibrationFile);
  const first = ctx.graders[0];
  const byId = new Map([...vmap.byRun.values()].map((v) => [v.id, v.answers[first]]));
  const seen = new Set();
  let agreed = 0;
  for (const [i, l] of labels.entries()) {
    const where = `${ctx.calibrationFile}:${i + 1}`;
    if (typeof l?.question_id !== 'string' || typeof l.complies !== 'boolean') throw new UsageError(`${where}: each label needs question_id and a boolean complies`);
    if (seen.has(l.question_id)) throw new UsageError(`${where}: ${l.question_id} is labeled twice`);
    seen.add(l.question_id);
    const answer = byId.get(l.question_id);
    if (!answer) throw new UsageError(`${where}: ${l.question_id} has no answer from ${first}, the grader being calibrated`);
    if (answer.answer === l.complies) agreed++;
  }
  if (labels.length < CALIBRATION_MIN) throw new UsageError(`${ctx.calibrationFile} holds ${labels.length} labels; calibration needs at least ${CALIBRATION_MIN}`);
  const agreement = round(agreed / labels.length);
  return { labeled: labels.length, agreed, agreement, passed: agreed / labels.length >= CALIBRATION_PASS };
}

function graderRecord(ctx, vmap, runs, calibration) {
  const rows = runs.map((r) => vmap.byRun.get(runKey(r)));
  const models = new Set(rows.flatMap((v) => Object.values(v.answers).filter((a) => a?.answered_by === 'judgment-model').map((a) => a.model)));
  const bothAnswered = rows.filter((v) => ctx.graders.length > 1 && v.votes[ctx.graders[0]] !== undefined && v.votes[ctx.graders[1]] !== undefined);
  const agreed = bothAnswered.filter((v) => v.agreed).length;
  const firstAnswers = rows.map((v) => v.answers[ctx.graders[0]]).filter(Boolean);
  const firstByModel = firstAnswers.length > 0 && firstAnswers.every((a) => a.answered_by === 'judgment-model');
  return {
    kind: ctx.graders.length > 1 ? 'consensus' : firstByModel ? 'judgment-model' : 'subagent',
    model: models.size === 1 ? [...models][0] : null,
    calibration,
    ...(ctx.graders.length > 1
      ? {
          consensus: {
            graders: ctx.graders,
            outputs: bothAnswered.length,
            agreed,
            agreement: bothAnswered.length ? round(agreed / bothAnswered.length) : 0,
            tiebroken: rows.filter((v) => v.tiebroken).length,
          },
        }
      : {}),
  };
}

const pct = (n, d) => (d ? `${n}/${d}` : '-');

export function summaryTable(ctx, record) {
  const names = ctx.activeNames;
  const head = ['Rule', ...names.flatMap((h) => ARMS.map((a) => `${h} ${a}`)), 'Lift', 'Decision'];
  const rows = record.rules.map((r) => {
    const cell = (h, a) => {
      const t = r.tallies.find((x) => x.harness === h && x.arm === a);
      return t ? pct(t.complied, t.runs) : '-';
    };
    const chosen = r.decision === 'delete' ? null : r.decision === 'weak' ? 'full' : r.decision;
    const lift = chosen ? r.lift.find((l) => l.harness === 'all' && l.arm === chosen) : null;
    const liftText = lift ? `${lift.lift >= 0 ? '+' : ''}${Math.round(lift.lift * 100)} pts (${chosen})` : r.decision === 'delete' ? 'not measured' : '-';
    return [`${r.section} ${r.rule.slice(0, 60)}${r.rule.length > 60 ? '...' : ''}`, ...names.flatMap((h) => ARMS.map((a) => cell(h, a))), liftText, `${r.decision}${r.provisional ? ' (provisional)' : ''}`];
  });
  const line = (cols) => `| ${cols.join(' | ')} |`;
  // A pinned harness's tallies say nothing about the model its users get by default.
  const pins = record.harnesses.filter((h) => h.model_pinned && names.includes(h.name)).map((h) => `${h.name} ran ${h.model ?? 'an unknown model'}, pinned (${h.pin_reason}), not its default.`);
  return [line(head), line(head.map(() => '---')), ...rows.map(line), ...(pins.length ? ['', ...pins] : [])].join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// CLI

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      standards: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' }, probes: { type: 'string' },
      harnesses: { type: 'string' }, skip: { type: 'string', multiple: true }, sections: { type: 'string' },
      graders: { type: 'string' }, concurrency: { type: 'string' }, 'timeout-min': { type: 'string' }, 'backoff-sec': { type: 'string' },
      env: { type: 'string', multiple: true }, model: { type: 'string', multiple: true }, writable: { type: 'string', multiple: true },
      'prune-json': { type: 'string' }, summary: { type: 'string' }, calibration: { type: 'string' }, 'dry-run': { type: 'boolean' },
      section: { type: 'string' }, harness: { type: 'string' }, 'tmp-root': { type: 'string' },
    },
  });
  const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  return {
    command: positionals[0],
    section: values.section,
    harness: values.harness,
    opts: {
      ...values,
      harnesses: list(values.harnesses),
      sections: list(values.sections),
      graders: list(values.graders),
    },
  };
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h') || !argv.length) {
    console.log(USAGE);
    return 0;
  }
  let parsed;
  try {
    parsed = parse(argv);
  } catch (e) {
    throw new UsageError(`${e.message}\n${USAGE}`);
  }
  const ctx = createContext(parsed.opts);
  switch (parsed.command) {
    case 'plan':
      plan(ctx);
      return 0;
    case 'trial':
      if (!parsed.section || !parsed.harness) throw new UsageError('trial needs --section and --harness');
      return (await trial(ctx, parsed.section, parsed.harness)).failed ? 1 : 0;
    case 'step':
      plan(ctx);
      await step(ctx);
      return 0;
    case 'status':
      status(ctx);
      return 0;
    case 'questions':
      questions(ctx);
      return 0;
    case 'finish':
      finish(ctx);
      return 0;
    default:
      throw new UsageError(USAGE);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`prune: ${e.message}`);
    process.exitCode = 2;
  }
}
