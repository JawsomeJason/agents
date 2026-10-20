import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { git, gitRepo, readJsonl, tempDir, writeJsonl } from './helpers.mjs';
import { loadSchema, validate } from './schema.mjs';

const prune = await import(fileURLToPath(new URL('../skills/standards/scripts/prune.mjs', import.meta.url)));
const { advance, buildPrompt, buildQuestion, siblingContext, siblingPaths, checkAnswers, consensus, createContext, finish, liftOf, loadStandards, readRuns, status, step, trial, trimDiff } = prune;

const H = ['alpha', 'beta'];
/** A cell from a string such as "5/5": that many graded runs, that many complied. */
const cell = (spec) => {
  if (!spec) return { runs: 0, graded: [] };
  const [c, n] = spec.split('/').map(Number);
  return { runs: n, graded: Array.from({ length: n }, (_, i) => i < c) };
};
const cellsOf = (spec) => Object.fromEntries(H.map((h) => [h, {
  none: cell(spec[h]?.none), 'one-liner': cell(spec[h]?.['one-liner']), full: cell(spec[h]?.full),
}]));
const both = (arms) => ({ alpha: arms, beta: arms });

test('advance asks for the first none batch in every harness', () => {
  const r = advance(cellsOf({}), H);
  assert.deepEqual(r.needs, [{ harness: 'alpha', arm: 'none', count: 5 }, { harness: 'beta', arm: 'none', count: 5 }]);
  assert.equal(r.state, 'open');
});

test('advance waits on grading when runs exist without verdicts', () => {
  const cells = cellsOf(both({ none: '5/5' }));
  cells.alpha.none.graded = cells.alpha.none.graded.slice(0, 3);
  const r = advance(cells, H);
  assert.deepEqual(r, { state: 'open', needs: [], pending: true });
});

test('advance runs a second none batch only when every harness complied 5 of 5', () => {
  const r = advance(cellsOf(both({ none: '5/5' })), H);
  assert.deepEqual(r.needs.map((n) => `${n.harness} ${n.arm} ${n.count}`), ['alpha none 5', 'beta none 5']);
  const skipped = advance(cellsOf({ alpha: { none: '5/5' }, beta: { none: '4/5' } }), H);
  assert.deepEqual(skipped.needs.map((n) => `${n.harness} ${n.arm} ${n.count}`), ['alpha one-liner 5', 'beta one-liner 5']);
});

test('advance deletes at 9 of 10 in every harness and not at 8', () => {
  const del = advance(cellsOf({ alpha: { none: '10/10' }, beta: { none: '9/10' } }), H);
  assert.equal(del.decision, 'delete');
  const keep = advance(cellsOf({ alpha: { none: '10/10' }, beta: { none: '8/10' } }), H);
  assert.equal(keep.state, 'open');
  assert.deepEqual(keep.needs.map((n) => n.arm), ['one-liner', 'one-liner']);
});

test('advance keeps the one-liner when it fails at most once in every harness', () => {
  const r = advance(cellsOf({ alpha: { none: '1/5', 'one-liner': '4/5' }, beta: { none: '0/5', 'one-liner': '5/5' } }), H);
  assert.equal(r.decision, 'one-liner');
});

test('advance runs the full arm when the one-liner fails twice, and picks the cheapest within one of the best', () => {
  const start = { alpha: { none: '1/5', 'one-liner': '3/5' }, beta: { none: '0/5', 'one-liner': '5/5' } };
  assert.deepEqual(advance(cellsOf(start), H).needs, [{ harness: 'alpha', arm: 'full', count: 5 }, { harness: 'beta', arm: 'full', count: 5 }]);
  const within = advance(cellsOf({ alpha: { ...start.alpha, full: '4/5' }, beta: { ...start.beta, full: '5/5' } }), H);
  assert.equal(within.decision, 'one-liner', 'one-liner fails 2 and full fails 1, so one-liner is within one failure');
  const better = advance(cellsOf({ alpha: { ...start.alpha, full: '5/5' }, beta: { ...start.beta, full: '5/5' } }), H);
  assert.equal(better.decision, 'full', 'one-liner fails 2 and full fails 0');
});

test('advance marks a rule weak when even the best arm fails more than once', () => {
  const r = advance(cellsOf({
    alpha: { none: '0/5', 'one-liner': '3/5', full: '3/5' },
    beta: { none: '2/5', 'one-liner': '5/5', full: '5/5' },
  }), H);
  assert.equal(r.decision, 'weak');
  assert.match(r.reason, /alpha/);
});

test('consensus: two graders vote and a third breaks a tie', () => {
  const g = ['a', 'b', 'c'];
  assert.deepEqual(consensus({ a: true, b: true }, g), { verdict: true, need: [], agreed: true, tiebroken: false });
  assert.deepEqual(consensus({ a: true }, g), { verdict: null, need: ['b'], agreed: null, tiebroken: false });
  assert.deepEqual(consensus({ a: true, b: false }, g), { verdict: null, need: ['c'], agreed: false, tiebroken: false });
  assert.deepEqual(consensus({ a: true, b: false, c: false }, g), { verdict: false, need: [], agreed: false, tiebroken: true });
  assert.equal(consensus({ a: true, b: false }, ['a', 'b']).unresolved, true);
  assert.equal(consensus({ a: false }, ['a']).verdict, false);
});

test('liftOf is compliance with the rule minus compliance without it', () => {
  const rows = liftOf(cellsOf({ alpha: { none: '1/5', 'one-liner': '4/5' }, beta: { none: '3/5', 'one-liner': '5/5' } }), H);
  assert.deepEqual(rows.map((r) => [r.harness, r.arm, r.lift]), [['alpha', 'one-liner', 0.6], ['beta', 'one-liner', 0.4], ['all', 'one-liner', 0.5]]);
});

test('trimDiff drops test files before source files and says what it left out', () => {
  const src = `diff --git a/a.go b/a.go\n${'+x\n'.repeat(10)}`;
  const tst = `diff --git a/a_test.go b/a_test.go\n${'+y\n'.repeat(10)}`;
  const out = trimDiff(tst + src, src.length + 40);
  assert.ok(out.includes('a.go b/a.go'));
  assert.ok(!out.includes('a_test.go'));
  assert.match(out, /1 more file diffs left out/);
  assert.equal(trimDiff(src, 1000), src);
});

test('trimDiff drops test files of any language first', () => {
  const src = `diff --git a/lib/a.py b/lib/a.py\n${'+x\n'.repeat(10)}`;
  for (const t of ['tests/test_a.py', 'src/a.test.ts', 'spec/a.spec.rb']) {
    const tst = `diff --git a/${t} b/${t}\n${'+y\n'.repeat(10)}`;
    const out = trimDiff(tst + src, src.length + 40);
    assert.ok(out.includes('lib/a.py') && !out.includes(t), t);
  }
});

