# mine

Pulls a repo's review history, labels each comment by the convention it enforces, and ranks the conventions by frequency times severity. The output, `.standards/clusters.json`, is what `write` turns into standards.

Run every step from the target repo's root. Every work file goes in `.standards/` there. Keep that folder out of version control, because review comments quote code and people the repo never meant to publish.

`<skill-dir>` below is the folder that holds this skill's `SKILL.md`. Each step names a script that does it faster. When a script is missing or exits non-zero, do the step by hand and write the same file, which the step's schema defines. Every step overwrites its own output, so rerunning a step converges on the same file.

## Step 1. Fetch review comments

Output `.standards/reviews.jsonl`, one comment per line, per [the reviews schema](schemas/fetch-reviews.reviews.schema.json).

Script: `node <skill-dir>/scripts/fetch-reviews.mjs --out .standards/reviews.jsonl`. It finds the forge's CLI, such as `gh` or `glab`, and falls back to `git log` when no forge answers.

By hand:

1. Check for the forge's CLI and run its auth status command. A CLI that is missing or signed out counts as no forge.
2. With a forge, list every merged pull or merge request. For each one, fetch its inline review comments, its review bodies and its thread replies. Page through every result, because the first page holds only a slice of the history.
3. With no forge, run `git log` over the default branch with full messages. Keep each commit whose message says it addresses review feedback, such as "address review", "per review" or "review fixes". Record it as kind `commit`, with the commit's diff as `diff_hunk`. This finds fewer conventions than a forge, so say so in the report.
4. Write one JSON object per line. Set `author_is_bot` for apps and bot accounts.

Done when every merged change the forge lists, or every commit on the default branch, has been read, and every line validates against the schema. Report the counts of comments, changes and bot comments.

## Step 2. Draft the label set

Output `.standards/labels.json`, a JSON array of `{ "id": "kebab-case-slug", "description": "One sentence naming the convention." }`. `scripts/questions.mjs` reads it.

1. Drop bot comments. They repeat rules their tool already enforces, so they add no convention a person had to defend.
2. Read at least 100 human comments, or all of them when there are fewer. Spread the sample across the history and across directories, so one busy area does not set the labels.
3. Name each distinct convention the reviewers ask for, at the level one rule could state. "Map database documents to DTOs before they leave a handler" is the right level. "Naming" is too broad to act on, and "rename this variable" is one site.
4. Merge labels that a single rule would cover. Aim for 10 to 40 labels. Too broad, and a cluster holds conventions no single rule states. Too narrow, and one convention splits into clusters under the minimum count of 3.

Done when every comment in the sample fits a label or is plainly not a convention.

## Step 3. Write the questions

Output `.standards/questions.jsonl`, per [the questions schema](schemas/questions.questions.schema.json).

Script: `node <skill-dir>/scripts/questions.mjs ask --reviews .standards/reviews.jsonl --labels .standards/labels.json --out .standards/questions.jsonl`.

By hand, write three questions for every human comment. Each one's `state` holds the comment body, its path, and its diff hunk when present.

| Topic | Kind | Prompt |
| --- | --- | --- |
| `convention` | `yesno` | Does this review comment ask for a change that applies to other code in this repo, not only to this line? |
| `label` | `choice` | Which convention does this review comment enforce? Options are every label id plus `none`. |
| `severity` | `score` | How much harm would ignoring this comment cause? Levels are `nit`, `minor`, `major`, `blocker`. |

Done when every human comment has exactly three questions.

## Step 4. Answer the questions

Output `.standards/answers.jsonl`, per [the answers schema](schemas/questions.answers.schema.json).

A judgment model is a fast model that answers typed questions (pick one of a set, a yes/no probability, a score) with calibrated probabilities. If your environment gives you a judgment model, answer the questions file with it; otherwise answer them yourself.

- Send a comment's three questions in one request when the judgment model accepts several, because they share one state.
- Record the model's ID in `model` and set `answered_by` to `judgment-model`.
- Keep answers whose question ids are unchanged since the last run. Re-asking costs time and money and returns the same answer.
- When you answer yourself, spawn subagents over batches of about 200 questions, so the comment text stays out of your own context. Give each answer an honest `confidence`.

Then check the answers.

Script: `node <skill-dir>/scripts/questions.mjs check --questions .standards/questions.jsonl --answers .standards/answers.jsonl`. It lists questions with no answer and answers with `confidence` under 0.6.

By hand, join the two files on question id with a short script and list the same two sets. Counting by eye misses gaps in a file this size.

Re-answer every listed question yourself, reading the comment's whole thread, and set `answered_by` to `agent`. Low-confidence answers are where a fast answerer is most often wrong, and they are few enough to read.

Done when every question has exactly one answer and the check lists nothing.

## Step 5. Cluster and rank

Output `.standards/clusters.json`, per [the clusters schema](schemas/cluster.clusters.schema.json).

Script: `node <skill-dir>/scripts/cluster.mjs --reviews .standards/reviews.jsonl --questions .standards/questions.jsonl --answers .standards/answers.jsonl --labels .standards/labels.json --out .standards/clusters.json`.

By hand, write a short script that does each of these, because the counts decide the ranking:

1. Keep a comment when its `convention` answer gives at least a 0.5 probability of yes and its `label` answer is not `none`.
2. Group the kept comments by label.
3. Weight each comment's severity level: `nit` 1, `minor` 2, `major` 3, `blocker` 4. A cluster's `severity` is the mean weight of its comments.
4. Move every cluster with fewer than 3 comments to `dropped`. One or two comments are one reviewer's opinion. Three show reviewers repeating themselves.
5. Set `score` to count times severity. Sort by score, highest first, and number `rank` from 1.
6. For each cluster, list every review id, change and path, and pick up to 5 examples that state the convention most plainly.

Done when `clusters.json` validates and its counts reconcile. Every human comment lands in exactly one group: under the convention threshold, labeled `none`, or kept. The three counts sum to the human comment count.

## Step 6. Report

Show the clusters as a table: rank, label, count, severity, score. Give the number of dropped clusters and the human comment count. Say whether a forge or `git log` supplied the comments, and how many answers came from a judgment model.

Offer `write` as the next command, and stop. `write` edits the repo, so the user decides when it runs.
