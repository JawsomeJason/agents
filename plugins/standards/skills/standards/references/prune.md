# prune

Runs a baseline A/B per rule and deletes the rules agents follow without being told. A rule agents already follow costs context on every load and changes nothing. Each rule that survives keeps the cheapest form that still works.

Run from the target repo's root, on standards that `write` produced. `<skill-dir>/scripts/prune.mjs` carries the mechanics: isolation, the arms, the sampling, the tallies and the decisions, because the decisions turn on exact counts. Its subcommands map to the steps below, and every one resumes from the run folder it was given, so a stopped run loses nothing.

| Subcommand | Does |
| --- | --- |
| `plan` | Prints the rule count, the harnesses and the most runs the sampling could take. |
| `trial` | Runs one probe once in the `none` arm and keeps it apart from the counted runs (step 1). |
| `step` | Runs every batch the sampling still needs, then writes the grading questions (steps 2 and 3). |
| `status` | Prints each rule's tallies and what it waits on. |
| `questions` | Writes the grading questions for the runs on disk, and runs nothing. |
| `finish` | Applies the decision rules and writes `prune.json` (steps 4 and 5). |

Run `step`, grade, and run `step` again until `status` shows every rule decided, then `finish`. A rule moves one batch per `step`, because the next batch depends on how the last one graded.

## Scope

Accepts an area slug or §. See [scope](scope.md) for the forms and how to resolve them. Test only the scoped rules. State the scoped rule count in the plan and the reply, because the cost scales with the rule count.

## Setup

**Pick the rules.** Probe every § unless the user names some. Show the user the plan first, with the rule count, the harnesses and the most runs it could take, because each run is a full agent session.

**Find the harnesses.** List every agent harness on this machine that can run one prompt non-interactively and exit. Ask the user when you cannot tell which ones they use. For each harness, record its command name, its version and the ID of the default model it runs on. Take the model ID from the harness's own output. When the harness does not report it, ask the user. The runner has an adapter for each harness it knows, and reads the model ID from the run itself. Add a harness by adding an adapter.

**Isolate every run.**