test('checkAnswers rejects what the answers schema forbids', () => {
  const qs = [{ id: 'aaaaaaaaaaaa#complies' }];
  const good = { question_id: 'aaaaaaaaaaaa#complies', answer: true, confidence: 0.8, answered_by: 'agent' };
  assert.deepEqual(checkAnswers(qs, [good]).problems, []);
  const bad = checkAnswers(qs, [
    { ...good, answer: 'yes' },
    { ...good, question_id: 'zzzzzzzzzzzz#complies' },
    { ...good, confidence: 2 },
    { ...good, answered_by: 'judgment-model' },
  ]);
  assert.deepEqual(bad.problems.map((p) => p.detail), [
    'answer must be true or false', 'answers no question in the questions file', 'has more than one answer', 'has more than one answer',
  ]);
  assert.deepEqual(validate(loadSchema('prune.answers'), { ...good, answered_by: 'judgment-model' }), ['$ is missing model']);
});

// ---------------------------------------------------------------------------------------------
// A whole run against a fake harness

const INDEX = `---
name: x-standards
description: Test standards. Use when testing.
metadata:
  generator: standards
---

# Standards

## §1 Naming

- §1.1 Name every value for what it holds. [§1.1](references/s1-1-names.md) Read first.
- §1.2 Keep files short. [§1.2](references/s1-2-short.md)
`;

function fixture() {
  const repo = gitRepo([{ message: 'init', date: '2026-01-01T00:00:00Z', files: { 'main.txt': 'hello\n' } }]);
  const dir = tempDir();
  const standards = join(dir, 'x-standards');
  mkdirSync(join(standards, 'references'), { recursive: true });
  writeFileSync(join(standards, 'SKILL.md'), INDEX);
  writeFileSync(join(standards, 'references/s1-1-names.md'), '# §1.1 Names\n\nName values for what they hold.\n');
  writeFileSync(join(standards, 'references/s1-2-short.md'), '# §1.2 Short\n\nKeep files short.\n');
  const probes = join(dir, 'probes.json');
  writeFileSync(probes, JSON.stringify([{ section: '§1.1', probe: 'Add a greeting.' }, { section: '§1.2', probe: 'Add a farewell.' }]));
  return { repo, dir, standards, probes, out: join(dir, 'out') };
}

/** An agent that follows a rule only when its prompt carries one, and fails when asked to. */
const fakeAdapter = (mode = 'rule') => ({
  command: 'sh',
  auth: () => null,
  prepare({ wt, prompt }) {
    const follows = prompt.includes('Project rule:');
    const line = mode === 'idle' ? '' : follows ? 'OK-named' : 'VIOLATION-named';
    return { argv: ['-c', line ? `echo ${line} >> ${wt}/main.txt` : 'true'], env: {} };
  },
  collect: () => ({ message: 'done', model: 'fake-model-1', usage: null }),
});

function context(fx, mode, extra = {}) {
  const logs = [];
  const ctx = createContext({
    standards: fx.standards, repo: fx.repo, out: fx.out, probes: fx.probes, harnesses: ['fake'], graders: ['a', 'b'],
    concurrency: 2, 'prune-json': join(fx.out, 'prune.json'), log: (s) => logs.push(s), ...extra,
  }, { fake: fakeAdapter(mode) });
  ctx.logs = logs;
  return ctx;
}

/** Answers every question in a grader's file: yes when the diff holds the compliant marker. */
function answerAll(fx, grader, flip = () => false) {
  const qs = readJsonl(join(fx.out, 'grading', `${grader}.questions.jsonl`));
  const rows = qs.map((q) => ({ question_id: q.id, answer: q.state.includes('OK-named') !== flip(q), confidence: 0.9, answered_by: 'agent' }));
  writeJsonl(join(fx.out, 'grading', `${grader}.answers.jsonl`), rows);
  return qs;
}

test('loadStandards reads the index and rejects a link to a missing file', () => {
  const fx = fixture();
  const rules = loadStandards(fx.standards);
  assert.deepEqual(rules.map((r) => [r.section, r.rule, r.readFirst]), [['§1.1', 'Name every value for what it holds.', true], ['§1.2', 'Keep files short.', false]]);
  assert.equal(buildPrompt('none', rules[0], 'P'), 'P');
  assert.equal(buildPrompt('one-liner', rules[0], 'P'), 'Project rule: Name every value for what it holds.\n\nP');
  assert.equal(buildPrompt('full', rules[0], 'P'), `Project rule: ${rules[0].text}\n\nP`);
  writeFileSync(join(fx.standards, 'SKILL.md'), INDEX.replace('s1-2-short', 's1-9-gone'));
  assert.throws(() => loadStandards(fx.standards), /does not exist/);
});

test('a severity tag on an index line stays out of the rule text the arms and the grader see', () => {
  const fx = fixture();
  writeFileSync(join(fx.standards, 'SKILL.md'), INDEX.replace('Keep files short. [§1.2]', 'Keep files short. (nit) [§1.2]'));
  const rule = loadStandards(fx.standards).find((r) => r.section === '§1.2');
  assert.deepEqual([rule.rule, rule.severity], ['Keep files short.', 'nit']);
  assert.equal(buildPrompt('one-liner', rule, 'P'), 'Project rule: Keep files short.\n\nP');
  assert.equal(buildQuestion(rule, { section: '§1.2', harness: 'h', arm: 'none', run: 1 }, 'diff').prompt, 'Does this output follow this rule: Keep files short.');
});

test('a numeric option that is not a whole number is a usage error, not a silent run of nothing', () => {
  const fx = fixture();
  for (const [name, value] of [['concurrency', 'three'], ['concurrency', '0'], ['timeout-min', 'x'], ['backoff-sec', '-1']]) {
    assert.throws(() => context(fx, 'rule', { [name]: value }), new RegExp(`--${name} must be a whole number`), `${name}=${value}`);
  }
  assert.equal(context(fx, 'rule', { 'backoff-sec': '0' }).backoffMs, 0);
});

test('plan prints the fewest runs any path through the sampling takes', () => {
  const fx = fixture();
  const ctx = context(fx);
  assert.deepEqual(prune.plan(ctx), { rules: 2, harnesses: 1, most: 40, fewest: 20 });
  assert.match(ctx.logs[1], /Fewest: 20 \(none 10, or none 5 and one-liner 5\)\./);
});

test('a probe set must cover every rule', () => {
  const fx = fixture();
  writeFileSync(fx.probes, JSON.stringify([{ section: '§1.1', probe: 'Add a greeting.' }]));
  assert.throws(() => createContext({ standards: fx.standards, repo: fx.repo, out: fx.out, probes: fx.probes }, { fake: fakeAdapter() }), /no probe for §1.2/);
});

