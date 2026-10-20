#!/usr/bin/env node
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LOW_CONFIDENCE, UsageError, check, ignoreWorkDir, isReviewerComment, readJsonl, readLabels } from './questions.mjs';

const USAGE =
  'usage: cluster.mjs --reviews <reviews.jsonl> --questions <questions.jsonl> --answers <answers.jsonl> --labels <labels.json> --out <clusters.json>';
// A convention needs evidence from several changes and more than one reviewer. Many comments
// on one change, or from one person, are that reviewer's taste on that code.
export const MIN_COUNT = { changes: 3, reviewers: 2 };
export const SEVERITY_WEIGHTS = { nit: 1, minor: 2, major: 3, blocker: 4 };
const MAX_EXAMPLES = 5;
const EXCERPT_MAX = 400;

const round = (x) => Math.round(x * 1000) / 1000;

function excerpt(body) {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_MAX ? flat : `${flat.slice(0, EXCERPT_MAX - 1)}…`;
}

const distinct = (values) => [...new Set(values.filter((v) => v !== null && v !== undefined))];

// A low-confidence judgment-model answer is worth re-answering only when a different answer
// could change a kept cluster. Any label answer can move its comment into, out of or between
// clusters. A severity answer moves a score only for a comment kept in a cluster that survives.
// An agent's or human's answer is already the re-answer, so it is never listed again.
function reanswerList(human, answer, kept) {
  const out = [];
  for (const review of human) {
    const label = answer(review, 'label');
    const severity = answer(review, 'severity');
    const low = (a) => a.answered_by === 'judgment-model' && a.confidence < LOW_CONFIDENCE;
    if (low(label)) out.push({ question_id: label.question_id, confidence: label.confidence, reason: 'label can move this comment between clusters' });
    if (low(severity) && kept.has(label.answer)) {
      out.push({ question_id: severity.question_id, confidence: severity.confidence, reason: `severity changes the score of ${label.answer}` });
    }
  }
  return out;
}

export function cluster({ reviews, questions, answers, labels }) {
  const { problems, answered } = check(questions, answers);
  if (problems.length) {
    const sample = problems.slice(0, 5).map((p) => `${p.kind} ${p.id}`).join(', ');
    throw new UsageError(`answers do not match questions (${problems.length} found, such as ${sample}); run questions.mjs check`);
  }
  const reviewIds = new Set(reviews.map((r) => r.id));
  const orphan = questions.find((q) => !reviewIds.has(q.review_id));
  if (orphan) throw new UsageError(`question ${orphan.id} names a review not in the reviews file; rerun questions.mjs ask`);
  const labelById = new Map(labels.map((l) => [l.id, l]));
  const questionFor = new Map(questions.map((q) => [`${q.review_id}#${q.topic}`, q.id]));
  const answer = (review, topic) => answered.get(questionFor.get(`${review.id}#${topic}`));

  const human = reviews.filter(isReviewerComment);
  const groups = new Map(labels.map((l) => [l.id, []]));
  let none = 0;
  for (const review of human) {
    const [label, severity] = ['label', 'severity'].map((t) => answer(review, t));
    if (!label || !severity) throw new UsageError(`review ${review.id} lacks its two questions; rerun questions.mjs ask`);
    if (label.answer === 'none') none++;
    else {
      if (!labelById.has(label.answer)) throw new UsageError(`label ${label.answer} is not in the labels file`);
      groups.get(label.answer).push({ review, weight: SEVERITY_WEIGHTS[severity.answer], labelConfidence: label.confidence });
    }
  }
  const kept = [...groups.values()].reduce((n, g) => n + g.length, 0);
  if (none + kept !== human.length) throw new Error('cluster counts do not reconcile with reviewer comments');

  const clusters = [];
  const dropped = [];
  for (const [id, members] of groups) {
    const changes = distinct(members.map((m) => m.review.change));
    const reviewers = distinct(members.map((m) => m.review.author));
    if (changes.length < MIN_COUNT.changes || reviewers.length < MIN_COUNT.reviewers) {
      dropped.push({ label: id, count: members.length, changes: changes.length, reviewers: reviewers.length });
      continue;
    }
    const severity = round(members.reduce((s, m) => s + m.weight, 0) / members.length);
    const plainest = [...members].sort(
      (a, b) => b.labelConfidence - a.labelConfidence || a.review.body.length - b.review.body.length,
    );
    clusters.push({
      label: id,
      description: labelById.get(id).description,
      count: members.length,
      severity,
      score: round(members.reduce((s, m) => s + m.weight, 0)),
      review_ids: members.map((m) => m.review.id),
      changes,
      reviewers,
      paths: distinct(members.map((m) => m.review.path)),
      examples: plainest.slice(0, MAX_EXAMPLES).map(({ review }) => ({
        review_id: review.id,
        change: review.change ?? null,
        path: review.path ?? null,
        excerpt: excerpt(review.body),
      })),
    });
  }
  const reanswer = reanswerList(human, answer, new Set(clusters.map((c) => c.label)));
  clusters.sort((a, b) => b.score - a.score || b.count - a.count || (a.label < b.label ? -1 : 1));
  dropped.sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1));

  const answeredBy = { 'judgment-model': 0, agent: 0, human: 0 };
  for (const a of answered.values()) answeredBy[a.answered_by]++;
  return {
    result: {
      inputs: { reviews: reviews.length, human_reviews: human.length, conventions: kept, answered_by: answeredBy },
      min_count: MIN_COUNT,
      // Under git log, a record's author is whoever committed the fix, not the reviewer who asked for it.
      reviewer_basis: human.some((r) => r.source === 'git-log') ? 'commit-author' : 'reviewer',
      severity_weights: SEVERITY_WEIGHTS,
      clusters: clusters.map((c, i) => ({ rank: i + 1, ...c })),
      dropped,
      reanswer,
    },
    tally: { human: human.length, none, kept },
  };
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { reviews: { type: 'string' }, questions: { type: 'string' }, answers: { type: 'string' }, labels: { type: 'string' }, out: { type: 'string' } },
    }));
  } catch (e) {
    throw new UsageError(`${e.message}\n${USAGE}`);
  }
  for (const n of ['reviews', 'questions', 'answers', 'labels', 'out']) {
    if (!values[n]) throw new UsageError(`--${n} is required\n${USAGE}`);
  }
  const { result, tally } = cluster({
    reviews: readJsonl(values.reviews, 'reviews'),
    questions: readJsonl(values.questions, 'questions'),
    answers: readJsonl(values.answers, 'answers'),
    labels: readLabels(values.labels),
  });
  ignoreWorkDir(values.out);
  mkdirSync(dirname(values.out), { recursive: true });
  const tmp = `${values.out}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(tmp, values.out);
  console.log(
    `${result.clusters.length} clusters kept, ${result.dropped.length} dropped. ` +
      `${tally.human} reviewer comments = ${tally.none} labeled none + ${tally.kept} kept`,
  );
  for (const r of result.reanswer) console.log(`re-answer ${r.question_id} confidence ${r.confidence}: ${r.reason}`);
  if (result.reanswer.length) console.log(`${result.reanswer.length} low-confidence answers can change a cluster; re-answer them, then rerun`);
  console.log(`wrote ${values.out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`cluster: ${e.message}`);
    process.exitCode = 2;
  }
}
