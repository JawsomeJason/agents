# mine

Pulls a repo's review history, labels each comment by the convention it enforces, and ranks the conventions by frequency times severity. The output, `.standards/clusters.json`, is what `write` turns into standards.

Run every step from the target repo's root. Every work file goes in `.standards/` there. Keep that folder out of version control, because review comments quote code and people the repo never meant to publish. Each script that writes there adds `.standards/.gitignore` holding `*` when the folder has none; by hand, write that file first.

`<skill-dir>` below is the folder that holds this skill's `SKILL.md`. Each step names a script that does it faster. When a script is missing or exits non-zero, do the step by hand and write the same file, which the step's schema defines. Every step overwrites its own output, so rerunning a step converges on the same file.

## Scope

Accepts a path or glob only. See [scope](scope.md) for the forms and how to resolve them. Keep only review comments whose `path` matches it, and drop the rest after step 1. An area or § is an error here: areas don't exist until `write` makes them. Say so, list the areas when standards exist, and stop.

## Step 1. Fetch review comments

Output `.standards/reviews.jsonl`, one comment per line, per [the reviews schema](schemas/fetch-reviews.reviews.schema.json).

Script: `node <skill-dir>/scripts/fetch-reviews.mjs --out .standards/reviews.jsonl`. It finds the forge's CLI, such as `gh` or `glab`, and falls back to `git log` when no forge answers.

- `--limit <n>` reads only the newest `n` merged changes, or the newest `n` review-fix commits under `git log`. Use it for a quick trial on a large repo.
- Each finished change is saved under `.standards/reviews.jsonl.cache/`, so a rerun after a failure skips the changes already read. `--refresh` ignores that cache and fetches everything again.

By hand:

1. Check for the forge's CLI and run its auth status command. A CLI that is missing or signed out counts as no forge.
2. With a forge, list every merged pull or merge request. For each one, fetch its inline review comments, its review bodies and its thread replies. Page through every result, because the first page holds only a slice of the history.
3. With no forge, run `git log` over the default branch with full messages. Keep each commit whose message says it addresses review feedback, such as "address review", "per review" or "review fixes". Record it as kind `commit`, with the commit's diff as `diff_hunk`, and as `change` the change number in its title or else its short hash, so each commit counts as one change. The log names who fixed the code, not who reviewed it, so the reviewer floor in step 5 counts commit authors instead; `clusters.json` says so with `reviewer_basis: commit-author`. This finds fewer conventions than a forge, so say so in the report.
4. Write one JSON object per line. Set `author_is_bot` for apps and bot accounts, and `change_author` to the login that opened the change.

Done when every merged change the forge lists, or every commit on the default branch, has been read, and every line validates against the schema. Report the counts of comments, changes and bot comments.

## Step 2. Draft the label set

Output `.standards/labels.json`, a JSON array of `{ "id": "kebab-case-slug", "description": "One sentence naming the convention." }`, per [the labels schema](schemas/questions.labels.schema.json). Ids are unique, and `none` is reserved. `scripts/questions.mjs` and `scripts/cluster.mjs` read it.

1. Drop bot comments, and comments by the change's own author. Bots repeat rules their tool already enforces, and an author answering review states no convention a reviewer defended.
2. Read at least 100 reviewer comments, or all of them when there are fewer. Spread the sample across the history and across directories, so one busy area does not set the labels.
3. Name each distinct convention the reviewers ask for, at the level one rule could state. "Map database documents to DTOs before they leave a handler" is the right level. "Naming" is too broad to act on, and "rename this variable" is one site.
4. Merge labels that a single rule would cover. Aim for 10 to 40 labels. Too broad, and a cluster holds conventions no single rule states. Too narrow, and one convention splits into clusters too small to keep.

Done when every comment in the sample fits a label or is plainly not a convention.

## Step 3. Write the questions

Output `.standards/questions.jsonl`, per [the questions schema](schemas/questions.questions.schema.json).

Script: `node <skill-dir>/scripts/questions.mjs ask --reviews .standards/reviews.jsonl --labels .standards/labels.json --out .standards/questions.jsonl`.

By hand, write two questions for every reviewer comment: human, and not by the change's author. Each one's `state` holds the comment body, its path, and its diff hunk when present.

