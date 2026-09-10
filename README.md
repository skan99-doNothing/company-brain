# company-brain

A router and a memory layer for people who use Claude Code in more than three folders.

If that is you, you already have this problem: a session in one folder makes a decision
that matters in another, and the other folder never finds out. You end up re-explaining
the same context every week, and the good reasoning stays in a chat window that scrolls away.

This is one place to open Claude from, one ledger per department, and nothing moved.

```
npm run init && npm run doctor
```

Needs Node 18+ and [Claude Code](https://claude.com/claude-code). Works on Windows, macOS
and Linux. No dependencies.

---

## What it actually does

**Links, not a merge.** The org root holds links to folders you already have: junctions on
Windows, symlinks on macOS and Linux. Nothing is moved, renamed or copied. Delete the org
folder and everything you own is exactly where it was.

**A ledger per department.** Each department gets a file in `state/` with a scoreboard,
what is in flight, a context bank of facts sessions keep needing, a friction queue and a
dated log. The rule is *read before, append after*.

**Cross-references.** When work in one department changes something in another, `/log`
writes a line in both. That single habit is the thing that fixes the problem at the top of
this README.

**Gaps are first class.** Anything you mark `gap` in the config is drawn in gold on the
map, listed in its brief and ranked by `/review`. Most org charts only show what exists,
which is the half you already know about.

---

## Quick start

**1.** Click **Use this template** on GitHub, then clone your copy.

**2.** Edit `org.config.json`. Point `roots` at folders you already have, rename the
departments to match how you actually think about your work, and mark the things that do
not exist yet as `gap`.

```jsonc
{
  "org": { "name": "Studio", "tagline": "one operator" },
  "roots": {
    "notes": "~/Documents/Vault",
    "code":  "~/Code"
  },
  "departments": [
    {
      "id": "growth",
      "name": "Growth",
      "color": "#9B8CC4",
      "mission": "Turn what you learn into things people find.",
      "paths": ["vaults/notes/Content"],
      "clusters": [
        { "name": "Creation", "items": [
          { "label": "draft",      "type": "core", "desc": "The skill that writes the thing." },
          { "label": "post-retro", "type": "gap",  "desc": "Nothing records how a piece performed, so the loop never closes." }
        ]}
      ]
    }
  ]
}
```

Three starting points ship in `examples/`: `solo-creator`, `indie-hacker`, `agency`. Copy
one over `org.config.json` if the default four departments do not fit.

**3.** Build it.

```bash
npm run init        # links, briefs, ledgers, dashboard, launcher
npm run doctor      # checks everything is wired, explains anything that is not
npm run doctor:deep # also asks every MCP server to initialize
```

`doctor` stays offline and needs no configuration, so it is safe as the first thing a fresh
clone runs. `doctor:deep` adds the checks that talk to something: it asks each server in
`.mcp.json` to complete an MCP `initialize` handshake and reports the ones that do not
answer, which is the only way to catch a connector whose token expired or whose path moved.
A static read of `.mcp.json` cannot tell you either. Neither command repairs anything; both
name the command that would.

**4.** Open Claude from the root, using the generated launcher rather than opening Claude
inside individual project folders. That is the whole mechanism.

```
Open-Org.cmd       # Windows
./open-org.sh      # macOS, Linux
```

---

## The daily loop

```
/brief growth                    read the brief and ledger, see what is in flight
   ... do the work ...
/log growth "swapped the hook format, saves ~20 min per post"
```

| Command | When | What it does |
|---|---|---|
| `/brief <dept>` | Starting | Reads brief and ledger, reports what is in flight, flags anything the ledger claims that the filesystem contradicts |
| `/log <dept>` | Finishing | Appends a dated line, updates in-flight, mirrors friction, cross-references other departments |
| `/route` | Unsure | Names the owning department and the exact folder |
| `/review` | Weekly | Walks every ledger. What moved, what stalled, dropped cross-references, ranked friction queue, one recommendation |
| `/sync` | After moving things | Rescans the filesystem, reports any path a brief claims that no longer exists |

Two agents in `.claude/agents/`: **librarian** (find and file across the linked vaults) and
**dept-analyst** (audit one department's brief and ledger against what is really on disk).

---

## What is in the repo

```
org.config.json        the one file you edit
CLAUDE.md              routing rules, loaded automatically every session
decisions.md           append-only: why, and what would reverse it
templates/             what init fills in
bin/                   init, sync-inventory, doctor, serve-atlas
.claude/skills/        route, brief, log, review, sync
.claude/agents/        librarian, dept-analyst
atlas/                 the visual map
examples/              three starting configs
```

Generated by `npm run init`, and gitignored because they are yours, not the template's:

```
vaults/                links to your real folders
departments/           a brief per department
state/                 a ledger per department
HOME.md                the dashboard
.mcp.json              from the mcpServers block in your config
```

---

## The atlas

`npm run atlas` serves the map at <http://localhost:4173>. Click a department to fly in,
click any orb for its profile: what it is, where it lives, its status, and the rest of its
cluster. Drag to pan, scroll to zoom, `esc` to pull back.

Served over http it reads your live `org.config.json` and `state/inventory.json`. Opened
straight off the filesystem the browser blocks those fetches, so it shows a bundled demo
instead. Either way it renders.

---

## Things worth knowing before you rely on it

**Search does not follow the links.** Ripgrep will not descend into junctions or symlinks,
so a search from the org root silently returns nothing from your vaults. That looks like an
empty folder rather than a broken search, so it is worth internalising:

```bash
rg "term" .                # finds nothing in your vaults
rg "term" vaults/notes     # right
```

Reading, editing and globbing through a link path all work normally. `CLAUDE.md` tells
Claude this, and `npm run doctor` reminds you.

**Ledgers are never overwritten.** `npm run init` regenerates briefs and the dashboard but
will not touch anything in `state/`, not even with `--force`. Re-run it as often as you like.

**No automation writes for you.** There is no hook that silently appends to a ledger. An
entry written by something that did not do the work is noise, and noise in the memory layer
is worse than a gap. The habit is the product; the tooling only makes it one command.

**It is not multiplayer.** Ledgers are plain markdown with no locking. For a team, put the
org root in a private repo and treat ledger edits like code.

---

## Versioning your own org

The generated files are gitignored so your real paths and notes do not end up in a public
fork. If you want your own org versioned, keep it in a separate private repo:

```bash
cd /path/to/your-org
git init
printf 'vaults/\nnode_modules/\n' > .gitignore   # links do not belong in git
git add . && git commit -m "org: initial"
git remote add origin git@github.com:you/your-org-private.git
git push -u origin main
```

Then pull template updates in as a second remote when you want them.

---

## Removing it

```bash
# Windows, from the org root
[System.IO.Directory]::Delete("$PWD\vaults\notes", $false)

# macOS, Linux
rm vaults/notes
```

Removing a link never touches its target. Delete the whole org folder and every real folder
is untouched. Use the commands above rather than `Remove-Item -Recurse` or `rm -rf`, which
some shells have been known to follow into the target.

---

MIT. Built because sixteen folders each had their own `CLAUDE.md` and none of them talked.
