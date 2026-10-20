#!/usr/bin/env node
// Picks the held-out changes and the mining set for one repo, so no mined comment can
// describe code the held-out reviews will see.
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JudgeError, args, ghJson, main, need, readJson, readJsonl, run, script, tally, writeJson, writeJsonl } from './lib.mjs';

const USAGE =
  'usage: split.mjs --repo <owner/name> --clone <dir> --data <dir> [--heldout 20] [--min-comments 2] [--mine-cap 400] [--max-window 1500]';
const STEP = 100;

const isReviewer = (r, author) => !r.author_is_bot && r.author !== author;

// The pull list is snapshotted once, so every later step sees the same changes in the same order.
function ensurePrs(file, repo, want) {
  const snap = existsSync(file) ? readJson(file) : { repo, pages: 0, exhausted: false, prs: [] };
  while (snap.prs.length < want && !snap.exhausted) {
    const page = ghJson(`repos/${repo}/pulls?state=closed&sort=created&direction=desc&per_page=100&page=${snap.pages + 1}`);
    snap.pages++;
    for (const p of page) {
      if (!p.merged_at) continue;
      snap.prs.push({
        number: String(p.number),
        author: p.user?.login ?? 'ghost',
        created_at: p.created_at,
        merged_at: p.merged_at,
        base_sha: p.base?.sha ?? null,
        head_sha: p.head?.sha ?? null,
        title: p.title,
      });
    }
    if (page.length < 100) snap.exhausted = true;
    writeJson(file, snap);
  }
  return snap;
}

function fetchWindow(clone, out, repo, limit) {
  run(process.execPath, [script('fetch-reviews.mjs'), '--out', out, '--limit', String(limit)], { cwd: clone });
  const cacheDir = join(`${out}.cache`, `gh-github.com-${repo.replaceAll('/', '_')}`);
  if (!existsSync(cacheDir)) throw new JudgeError(`fetch-reviews left no cache at ${cacheDir}; its cache layout changed`);
  return new Set(readdirSync(cacheDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
}

function split(argv) {
  const { values } = args(
    argv,
    {
      repo: { type: 'string' },
      clone: { type: 'string' },
      data: { type: 'string' },
      heldout: { type: 'string', default: '20' },
      'min-comments': { type: 'string', default: '2' },
      'mine-cap': { type: 'string', default: '400' },
      'max-window': { type: 'string', default: '1500' },
    },
    USAGE,
  );
  need(values, ['repo', 'clone', 'data'], USAGE);
  const [heldoutN, minComments, mineCap, maxWindow] = ['heldout', 'min-comments', 'mine-cap', 'max-window'].map((k) => Number(values[k]));
  const { repo } = values;
  const [clone, data] = [resolve(values.clone), resolve(values.data)];
  const prsFile = join(data, 'prs.json');
  const reviewsFile = join(data, 'reviews.jsonl');
  const previous = existsSync(join(data, 'split.json')) ? readJson(join(data, 'split.json')).window : STEP;

  for (let window = previous; ; window += STEP) {
    if (window > maxWindow) throw new JudgeError(`no split within ${maxWindow} merged changes`);
    const snap = ensurePrs(prsFile, repo, window);
    const prs = snap.prs.slice(0, window);
    // Changes merged after the snapshot push the live list down, so fetch a little past the window.
    let unread = prs;
    for (let extra = 0; unread.length && extra <= 100; extra += 20) {
      const read = fetchWindow(clone, reviewsFile, repo, prs.length + extra);
      unread = prs.filter((p) => !read.has(p.number));
    }
    if (unread.length) throw new JudgeError(`fetch-reviews never read ${unread.map((p) => p.number).join(', ')}`);

    const byChange = new Map(prs.map((p) => [p.number, []]));
    for (const r of readJsonl(reviewsFile)) byChange.get(r.change)?.push(r);
    const inline = (p) => byChange.get(p.number).filter((r) => r.kind === 'inline-comment' && isReviewer(r, p.author));

    const qualifying = prs.filter((p) => inline(p).length >= minComments).sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1));
    if (qualifying.length < heldoutN) {
      if (snap.exhausted && window >= snap.prs.length) throw new JudgeError(`only ${qualifying.length} qualifying changes in the whole history`);
      continue;
    }
    const heldout = qualifying.slice(0, heldoutN);
    const cutoff = heldout.map((p) => p.created_at).sort()[0];
    const eligible = prs.filter((p) => p.merged_at < cutoff).sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1));
    if (eligible.length < mineCap && !(snap.exhausted && window >= snap.prs.length)) continue;
    const mining = eligible.slice(0, mineCap);

    const graded = [];
    const heldoutRows = heldout.map((p) => {
      const comments = inline(p).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      const commit = comments[0].commit;
      const onCommit = comments.filter((c) => c.commit === commit);
      graded.push(...onCommit);
      return {
        number: p.number,
        title: p.title,
        author: p.author,
        created_at: p.created_at,
        merged_at: p.merged_at,
        base_sha: p.base_sha,
        reviewed_commit: commit,
        reviewer_inline_comments: comments.length,
        graded_comments: onCommit.length,
        reviewers: tally(comments, (c) => c.author),
      };
    });
    const mineSet = new Set(mining.map((p) => p.number));
    const authorOf = new Map(prs.map((p) => [p.number, p.author]));
    const mined = readJsonl(reviewsFile).filter((r) => mineSet.has(r.change));
    const minedReviewer = mined.filter((r) => isReviewer(r, authorOf.get(r.change)));

    writeJsonl(join(data, 'mine', 'reviews.jsonl'), mined);
    writeJsonl(join(data, 'heldout', 'reviews.jsonl'), graded);
    const result = {
      repo,
      window,
      cutoff,
      rules: { heldout: heldoutN, min_reviewer_inline_comments: minComments, mine_cap: mineCap, mine_merged_before: 'oldest held-out created_at' },
      heldout: heldoutRows,
      mining: {
        changes: mining.length,
        newest_merged: mining[0]?.merged_at ?? null,
        oldest_merged: mining.at(-1)?.merged_at ?? null,
        records: mined.length,
        reviewer_records: minedReviewer.length,
        changes_with_reviewer_comments: new Set(minedReviewer.map((r) => r.change)).size,
      },
      reviewers: {
        mining: tally(minedReviewer, (r) => r.author),
        heldout_graded: tally(graded, (r) => r.author),
      },
      skipped_between: prs.filter((p) => p.merged_at >= cutoff && !heldout.includes(p)).length,
    };
    writeJson(join(data, 'split.json'), result);
    const share = (t) => {
      const total = Object.values(t).reduce((a, b) => a + b, 0);
      const [top, n] = Object.entries(t).sort((x, y) => y[1] - x[1])[0] ?? ['none', 0];
      return `${total} comments, ${Object.keys(t).length} reviewers, top ${top} ${Math.round((100 * n) / (total || 1))}%`;
    };
    console.log(`window ${window} merged changes, cutoff ${cutoff}`);
    console.log(`held out ${heldout.length} changes, ${graded.length} graded comments (${share(result.reviewers.heldout_graded)})`);
    console.log(`mining ${mining.length} changes, ${minedReviewer.length} reviewer records (${share(result.reviewers.mining)})`);
    console.log(`wrote ${join(data, 'split.json')}`);
    return;
  }
}

main(split);
