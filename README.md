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
and Linux. No npm dependencies, in this or in any part of it.

That much is the router, and it is the whole thing for most people. There is a second stage
if you want it, which indexes everything the router links and hands your sessions semantic
search over it as MCP tools. It needs a Postgres database and a local embedding model, it is
off until you set it up, and the router does not care either way. See
[retrieval](#retrieval-the-optional-second-stage).

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

## Retrieval, the optional second stage

The router makes a session open in the right place with the right context. It cannot answer
"where did I write about X" across forty thousand files, because ripgrep needs you to know
the word you wrote, and six months later you remember the idea instead.

This stage indexes the markdown under every linked root into Postgres with pgvector, then
exposes retrieval to every session as MCP tools. The index is strictly derived: markdown on
disk stays the only source of truth, and `npm run index -- --rebuild` reconstructs the whole
thing, so a corrupted index is a repair and never a loss.

**What you need.** A Postgres database with the `vector` and `pg_trgm` extensions. A
[Supabase](https://supabase.com) project on the free tier is the assumed case and what the
migrations are written against. And [Ollama](https://ollama.com) running locally with an
embedding model, which is what keeps this free and keeps your notes on your own machine.
Nothing is sent to an embedding API unless you change a variable to say so.

```bash
ollama pull mxbai-embed-large
cp .env.example .env        # then fill in the project URL and the service key

for f in supabase/migrations/*.sql; do npm run db -- apply "$f"; done

npm run index               # first run embeds everything, later runs only what changed
npm run search -- "the thing you half remember"
```

Ollama has to be running whenever a session *searches*, not only when you index, because a
query is embedded by the same model that embedded the corpus. Vectors are only comparable to
vectors from the same model, so switching models means `--rebuild`.

**Day to day.**

| Command | What it does |
|---|---|
| `npm run index` | Brings the index up to date. Skips a file whose content hash has not changed, so it is cheap to run often. |
| `npm run search -- "..."` | Search from the terminal. `--why` shows which signals fired, which is how you debug a bad result. |
| `npm run brain` | The MCP server. Add it to `.mcp.json` and every session gets search, department state, neighbours, related subjects, recent sessions and duplicates as tools. |
| `npm run eval` | Scores retrieval against your own questions. Run `-- --audit` after anything that moves files. |
| `npm run entities` | Builds one identity for a person, project or tool across every department that mentions it. |
| `npm run relate` | Reports subjects that appear in several departments with nothing linking them. |
| `npm run supervise` | Asks the questions nobody remembers to ask: what has stalled, which department has gone quiet, what is in flight that no longer exists, which subjects span departments with nothing linking them, and whether retrieval scored worse than last run. |
| `npm run preflight` | Checks Postgres and Ollama are reachable. `bin/nightly.cmd` runs it before anything else. |

**Two things that will bite you, both learned the hard way.**

Never let two copies of the same file into the index. A duplicate of your own notes is worse
than noise: it matches, it scores as correct in the eval, and it hides a real failure
underneath. Exactly that happened here. A vendored copy of this repo's own `decisions.md`
outranked the real one, and the eval called it a pass for weeks. Keep copies out with
`index.exclude` in `org.config.json`. Search collapses identical text to one result as a
backstop, but exclusion is the fix.

Write your own eval questions before you tune anything. `bin/eval-questions.mjs` ships
fifteen that target the files this template gives you, so the harness says something true on
day one, and they are an example of the format rather than a benchmark. The rules that keep a
set honest are in that file's header, and the one that matters most is to keep each expected
path fragment specific: a fragment broad enough to match a whole directory is satisfied by
anything in it, so the question passes without ever finding the answer.

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

The retrieval stage, inert until you configure it:

```
.env.example           copy to .env: database URL, key, embedding model
supabase/migrations/   schema and the search function, applied in order
bin/lib/               config, walk, markdown, embed, store, search
bin/index.mjs          the indexer
bin/search.mjs         search from the terminal
bin/mcp-brain.mjs      retrieval as MCP tools
bin/eval-search.mjs    the scorer
bin/eval-questions.mjs the questions, which you replace
bin/entities.mjs       one identity per subject across departments
bin/relate.mjs         subjects that span departments with nothing linking them
bin/supervise.mjs      what stalled, what went quiet, what nobody wrote down
bin/preflight.mjs      is it worth starting a scheduled run
bin/nightly.cmd        preflight, index, eval, one summary line
bin/db.mjs             apply a migration, run a query
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
