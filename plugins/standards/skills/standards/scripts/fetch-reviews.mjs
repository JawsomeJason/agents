#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = 'usage: fetch-reviews.mjs --out <file> [--limit <changes>] [--refresh]';
const PER_PAGE = 100;
const DIFF_MAX_CHARS = 20000;
const REVIEW_FIX =
  /\b(?:address(?:es|ed|ing)?|appl(?:y|ies|ied|ying)|fix(?:es|ed|ing)?|resolv(?:e|es|ed|ing))\b[^\n]{0,40}\breview\b|\bper (?:the |code |pr )?review\b|\breview (?:fixes|feedback|comments?|findings|nits?|suggestions?)\b/i;

export class FetchError extends Error {}

export function systemRunner(cmd, args, { cwd } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.error?.code === 'ENOENT') return { missing: true, status: null, stdout: '', stderr: '' };
  if (r.error) throw r.error;
  return { missing: false, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function parseRemote(url) {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { host: m[1].toLowerCase(), path: m[2] } : null;
}

const firstLine = (text) => text.trim().split('\n')[0] ?? '';
const isBotLogin = (login) => /\[bot\]$/i.test(login) || /(?:^|[-_])bot$/i.test(login);

function git(run, cwd, args) {
  const r = run('git', args, { cwd });
  if (r.missing) throw new FetchError('git is not installed');
  return r;
}

function findRemote(run, cwd) {
  const remotes = git(run, cwd, ['remote']).stdout.split('\n').filter(Boolean);
  const name = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!name) return null;
  const url = git(run, cwd, ['remote', 'get-url', name]).stdout;
  return parseRemote(url);
}

const FORGES = [
  { cli: 'gh', repoPath: (path) => `repos/${path}` },
  { cli: 'glab', repoPath: (path) => `projects/${encodeURIComponent(path)}` },
];

function detectForge(run, cwd, remote) {
  if (!remote) return { forge: null, reasons: ['the repo has no remote'] };
  const reasons = [];
  for (const { cli, repoPath } of FORGES) {
    if (run(cli, ['--version'], { cwd }).missing) {
      reasons.push(`${cli} is not installed`);
      continue;
    }
    if (run(cli, ['auth', 'status', '--hostname', remote.host], { cwd }).status !== 0) {
      reasons.push(`${cli} is not signed in to ${remote.host}`);
      continue;
    }
    if (run(cli, ['api', '--hostname', remote.host, repoPath(remote.path)], { cwd }).status !== 0) {
      reasons.push(`${cli} cannot find ${remote.path} on ${remote.host}`);
      continue;
    }
    return { forge: { cli, cwd, ...remote }, reasons };
  }
  return { forge: null, reasons };
}

