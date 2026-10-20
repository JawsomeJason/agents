#!/usr/bin/env node
// Grades reviewer findings against the human comments on the held-out changes.
//   collect    copy each workspace's findings.json into the data folder
//   pairs      write one yes/no question per finding and human comment on the same file within --window lines
//   consensus  accept a verdict where two graders agree, send disagreements to a third, write the consensus answers
//   calibrate  sample pairs for hand labels, then report grader agreement once they are filled in
//   score      recall, false positives and tokens per arm
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ARMS, JudgeError, args, main, need, readJson, readJsonl, seededShuffle, writeJson, writeJsonl, writeAtomic } from './lib.mjs';

const USAGE = [
  'usage: grade.mjs collect --data <dir>',
  '       grade.mjs pairs --data <dir> [--window 10]',
  '       grade.mjs consensus --data <dir> [--first <answers>] [--second <answers>] [--third <answers>]',
  '       grade.mjs calibrate --data <dir> [--answers <pairs answers>] [--n 30] [--seed 7]',
  '       grade.mjs score --data <dir> [--answers <pairs answers>] [--threshold 0.5]',
].join('\n');
const SAME_CONCERN =
  'Do `review_finding` and `human_comment` raise the same concern about this code, so that an author who fixed what the finding asks for would also have addressed the human comment?';
const HUNK_TAIL = 1500;

const normPath = (p) => (p ?? '').replace(/^(?:\.\/|[ab]\/)/, '');
const yes = (a) => (typeof a.distribution?.true === 'number' ? a.distribution.true : a.answer === true ? a.confidence : 1 - a.confidence);
// At an even split the answerer's own verdict decides, so an agent's false at 0.5 stays false.
const says = (a, threshold = 0.5) => (yes(a) === threshold ? a.answer === true : yes(a) > threshold);

function collect(data) {
  const manifest = readJson(join(data, 'review', 'manifest.json'));
  const missing = [];
  let findings = 0;
  for (const [id, m] of Object.entries(manifest)) {
    const src = join(m.dir, 'findings.json');
    const dest = join(data, 'review', m.arm, `${m.change}.json`);
    if (!existsSync(src)) {
      if (!existsSync(dest)) missing.push(`${id} (${m.arm} ${m.change})`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(src, 'utf8'));
    } catch {
      throw new JudgeError(`${src} is not valid JSON`);
    }
    if (!Array.isArray(parsed.findings)) throw new JudgeError(`${src} has no findings array`);
    const clean = parsed.findings.map((f, i) => {
      if (typeof f.file !== 'string' || typeof f.message !== 'string') throw new JudgeError(`${src} finding ${i} lacks file or message`);
      return { file: normPath(f.file), line: Number.isInteger(f.line) ? f.line : null, message: f.message, section: f.section ?? null };
    });
    findings += clean.length;
    writeJson(dest, { token: id, findings: clean });
  }
  console.log(`${Object.keys(manifest).length - missing.length} collected, ${findings} findings from fresh workspaces`);
  if (missing.length) {
    console.log(`missing: ${missing.join(', ')}`);
    process.exitCode = 1;
  }
}

function loadFindings(data, split) {
  const out = {};
  for (const arm of ARMS) {
    out[arm] = {};
    for (const c of split.heldout) {
      const file = join(data, 'review', arm, `${c.number}.json`);
      if (!existsSync(file)) throw new JudgeError(`${file} is missing; run the reviewer, then grade.mjs collect`);
      out[arm][c.number] = readJson(file).findings;
    }
  }
  return out;
}

function candidatePairs(data, window) {
  const split = readJson(join(data, 'split.json'));
  const comments = readJsonl(join(data, 'heldout', 'reviews.jsonl'));
  const findings = loadFindings(data, split);
  const pairs = [];
  for (const arm of ARMS) {
    for (const c of split.heldout) {
      findings[arm][c.number].forEach((f, i) => {
        for (const h of comments.filter((x) => x.change === c.number && normPath(x.path) === f.file)) {
          if (f.line !== null && h.line !== null && Math.abs(f.line - h.line) > window) continue;
          const state = JSON.stringify({
            human_comment: { path: h.path, line: h.line, body: h.body, diff_hunk_tail: (h.diff_hunk ?? '').slice(-HUNK_TAIL) },
            review_finding: { file: f.file, line: f.line, message: f.message },
          });
          pairs.push({ id: `${arm}/${c.number}/f${i}~${h.id}`, arm, change: c.number, finding: i, comment: h.id, kind: 'yesno', prompt: SAME_CONCERN, state });
        }
      });
    }
  }
  return { split, comments, findings, pairs };
}

function pairs(data, window) {
  const { pairs: rows } = candidatePairs(data, window);
  writeJsonl(join(data, 'grade', 'pairs.questions.jsonl'), rows);
  const byArm = Object.fromEntries(ARMS.map((a) => [a, rows.filter((p) => p.arm === a).length]));
  console.log(`${rows.length} candidate pairs within ${window} lines: ${JSON.stringify(byArm)}`);
}

