# Judge harness

Measures whether standards mined from a repo's review history help a reviewer that never sees the human comments catch what those humans flagged. It holds out a repo's newest reviewed changes, mines standards from the older ones with the `standards` skill, has fresh reviewers review each held-out diff with no standards, with shape A and with shape B, and grades their findings against the human comments.

The scripts hold only code. Pass every data path with `--data`, and keep data outside this repo, because review comments quote people and code. Each step caches its output under `--data`, so a rerun resumes where the last one stopped and repeats no paid call. The scripts use the Node standard library and the forge CLI (`gh`), plus `git`.

## Steps

Run from anywhere. `$D` is the data folder for one repo and `$S` is `plugins/standards/skills/standards`.

1. **Clone.** `git clone <repo url> $D/clone`.
2. **Split.** `node split.mjs --repo <owner/name> --clone $D/clone --data $D`. It runs the skill's `fetch-reviews.mjs` over a growing window of merged changes until it finds the 20 newest merged changes with at least 2 reviewer inline comments (not a bot, not the change's author), then keeps up to 400 changes merged before the oldest of those was opened. It writes `split.json` (the held-out changes, the reviewed commit of each, and the reviewer distribution of both sets), `mine/reviews.jsonl` and `heldout/reviews.jsonl`. A held-out change is graded on the reviewer inline comments made against the commit its first one points at, because later comments may describe code the reviewed diff never had.
3. **Mine.** Follow `$S/references/mine.md` from step 2, with `$D/mine/` in place of `.standards/`. Answer `questions.jsonl` with whatever answerer the environment offers.
4. **Agreement.** `node agree.mjs sample --questions $D/mine/questions.jsonl --out $D/agree/sample.jsonl`, have a second answerer answer the sample into `$D/agree/answers.jsonl`, then `node agree.mjs compare --sample $D/agree/sample.jsonl --first $D/mine/answers.jsonl --second $D/agree/answers.jsonl --out $D/agree/result.json`.
5. **Write.** Follow `$S/references/write.md` into `$D/standards-A/`, against a checkout of the repo at the last trunk commit before the cutoff, so the writer sees none of the held-out code. Record each area's slug and description in `$D/areas.json` as `[{"section": "§1", "slug": "...", "description": "..."}]`, then `node shape-b.mjs --a $D/standards-A/<skill> --areas $D/areas.json --out $D/standards-B --repo-slug <slug>`. Lint both with `node scripts/lint.mjs <dir>`.
6. **Label the held-out comments** the way mine does: `node $S/scripts/questions.mjs ask --reviews $D/heldout/reviews.jsonl --labels $D/mine/labels.json --out $D/heldout/questions.jsonl`, then answer it into `$D/heldout/answers.jsonl` with the same answerer as step 3.
7. **Stage.** `node stage.mjs --repo <owner/name> --clone $D/clone --data $D --workspace <dir> --standards-a $D/standards-A --standards-b $D/standards-B`. It fetches each held-out diff at its reviewed commit and builds one workspace per change and arm, with neutral names, and writes `review/manifest.json` and each prompt to `review/<arm>/<change>.prompt.md`.
8. **Review.** For every workspace, spawn a fresh reviewer subagent with its `.prompt.md` as the whole prompt. Record each one's reported token use in `review/tokens.json` as `{"<workspace id>": tokens}`. Then `node grade.mjs collect --data $D`.
9. **Grade.** `node grade.mjs pairs --data $D` writes one yes/no question per finding and human comment on the same file within 10 lines. Answer `grade/pairs.questions.jsonl` into `grade/pairs.answers.jsonl`. `node grade.mjs calibrate --data $D` samples 30 pairs into `grade/calibration.json`; label each `same_concern` by hand and rerun it for the agreement. Below 0.9, have a fresh subagent answer the pairs instead, calibrate its file the same way with `--answers`, and score with it. `calibrate` writes `grade/calibration.result.json` for whichever file it was given, so copy it aside before calibrating a second grader.
10. **Score.** `node grade.mjs score --data $D` writes `grade/metrics.json` and `grade/metrics.md`: convention recall, all-comment recall, false positives per change and mean tokens, per arm.

## What the numbers mean

- A human comment is a convention comment when its `convention` answer gives at least 0.5 and its label is not `none`, the same rule `cluster.mjs` applies.
- A finding catches a human comment when the grader says they raise the same concern. A false positive is a finding that catches no human comment. Some false positives are real problems the humans missed, so the count is an upper bound on noise.
- An answer at exactly the threshold counts as its stated verdict, so an answerer's false at 0.5 is a no.
- Mean tokens is the reviewer's own reported token use per review, so it counts the diff and any source the reviewer read as well as the standards.
