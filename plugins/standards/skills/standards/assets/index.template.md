---
name: {{ repo-slug }}-standards
description: Coding standards for {{ repo }}, mined from its code review history. Use when editing or adding {{ file kinds the globs cover, such as API handlers or database migrations }} in this repo. {{ One trigger per area, naming the edit, such as adding an endpoint or writing a migration. }}
metadata:
  generator: standards
---

# {{ repo }} standards

Each line below is a rule that reviewers in this repo enforced on at least 3 changes, more than one reviewer among them. Follow it while you write code. A standards review pass, which adds to an ordinary review, opens the linked § for its why, its evidence, its examples and the heuristics to match against the diff.

Each line names its rule's default severity in parentheses, so a reviewer knows before opening the § that a nit still gets reported.

A line that ends in "Read first" needs its full § in mind while you write. Open that § before you edit a file it applies to.

## §1 {{ area name }}

- §1.1 {{ rule, one imperative sentence }} ({{ default severity }}) [§1.1]({{ references/s1-1-slug.md }})
- §1.2 {{ rule, one imperative sentence }} ({{ default severity }}) [§1.2]({{ references/s1-2-slug.md }}) Read first.

## §2 {{ area name }}

- §2.1 {{ rule, one imperative sentence }} ({{ default severity }}) [§2.1]({{ references/s2-1-slug.md }})
