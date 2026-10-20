# jawsome-agents

Agent skills that run in any harness that reads the [Agent Skills spec](https://agentskills.io/specification). Each skill uses only the spec's frontmatter and plain files, so the same folder installs in Claude Code, Codex, opencode and any other harness that loads skill folders.

## Plugins

| Plugin | What it does |
| --- | --- |
| `standards` | Mines a repo's review history into coding standards that agents follow while they write code there, each with its reason and the review comments behind it, and prunes the rules that don't change what agents write. |

Invoke it as `/standards [command] [scope]`:

- `command` is one of `mine`, `write`, `review`, `prune` or `doctor`. With no argument, the skill shows a menu and waits.
- `scope` is a path or glob, an area from the generated standards, or a § number such as `§2`. A scope with no command runs `review` on it.

Use it in this order:

1. `mine` the review history into ranked conventions.
2. `write` the standards skill into the repo.
3. `prune` the rules agents already follow without being told.
4. Write code. Agents load the generated standards while they edit the files the rules cover.
5. Optionally, `review` a diff: it adds a standards pass on top of an ordinary review and never replaces it.

Run `doctor` now and then to catch drift.

## Install

### Claude Code

```text
/plugin marketplace add JawsomeJason/jawsome-agents
/plugin install standards@jawsome-agents
```

### Codex and opencode

Clone the repo, then link its skills into each harness's skills folder. The script prints its plan first and changes nothing until you pass `--apply`.

```sh
sh scripts/install.sh --harness all           # print the plan
sh scripts/install.sh --harness all --apply   # make the links
```

| `--harness` | Folder | Read by |
| --- | --- | --- |
| `codex` | `$CODEX_HOME/skills`, which defaults to `~/.codex/skills` | Codex |
| `opencode` | `$XDG_CONFIG_HOME/opencode/skills`, which defaults to `~/.config/opencode/skills` | opencode |
| `agents` | `~/.agents/skills` | Codex and opencode both |
| `all` | the `codex` and `opencode` folders | |

Pick either `agents` or the per-harness folders, not both: a harness that reads both folders would load each skill twice. Each folder above was verified by installing a probe skill into a temp home and checking that a real run listed it.

The links point back into the clone, so `git pull` updates every harness. The script is idempotent and never replaces a file or folder that isn't a symlink; it reports that path as skipped.

### Other harnesses

Gemini CLI, Cursor, Copilot and other harnesses aren't verified here. Copy or link the skill folder, such as `plugins/standards/skills/standards`, into your harness's skills folder.

## Develop

```sh
node scripts/lint.mjs                              # lint the repo's skills and docs
node --test 'scripts/*.test.mjs'                   # tests for the lint, install.sh and test-harnesses.mjs
node --test 'plugins/standards/tests/*.test.mjs'   # tests for the standards scripts
node scripts/test-harnesses.mjs                    # real runs in each installed harness
```

CI runs the lint and both test suites. The harness test needs each harness's login and spends real usage, so it runs by hand: in a temp home per harness, it installs the skills, invokes `standards` with no argument and checks that the menu prints. A harness that isn't installed or isn't logged in shows as skipped. Pass `--keep` to keep the temp homes for debugging.

### Add a plugin

1. Read [AGENTS.md](AGENTS.md). It holds the rules every skill follows and the reason for each.
2. Create `plugins/<name>/skills/<skill>/SKILL.md`, with optional `references/`, `scripts/` and `assets/` beside it.
3. Add `plugins/<name>/.claude-plugin/plugin.json` and an entry for the plugin in `.claude-plugin/marketplace.json`.
4. Run the lint and the tests, then `node scripts/test-harnesses.mjs`.

## License

MIT. See [LICENSE](LICENSE).
