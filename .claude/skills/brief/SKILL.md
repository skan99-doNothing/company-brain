---
name: brief
description: Open a department before working in it. Reads the department brief and its ledger, then reports what is in flight, what the friction queue says, and which paths matter. Use at the start of any session that will change something, whenever the user names a department, or when they ask "what was I doing with X".
---

# Brief a department

Argument: a department id. The valid ids are the keys in `org.config.json` under
`departments`, and they are listed in `HOME.md`. If the argument is missing or ambiguous,
run the `route` skill first rather than guessing.

## Steps

1. Read `departments/<id>.md` in full. This gives the paths, the inventory and the rules.
2. Read `state/<id>.md` in full. This is the memory.
3. If the brief points at a nested ledger inside one of the linked vaults, read that too.
   Ask which one if it is not obvious from the request.
4. Check whether anything in the ledger's In flight section is stale by looking at the real
   files it names. An entry claiming a file is empty when it now has content is out of
   date; say so rather than repeating it.
5. If `state/inventory.json` is more than a week old, mention it once and offer `/sync`.

## Report back

Keep it short. The user asked to start work, not to read a summary of their own notes.

- What is in flight, as a list. If nothing, say so plainly.
- The two or three context-bank facts that bear on what they just asked for. Not the whole
  bank.
- Anything in the ledger the filesystem now contradicts.
- The paths they are most likely to touch, as clickable `path:line` references where you
  can resolve them.

Then stop and wait. Do not start doing the work as part of the brief unless the original
message clearly asked for both.

## Afterwards

The session that follows a brief is expected to end with `/log <id>`. If the user is
wrapping up and has not logged, remind them once. Do not nag more than once.
