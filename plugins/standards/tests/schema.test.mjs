import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSchema, validate } from './schema.mjs';

const line = {
  id: 'forge:1',
  source: 'forge',
  kind: 'inline-comment',
  author: 'reviewer',
  author_is_bot: false,
  created_at: '2024-01-01T00:00:00Z',
  body: 'Use a DTO here.',
};

test('the validator rejects what each schema forbids', () => {
  const reviews = loadSchema('fetch-reviews.reviews');
  assert.deepEqual(validate(reviews, line), []);
  assert.deepEqual(validate(reviews, { ...line, kind: 'note', created_at: 'yesterday', extra: 1, line: 0 }), [
    '$.kind is not one of ["inline-comment","review-body","thread-reply","commit"]',
    '$.created_at is not an RFC 3339 date-time',
    '$ has unexpected extra',
    '$.line is under 1',
  ]);

  const questions = loadSchema('questions.questions');
  const q = { id: 'forge:1#severity', review_id: 'forge:1', topic: 'severity', kind: 'score', prompt: 'p', state: 's', levels: ['low', 'high'], level_descriptions: { low: 'l', high: 'h' } };
  assert.deepEqual(validate(questions, q), ['$.levels is not ["nit","minor","major","blocker"]']);
  assert.deepEqual(validate(questions, { ...q, levels: ['nit', 'minor', 'major', 'blocker'], options: ['a', 'b'] }), ['$ matches a not schema']);

  const answers = loadSchema('questions.answers');
  assert.deepEqual(validate(answers, { question_id: 'x', answer: true, confidence: 1.2, answered_by: 'judgment-model' }), [
    '$.answer is boolean, expected string',
    '$.confidence is over 1',
    '$ is missing model',
  ]);

  const labels = loadSchema('questions.labels');
  assert.deepEqual(validate(labels, [{ id: 'none', description: '' }]), ['$[0].id matches a not schema', '$[0].description is shorter than 1']);
});

test('doctor findings include a too-broad glob', () => {
  const doctor = loadSchema('doctor');
  const finding = { check: 'glob-too-broad', section: '§1.1', path: 'pkg/cmd/**/*.go', detail: 'Matches 672 of 900 tracked .go files.', fix: 'Narrow the glob.' };
  const report = { standards_path: 'skills/x', checked_at: '2024-01-01T00:00:00Z', commit: 'abc1234', window: { commits: 50 }, sections: 1, findings: [finding] };
  assert.deepEqual(validate(doctor, report), []);
  assert.deepEqual(validate(doctor, { ...report, findings: [{ ...finding, check: 'glob-too-wide' }] }).length, 1);
});