- Give each run a fresh temporary home directory. Copy in only what the harness needs to authenticate. User-level instruction files and skills would otherwise leak rules into the no-rule arm. When a harness can take its login from an environment variable, pass it there and copy no login file, because a copy on disk can outlive the run. The runner keeps every temp home and login copy in one folder per process that only its owner can read, and removes it when the runner exits, fails, is interrupted or loses its terminal. Each agent runs under a small watchdog in its own process group, which kills the group at the run's timeout and as soon as the runner is gone, so no agent outlives the runner even when the runner is killed outright.
- Turn off what the harness loads from the user's account and settings: synced skills and plugins, user skills and commands, and tool servers. A fresh home does not stop a harness that downloads the account's skills when a session starts. The runner sets the switches each harness documents, but a switch proves nothing until a session shows it held. So each `run.json` records what its session reported loading under `loaded`, when the harness reports it. `trial` prints it, and warns when the session loaded any skill: a skill the user installed listed there means the no-rule arm is not clean. A harness that reports nothing records `loaded: null`, and its isolation rests on the fresh home alone; say so in the report.
- Give each run a fresh `git worktree` of the target repo at HEAD, with the standards folder deleted from it. Only the arm's text should carry the rule. The runner takes the worktrees from a one-commit clone with no remote, so an agent cannot read later history to find the change it was asked for.
- Run each harness on its default model. Users run the default, so that is the model a rule has to work on. When quota rules that out, pass `--model name=ID` to pin a harness to another model. The runs record the pin (`model_pinned`, with `pin_reason`), and the report says the decisions rest on a pinned model, not the default. An adapter that can only run one fixed model in a temp home records that model as pinned too, with its reason, because it is not what the harness's users get.
- Mark a harness that cannot authenticate or cannot run headless as skipped, with the reason. A skipped harness never counts as complying. Name the harnesses to run with `--harnesses`; every other harness the runner knows is recorded as skipped with the reason `not requested`, so it is not mistaken for a failure. Pass `--skip name:reason` for a harness that is installed but cannot run now. When a provider keeps refusing work for lack of quota, the runner halts that harness for the step and keeps the runs that finished. The runner reads a refusal only from the harness's error output and its final error or result event, never from the transcript, because the transcript quotes the target repo's files and those may mention rate limits. Later, drop the `--skip` and run `step` again: the runs that exist stay, and the harness catches up.
- Hand each agent only the environment it needs: `PATH`, `HOME`, `LANG`, `LC_ALL` and the POSIX `LC_` categories, `TERM`, `TMPDIR`, `USER`, `LOGNAME`, `SHELL`, the proxy settings (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY`, in either case), the CA settings (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `SSL_CERT_DIR`), what its harness needs to log in, and what `--env` names. Pass anything else a harness needs to start, such as a version manager's home, with `--env KEY=VALUE`. An agent runs the target repo's own agent config and scripts, so a forge token or a cloud key left in its environment is one prompt away from leaving the machine. Agents run with every permission check bypassed in harnesses that have one, and that is a deliberate decline of a narrower mode: a probe agent must edit files and run the target repo's own tests and toolchain, which no fixed tool list covers. What contains a run is a disposable worktree and the allowlisted environment above. Neither stops an agent from reading a file by its full path, such as another tool's login under the user's home. So prune only repos you trust, and run prune on a repo you do not trust inside a VM or a container.
- A run that ends with no change, a timeout or an error is not a run. The runner retries it up to 3 times, logs each failure in `failures.jsonl`, and counts only runs that left a diff outside the standards folder. An idle agent would otherwise count, and grade as compliant, because a diff that touches nothing the rule governs follows it.

**Deliver the arm in the prompt.** Every harness reads its prompt, so the arms differ only in the rule text. Each prompt is the arm's text, a blank line, then the probe.

| Arm | Text before the probe |
| --- | --- |
| `none` | Nothing. |
| `one-liner` | `Project rule:` and the rule's index line. |
| `full` | `Project rule:` and the whole § file. |

## Step 1. Generate a probe

Write a probe task for the rule: a realistic change in this repo whose easiest solution breaks the rule. The probe never mentions the rule. A probe that names the rule measures reading, not following. Save the probes in `probes.json` per [the probes schema](schemas/prune.probes.schema.json), one per §, each with the whole task text including how to finish.

Run `trial` for the probe, which runs it once in the `none` arm, and read the output. When the output never makes the kind of change the rule governs, the probe cannot test the rule. Rewrite it and try again. Do not count this trial run.

## Step 2. Run the arms

Run the arms `none`, `one-liner` and `full` in every harness that is not skipped, in the order step 3 sets. Keep each run's output: its final message and the diff of its worktree.

### Grade each output

Ask one yes/no question per output: "Does this output follow <rule>?", with the rule's one-liner in place of `<rule>`, and the § file and the output's diff as the state.

If your environment gives you a judgment model, as [SKILL.md](../SKILL.md#judgment-model) defines it, grade with it; otherwise use the fallback grader below.

`step` writes `grading/<grader>.questions.jsonl` for each grader, in the same questions and answers pattern `mine` uses, per [the questions schema](schemas/prune.questions.schema.json). Each is one yes/no question with an opaque id, so a grader cannot tell the arm or the harness. The id hashes the run's slot with its diff, the § text, its index one-liner and the probe, so a redone run, an edited § or one-liner, or a rewritten probe asks a new question instead of keeping a verdict on output that is gone. An answer about a harness that is out of scope for now, such as one skipped this time, is set aside and counts again once that harness is back. `status` lists an answer whose question is gone because its run, its § or its probe changed; delete only that kind before `finish`, which refuses while any answer has a problem. Write the answers to `grading/<grader>.answers.jsonl` per [the answers schema](schemas/prune.answers.schema.json). Rerunning `step` reads them.

Calibrate a judgment model before trusting it:

1. Gather 30 outputs, spread across arms and harnesses.
2. Ask the user to label each one yes or no against the rule. Show the rule, the § and the diff for each.
3. Grade the same 30 with the judgment model. When it agrees with at least 27 of the 30 labels, 90%, it grades every run.
4. Save the labels one per line, `{question_id, complies}`, per [the labels schema](schemas/prune.labels.schema.json), and pass the file to `finish --calibration`. `finish` scores the first grader in `--graders` against them and records the labeled count, the agreed count, the agreement and whether it passed in `prune.json`.

When agreement falls under 90%, when there is no judgment model, or when the user declines to label, a fresh subagent that did not write the probe grades instead. Give it the rule, the § and the diff, and nothing about which arm produced the output. A grader that wrote the probe knows what it was trying to provoke, and a grader that knows the arm expects the rule to win. Say in the report which grader ran and why.

When no human labels exist, the runner can take a consensus instead: two graders vote on every output and a third breaks each tie, named in order by `--graders`. Record the agreement between the two voters. It tells you how much the graders share a reading, and it is weaker than calibration, because two graders can share a bias. `prune.json` marks such a run `consensus`. Without `--calibration`, `calibration` is null and every decision is provisional.

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
| `one-liner` | Remove a "Read first." that `write` added. The index line is enough. |
| `full` or `weak` | End the index line with "Read first.", so an agent opens the § before it edits a matching file. |

Show the planned edits as a diff, then apply them.

## Step 5. Write prune.json

Write `prune.json` into the standards folder, beside its `SKILL.md`, per [the prune schema](schemas/prune.schema.json). `finish` writes it. Record every harness with its model ID and status, every rule with its probe, tallies, lift and decision, and every graded run with its harness, model ID and date. Lift is compliance with the rule minus compliance without it, per harness and pooled, for each rule arm that ran. It is the writing-side value of the rule. A deleted rule has no lift, because its rule arms never ran. `finish` recounts every tally from the graded runs and refuses to write when they differ.

Grade with the context a reviewer would have. `step` adds to each question the files the rule points at and the changed files' sibling files from the checkout the runs branched from, because a rule such as "match the sibling" cannot be judged from the diff alone.

Mark a decision provisional when its grader has not passed calibration, because no labels were given or agreement fell under 90%, or when a harness did not run that was requested or is installed and logged in. A requested harness that was skipped, not on PATH or not logged in did not run. So did an installed, logged-in harness that `--harnesses` left out, because narrowing the command must not turn a one-harness delete into a final one. With no `--harnesses`, every harness the runner knows is requested, so a machine with only one harness installed stays provisional until the others run. A rerun with the missing harness replaces the decision. No rule is decided without counted runs: with no harness able to run, `status` shows every rule undecided and `finish` refuses to write `prune.json`.

A rule pruned on one model may be needed on the next one. `doctor` compares these model IDs with each harness's default and flags the record as stale when they differ. `write` reads the `delete` decisions so it does not write a deleted rule back.

Done when `prune.json` validates against the schema and its tallies match its runs.

Report a table of rule, tallies per arm and harness, lift and decision. Name the grader, its calibration result or consensus agreement, every skipped harness with its reason, and the runs used per harness.
