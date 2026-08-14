---
name: route
description: Work out which department owns a piece of work, and where the files for it live. Use when the user asks "where does this go", "which folder", "where should I put this", when a request could plausibly belong to two departments, or before running brief or log with no clear department.
---

# Route a piece of work

## Steps

1. Read `HOME.md` for the department table if it is not already in context.
2. Match the request against the briefs in `departments/`. Read only the ones that
   plausibly match, not all of them.
3. Answer with the owning department, the ledger path, and the specific folder the work
   belongs in. One short paragraph, not a table.

## Disambiguation

These are the boundaries that get confused in practice. Adapt them to the departments in
this particular org; the shapes recur even when the names do not.

- **Producing a thing** belongs to the department that produces it. **Selling it** belongs
  to whichever department owns money. A piece of work that does both is owned by the
  producer with a cross-reference to the seller.
- **Anything touching price, packaging or the funnel** goes to the money department, even
  when the code change happens in a product repo. The code work is logged where the code
  lives; the pricing decision is logged where the money lives.
- **Building a skill, connector or agent** belongs to whichever department owns tooling,
  regardless of which department will use it. The beneficiary gets a cross-reference, not
  the entry.
- **Filing and retrieval** belong to the department that owns the vault. The content being
  filed belongs to whoever produced it.
- **Health, people and time** belong to the personal department if there is one, and belong
  there even when they explain a bad week elsewhere.

## When it genuinely spans two

Say so. Name the owner, name the department that needs the cross-reference, and say which
line goes where. Do not split an entry across two ledgers as equals; one of them owns it.

## When nothing fits

Some work has no department yet. Say that plainly rather than forcing it into the nearest
box. Then either propose the department it should live in, or note it as unrouted in the
vault department's ledger so it is visible next time. Unrouted work is how things get lost,
which is the failure this whole folder exists to prevent.

If unrouted work keeps appearing in the same shape, that is a signal the org needs another
department. Adding one means adding it to `org.config.json` and re-running `npm run init`.
