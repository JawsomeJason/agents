import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FetchError, fetchReviews, parseRemote } from '../skills/standards/scripts/fetch-reviews.mjs';
import { failed, fakeRunner, gitRepo, readJsonl, runNode, tempDir } from './helpers.mjs';
import { loadSchema, validate } from './schema.mjs';

const GH = JSON.parse(readFileSync(new URL('./fixtures/gh-api.json', import.meta.url), 'utf8'));
const REMOTE = 'https://github.com/tj/commander.js.git';
const schema = loadSchema('fetch-reviews.reviews');

const assertValid = (records) => {
  for (const r of records) assert.deepEqual(validate(schema, r), [], r.id);
};
const repo = () => gitRepo([{ message: 'init', files: { 'a.txt': 'a\n' }, date: '2020-01-01T00:00:00Z' }], REMOTE);
const fetchGh = (cwd, out, extra = {}) =>
  fetchReviews({ cwd, out, limit: 3, perPage: 2, run: fakeRunner({ responses: GH, cli: { gh: 'ok' } }), ...extra });

test('parses scp, https and ssh remotes, and rejects local paths', () => {
  assert.deepEqual(parseRemote('git@github.com:tj/commander.js.git'), { host: 'github.com', path: 'tj/commander.js' });
  assert.deepEqual(parseRemote('https://gitlab.example.com/group/sub/proj.git\n'), { host: 'gitlab.example.com', path: 'group/sub/proj' });
  assert.deepEqual(parseRemote('ssh://git@host.example:2222/o/r'), { host: 'host.example', path: 'o/r' });
  assert.equal(parseRemote('/srv/repos/r.git'), null);
});

test('gh: pages through merged pull requests and maps every comment kind', () => {
  const dir = tempDir();
  const out = join(dir, 'reviews.jsonl');
  const r = fetchGh(repo(), out);
  assert.equal(r.via, 'gh');
  assert.equal(r.changes, 3);
  const records = readJsonl(out);
  assertValid(records);
  assert.deepEqual(
    records.map((x) => [x.id, x.kind, x.change, x.in_reply_to]),
    [
      ['forge:4225762243', 'inline-comment', '2646', null],
      ['forge:4225818482', 'thread-reply', '2646', 'forge:4225762243'],
      ['forge:4225843246', 'thread-reply', '2646', 'forge:4225762243'],
      ['forge:4225965322', 'thread-reply', '2646', 'forge:4225762243'],
      ['forge:review-5464951591', 'review-body', '2646', null],
    ],
  );
  assert.equal(records[0].path, 'CONTRIBUTING.md');
});

test('gh: --limit stops at that many merged changes', () => {
  const out = join(tempDir(), 'reviews.jsonl');
  const r = fetchGh(repo(), out, { limit: 1 });
  assert.equal(r.changes, 1);
  assert.equal(readFileSync(out, 'utf8'), '');
});

test('gh: marks bot accounts', () => {
  const responses = structuredClone(GH);
  const page = responses['repos/tj/commander.js/pulls/2646/comments?per_page=2&page=1'];
  page[0].user = { login: 'renovate[bot]', type: 'Bot' };
  const out = join(tempDir(), 'reviews.jsonl');
  fetchReviews({ cwd: repo(), out, limit: 3, perPage: 2, run: fakeRunner({ responses, cli: { gh: 'ok' } }) });
  const bots = readJsonl(out).filter((x) => x.author_is_bot);
  assert.equal(bots.length, 1);
  assert.equal(bots[0].author, 'renovate[bot]');
});

