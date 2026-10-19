# doctor

Checks generated standards for drift against the code they govern and writes the findings to `.standards/doctor.json`. Code moves on after a standard is written. A § that points at deleted files, or a lens that never fires, still costs context and erodes trust in the rest.

`doctor` edits nothing. Each finding needs a call on whether the code or the standard is wrong, and that call belongs to the user.

Run from the target repo's root. No script covers this command. Write a short script for steps 2 to 5, because each one matches paths or counts commits, and an eyeballed match misses files.

## Scope

Accepts any form. See [scope](scope.md) for the forms and how to resolve them. An area or § checks only those § files. A path or glob checks only the § files whose "Applies to" globs match a file in it. Steps 4 and 5 still read the whole `prune.json` and index, but report only findings for the scoped § files.

## Step 1. Find the standards

Find every `SKILL.md` in the repo whose frontmatter `metadata` holds `generator: standards`. When there are none, ask the user for the path. When they have none, offer `mine`, and stop.

Read each index and every § file it links. Record HEAD with `git rev-parse HEAD`.

## Step 2. Check globs and cited files

List tracked files with `git ls-files`.

- **`glob-matches-nothing`.** A glob in a § "Applies to" line matches no tracked file. Its lens can never trigger. Fix: update the glob to where the code moved, or delete the § when the code is gone.
- **`cited-file-gone`.** A path in a § "Evidence" line is no longer tracked. The convention may still hold, but a reader can no longer check the evidence against the code. Fix: rerun `mine` and refresh the evidence.

## Step 3. Check which lenses fire

1. List the last 50 non-merge commits on the default branch with the files each one changed: `git log --no-merges -n 50 --name-only`.
2. For each §, keep the commits that changed a file its globs match.
3. For each kept commit, judge whether any of the § heuristics applies to the commit's added lines. A judgment model can answer this as one yes/no question per commit and §. If your environment gives you a judgment model, answer with it; otherwise answer yourself.
4. A § with no commit that triggers it gets **`lens-never-fires`**. Either the code stopped making that kind of change, or the heuristics no longer match how it is written. Fix: rewrite the heuristics from the evidence, or delete the §.

## Step 4. Check the prune record

- **`prune-missing`.** The standards folder has no `prune.json`. Nobody has measured whether agents follow these rules unprompted. Fix: run `prune`.
- **`prune-stale`.** For each harness in `prune.json`, find the ID of the model it defaults to now, from the harness's own output or by asking the user. Flag every harness whose model ID differs from the recorded one. A rule measured on one model says nothing about the next. Fix: rerun `prune`.

## Step 5. Check each § is complete

- **`section-incomplete`.** A § lacks its why, has fewer than 3 evidence lines, or has no "Confirmed when" bar. Fix: fill it from the evidence with `write`, or delete the §.
- **`index-mismatch`.** An index line links to a missing file, or a § file has no index line. Fix: restore the link or remove the orphan.

## Step 6. Write doctor.json and report

Write `.standards/doctor.json` per [the doctor schema](schemas/doctor.schema.json), one finding per problem.

Done when every § has been through steps 2 to 5 and the file validates against the schema.

Report the findings grouped by check, each with its § and its fix. When there are none, say how many § files passed and over how many commits.
