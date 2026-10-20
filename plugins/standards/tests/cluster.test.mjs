import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readJsonl, runNode, tempDir, writeJsonl } from './helpers.mjs';
import { loadSchema, validate } from './schema.mjs';

const LABELS = [
  { id: 'many-minor', description: 'A frequent, low-harm convention.' },
  { id: 'few-blocker', description: 'A rarer, high-harm convention.' },
  { id: 'pair', description: 'Only two comments ask for this.' },
  { id: 'unused', description: 'No comment asks for this.' },
];

// label, severity, label confidence
const PLAN = [
  ['many-minor', 'minor', 0.9],
  ['many-minor', 'minor', 0.7],
  ['many-minor', 'nit', 0.95],
  ['many-minor', 'major', 0.8],
  ['many-minor', 'minor', 0.6],
  ['few-blocker', 'blocker', 0.9],
  ['few-blocker', 'blocker', 0.9],
  ['few-blocker', 'major', 0.9],
  ['pair', 'major', 0.9],
  ['pair', 'major', 0.9],
  ['none', 'blocker', 0.9],
  ['none', 'nit', 0.9],
];

function setup() {
  const dir = tempDir();
  const reviews = PLAN.map((_, i) => ({
    id: `forge:${i + 1}`,
    source: 'forge',
    kind: 'inline-comment',
    change: String(100 + (i % 3)),
    author: 'reviewer',
    author_is_bot: false,
    created_at: '2024-01-01T00:00:00Z',
    body: `Comment ${i + 1}: please ${'do it this way '.repeat(i === 0 ? 40 : 1)}`,
    path: i % 2 ? 'src/b.js' : 'src/a.js',
  }));
  reviews.push({ ...reviews[0], id: 'forge:bot', author: 'lint[bot]', author_is_bot: true });
  writeJsonl(join(dir, 'reviews.jsonl'), reviews);
  writeFileSync(join(dir, 'labels.json'), JSON.stringify(LABELS));
  const ask = runNode('questions.mjs', ['ask', '--reviews', 'reviews.jsonl', '--labels', 'labels.json', '--out', 'questions.jsonl'], dir);
  assert.equal(ask.status, 0, ask.stderr);
  const answers = PLAN.flatMap(([label, severity, labelConfidence], i) => [
    { question_id: `forge:${i + 1}#label`, answer: label, confidence: labelConfidence, answered_by: 'judgment-model', model: 'test-model' },
    { question_id: `forge:${i + 1}#severity`, answer: severity, confidence: 0.8, answered_by: 'agent' },
  ]);
  writeJsonl(join(dir, 'answers.jsonl'), answers);
  return dir;
}

const args = ['--reviews', 'reviews.jsonl', '--questions', 'questions.jsonl', '--answers', 'answers.jsonl', '--labels', 'labels.json', '--out', 'out/clusters.json'];

test('ranks by count times severity, drops clusters under 3, and validates', () => {
  const dir = setup();
  const r = runNode('cluster.mjs', args, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /12 reviewer comments = 2 labeled none \+ 10 kept/);
  const out = JSON.parse(readFileSync(join(dir, 'out/clusters.json'), 'utf8'));
  assert.deepEqual(validate(loadSchema('cluster.clusters'), out), []);
  assert.deepEqual(out.inputs, { reviews: 13, human_reviews: 12, conventions: 10, answered_by: { 'judgment-model': 12, agent: 12, human: 0 } });
  assert.deepEqual(
    out.clusters.map((c) => [c.rank, c.label, c.count, c.severity, c.score]),
    [
      [1, 'few-blocker', 3, 3.667, 11],
      [2, 'many-minor', 5, 2, 10],
    ],
  );
  assert.deepEqual(out.dropped, [{ label: 'pair', count: 2 }, { label: 'unused', count: 0 }]);
  const many = out.clusters[1];
  assert.deepEqual(many.review_ids, ['forge:1', 'forge:2', 'forge:3', 'forge:4', 'forge:5']);
  assert.deepEqual(many.changes, ['100', '101', '102']);
  assert.deepEqual(many.paths, ['src/a.js', 'src/b.js']);
  assert.deepEqual(many.examples.map((e) => e.review_id), ['forge:3', 'forge:1', 'forge:4', 'forge:2', 'forge:5']);
  assert.equal(many.examples[1].excerpt.length, 400);

  const bytes = readFileSync(join(dir, 'out/clusters.json'), 'utf8');
  assert.equal(runNode('cluster.mjs', args, dir).status, 0);
  assert.equal(readFileSync(join(dir, 'out/clusters.json'), 'utf8'), bytes);
});

test('refuses answers that do not match the questions', () => {
  const dir = setup();
  const answers = readJsonl(join(dir, 'answers.jsonl')).slice(1);
  writeJsonl(join(dir, 'answers.jsonl'), answers);
  const r = runNode('cluster.mjs', args, dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /answers do not match questions \(1 found, such as missing forge:1#label\); run questions\.mjs check/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test('a missing input file is one clear line', () => {
  const r = runNode('cluster.mjs', args, tempDir());
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'cluster: reviews file not found: reviews.jsonl\n');
});
