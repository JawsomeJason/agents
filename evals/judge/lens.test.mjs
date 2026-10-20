import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_ADDED, ask, collect, globToRegExp, parseHunks, parseLens } from './lens.mjs';

const LENS = `# §3.2 Write Long help as Markdown

- Applies to: \`pkg/cmd/**/*.go\`, \`api/*.go\`
- Triggers: adding a command's \`Long\`

## Rule

Put verbatim text in backticks.

## Why

Docs render as Markdown.

## Heuristics

- A flag name without backticks.
- A path without backticks.

## Confirmed when

Always.
`;

const DIFF = [
  'diff --git a/pkg/cmd/x/x.go b/pkg/cmd/x/x.go',
  '--- a/pkg/cmd/x/x.go',
  '+++ b/pkg/cmd/x/x.go',
  '@@ -10,3 +10,4 @@ func x() {',
  ' \tLong: heredoc.Doc(`',
  '-\t\tOld text.',
  '+\t\tPass --limit to cap results.',
  '+\t\tReads skills/*/SKILL.md.',
  ' \t`),',
  'diff --git a/docs/readme.md b/docs/readme.md',
  '--- a/docs/readme.md',
  '+++ b/docs/readme.md',
  '@@ -1,1 +1,2 @@',
  ' # Title',
  '+More text.',
  'diff --git a/pkg/cmd/x/gone.go b/pkg/cmd/x/gone.go',
  '--- a/pkg/cmd/x/gone.go',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-package x',
  '',
].join('\n');

test('globs match the way Applies-to lines mean them', () => {
  assert.equal(globToRegExp('pkg/cmd/**/*.go').test('pkg/cmd/issue/artifact/list/list.go'), true);
  assert.equal(globToRegExp('pkg/cmd/**/*.go').test('pkg/cmd/root.go'), true);
  assert.equal(globToRegExp('api/*.go').test('api/queries/pr.go'), false);
  assert.equal(globToRegExp('pkg/**/*.go').test('internal/x.go'), false);
});

test('a § file yields its number, globs, rule and heuristics', () => {
  assert.deepEqual(parseLens(LENS), {
    section: '§3.2',
    title: 'Write Long help as Markdown',
    globs: ['pkg/cmd/**/*.go', 'api/*.go'],
    byTrigger: false,
    triggers: "adding a command's `Long`",
    rule: 'Put verbatim text in backticks.',
    heuristics: ['A flag name without backticks.', 'A path without backticks.'],
  });
});

test('hunks keep new-file line numbers and skip deleted files', () => {
  const hunks = parseHunks(DIFF);
  assert.deepEqual(
    hunks.map((h) => [h.file, h.start, h.lines.map((l) => `${l.n}${l.kind}`).join(' ')]),
    [
      ['pkg/cmd/x/x.go', 11, '10  11+ 12+ 13 '],
      ['docs/readme.md', 2, '1  2+'],
    ],
  );
});

test('a long hunk is cut so no piece adds more than the cap', () => {
  const added = Array.from({ length: MAX_ADDED + 5 }, (_, i) => `+line ${i}`);
  const hunks = parseHunks(['+++ b/pkg/cmd/a.go', `@@ -0,0 +1,${added.length} @@`, ...added].join('\n'));
  assert.deepEqual(hunks.map((h) => [h.start, h.lines.length]), [
    [1, MAX_ADDED],
    [MAX_ADDED + 1, 5],
  ]);
});

