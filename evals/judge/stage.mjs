#!/usr/bin/env node
// Builds one reviewer workspace per held-out change and arm: the diff at the commit the
// first human review comment points at, a link to the clone, and for the standards arms
// a copy of the skills a user would have installed. Names stay neutral, so a reviewer
// cannot tell which arm it is in or that it is being measured.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ARMS, JudgeError, SKILL_DIR, args, main, need, readJson, run, writeAtomic, writeJson } from './lib.mjs';

const USAGE =
  'usage: stage.mjs --repo <owner/name> --clone <dir> --data <dir> --workspace <dir> [--arms none,A,B] [--standards-a <dir>] [--standards-b <dir>] [--repo-name <text>]';

const DIFF_BUDGET = 150000;
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|go\.sum|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$/;
const TEST_FILE = /(?:_test\.go|\.test\.[cm]?[jt]sx?|_test\.py|(?:^|\/)(?:testdata|fixtures|tests?)\/)/;

// Fits a large diff into a reviewer's context by a rule blind to where humans commented:
// lockfiles go first, then whole files are kept in diff order, source before tests, while
// they fit the budget. Every omitted file is listed so the reviewer can read it from the clone.
export function trimDiff(text, budget = DIFF_BUDGET) {
  if (text.length <= budget) return { text, omitted: [] };
  const files = text.split(/^(?=diff --git )/m).filter(Boolean).map((chunk) => ({ chunk, path: /^diff --git a\/(\S+)/.exec(chunk)?.[1] ?? '?' }));
  const order = [...files.filter((f) => !TEST_FILE.test(f.path)), ...files.filter((f) => TEST_FILE.test(f.path))];
  const kept = new Set();
  let used = 0;
  for (const f of order) {
    if (LOCKFILE.test(f.path) || used + f.chunk.length > budget) continue;
    kept.add(f);
    used += f.chunk.length;
  }
  const omitted = files.filter((f) => !kept.has(f)).map((f) => f.path);
  const note = `# This diff is too large to show whole. These files changed too, and are left out here:\n${omitted.map((p) => `#   ${p}`).join('\n')}\n# Read any of them with git show, as described in the request.\n`;
  return { text: note + files.filter((f) => kept.has(f)).map((f) => f.chunk).join(''), omitted };
}

const token = (repo, change, arm) => createHash('sha256').update(`${repo}#${change}#${arm}`).digest('hex').slice(0, 10);

function diffAt(repo, data, change) {
  const file = join(data, 'heldout', 'diffs', `${change.number}.diff`);
  if (!existsSync(file)) {
    const r = run('gh', ['api', '-H', 'Accept: application/vnd.github.v3.diff', `repos/${repo}/compare/${change.base_sha}...${change.reviewed_commit}`]);
    writeAtomic(file, r.stdout);
  }
  return file;
}

function ensureCommit(clone, change) {
  const has = () => run('git', ['cat-file', '-e', `${change.reviewed_commit}^{commit}`], { cwd: clone, allowFail: true }).status === 0;
  if (has()) return true;
  run('git', ['fetch', '-q', 'origin', `+refs/pull/${change.number}/head:refs/remotes/origin/pr/${change.number}`], { cwd: clone, allowFail: true });
  if (has()) return true;
  run('git', ['fetch', '-q', 'origin', change.reviewed_commit], { cwd: clone, allowFail: true });
  return has();
}

