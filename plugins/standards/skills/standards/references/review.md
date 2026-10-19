# review

Applies every lens a diff triggers and reports each confirmed violation with its § cited. A finding that names its § lets the author read the rule, the why and the evidence before arguing with it.

Run from the target repo's root. No script covers this command, because matching a heuristic to code is a judgment.

## Scope

Accepts any form. See [scope](scope.md) for the forms and how to resolve them. A path or glob keeps only the changed files it matches, at step 3. An area or § applies only those lenses, at step 3. Scope combines with the diff source from step 1: the branch, pull request or commit still sets the diff, and the scope narrows it.

## Step 1. Get the diff

Pick the diff from the request:

| Request names | Diff |
| --- | --- |
| Nothing | The current branch against its merge base with the default branch, plus uncommitted changes: `git diff $(git merge-base HEAD <default-branch>)`. |
| A pull or merge request | Its diff from the forge's CLI, such as `gh` or `glab`. With no forge, fetch its branch with `git fetch` and diff it against its merge base. |
| A commit or a range | `git diff <from>..<to>`, or `git show <commit>`. |

Find the default branch with `git symbolic-ref refs/remotes/origin/HEAD`, and ask the user when that fails. Guessing the branch name diffs against the wrong base.

When you wrote the diff yourself, spawn a fresh subagent to run steps 2 to 5. An author reads intent into code that a reader would not see.

## Step 2. Find the standards

Find every `SKILL.md` in the repo whose frontmatter `metadata` holds `generator: standards`. Shape A gives one such skill, and shape B gives one per area. Use them all.

When there are none, ask the user for the path of their standards. When they have none, offer `mine`, and stop.

## Step 3. Pick the lenses the diff triggers

1. List the changed paths with `git diff --name-only` over the same range.
2. For each § in the index, open its file and read its "Applies to" globs and its "Triggers" line.
3. A § triggers when a changed path matches one of its globs and the change is an edit kind its Triggers line names.

Load only the triggered § files. Every extra § costs context and invites findings about code the diff never touched.

## Step 4. Apply each lens

For each triggered §, check its heuristics against the added and changed lines of each matching file. Read enough of the surrounding file to judge each match. A heuristic match is a candidate, not yet a finding.

## Step 5. Confirm each candidate

Hold each candidate to its § "Confirmed when" bar. Drop any candidate that falls short, and drop any that a comment, a test or the § itself marks as an intended exception. A false positive teaches the team to skim past the next real finding.

Set each finding's severity from the § failure model, using the vector it matches.

Done when every candidate is either confirmed or dropped against its bar.

## Step 6. Report

Write one line per finding, sorted by severity, blockers first:

```text
§3.1 major src/api/users.ts:42 The handler returns the database document, so internal fields reach the client. Map it to a response DTO first.
§1.2 minor src/jobs/sync.ts:17 The retry loop has no limit, so a bad record retries forever. Cap it, as §1.2 shows.
```

After the findings, give the count of triggered lenses and the count of findings. When nothing is confirmed, say so plainly and name the lenses applied, so the author knows what was checked.

Post findings to the forge only when the user asks. The user decides what reaches reviewers.