test('step, grading and finish converge on a decision, and a rerun changes nothing', async () => {
  const fx = fixture();
  let ctx = context(fx);

  await step(ctx);
  assert.equal(readRuns(fx.out).length, 10, 'none arm: 5 runs for each of 2 rules');
  assert.ok(readRuns(fx.out).every((r) => r.arm === 'none' && r.model === 'fake-model-1'));
  const qs = readJsonl(join(fx.out, 'grading', 'a.questions.jsonl'));
  assert.equal(qs.length, 10);
  for (const q of qs) assert.deepEqual(validate(loadSchema('prune.questions'), q), []);
  assert.ok(qs.every((q) => !/none|one-liner|full|fake/.test(q.id)), 'ids do not reveal the arm or harness');
  assert.deepEqual(qs.map((q) => q.id), qs.map((q) => q.id).sort(), 'questions are in id order, not grouped by rule or arm');
  assert.notDeepEqual(qs.map((q) => q.section), qs.map((q) => q.section).sort(), 'the order mixes the rules');

  ctx = context(fx);
  await step(ctx);
  assert.equal(readRuns(fx.out).length, 10, 'nothing new runs while the outputs await grading');
  assert.match(ctx.logs.join('\n'), /0 runs to do, 2 rules waiting on grading/);

  answerAll(fx, 'a');
  answerAll(fx, 'b');
  ctx = context(fx);
  await step(ctx);
  assert.equal(readRuns(fx.out).filter((r) => r.arm === 'one-liner').length, 10, 'none complied 0 of 5, so one-liner runs next');

  answerAll(fx, 'a');
  answerAll(fx, 'b');
  ctx = context(fx);
  const before = readRuns(fx.out).length;
  await step(ctx);
  assert.equal(readRuns(fx.out).length, before, 'both rules are decided, so step runs nothing');
  assert.match(ctx.logs.join('\n'), /2 rules decided, 0 runs to do/);

  const { record } = finish(ctx);
  assert.deepEqual(validate(loadSchema('prune'), record), []);
  assert.deepEqual(record.rules.map((r) => [r.section, r.decision, r.provisional]), [['§1.1', 'one-liner', true], ['§1.2', 'one-liner', true]]);
  assert.equal(record.provisional, 'The grader was not calibrated against human labels; pass --calibration with at least 30.', 'the one requested harness ran, but a consensus is not a calibration');
  assert.deepEqual(record.rules[0].tallies, [
    { harness: 'fake', arm: 'none', runs: 5, complied: 0 },
    { harness: 'fake', arm: 'one-liner', runs: 5, complied: 5 },
  ]);
  assert.deepEqual(record.rules[0].lift, [{ harness: 'fake', arm: 'one-liner', none: 0, with: 1, lift: 1 }, { harness: 'all', arm: 'one-liner', none: 0, with: 1, lift: 1 }]);
  assert.equal(record.grader.kind, 'consensus');
  assert.deepEqual(record.grader.consensus, { graders: ['a', 'b'], outputs: 20, agreed: 20, agreement: 1, tiebroken: 0 });
  assert.equal(record.grader.calibration, null);
  assert.equal(record.harnesses[0].model, 'fake-model-1');
  assert.equal(record.runs.length, 20);
  for (const run of readRuns(fx.out)) {
    const { dir, ...rest } = run;
    assert.deepEqual(validate(loadSchema('prune.run'), rest), []);
    assert.match(readFileSync(join(dir, 'diff.patch'), 'utf8'), /named/);
  }

  const first = readFileSync(join(fx.out, 'prune.json'), 'utf8');
  finish(context(fx));
  assert.equal(readFileSync(join(fx.out, 'prune.json'), 'utf8'), first, 'finish is idempotent');
});

test('advance decides nothing when no harness ran', () => {
  assert.deepEqual(advance({}, []), { state: 'open', needs: [], pending: false, blocked: 'no harness ran' });
});

test('with the only requested harness skipped, status leaves every rule undecided and finish writes nothing', () => {
  const fx = fixture();
  const ctx = context(fx, 'rule', { skip: ['fake:not logged in'] });
  assert.deepEqual(ctx.activeNames, []);
  status(ctx);
  assert.deepEqual(ctx.logs, ['§1.1 undecided: no harness ran', '§1.2 undecided: no harness ran']);
  assert.throws(() => finish(ctx), /no harness can run; nothing to decide/);
  assert.equal(existsSync(join(fx.out, 'prune.json')), false);
});

/** Steps and answers until every scoped rule is decided, then finishes. */
async function runToDecision(fx, makeCtx) {
  for (let i = 0; i < 4; i++) {
    await step(makeCtx());
    for (const g of makeCtx().graders) answerAll(fx, g);
  }
  return finish(makeCtx()).record;
}

test('a rule decided on fewer harnesses than were requested is provisional', async () => {
  const fx = fixture();
  const adapters = { fake: fakeAdapter(), other: fakeAdapter() };
  const makeCtx = () => createContext({
    standards: fx.standards, repo: fx.repo, out: fx.out, probes: fx.probes, harnesses: ['fake', 'other'], skip: ['other:not logged in'],
    graders: ['a', 'b'], sections: ['§1.1'], 'prune-json': join(fx.out, 'prune.json'), log: () => {},
  }, adapters);
  const record = await runToDecision(fx, makeCtx);
  assert.deepEqual(record.rules.map((r) => [r.section, r.decision, r.provisional]), [['§1.1', 'one-liner', true]]);
  assert.match(record.provisional, /^Decided on 1 of 2 harnesses; did not run: other \(not logged in\)/);
  assert.deepEqual(validate(loadSchema('prune'), record), []);
});

test('a harness left out of --harnesses keeps the decision provisional when it is installed and logged in', async () => {
  const fx = fixture();
  const adapters = { fake: fakeAdapter(), other: fakeAdapter(), absent: { ...fakeAdapter(), command: 'no-such-harness-on-path' } };
  const makeCtx = () => createContext({
    standards: fx.standards, repo: fx.repo, out: fx.out, probes: fx.probes, harnesses: ['fake'],
    graders: ['a', 'b'], sections: ['§1.1'], 'prune-json': join(fx.out, 'prune.json'), log: () => {},
  }, adapters);
  const record = await runToDecision(fx, makeCtx);
  assert.deepEqual(record.rules.map((r) => [r.section, r.provisional]), [['§1.1', true]]);
  assert.match(record.provisional, /^Decided on 1 of 2 harnesses; did not run: other \(not requested\)\. /, 'a harness that is not installed does not count');
});