test('gh: a second run is byte-identical and reads finished changes from the cache', () => {
  const cwd = repo();
  const out = join(tempDir(), 'reviews.jsonl');
  fetchGh(cwd, out);
  const first = readFileSync(out, 'utf8');
  const noCommentsAllowed = fakeRunner({
    responses: GH,
    cli: { gh: 'ok' },
    onApi: (_, path) => (/\/pulls\/\d+\//.test(path) ? failed('network down') : null),
  });
  fetchReviews({ cwd, out, limit: 3, perPage: 2, run: noCommentsAllowed });
  assert.equal(readFileSync(out, 'utf8'), first);
});

test('gh: a run that fails partway resumes to the same output', () => {
  const cwd = repo();
  const clean = join(tempDir(), 'reviews.jsonl');
  fetchGh(cwd, clean);

  const out = join(tempDir(), 'reviews.jsonl');
  const flaky = fakeRunner({
    responses: GH,
    cli: { gh: 'ok' },
    onApi: (_, path) => (path.includes('2646/reviews?per_page=2&page=2') ? failed('HTTP 502') : null),
  });
  assert.throws(() => fetchReviews({ cwd, out, limit: 3, perPage: 2, run: flaky }), FetchError);
  assert.equal(existsSync(out), false);
  const cacheDir = join(`${out}.cache`, 'gh-github.com-tj_commander.js');
  assert.deepEqual(readdirSync(cacheDir).sort(), ['2653.json', '2654.json']);

  fetchGh(cwd, out);
  assert.equal(readFileSync(out, 'utf8'), readFileSync(clean, 'utf8'));
});

test('detection: missing, signed-out and wrong-remote CLIs all fall back to git log', () => {
  const cases = [
    [{}, ['gh is not installed', 'glab is not installed']],
    [{ gh: 'signed-out' }, ['gh is not signed in to github.com', 'glab is not installed']],
    [{ gh: 'ok', glab: 'ok' }, ['gh cannot find tj/commander.js on github.com', 'glab cannot find tj/commander.js on github.com']],
  ];
  for (const [cli, reasons] of cases) {
    const r = fetchReviews({ cwd: repo(), out: join(tempDir(), 'r.jsonl'), run: fakeRunner({ cli }) });
    assert.equal(r.via, 'git-log');
    assert.deepEqual(r.reasons, reasons);
  }
});

test('glab: maps merge request discussions', () => {
  const project = 'projects/group%2Fproj';
  const responses = {
    [project]: { id: 1 },
    [`${project}/merge_requests?state=merged&order_by=created_at&sort=desc&per_page=100&page=1`]: [
      { iid: 7, web_url: 'https://gitlab.example.com/group/proj/-/merge_requests/7' },
    ],
    [`${project}/merge_requests/7/discussions?per_page=100&page=1`]: [
      {
        notes: [
          { id: 11, system: false, body: 'Wrap this in a transaction.', author: { username: 'rev' }, created_at: '2024-02-01T10:00:00.000Z', position: { new_path: 'db.js', new_line: 4, head_sha: 'abcdef1234567' } },
          { id: 12, system: false, body: 'Done.', author: { username: 'dev' }, created_at: '2024-02-01T11:00:00.000Z' },
        ],
      },
      { notes: [{ id: 13, system: true, body: 'merged', author: { username: 'rev' }, created_at: '2024-02-02T00:00:00.000Z' }] },
      { notes: [{ id: 14, system: false, body: 'Pipeline passed.', author: { username: 'ci-bot', bot: true }, created_at: '2024-02-02T00:00:00.000Z' }] },
    ],
  };
  const cwd = gitRepo([{ message: 'init', files: { 'a.txt': 'a\n' }, date: '2020-01-01T00:00:00Z' }], 'git@gitlab.example.com:group/proj.git');
  const out = join(tempDir(), 'r.jsonl');
  const r = fetchReviews({ cwd, out, run: fakeRunner({ responses, cli: { glab: 'ok' } }) });
  assert.equal(r.via, 'glab');
  const records = readJsonl(out);
  assertValid(records);
  assert.deepEqual(
    records.map((x) => [x.id, x.kind, x.path, x.line, x.in_reply_to, x.author_is_bot]),
    [
      ['forge:11', 'inline-comment', 'db.js', 4, null, false],
      ['forge:12', 'thread-reply', null, null, 'forge:11', false],
      ['forge:14', 'review-body', null, null, null, true],
    ],
  );
});

const HISTORY = [
  { message: 'Add parser', files: { 'parse.js': 'export const parse = 1;\n' }, date: '2024-01-01T00:00:00Z' },
  { message: 'Address review comments (#12)\n\nRename the export.', files: { 'parse.js': 'export const parseInput = 1;\n' }, date: '2024-01-02T00:00:00Z' },
  { message: 'Fix typo in readme', files: { 'README.md': 'hi\n' }, date: '2024-01-03T00:00:00Z' },
  { message: 'per review: split helpers', files: { 'a.js': '1\n', 'b.js': '2\n' }, date: '2024-01-04T00:00:00Z' },
];

test('git log fallback: keeps only commits that address review feedback', () => {
  const cwd = gitRepo(HISTORY);
  const out = join(tempDir(), 'r.jsonl');
  const r = fetchReviews({ cwd, out, run: fakeRunner() });
  assert.equal(r.via, 'git-log');
  assert.deepEqual(r.reasons, ['the repo has no remote']);
  assert.equal(r.scanned, 4);
  const records = readJsonl(out);
  assertValid(records);
  assert.deepEqual(
    records.map((x) => [x.kind, x.change, x.path, x.body.split('\n')[0]]),
    [
      ['commit', '12', 'parse.js', 'Address review comments (#12)'],
      ['commit', null, null, 'per review: split helpers'],
    ],
  );
  assert.match(records[0].diff_hunk, /\+export const parseInput = 1;/);
  assert.equal(records[0].id, `git-log:${records[0].commit}`);
});

test('cli: falls back to git log with no remote, and reruns to identical output', () => {
  const cwd = gitRepo(HISTORY);
  const first = runNode('fetch-reviews.mjs', ['--out', '.standards/reviews.jsonl'], cwd);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /no forge reachable: the repo has no remote/);
  assert.match(first.stdout, /git-log: 2 review-fix commits out of 4 scanned \(0 bot\)/);
  const bytes = readFileSync(join(cwd, '.standards/reviews.jsonl'), 'utf8');
  assert.equal(runNode('fetch-reviews.mjs', ['--out', '.standards/reviews.jsonl'], cwd).status, 0);
  assert.equal(readFileSync(join(cwd, '.standards/reviews.jsonl'), 'utf8'), bytes);
});

test('cli: expected failures print one clear line and no stack trace', () => {
  const cases = [
    [[], tempDir(), /--out is required/],
    [['--out', 'r.jsonl'], tempDir(), /is not inside a git repository/],
    [['--out', 'r.jsonl', '--limit', 'zero'], tempDir(), /--limit must be a positive integer/],
  ];
  for (const [args, cwd, message] of cases) {
    const r = runNode('fetch-reviews.mjs', args, cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, message);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  }
});
