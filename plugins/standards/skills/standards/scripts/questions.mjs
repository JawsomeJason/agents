#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = [
  'usage: questions.mjs ask --reviews <reviews.jsonl> --labels <labels.json> --out <questions.jsonl>',
  '       questions.mjs check --questions <questions.jsonl> --answers <answers.jsonl>',
].join('\n');
export const LOW_CONFIDENCE = 0.6;
export const SEVERITY_LEVELS = ['nit', 'minor', 'major', 'blocker'];
const SEVERITY_DESCRIPTIONS = {
  nit: 'Ignoring it leaves the code working and clear; it is a matter of taste.',
  minor: 'Ignoring it makes the code harder to read, change or keep consistent, with no wrong behavior.',
  major: 'Ignoring it causes wrong behavior in some cases, a confusing interface, or real maintenance cost.',
  blocker: 'Ignoring it breaks the build, loses or corrupts data, opens a security hole, or ships a bug users hit.',
};
const ANSWERERS = ['judgment-model', 'agent', 'human'];
const LABEL_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NONE_DESCRIPTION =
  'The comment enforces none of the other conventions: it asks for a change to this one site only, or states no convention at all.';

// A comment is a convention when its label is not none. A separate yes/no gate on whether a
// comment generalizes passed few comments, disagreed across answerers, and hid rule-shaped ones.
const PROMPTS = {
  label: 'Which convention does this review comment enforce?',
  severity: 'How much harm would ignoring this comment cause?',
};

export class UsageError extends Error {}

function readText(file, what) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new UsageError(`${what} file not found: ${file}`);
    throw e;
  }
}

export function readJsonl(file, what) {
  return readText(file, what)
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

export function readLabels(file) {
  let labels;
  try {
    labels = JSON.parse(readText(file, 'labels'));
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`${file} is not valid JSON`);
  }
  if (!Array.isArray(labels) || !labels.length) throw new UsageError(`${file} must be a non-empty JSON array`);
  const seen = new Set();
  labels.forEach((l, i) => {
    const where = `${file} label ${i + 1}`;
    if (typeof l?.id !== 'string' || !LABEL_ID.test(l.id)) throw new UsageError(`${where}: id must be a kebab-case slug`);
    if (l.id === 'none') throw new UsageError(`${where}: none is reserved for comments that fit no label`);
    if (seen.has(l.id)) throw new UsageError(`${where}: duplicate id ${l.id}`);
    if (typeof l.description !== 'string' || !l.description.trim()) {
      throw new UsageError(`${where}: description must be a non-empty string`);
    }
    if (Object.keys(l).some((k) => k !== 'id' && k !== 'description')) {
      throw new UsageError(`${where}: only id and description are allowed`);
    }
    seen.add(l.id);
  });
  return labels;
}

// A change's author answering review states no convention a reviewer enforced.
export const isReviewerComment = (r) => !r.author_is_bot && !(r.change_author && r.author === r.change_author);

function stateOf(review) {
  const parts = [`Comment:\n${review.body}`];
  if (review.path) parts.push(`Path: ${review.path}`);
  if (review.diff_hunk) parts.push(`${review.kind === 'commit' ? 'Commit diff' : 'Diff hunk'}:\n${review.diff_hunk}`);
  return parts.join('\n\n');
}

// An id alone is too terse to choose between, so each option carries its label's description.
export function ask(reviews, labels) {
  const options = [...labels.map((l) => l.id), 'none'];
  const option_descriptions = Object.fromEntries([...labels.map((l) => [l.id, l.description]), ['none', NONE_DESCRIPTION]]);
  const seen = new Set();
  const questions = [];
  for (const review of reviews) {
    if (seen.has(review.id)) throw new UsageError(`duplicate review id ${review.id}`);
    seen.add(review.id);
    if (!isReviewerComment(review)) continue;
    const state = stateOf(review);
    const q = (topic, kind, extra) => ({ id: `${review.id}#${topic}`, review_id: review.id, topic, kind, prompt: PROMPTS[topic], state, ...extra });
    questions.push(q('label', 'choice', { options, option_descriptions }), q('severity', 'score', { levels: SEVERITY_LEVELS, level_descriptions: SEVERITY_DESCRIPTIONS }));
  }
  return questions;
}

function invalidReason(question, a) {
  if (!ANSWERERS.includes(a.answered_by)) return `answered_by must be one of ${ANSWERERS.join(', ')}`;
  if (a.answered_by === 'judgment-model' && !(typeof a.model === 'string' && a.model)) {
    return 'judgment-model answers need a model';
  }
  if (typeof a.confidence !== 'number' || a.confidence < 0 || a.confidence > 1) return 'confidence must be within 0 and 1';
  if (question.kind === 'choice' && !question.options.includes(a.answer)) return `${JSON.stringify(a.answer)} is not an option`;
  if (question.kind === 'score' && !question.levels.includes(a.answer)) return `${JSON.stringify(a.answer)} is not a level`;
  return null;
}

// Every problem means the two files do not line up. Which low-confidence answers to re-answer
// depends on the clusters, so cluster.mjs lists those.
export function check(questions, answers) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const answered = new Map();
  const problems = [];
  for (const a of answers) {
    const question = byId.get(a.question_id);
    if (!question) {
      problems.push({ kind: 'unknown', id: String(a.question_id), detail: 'answers no question in the questions file' });
      continue;
    }
    if (answered.has(a.question_id)) {
      problems.push({ kind: 'duplicate', id: a.question_id, detail: 'has more than one answer' });
      continue;
    }
    answered.set(a.question_id, a);
    const reason = invalidReason(question, a);
    if (reason) problems.push({ kind: 'invalid', id: a.question_id, detail: reason });
  }
  for (const q of questions) {
    if (!answered.has(q.id)) problems.push({ kind: 'missing', id: q.id, detail: 'has no answer' });
  }
  return { problems, answered };
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function required(values, names) {
  for (const n of names) if (!values[n]) throw new UsageError(`--${n} is required\n${USAGE}`);
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: { reviews: { type: 'string' }, labels: { type: 'string' }, out: { type: 'string' }, questions: { type: 'string' }, answers: { type: 'string' } },
    }));
  } catch (e) {
    throw new UsageError(`${e.message}\n${USAGE}`);
  }
  if (command === 'ask') {
    required(values, ['reviews', 'labels', 'out']);
    const reviews = readJsonl(values.reviews, 'reviews');
    const questions = ask(reviews, readLabels(values.labels));
    writeAtomic(values.out, questions.map((q) => JSON.stringify(q)).join('\n') + (questions.length ? '\n' : ''));
    console.log(`${questions.length} questions for ${questions.length / 2} reviewer comments (${reviews.length} reviews read); wrote ${values.out}`);
    return 0;
  }
  if (command === 'check') {
    required(values, ['questions', 'answers']);
    const questions = readJsonl(values.questions, 'questions');
    const answers = readJsonl(values.answers, 'answers');
    const { problems } = check(questions, answers);
    for (const p of problems) console.log(`${p.kind} ${p.id} ${p.detail}`);
    console.log(`${questions.length} questions, ${answers.length} answers, ${problems.length} to fix`);
    return problems.length ? 1 : 0;
  }
  throw new UsageError(USAGE);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`questions: ${e.message}`);
    process.exitCode = 2;
  }
}