// Two graders answer every pair: by default a judgment model into pairs.answers.model.jsonl and
// a subagent into pairs.answers.subagent.jsonl. Where they agree, that is the verdict. Where they
// differ, a third grader, a fresh subagent, answers only those pairs and its vote breaks the tie.
// The harness only reads and writes these files, so any answerer can fill each one.
export function consensusOf(rows, first, second, third) {
  const votes = {};
  const answers = [];
  const disputed = [];
  for (const r of rows) {
    const [a, b] = [first.get(r.id), second.get(r.id)];
    if (!a || !b) throw new JudgeError(`pair ${r.id} lacks an answer from the ${!a ? 'first' : 'second'} grader`);
    const v = { first: says(a), second: says(b) };
    if (v.first !== v.second) {
      const c = third.get(r.id);
      if (!c) {
        disputed.push(r);
        votes[r.id] = v;
        continue;
      }
      v.third = says(c);
    }
    v.verdict = v.third ?? v.first;
    votes[r.id] = v;
    const ballots = [v.first, v.second, v.third].filter((x) => x !== undefined);
    const share = ballots.filter((x) => x === v.verdict).length / ballots.length;
    answers.push({ question_id: r.id, answer: v.verdict, confidence: round(share), answered_by: 'consensus', votes: v });
  }
  const agreed = rows.filter((r) => votes[r.id].first === votes[r.id].second).length;
  return { answers, disputed, votes, agreed, agreement: rows.length ? round(agreed / rows.length) : null };
}

function consensus(data, files) {
  const rows = readJsonl(join(data, 'grade', 'pairs.questions.jsonl'));
  const [first, second] = [files.first, files.second].map(readAnswers);
  const third = existsSync(files.third) ? new Map(readJsonl(files.third).map((a) => [a.question_id, a])) : new Map();
  const result = consensusOf(rows, first, second, third);
  const summary = { pairs: rows.length, agreed: result.agreed, agreement: result.agreement, disagreed: rows.length - result.agreed, awaiting_third: result.disputed.length, files };
  writeJson(join(data, 'grade', 'consensus.json'), { ...summary, votes: result.votes });
  if (result.disputed.length) {
    const out = join(data, 'grade', 'pairs.tiebreak.questions.jsonl');
    writeJsonl(out, result.disputed);
    console.log(JSON.stringify(summary));
    console.log(`${result.disputed.length} pairs need a third grader: have a fresh subagent answer ${out} into ${files.third}, then rerun`);
    process.exitCode = 1;
    return;
  }
  writeJsonl(join(data, 'grade', 'pairs.answers.jsonl'), result.answers);
  console.log(JSON.stringify(summary));
  console.log(`wrote ${join(data, 'grade', 'pairs.answers.jsonl')}`);
}

function readAnswers(file) {
  if (!existsSync(file)) throw new JudgeError(`${file} is missing; answer pairs.questions.jsonl first`);
  return new Map(readJsonl(file).map((a) => [a.question_id, a]));
}

// Half the sample from pairs the grader called a match, half from the rest, so a grader
// that says no to everything cannot pass on the base rate. The labeler never sees the grader's answer.
function calibrate(data, answersFile, n, seed) {
  const file = join(data, 'grade', 'calibration.json');
  const rows = readJsonl(join(data, 'grade', 'pairs.questions.jsonl'));
  const answers = readAnswers(answersFile);
  if (!existsSync(file)) {
    const pos = seededShuffle(rows.filter((r) => says(answers.get(r.id))), seed);
    const neg = seededShuffle(rows.filter((r) => !says(answers.get(r.id))), seed + 1);
    const take = Math.min(Math.ceil(n / 2), pos.length);
    const sample = seededShuffle([...pos.slice(0, take), ...neg.slice(0, n - take)], seed + 2);
    writeJson(file, sample.map((r) => ({ id: r.id, ...JSON.parse(r.state), same_concern: null })));
    console.log(`wrote ${sample.length} pairs to ${file}; set each same_concern to true or false, then rerun`);
    return;
  }
  const labeled = readJson(file);
  const open = labeled.filter((l) => typeof l.same_concern !== 'boolean');
  if (open.length) throw new JudgeError(`${open.length} pairs in ${file} still need a same_concern label`);
  const agreed = labeled.filter((l) => says(answers.get(l.id)) === l.same_concern).length;
  const result = { labeled: labeled.length, agreed, agreement: agreed / labeled.length, passed: agreed / labeled.length >= 0.9 };
  writeJson(join(data, 'grade', 'calibration.result.json'), {
    ...result,
    answers: answersFile,
    disagreements: labeled.filter((l) => says(answers.get(l.id)) !== l.same_concern).map((l) => ({ id: l.id, hand: l.same_concern, grader_yes: yes(answers.get(l.id)) })),
  });
  console.log(JSON.stringify(result));
}

function conventionFlags(data) {
  const answers = new Map(readJsonl(join(data, 'heldout', 'answers.jsonl')).map((a) => [a.question_id, a]));
  if (!answers.size) throw new JudgeError('heldout/answers.jsonl is missing; label the held-out comments the way mine does first');
  return (id) => {
    const label = answers.get(`${id}#label`);
    if (!label) throw new JudgeError(`held-out comment ${id} has no label answer`);
    return { convention: label.answer !== 'none', label: label.answer };
  };
}

