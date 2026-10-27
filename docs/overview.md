# backlog-manager

A Claude Code plugin that publishes seven backlog skills — capture, groom, execute, orchestrate, retro, tick and a read-only board printer — and a `jira` skill
that reads and moves a Jira ticket through the local API, together with a local web app that shows every registered project's backlog on one board. There is no
database: the registry file and each project's `backlog/` directory _are_ the data, and everything the app displays is derived from them on the way out.

The plugin half and the app half share one rule that explains most of the design: **the skills write, everything else reads.** The server and the client never
touch an item file, and each file that holds state has exactly one writer. The one place the server writes items is a TRACKER project (task-46), whose items
are GitHub issues rather than files: there the skills still decide every write, and the server carries it out, because the credential lives nowhere else.

## Map

| doc                                                  | what it is                                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [README.md](../README.md)                            | the human front door — what this is, quick start, the surfaces                                                          |
| [CLAUDE.md](../CLAUDE.md)                            | the normative index: one headline per rule — mechanism in `.claude/rules/`, reasoning in `subsystems/invariants.md`     |
| [subsystems/api.md](subsystems/api.md)               | the Nest side: what each module owns, which reads are cached and which must never be                                    |
| [subsystems/jira.md](subsystems/jira.md)             | the Jira integration's server half: the client, the board poller and its caches, the `/api/jira` read routes            |
| [subsystems/board.md](subsystems/board.md)           | the client: the five sections, and what the browser derives rather than fetches                                         |
| [subsystems/releases.md](subsystems/releases.md)     | the board's own versions: `GET /api/releases` from the checkout's tags, the rail's version chip and the What's new drawer |
| [.claude/DESIGN.md](../.claude/DESIGN.md)            | the client's visual language: the reference design (§1–7, copied from the dashboard) and how this board applies it (§8) |
| [subsystems/skills.md](subsystems/skills.md)         | the eight skills, the CLIs beneath them, and the reviewer agent                                                         |
| [subsystems/invariants.md](subsystems/invariants.md) | the rationale behind the rules whose "why" outruns one line — most encode a failure that already happened               |
| [workflows/development.md](workflows/development.md) | running the app while you work on it: stack or host, ports, verification, failure modes                                 |
| [workflows/publishing.md](workflows/publishing.md)   | getting a skill edit out of the working tree and into the installed plugin                                              |
| [workflows/ci.md](workflows/ci.md)                   | the PR gate: `ci / checks`, `ci / pr-title`, `ci / skills` from release-kit, and the `main-pr-only` ruleset             |
| [workflows/remote-machine.md](workflows/remote-machine.md) | adding a second machine to the launch picker: its name, its tailnet reach, its allowlist and token, this board's `.env` |

`.claude/rules/` sits beside that table rather than in it: eleven path-scoped files that a session loads automatically when it reads a file under their `paths:`
glob, each the one home of the mechanism text for the rules scoped to its paths — CLAUDE.md keeps the headlines, `subsystems/invariants.md` the reasoning. They
are guarded by `test/claude-rules.test.ts` rather than by `/docs-sync`, because what can rot in them is mechanical: a dead anchor, a glob that matches nothing,
a headline that no longer matches CLAUDE.md's, an anchor homed in two files or in none.

