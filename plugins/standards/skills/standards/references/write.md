# write

Turns `.standards/clusters.json` into a standards skill inside the target repo. Every § states its rule, its why, and the review comments behind it, so a reader can trace each rule to where reviewers enforced it.

Run from the target repo's root. `<skill-dir>` is the folder that holds this skill's `SKILL.md`. No script covers this command, because each step is a judgment about the repo's code.

## Scope

Accepts an area slug or §. See [scope](scope.md) for the forms and how to resolve them. Write or refresh only that area: its index section and its § files. Leave every other area's files and § numbers untouched, because review comments cite them. A path or glob is an error here, because `write` works on areas, not files.

## Step 1. Read the inputs

1. Read `.standards/clusters.json`. When it is missing, stop and offer `mine`, because a § without mined evidence is a guess. When its `reanswer` list is not empty, stop and finish `mine` step 5, because those answers can still change which clusters exist. Its examples are cut short, so for each cluster also read the full comments and their whole threads in `.standards/reviews.jsonl`: the reviewer's reason often sits in a reply, and a later reply can narrow or reverse what the first comment asked for.
2. Look for standards this skill wrote before: a `SKILL.md` whose frontmatter `metadata` holds `generator: standards`. When one exists, update it in place, keep its § numbers, and read its `prune.json`.
3. Skip every cluster whose rule `prune.json` marks `delete`, unless a harness's default model has changed since that run. The run showed agents follow that rule unprompted, and writing it back would undo the measurement.

## Step 2. Give each convention one home

Find the repo's existing rules: agent instruction files such as `AGENTS.md`, each harness's own instruction file and rules folder, contributing guides, decision records, and the configs of its linters, formatters, type checkers and tests.

Sort each cluster into one status:

| Status | Meaning | Action |
| --- | --- | --- |
| `enforced` | A linter, type check, formatter or test already catches it. | No §. The tool is its home. |
| `documented` | A rules file that agents load when they write code states it with specifics, but no tool checks it. | No §, unless the user asks to move it. That file is its home. |
| `thin` | The only existing statement is a generic line, or it lives only in a reviewer-facing doc. | Write a §. The § becomes the home. |
| `missing` | Nothing states or checks it. | Write a §. |

A line is generic when it is one sentence with no specifics and no examples, such as "keep functions small" or "handle errors properly": it names the topic but not the rule the reviewers enforced, so an agent that reads it still writes the code the reviewers flagged. A reviewer-facing doc is one only a reviewer reads, such as a review checklist or a reviewing skill. An agent writing code never loads it, so it cannot be the convention's home for that agent.

For each `thin` cluster, name the thin home in the report: its file, its line, and why it is thin. Offer to replace that line with a one-line pointer to the new §, so the convention keeps one home instead of a generic copy that drifts from it. Make that edit only when the user agrees, because the file belongs to the repo, not to the standards.

Then mark each rule in the existing files `dead` when it names files, APIs or tools the repo no longer has.

Report a table of file, convention and status before writing anything, with each `thin` home named. A convention with two homes drifts, and an agent follows whichever copy it read first.

When a user invoked `write` interactively, wait for their go-ahead on the table, because a status they dispute changes which § files get written. Otherwise, such as under a script, a subagent or an unattended run, report the table and continue to step 3 without waiting. The step 8 report repeats it, so nothing is decided out of sight.

A `missing` or `thin` convention that a tool could check is a check candidate. Write its § anyway, so the convention is covered until the check exists, and list it in the report. A check fails every time, while a § works only when someone reads it.

## Step 3. Pick the output shape

Shape A is the default. Write one skill, named `<repo-slug>-standards`, with the index as its `SKILL.md` and one `references/s<area>-<n>-<slug>.md` file per §. An agent loads one short index and opens only the § files a change touches.

Shape B is the option. Write one skill per area, named `<repo-slug>-standards-<area>`, each with its own description, index and § files. Each area then triggers on its own, at the cost of one description per area held in context.

Write each shape B description so it loads its area and no other:

- Say what the area covers, by the file kinds its globs match and the code it governs, such as "HTTP handlers under `api/`".
- Name the edit kinds from its § Triggers lines as "Use when" triggers, such as adding an endpoint or changing a response type.
- Keep rule text out. The description decides when to load the skill, and the index carries the rules.
- Make each area's triggers distinct from every other area's, so one edit does not load two areas for one rule.
- Stay within 1024 characters.

Use B only when the user asks for it, or when a shape experiment on this repo picked it. See "Shape experiment" below.

Place the folder where the repo keeps its skills. When the repo has no skills folder, ask the user where it should go. `<repo-slug>` is the repository's name without its owner, lowercased, with every run of other characters as one hyphen, such as `cli` for `cli/cli`. The prefix keeps the generated skill from sharing a name with this one.

## Step 4. Number the rules

A cluster is one label, not always one rule. Before numbering, read each kept cluster's threads and decide which rules it holds:

- **Split** a cluster when its comments ask for conventions that one imperative sentence cannot state, such as three separate requests that share a topic. Write one rule per convention.
- **Pool** evidence across clusters when comments under another label ask for the same rule. A labeler picks one label per comment, so a rule's evidence can sit in two clusters.
- Each rule cites only the comments that ask for it, and each rule on its own needs comments from at least 3 distinct changes and 2 distinct reviewers, the same floor `mine` applies. A rule that falls under the floor after a split is left out and listed in the report as "too little evidence", because the floor is what keeps one reviewer's taste out of the standards.

