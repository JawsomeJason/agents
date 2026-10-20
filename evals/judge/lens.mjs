#!/usr/bin/env node
// An exhaustive lens pass: one yes/no question for every pair of a standards § and an added
// hunk in a file the § applies to, so no rule depends on a reviewer remembering to apply it.
//   ask      write the questions file, in the questions/answers pattern mine uses
//   collect  turn the answers into one findings file per change, in the shape grade.mjs reads
//   union    merge two arms' findings, to model a free-form review followed by the lens pass
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JudgeError, args, main, need, readJson, readJsonl, writeJson, writeJsonl } from './lib.mjs';

const USAGE = [
  'usage: lens.mjs ask --standards <skill dir> --diffs <dir> --split <split.json> --out <questions.jsonl>',
  '       lens.mjs collect --questions <questions.jsonl> --answers <answers.jsonl> --split <split.json> --out <dir> [--threshold 0.5]',
  '       lens.mjs union --a <dir> --b <dir> --split <split.json> --out <dir>',
].join('\n');

// A long new file is one hunk; cutting it keeps each question about code a reader can hold at once.
export const MAX_ADDED = 40;
const VIOLATES = (l) =>
  [
    'Does this added code violate this rule?',
    `Rule (${l.section}): ${l.rule}`,
    `Heuristics:\n${l.heuristics.map((h) => `- ${h}`).join('\n')}`,
    'Judge only the lines marked +. Context lines and code outside the hunk are not part of the change.',
  ].join('\n');
