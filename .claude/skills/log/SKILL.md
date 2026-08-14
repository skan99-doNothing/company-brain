---
name: log
description: Append an entry to a department ledger, and a decision to decisions.md when one was made. Use at the end of any session that changed something, when the user says "log this", "write that down", "remember this for next time", or when a session is wrapping up and nothing has been written to state/ yet.
---

# Log to the ledger

Arguments: a department id, then optionally the entry text. If the text is missing, write it
yourself from what actually happened this session, then show it before saving.

## What goes where

A ledger line records what changed and what it means next time. A decision records why a
choice was made and what would reverse it. Most sessions produce a ledger line and no
decision. Never write a decision without also writing the ledger line.

## Steps

1. Read `state/<id>.md` so the new entry matches the existing tone and does not repeat
   something already there.

2. Append under `## Log`, at the bottom:

   ```
   - YYYY-MM-DD · what changed · what it means next time
   ```

   Use today's real date. The second half is the part that earns its keep. A fact alone
   does not stop the next session repeating the work; the implication does.

3. Update the other sections if this session changed them:
   - `## In flight` if something started or finished. Remove finished items rather than
     leaving them ticked.
   - `## Scoreboard` if a number moved.
   - `## Context bank` if the session discovered a fact that will be needed again.
   - `## Friction` if something cost time that a skill or connector would have prevented.
     Mirror that same line into whichever department owns tooling, prefixed with this
     department's name. That combined list is the build queue.

4. Update the `updated:` field in the frontmatter to today.

5. **If the work touched another department, append one line to that department's
   `## Cross-references` section** naming this department and the date. This is the step
   that stops work in one folder from being invisible in another. It is the entire point of
   the org root, so do not skip it.

6. If a decision was made that would be expensive to reverse, commits money or several
   days, rules out an option that looked reasonable, or would otherwise be re-derived from
   scratch later, append to `decisions.md` in the format documented at the top of that file.
   Include the option not taken and the exit condition. If unsure whether it qualifies, ask
   in one sentence rather than deciding for them.

## Confirm

Show the exact lines being appended and which files they go to, then write them. Do not
print a diff of the whole file.