1. Group the rules that survive into 1 to 8 areas, each one a part of the codebase or a kind of change, such as data access or error handling. Size the areas to the rules: a handful of rules may need only one or two areas, and an area of one rule is fine when no other rule shares its part of the code. Splitting few rules across many areas adds index headings, and in shape B whole descriptions, without helping an agent find a rule.
2. Order the areas by their best cluster rank, and number them §1, §2 and on. Within an area, number rules by rank: §1.1, §1.2.
3. When updating earlier standards, keep every existing number and append new rules at the end of their area. Review comments cite § numbers, and renumbering breaks those citations.
4. Break ties in rank, such as two rules split from one cluster, by more distinct changes in the rule's own evidence, then more comments, then higher mean severity, then the slug in alphabetical order. A fixed order keeps the numbers the same when `write` reruns.
5. Write each rule as one imperative sentence a person could follow without the § file.
6. End the index line with "Read first." when the one-liner cannot carry what following the rule needs: a named helper or type, an order of steps, or an exception the rule allows. Mark it too when the rule's default severity is `major` or `blocker`, because a miss there costs more than opening one file. This is a guess until `prune` measures it, and `prune` sets or clears the mark from its results.

## Step 5. Write each §

Copy [the section template](../assets/section.template.md) to `references/s<area>-<n>-<slug>.md` and replace every `{{ }}` placeholder.

- **Why.** Take it from the reviewers' own reasons in the evidence, read to the end of each thread. When a thread settles on something other than what its first comment asked, write the rule the thread settled on. When no comment gives a reason and you cannot state one the evidence supports, do not write the §. List it as "no why" in the report so the user can supply one. A rule without its reason fails as soon as the code around it changes shape.
- **Evidence.** Cite at least 3 of this rule's own comments, from its cluster or pooled from others, spanning at least 3 distinct changes and 2 distinct reviewers. Give each its change id, its path and a short excerpt. A review body or a commit has no path, so write `review body` or `commit` in the path's place, in the form the template shows. Never cite a comment that asks for a different rule from the same cluster.
- **Applies to.** Derive globs from the rule's evidence paths, using their shared directories and extensions. Run `git ls-files` and keep only globs that match at least one tracked file. A glob that matches nothing never triggers its lens.
- **Glob breadth.** No glob may match more than about 25% of the repo's tracked files of its kind: files with the glob's extension, or all tracked files when it names none. Count both with `git ls-files` and a short script. A glob that broad triggers its lens on almost every change, which loads the § and invites findings on code the rule never meant. Narrow the glob to the directories the evidence sits in. When the rule truly applies everywhere its file kind appears, write `Applies to: by trigger` instead, and make the Triggers line a pattern a reviewer can match against added lines, such as a call, an import or a type, so the trigger lives in the heuristic rather than the path.
- **Failure model.** Name each way the rule gets broken, with a default severity from the cluster's comments.
- **Examples.** Write both examples in the repo's language, against its real types and helpers, and check that each one compiles or parses. A broken example teaches the wrong code to every agent that copies it.
- **Heuristics.** Write patterns a reviewer can match against added lines, such as a call, an import or a missing step.
- **Confirmed when.** Set the bar for reporting a violation, and say what evidence of an intended exception clears it.

## Step 6. Write the index

Copy [the index template](../assets/index.template.md) to the skill folder as `SKILL.md`. List every § as its one-liner with a link to its file, and keep the `metadata` block so `review` and `doctor` can find this skill.

Fill `description` with the file kinds and edit kinds the globs cover, at most 1024 characters. The description decides when an agent loads the standards, so each area's edit kind belongs in it.

## Step 7. Check the output

When the source repo of this skill is at hand, run its lint on the generated folder: `node scripts/lint.mjs <generated-folder>`. Otherwise check by hand:

- Frontmatter uses only `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools`.
- `name` matches the folder, and the body of `SKILL.md` stays under about 5000 tokens, at 4 characters per token.
- Every link resolves inside the skill folder, and every § file has an index line.
- Every § has a why, at least 3 evidence lines, globs that match tracked files and none broader than about 25% of their kind, and a confirmed-when bar.
- No § carries a URL, a date, or a time-relative word outside a quoted excerpt, because each one goes stale while the rule still holds. A reviewer's quoted words stay verbatim, so the lint skips blockquotes for time words.

Done when every check passes.

## Step 8. Report

List the files written, the § count per area, the homes table from step 2 with each thin home and its pointer offer, the check candidates, any cluster left out for having no why, each cluster split into several rules or pooled into another, and any rule left out for too little evidence. Offer `prune` next, because a rule agents already follow costs tokens on every load and changes nothing.

## Shape experiment

Run it when the user wants to know whether shape B beats shape A on their repo.

1. Hold out the 20 newest merged changes that each have at least 2 inline comments from reviewers (not bots, not the change's author). Most merged changes get no inline comments, so the last 20 alone leave little to score. Run `mine` only on changes merged before the oldest held-out change was opened, so no mined comment describes code a held-out review will see. Write the standards against the repo as it stood then, for the same reason.
2. Write shape A and shape B from the same `clusters.json`, into two separate scratch folders.
3. For each held-out change, spawn three fresh reviewer subagents: one with no standards, and one per shape. Give each the change's diff as it stood at the commit the first reviewer comment points at, so fixes made in answer to review are not in it, plus only its own shape's standards. Have the shape reviewers run `review`. The no-standards reviewer is the baseline, because a shape that wins against the other shape but not against no standards adds nothing.
4. Score each shape on three numbers. Recall is the share of the human convention comments on the held-out changes that the reviewer also raised. False positives are findings no human raised and the confirmed-when bar does not support, per change. Tokens loaded are the characters of every standards file the reviewer read, divided by 4, per review.
5. Pick the winner. Higher recall wins. Recall within one caught comment across the 20 changes is a tie, settled by fewer false positives, then by fewer tokens. A tie on all three goes to A, because one description costs less context than many.

Report the three numbers for each shape and the winner. Use the winner's shape for this repo's standards from then on.
