# §{{ id }} {{ title }}

Paired standard: rule §{{ id }} in [the index](../SKILL.md). This file is the lens a reviewer applies for that rule.

- Applies to: {{ globs, each in backticks, each matching at least one tracked file }}
- Triggers: {{ edit kinds, such as adding an endpoint or changing a schema }}
- Default severity: {{ nit, minor, major or blocker }}

## Rule

{{ The index line for §id, word for word. }}

## Why

{{ What breaks in this repo when code ignores the rule. Take it from the reviewers' own reasons. Required: write leaves out any § it cannot fill this for. }}

## Evidence

{{ At least 3 review comments from clusters.json, one per line, in this form. }}

- {{ change id }} `{{ path }}`: "{{ excerpt, under 200 characters }}"
- {{ change id }} `{{ path }}`: "{{ excerpt }}"
- {{ change id }} `{{ path }}`: "{{ excerpt }}"

## Failure model

| Vector | What goes wrong | Default severity |
| --- | --- | --- |
| {{ one way code breaks the rule }} | {{ the consequence }} | {{ nit, minor, major or blocker }} |

## Examples

Breaks the rule:

{{ a fenced code block in the file's language, taken from or modeled on the evidence }}

Follows the rule:

{{ a fenced code block showing the same change done right }}

## Heuristics

- {{ a pattern a reviewer can match against the added lines of a diff, such as a call, an import or a missing step }}

## Confirmed when

{{ The bar for reporting a violation: what must be true of the added code, and what evidence of an intended exception clears it. }}
