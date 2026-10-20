---
name: standards
description: Turns a repo's code review history into numbered coding standards that agents load while they write code there, each rule with its why and the review comments behind it, proves each rule earns its place, and can add a standards pass on top of an ordinary review. Use when writing or auditing coding standards or conventions from review history (mine, write), adding a standards pass to the review of a diff, branch or pull request (review), pruning standards that agents already follow unprompted (prune), or checking standards for drift, such as rules whose files are gone or prune data measured on an older default model (doctor).
argument-hint: "[mine|write|review|prune|doctor] [path|area|§]"
---

# Standards

Reviewers enforce the same conventions by hand, comment after comment. This skill mines those comments into written standards that an agent loads while it writes code in the repo, so the code arrives already following them. `prune` keeps only the rules that change what agents write. Each numbered § cites the review comments behind it, so anyone can trace a rule back to the reviewers who enforced it. `review` is an optional extra: a standards pass that adds findings on top of an ordinary review and never replaces it.

## Core principles

- Standards are for writing. The generated index loads while an agent edits the files its rules cover, because a rule followed while writing costs no review round. A standards review pass that replaced the ordinary review missed real bugs, so it only ever adds to one.
- Evidence first. A § needs review comments from at least 3 distinct changes and 2 distinct reviewers, because many comments on one change, or from one person, are a single reviewer's taste.
- Every rule carries its why. A reason still guides an agent after the code around the rule changes shape.
- One home per convention. Two copies drift apart, and an agent follows whichever one it read first.
- A check beats a §. A convention a linter, type or test can catch belongs in that tool, because a check runs every time.
- Delete what agents already do. A rule followed unprompted costs context on every load and changes nothing.
- Scripts are shortcuts. Each output file has a schema in `references/schemas/`, so when a script is missing or fails, write the same file by hand.
- `git` is the only hard dependency. A forge's CLI, such as `gh` or `glab`, adds review comments, and `git log` stands in without one.

## Commands

| Command | What it does | Output | Reference |
| --- | --- | --- | --- |
| `mine` | Pulls review comments, labels each by convention, ranks the clusters by frequency times severity | `.standards/clusters.json` | [references/mine.md](references/mine.md) |
| `write` | Turns ranked clusters into a standards skill in the repo, each § with its why and evidence | the standards skill | [references/write.md](references/write.md) |
| `review` | Adds a standards pass on top of an ordinary review: applies every lens a diff triggers and reports extra findings with the § cited | findings in the reply | [references/review.md](references/review.md) |
| `prune` | A/B tests each rule across harnesses and deletes the ones agents follow unprompted | `prune.json` | [references/prune.md](references/prune.md) |
| `doctor` | Flags drift: globs that match nothing, cited files that are gone, lenses that never fire, stale prune data | `.standards/doctor.json` | [references/doctor.md](references/doctor.md) |

## Routing

Invoke as `standards [command] [scope]`. A scope is a path or glob, an area slug from the generated index, or a § number (`§2`, `§2.3`). Resolve it per [references/scope.md](references/scope.md). `mine` takes only a path, because areas exist only after `write`.

- **No argument.** Show the menu below and wait for a choice. Never auto-run a command, because each one reads history, edits the repo or spends many agent runs.
- **A scope with no command.** Run `review` of that scope without asking, because `review` only reads. It still starts from an ordinary review and adds the standards pass to it.
- **An explicit or clearly implied command.** Load its reference and follow it step by step.
- **Two commands fit.** Ask once which one, naming both and what each would do. Then follow the answer.
- **Standards from nothing.** Start at `mine`, because `write` needs `clusters.json`. Offer `write` when `mine` finishes.
- **A question about the skill itself.** Answer from this file without running a command.

## Menu

```text
standards: what should I do?
  mine    Mine review comments into ranked conventions
  write   Write standards from the ranked conventions
  review  Add a standards pass to a review of a diff
  prune   Test each rule and delete the ones agents already follow
  doctor  Check the standards for drift
Every command takes an optional scope: a path, an area or a §.
```

When generated standards exist, list their areas under the menu as § number and slug.

## Pipeline

`mine` feeds `write`, and `prune` tests what `write` produced. Agents then load the standards while they write code. `doctor` maintains them, and `review` optionally applies them to a diff on top of an ordinary review.

Work files live in `.standards/` at the target repo's root. Keep that folder out of version control, because review comments quote code and people. `prune.json` is the exception. It lives beside the generated standards, because `doctor` reads it there.

`<skill-dir>` in the references is the folder that holds this file. The scripts in `<skill-dir>/scripts/` speed up `mine` and need only a JavaScript runtime's standard library.

## Judgment model

`mine`, `prune` and `doctor` ask many small typed questions. A judgment model is a fast model that answers typed questions (pick one of a set, a yes/no probability, a score) with calibrated probabilities. If your environment gives you a judgment model, answer the questions file with it; otherwise answer them yourself. Your environment's own instructions decide which model that is.

## Generated standards

- The default output is one skill with an index of one-liners, each linking to a § file. Templates: [index](assets/index.template.md) and [section](assets/section.template.md).
- One skill per area is an option, settled per repo by the shape experiment in [references/write.md](references/write.md).
- Generated standards follow the same rules as this skill: spec frontmatter only, no URLs, no dates, and a why for every rule.