test('a split between the first two graders goes to the tiebreaker', async () => {
  const fx = fixture();
  let ctx = context(fx, 'rule', { graders: ['a', 'b', 'c'], sections: ['§1.1'] });
  await step(ctx);
  const qs = answerAll(fx, 'a');
  answerAll(fx, 'b', (q) => q.id === qs[0].id);
  ctx = context(fx, 'rule', { graders: ['a', 'b', 'c'], sections: ['§1.1'] });
  await step(ctx);
  const tie = readJsonl(join(fx.out, 'grading', 'c.questions.jsonl'));
  assert.deepEqual(tie.map((q) => q.id), [qs[0].id], 'only the split output reaches the tiebreaker');
  writeJsonl(join(fx.out, 'grading', 'c.answers.jsonl'), [{ question_id: qs[0].id, answer: false, confidence: 0.7, answered_by: 'agent' }]);
  const split = [...prune.verdicts(ctx, readRuns(fx.out)).byRun.values()].find((v) => v.id === qs[0].id);
  assert.deepEqual([split.verdict, split.tiebroken, split.agreed], [false, true, false]);
  status(ctx);
  assert.match(ctx.logs.at(-1), /^§1\.1 needs fake one-liner x5 \| fake: none 0\/5$/, 'the tiebroken output counts as graded, so the none batch is complete');
});

test('a harness that changes nothing is retried, logged and does not hang the step', async () => {
  const fx = fixture();
  const ctx = context(fx, 'idle', { sections: ['§1.1'], concurrency: 1 });
  await step(ctx);
  assert.equal(readRuns(fx.out).length, 0);
  const failures = readJsonl(join(fx.out, 'failures.jsonl'));
  assert.equal(failures.length, 15, '5 runs, 3 attempts each');
  assert.match(failures[0].reason, /no changes/);
});

test('a trial keeps its output apart from the counted runs', async () => {
  const fx = fixture();
  const ctx = context(fx);
  const r = await trial(ctx, '§1.1', 'fake');
  assert.ok(existsSync(join(r.dest, 'diff.patch')));
  assert.equal(readRuns(fx.out).length, 0);
  assert.ok(r.dest.includes('trial'));
});

test('worktrees hold only the checkout: no remote, one commit, and the standards folder removed', async () => {
  const fx = fixture();
  git(fx.repo, ['config', 'user.email', 'a@b.c']);
  const nested = join(fx.repo, 'x-standards');
  mkdirSync(nested);
  writeFileSync(join(nested, 'SKILL.md'), INDEX);
  mkdirSync(join(nested, 'references'));
  writeFileSync(join(nested, 'references/s1-1-names.md'), '# §1.1\n');
  writeFileSync(join(nested, 'references/s1-2-short.md'), '# §1.2\n');
  git(fx.repo, ['add', '-A']);
  git(fx.repo, ['commit', '-q', '-m', 'add standards']);
  const ctx = context(fx, 'rule', { standards: nested, sections: ['§1.1'] });
  assert.equal(ctx.standardsRel, 'x-standards');
  const adapter = fakeAdapter();
  let seen = null;
  adapter.prepare = ({ wt, prompt }) => {
    seen = { wt, standards: existsSync(join(wt, 'x-standards')), prompt };
    return { argv: ['-c', `git -C ${wt} remote | wc -l | tr -d " " > ${wt}/remotes.txt; git -C ${wt} rev-list --all | wc -l | tr -d " " > ${wt}/commits.txt; echo "pwd=$PWD" > ${wt}/pwd.txt`], env: {} };
  };
  const ctx2 = createContext({ standards: nested, repo: fx.repo, out: fx.out, probes: fx.probes, harnesses: ['fake'], graders: ['a'], sections: ['§1.1'], log: () => {} }, { fake: adapter });
  const r = await trial(ctx2, '§1.1', 'fake');
  assert.equal(seen.standards, false);
  const diff = readFileSync(join(r.dest, 'diff.patch'), 'utf8');
  assert.match(diff, /\+0\n/, 'no remote');
  assert.match(diff, /\+1\n/, 'one commit');
  assert.ok(diff.includes(`+pwd=${seen.wt}\n`), 'the agent starts in its worktree, not the directory the runner started in');
});

test('with the standards committed in the repo, an idle run and a run that only writes the standards folder both fail as no changes', async () => {
  const fx = fixture();
  const nested = join(fx.repo, 'x-standards');
  mkdirSync(join(nested, 'references'), { recursive: true });
  writeFileSync(join(nested, 'SKILL.md'), INDEX);
  writeFileSync(join(nested, 'references/s1-1-names.md'), '# §1.1\n');
  writeFileSync(join(nested, 'references/s1-2-short.md'), '# §1.2\n');
  git(fx.repo, ['add', '-A']);
  git(fx.repo, ['commit', '-q', '-m', 'add standards']);
  for (const script of ['true', 'mkdir -p x-standards && echo note > x-standards/NOTES.md']) {
    const adapter = { ...fakeAdapter(), prepare: () => ({ argv: ['-c', script], env: {} }) };
    const ctx = createContext({ standards: nested, repo: fx.repo, out: join(fx.dir, `out-${script.length}`), probes: fx.probes, harnesses: ['fake'], graders: ['a'], log: () => {} }, { fake: adapter });
    const r = await trial(ctx, '§1.1', 'fake');
    assert.match(r.failed ?? '', /^no changes/, script);
  }
});

test('a run lost mid-step leaves a gap, and the next step numbers after the highest run instead of overwriting one', async () => {
  const fx = fixture();
  await step(context(fx));
  const runs = readRuns(fx.out).filter((r) => r.section === '§1.1');
  const lost = runs.find((r) => r.run === 2);
  rmSync(lost.dir, { recursive: true });
  const kept = readRuns(fx.out).filter((r) => r.section === '§1.1').map((r) => [r.run, r.finished_at]);
  await step(context(fx));
  const after = readRuns(fx.out).filter((r) => r.section === '§1.1');
  assert.deepEqual(after.map((r) => r.run).sort(), [1, 3, 4, 5, 6]);
  for (const [n, at] of kept) assert.equal(after.find((r) => r.run === n).finished_at, at, `run ${n} was left alone`);
});

test('a scoped step ignores the runs of rules outside its scope', async () => {
  const fx = fixture();
  await step(context(fx));
  assert.equal(readRuns(fx.out).length, 10);
  const scoped = context(fx, 'rule', { sections: ['§1.2'] });
  await step(scoped);
  assert.equal(readJsonl(join(fx.out, 'grading', 'a.questions.jsonl')).length, 5, 'only the scoped rule is asked about');
  assert.equal(prune.scopedRuns(scoped).length, 5);
});

