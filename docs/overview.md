# backlog-manager

A Claude Code plugin that publishes six backlog skills — capture, groom, execute, orchestrate, retro and a read-only board printer — together with a local web
app that shows every registered project's backlog on one board. There is no database: the registry file and each project's `backlog/` directory _are_ the data,
and everything the app displays is derived from them on the way out.

The plugin half and the app half share one rule that explains most of the design: **the skills write, everything else reads.** The server and the client never
touch an item file, and each file that holds state has exactly one writer.

## Map

| doc                                                  | what it is                                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [README.md](../README.md)                            | the human front door — what this is, quick start, the surfaces                                                          |
| [CLAUDE.md](../CLAUDE.md)                            | the normative index: one line per rule, for anyone (or anything) working in this repo                                   |
| [subsystems/api.md](subsystems/api.md)               | the Nest side: what each module owns, which reads are cached and which must never be                                    |
| [subsystems/board.md](subsystems/board.md)           | the client: the four surfaces, and what the browser derives rather than fetches                                         |
| [.claude/DESIGN.md](../.claude/DESIGN.md)            | the client's visual language: the reference design (§1–7, copied from the dashboard) and how this board applies it (§8) |
| [subsystems/skills.md](subsystems/skills.md)         | the six skills, the CLIs beneath them, and the reviewer agent                                                           |
| [subsystems/invariants.md](subsystems/invariants.md) | the rationale behind the rules whose "why" outruns one line — most encode a failure that already happened               |
| [workflows/development.md](workflows/development.md) | running the app while you work on it: stack or host, ports, verification, failure modes                                 |
| [workflows/publishing.md](workflows/publishing.md)   | getting a skill edit out of the working tree and into the installed plugin                                              |

`.claude/rules/` sits beside that table rather than in it: six path-scoped pointer files that a session loads automatically when it reads a file under their
`paths:` glob, each one line per anchor into `subsystems/invariants.md` and no prose of its own. They are guarded by `test/claude-rules.test.ts` rather than by
`/docs-sync`, because what can rot in them is a dead anchor or a glob that matches nothing — both mechanical checks.

Deliberately not tracked, and each for a stated reason in [`.docs-sync.yml`](.docs-sync.yml): `backlog/` (the store's own items and README), `docs/superpowers/`
(specs, plans, decision logs), `audits/` (dated findings), and `skills/` + `agents/` — those are the product, not documentation about it.

## Architecture

### The data plane

Five artefacts hold everything, and the single-writer column is the load-bearing part:

| artefact                                             | one writer                                         | read by                                                                       |
| ---------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `~/.backlog-manager/registry.json`                   | `skills/backlog/tools/backlog.mjs`                 | the server, per request, never cached                                         |
| each project's `backlog/**/*.md`                     | the skills                                         | the server's scan; the client renders it                                      |
| `~/.backlog-manager/orchestrator/<project>/run.json` | `skills/backlog-orchestrate/tools/orchestrate.mjs` | `server/src/orchestrator/`, fresh per request                                 |
| `~/.backlog-manager/settings/`                       | the server                                         | the watchdog config it wrote, and — for the pause request — `orchestrate.mjs` |
| `~/.backlog-manager/retro/`                          | `skills/backlog-retro/tools/retro.mjs record`      | `retro.mjs sweep`, read-only, for the deltas against the newest record        |

The `settings/` row is the one exception to the direction of travel: everything else under `~/.backlog-manager` flows tool → server, and the pause request flows
server → tool. The retro home travels nowhere at all — one tool writes it and the same tool reads it back on the next sweep. The run file's own single-writer
guarantee is untouched by it.

### The API — [full doc](subsystems/api.md)

Nest, composed in [`app.module.ts`](../server/src/app.module.ts), every route under `/api`:

- **`items/`** — resolves which source owns each registered project's items (its committed `backlog/source.json`, read per request; absent means the files on
  disk), lists them through that source's adapter — `files` or, since task-45, `github` — parses frontmatter, derives what the board needs, and serves item
  bodies through a registry-built allowlist so a file outside every registered `backlog/` cannot be read; a `gh:<owner>/<repo>#<n>` URN goes to the tracker
  adapter instead, gated on the registry the same way. Since task-46 it also holds the app's ONLY writes to anybody's items — seven guarded POST routes that a
  tracker project's items go through, refused outright for a `files` project, whose credential never leaves the server. Two git-backed reads live here: the last
  commit touching an item file (memoised against the files git rewrites) and which items differ from `main` (memoised nowhere — the edit it reports moves
  neither of those files).
- **`orchestrator/`** — a read-only view of the run-state directory, current run and archived runs alike, plus two pieces of in-memory bookkeeping that are lost
  on restart on purpose: what the watchdog has done, and which projects this process has just asked to start a run.
- **`agents/`** — one of the two modules that make an outbound call — to the local claude-agents-dashboard — and the only one that can start a session. Off
  unless `BM_AGENTS` says otherwise; every POST here is additionally guarded by content-type and `Origin`, because loopback is no boundary against a page in
  this machine's own browser (the `Host` allowlist above is what covers the rebinding case those two checks do not). The run watchdog lives here too, armed only
  while some run file says `running`.
- **`tracker/`** — the other outbound-calling module: a GitHub client, a poller armed only while a project is connected and `BM_GITHUB_TOKEN` is set, the
  in-memory issue cache the `github` adapter answers from (the one cache in this server whose age is rendered, as `polledAt`), the eight-label bootstrap, the
  claim protocol's pure half (`claim.ts` — what a claim IS, and why the lowest live comment id wins), and a read-only `trackers` route for Settings. The token
  is read per call from the environment and reaches no payload.
- **`registry/`** — read-only view of the registry file.
- **`static.ts` / `security.ts` / `allowed-hosts.ts`** — the built client is served only if it was built; the served build carries a CSP whose `script-src` pins
  the inline theme script by hash; and every route, read or write, is gated by a `Host` allowlist, which is what a page that rebinds DNS onto loopback cannot
  pass.

### The client — [full doc](subsystems/board.md)

A React SPA, four sections behind a side rail ([`App.tsx`](../client/src/App.tsx)) and each one its own lazy chunk: Board, Runs, Archive, Settings. The server
returns whole corpora, so most of what you see is decided in the browser — whether an item is groomed, whether it belongs on the Board or in Archive, how long
an item's work took, what a run's cost was. Those derivations live in `client/src/lib/` as one implementation each, precisely so two surfaces cannot disagree
about the same item; the ones the server needs too live in [`shared/`](../shared/agent.ts) beside the wire types.

### The skills — [full doc](subsystems/skills.md)

Six skills under `skills/`, three CLIs beneath them (`backlog.mjs`, the registry's only writer; `orchestrate.mjs`, the run file's only writer; `retro.mjs`, the
retro home's only writer and the one of the three nothing else reads at runtime), and one agent under `agents/` that the orchestrator dispatches to review an
item's branch before it merges. `backlog-orchestrate` is the only skill that touches git history at all — it works one item per worktree and merges to `main` —
while execute does the work and groom writes the plans, neither of them committing anything.

An install is a copy of the pushed `HEAD`, never the working tree; see [workflows/publishing.md](workflows/publishing.md).

### Where the rules live

[CLAUDE.md](../CLAUDE.md) carries every rule as one normative line, and [subsystems/invariants.md](subsystems/invariants.md) carries the reasoning for the ones
that need more than that. If the two ever disagree, the code and its tests decide — but the disagreement itself is a bug worth fixing in the same sitting.

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
  verified: d3dbf8855e78b4ae70c792eeb7696167a44ce8a4
-->
