# prune

Runs a baseline A/B per rule and deletes the rules agents follow without being told. A rule agents already follow costs context on every load and changes nothing. Each rule that survives keeps the cheapest form that still works.

Run from the target repo's root, on standards that `write` produced. No script covers this command. Write a short script to tally runs, because the decisions below turn on exact counts.

## Setup

**Pick the rules.** Probe every § unless the user names some. Show the user the plan first, with the rule count, the harnesses and the most runs it could take, because each run is a full agent session.

**Find the harnesses.** List every agent harness on this machine that can run one prompt non-interactively and exit. Ask the user when you cannot tell which ones they use. For each harness, record its command name, its version and the ID of the default model it runs on. Take the model ID from the harness's own output. When the harness does not report it, ask the user.

**Isolate every run.**

- Give each run a fresh temporary home directory. Copy in only what the harness needs to authenticate. User-level instruction files and skills would otherwise leak rules into the no-rule arm.
- Give each run a fresh `git worktree` of the target repo at HEAD, with the standards folder deleted from it. Only the arm's text should carry the rule.
- Run each harness on its default model. Users run the default, so that is the model a rule has to work on.
- Mark a harness that cannot authenticate or cannot run headless as skipped, with the reason. A skipped harness never counts as complying.

**Deliver the arm in the prompt.** Every harness reads its prompt, so the arms differ only in the rule text. Each prompt is the arm's text, a blank line, then the probe.

| Arm | Text before the probe |
| --- | --- |
| `none` | Nothing. |
| `one-liner` | `Project rule:` and the rule's index line. |
| `full` | `Project rule:` and the whole § file. |

## Step 1. Generate a probe

Write a probe task for the rule: a realistic change in this repo whose easiest solution breaks the rule. The probe never mentions the rule. A probe that names the rule measures reading, not following.

Run the probe once in the `none` arm and read the output. When the output never makes the kind of change the rule governs, the probe cannot test the rule. Rewrite it and try again. Do not count this trial run.

## Step 2. Run the arms

Run the arms `none`, `one-liner` and `full` in every harness that is not skipped, in the order step 3 sets. Keep each run's output: its final message and the diff of its worktree.

### Grade each output

Ask one yes/no question per output: "Does this output follow <rule>?", with the rule's one-liner in place of `<rule>`, and the § file and the output's diff as the state.

A judgment model is a fast model that answers typed questions (pick one of a set, a yes/no probability, a score) with calibrated probabilities. If your environment gives you a judgment model, grade with it; otherwise use the fallback grader below.

Calibrate a judgment model before trusting it:

1. Gather 30 outputs, spread across arms and harnesses.
2. Ask the user to label each one yes or no against the rule. Show the rule, the § and the diff for each.
3. Grade the same 30 with the judgment model. When it agrees with at least 27 of the 30 labels, 90%, it grades every run.
4. Record the labeled count, the agreed count and the agreement in `prune.json`.

When agreement falls under 90%, when there is no judgment model, or when the user declines to label, a fresh subagent that did not write the probe grades instead. Give it the rule, the § and the diff, and nothing about which arm produced the output. A grader that wrote the probe knows what it was trying to provoke, and a grader that knows the arm expects the rule to win. Say in the report which grader ran and why.

## Step 3. Sample sequentially

Each run costs a full agent session, so stop sampling a rule as soon as more runs cannot change its decision.

1. Run the `none` arm 5 times in each harness.
2. When `none` complied 5 of 5 in every harness, run it 5 more times in each. The rule then needs at least 9 of 10 in every harness to be deleted, at step 4.
3. When the rule is not deleted, run the `one-liner` arm 5 times in each harness. When it fails at most once in every harness, no arm can beat it by more than one failure, so stop.
4. Run the `full` arm 5 times in each harness only when the one-liner fails more than once in some harness.

## Step 4. Decide

1. **Delete** the rule when the `none` arm complied at least 90% of the time in every harness. With the batches above, that means 9 or 10 of 10.
2. Otherwise **keep the cheapest arm within one failure of the best** in every harness. The order from cheapest is `one-liner`, then `full`. The `none` arm counts only through the delete rule in step 4.1.
3. When even the best arm fails more than once in 5 in some harness, mark the rule **weak**. Keep the `full` arm, and report the rule as a check candidate. Agents miss it even with the whole § in front of them, so it belongs in a linter, a type or a test.

Apply each decision to the standards:

| Decision | Edit |
| --- | --- |
| `delete` | Remove the index line and the § file. Leave the § number unused, because review comments may cite it. |
| `one-liner` | No edit. The index line is enough. |
| `full` or `weak` | End the index line with "Read first.", so an agent opens the § before it edits a matching file. |

Show the planned edits as a diff, then apply them.

## Step 5. Write prune.json

Write `prune.json` into the standards folder, beside its `SKILL.md`, per [the prune schema](schemas/prune.schema.json). Record every harness with its model ID and status, every rule with its probe, tallies and decision, and every graded run with its harness, model ID and date.

A rule pruned on one model may be needed on the next one. `doctor` compares these model IDs with each harness's default and flags the record as stale when they differ. `write` reads the `delete` decisions so it does not write a deleted rule back.

Done when `prune.json` validates against the schema and its tallies match its runs.

Report a table of rule, decision and tallies per harness. Name the grader, its calibration result, and every skipped harness with its reason.
