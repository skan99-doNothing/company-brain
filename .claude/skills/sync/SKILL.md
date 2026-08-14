---
name: sync
description: Rescan the real filesystem and refresh state/inventory.json, then report what changed against the department briefs. Use when a brief looks out of date, after adding or removing a repo or project folder, when the atlas numbers look wrong, or when the user asks what actually exists in a department.
---

# Sync the inventory

Briefs are generated once and then drift. `state/inventory.json` is generated from the real
filesystem every time and does not.

## Run it

```
npm run sync
```

It walks every path declared under `paths` in `org.config.json`, skips `.git`,
`node_modules`, virtualenvs and build output, counts markdown and total files, records the
most recent modification date, and notes which folders carry their own `CLAUDE.md`,
`.mcp.json` or `.claude/skills`.

## Then

1. Read the fresh `state/inventory.json`.
2. **Report any path marked `missing: true`.** That means a brief points at something no
   longer there, and it is the most useful thing this produces. Either the folder was
   renamed or the config is wrong; work out which before editing anything.
3. Use the `newest` date per path to say where work has actually been happening. That is
   often not where the brief says it should be, and the gap is worth naming.
4. If a folder exists inside a declared root that no department claims, say so. Unrouted
   folders are how things get lost. Propose which department should own it and offer to add
   it to `org.config.json`.

## Adding a path

Paths go in the department's `paths` array in `org.config.json`, relative to the org root.
If the folder lives outside every linked root, add it under `loose` first, then re-run:

```
npm run init
```

Init never overwrites a ledger, so re-running is safe. It will skip existing briefs unless
you pass `--force`.

## Do not

Do not edit `state/inventory.json` by hand. It is generated and a hand edit is silently
overwritten on the next run. Correct the source instead: either the filesystem or
`org.config.json`.
