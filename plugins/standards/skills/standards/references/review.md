# review

Adds a standards pass on top of an ordinary review: applies every lens a diff triggers and reports each confirmed violation with its § cited. A finding that names its § lets the author read the rule, the why and the evidence before arguing with it.

The pass never replaces the ordinary review. When it stood in for one, reviewers raised mostly § findings and missed real bugs and behavior problems that a plain review caught.

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

Then review the diff the ordinary way first, before opening any standards: bugs, behavior, design, tests and anything else a careful maintainer would raise. Skip this only when an ordinary review of this diff already exists, such as one the user supplied or one already in the reply. Keep those findings whole. The standards pass that follows only adds findings, because a reviewer primed with lenses stops looking for anything else.

## Step 2. Find the standards

Find every `SKILL.md` in the repo whose frontmatter `metadata` holds `generator: standards`. Shape A gives one such skill, and shape B gives one per area. Use them all.

When there are none, ask the user for the path of their standards. When they have none, offer `mine`, and stop.

## Step 3. Pick the lenses the diff triggers

1. List the changed paths with `git diff --name-only` over the same range.
2. For each § in the index, open its file and read its "Applies to" globs and its "Triggers" line.
3. A § triggers when a changed path matches one of its globs and the change is an edit kind its Triggers line names. A § whose Applies to line says `by trigger` triggers when the added lines of any changed file match the pattern its Triggers line names.

Note each triggered §'s default severity from its index line. Load only the triggered § files. Every extra § costs context and invites findings about code the diff never touched.

## Step 4. Apply each lens

For each triggered §, read its Rule sentence against every added hunk of each file its globs cover, and ask whether that hunk breaks it. The Rule sentence is the test. Its heuristics are leads that point at likely lines, never the gate: a hunk that no heuristic matches can still break the rule, because heuristics list the cases the evidence showed, and new code breaks rules in new ways. Read enough of the surrounding file, and of the sibling code the rule points at, to judge each hunk. A hunk that seems to break the rule is a candidate, not yet a finding.

## Step 5. Confirm each candidate

Hold each candidate to its § "Confirmed when" bar. Drop any candidate that falls short, and drop any that a comment, a test or the § itself marks as an intended exception. A false positive teaches the team to skim past the next real finding.

Set each finding's severity from the § failure model, using the vector it matches, or the § default severity when no vector fits. Report a confirmed violation at that severity even when it is a nit, and label it `nit`. Never drop a confirmed finding for being small: the standards exist because reviewers raised these points, so a small one is still one the team asked for.

Done when every candidate is either confirmed or dropped against its bar.

## Step 6. Report

Anchor each finding on the line the fix changes, such as the declaration of the function, parameter, type or name to change, rather than a line where the symptom shows. When the fix reaches other lines, name those call sites in the message. An author fixes the line a finding points at, so a finding on the symptom gets the symptom patched.

Report the ordinary review's findings first, unchanged: never drop, merge away or shorten one because the standards pass covers the same line. When a § finding and an ordinary finding name the same problem, keep the ordinary one and add the § to it.

Then list the standards pass's findings under a heading `Standards pass`, so the reader can tell them apart. Write one line per finding, sorted by severity, blockers first, nits last:

```text
§3.1 major src/api/users.ts:42 The handler returns the database document, so internal fields reach the client. Map it to a response DTO first.
§1.2 minor src/jobs/sync.ts:17 The retry loop has no limit, so a bad record retries forever. Cap it, as §1.2 shows.
§2.1 nit src/jobs/sync.ts:9 `refs` holds jobs, not references. Name it `jobs`, here and at lines 21 and 30.
```

End with a coverage list: one line per triggered §, naming the files it was applied to, then the count of findings. A § with no finding still gets its line, so the author knows what was checked and a skipped § shows:

```text
Applied §1.2 to src/jobs/sync.ts, src/jobs/retry.ts
Applied §2.1 to src/jobs/sync.ts
3 findings
```

Post findings to the forge only when the user asks. The user decides what reaches reviewers.
