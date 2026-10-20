# Scope

Every command takes an optional scope: `standards [command] [scope]`. A scope narrows the work to part of the repo or part of the standards, so a run costs only what the user asked about.

## Forms

| Form | Example | Means |
| --- | --- | --- |
| § number | `§2`, `§2.3` | One area, or one rule in it. |
| Area slug | `error-handling` | One area, named by its index heading in kebab case. |
| Path or glob | `src/api/`, `src/**/*.ts` | The files it matches. |

## Resolve it in this order

1. **§ pattern.** The scope matches `§<n>` or `§<n>.<m>`. Check that the generated index has that area or rule.
2. **Area slug.** Find the generated standards (a `SKILL.md` whose frontmatter `metadata` holds `generator: standards`). Turn each area heading in the index into its slug: drop the leading § number, then lowercase the rest, with every run of other characters as one hyphen, so `## §1 Command layering` gives `command-layering`. For shape B, an area's slug is also its skill name after `-standards-`. The scope matches when it equals a slug.
3. **Path or glob.** The scope matches when `git ls-files` lists at least one file it matches.

The order matters, because an area slug can look like a directory name, and the standards decide what an area means.

## When nothing matches

Say that the scope matched nothing, list every area as its § number and slug, and stop. Guessing a near match runs the command on code the user did not name. When no generated standards exist, say so instead of listing areas.

Each command's reference says which forms it accepts and what the scope does there. A form the command does not accept is an error: name the forms it takes, list the areas, and stop.