test('a provider that keeps refusing halts its harness and the step ends', async () => {
  const fx = fixture();
  const adapter = fakeAdapter();
  const ok = adapter.prepare;
  let calls = 0;
  adapter.prepare = (a) => (++calls <= 99 ? { argv: ['-c', 'echo \'{"type":"error","status":429,"message":"Rate limit exceeded"}\'; exit 1'], env: {} } : ok(a));
  const ctx = createContext({ standards: fx.standards, repo: fx.repo, out: fx.out, probes: fx.probes, harnesses: ['fake'], graders: ['a'], sections: ['§1.1'], concurrency: 1, 'backoff-sec': '0', log: () => {} }, { fake: adapter });
  ctx.backoffMs = 0;
  await step(ctx);
  const failures = readJsonl(join(fx.out, 'failures.jsonl'));
  assert.deepEqual([...new Set(failures.map((f) => f.kind))], ['throttled']);
  assert.equal(failures.length, 4, 'one try and three waited retries, then the harness halts');
  assert.ok(ctx.halted.has('fake'));
  assert.equal(readRuns(fx.out).length, 0, 'a halted harness runs nothing more');
});

/** A claude-shaped agent whose transcript quotes a repo file that mentions a rate limit, then ends with tail. */
function quotingAgent(tail) {
  const event = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'api/client.go: return fmt.Errorf("API rate limit exceeded")' }] } });
  return {
    command: 'sh',
    auth: () => null,
    prepare: ({ wt }) => ({ argv: ['-c', `printf '%s\\n' '${event}'; echo x >> ${wt}/main.txt; ${tail}`], env: {} }),
    errorText: prune.ADAPTERS.claude.errorText,
    collect: prune.ADAPTERS.claude.collect,
  };
}

for (const [how, tail, timeoutMs, want] of [
  ['exits 1', 'exit 1', null, /^exit 1 with no message/],
  ['times out', 'sleep 5', 300, /^timed out after/],
  ['ends on a 429 result', `echo '{"type":"result","is_error":true,"api_error_status":429,"result":"API Error: 429 rate_limit_error"}'; exit 1`, null, /^throttled: .*429/],
]) {
  test(`a claude run whose transcript quotes "rate limit" and ${how} is ${String(want).includes('throttled') ? '' : 'not '}throttled`, async () => {
    const fx = fixture();
    const ctx = createContext({ standards: fx.standards, repo: fx.repo, out: fx.out, probes: fx.probes, harnesses: ['c'], graders: ['a'], log: () => {} }, { c: quotingAgent(tail) });
    if (timeoutMs) ctx.timeoutMs = timeoutMs;
    const r = await trial(ctx, '§1.1', 'c');
    assert.match(r.failed, want);
  });
}

test('questions writes the grading files for the runs on disk and runs nothing', async () => {
  const fx = fixture();
  await step(context(fx, 'rule', { sections: ['§1.1'] }));
  rmSync(join(fx.out, 'grading'), { recursive: true });
  const files = prune.questions(context(fx, 'idle', { sections: ['§1.1'] }));
  assert.deepEqual(files.a, { questions: 5, unanswered: 5 });
  assert.equal(readRuns(fx.out).length, 5);
});

test('a harness the caller did not name is recorded as skipped, with the caller\'s reason or not requested', () => {
  const fx = fixture();
  const adapters = { fake: fakeAdapter(), other: fakeAdapter() };
  const ctx = createContext({ standards: fx.standards, repo: fx.repo, out: fx.out, probes: fx.probes, harnesses: ['fake'], skip: ['third:waiting'], graders: ['a'], log: () => {} }, { ...adapters, third: fakeAdapter() });
  const byName = Object.fromEntries(ctx.harnesses.map((h) => [h.name, [h.status, h.reason]]));
  assert.deepEqual(byName, { other: ['skipped', 'not requested'], third: ['skipped', 'waiting'], fake: ['ran', null] });
  assert.deepEqual(ctx.activeNames, ['fake']);
});

test('siblingPaths puts rule-named files first, then same-directory, sibling-directory and same-named files, never tests or changed files', () => {
  const tree = [
    'pkg/cmd/ssh-key/list/list.go', 'pkg/cmd/ssh-key/list/list_test.go', 'pkg/cmd/ssh-key/list/http.go',
    'pkg/cmd/ssh-key/add/add.go', 'pkg/cmd/pr/list/list.go', 'pkg/cmd/issue/list/list.go', 'pkg/iostreams/color.go', 'README.md',
  ];
  const got = siblingPaths(tree, 'Heuristic: `pkg/iostreams/color.go` marks it; `missing/file.go` is not in the repo.', ['pkg/cmd/ssh-key/list/list.go', 'pkg/cmd/ssh-key/list/list_test.go']);
  assert.deepEqual(got, ['pkg/iostreams/color.go', 'pkg/cmd/ssh-key/list/http.go', 'pkg/cmd/ssh-key/add/add.go', 'pkg/cmd/issue/list/list.go', 'pkg/cmd/pr/list/list.go']);
});

test('a grading question carries the sibling files as they stood before the change', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'cmd/a'), { recursive: true });
  mkdirSync(join(dir, 'cmd/b'), { recursive: true });
  writeFileSync(join(dir, 'cmd/a/list.go'), 'package a\n');
  writeFileSync(join(dir, 'cmd/b/list.go'), 'package b // SIBLING-MARK\n');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  const head = git(dir, ['rev-parse', 'HEAD']).trim();
  const siblings = siblingContext(dir, head, 'Match the sibling.', ['cmd/a/list.go']);
  assert.match(siblings, /--- cmd\/b\/list\.go\npackage b \/\/ SIBLING-MARK/);
  const rule = { section: '§1.2', rule: 'Match the sibling.', text: 'Match the sibling.' };
  const run = { section: '§1.2', harness: 'h', arm: 'none', run: 1 };
  assert.match(buildQuestion(rule, run, 'diff --git a/x b/x\n', siblings).state, /SIBLING-MARK/);
  assert.doesNotMatch(buildQuestion(rule, run, 'diff --git a/x b/x\n').state, /siblings/);
});

