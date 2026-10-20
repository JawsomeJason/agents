# Repo conventions

These rules apply to every agent and person who edits this repo, in any harness.

## Layout

- `plugins/<name>/skills/<skill>/` holds each skill: `SKILL.md`, plus optional `references/`, `scripts/` and `assets/`.
- `plugins/<name>/.claude-plugin/plugin.json` and the root `.claude-plugin/marketplace.json` are thin install wrappers. They live outside `skills/`, and skills never depend on them.
- `scripts/` holds repo tooling: the lint, its rules file and its fixtures.

## Skills follow the Agent Skills spec only

Read the [spec](https://agentskills.io/specification) before writing a skill. It is the most stable surface across harnesses, so a skill uses nothing beyond it.

- Frontmatter uses spec keys only: `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`.
- Extension keys are allowed only when listed in `extensionKeys` in `scripts/lint-rules.json`. Each must be one that harnesses ignore when they don't know it, and the harness smoke test must prove a skill carrying it still loads, because an unknown key some harness rejects breaks the skill there.
- `name` matches its directory, has at most 64 characters, and uses lowercase letters, digits and single hyphens.
- `description` stays within 1024 characters and says both what the skill does and when to use it.
- The `SKILL.md` body stays under 5000 tokens. Rules sit in `SKILL.md` as one-liners, each linking to a file in `references/` that holds its examples.
- No fenced code block in `SKILL.md` runs past 10 lines. Longer code goes in `references/`.

## Durability

Skills must keep working as harnesses, models, vendors and runtimes change around them.

- **Harness tools.** Describe actions with verbs: run, spawn a subagent, ask the user. Never name a harness's tool.
- **Models.** Name no model family or model ID, and make no claim about what a model can do.
- **Vendors.** Name no vendor or hosted service. Describe an optional capability by category, such as a judgment model or a forge CLI, and give a fallback. `git` is the only hard dependency.
- **Runtimes.** Scripts use the standard library only: no `package.json`, no lockfile, no install step. Each script's output follows a schema in `references/schemas/`, so an agent can write the same file by hand when the script fails.
- **Links.** The only external URL a skill may carry is the spec. Examples live in `references/`, and every relative link stays inside its own skill folder.
- **Time.** Prose carries no time-relative words and no absolute dates. Words like `currently`, `latest` and `recently` go stale. Dates belong in data files.
- **Reasons.** Every rule states why it exists. A rule with its reason still generalizes after the tools change.
- **Identity.** No person, company, domain or private path appears anywhere. Skills work for any user at any company.

## Lint

`scripts/lint.mjs` enforces every rule above that a machine can check. The denylists live in `scripts/lint-rules.json`, so they change without code edits. Standards that the `standards` skill generates for one repo (frontmatter `metadata` holds `generator: standards`) skip the rules in `generatedStandardsExempt`, because they describe that repo and may name the services it runs on.

```sh
node scripts/lint.mjs                 # this repo
node scripts/lint.mjs path/to/folder  # any folder of skills, such as generated standards
node --test 'scripts/*.test.mjs'     # the lint's own tests
```

Errors print as `file:line rule message`, and the lint exits non-zero when it finds any. Every check has a violating fixture in `scripts/lint-fixtures/`, and `scripts/lint.test.mjs` proves each fixture fails its rule and the clean fixture passes. Add a fixture and a test with every check you add.

Run `node scripts/test-harnesses.mjs` before each release. It runs the skills in every installed harness, which needs each harness's login, so CI can't run it.

CI runs the lint and its tests on every push, every pull request and once a month, so rot shows even when nobody pushes. Pin each action by full commit SHA.
