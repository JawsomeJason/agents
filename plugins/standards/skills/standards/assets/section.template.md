# §{{ id }} {{ title }}

Paired standard: rule §{{ id }} in [the index](../SKILL.md). This file holds the rule's why, evidence and examples, for an agent writing code it governs. A standards review pass also matches its heuristics against a diff.

- Applies to: {{ globs, each in backticks, each matching at least one tracked file and at most about 25% of the tracked files of its kind; or `by trigger` }}
- Triggers: {{ edit kinds, such as adding an endpoint or changing a schema; with `by trigger`, a pattern to match against added lines, such as a call or an import }}
- Default severity: {{ nit, minor, major or blocker }}

## Rule

{{ The rule sentence of the index line for §id, word for word, without its severity or link. }}

## Why

{{ What breaks in this repo when code ignores the rule. Take it from the reviewers' own reasons. Required: write leaves out any § it cannot fill this for. }}

## Evidence

{{ At least 3 review comments, one list item each, in this form. The excerpt sits in a blockquote under its item, so a reviewer's own words stay verbatim even when they use a time word. The `fires:` line names the heuristic below that matches the code the comment was about. }}

- {{ change id }} `{{ path }}`:
  > {{ excerpt, under 200 characters }}

  fires: {{ heuristic's short name }}
- {{ change id }} `{{ path }}`:
  > {{ excerpt }}

  fires: {{ heuristic's short name }}
- {{ change id }} review body:
  > {{ excerpt from a review's summary text, which has no path }}

  fires: {{ heuristic's short name }}

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

{{ At least one per noun or construct the Rule sentence names, each opening with a bold short name. Every Evidence item's `fires:` line gives one of these names. }}

- **{{ short name }}.** {{ a pattern a reviewer can match against the added lines of a diff, such as a call, an import or a missing step }}

## Confirmed when

{{ The bar for reporting a violation: what must be true of the added code, and what evidence of an intended exception clears it. }}