test('a pinned model reaches the harness and is recorded in the runs and prune.json', async () => {
  const fx = fixture();
  const adapter = fakeAdapter('rule');
  let seen = null;
  const prepare = adapter.prepare;
  adapter.prepare = (a) => { seen = a.model; return prepare(a); };
  const ctx = createContext({
    standards: fx.standards, repo: fx.repo, out: fx.out, probes: fx.probes, harnesses: ['fake'], model: ['fake=pinned-model-9'], graders: ['a', 'b'],
    sections: ['§1.1'], concurrency: 2, 'prune-json': join(fx.out, 'prune.json'), log: () => {},
  }, { fake: adapter });
  await step(ctx);
  assert.equal(seen, 'pinned-model-9');
  assert.ok(readRuns(fx.out).every((r) => r.model_pinned === true));
  answerAll(fx, 'a');
  answerAll(fx, 'b');
  await step(ctx);
  answerAll(fx, 'a');
  answerAll(fx, 'b');
  const { record } = finish(ctx);
  assert.equal(record.harnesses[0].model_pinned, true);
  assert.ok(record.runs.every((r) => r.model_pinned === true));
  assert.deepEqual(validate(loadSchema('prune'), record), []);
  assert.throws(() => createContext({ standards: fx.standards, repo: fx.repo, out: fx.out, probes: fx.probes, model: ['nope=x'], log: () => {} }, { fake: adapter }), /no known harness/);
});

// ---------------------------------------------------------------------------------------------
// Login copies never outlive the process

const PRUNE = fileURLToPath(new URL('../skills/standards/scripts/prune.mjs', import.meta.url));

/** Runs a trial in a child process whose fake agent copies a login, then waits; returns once the agent is running. */
function childTrial(fx, how) {
  const tmpRoot = join(fx.dir, 'tmp-root');
  mkdirSync(tmpRoot);
  const pidFile = join(fx.dir, 'agent.pid');
  const script = join(fx.dir, 'child.mjs');
  writeFileSync(script, `
    import { writeFileSync, statSync } from 'node:fs';
    import { join } from 'node:path';
    const { createContext, trial } = await import(${JSON.stringify(PRUNE)});
    const agent = {
      command: 'sh',
      auth: () => null,
      prepare({ tmp, scratch, wt }) {
        writeFileSync(join(tmp, 'auth.json'), 'SECRET\\n', { mode: 0o600 });
        writeFileSync(${JSON.stringify(join(fx.dir, 'scratch-mode'))}, (statSync(scratch).mode & 0o777).toString(8));
        if (${JSON.stringify(how)} === 'throw') setTimeout(() => { throw new Error('boom'); }, 500);
        return { argv: ['-c', 'echo $$ > ${pidFile}; exec sleep 30'], env: {} };
      },
      collect: () => ({ message: 'done', model: 'm', usage: null }),
    };
    const ctx = createContext({ standards: ${JSON.stringify(fx.standards)}, repo: ${JSON.stringify(fx.repo)}, out: ${JSON.stringify(fx.out)}, probes: ${JSON.stringify(fx.probes)}, harnesses: ['fake'], graders: ['a'], 'tmp-root': ${JSON.stringify(tmpRoot)}, log: () => {} }, { fake: agent });
    await trial(ctx, '§1.1', 'fake');
  `);
  const child = spawn(process.execPath, [script], { stdio: 'ignore' });
  const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
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
  return { child, exited, started, tmpRoot };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`${signal} removes the private scratch with its login copy and kills the agent`, async () => {
    const fx = fixture();
    const { child, exited, started, tmpRoot } = childTrial(fx, 'wait');
    const agentPid = await started;
    const [scratch] = readdirSync(tmpRoot);
    assert.match(scratch, /^standards-prune-/);
    assert.equal(readFileSync(join(fx.dir, 'scratch-mode'), 'utf8'), '700', 'only the owner can read the scratch');
    child.kill(signal);
    assert.deepEqual(await exited, { code: null, signal });
    assert.deepEqual(readdirSync(tmpRoot), [], 'nothing is left under the temp root');
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(alive(agentPid), false, 'the agent died with the runner');
  });
}