function prompt({ dir, repoName, commit, arm }) {
  const lines = [
    `Please review a pull request to ${repoName}.`,
    '',
    `- The change is in ${dir}/change.diff, the pull request's diff against its base branch at commit ${commit}.`,
    `- ${dir}/repo is a clone of the repository. Read any file as it stands in this change with \`git -C ${dir}/repo show ${commit}:<path>\`. Do not check out, edit or build anything there.`,
  ];
  if (arm !== 'none') {
    lines.push(
      `- The repository's coding standards are installed as skills in ${dir}/skills/. Review the change with the standards skill's review command: read ${dir}/skills/standards/SKILL.md and follow its review reference. Use change.diff as the diff, and the standards skills under ${dir}/skills/ as the standards.`,
    );
  }
  lines.push(
    '',
    'Review it the way a careful maintainer of this repository would. Report each problem you would raise as an inline review comment, whatever its size: bugs, design and API problems, naming, style and convention issues, missing tests or docs. Skip praise and summaries of what the code does.',
    '',
    `Write your findings to ${dir}/findings.json as JSON in this shape:`,
    '',
    '```json',
    '{"findings": [{"file": "path/from/repo/root.go", "line": 123, "message": "What is wrong and what to do instead.", "section": null}]}',
    '```',
    '',
    '`line` is the line number in the new version of the file. `section` is the standards § the finding applies, such as "§2.1", or null when none applies. An empty list is a valid answer. When the file is written, reply with only the word done.',
  );
  return lines.join('\n') + '\n';
}

function stage(argv) {
  const { values } = args(
    argv,
    {
      repo: { type: 'string' },
      clone: { type: 'string' },
      data: { type: 'string' },
      workspace: { type: 'string' },
      'standards-a': { type: 'string' },
      'standards-b': { type: 'string' },
      'repo-name': { type: 'string' },
      arms: { type: 'string', default: ARMS.join(',') },
    },
    USAGE,
  );
  const arms = values.arms.split(',').filter(Boolean);
  const unknown = arms.filter((a) => !ARMS.includes(a));
  if (unknown.length) throw new JudgeError(`unknown arm ${unknown.join(', ')}; arms are ${ARMS.join(', ')}\n${USAGE}`);
  need(values, ['repo', 'clone', 'data', 'workspace', ...arms.filter((a) => a !== 'none').map((a) => `standards-${a.toLowerCase()}`)], USAGE);
  const { repo, data } = values;
  const clone = resolve(values.clone);
  const workspace = resolve(values.workspace);
  const repoName = values['repo-name'] ?? repo;
  const split = readJson(join(data, 'split.json'));
  const standards = Object.fromEntries(arms.filter((a) => a !== 'none').map((a) => [a, resolve(values[`standards-${a.toLowerCase()}`])]));
  const manifest = {};
  let missingSource = 0;

  for (const change of split.heldout) {
    const full = diffAt(repo, data, change);
    const trimmed = trimDiff(readFileSync(full, 'utf8'));
    const diff = join(data, 'heldout', 'diffs', `${change.number}.review.diff`);
    writeAtomic(diff, trimmed.text);
    const source = ensureCommit(clone, change);
    if (!source) missingSource++;
    for (const arm of arms) {
      const id = token(repo, change.number, arm);
      const dir = join(workspace, `cr-${id}`);
      // Rebuilt from scratch every run, so a stale copy of older standards never survives.
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      cpSync(diff, join(dir, 'change.diff'));
      symlinkSync(clone, join(dir, 'repo'));
      if (arm !== 'none') {
        cpSync(SKILL_DIR, join(dir, 'skills', 'standards'), { recursive: true });
        for (const skill of readdirSync(standards[arm], { withFileTypes: true })) {
          if (skill.isDirectory()) cpSync(join(standards[arm], skill.name), join(dir, 'skills', skill.name), { recursive: true });
        }
      }
      const text = prompt({ dir, repoName, commit: change.reviewed_commit, arm });
      writeFileSync(join(dir, '.prompt.md'), text);
      manifest[id] = { change: change.number, arm, dir, diff_chars: trimmed.text.length, omitted_files: trimmed.omitted.length, source_available: source };
      writeAtomic(join(data, 'review', arm, `${change.number}.prompt.md`), text);
    }
  }
  writeJson(join(data, 'review', 'manifest.json'), manifest);
  const sizes = Object.values(manifest).filter((m) => m.arm === 'none').map((m) => m.diff_chars).sort((a, b) => a - b);
  console.log(`${Object.keys(manifest).length} workspaces under ${workspace}`);
  console.log(`diff chars: min ${sizes[0]}, median ${sizes[Math.floor(sizes.length / 2)]}, max ${sizes.at(-1)}; commits missing from clone: ${missingSource}`);
}

main(stage, import.meta.url, USAGE);