function api(run, forge, path) {
  const r = run(forge.cli, ['api', '--hostname', forge.host, path], { cwd: forge.cwd });
  if (r.status !== 0) {
    throw new FetchError(`${forge.cli} api ${path} failed: ${firstLine(r.stderr) || `exit ${r.status}`}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new FetchError(`${forge.cli} api ${path} did not return JSON`);
  }
}

// Paging by hand rather than with the CLI's own pagination keeps both CLIs on one code path
// and lets the merged-change limit stop the walk early.
function* pages(run, forge, path, perPage) {
  const joiner = path.includes('?') ? '&' : '?';
  for (let page = 1; ; page++) {
    const items = api(run, forge, `${path}${joiner}per_page=${perPage}&page=${page}`);
    if (!Array.isArray(items)) throw new FetchError(`${forge.cli} api ${path} did not return a list`);
    yield* items;
    if (items.length < perPage) return;
  }
}

// One finished file per change, so a rerun after a failure skips every change already read.
function cached(dir, change, refresh, load) {
  const file = join(dir, `${change}.json`);
  if (!refresh && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const records = load();
  writeAtomic(file, JSON.stringify(records));
  return records;
}

function githubRecords(run, forge, change, perPage, changeAuthor) {
  const base = `repos/${forge.path}/pulls/${change}`;
  const records = [];
  for (const c of pages(run, forge, `${base}/comments`, perPage)) {
    if (!c.body?.trim()) continue;
    const author = c.user?.login ?? 'ghost';
    records.push({
      id: `forge:${c.id}`,
      source: 'forge',
      kind: c.in_reply_to_id ? 'thread-reply' : 'inline-comment',
      change,
      change_author: changeAuthor,
      author,
      author_is_bot: c.user?.type === 'Bot' || isBotLogin(author),
      created_at: c.created_at,
      body: c.body,
      path: c.path ?? null,
      // The original fields name the commit the reviewer saw. commit_id and line move with
      // later pushes, and line goes null once the comment is outdated.
      line: c.original_line ?? c.line ?? null,
      diff_hunk: c.diff_hunk ?? null,
      commit: c.original_commit_id ?? c.commit_id ?? null,
      in_reply_to: c.in_reply_to_id ? `forge:${c.in_reply_to_id}` : null,
      url: c.html_url ?? null,
    });
  }
  for (const r of pages(run, forge, `${base}/reviews`, perPage)) {
    if (!r.body?.trim() || !r.submitted_at) continue;
    const author = r.user?.login ?? 'ghost';
    records.push({
      id: `forge:review-${r.id}`,
      source: 'forge',
      kind: 'review-body',
      change,
      change_author: changeAuthor,
      author,
      author_is_bot: r.user?.type === 'Bot' || isBotLogin(author),
      created_at: r.submitted_at,
      body: r.body,
      path: null,
      line: null,
      diff_hunk: null,
      commit: r.commit_id ?? null,
      in_reply_to: null,
      url: r.html_url ?? null,
    });
  }
  return records;
}

function gitlabRecords(run, forge, change, perPage, webUrl, changeAuthor) {
  const base = `projects/${encodeURIComponent(forge.path)}/merge_requests/${change}/discussions`;
  const records = [];
  for (const discussion of pages(run, forge, base, perPage)) {
    const notes = (discussion.notes ?? []).filter((n) => !n.system && n.body?.trim());
    notes.forEach((n, i) => {
      const author = n.author?.username ?? 'ghost';
      records.push({
        id: `forge:${n.id}`,
        source: 'forge',
        kind: i > 0 ? 'thread-reply' : n.position ? 'inline-comment' : 'review-body',
        change,
        change_author: changeAuthor,
        author,
        author_is_bot: n.author?.bot === true || isBotLogin(author),
        created_at: n.created_at,
        body: n.body,
        path: n.position?.new_path ?? null,
        line: n.position?.new_line ?? null,
        diff_hunk: null,
        commit: n.position?.head_sha ?? null,
        in_reply_to: i > 0 ? `forge:${notes[0].id}` : null,
        url: webUrl ? `${webUrl}#note_${n.id}` : null,
      });
    });
  }
  return records;
}

function fromForge(run, forge, { limit, refresh, perPage, cacheRoot }) {
  const github = forge.cli === 'gh';
  const listPath = github
    ? `repos/${forge.path}/pulls?state=closed&sort=created&direction=desc`
    : `projects/${encodeURIComponent(forge.path)}/merge_requests?state=merged&order_by=created_at&sort=desc`;
  const changes = [];
  for (const item of pages(run, forge, listPath, perPage)) {
    if (github && !item.merged_at) continue;
    const changeAuthor = (github ? item.user?.login : item.author?.username) ?? null;
    changes.push({ number: String(github ? item.number : item.iid), webUrl: item.web_url, changeAuthor });
    if (limit && changes.length >= limit) break;
  }
  const cacheDir = join(cacheRoot, `${forge.cli}-${forge.host}-${forge.path.replaceAll('/', '_')}`);
  const records = changes.flatMap(({ number, webUrl, changeAuthor }) =>
    cached(cacheDir, number, refresh, () =>
      github
        ? githubRecords(run, forge, number, perPage, changeAuthor)
        : gitlabRecords(run, forge, number, perPage, webUrl, changeAuthor),
    ),
  );
  return { records, changes: changes.length };
}

