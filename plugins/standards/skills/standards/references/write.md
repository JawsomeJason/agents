# write

Turns `.standards/clusters.json` into a standards skill inside the target repo. Every § states its rule, its why, and the review comments behind it, so a reader can trace each rule to where reviewers enforced it.

Run from the target repo's root. `<skill-dir>` is the folder that holds this skill's `SKILL.md`. No script covers this command, because each step is a judgment about the repo's code.

## Scope

Accepts an area slug or §. See [scope](scope.md) for the forms and how to resolve them. Write or refresh only that area: its index section and its § files. Leave every other area's files and § numbers untouched, because review comments cite them. A path or glob is an error here, because `write` works on areas, not files.

## Step 1. Read the inputs

1. Read `.standards/clusters.json`. When it is missing, stop and offer `mine`, because a § without mined evidence is a guess. Its examples are cut short, so for each cluster also read the full comments and their whole threads in `.standards/reviews.jsonl`: the reviewer's reason often sits in a reply, and a later reply can narrow or reverse what the first comment asked for.
2. Look for standards this skill wrote before: a `SKILL.md` whose frontmatter `metadata` holds `generator: standards`. When one exists, update it in place, keep its § numbers, and read its `prune.json`.
3. Skip every cluster whose rule `prune.json` marks `delete`, unless a harness's default model has changed since that run. The run showed agents follow that rule unprompted, and writing it back would undo the measurement.

## Step 2. Give each convention one home

Find the repo's existing rules: agent instruction files such as `AGENTS.md`, each harness's own instruction file and rules folder, contributing guides, decision records, and the configs of its linters, formatters, type checkers and tests.

Sort each cluster into one status:

| Status | Meaning | Action |
| --- | --- | --- |
| `enforced` | A linter, type check, formatter or test already catches it. | No §. The tool is its home. |
| `documented` | A rules file states it, but no tool checks it. | No §, unless the user asks to move it. That file is its home. |
| `missing` | Nothing states or checks it. | Write a §. |

Then mark each rule in the existing files `dead` when it names files, APIs or tools the repo no longer has.

Report a table of file, convention and status before writing anything. A convention with two homes drifts, and an agent follows whichever copy it read first.

A `missing` convention that a tool could check is a check candidate. Write its § anyway, so the convention is covered until the check exists, and list it in the report. A check fails every time, while a § works only when someone reads it.

## Step 3. Pick the output shape

Shape A is the default. Write one skill, named `<repo-slug>-standards`, with the index as its `SKILL.md` and one `references/s<area>-<n>-<slug>.md` file per §. An agent loads one short index and opens only the § files a change touches.

Shape B is the option. Write one skill per area, named `<repo-slug>-standards-<area>`, each with its own description, index and § files. Each area then triggers on its own, at the cost of one description per area held in context.

Use B only when the user asks for it, or when a shape experiment on this repo picked it. See "Shape experiment" below.

Place the folder where the repo keeps its skills. When the repo has no skills folder, ask the user where it should go. The prefix `<repo-slug>` keeps the generated skill from sharing a name with this one.

## Step 4. Number the rules

1. Group the `missing` clusters into 3 to 8 areas, each one a part of the codebase or a kind of change, such as data access or error handling.
2. Order the areas by their best cluster rank, and number them §1, §2 and on. Within an area, number rules by rank: §1.1, §1.2.
3. When updating earlier standards, keep every existing number and append new rules at the end of their area. Review comments cite § numbers, and renumbering breaks those citations.
4. Write each rule as one imperative sentence a person could follow without the § file.

## Step 5. Write each §

Copy [the section template](../assets/section.template.md) to `references/s<area>-<n>-<slug>.md` and replace every `{{ }}` placeholder.

- **Why.** Take it from the reviewers' own reasons in the evidence, read to the end of each thread. When a thread settles on something other than what its first comment asked, write the rule the thread settled on. When no comment gives a reason and you cannot state one the evidence supports, do not write the §. List it as "no why" in the report so the user can supply one. A rule without its reason fails as soon as the code around it changes shape.
- **Evidence.** Cite at least 3 comments from the cluster, each with its change id, its path and a short excerpt.
- **Applies to.** Derive globs from the cluster's paths, using their shared directories and extensions. Run `git ls-files` and keep only globs that match at least one tracked file. A glob that matches nothing never triggers its lens.
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
- Every § has a why, at least 3 evidence lines, globs that match tracked files, and a confirmed-when bar.
- No § carries a URL, a date, or a time-relative word, because each one goes stale while the rule still holds.

Done when every check passes.

## Step 8. Report

List the files written, the § count per area, the homes table from step 2, the check candidates, and any cluster left out for having no why. Offer `prune` next, because a rule agents already follow costs tokens on every load and changes nothing.

## Shape experiment

Run it when the user wants to know whether shape B beats shape A on their repo.

1. Hold out the last 20 merged changes. Run `mine` on the rest, removing the held-out changes from `reviews.jsonl` before step 2.
2. Write shape A and shape B from the same `clusters.json`, into two separate scratch folders.
3. For each held-out change, spawn two fresh reviewer subagents, one per shape. Give each the change's diff and only its shape's standards, and have it run `review`.
4. Score each shape on three numbers. Recall is the share of the human convention comments on the held-out changes that the reviewer also raised. False positives are findings no human raised and the confirmed-when bar does not support, per change. Tokens loaded are the characters of every standards file the reviewer read, divided by 4, per review.
5. Pick the winner. Higher recall wins. Recall within one caught comment across the 20 changes is a tie, settled by fewer false positives, then by fewer tokens. A tie on all three goes to A, because one description costs less context than many.

Report the three numbers for each shape and the winner. Use the winner's shape for this repo's standards from then on.