| Topic | Kind | Prompt |
| --- | --- | --- |
| `label` | `choice` | Which convention does this review comment enforce? Options are every label id plus `none`, each with its description in `option_descriptions`. |
| `severity` | `score` | How much harm would ignoring this comment cause? Levels are `nit`, `minor`, `major`, `blocker`, each with the situation it describes in `level_descriptions`. |

A comment is a convention when its label is not `none`. There is no separate yes/no question on whether a comment generalizes: answerers disagree on it, and a strict gate hides comments that a label already shows to be rule-shaped.

Done when every reviewer comment has exactly two questions.

## Step 4. Answer the questions

Output `.standards/answers.jsonl`, per [the answers schema](schemas/questions.answers.schema.json).

If your environment gives you a judgment model, as [SKILL.md](../SKILL.md#judgment-model) defines it, answer the questions file with it; otherwise answer them yourself.

- Send a comment's two questions in one request when the judgment model accepts several, because they share one state.
- Record the model's ID in `model` and set `answered_by` to `judgment-model`.
- Set `confidence` to the probability of the chosen answer: for a choice or score, the chosen option's or level's probability. A model's own confidence figure may measure how concentrated the whole distribution is, which is not the chance this answer is right, and the check's threshold assumes the latter.
- Keep answers whose question ids are unchanged since the last run. Re-asking costs time and money and returns the same answer. A label question's id carries a hash of the label set, so adding, removing or rewording a label asks every label question again: a comment answered `none` before its label existed must get the chance to join it. Severity question ids do not change.
- When you answer yourself, spawn subagents over batches of about 200 questions, so the comment text stays out of your own context. Give each answer an honest `confidence`.

Then check the answers.

Script: `node <skill-dir>/scripts/questions.mjs check --questions .standards/questions.jsonl --answers .standards/answers.jsonl`. It lists questions with no answer, answers to unknown questions, second answers to one question, and answers that are not one of the question's options or levels, and it exits non-zero while anything is listed.

By hand, join the two files on question id with a short script and list the same sets. Counting by eye misses gaps in a file this size.

Done when every question has exactly one answer and the check lists nothing. Low-confidence answers are handled after step 5, because only the clusters show which of them matter.

## Step 5. Cluster and rank

Output `.standards/clusters.json`, per [the clusters schema](schemas/cluster.clusters.schema.json).

Script: `node <skill-dir>/scripts/cluster.mjs --reviews .standards/reviews.jsonl --questions .standards/questions.jsonl --answers .standards/answers.jsonl --labels .standards/labels.json --out .standards/clusters.json`.

By hand, write a short script that does each of these, because the counts decide the ranking:

1. Keep a comment when its `label` answer is not `none`.
2. Group the kept comments by label.
3. Weight each comment's severity level: `nit` 1, `minor` 2, `major` 3, `blocker` 4. A cluster's `severity` is the mean weight of its comments.
4. Move every cluster whose comments come from fewer than 3 distinct changes, or from fewer than 2 distinct reviewers, to `dropped`. Count changes, not comments: five comments on one change are one review of one piece of code. Count reviewers too: one person repeating a request across changes is that person's taste, while a second reviewer asking the same shows a convention.
5. Set `score` to count times severity. Sort by score, highest first, and number `rank` from 1.
6. For each cluster, list every review id, change, reviewer and path, and pick up to 5 examples that state the convention most plainly.

Then re-answer what can change a cluster. Low-confidence answers are where a fast answerer is most often wrong, but most of them cannot move any cluster, and re-reading those costs time for nothing. List every judgment-model answer with `confidence` under 0.6 that a different answer could change:

- every label answer, because a different label moves the comment into, out of or between clusters;
- severity answers only for comments kept in a cluster that survives item 4 above, because elsewhere severity changes no score.

The script writes this list to `reanswer` in `clusters.json` and prints it. Re-answer each listed question yourself, reading the comment's whole thread, and set `answered_by` to `agent`. An agent's answer is final: it is never listed again, so the loop ends. Then rerun this step, because a changed label can make a cluster survive and bring its severity answers into the list.

Done when `clusters.json` validates, its counts reconcile, and `reanswer` is empty. Every reviewer comment lands in exactly one group: labeled `none`, or kept. The two counts sum to the reviewer comment count.

## Step 6. Report

Show the clusters as a table: rank, label, count, severity, score. Give the number of dropped clusters and the reviewer comment count. Say whether a forge or `git log` supplied the comments, and how many answers came from a judgment model.

Offer `write` as the next command, and stop. `write` edits the repo, so the user decides when it runs.