function fromGitLog(run, cwd, { limit }) {
  const head = git(run, cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const branch = head.status === 0 ? head.stdout.trim() : 'HEAD';
  const log = git(run, cwd, ['log', branch, '--no-merges', '-z', '--format=%H%x1f%an%x1f%aI%x1f%B']);
  if (log.status !== 0) throw new FetchError(`git log failed: ${firstLine(log.stderr)}`);
  const records = [];
  let scanned = 0;
  for (const entry of log.stdout.split('\0')) {
    if (!entry.trim()) continue;
    scanned++;
    const [sha, author, date, message] = entry.replace(/^\n/, '').split('\x1f');
    const body = message.replace(/\s+$/, '');
    if (!REVIEW_FIX.test(body)) continue;
    const files = git(run, cwd, ['show', '--no-color', '--format=', '--name-only', sha]).stdout.split('\n').filter(Boolean);
    const diff = git(run, cwd, ['show', '--no-color', '--format=', '--patch', sha]).stdout;
    const change = /\(#(\d+)\)|(?:^|\s)!(\d+)\b/.exec(body.split('\n')[0]);
    records.push({
      id: `git-log:${sha}`,
      source: 'git-log',
      kind: 'commit',
      // A commit with no change number in its title is its own change, so clusters can still count distinct changes.
      change: change ? (change[1] ?? change[2]) : sha.slice(0, 12),
      change_author: null,
      author: author || 'unknown',
      author_is_bot: isBotLogin(author),
      created_at: date,
      body,
      path: files.length === 1 ? files[0] : null,
      line: null,
      diff_hunk: diff.trim() ? diff.slice(0, DIFF_MAX_CHARS) : null,
      commit: sha,
      in_reply_to: null,
      url: null,
    });
    if (limit && records.length >= limit) break;
  }
  return { records, changes: records.length, scanned };
}

// Numbered changes sort by number, then commit-hash changes by text, then records with no change.
function byChangeThenTime(a, b) {
  const rank = (c) => (c === null ? 2 : /^\d+$/.test(c) ? 0 : 1);
  if (rank(a.change) !== rank(b.change)) return rank(a.change) - rank(b.change);
  if (rank(a.change) === 0 && a.change !== b.change) return Number(a.change) - Number(b.change);
  if (rank(a.change) === 1 && a.change !== b.change) return a.change < b.change ? -1 : 1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function fetchReviews({ cwd, out, limit = 0, refresh = false, run = systemRunner, perPage = PER_PAGE }) {
  if (git(run, cwd, ['rev-parse', '--show-toplevel']).status !== 0) {
    throw new FetchError(`${cwd} is not inside a git repository`);
  }
  const { forge, reasons } = detectForge(run, cwd, findRemote(run, cwd));
  const result = forge
    ? fromForge(run, forge, { limit, refresh, perPage, cacheRoot: `${out}.cache` })
    : fromGitLog(run, cwd, { limit });
  const records = [...result.records].sort(byChangeThenTime);
  writeAtomic(out, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  return { ...result, records, via: forge ? forge.cli : 'git-log', reasons };
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
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
      options: { out: { type: 'string' }, limit: { type: 'string' }, refresh: { type: 'boolean' } },
    }));
  } catch (e) {
    throw new FetchError(`${e.message}\n${USAGE}`);
  }
  if (!values.out) throw new FetchError(`--out is required\n${USAGE}`);
  const limit = values.limit === undefined ? 0 : Number(values.limit);
  if (values.limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) {
    throw new FetchError(`--limit must be a positive integer\n${USAGE}`);
  }
  const out = resolve(values.out);
  const r = fetchReviews({ cwd: process.cwd(), out, limit, refresh: values.refresh });
  const bots = r.records.filter((x) => x.author_is_bot).length;
  if (r.via === 'git-log') {
    console.log(`no forge reachable: ${r.reasons.join('; ')}`);
    console.log(
      `git-log: ${r.records.length} review-fix commits out of ${r.scanned} scanned (${bots} bot). ` +
        'git log finds fewer conventions than a forge.',
    );
  } else {
    console.log(`${r.via}: ${r.records.length} comments (${bots} bot) from ${r.changes} merged changes`);
  }
  console.log(`wrote ${values.out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof FetchError)) throw e;
    console.error(`fetch-reviews: ${e.message}`);
    process.exit(1);
  }
}