const WHERE = (l) => `Assume the added code violates ${l.section} (${l.rule}). Which added line shows it most clearly?`;
const WHICH = (l) => `Assume the added code violates ${l.section} (${l.rule}). Which sign shows it most clearly?`;

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// Reads one § file: its number, the Applies-to globs, the Rule paragraph and the Heuristics list.
export function parseLens(text) {
  const title = /^# (§\d+\.\d+)\s+(.*)$/m.exec(text);
  const applies = /^- Applies to:(.*)$/m.exec(text);
  const section = (name) => new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text)?.[1].trim();
  const rule = section('Rule');
  if (!title || !applies || !rule) throw new JudgeError('a § file lacks its title, Applies to line or Rule section');
  const heuristics = (section('Heuristics') ?? '')
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());
  const globs = [...applies[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  return { section: title[1], title: title[2], globs, rule: rule.replace(/\s+/g, ' '), heuristics };
}

export function readLenses(skillDir) {
  const dir = join(skillDir, 'references');
  return readdirSync(dir)
    .filter((f) => /^s\d+-\d+.*\.md$/.test(f))
    .sort()
    .map((f) => parseLens(readFileSync(join(dir, f), 'utf8')));
}

// Splits a unified diff into hunks that add lines, each line tagged with its new-file number.
// A hunk with more than MAX_ADDED added lines is cut into pieces of at most that many.
export function parseHunks(diff) {
  const hunks = [];
  let file = null;
  let cur = null;
  let n = 0;
  const flush = () => {
    if (cur && cur.lines.some((l) => l.kind === '+')) hunks.push(...cut(cur));
    cur = null;
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      file = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.slice(4).replace(/^b\//, '');
      continue;
    }
    const head = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (head) {
      flush();
      if (file) cur = { file, lines: [] };
      n = Number(head[1]);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+')) cur.lines.push({ n: n++, kind: '+', text: line.slice(1) });
    else if (line.startsWith(' ')) cur.lines.push({ n: n++, kind: ' ', text: line.slice(1) });
    else if (line.startsWith('-') || line.startsWith('\\')) continue;
  }
  flush();
  return hunks;
}

function cut(hunk) {
  const pieces = [];
  let lines = [];
  let added = 0;
  for (const l of hunk.lines) {
    if (l.kind === '+' && added === MAX_ADDED) {
      pieces.push(lines);
      lines = [];
      added = 0;
    }
    lines.push(l);
    if (l.kind === '+') added++;
  }
  pieces.push(lines);
  return pieces
    .filter((ls) => ls.some((l) => l.kind === '+'))
    .map((ls) => ({ file: hunk.file, start: ls.find((l) => l.kind === '+').n, lines: ls }));
}

const render = (h) => h.lines.map((l) => `${String(l.n).padStart(5)} ${l.kind} ${l.text}`).join('\n');

export function ask({ lenses, diffs }) {
  const matchers = lenses.map((l) => ({ l, res: l.globs.map(globToRegExp) }));
  const questions = [];
  for (const [change, diff] of diffs) {
    for (const h of parseHunks(diff)) {
      const state = JSON.stringify({ change, file: h.file, hunk: render(h) });
      const added = h.lines.filter((l) => l.kind === '+');
      for (const { l } of matchers.filter((m) => m.res.some((re) => re.test(h.file)))) {
        const id = `${change}/${h.file}:${h.start}/${l.section}`;
        const base = { pair: id, change, file: h.file, start: h.start, section: l.section, state };
        questions.push({ ...base, id: `${id}#violates`, kind: 'yesno', prompt: VIOLATES(l), rule: l.rule, heuristics: l.heuristics });
        if (added.length > 1) {
          const options = added.map((x) => String(x.n));
          const option_descriptions = Object.fromEntries(added.map((x) => [String(x.n), x.text.trim() || '(blank line)']));
          questions.push({ ...base, id: `${id}#line`, kind: 'choice', prompt: WHERE(l), options, option_descriptions });
        }
        if (l.heuristics.length) {
          const options = [...l.heuristics.map((_, i) => `h${i + 1}`), 'rule'];
          const option_descriptions = { ...Object.fromEntries(l.heuristics.map((t, i) => [`h${i + 1}`, t])), rule: 'None of these signs; the code breaks the rule sentence itself.' };
          questions.push({ ...base, id: `${id}#heuristic`, kind: 'choice', prompt: WHICH(l), options, option_descriptions });
        }
      }
    }
  }
  return questions;
}

const yes = (a) => (typeof a.distribution?.true === 'number' ? a.distribution.true : a.answer === true ? a.confidence : 1 - a.confidence);
const says = (a, threshold) => (yes(a) === threshold ? a.answer === true : yes(a) > threshold);

// A yes becomes a finding at the line the #line answer picks, or the hunk's first added line when
// no answer picks one, so an agent that answers only the yes/no questions still yields findings.
export function collect({ questions, answers, threshold }) {
  const byId = new Map(answers.map((a) => [a.question_id, a]));
  const out = {};
  const seen = new Set();
  for (const q of questions.filter((x) => x.id.endsWith('#violates'))) {
    const a = byId.get(q.id);
    if (!a) throw new JudgeError(`question ${q.id} has no answer`);
    if (!says(a, threshold)) continue;
    const line = Number(byId.get(`${q.pair}#line`)?.answer ?? q.start);
    const h = byId.get(`${q.pair}#heuristic`)?.answer;
    const sign = h && h !== 'rule' ? q.heuristics[Number(h.slice(1)) - 1] : null;
    const code = JSON.parse(q.state).hunk.split('\n').find((x) => Number(x.slice(0, 5)) === line)?.slice(8).trim();
    const key = `${q.change}|${q.file}|${line}|${q.section}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const message = [code ? `\`${code}\` breaks ${q.section}.` : `This breaks ${q.section}.`, q.rule, sign ? `Sign: ${sign}` : ''].filter(Boolean).join(' ');
    (out[q.change] ??= []).push({ file: q.file, line, message, section: q.section, p_yes: Math.round(yes(a) * 1000) / 1000 });
  }
  return out;
}

const readDiffs = (dir, split) =>
  split.heldout.map((c) => {
    const file = join(dir, `${c.number}.review.diff`);
    if (!existsSync(file)) throw new JudgeError(`${file} is missing; run stage.mjs first`);
    return [c.number, readFileSync(file, 'utf8')];
  });

main((argv) => {
  const [command, ...rest] = argv;
  const { values } = args(
    rest,
    {
      standards: { type: 'string' },
      diffs: { type: 'string' },
      split: { type: 'string' },
      out: { type: 'string' },
      questions: { type: 'string' },
      answers: { type: 'string' },
      threshold: { type: 'string', default: '0.5' },
      a: { type: 'string' },
      b: { type: 'string' },
    },
    USAGE,
  );
  need(values, ['split', 'out'], USAGE);
  const split = readJson(resolve(values.split));
  if (command === 'ask') {
    need(values, ['standards', 'diffs'], USAGE);
    const questions = ask({ lenses: readLenses(resolve(values.standards)), diffs: readDiffs(resolve(values.diffs), split) });
    writeJsonl(resolve(values.out), questions);
    const pairs = questions.filter((q) => q.id.endsWith('#violates')).length;
    console.log(`${questions.length} questions, ${pairs} §-hunk pairs, ${new Set(questions.map((q) => q.state)).size} hunks`);
    return;
  }
  if (command === 'collect') {
    need(values, ['questions', 'answers'], USAGE);
    const questions = readJsonl(resolve(values.questions));
    if (!questions.length) throw new JudgeError(`${values.questions} has no questions`);
    const found = collect({ questions, answers: readJsonl(resolve(values.answers)), threshold: Number(values.threshold) });
    let total = 0;
    for (const c of split.heldout) {
      const findings = found[c.number] ?? [];
      total += findings.length;
      writeJson(join(resolve(values.out), `${c.number}.json`), { token: `lens-${c.number}`, findings });
    }
    console.log(`${total} findings across ${split.heldout.length} changes at threshold ${values.threshold}`);
    return;
  }
  if (command === 'union') {
    need(values, ['a', 'b'], USAGE);
    let total = 0;
    for (const c of split.heldout) {
      const read = (d) => readJson(join(resolve(d), `${c.number}.json`)).findings;
      const findings = [...read(values.a), ...read(values.b)];
      total += findings.length;
      writeJson(join(resolve(values.out), `${c.number}.json`), { token: `union-${c.number}`, findings });
    }
    console.log(`${total} findings across ${split.heldout.length} changes`);
    return;
  }
  throw new JudgeError(USAGE);
}, import.meta.url, USAGE);

