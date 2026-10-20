import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { consensusOf } from './grade.mjs';

const vote = (question_id, answer, confidence = 0.9) => ({ question_id, answer, confidence, answered_by: 'agent' });
const byId = (rows) => new Map(rows.map((a) => [a.question_id, a]));
const rows = ['p1', 'p2', 'p3'].map((id) => ({ id }));

test('two agreeing graders decide a pair, and a third breaks a disagreement', () => {
  const first = byId([vote('p1', true), vote('p2', false), vote('p3', true)]);
  const second = byId([vote('p1', true), vote('p2', false), vote('p3', false)]);
  const pending = consensusOf(rows, first, second, new Map());
  assert.deepEqual(pending.disputed.map((r) => r.id), ['p3']);
  assert.equal(pending.agreement, 0.67);

  const done = consensusOf(rows, first, second, byId([vote('p3', false)]));
  assert.deepEqual(done.disputed, []);
  assert.deepEqual(
    done.answers.map((a) => [a.question_id, a.answer, a.confidence]),
    [
      ['p1', true, 1],
      ['p2', false, 1],
      ['p3', false, 0.67],
    ],
  );
  assert.deepEqual(done.votes.p3, { first: true, second: false, third: false, verdict: false });
});

test('a false at an even split is a no vote', () => {
  const first = byId([vote('p1', false, 0.5)]);
  const second = byId([vote('p1', true, 0.8)]);
  assert.deepEqual(consensusOf([{ id: 'p1' }], first, second, new Map()).votes.p1, { first: false, second: true });
});

test('consensus asks for a third grader, then writes the answers score reads', () => {
  const data = mkdtempSync(join(tmpdir(), 'judge-test-'));
  const grade = join(data, 'grade');
  mkdirSync(grade);
  const jsonl = (file, items) => writeFileSync(join(grade, file), items.map((x) => JSON.stringify(x)).join('\n') + '\n');
  jsonl('pairs.questions.jsonl', rows.map((r) => ({ ...r, kind: 'yesno', prompt: 'same?', state: '{}' })));
  jsonl('pairs.answers.model.jsonl', [vote('p1', true), vote('p2', false), vote('p3', true)]);
  jsonl('pairs.answers.subagent.jsonl', [vote('p1', true), vote('p2', false), vote('p3', false)]);
  const cli = fileURLToPath(new URL('./grade.mjs', import.meta.url));
  const run = () => spawnSync(process.execPath, [cli, 'consensus', '--data', data], { encoding: 'utf8' });

  const first = run();
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stdout, /1 pairs need a third grader/);
  assert.deepEqual(readFileSync(join(grade, 'pairs.tiebreak.questions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id), ['p3']);

  jsonl('pairs.answers.tiebreak.jsonl', [vote('p3', true)]);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  const answers = readFileSync(join(grade, 'pairs.answers.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(answers.map((a) => [a.question_id, a.answer]), [['p1', true], ['p2', false], ['p3', true]]);
  const summary = JSON.parse(readFileSync(join(grade, 'consensus.json'), 'utf8'));
  assert.deepEqual([summary.pairs, summary.agreed, summary.agreement, summary.awaiting_third], [3, 2, 0.67, 0]);
});