Deliberately not tracked, and each for a stated reason in [`.docs-sync.yml`](.docs-sync.yml): `backlog/` (the store's own items and README), `docs/superpowers/`
(specs, plans, decision logs), `audits/` (dated findings), and `skills/` + `agents/` — those are the product, not documentation about it.

## Architecture

### The data plane

Six artefacts hold everything, and the single-writer column is the load-bearing part:

| artefact                                             | one writer                                         | read by                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `~/.backlog-manager/registry.json`                   | `skills/backlog/tools/backlog.mjs`                 | the server, per request, never cached                                                                       |
| each project's `backlog/**/*.md`                     | the skills                                         | the server's scan; the client renders it                                                                    |
| `~/.backlog-manager/orchestrator/<project>/run.json` | `skills/backlog-orchestrate/tools/orchestrate.mjs` | `server/src/orchestrator/`, fresh per request                                                               |
| `~/.backlog-manager/settings/`                       | the server                                         | the watchdog config and the tracker sync intervals it wrote, and — for the control file — `orchestrate.mjs`, and — for `tick.json` — `tick.mjs` |
| `~/.backlog-manager/retro/`                          | `skills/backlog-retro/tools/retro.mjs record`      | `retro.mjs sweep`, read-only, for the deltas against the newest record of the same scope                    |
| `~/.backlog-manager/tick/`                           | `skills/backlog-tick/tools/tick.mjs`               | the server's `tick/` module, read-only, for `GET /api/ticks`                                                |

The `settings/` row is the one exception to the direction of travel: everything else under `~/.backlog-manager` flows tool → server, and the control file — one
per project, holding a pause request or a stop request (bug-39) — flows server → tool. The retro home travels nowhere at all — one tool writes it and the same tool reads it back on the next sweep. The run file's own single-writer
guarantee is untouched by it. `settings/` also holds `jira.json`, which the server reads and writes through six guarded config routes (`POST /api/jira/boards`, `/boards/delete`,
`/repos`, `/skills`, `/skills/delete` and `/repo-defaults`), and a hand edit still lands ([subsystems/jira.md](subsystems/jira.md)), and `dashboards.json`, the
list of other machines a launch can go to, which the server alone reads and writes through four guarded routes under `/api/dashboards` — no skill reads it
([workflows/remote-machine.md](workflows/remote-machine.md)). And it holds `tick.json`, the tick breaker's halt threshold and per-project resets, which travels
server → tool like the control file: the server writes it through two guarded routes (`POST /api/ticks/config` and `/reset`), and `tick.mjs` only reads it.

### The API — [full doc](subsystems/api.md)

Nest, composed in [`app.module.ts`](../server/src/app.module.ts), every route under `/api`:

- **`items/`** — resolves which source owns each registered project's items (its committed `backlog/source.json`, read per request; absent means the files on
  disk), lists them through that source's adapter — `files` or, since task-45, `github` — parses frontmatter, derives what the board needs, and serves item
  bodies through a registry-built allowlist so a file outside every registered `backlog/` cannot be read; a `gh:<owner>/<repo>#<n>` URN goes to the tracker
  adapter instead, gated on the registry the same way. Since task-46 it also holds the app's ONLY writes to anybody's items — eleven guarded POST routes (one,
  `abort`, served from `agents/` because it calls the dashboard) that a tracker project's items go through, refused outright for a `files` project,
  whose credential never leaves the server. Two git-backed reads live here: the last
  commit touching an item file (memoised against the files git rewrites) and which items differ from the run's base, `main` by default (memoised nowhere — the edit it reports moves
  neither of those files).
  Every git spawn the server makes is async with a 10 s timeout (`git-run.util.ts`, #277), so a slow repository slows only the routes that read it.
- **`orchestrator/`** — a read-only view of the run-state directory, current run and archived runs alike, plus two pieces of in-memory bookkeeping that are lost
  on restart on purpose: what the watchdog has done, and which projects this process has just asked to start a run. Since task-48 it also derives the runs
  other machines drove on a tracker project from the poller's cached claim comments, and serves them in a separate `remote` array, never among the local runs.
- **`agents/`** — one of the three modules that make an outbound call — to the local claude-agents-dashboard — and the only one that can start a session. Off
  unless `BM_AGENTS` says otherwise; every POST here is additionally guarded by content-type and `Origin`, because loopback is no boundary against a page in
  this machine's own browser (the `Host` allowlist above is what covers the rebinding case those two checks do not). The run watchdog lives here too, armed only
  while some run file says `running`. Its `dashboards/` folder is what lets a launch go to ANOTHER machine's dashboard instead — the outbound destinations are
  then the remote dashboards and the remote boards named in `~/.backlog-manager/settings/dashboards.json`, still this one module, and with no such file nothing
  about a launch changes ([setup](workflows/remote-machine.md)).
- **`tracker/`** — the second of three outbound-calling modules: a GitHub client, a poller armed only while a project is connected and `BM_GITHUB_TOKEN` is set,
  the in-memory issue cache the `github` adapter answers from (one of the two caches in this server whose age is rendered, as `polledAt`), the eleven-label
  bootstrap, the claim protocol's pure half (`claim.ts` — what a claim IS, and why the lowest live comment id wins), and a read-only `trackers` route for
  Settings. The token is read per call from the environment and reaches no payload.
- **`jira/`** — the third outbound-calling module, and only while `BM_JIRA_SITE`, `BM_JIRA_EMAIL` and `BM_JIRA_TOKEN` are all set: a Jira Cloud client on
  Atlassian's gateway, a poller that sweeps the boards in `~/.backlog-manager/settings/jira.json` into in-memory caches (the second cache whose age is
  rendered), and nine read routes under `/api/jira` (`/prompt` composes a Run session's prompt; `/refs` and
  `/worktrees` read a mapped repo's git), plus eight guarded POSTs — six config writes to `jira.json` (`/boards`, `/boards/delete`, `/repos`, since phase 5a
  `/skills`, `/skills/delete`, and `/repo-defaults`) and, since phase 3, two writes to Jira itself (`/issue/assign` `{ key }`
  and `/issue/transition` `{ key, transitionId }`), the only writes this server makes to Jira. An in-memory live map of Jira sessions sits here too, driven from
  `agents/` by `POST /api/agents/dispatch-jira` and `/jira-stop` — part of the
  [Jira integration](superpowers/specs/2026-10-15-jira-integration-design.md); [full doc](subsystems/jira.md).