function score(data, answersFile, threshold) {
  const { split, comments, findings, pairs: rows } = candidatePairs(data, readJson(join(data, 'grade', 'pairs.meta.json')).window);
  const answers = readAnswers(answersFile);
  const flag = conventionFlags(data);
  const manifest = readJson(join(data, 'review', 'manifest.json'));
  const tokensFile = join(data, 'review', 'tokens.json');
  const tokens = existsSync(tokensFile) ? readJson(tokensFile) : {};
  const conv = new Set(comments.filter((c) => flag(c.id).convention).map((c) => c.id));
  const changes = split.heldout.length;
  const table = {};
  const perChange = {};
  for (const arm of ARMS) {
    const matches = rows.filter((p) => p.arm === arm && says(answers.get(p.id) ?? missingAnswer(p.id), threshold));
    const caught = new Set(matches.map((p) => p.comment));
    const backed = new Set(matches.map((p) => `${p.change}/${p.finding}`));
    const all = split.heldout.flatMap((c) => findings[arm][c.number].map((f, i) => ({ change: c.number, i, f })));
    const fp = all.filter((x) => !backed.has(`${x.change}/${x.i}`));
    const armTokens = Object.entries(manifest).filter(([, m]) => m.arm === arm).map(([id]) => tokens[id]).filter((t) => typeof t === 'number');
    table[arm] = {
      convention_recall: ratio([...conv].filter((id) => caught.has(id)).length, conv.size),
      all_recall: ratio(comments.filter((c) => caught.has(c.id)).length, comments.length),
      findings: all.length,
      false_positives: fp.length,
      false_positives_per_change: round(fp.length / changes),
      findings_citing_section: all.filter((x) => x.f.section).length,
      mean_tokens: armTokens.length ? Math.round(armTokens.reduce((a, b) => a + b, 0) / armTokens.length) : null,
      tokens_reported: armTokens.length,
    };
    perChange[arm] = Object.fromEntries(
      split.heldout.map((c) => {
        const mine = comments.filter((h) => h.change === c.number);
        return [c.number, { comments: mine.length, convention: mine.filter((h) => conv.has(h.id)).length, caught: mine.filter((h) => caught.has(h.id)).map((h) => h.id), findings: findings[arm][c.number].length, false_positives: fp.filter((x) => x.change === c.number).length }];
      }),
    );
  }
  const result = { threshold, answers: answersFile, changes, comments: comments.length, convention_comments: conv.size, arms: table, per_change: perChange };
  writeJson(join(data, 'grade', 'metrics.json'), result);
  const row = (arm, t) =>
    `| ${arm} | ${t.convention_recall.text} | ${t.all_recall.text} | ${t.false_positives_per_change} | ${t.findings} | ${t.mean_tokens ?? 'n/a'} |`;
  const md = [
    `| Arm | Convention recall (of ${conv.size}) | All recall (of ${comments.length}) | False positives per change | Findings | Mean tokens |`,
    '| --- | --- | --- | --- | --- | --- |',
    ...ARMS.map((a) => row(a, table[a])),
  ].join('\n');
  writeAtomic(join(data, 'grade', 'metrics.md'), md + '\n');
  console.log(md);
}

function missingAnswer(id) {
  throw new JudgeError(`pair ${id} has no answer; rerun the grader on pairs.questions.jsonl`);
}
const round = (x) => Math.round(x * 100) / 100;
const ratio = (n, d) => ({ n, d, value: d ? round(n / d) : null, text: d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : 'n/a' });

main((argv) => {
  const [command, ...rest] = argv;
  const { values } = args(
    rest,
    { data: { type: 'string' }, window: { type: 'string', default: '10' }, answers: { type: 'string' }, first: { type: 'string' }, second: { type: 'string' }, third: { type: 'string' }, n: { type: 'string', default: '30' }, seed: { type: 'string', default: '7' }, threshold: { type: 'string', default: '0.5' } },
    USAGE,
  );
  need(values, ['data'], USAGE);
  const data = resolve(values.data);
  const answersFile = resolve(values.answers ?? join(data, 'grade', 'pairs.answers.jsonl'));
  if (command === 'collect') return collect(data);
  if (command === 'pairs') {
    writeJson(join(data, 'grade', 'pairs.meta.json'), { window: Number(values.window), prompt: SAME_CONCERN });
    return pairs(data, Number(values.window));
  }
  if (command === 'consensus') {
    const file = (k, name) => resolve(values[k] ?? join(data, 'grade', name));
    return consensus(data, { first: file('first', 'pairs.answers.model.jsonl'), second: file('second', 'pairs.answers.subagent.jsonl'), third: file('third', 'pairs.answers.tiebreak.jsonl') });
  }
  if (command === 'calibrate') return calibrate(data, answersFile, Number(values.n), Number(values.seed));
  if (command === 'score') return score(data, answersFile, Number(values.threshold));
  throw new JudgeError(USAGE);
}, import.meta.url);