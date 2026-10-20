#!/usr/bin/env node
// Measures how often a second answerer agrees with the first on the same questions.
//   sample   pick --n questions at random and write them, with no answers, for the second answerer
//   compare  report agreement per topic between the two answer files on that sample
import { resolve } from 'node:path';
import { JudgeError, args, main, need, readJsonl, seededShuffle, writeJson, writeJsonl } from './lib.mjs';

const USAGE = [
  'usage: agree.mjs sample --questions <questions.jsonl> --out <sample.jsonl> [--n 50] [--seed 11]',
  '       agree.mjs compare --sample <sample.jsonl> --first <answers.jsonl> --second <answers.jsonl> --out <agreement.json>',
].join('\n');

main((argv) => {
  const [command, ...rest] = argv;
  const { values } = args(
    rest,
    { questions: { type: 'string' }, out: { type: 'string' }, n: { type: 'string', default: '50' }, seed: { type: 'string', default: '11' }, sample: { type: 'string' }, first: { type: 'string' }, second: { type: 'string' } },
    USAGE,
  );
  if (command === 'sample') {
    need(values, ['questions', 'out'], USAGE);
    const picked = seededShuffle(readJsonl(resolve(values.questions)), Number(values.seed)).slice(0, Number(values.n));
    writeJsonl(resolve(values.out), picked);
    console.log(`wrote ${picked.length} questions to ${values.out}`);
    return;
  }
  if (command === 'compare') {
    need(values, ['sample', 'first', 'second', 'out'], USAGE);
    const sample = readJsonl(resolve(values.sample));
    const [first, second] = [values.first, values.second].map((f) => new Map(readJsonl(resolve(f)).map((a) => [a.question_id, a])));
    const topics = {};
    const disagreements = [];
    for (const q of sample) {
      const [a, b] = [first.get(q.id), second.get(q.id)];
      if (!a || !b) throw new JudgeError(`${q.id} lacks an answer in ${!a ? values.first : values.second}`);
      const t = (topics[q.topic ?? q.kind] ??= { n: 0, agreed: 0 });
      t.n++;
      if (a.answer === b.answer) t.agreed++;
      else disagreements.push({ id: q.id, first: a.answer, first_confidence: a.confidence, second: b.answer, second_confidence: b.confidence });
    }
    const n = sample.length;
    const agreed = Object.values(topics).reduce((s, t) => s + t.agreed, 0);
    const result = { n, agreed, agreement: Math.round((100 * agreed) / n) / 100, topics, disagreements };
    writeJson(resolve(values.out), result);
    console.log(JSON.stringify({ n, agreed, agreement: result.agreement, topics }));
    return;
  }
  throw new JudgeError(USAGE);
});
