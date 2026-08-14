# Decision log

Append-only. Newest at the bottom. Never edit an old entry; if a decision is reversed,
write a new entry that says so and link back to the one it replaces.

This is the highest-value file in the org and it costs about two minutes per entry. It
answers the question nothing else can: not what changed, but why, and what would have to be
true to change it back.

Log a decision when the choice would be expensive to reverse, when it commits money or
several days of work, when it rules out an option that looked reasonable, or when a future
session would otherwise redo the reasoning from scratch. Do not log routine work; that goes
in the department ledger.

## Format

```
## YYYY-MM-DD · Short title
Department: <dept>
Decision: <what was decided, one or two sentences>
Why: <the reasoning, including the option not taken>
Reverses if: <what would have to become true to change this>
```

The `Reverses if` line is the one people skip and the one that pays. A decision without an
exit condition is a belief.

---

## Example, delete this once you have your own

## 2026-01-01 · Markdown stays the memory substrate

Department: memory

Decision: Keep all memory as markdown in git. Do not stand up a vector database for
personal recall.

Why: At a few thousand notes, ripgrep is exact and instant, and files are read natively
with no pipeline in between. A vector store adds a service to run, an embedding pipeline to
keep in sync, and a way for notes to go stale silently. Markdown is diffable,
hand-editable, and outlives the tool that wrote it. The option not taken was standing up
Qdrant now, on the theory that it would be needed eventually.

Reverses if: Retrieval becomes a daily cost that a local index inside the note-taking app
cannot solve, or a product needs retrieval at runtime, which is product infrastructure and
a different problem from personal recall.
