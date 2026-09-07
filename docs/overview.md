# backlog-manager

A Claude Code plugin that publishes six backlog skills — capture, groom, execute,
orchestrate, retro and a read-only board printer — together with a local web app that shows
every registered project's backlog on one board. There is no database: the registry file
and each project's `backlog/` directory *are* the data, and everything the app displays
is derived from them on the way out.

The plugin half and the app half share one rule that explains most of the design: **the
skills write, everything else reads.** The server and the client never touch an item
file, and each file that holds state has exactly one writer.

## Map

| doc | what it is |
| --- | --- |
| [README.md](../README.md) | the human front door — what this is, quick start, the surfaces |
| [CLAUDE.md](../CLAUDE.md) | the normative index: one line per rule, for anyone (or anything) working in this repo |
| [subsystems/api.md](subsystems/api.md) | the Nest side: what each module owns, which reads are cached and which must never be |
| [subsystems/board.md](subsystems/board.md) | the client: the four surfaces, and what the browser derives rather than fetches |
| [subsystems/skills.md](subsystems/skills.md) | the six skills, their three CLIs, and the reviewer agent |
| [subsystems/invariants.md](subsystems/invariants.md) | the rationale behind the rules whose "why" outruns one line — most encode a failure that already happened |
| [workflows/development.md](workflows/development.md) | running the app while you work on it: stack or host, ports, verification, failure modes |
| [workflows/publishing.md](workflows/publishing.md) | getting a skill edit out of the working tree and into the installed plugin |

The three subsystem docs above carry no `verified:` baseline yet: their prose was moved
out of README and CLAUDE.md rather than written from a code read, and a stamp claims
someone did the latter. The checker reports them `unstamped` until that pass happens.

Deliberately not tracked, and each for a stated reason in
[`.docs-sync.yml`](.docs-sync.yml): `backlog/` (the store's own items and README),
`docs/superpowers/` (specs, plans, decision logs), `audits/` (dated findings), and
`skills/` + `agents/` — those are the product, not documentation about it.

## Architecture

### The data plane

Five artefacts hold everything, and the single-writer column is the load-bearing part:

| artefact | one writer | read by |
| --- | --- | --- |
| `~/.backlog-manager/registry.json` | `skills/backlog/tools/backlog.mjs` | the server, per request, never cached |
| each project's `backlog/**/*.md` | the skills | the server's scan; the client renders it |
| `~/.backlog-manager/orchestrator/<project>/run.json` | `skills/backlog-orchestrate/tools/orchestrate.mjs` | `server/src/orchestrator/`, fresh per request |
| `~/.backlog-manager/settings/` | the server | the watchdog config it wrote, and — for the pause request — `orchestrate.mjs` |
| `~/.backlog-manager/retro/` | `skills/backlog-retro/tools/retro.mjs record` | `retro.mjs sweep`, read-only, for the deltas against the newest record |

The `settings/` row is the one exception to the direction of travel: everything else
under `~/.backlog-manager` flows tool → server, and the pause request flows server →
tool. The retro home travels nowhere at all — one tool writes it and the same tool reads
it back on the next sweep.
The run file's own single-writer guarantee is untouched by it.

### The API — [full doc](subsystems/api.md)

Nest, composed in [`app.module.ts`](../server/src/app.module.ts), every route under
`/api`:

- **`items/`** — walks each registered project's store, parses frontmatter, derives what
  the board needs, and serves item bodies through a registry-built allowlist so a file
  outside every registered `backlog/` cannot be read. Two git-backed reads live here: the
  last commit touching an item file (memoised against the files git rewrites) and which
  items differ from `main` (memoised nowhere — the edit it reports moves neither of those
  files).
- **`orchestrator/`** — a read-only view of the run-state directory, current run and
  archived runs alike, plus two pieces of in-memory bookkeeping that are lost on restart
  on purpose: what the watchdog has done, and which projects this process has just asked
  to start a run.
- **`agents/`** — the one module that makes an outbound call, to the local
  claude-agents-dashboard, and the only one that can start a session. Off unless
  `BM_AGENTS` says otherwise; every POST here is additionally guarded by content-type and
  `Origin`, because loopback is no boundary against a page in this machine's own browser.
  The run watchdog lives here too, armed only while some run file says `running`.
- **`registry/`** — read-only view of the registry file.
- **`static.ts` / `security.ts`** — the built client is served only if it was built, and
  the served build carries a CSP whose `script-src` pins the inline theme script by hash.

### The client — [full doc](subsystems/board.md)

A React SPA, four sections behind a side rail
([`App.tsx`](../client/src/App.tsx)) and each one its own lazy chunk: Board, Runs,
Archive, Settings. The server returns whole corpora, so most of what you see is decided
in the browser — whether an item is groomed, whether it belongs on the Board or in
Archive, how long an item's work took, what a run's cost was. Those derivations live in
`client/src/lib/` as one implementation each, precisely so two surfaces cannot disagree
about the same item; the ones the server needs too live in
[`shared/`](../shared/agent.ts) beside the wire types.

### The skills — [full doc](subsystems/skills.md)

Five skills under `skills/`, two CLIs beneath them (`backlog.mjs`, the registry's only
writer; `orchestrate.mjs`, the run file's only writer), and one agent under `agents/`
that the orchestrator dispatches to review an item's branch before it merges.
`backlog-orchestrate` is the only skill that touches git history at all — it works one
item per worktree and merges to `main` — while execute does the work and groom writes the
plans, neither of them committing anything.

An install is a copy of the pushed `HEAD`, never the working tree; see
[workflows/publishing.md](workflows/publishing.md).

### Where the rules live

[CLAUDE.md](../CLAUDE.md) carries every rule as one normative line, and
[subsystems/invariants.md](subsystems/invariants.md) carries the reasoning for the ones
that need more than that. If the two ever disagree, the code and its tests decide — but
the disagreement itself is a bug worth fixing in the same sitting.

<!-- docs-sync:
  sources:
    - server/src/app.module.ts
    - server/src/static.ts
    - client/src/App.tsx
    - client/src/components/SideRail.tsx
    - shared/types.ts
    - shared/agent.ts
    - skills
    - agents
    - docs/.docs-sync.yml
  kind: overview
  verified: 07169ebeb2df774c00d134b5bb926ce8d5762b9f
-->
