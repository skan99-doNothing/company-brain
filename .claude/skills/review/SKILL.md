---
name: review
description: Weekly review across every department. Walks all ledgers, reports what moved, what stalled, what the friction queue says to build, and which cross-references were never followed up. Use when the user says "weekly review", "what happened this week", "review the org", or asks what to work on next.
---

# Weekly review

## Steps

1. Read every file in `state/`. Read `decisions.md` for anything dated inside the window.
2. Default window is the last seven days. If the newest log line across all ledgers is
   older than that, widen to cover it and say which window you actually used.
3. Classify each department:
   - **Moved**: has log entries inside the window.
   - **Stalled**: has In flight items but no log entries inside the window.
   - **Quiet**: nothing in flight and nothing logged. Not the same as stalled, and not
     automatically a problem.
4. Check the Cross-references section of every ledger for entries never acted on. Those are
   the things that fell between departments, which is the exact failure this org root exists
   to catch. Call them out by name.
5. Read every Friction section and rank the combined list by how many departments each item
   blocks, then by how long it has been sitting there.
6. Read `state/inventory.json`. Any path marked missing means a brief points somewhere that
   moved. Flag it; that is silent rot.

## Report

Prose with a few short lists, not a wall of tables.

- One paragraph on what actually moved. Name the departments and what changed.
- Stalled departments, with the specific In flight item that has not moved and roughly how
  long it has been there.
- Dropped cross-references, if any. These matter more than the stalled items because nobody
  owns them.
- The top three from the friction queue, with a one-line case for each.
- One recommendation for the coming week. One, not a list. Pick the thing that unblocks the
  most and say why the others can wait.

## Then

Offer to write the digest as a dated Log entry in whichever department owns the vault, and
to note in each stalled department that it was flagged. Do not write either without a yes.

## Style

No invented numbers. If a count is needed, take it from the ledgers or the inventory. End
on the recommendation; do not add a closing paragraph about momentum.