test('an agent dies when its runner is killed with no chance to clean up', async () => {
  const fx = fixture();
  const { child, exited, started } = childTrial(fx, 'wait');
  const agentPid = await started;
  child.kill('SIGKILL');
  await exited;
  const deadline = Date.now() + 3000;
  while (alive(agentPid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
  assert.equal(alive(agentPid), false, 'the watchdog killed the orphaned agent');
});

test('an agent dies at its timeout even when the runner timer never fires', async () => {
  const dir = tempDir();
  const pidFile = join(dir, 'pid');
  const script = join(dir, 'blocked.mjs');
  // The runner starts the agent, then blocks its own event loop, so its timer cannot fire.
  writeFileSync(script, `
    import { existsSync } from 'node:fs';
    const { spawnGuarded } = await import(${JSON.stringify(PRUNE)});
    spawnGuarded('sh', ['-c', 'echo $$ > ${pidFile}; exec sleep 30'], { cwd: ${JSON.stringify(dir)}, env: process.env, timeoutMs: 100 });
    while (!existsSync(${JSON.stringify(pidFile)})) await new Promise((done) => setTimeout(done, 10));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
  `);
  const runner = spawn(process.execPath, [script], { stdio: 'ignore' });
  while (!existsSync(pidFile) || !readFileSync(pidFile, 'utf8').trim()) await new Promise((done) => setTimeout(done, 20));
  const agentPid = Number(readFileSync(pidFile, 'utf8'));
  const deadline = Date.now() + 4500;
  while (alive(agentPid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
  const agentAlive = alive(agentPid);
  const runnerAlive = alive(runner.pid);
  runner.kill('SIGKILL');
  assert.equal(runnerAlive, true, 'the runner was still blocked');
  assert.equal(agentAlive, false, 'the watchdog killed the agent at its own timeout');
});

test('an uncaught error removes the private scratch with its login copy', async () => {
  const fx = fixture();
  const { exited, started, tmpRoot } = childTrial(fx, 'throw');
  const agentPid = await started;
  assert.equal((await exited).code, 1);
  assert.deepEqual(readdirSync(tmpRoot), []);
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(alive(agentPid), false);
});

test('a finished trial leaves nothing under the temp root', async () => {
  const fx = fixture();
  const tmpRoot = join(fx.dir, 'tmp-root');
  mkdirSync(tmpRoot);
  await trial(context(fx, 'rule', { 'tmp-root': tmpRoot }), '§1.1', 'fake');
  assert.deepEqual(readdirSync(tmpRoot), []);
});

/** Every file path under a folder. */
const filesUnder = (dir) => readdirSync(dir, { recursive: true }).map((p) => join(dir, p)).filter((p) => statSync(p).isFile());

test('with CLAUDE_CODE_OAUTH_TOKEN set, the claude adapter passes the token in its environment and writes no login file', () => {
  const dir = tempDir();
  const tmp = join(dir, 'run');
  mkdirSync(tmp);
  const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-FAKE';
  try {
    assert.equal(prune.ADAPTERS.claude.auth(), null);
    const { env } = prune.ADAPTERS.claude.prepare({ tmp, scratch: dir, prompt: 'P', model: null });
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'tok-FAKE');
    assert.equal(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
    assert.equal(env.CLAUDE_CONFIG_DIR, join(tmp, 'claude'), 'a config folder per run, removed with the run');
    assert.deepEqual(filesUnder(dir).filter((f) => readFileSync(f, 'utf8').includes('tok-FAKE')), []);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
  }
});

test('without a token, the claude adapter writes the login once per process into the private scratch, owner-only', () => {
  const dir = tempDir();
  const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  prune.ADAPTERS.claude.creds = '{"fake":true}';
  try {
    for (const n of [1, 2]) {
      const tmp = join(dir, `run${n}`);
      mkdirSync(tmp);
      const { env } = prune.ADAPTERS.claude.prepare({ tmp, scratch: dir, prompt: 'P', model: null });
      assert.equal(env.CLAUDE_CONFIG_DIR, join(dir, 'claude'));
    }
    assert.equal(statSync(join(dir, 'claude')).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'claude/.credentials.json')).mode & 0o777, 0o600);
  } finally {
    delete prune.ADAPTERS.claude.creds;
    if (saved !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
  }
});

test('an agent gets only the allowlisted environment, never the caller\'s tokens and keys', async () => {
  const fx = fixture();
  const planted = { GH_TOKEN: 'ghp_FAKE', AWS_SECRET_ACCESS_KEY: 'aws_FAKE', SOME_API_KEY: 'key_FAKE', LC_CTYPE: 'C' };
  const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
  Object.assign(process.env, planted);
  try {
    const adapter = { ...fakeAdapter(), prepare: ({ wt }) => ({ argv: ['-c', `env | sort > ${wt}/env.txt`], env: { ADAPTER_LOGIN: 'mine' } }) };
    const ctx = createContext({ standards: fx.standards, repo: fx.repo, out: fx.out, probes: fx.probes, harnesses: ['fake'], graders: ['a'], env: ['EXTRA=1'], log: () => {} }, { fake: adapter });
    const r = await trial(ctx, '§1.1', 'fake');
    const names = readFileSync(join(r.dest, 'diff.patch'), 'utf8').split('\n').filter((l) => /^\+[A-Z_]+=/.test(l)).map((l) => l.slice(1, l.indexOf('=')));
    assert.ok(!names.includes('GH_TOKEN') && !names.includes('AWS_SECRET_ACCESS_KEY') && !names.includes('SOME_API_KEY'), names.join(' '));
    for (const k of ['PATH', 'LC_CTYPE', 'ADAPTER_LOGIN', 'EXTRA', 'PWD']) assert.ok(names.includes(k), `${k} reaches the agent`);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('the claude adapter turns off account skills, plugins, commands and tool servers, and reads what its session loaded', () => {
  const dir = tempDir();
  const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-FAKE';
  try {
    const { argv } = prune.ADAPTERS.claude.prepare({ tmp: dir, scratch: dir, prompt: 'P', model: null });
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
    assert.deepEqual(settings, { syncClaudeAiSkills: false, syncClaudeAiPlugins: false });
    for (const flag of ['--disable-slash-commands', '--strict-mcp-config']) assert.ok(argv.includes(flag), flag);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
  }
  const stdout = [
    { type: 'system', subtype: 'init', skills: ['debug'], plugins: [{ name: 'p1', path: '/x' }], mcp_servers: [] },
    { type: 'assistant', message: {} },
    { type: 'result', result: 'all done', modelUsage: { 'model-a': {} }, usage: { input_tokens: 3 } },
  ].map((e) => JSON.stringify(e)).join('\n');
  assert.deepEqual(prune.ADAPTERS.claude.collect({ stdout }), {
    message: 'all done', model: 'model-a', usage: { input_tokens: 3 }, loaded: { skills: ['debug'], plugins: ['p1'], mcp_servers: [] },
  });
});

test('a run records what its session reported loading', async () => {
  const fx = fixture();
  const adapter = { ...fakeAdapter(), collect: () => ({ message: 'done', model: 'm', usage: null, loaded: { skills: [], plugins: [], mcp_servers: [] } }) };
  const ctx = createContext({ standards: fx.standards, repo: fx.repo, out: fx.out, probes: fx.probes, harnesses: ['fake'], graders: ['a'], log: () => {} }, { fake: adapter });
  const { record } = await trial(ctx, '§1.1', 'fake');
  assert.deepEqual(record.loaded, { skills: [], plugins: [], mcp_servers: [] });
  assert.deepEqual(validate(loadSchema('prune.run'), record), []);
});

test('a redone run, an edited § or a rewritten probe gets a new question id, so an old verdict never carries over', async () => {
  const fx = fixture();
  await step(context(fx, 'rule', { sections: ['§1.1'] }));
  answerAll(fx, 'a');
  answerAll(fx, 'b');
  const before = prune.verdicts(context(fx, 'rule', { sections: ['§1.1'] }), readRuns(fx.out));
  assert.equal([...before.byRun.values()].filter((v) => v.verdict !== null).length, 5);

  const redone = readRuns(fx.out).find((r) => r.run === 1);
  writeFileSync(join(redone.dir, 'diff.patch'), 'diff --git a/main.txt b/main.txt\n+OK-named\n');
  const { dir, diff_sha256: _old, ...record } = redone;
  writeFileSync(join(dir, 'run.json'), JSON.stringify(record));
  const after = prune.verdicts(context(fx, 'rule', { sections: ['§1.1'] }), readRuns(fx.out));
  assert.equal(after.byRun.get(prune.runKey(redone)).verdict, null, 'the redone run waits on a new answer');
  assert.deepEqual(after.problems.map((p) => p.detail), ['answers no question in the questions file', 'answers no question in the questions file']);

  writeFileSync(join(fx.standards, 'references/s1-1-names.md'), '# §1.1 Names\n\nName values for what they hold, always.\n');
  const edited = prune.verdicts(context(fx, 'rule', { sections: ['§1.1'] }), readRuns(fx.out));
  assert.equal([...edited.byRun.values()].filter((v) => v.verdict !== null).length, 0, 'an edited § re-asks every question');
});

test('grading context and prune.json come from the commit the runs branched from, not a later repo HEAD', async () => {
  const fx = fixture();
  writeFileSync(join(fx.repo, 'sibling.txt'), 'BEFORE\n');
  git(fx.repo, ['add', '-A']);
  git(fx.repo, ['commit', '-q', '-m', 'sibling']);
  const base = git(fx.repo, ['rev-parse', 'HEAD']).trim();
  const ctx = () => context(fx, 'rule', { sections: ['§1.1'] });
  for (let i = 0; i < 2; i++) {
    await step(ctx());
    answerAll(fx, 'a');
    answerAll(fx, 'b');
  }
  assert.ok(readRuns(fx.out).every((r) => r.base_commit === base));
  writeFileSync(join(fx.repo, 'sibling.txt'), 'AFTER\n');
  git(fx.repo, ['commit', '-q', '-am', 'later']);
  prune.questions(ctx());
  const state = readJsonl(join(fx.out, 'grading', 'a.questions.jsonl'))[0].state;
  assert.match(state, /BEFORE/);
  assert.doesNotMatch(state, /AFTER/);
  assert.equal(finish(ctx()).record.commit, base);
  const runs = readRuns(fx.out);
  const moved = runs[0];
  const { dir, ...rec } = moved;
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...rec, base_commit: 'abcdef1234567' }));
  assert.throws(() => finish(ctx()), /branched from 2 commits/);
  writeFileSync(join(dir, 'run.json'), JSON.stringify(rec));
});

test('finish --calibration scores the first grader against human labels, and only a pass clears provisional', async () => {
  const fx = fixture();
  const adapters = { fake: fakeAdapter(), other: fakeAdapter() };
  const labels = join(fx.dir, 'labels.jsonl');
  const makeCtx = (extra = {}) => createContext({
    standards: fx.standards, repo: fx.repo, out: fx.out, probes: fx.probes, harnesses: ['fake', 'other'], graders: ['a', 'b'],
    'prune-json': join(fx.out, 'prune.json'), log: () => {}, ...extra,
  }, adapters);
  await runToDecision(fx, makeCtx);
  const answers = readJsonl(join(fx.out, 'grading', 'a.answers.jsonl'));
  assert.equal(answers.length, 40);
  const label = (wrong) => writeJsonl(labels, answers.slice(0, 30).map((a, i) => ({ question_id: a.question_id, complies: i < wrong ? !a.answer : a.answer })));

  label(3);
  let { record } = finish(makeCtx({ calibration: labels }));
  assert.deepEqual(record.grader.calibration, { labeled: 30, agreed: 27, agreement: 0.9, passed: true });
  assert.equal(record.provisional, null);
  assert.ok(record.rules.every((r) => r.provisional === false));
  assert.deepEqual(validate(loadSchema('prune'), record), []);

  label(4);
  ({ record } = finish(makeCtx({ calibration: labels })));
  assert.equal(record.grader.calibration.passed, false);
  assert.equal(record.provisional, 'The grader agreed with 26 of 30 human labels, under 90%.');
  assert.ok(record.rules.every((r) => r.provisional === true));

  writeJsonl(labels, answers.slice(0, 29).map((a) => ({ question_id: a.question_id, complies: a.answer })));
  assert.throws(() => finish(makeCtx({ calibration: labels })), /holds 29 labels; calibration needs at least 30/);
});

test('an adapter that always runs one model records its runs as pinned, with the reason, and the summary says so', async () => {
  const fx = fixture();
  const adapter = { ...fakeAdapter(), pin: { model: () => 'forced-model-1', reason: 'adapter default: test' }, collect: ({ model }) => ({ message: 'done', model, usage: null }) };
  let seen = null;
  const prepare = adapter.prepare;
  adapter.prepare = (a) => { seen = a.model; return prepare(a); };
  const makeCtx = () => createContext({ standards: fx.standards, repo: fx.repo, out: fx.out, probes: fx.probes, harnesses: ['fake'], graders: ['a', 'b'], sections: ['§1.1'], 'prune-json': join(fx.out, 'prune.json'), log: () => {} }, { fake: adapter });
  const record = await runToDecision(fx, makeCtx);
  assert.equal(seen, 'forced-model-1');
  assert.ok(readRuns(fx.out).every((r) => r.model === 'forced-model-1' && r.model_pinned === true && r.pin_reason === 'adapter default: test'));
  assert.deepEqual([record.harnesses[0].model_pinned, record.harnesses[0].pin_reason], [true, 'adapter default: test']);
  assert.deepEqual(validate(loadSchema('prune'), record), []);
  assert.match(prune.summaryTable(makeCtx(), record), /\nfake ran forced-model-1, pinned \(adapter default: test\), not its default\.\n$/);
});

test('a repo path holding a percent sign clones for the runs', async () => {
  const fx = fixture();
  const odd = join(fx.dir, 'repo%41 #x');
  git(fx.dir, ['clone', '-q', fx.repo, odd]);
  const r = await trial(context({ ...fx, repo: odd }, 'rule'), '§1.1', 'fake');
  assert.ok(r.record, r.failed);
});

test('an agent environment keeps locale, proxy and CA settings and drops everything else', () => {
  const planted = { LC_ALL: 'C', LC_CTYPE: 'C', LC_SECRET: 'x', LOGNAME: 'me', HTTPS_PROXY: 'http://p', no_proxy: 'local', NODE_EXTRA_CA_CERTS: '/ca.pem', SSL_CERT_FILE: '/c.pem', GH_TOKEN: 'ghp_FAKE' };
  const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
  Object.assign(process.env, planted);
  try {
    const env = prune.harnessEnv({});
    assert.deepEqual(Object.fromEntries(Object.keys(planted).map((k) => [k, env[k]])), { ...planted, LC_SECRET: undefined, GH_TOKEN: undefined });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('editing a rule\'s index one-liner asks a new grading question', () => {
  const run = { section: '§1.1', harness: 'fake', arm: 'none', run: 1, diff_sha256: 'd' };
  const rule = { section: '§1.1', text: 'Body.', rule: 'Name values.' };
  assert.notEqual(prune.questionId(run, rule, 'P'), prune.questionId(run, { ...rule, rule: 'Never name values.' }, 'P'));
});

test('trial prints what the session loaded and warns when skills loaded', async () => {
  const fx = fixture();
  const init = JSON.stringify({ type: 'system', subtype: 'init', skills: ['someone-else'], plugins: [], mcp_servers: [] });
  const result = JSON.stringify({ type: 'result', result: 'done', modelUsage: { m: {} } });
  const agent = {
    command: 'sh',
    auth: () => null,
    prepare: ({ wt }) => ({ argv: ['-c', `printf '%s\\n' '${init}' '${result}'; echo x >> ${wt}/main.txt`], env: {} }),
    collect: prune.ADAPTERS.claude.collect,
  };
  const logs = [];
  const ctx = createContext({ standards: fx.standards, repo: fx.repo, out: fx.out, probes: fx.probes, harnesses: ['c'], graders: ['a'], log: (s) => logs.push(s) }, { c: agent });
  await trial(ctx, '§1.1', 'c');
  assert.deepEqual(logs.filter((l) => /^(loaded|warning):/.test(l)), ['loaded: skills someone-else; plugins none; mcp servers none', 'warning: the session loaded skills, so the no-rule arm may not be clean']);
});