- **`registry/`** — read-only view of the registry file.
- **`hub/`** — three read-only Lookout widgets (open work, projects, this machine's run state) at `/api/hub/widgets`, served through the `lookout-widgets`
  package (#249). No actions, so no write path; it reads runs through the pure service read, so a hub poll never arms the watchdog. The run widget opens
  `/?section=runs&runs=history`, the one URL the client reads (`client/src/lib/deep-link.ts`); the other two open `/`. That reader has one more parameter,
  `settings=shared|local|dashboards`, honoured only beside `section=settings`: the launch sheets' "Run on" card links to the Dashboards page with it, because
  the viewer's stored scope defaults to `local`.
- **`tick/`** — the tick breaker's three routes under `/api/ticks`: a `GET` that reads the tick home `tick.mjs` writes (one directory per project, holding
  `state.json`, `lock` and `last-decide.json`) and never writes under it, and the two guarded POSTs that write `tick.json`. Not an outbound-calling module.
- **`releases/`** — `GET /api/releases`, this checkout's own `vX.Y.Z` tags for the rail's version chip, read through release-kit's reader with every git call
  going through `runGit`. Read-only and git only, so not an outbound-calling module either; [full doc](subsystems/releases.md).
- **`static.ts` / `security.ts` / `allowed-hosts.ts`** — the built client is served only if it was built; the served build carries a CSP whose `script-src` pins
  the inline theme script by hash; and every route, read or write, is gated by a `Host` allowlist, which is what a page that rebinds DNS onto loopback cannot
  pass.

### The client — [full doc](subsystems/board.md)

A React SPA, five sections behind a side rail ([`App.tsx`](../client/src/App.tsx)) and each one its own lazy chunk: Board, Runs, Archive, Jira (drawn only when
configured), Settings. The server returns whole corpora, so most of what you see is decided in the browser — whether an item is groomed, whether it belongs on
the Board or in Archive, how long an item's work took, what a run's cost was. Those derivations live in `client/src/lib/` as one implementation each, precisely
so two surfaces cannot disagree about the same item; the ones the server needs too live in [`shared/`](../shared/agent.ts) beside the wire types. The
rail ends in a version chip that opens a What's new drawer of every release, read from the checkout's own tags ([releases](subsystems/releases.md)).

### The skills — [full doc](subsystems/skills.md)

Eight skills under `skills/`, five CLIs beneath them (`backlog.mjs`, the registry's only writer; `orchestrate.mjs`, the run file's only writer; `retro.mjs`, the
retro home's only writer and the one of the four writers nothing else reads at runtime; `tick.mjs`, the tick home's only writer, which decides one unattended
unit of work per scheduled tick and is read-only against items, the run state and git; `jira.mjs`, API-only, which writes no file and reaches Jira through
`/api/jira` — save `worktree`, which is git only and makes a ticket's worktree in a mapped repo), and one agent under `agents/` that the orchestrator
dispatches to review an item's branch before it merges (and execute, before a `pr`-mode push).
`backlog-orchestrate` is the only skill that merges into a base — it works one item per worktree and merges each into the run's base branch (`main` unless the
run
was given `--base`), or leaves a reviewed branch per item in branch mode, or — in PR mode, tracker projects only — merges them onto a run branch of its own and
opens one pull request into the base, and for a tracker project it pushes that base — while execute does the work and groom writes the plans. Execute and groom
commit and push only when their trigger says `--finish pr` (the board's launch sheet picks it per run), and then only their own branch in their own worktree
(`execute/<id>`, `groom/<id>`), ending in a pull request rather than a merge; with `--auto-merge` (and optionally `--fix`) they may arm GitHub auto-merge on
that PR and wait for GitHub to land it, which is still not the skill merging.

An install is a copy of the pushed `HEAD`, never the working tree; see [workflows/publishing.md](workflows/publishing.md).

### Where the rules live

[CLAUDE.md](../CLAUDE.md) carries every rule as one normative headline; the rule's mechanism lives in exactly one `.claude/rules/*.md` file, loaded when a
session reads a file under its scope; and [subsystems/invariants.md](subsystems/invariants.md) carries the reasoning. If the tiers ever disagree, the code and
its tests decide — but the disagreement itself is a bug worth fixing in the same sitting.

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
  verified: 5a74ebf0f276cf9103c7a744f913c01f02e178f5
-->
