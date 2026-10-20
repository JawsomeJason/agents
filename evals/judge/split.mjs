#!/usr/bin/env node
// Picks the held-out changes and the mining set for one repo, so no mined comment can
// describe code the held-out reviews will see.
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JudgeError, args, ghJson, main, need, readJson, readJsonl, run, script, tally, writeJson, writeJsonl } from './lib.mjs';

const USAGE =
  'usage: split.mjs --repo <owner/name> --clone <dir> --data <dir> [--heldout 20] [--min-comments 2] [--mine-cap 400] [--max-window 1500] [--max-per-author 2] [--max-per-series 2] [--max-reviewer-share 0.5]';
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
        base_ref: p.base?.ref ?? null,
        head_ref: p.head?.ref ?? null,
        default_branch: p.base?.repo?.default_branch ?? null,
        title: p.title,
      });
    }
    if (page.length < 100) snap.exhausted = true;
    writeJson(file, snap);
  }
  return snap;
}

// A series is a run of changes one author split one piece of work into. Two signals mark one:
// a stacked base, where a change's base branch is another change's head branch rather than the
// default branch, and a shared title prefix before a part number, such as "Feature stack 3/8:"
// or "Feature (part 2)". Changes linked by either signal share a series. Snapshots written before
// branch names were recorded fall back to titles alone.
const PART = /^(.*?)[\s([]*(?:\b(?:part|pt\.?)\s*\d+\b|\b\d+\s*(?:\/|of)\s*\d+\b)/i;

export function titlePrefix(title) {
  const m = PART.exec(title ?? '');
  const prefix = m?.[1].replace(/[\s:([-]+$/, '').trim().toLowerCase();
  return prefix ? prefix : null;
}

export function seriesOf(prs) {
  const parent = new Map(prs.map((p) => [p.number, p.number]));
  const find = (x) => (parent.get(x) === x ? x : find(parent.get(x)));
  const join = (a, b) => parent.set(find(a), find(b));
  const byHead = new Map(prs.filter((p) => p.head_ref).map((p) => [`${p.author}\0${p.head_ref}`, p.number]));
  const byPrefix = new Map();
  for (const p of prs) {
    const stacked = p.base_ref && p.base_ref !== p.default_branch ? byHead.get(`${p.author}\0${p.base_ref}`) : undefined;
    if (stacked) join(p.number, stacked);
    const prefix = titlePrefix(p.title);
    if (prefix) {
      const key = `${p.author}\0${prefix}`;
      if (byPrefix.has(key)) join(p.number, byPrefix.get(key));
      else byPrefix.set(key, p.number);
    }
  }
  return new Map(prs.map((p) => [p.number, find(p.number)]));
}

const topShare = (counts) => {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const [reviewer, n] = Object.entries(counts).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0] ?? [null, 0];
  return { reviewer, share: total ? n / total : 0 };
};

// Picks the held-out changes newest first under the author and series caps. While one reviewer
// wrote more than maxShare of the graded comments, it swaps the selected change that reviewer
// dominates most for the newest unpicked change they do not dominate, which reaches further
// back in history. `graded` maps a change number to its graded comments.
export function chooseHeldout(qualifying, graded, series, { n, maxPerAuthor, maxPerSeries, maxShare }) {
  const perAuthor = new Map();
  const perSeries = new Map();
  const fits = (p) => (perAuthor.get(p.author) ?? 0) < maxPerAuthor && (perSeries.get(series.get(p.number)) ?? 0) < maxPerSeries;
  const add = (p, d) => {
    perAuthor.set(p.author, (perAuthor.get(p.author) ?? 0) + d);
    perSeries.set(series.get(p.number), (perSeries.get(series.get(p.number)) ?? 0) + d);
  };
  const picked = [];
  for (const p of qualifying) {
    if (picked.length === n) break;
    if (fits(p)) {
      picked.push(p);
      add(p, 1);
    }
  }
  const shares = () => topShare(tally(picked.flatMap((p) => graded.get(p.number)), (c) => c.author));
  const byReviewer = (p, r) => graded.get(p.number).filter((c) => c.author === r).length;
  const tried = new Set(picked.map((p) => p.number));
  let top = shares();
  while (picked.length === n && top.share > maxShare) {
    const out = [...picked].sort((a, b) => byReviewer(b, top.reviewer) - byReviewer(a, top.reviewer))[0];
    add(out, -1);
    const into = qualifying.find((p) => !tried.has(p.number) && fits(p) && byReviewer(p, top.reviewer) * 2 < graded.get(p.number).length);
    if (!into) {
      add(out, 1);
      break;
    }
    tried.add(into.number);
    picked[picked.indexOf(out)] = into;
    add(into, 1);
    const next = shares();
    if (next.share >= top.share && next.reviewer === top.reviewer) {
      picked[picked.indexOf(into)] = out;
      add(into, -1);
      add(out, 1);
      continue;
    }
    top = next;
  }
  picked.sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1));
  return { heldout: picked, top, diverse: picked.length === n && top.share <= maxShare };
}

function fetchWindow(clone, out, repo, limit) {
  run(process.execPath, [script('fetch-reviews.mjs'), '--out', out, '--limit', String(limit)], { cwd: clone });
  const cacheDir = join(`${out}.cache`, `gh-github.com-${repo.replaceAll('/', '_')}`);
  if (!existsSync(cacheDir)) throw new JudgeError(`fetch-reviews left no cache at ${cacheDir}; its cache layout changed`);
  return new Set(readdirSync(cacheDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
}

const shareOf = (counts) => {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Math.round((1000 * v) / (total || 1)) / 1000]));
};

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
      'max-per-author': { type: 'string', default: '2' },
      'max-per-series': { type: 'string', default: '2' },
      'max-reviewer-share': { type: 'string', default: '0.5' },
    },
    USAGE,
  );
  need(values, ['repo', 'clone', 'data'], USAGE);
  const [heldoutN, minComments, mineCap, maxWindow, maxPerAuthor, maxPerSeries, maxShare] = [
    'heldout',
    'min-comments',
    'mine-cap',
    'max-window',
    'max-per-author',
    'max-per-series',
    'max-reviewer-share',
  ].map((k) => Number(values[k]));
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
    // Graded comments are the reviewer inline comments on the commit the first one points at.
    const graded = new Map(
      qualifying.map((p) => {
        const comments = inline(p).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
        return [p.number, comments.filter((c) => c.commit === comments[0].commit)];
      }),
    );
    const canGrow = window + STEP <= maxWindow && !(snap.exhausted && window >= snap.prs.length);
    const choice = chooseHeldout(qualifying, graded, seriesOf(prs), { n: heldoutN, maxPerAuthor, maxPerSeries, maxShare });
    if (choice.heldout.length < heldoutN) {
      if (!canGrow) throw new JudgeError(`only ${choice.heldout.length} qualifying changes within the caps in ${window} merged changes`);
      continue;
    }
    if (!choice.diverse && canGrow) continue;
    const heldout = choice.heldout;
    const cutoff = heldout.map((p) => p.created_at).sort()[0];
    const eligible = prs.filter((p) => p.merged_at < cutoff).sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1));
    if (eligible.length < mineCap && canGrow) continue;
    const mining = eligible.slice(0, mineCap);

    const series = seriesOf(prs);
    const heldoutRows = heldout.map((p) => {
      const comments = inline(p);
      const onCommit = graded.get(p.number);
      return {
        number: p.number,
        title: p.title,
        author: p.author,
        series: series.get(p.number),
        created_at: p.created_at,
        merged_at: p.merged_at,
        base_sha: p.base_sha,
        reviewed_commit: onCommit[0].commit,
        reviewer_inline_comments: comments.length,
        graded_comments: onCommit.length,
        reviewers: tally(onCommit, (c) => c.author),
      };
    });
    const gradedRows = heldout.flatMap((p) => graded.get(p.number));
    const mineSet = new Set(mining.map((p) => p.number));
    const authorOf = new Map(prs.map((p) => [p.number, p.author]));
    const mined = readJsonl(reviewsFile).filter((r) => mineSet.has(r.change));
    const minedReviewer = mined.filter((r) => isReviewer(r, authorOf.get(r.change)));

    writeJsonl(join(data, 'mine', 'reviews.jsonl'), mined);
    writeJsonl(join(data, 'heldout', 'reviews.jsonl'), gradedRows);
    const result = {
      repo,
      window,
      cutoff,
      rules: { heldout: heldoutN, min_reviewer_inline_comments: minComments, mine_cap: mineCap, max_per_author: maxPerAuthor, max_per_series: maxPerSeries, max_reviewer_share: maxShare, mine_merged_before: 'oldest held-out created_at' },
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
        heldout_graded: tally(gradedRows, (r) => r.author),
        heldout_share: shareOf(tally(gradedRows, (r) => r.author)),
      },
      skipped_between: prs.filter((p) => p.merged_at >= cutoff && !heldout.includes(p)).length,
      diverse: choice.diverse,
    };
    writeJson(join(data, 'split.json'), result);
    const share = (t) => {
      const total = Object.values(t).reduce((a, b) => a + b, 0);
      const [top, n] = Object.entries(t).sort((x, y) => y[1] - x[1])[0] ?? ['none', 0];
      return `${total} comments, ${Object.keys(t).length} reviewers, top ${top} ${Math.round((100 * n) / (total || 1))}%`;
    };
    console.log(`window ${window} merged changes, cutoff ${cutoff}`);
    console.log(`held out ${heldout.length} changes, ${gradedRows.length} graded comments (${share(result.reviewers.heldout_graded)})`);
    console.log(`reviewer share of held-out comments: ${Object.entries(result.reviewers.heldout_share).map(([r, x]) => `${r} ${Math.round(100 * x)}%`).join(', ')}`);
    if (!choice.diverse) {
      console.warn(`warning: ${choice.top.reviewer} wrote ${Math.round(100 * choice.top.share)}% of the held-out comments, over ${Math.round(100 * maxShare)}%, and no further window diversified it`);
    }
    console.log(`mining ${mining.length} changes, ${minedReviewer.length} reviewer records (${share(result.reviewers.mining)})`);
    console.log(`wrote ${join(data, 'split.json')}`);
    return;
  }
}

main(split, import.meta.url);
