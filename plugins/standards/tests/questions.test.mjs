import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readJsonl, runNode, tempDir, writeJsonl } from './helpers.mjs';
import { loadSchema, validate } from './schema.mjs';
import { labelTag } from '../skills/standards/scripts/questions.mjs';

const LABELS = [
  { id: 'dto-at-boundary', description: 'Map database documents to DTOs before they leave a handler.' },
  { id: 'test-behavior', description: 'Tests assert observable behavior, not internals.' },
];
const TAG = labelTag(LABELS);

const review = (id, extra = {}) => ({
  id,
  source: 'forge',
  kind: 'inline-comment',
  change: '1',
  author: 'reviewer',
  author_is_bot: false,
  created_at: '2024-01-01T00:00:00Z',
  body: `Comment ${id}`,
  path: 'src/a.js',
  diff_hunk: '@@ -1 +1 @@\n-a\n+b',
  ...extra,
});

function setup() {
  const dir = tempDir();
  writeJsonl(join(dir, 'reviews.jsonl'), [
    review('forge:1'),
    review('forge:2', { author: 'ci[bot]', author_is_bot: true }),
    review('forge:3', { author: 'dev', change_author: 'dev', kind: 'thread-reply', body: 'Done.' }),
    review('git-log:abc1234', { source: 'git-log', kind: 'commit', path: null, body: 'Address review' }),
  ]);
  writeFileSync(join(dir, 'labels.json'), JSON.stringify(LABELS));
  return dir;
}

const askArgs = ['ask', '--reviews', 'reviews.jsonl', '--labels', 'labels.json', '--out', 'questions.jsonl'];

test('ask writes two valid questions per reviewer comment and skips bots and the change author', () => {
  const dir = setup();
  const r = runNode('questions.mjs', askArgs, dir);
  assert.equal(r.status, 0, r.stderr);
  const questions = readJsonl(join(dir, 'questions.jsonl'));
  const schema = loadSchema('questions.questions');
  for (const q of questions) assert.deepEqual(validate(schema, q), [], q.id);
  assert.deepEqual(validate(loadSchema('questions.labels'), LABELS), []);
  assert.deepEqual(
    questions.map((q) => q.id),
    [`forge:1#label@${TAG}`, 'forge:1#severity', `git-log:abc1234#label@${TAG}`, 'git-log:abc1234#severity'],
  );
  assert.deepEqual(questions[0].options, ['dto-at-boundary', 'test-behavior', 'none']);
  assert.equal(questions[0].option_descriptions['dto-at-boundary'], LABELS[0].description);
  assert.match(questions[0].option_descriptions.none, /none of the other conventions/);
  assert.deepEqual(questions[1].levels, ['nit', 'minor', 'major', 'blocker']);
  assert.deepEqual(Object.keys(questions[1].level_descriptions), questions[1].levels);
  assert.equal(questions[0].state, 'Comment:\nComment forge:1\n\nPath: src/a.js\n\nDiff hunk:\n@@ -1 +1 @@\n-a\n+b');
  assert.match(questions[2].state, /^Comment:\nAddress review\n\nCommit diff:\n/);

  const bytes = readFileSync(join(dir, 'questions.jsonl'), 'utf8');
  assert.equal(runNode('questions.mjs', askArgs, dir).status, 0);
  assert.equal(readFileSync(join(dir, 'questions.jsonl'), 'utf8'), bytes);
});

const answer = (question_id, answer, confidence = 0.9) => ({ question_id, answer, confidence, answered_by: 'agent' });
const matching = () => [
  answer(`forge:1#label@${TAG}`, 'test-behavior'),
  answer('forge:1#severity', 'minor'),
  answer(`git-log:abc1234#label@${TAG}`, 'none'),
  answer('git-log:abc1234#severity', 'nit'),
];
const checkArgs = ['check', '--questions', 'questions.jsonl', '--answers', 'answers.jsonl'];

test('check passes a matching answers file', () => {
  const dir = setup();
  runNode('questions.mjs', askArgs, dir);
  const answers = matching();
  const schema = loadSchema('questions.answers');
  for (const a of answers) assert.deepEqual(validate(schema, a), []);
  writeJsonl(join(dir, 'answers.jsonl'), answers);
  const r = runNode('questions.mjs', checkArgs, dir);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stdout, '4 questions, 4 answers, 0 to fix\n');
});

test('check rejects a mismatched answers file, lists every problem, and leaves low confidence to cluster', () => {
  const dir = setup();
  runNode('questions.mjs', askArgs, dir);
  const answers = matching();
  answers.splice(3, 1);
  answers[0] = answer(`forge:1#label@${TAG}`, 'naming');
  answers[1] = answer('forge:1#severity', 'minor', 0.4);
  answers.push(answer(`forge:99#label@${TAG}`, 'none'), answer('forge:1#severity', 'nit'), answer('forge:1#convention', true));
  answers.push({ question_id: `git-log:abc1234#label@${TAG}`, answer: 'none', confidence: 0.9, answered_by: 'judgment-model' });
  writeJsonl(join(dir, 'answers.jsonl'), answers);
  const r = runNode('questions.mjs', checkArgs, dir);
  assert.equal(r.status, 1);
  assert.equal(
    r.stdout,
    [
      `invalid forge:1#label@${TAG} "naming" is not an option`,
      `unknown forge:99#label@${TAG} answers no question in the questions file`,
      'duplicate forge:1#severity has more than one answer',
      'unknown forge:1#convention answers no question in the questions file',
      `duplicate git-log:abc1234#label@${TAG} has more than one answer`,
      'missing git-log:abc1234#severity has no answer',
      '4 questions, 7 answers, 6 to fix',
      '',
    ].join('\n'),
  );
});

test('expected failures print one clear line and no stack trace', () => {
  const dir = setup();
  writeFileSync(join(dir, 'bad-labels.json'), JSON.stringify([{ id: 'none', description: 'x' }]));
  const cases = [
    [['ask', '--reviews', 'missing.jsonl', '--labels', 'labels.json', '--out', 'q.jsonl'], /reviews file not found: missing\.jsonl/],
    [['ask', '--reviews', 'reviews.jsonl', '--labels', 'bad-labels.json', '--out', 'q.jsonl'], /none is reserved/],
    [['check', '--questions', 'questions.jsonl'], /--answers is required/],
    [['frobnicate'], /usage: questions\.mjs ask/],
  ];
  for (const [args, message] of cases) {
    const r = runNode('questions.mjs', args, dir);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, message);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  }
});

test('changing the label set changes every label question id, so an old answer is unknown and the question is missing', () => {
  const dir = setup();
  runNode('questions.mjs', askArgs, dir);
  writeJsonl(join(dir, 'answers.jsonl'), matching());
  assert.equal(runNode('questions.mjs', checkArgs, dir).status, 0);
  writeFileSync(join(dir, 'labels.json'), JSON.stringify([...LABELS, { id: 'wrap-errors', description: 'Wrap errors with context.' }]));
  runNode('questions.mjs', askArgs, dir);
  const r = runNode('questions.mjs', checkArgs, dir);
  assert.equal(r.status, 1);
  const lines = r.stdout.trim().split('\n');
  assert.deepEqual(lines.filter((l) => l.startsWith('unknown')).map((l) => l.split(' ')[1]), [`forge:1#label@${TAG}`, `git-log:abc1234#label@${TAG}`]);
  assert.equal(lines.filter((l) => /^missing \S+#label@/.test(l)).length, 2);
  assert.ok(!lines.some((l) => l.includes('#severity')), 'severity answers keep their ids');
});