test('ask writes one yes/no, line and sign question per covered hunk, and collect turns a yes into a finding', () => {
  const qs = ask({ lenses: [parseLens(LENS)], diffs: [['42', DIFF]] });
  assert.deepEqual(qs.map((q) => q.id), [
    '42/pkg/cmd/x/x.go:11/§3.2#violates',
    '42/pkg/cmd/x/x.go:11/§3.2#line',
    '42/pkg/cmd/x/x.go:11/§3.2#heuristic',
  ]);
  assert.deepEqual(qs[1].options, ['11', '12']);
  assert.deepEqual(qs[2].options, ['h1', 'h2', 'rule']);
  const answers = [
    { question_id: qs[0].id, answer: true, confidence: 0.8, distribution: { true: 0.8, false: 0.2 } },
    { question_id: qs[1].id, answer: '12', confidence: 0.9 },
    { question_id: qs[2].id, answer: 'h2', confidence: 0.7 },
  ];
  assert.deepEqual(collect({ questions: qs, answers, threshold: 0.5 }), {
    42: [
      {
        file: 'pkg/cmd/x/x.go',
        line: 12,
        message: '`Reads skills/*/SKILL.md.` breaks §3.2. Put verbatim text in backticks. Sign: A path without backticks.',
        section: '§3.2',
        p_yes: 0.8,
      },
    ],
  });
  assert.deepEqual(collect({ questions: qs, answers, threshold: 0.9 }), {});
});

test('an answerer that skips the line and sign questions still yields a finding at the first added line', () => {
  const qs = ask({ lenses: [parseLens(LENS)], diffs: [['42', DIFF]] });
  const found = collect({ questions: qs, answers: [{ question_id: qs[0].id, answer: true, confidence: 0.6, answered_by: 'agent' }], threshold: 0.5 });
  assert.deepEqual(found['42'].map((f) => [f.line, f.message]), [[11, '`Pass --limit to cap results.` breaks §3.2. Put verbatim text in backticks.']]);
});

test('the CLI writes questions, then one findings file per held-out change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lens-'));
  mkdirSync(join(dir, 'skill', 'references'), { recursive: true });
  mkdirSync(join(dir, 'diffs'));
  writeFileSync(join(dir, 'skill', 'references', 's3-2-long.md'), LENS);
  writeFileSync(join(dir, 'diffs', '42.review.diff'), DIFF);
  writeFileSync(join(dir, 'diffs', '43.review.diff'), '');
  writeFileSync(join(dir, 'split.json'), JSON.stringify({ heldout: [{ number: '42' }, { number: '43' }] }));
  const cli = fileURLToPath(new URL('./lens.mjs', import.meta.url));
  const run = (...a) => spawnSync(process.execPath, [cli, ...a, '--split', join(dir, 'split.json')], { encoding: 'utf8' });
  const q = join(dir, 'q.jsonl');
  assert.equal(run('ask', '--standards', join(dir, 'skill'), '--diffs', join(dir, 'diffs'), '--out', q).status, 0);
  const first = JSON.parse(readFileSync(q, 'utf8').split('\n')[0]);
  writeFileSync(join(dir, 'a.jsonl'), JSON.stringify({ question_id: first.id, answer: true, confidence: 0.9, answered_by: 'agent' }) + '\n');
  writeFileSync(q, JSON.stringify(first) + '\n');
  const r = run('collect', '--questions', q, '--answers', join(dir, 'a.jsonl'), '--out', join(dir, 'review', 'lens'));
  assert.equal(r.status, 0, r.stderr);
  const read = (n) => JSON.parse(readFileSync(join(dir, 'review', 'lens', `${n}.json`), 'utf8')).findings.length;
  assert.deepEqual([read('42'), read('43')], [1, 0]);
});

test('a by-trigger § meets every hunk, and its question carries the trigger', () => {
  const lens = parseLens(LENS.replace(/^- Applies to:.*$/m, '- Applies to: by trigger').replace(/^- Triggers:.*$/m, '- Triggers: a `heredoc.Doc(` call in the added lines'));
  assert.equal(lens.byTrigger, true);
  assert.deepEqual(lens.globs, []);
  const qs = ask({ lenses: [lens], diffs: [['7', DIFF]] }).filter((q) => q.id.endsWith('#violates'));
  assert.deepEqual(qs.map((q) => q.file), ['pkg/cmd/x/x.go', 'docs/readme.md']);
  assert.match(qs[0].prompt, /applies only where the added lines match its trigger: a `heredoc\.Doc\(` call in the added lines\./);
});
