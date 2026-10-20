# §1.1 Names

Paired standard: rule §1.1 in [the index](../SKILL.md).

- Applies to: `src/*.js`
- Triggers: adding a variable
- Default severity: nit

## Rule

Name values for what they hold.

## Why

A vague name makes the reader open the definition.

## Evidence

- 12 `src/a.js`:
  > Call this userCount, not n.

  fires: vague name
- 14 `src/b.js`:
  > What does tmp hold?

  fires: vague name
- 19 review body:
  > Please name these for what they are.

  fires: vague name

## Heuristics

- **vague name.** A one-letter or tmp name for a value that lives past one line.

## Confirmed when

The added name says nothing about the value and the value outlives its line.
