# backlog-manager

Claude Code plugin repo: six backlog skills — `backlog`, `backlog-capture`, `backlog-groom`, `backlog-execute`, `backlog-orchestrate` (drains a project's
groomed queue, one item per git worktree, each reviewed and verified before it merges), `backlog-retro` (sweeps every orchestrator run on the machine into a
report, a pick-list of items and a record the next sweep is measured against) — plus a local NestJS + React app that shows every registered project's backlog on
one kanban-by-type board. No database: the registry file and each project's `backlog/` directory are the data.

## Commands

| Task                                      | Command                                                |
| ----------------------------------------- | ------------------------------------------------------ |
| Whole stack (api + client, no db)         | `pnpm run docker:up`                                   |
| Rebuild the stack from scratch            | `pnpm run docker:sync`                                 |
| API only, on the host                     | `pnpm run dev`                                         |
| Client only, on the host                  | `pnpm run dev:web`                                     |
| Tests (both runners)                      | `pnpm test` (`scripts/test-all.mjs` — jest, then node) |
| Tests, jest only                          | `pnpm run test:jest` (`jest --runInBand`)              |
| Skill tests                               | `pnpm run test:skills` (`node --test`)                 |
| Reinstall the plugin from the pushed HEAD | `pnpm run plugin:sync`                                 |
| Publish the web port to the tailnet       | `pnpm run tailnet` (`up` \| `status` \| `down`)        |
| Types                                     | `pnpm run typecheck`                                   |
| Production build                          | `pnpm run build`                                       |

Ports: API `4322`, Vite `5177` (guide-manager holds 4321/5175/5176 on this machine). Only the host side moves, via `BM_API_PORT` / `BM_WEB_PORT` in `.env` —
inside the compose stack they are fixed. `pnpm run tailnet` reads `BM_WEB_PORT` from that same `.env` and serves the tailnet on the same number.

## Layout

One line per seam. The mechanism lives in the subsystem docs linked below; the reasoning behind the rules in the next section lives in
[docs/subsystems/invariants.md](docs/subsystems/invariants.md). The doc map is [docs/overview.md](docs/overview.md).

- `server/src/` — Nest, every route under `/api`: `health/`, `items/` (items, projects, item bodies, `uncommitted`, the read-only claim lookup, the item-source
  adapters, and — since task-46 — the seven guarded write routes in `items-write.controller.ts`, which are the ONLY writes this server makes to anybody's
  items), `agents/` (the
  dashboard calls, plus the run watchdog), `tracker/` (the GitHub client, the issue poller and its in-memory cache, the label bootstrap and the read-only
  `trackers` route) — those two are the outbound-calling modules, and the ONLY two — `orchestrator/` (a read-only view of the run-state directory, plus the
  in-memory watchdog and starting-run records, the remote-run derivation over the tracker cache, and the two files the server does write), `registry/`, `static.ts` (serves `client/dist` only when built),
  `security.ts`, `allowed-hosts.ts` (the Host allowlist every route is gated by). → [docs/subsystems/api.md](docs/subsystems/api.md)
- `client/src/` — React SPA: four lazy sections behind a side rail (Board, Runs, Archive, Settings), one run chip in the board's band, and the three-step
Orchestrate sheet. Runs is TWO pages under one rail entry — History (a figure strip, a 420 px Live+History list column, one always-visible detail sheet — and,
  on a board 1400 px or wider, that strip standing as a 320 px right rail instead) and

  Watchdog — switched by the rail's sub-nav tree alone, never by an in-page control. Every derivation has one home in `lib/`, and every look more than one
  surface draws has one home in `components/ui/`. A connected tracker adds three readings and no new surface: the band's poll-age line, the card's
  `untyped`/assignee/link-out, and the item modal's age beside the cached body — all derived in `lib/tracker.ts`, plus the read-only `Trackers` card on Shared
  Settings. → [docs/subsystems/board.md](docs/subsystems/board.md)
- [`.claude/DESIGN.md`](.claude/DESIGN.md) — the client's visual language: §1–7 copied from the dashboard, §8 how this board applies it; every component must
  cite its subsection in a header comment. Not a `.claude/rules/` file — those pin to `invariants.md` anchors only.
- `shared/` — `types.ts` (all shared shapes), `agent.ts` (`deriveAction`, `dispatchGate` and the run/watchdog predicates both sides must agree on), `theme.css`
  (five theme palettes).
- `skills/backlog/`, `skills/backlog-capture/`, `skills/backlog-groom/`, `skills/backlog-execute/`, `skills/backlog-orchestrate/`, `skills/backlog-retro/` — the
  skills this repo publishes. `skills/backlog/tools/backlog.mjs` is the registry's only writer; `skills/backlog-orchestrate/tools/orchestrate.mjs` is the run
  file's only writer. `skills/backlog-retro/tools/retro.mjs` reads the run-state directory, the registry and — by recorded lease id — each run's driver
  transcript, and owns `~/.backlog-manager/retro/` ([spec](docs/superpowers/specs/2026-09-06-backlog-retro-design.md)). **Start orchestrator runs from the
  board, not by typing the trigger into a terminal.** → [docs/subsystems/skills.md](docs/subsystems/skills.md)
- `agents/` — the plugin's own agents, one file each, discovered from this root-level directory by Claude Code's own convention. Currently one:
  `backlog-reviewer.md`, the reviewer `backlog-orchestrate` dispatches before every merge.
- `.claude/rules/` — six path-scoped pointer files, injected into a session the moment it reads a file under their `paths:` glob. Each is one line per anchor
  into `docs/subsystems/invariants.md` and nothing else; the reasoning has one home and this is not it.
- `backlog/` — this repo's own backlog, self-registered like any project.
- `scripts/` — `sync-plugin.mjs` (reinstall the plugin from the pushed HEAD, → [docs/workflows/publishing.md](docs/workflows/publishing.md)), `test-all.mjs`
  (`pnpm test`, → [docs/workflows/development.md](docs/workflows/development.md)) and `tailnet.mjs` (`pnpm run tailnet` — the `tailscale serve` wrapper).
- `docs/` — the reference docs; `docs/superpowers/` holds the design spec and implementation plans this repo was built from.

## Invariants

Each entry is the rule; its `Why:` link is the reasoning, in [docs/subsystems/invariants.md](docs/subsystems/invariants.md). Read that section before changing
any of these — most encode a failure that already happened. Every rule is STATED here in full, because a `.claude/rules/` glob does not fire for a `Write`, a
`Grep`/`Glob` or a `codegraph_explore` read; what lives only behind the link is the elaboration — the mechanism, the file list, the failure it encodes.

- **`skills/` is the plugin skill root**; never duplicate it under `.claude/skills/` — that loads the same skills twice and drifts.
- **`~/.backlog-manager/registry.json` has exactly one writer**: `skills/backlog/tools/backlog.mjs` (`init`/`new` upsert, plus `unregister`). The server
  re-reads it per request, never writes, never caches. What gets written is `registryRoot(root)`, not the root `resolveRoot` returned (bug-17): a linked
  worktree registers its **main tree**. Why:
  [invariants.md](docs/subsystems/invariants.md#registryjson-has-exactly-one-writer-and-a-linked-worktree-registers-its-main-tree)
- **The orchestrator's run file has exactly one writer, one reader — the same relationship the registry has.**
  `skills/backlog-orchestrate/tools/orchestrate.mjs` is the writer, `server/src/orchestrator/` is the reader, and `run.json` lives outside the repo entirely,
  under `$BM_ORCH_HOME` or `~/.backlog-manager/orchestrator/`. The server reads it fresh on every request, never writes or caches it. Why:
  [invariants.md](docs/subsystems/invariants.md#the-orchestrators-run-file-has-exactly-one-writer-one-reader--the-same-relationship-the-registry-has)
- **Remote runs ride beside `runs`, never in it** (task-48). `OrchestratorRunsPayload.remote` is other machines' runs on a tracker project, derived by
  `RemoteRunsService` from the poller's cached claim comments — never from a file, no cache or request of its own. `OrchestratorService.runs()` fills `[]` and
  the controller overwrites it, so the `RUN_IN_PROGRESS_CODE` lock, `runClaimBlock` and the watchdog stay local-only and two machines never block each other.
  A derived run whose `runId` any local run file carries (current or archived, by name through `archivedRunFiles`) is DROPPED, never merged; `project` is this
  machine's registry path; status is the newest `finished` stamp unless ANOTHER claim heartbeated after it, else `running` — a crashed remote run stays
  crashed. A remote row is read-only: no `RunControls`, no `archive/run` fetch. Why:
  [invariants.md](docs/subsystems/invariants.md#remote-runs-ride-beside-runs-never-in-it)
- **`~/.backlog-manager/retro/` has exactly one writer, `retro.mjs record`, and `backlog-retro` never writes under the run-state directory.** A record is
  evidence, so `record` refuses to overwrite one (exit `2`): the fix for a wrong record is the next sweep, never an edit. Why:
  [invariants.md](docs/subsystems/invariants.md#backlog-managerretro-has-exactly-one-writer-and-the-retro-never-writes-run-state)
- **A run's sidecars are archived beside its run file, under a name derived from the archive path and stored nowhere.** One `archiveStem` names both
  `runs/<stem>.json` and `runs/<stem>/`; there is no `sidecarDir` field, and `archivedRunFiles` (`orchestrator.service.ts`) is the ONE implementation of
  "which entries are run files". Why: [invariants.md](docs/subsystems/invariants.md#a-runs-sidecars-are-archived-beside-its-run-file-task-31)
- **A board-started run is visible before its run file exists, from server memory that is never written to disk.** `StartingRunsService` is a
  `Map<project, requestedAt>`, lost on restart on purpose, riding the payload as a separate top-level `starting` array — never a `status: 'starting'` member of
  `runs`. A starting row carries no controls and cannot be selected. Why:
  [invariants.md](docs/subsystems/invariants.md#a-board-started-run-is-visible-before-its-run-file-exists)
- **A starting entry blocks what a run file blocks, on every surface** (bug-21). `runClaimBlock` (`shared/agent.ts`) takes `starting` as a required third
  parameter, no `[]` default; the block is project-wide and deliberately coarse. `runHoldsItem` deliberately does NOT gain the parameter. Why:
  [invariants.md](docs/subsystems/invariants.md#a-starting-entry-blocks-what-a-run-file-blocks-bug-21)
- **Escape has one owner, and the topmost dialog is the only one that closes.** `hooks/useDialogEscape.ts` is a module-level LIFO stack plus a single `window`
  listener; three dialogs are on it — the item modal, `LaunchSheet`, `OrchestrateSheet` — and none binds its own (bug-23 — four until task-37 took the run
  drawer off the Board, whose content is an inline sheet and never a dialog again). Since task-40 the hook is called by the two overlay shells
  (`ui/Modal.tsx`, `ui/FormSheet.tsx`). Ranking is by mount order; entries are removed by identity, never popped. Why:
  [invariants.md](docs/subsystems/invariants.md#escape-has-one-owner-and-the-topmost-dialog-is-the-only-one-that-closes)
- **Item files are read-only to the server and client**; every write goes through the skills. Dispatch writes no item files either — the spawned session runs
  the skills, which remain the only writers. **A TRACKER project's items are the one thing this server writes** (task-46), and only through the seven routes
  below — never a file, on any path.
- **The seven `/api/items/*` write routes are guarded like the agents POSTs, refused for a `files` project, and serialised per item.** Every one of them is
  `@UseGuards(SameOriginPostGuard)` (`items-write.controller.ts`) and is a thin pass-through to an `ItemWriter` method; `ItemsService.writerFor` gates the
  `project` against the registry by a RAW string compare and answers `unregistered` / `files` / `unsupported` / the call. `FilesSource` has no `writer` at all,
  and that absence IS the rule. The adapter answers a VALUE for every failure (`WriteRefusal`) and the controller is the only layer mapping one to a status;
  `GithubSource` keeps a `Map<urn, Promise>` so two local sessions never race on one item. An eighth route, `GET /api/items/claim`, is a READ and unguarded
  like every other GET. Why:
  [invariants.md](docs/subsystems/invariants.md#the-seven-item-write-routes-are-guarded-refused-for-files-and-serialised-per-item)
- **The claim protocol is one comment per session per issue, and the LOWEST live comment id wins.** `server/src/tracker/claim.ts` is the one implementation of
  what a claim IS (render, parse, `claimsFor`, `isLive`, `newestClaim`, `winner`); `GithubSource.claim` is the one implementation of taking one. The sequence
  is list · post · settle (`settleMs`, 1 s) · list · UNION, and the union is what decides — never the second list alone, because GitHub's comment listing is
  eventually consistent. A LOSER deletes its own comment; a claim that merely went STALE is released (`released: { reason: 'stale' }`), never deleted, because
  it is the permanent record of work somebody did and carries the counters to prove it. **Who may release is a triple: the holder always, the RUN that owns the
  claim, ANYONE once the claim is dead** (bug-42) — the middle clause is task-47 §7.6's same-run takeover, which `claim` enforced and `release` did not, so a
  board force stop's spawned `--abort` could not release the dead driver's claims. `ItemReleaseRequest.runId` is the assertion, a 400 on anything but a
  non-empty string, sent by `trackerRelease` on EVERY release and never by `backlog.mjs stop`; the test is guarded with `typeof`/`length` so a claim with no
  `run` is never same-run with anything, and `isLive` reaches the dead clause first. `CLAIM_STALE_MS` is a named alias of `RUN_STALE_MS`, not a second
  number. The four counters live in the claim (§6.4: never in the body), are SEEDED by the server from the newest prior claim and are BILLED by the CLI on
  release — `--abandon` sends no `counters` key at all, which is not the same as zeros. The mapper reads `started`/`phase` from an UNRELEASED claim without
  consulting its heartbeat ("any stamp, fresh or stale") and the counters from the newest claim regardless of release. Why:
  [invariants.md](docs/subsystems/invariants.md#the-claim-protocol-lowest-live-comment-id-wins)
- **`backlog.mjs` in a tracker project needs the stack up, and says so with exit `5`.** The committed marker decides the mode — absent or `{"kind":"files"}`
  runs today's synchronous code byte for byte and makes no HTTP request; `{"kind":"github"}` with a valid repo routes every command through
  `http://127.0.0.1:${BM_API_PORT ?? 4322}`; anything else is exit `1` naming the marker, NEVER a fallback to files. There is no offline queue on purpose. Why:
  [invariants.md](docs/subsystems/invariants.md#backlogmjs-in-a-tracker-project-needs-the-stack-up)
- **Every server route lives under `/api`**; the Vite proxy has exactly one entry, asserted by `test/vite-proxy.test.ts`.
- **Item bodies are served through a registry-built allowlist** (`allow.util.ts`); a file outside every registered `backlog/` 404s.
- **A project's source is a committed marker, resolved per request, and an `unsupported` one never falls back to `files`.** `resolveSource`
  (`server/src/items/sources/resolve.util.ts`) reads `backlog/source.json` per request, caches nothing, and answers `missing` / `files` / `tracker` /
  `unsupported`; `ItemsService` dispatches over the adapters registered under `ITEM_SOURCES` and **throws at boot** if two claim one kind. Absent means `files`.
  An unsupported marker contributes **no items** and one `ItemsIndex.errors` entry. `SourceKind` is the closed list of adapters this build ships and widens
  only with the adapter. Why:
  [invariants.md](docs/subsystems/invariants.md#a-projects-source-is-a-committed-marker-resolved-per-request-and-an-unsupported-one-never-falls-back-to-files)
- **The GitHub token never leaves the server, and the poller is armed only while something is connected.** `githubToken()`
  (`server/src/tracker/token.util.ts`) reads `BM_GITHUB_TOKEN` per call and caches nowhere; no route returns it and the browser never talks to
  `api.github.com`. `docker-compose.yml` passes it through as an interpolation with a default, never a literal. `TrackerPollerService` is a `setTimeout` chain
  armed only while a registered project resolves to `github` AND a token is present, disarmed on the tick that finds either missing. Why:
  [invariants.md](docs/subsystems/invariants.md#the-github-token-never-leaves-the-server-and-the-poller-is-armed-only-while-something-is-connected)
- **The tracker cache is the one cache in this server whose age is a rendered value.** In memory, per repo, lost on restart, rebuilt by the first sync; it
  exists because the hourly rate limit makes a per-request fetch impossible, and `polledAt` on the board, in the item modal, on the Trackers card and — since
  bug-41 — beside every tracker queue `orchestrate.mjs plan`/`init` builds is what keeps it honest. **A named `--ids` entry the cache has not polled yet buys
  ONE re-read, timed off `polledAt`, and only a second miss is refused** — never a fresh per-id `GET` to GitHub, which was weighed and rejected. Every other read stays per request — the registry's and `resolveSource`'s rules are untouched. A `304` leaves the cache unchanged and MOVES
  `polledAt`: the rendered age means "since we last successfully checked", and a conditional request that came back `304` is a successful check (settled
  2026-09-18 in spec §12.2's favour, against task-45's own authoritative case, which is recorded as having been overturned). The comments request is made every
  tick and is read by `TrackerPollerService.comments()`, which is what the claim protocol maps an item's `started`/`phase` and counters
  from — and, since task-48, what `RemoteRunsService` derives other machines' runs from, with no cache of its own. **Issues and comments have SEPARATE high-water marks and each paginates to the end** — sharing one mark asked for comments `since` the newest
  ISSUE's stamp, which hid every claim older than that from a fresh process, and `readClaim` therefore falls back to one fresh read on a cache miss
  rather than reporting "unclaimed".
 Rate limits are values, never exceptions: a sleeping repo gets no request at all, and `detail` names the reset TIME. The eight labels
  live in `server/src/tracker/labels.ts`, are created idempotently on a repo's first successful sync — phase 2's one write to GitHub — and agree with
  `connect`'s issue forms by a source-reading guard (`test/tracker-labels.test.ts`), never an import. Why:
  [invariants.md](docs/subsystems/invariants.md#the-tracker-cache-is-the-one-cache-in-this-server-whose-age-is-a-rendered-value)
- **A tracker project has no item files, and that shows up in three places — and dispatch is NOT one of them.** `GET /api/items/uncommitted` answers
  `known: false`, and `uncommitted` stays a sibling endpoint nothing derived reads; `ItemsService.body` AND `ItemsService.find` dispatch on the REF'S SHAPE — a
  `gh:<owner>/<repo>#<n>` URN to the tracker adapter, anything else to files — in ONE place each side calls, and the adapter gates on the registry exactly as
  the files allowlist does; and `untyped` is a rendered badge that NOTHING derived reads (no type label → `ideas` with the badge and no error; two → the first
  alphabetically AND one `errors` entry). A closed issue keeps its `type:*` label so the original type is recoverable. **Dispatch is derived like any other
  item's since task-46** (the lift): `deriveAction` asks nothing about `source`, and the per-item block that stops a claimed tracker item is the LIVE CLAIM,
  read by `progressBlock` off the `started` the mapper fills — no tracker-specific branch anywhere. **The ORCHESTRATOR lifted one phase later (task-47, phase
  4a)**: `projectIsFiles` is deleted and `AgentsService.orchestrate`'s `arrives in phase 4` 400 is gone, and what replaced them is `resolveIds` learning the
  vocabulary — `resolveTrackerIds` proves an id against `ItemsService` where the files path proves it against a directory scan, accepts `#31`, the URN and a
  bare `31`, and **emits bare digits alone**, so no `#` reaches the prompt. Why:
  [invariants.md](docs/subsystems/invariants.md#a-tracker-project-has-no-item-files-and-that-shows-up-in-three-places)
- **Groomed is derived** (bug: Cause+Fix filled and not "unknown"; task: Plan non-empty), never stored; status is the directory, never frontmatter. Ideas,
  refactors and out-of-scope derive `null`, not `false` — grooming is not a state they have, and for the first two the state they wait in is _promoted_.
- **Board-versus-Archive is derived from `updated ?? lastCommit ?? created` and the run payload, never stored.** `isStale`/`leavesBoard`
  (`client/src/lib/item-stale.ts`) are the one implementation and `lastTouched` (`client/src/lib/item-touched.ts`) the one precedence; both predicates take
  `runs`, required, no `[]` default. In progress, held by a fresh run, done and rejected are never stale; unparseable stamps read as fresh; a task never leaves
  the Board, it gains a `stale` marker. Why:
  [invariants.md](docs/subsystems/invariants.md#board-versus-archive-is-derived-and-last-touched-has-three-rungs)
- **The middle rung of "last touched" comes from git, not the item file.** `lastCommit` (`server/src/items/git-dates.util.ts`) is the committer date of the last
  commit touching the file; every failure degrades to `created`, never throws. Memoised per project against the mtimes of `index` and `logs/HEAD` — the one
  cache in `items/`. Why: [invariants.md](docs/subsystems/invariants.md#the-middle-rung-comes-from-git-not-the-item-file)
- **The Orchestrate sheet's `uncommitted` flag is read from git per request, memoised nowhere, and must never join the memo one file over.**
  `uncommittedItemPaths` (`server/src/items/uncommitted.util.ts`), behind `GET /api/items/uncommitted`, is the one implementation. The question is "differs from
  `main`", never "differs from `HEAD`"; a sibling endpoint, never a `BacklogItem` field; nothing derived reads it and it changes no default selection. Why:
  [invariants.md](docs/subsystems/invariants.md#the-orchestrate-sheets-uncommitted-flag-is-read-from-git-per-request-and-memoised-nowhere)
- **`refactors/` is a peer section, not a facet on ideas**: ideas are new, refactors are existing things that should be improved. Prefix `ref`, lifecycle
  identical to ideas (`open/` → `done/`, promotable to a task with `from:`, rejectable). `kind: chore | debt` is written by `backlog-capture`, round-tripped by
  the CLI as an unknown key, passed through verbatim by the API, and badged only for the values `REFACTOR_KINDS` lists. `backlog-execute` refuses the section
  outright. Why: [invariants.md](docs/subsystems/invariants.md#refactors-is-a-peer-section-not-a-facet-on-ideas)
- **`started:` and `phase:` are the lifecycle keys allowed in frontmatter, and neither is a status** — the `status:` ban stands. `start`/`stop` are the only
  writers: `start` stamps `started:` and, with `--as`, `phase:`; `stop` bills four permanent, accumulating counters behind ONE billable gate, then removes
  `phase:` and, unless `--keep-started`, `started:`. `updated:` is stamped by every `start` and every `stop`, never by `move`. Both round-trip unknown keys and
  the body byte-for-byte; "in progress" is decided in the client. Why:
  [invariants.md](docs/subsystems/invariants.md#started-and-phase-are-the-lifecycle-keys-in-frontmatter-and-neither-is-a-status)
- **`backlog-orchestrate` is the only skill that commits or merges — and, for a TRACKER project only, the only one that pushes.** Inside a per-item worktree,
  on `backlog/<id>` alone; merged into the run's **base branch** (`main` unless `--base` said otherwise), `--no-ff` only, only once the tree holding that base
  is verified to have it actually checked out. No other skill touches git history at all. The push half is exactly three commands, none of them ever run for a
  files project. **A rejected or classifier-denied push PARKS, never degrades** — which is the one exception to the classifier-denial rule. Why:
  [invariants.md](docs/subsystems/invariants.md#backlog-orchestrate-is-the-only-skill-that-commits-or-merges)
- **On a tracker project the DRIVER owns each item's claim, and the execute session never touches the issue** (task-47). The run claims at
  `stage <n> preflight` — before the worktree exists — with `phase: 'execute'` and a `ClaimRun` naming the run; it publishes the queue item as `ClaimState`
  through `heartbeat` from every command that changes one (`stage`, `usage`, `verify`, `assume`, `watch`'s tick); and it releases at a terminal stage
  (`merged`, `branched`, `failed`, `skipped`, `parked`, `ungroomed` — never `needs-answers`), billing `executeElapsed`/`executeTokens` on top of the counters
  it reads first. **`abort` releases too, with the reason `aborted`** (bug-40): a torn-down run passes through no terminal stage, and an unreleased claim is
  not repaired by going stale — the mapper reads `started`/`phase` off any unreleased claim, fresh or stale, so the item's dispatch control stays disabled on
  every machine until a person intervenes. The released set is the one `heartbeat` already uses ("still holds": `claim` set and the stage not one that
  released it), the reason is deliberately NOT a `RunStage`, and the release runs before `finish` stamps `finished` on one of the same claims. **A failed heartbeat or release is one stderr line and never fails the command** — `run.json` is the journal of record and the claim is a
  published copy — while a failed CLOSE is exit `9` with nothing written, because it is the only record anywhere that the item is done. A 409 naming ANOTHER
  run skips the item (exit `0`, `claimed elsewhere`); a resumed driver re-claims its own run's items and the SERVER makes that a takeover, by `run.runId`.
  The dispatched `backlog-execute` session runs none of `start`/`stop`/`heartbeat`/`move`/`comment`: it writes its `## Outcome` to the path the
  `[orchestrator-run … outcome <path>]` marker names, and `orchestrate.mjs snapshot <n>` turns that plus the issue body into the one file the reviewer and
  `verify` read. Inside a run a tracker item's id is its **bare issue number**. Task-48 added three publishes, all best-effort: `finish` stamps
  `finished` on the last-touched claimed item, `attention` posts a `<!-- bm:attention kind=… run=… -->` comment with an `@mention` (its marker and the
  server's `ATTENTION_LINE` agree through a source-reading guard, never an import), and `heartbeat` heartbeats every claim the run still holds. `reconcile`
  reads each item's claim and suggests `skip` for another run's live one; a files run's output is byte-identical. Why:
  [invariants.md](docs/subsystems/invariants.md#the-driver-owns-a-tracker-items-claim-for-the-whole-item)
- **The merge happens in whichever tree holds the base, and the run removes only the tree it made.** git refuses one branch in two trees, so the merge site is
  resolved per merge (`git worktree list --porcelain`) into three exhaustive outcomes: a tree holds it → merge there; none does → create
  `.worktrees/_base-<sanitised ref>`, merge, remove at the end of the run; none does and `worktree add` refuses → park (detected by the create failing, never by
  the scan). A base worktree the run did not create is never removed. **"The main tree" and "the tree holding `main`" are not synonyms**: every command that
  **depends on** the HEAD of the tree it runs in follows the merge into the BASE tree (bug-38), and `orchestrate.test.mjs` pins the closed allowlist of the
  HEAD-independent shapes that may stay at the project root. `base` is required on `OrchestratorRun`, carried spawn → prompt → `init` → run file, and checked
  twice in the same order both times (`resolveBase`, `assertUsableBase`): legal ref name first, then `refs/heads/<base>` exists. Neither check alone is the
  rule, and a missing branch is a refusal, never a create. Why:
  [invariants.md](docs/subsystems/invariants.md#the-merge-happens-in-whichever-tree-holds-the-base-and-the-run-removes-only-the-tree-it-made)
- **Merge mode is run-scoped: chosen per launch, defaulted from Settings, and carried spawn → prompt → `init` → run file.** `MergeMode` (`shared/types.ts`) is
  `merge | branch`, `isMergeMode` its one guard; `init` writes `mergeMode`, `mergeModeEffective` (moves `merge` → `branch` once, never back) and
  `mergeModeNote`. **Absent means `merge`; present-but-invalid is a 400, never a clamp.** Why:
  [invariants.md](docs/subsystems/invariants.md#merge-mode-is-run-scoped-and-a-malformed-one-is-a-400)
- **`merged` is no longer the only success exit.** `branched` is its branch-mode sibling and a true exit: out of `RUN_CLAIMED_STAGES`, `ATTENTION_RUN_STAGES`
  and `MACHINE_STAGES`, in `RECONCILE_TERMINAL_STAGES`, counted as completed by `aggregateRuns`; `test/agents-shared.test.ts`'s `Record<RunStage, true>` literal
  forces the classification. A `branched` stamp does not prove the run that wrote it executed the item. Why:
  [invariants.md](docs/subsystems/invariants.md#merged-is-not-the-only-success-exit--branched-is-its-branch-mode-sibling)
- **The tool refuses `stage <id> merged` under branch mode** — exit `1`, nothing written. The converse is deliberately _not_ enforced: `stage <id> branched` is
  legal under `merge` mode too. Why: [invariants.md](docs/subsystems/invariants.md#merge-mode-is-run-scoped-and-a-malformed-one-is-a-400)
- **Question mode is run-scoped, and it only ever takes effect in a headless run.** `QuestionMode` (`shared/types.ts`) is `decide | park`, `isQuestionMode` its
  one guard; the default `park` appends nothing to the prompt. Absent means `park`; present-but-invalid is a 400, never a clamp; one field, not three.
  `orchestrate.mjs assume <id> --json <file>` is the one writer of `RunQueueItem.assumptions` and is refused under `park`. No fourth `ATTENTION_KIND`. Why:
  [invariants.md](docs/subsystems/invariants.md#question-mode-is-run-scoped-and-it-only-ever-takes-effect-in-a-headless-run)
- **A classifier denial degrades a run to branch mode; every other merge failure still parks.** Denied means the item is staged `branched`, the downgrade is
  recorded once (`merge-mode branch --note`), the queue continues, and there is no attention entry. A conflict, overlapping dirty paths and a main tree not on
  `main` still park. SKILL.md §2's preflight probe is early warning, never a guarantee — the verdict is per call. Why:
  [invariants.md](docs/subsystems/invariants.md#a-classifier-denial-degrades-the-run-every-other-merge-failure-parks)
- **Undoing an already-completed orchestrator merge is `git revert -m 1`, never `git reset --hard`** — proved empirically: the reset silently destroyed
  unrelated uncommitted work with no reflog entry to recover it. `git merge --abort` still handles an in-progress conflicted merge. Why:
  [invariants.md](docs/subsystems/invariants.md#undoing-an-already-completed-orchestrator-merge-is-git-revert--m-1-never-git-reset---hard)
- **`orchestrate.mjs` is always invoked from the project root, never from inside a per-item worktree.** Every command but `init` walks up from its cwd and
  **refuses** a linked worktree (exit `1`, naming the worktree and the project root); `init` runs the same refusal over `--project`. The discriminator is a
  `commondir` entry in the `gitdir:` target. Worktree-scoped flags (`stage --worktree`/`--branch`, `verify --cwd`) are exempt. Why:
  [invariants.md](docs/subsystems/invariants.md#orchestratemjs-is-always-invoked-from-the-project-root-never-from-inside-a-per-item-worktree)
- **A `runner-fix:` item is hoisted to the front of the queue, and the marker is read at `<base>`.** A human's judgement written during grooming, never a path
  heuristic; presence hoists, only `false` opts out; the partition is stable, outranks bugs-then-tasks and runs before `--max`; `--ids` is hoisted too. Inert
  for the _next_ run until push + `pnpm run plugin:sync`. Why:
  [invariants.md](docs/subsystems/invariants.md#a-runner-fix-item-is-hoisted-to-the-front-of-the-queue-and-the-marker-is-read-at-base)
- **Every skill CLI ends with `process.exitCode = main(...)`, never `process.exit(main(...))`.** Writing to a pipe is asynchronous, so `process.exit()`
  drops everything past 65,536 bytes of a `--json` payload while a `> file.json` redirect stays fine. Safe only because none of them holds the event loop
  open; whoever adds a timer, server or async child closes the handle rather than restoring `process.exit()`. **`backlog.mjs` and `api-call.mjs` may also end
  `process.exitCode = await main(...)`** (task-46, task-47) — the rule is about `process.exit()` truncating a pipe, which asynchrony has nothing to do with.
  `backlog.test.mjs`'s `CLI_SOURCES` is where the list of files lives, never a count in prose. Why:
  [invariants.md](docs/subsystems/invariants.md#every-skill-cli-exits-through-processexitcode-never-processexit)
- **Editing `skills/` changes nothing until it is committed, pushed, and `pnpm run plugin:sync` runs.** An install is a copy of the pushed HEAD, never the
  working tree; the sync refuses dirty/unpushed/behind states. New skills load on the next Claude Code restart. Why:
  [invariants.md](docs/subsystems/invariants.md#editing-skills-changes-nothing-until-commit--push--pluginsync)
- **`agents/` is part of the plugin's publish surface.** An install carries only what `PUBLISHED_PATHS` (`scripts/sync-plugin.mjs`) and the marketplace's
  `sparsePaths` both list; the machine-local half is declared in `~/.claude/settings.json`, never in `known_marketplaces.json` — a cache. The sync measures
  every published path on both sides (bug-10). Why: [invariants.md](docs/subsystems/invariants.md#agents-is-part-of-the-plugins-publish-surface)
- **The tailnet serve is a script, and its port is read where compose reads it.** `scripts/tailnet.mjs` (`pnpm run tailnet`, `up`/`status`/`down`) is the one
  sanctioned way past the loopback bind below; it resolves `BM_WEB_PORT` the way compose does — exported variable over `.env` over the compose default — because
  a hand-typed `tailscale serve` stores a second copy of the port inside tailscaled, which drifts and surfaces as a bare 502 on the phone. The tailnet port and
  the loopback port are always the same number (which is why HTTPS serve is out: `--https` takes only 443/8443/10000); plain HTTP is deliberate and rides inside
  WireGuard; `funnel` and `--set-path` are never used. `5177` appears once in the script, asserted against its source text by `scripts/tailnet.test.mjs`. Why:
  [invariants.md](docs/subsystems/invariants.md#the-tailnet-serve-is-a-script-and-its-port-is-read-where-compose-reads-it)
- **Both processes bind `127.0.0.1` by default; loopback is the access control** (nothing has auth). `BM_BIND` is the single knob; compose sets `0.0.0.0`. Both
  halves are pinned: `test/vite-proxy.test.ts` imports the dev config, `test/server-bind.test.ts` reads `server/src/main.ts`'s SOURCE — a bare
  `app.listen(PORT)` fails it. Why: [invariants.md](docs/subsystems/invariants.md#loopback-bind-is-the-access-control-except-where-noted)
- **Every route is gated by a Host allowlist, because a bind is no defence against DNS rebinding** (bug-22). `isAllowedHost` (`server/src/allowed-hosts.ts`) is
  the one implementation; loopback and every other IP literal, `localhost`, `.ts.net` and `BM_ALLOWED_HOSTS` are the only names this app answers to, and an
  absent or empty `Host` is refused, never defaulted. Hostname only, never the port; read from the environment per request, never cached. The gate is registered
  by the **same applier as the CSP** (`applySecurityMiddleware`, host gate first), so no app built here can carry one without the other, and it is global rather
  than scoped to the agents POSTs because the read routes are exposed to the same page. The origin guard is deliberately unchanged — it inherits the allowlist
  transitively. Why: [invariants.md](docs/subsystems/invariants.md#every-route-is-gated-by-a-host-allowlist)
- **Settings is two pages, the page is the scope, and the rail is the only thing that switches them.** `settingsScope` (`client/src/lib/settings.ts`) is
  `local | shared`: Local is this browser's `localStorage`, Shared is what the API reads off the host. No card mixes the two, and there is no in-page switch at
  any width — the same rule Runs' two pages follow. Why:
  [invariants.md](docs/subsystems/invariants.md#settings-is-two-pages-the-page-is-the-scope)
- **`contentWidth` is stamped before first paint, and the CSP hash travels with the script that stamps it.** `data-width` on `<html>`, written twice — by
  `client/index.html`'s inline script and by `useSettings`, whose dependency list must carry it. Editing that script invalidates `THEME_SCRIPT_SHA256`
  (`server/src/security.ts`), and dev has no CSP, so the failure is invisible until the built app is served. Why:
  [invariants.md](docs/subsystems/invariants.md#contentwidth-is-stamped-before-first-paint-and-the-csp-hash-travels-with-it)
- **The served build carries a CSP (`server/src/security.ts`); dev does not.** `script-src` pins the pre-paint theme script's sha256 — edit that script and
  `test/csp.test.ts` goes red until `THEME_SCRIPT_SHA256` follows.
- **Container mounts land on host paths, read-only**, because the registry stores absolute host paths.
- **pnpm only**, pinned by `packageManager`, enforced via corepack in the image.
- **`pnpm test` is the union of BOTH runners** — `scripts/test-all.mjs` runs `test:jest` and then `test:skills`, always both, and exits `1` if either failed. Do
  not "simplify" `test` back to bare jest: jest's `testMatch` can never reach `skills/*/tools/*.test.mjs`, the whole of this repo's single-writer tooling. Why:
  [invariants.md](docs/subsystems/invariants.md#pnpm-test-is-the-union-of-both-runners)
- **`allowBuilds` in `pnpm-workspace.yaml` lists `esbuild`**; a skipped build surfaces as Vite failing to start.
- **Editing `vite.config.ts` needs `docker compose restart client`.**
- **Backlog items move `open/` → `done/`; `out-of-scope/` is flat.**
- **Dispatch derives the action; it never accepts one.** `deriveAction` (`shared/agent.ts`) is the single implementation for the board's label and the server's
  validation; dispatch re-scans the file and 409s on disagreement. The prompt is the only client field taken outright; the controller rebuilds the body field by
  field and checks `action` with `isAgentAction`. `AgentAction` has three members and ONE check runs ahead of all of them: `capture` is derived for an
  out-of-scope item by SECTION, before the `status !== 'open'` check. **Nothing here asks what an item's `source` is** — re-adding that would hide the control
  for every tracker item again. Why: [invariants.md](docs/subsystems/invariants.md#dispatch-derives-the-action-it-never-accepts-one)
- **`isItemId` accepts three shapes, and `#` is the one metacharacter among them.** `[a-z]+-\d+` (a files id), `#\d+` and the URN `gh:<owner>/<repo>#\d+` —
  still no whitespace, no newline, no quote, no `;`, no `$`. `#` is safe because nothing this predicate guards reaches a shell, and the ONE composition that
  concatenates caller text — the orchestrate prompt — never carries a `#` because `resolveTrackerIds` normalises every accepted id to bare digits first
  (task-47). That normalisation is the more fragile of the two guarantees it replaced, so anything weakening it is the thing to re-check first. Why:
  [invariants.md](docs/subsystems/invariants.md#isitemid-accepts-three-shapes)
- **The orchestrate spawn prompt is composed server-side.** `ORCHESTRATE_PROMPT` (`agents.service.ts`) is the literal `/backlog-orchestrate`; the request body
  has no `prompt` field. What a caller can influence is enumerated by the composition in `orchestrate()` and nowhere else, in this order: `ids` first (which
  must stay first, because bare tokens parse as ids), then the compile-time literals ` --merge-mode branch` and ` --question-mode decide`, then ` --base <ref>`.
  **They are not all the same kind of safe**: the two mode flags append compile-time literals, while `base` is the one member whose caller text is appended
  verbatim and is therefore *proved* (`resolveBase`) rather than clamped. Why:
  [invariants.md](docs/subsystems/invariants.md#the-orchestrate-spawn-prompt-is-composed-server-side)
- **The browser never talks to the dashboard.** Every call goes board → this API → dashboard; `BM_AGENTS_URL` is env-only; `BM_AGENTS` defaults to off — and
  compose passes that one through as `${BM_AGENTS:-off}`, never as a literal (bug-25). `BM_AGENTS_URL` beside it is stack topology, not a policy default, so
  compose overrides it under a **second key** (`BM_AGENTS_DOCKER_URL`) and never interpolates `BM_AGENTS_URL` itself. Do not collapse the two names back into
  one. Why: [invariants.md](docs/subsystems/invariants.md#the-browser-never-talks-to-the-dashboard)
- **A project the dashboard cannot see cannot be dispatched to.** Never derive a `dirName` from a path to route around this. The `dispatchGate` membership check
  is a raw string compare, deliberately not realpath. Why:
  [invariants.md](docs/subsystems/invariants.md#a-project-the-dashboard-cannot-see-cannot-be-dispatched-to)
- **An environment-level block hides the dispatch control; the per-item ones disable it.** With `BM_AGENTS` off the board shows no dispatch buttons — do not
  "improve" that into disabled buttons. Three per-item blocks keep their button, read by `DispatchButton` in this order: `dispatchGate`, `progressBlock`
  (ANY `started:` stamp, fresh or stale), `runClaimBlock`. Exactly one lets the click through: the visibility block re-asks the status through `useReverify`;
  the other two keep swallowing it. Why:
  [invariants.md](docs/subsystems/invariants.md#environment-level-blocks-hide-the-dispatch-control-per-item-ones-disable-it)
- **One run per project, checked twice.** `orchestrate.mjs init` refuses outright on any `status: "running"` run file, fresh or stale (exit `4`; recover via
  `--resume`/`--abort`, never overwrite). `POST /api/agents/orchestrate` re-checks before it spawns: a _fresh_ run file or a `starting` entry, both 409 with
  `RUN_IN_PROGRESS_CODE`. Keep no count of its 409 reasons anywhere. Why:
  [invariants.md](docs/subsystems/invariants.md#one-run-per-project-checked-twice)
- **A pause request lives in a server-owned file the tool reads at its two dispatch gates; `paused` is a fifth run status and `unpause` its only exit.**
  `POST /api/agents/pause` — origin-guarded, independent of `BM_AGENTS` — writes under
  `~/.backlog-manager/settings/orchestrator-control/`, the one file travelling server → tool; `run.json` keeps its single writer and effectiveness is derived on
  both sides, never stored. `orchestrate.mjs` refuses `stage <id> preflight`/`dispatched` with exit `6`, only on a transition. Why:
  [invariants.md](docs/subsystems/invariants.md#a-pause-request-is-a-file-the-server-writes-and-the-tool-reads)
- **A stop is the control file's SECOND `kind`, and nothing resumes a stopped run** (bug-39). `PauseRequest.kind` is `'pause' | 'stop'`, **absent means
  `'pause'`**, one control fact per project stays one file, and the two predicates are DISJOINT on both sides. `POST /api/agents/stop` is `pause`'s sibling —
  guarded, `cancel === true` only, `running` fresh **or stale** — and then attempts ONE `--abort` spawn: recording the fact and ending the run are two outcomes
  and only the first is guaranteed, so a gate refusal is a 200 carrying `abortRefused`, never an error. `stopRequested` rides the runs payload beside
  `pauseRequested` and is deliberately NOT a third input to `watchdogStoodDown`. In the tool: `stage` refuses EVERY transition with exit `10`, `watch` kills the
  child **by the pid it was given**, `takeOverRun` gains a REQUIRED third `force` parameter, and `resolveItemPid` reads `<dir>/logs/<id>.pid` before
  `RunQueueItem.pid` (bug-43). No sixth `RunStatus`, no `--force` flag, no server-side kill. Why:
  [invariants.md](docs/subsystems/invariants.md#a-stop-is-the-control-files-second-kind-and-nothing-resumes-a-stopped-run)
- **A resume is serialized at three layers, and only the third one can refuse a resume this app never asked for** (bug-19): the board's Resume control has a
  synchronous in-flight guard; `AgentsService.resume()` takes `WatchdogEntry.resumeSpawnAt` synchronously before its next `await` and refuses with an
  **uncoded** 409; and `orchestrate.mjs` records a driver lease (identity `CLAUDE_CODE_SESSION_ID`, refusal exit `7`) which `abort` and `unpause` TAKE rather
  than check — that is the rule, not an exception. Why:
  [invariants.md](docs/subsystems/invariants.md#a-resume-is-serialized-at-three-layers)
- **The sweeper's prune keeps `paused` runs, because an entry is no longer only its bookkeeping.** `resumeSpawnAt` lives for `RUN_STALE_MS`, not "while the
  sweeper is interested"; the keep set is built in `sweep()`, not decided inside `prune()`. Why:
  [invariants.md](docs/subsystems/invariants.md#a-resume-is-serialized-at-three-layers)
- **The watchdog spawns; it never writes the run file.** `runs()` stays the one reader and `WatchdogService` only ever calls `AgentsService.resume()`; attempts,
  phase and the event log live in `WatchdogStateService`, in memory, lost on restart on purpose. `settings/watchdog.json` is the server's one write, its own
  single writer. Why: [invariants.md](docs/subsystems/invariants.md#the-watchdog-spawns-it-never-writes-the-run-file)
- **A crashed run renders as crashed, never as nothing.** The Board counts it in `RunChip`'s own line (`1 run · crashed ›`) and says nothing the payload does
  not carry. The Runs page reads the same payload (bug-29): `MergedRun.live` is the data authority, `MergedRun.isLive` the presentation gate, and both status
  badges read `crashed` through `runStatusChip` (`lib/run-stage.ts`), never from `authority`. A crashed run is a **Live sheet row** and never a History one —
  `splitLive` decides on `running`/`paused` presence, freshness deliberately excluded — and its three readings travel in one element. `crashed` is **not** a
  sixth `RunStatus`. Why: [invariants.md](docs/subsystems/invariants.md#a-crashed-run-renders-as-crashed-never-as-nothing)
- **The watchdog is armed only while some `run.json` says `running`.** No standing interval — a `setTimeout` chain that disarms the tick it finds none. It arms
  on the board's own runs reads, a boot-time scan, a successful `orchestrate`/`resume` spawn (wired in `AgentsController`, never `AgentsService`) and every
  `POST /api/agents/watchdog/config` save. A run started by typing the trigger with the board never opened is never watched. Why:
  [invariants.md](docs/subsystems/invariants.md#armed-idle-off)
- **`useOrchestratorRuns` polls while any run is `running`, fresh or not** — and, since task-48, while any REMOTE run is `running`, which is the only way this
  machine sees another's progress. Why:
  [invariants.md](docs/subsystems/invariants.md#a-crashed-run-renders-as-crashed-never-as-nothing)
- **Any spawn attempt starts the grace clock; only a success counts against the cap.** `exhausted` is decided before grace. A board resume is a spawn attempt
  too (`WatchdogService.noteBoardResume`, called from the controller BEFORE `arm()`): grace yes, cap no. Why:
  [invariants.md](docs/subsystems/invariants.md#grace-any-attempt-starts-the-clock-only-a-success-counts)
- **The board offers a hand resume exactly when the watchdog will not spawn one — absent a stop request, which suppresses both sides — and that is one
  function, not two agreeing expressions.** `watchdogStoodDown` (`shared/agent.ts`) is read by `watchdog.service.ts`'s `visit()` and by `RunControls`, the ONE
  component for both surfaces that offer the click, so `WatchdogMonitor` must never call the predicate itself; `test/watchdog-coupling.test.tsx`'s reader list
  is an exact set for that reason. Its inputs `spawningEnabled()` and `watchdogExhausted` (DERIVED, never stored) are single implementations too. Why:
  [invariants.md](docs/subsystems/invariants.md#the-resume-coupling-the-board-offers-a-hand-resume-exactly-when-the-sweeper-will-not)
- **Every agents POST is guarded by content-type and origin** (`server/src/agents/origin.guard.ts`) — the one place loopback is NOT the access control.
  `test/agents-origin-guard.test.ts`'s route list is where the guarded set lives, never a count in prose. Absent `Origin` stays allowed; the guard compares host
  and port, not scheme. Why: [invariants.md](docs/subsystems/invariants.md#every-agents-post-is-guarded-by-content-type-and-origin)
- **The launch sheet's model/effort pickers seed from Settings, never the last launch** (`dispatchDefaultModel` / `dispatchDefaultEffort` in
  `client/src/lib/settings.ts`, clamped against `MODELS`/`EFFORTS`). Permission mode has no stored default — it comes from `plan.defaultMode`, clamped to the
  host ceiling. Why: [invariants.md](docs/subsystems/invariants.md#launch-sheet-modeleffort-pickers-seed-from-settings-never-the-last-launch)
- **`linkBase` becomes an href**, so `clampSettings` routes it through `clampOrigin` — URL-parsed, `http(s)` only. The one settings key a hand-edited
  localStorage value could turn into script execution.
- **"Queue wait is not work."** `itemDurationMs` (`client/src/lib/run-time.ts`) is the one implementation of "how long did this item take"; machine time
  (`runStageTotals`) excludes `pending` too, and `MACHINE_STAGES` is the closed list of what counts. Why:
  [invariants.md](docs/subsystems/invariants.md#queue-wait-is-not-work)
- **A session's cost is recorded per transcript, and a transcript's identity is its file name, not its session id** (task-27).
  `orchestrate.mjs usage <id> --jsonl <file>` is the one writer of `RunQueueItem.usage`: one entry per transcript, never one summed figure; identity is `kind` +
  `loop`, both from the file name, never `sessionId`. Absence is a value: no result event writes no entry, a renamed numeric field reads `null` never `0`, and
  `usage` stays optional so an older run renders nothing rather than `$0.00`. Why:
  [invariants.md](docs/subsystems/invariants.md#a-sessions-cost-is-recorded-per-transcript-and-a-transcripts-identity-is-its-file-name)
- **Every `.claude/rules/` file carries `paths:` and is a pointer, never a second copy of the reasoning.** A rule with no `paths:` loads at `session_start` in
  every session — a context-floor increase on all of them, which is the one failure mode the mechanism can introduce; a rule that restated a rule would be a
  third statement of it, free to drift from both CLAUDE.md and the rationale. Measured, not assumed (Claude Code 2.1.268): a glob fires for a headless
  `claude -p`, inside a linked worktree, and for a custom subagent's read; it does NOT fire for `Write`, `Grep`/`Glob`, or a source read through
  `codegraph_explore`. Pinned by `test/claude-rules.test.ts`, which passes vacuously on an empty directory. Why:
  [invariants.md](docs/subsystems/invariants.md#path-scoped-clauderules-reach-a-headless-run-in-a-linked-worktree-task-35)

## Conventions

- Comments explain _why_, at length, and the existing density is deliberate — match it rather than stripping it.
- **A suite that hands an app to supertest listens once, on `127.0.0.1`, via `listenLoopback` (`test/helpers/app.ts`)** — never on the wildcard, never per
  request. supertest dials `http://127.0.0.1:<port>` unconditionally while a bare `listen(0)` binds `::`, so any process holding that port on `127.0.0.1`
  answers instead: ~1 request in 1,500 on a loaded machine, which is one false red per `pnpm test` and so a merge-gate defect (bug-33). Not `jest.retryTimes`.
  `watchdog-sweep.test.ts` is the one exception — `createApp({ listen: true })`, opt-in, because its other cases install fake timers first. Pinned by a source
  guard in `test/supertest-bind.test.ts`: behaviour cannot catch a suite that forgets, since forgetting is green 1,499 runs in 1,500. Why:
  [invariants.md](docs/subsystems/invariants.md#a-supertest-suite-listens-once-on-127001-through-listenloopback)
- **A jsdom suite's fixture dates are relative to the clock the assertion runs under** — `daysAgoDate`/`daysAgoStamp` (`test/helpers/dates.ts`), read at call
  time so a faked clock is honoured, never an absolute literal. `created` is compared against the REAL clock by `leavesBoard` → `isStale` → `lastTouched`, so a
  literal is not a constant but an expiry date: the card renders for `staleDays` and then stops, red on a tree nobody touched (bug-44, three cases, two suites,
  every orchestrator run parked at `verify`). `test/fixture-clock.test.ts` is the source guard — every `test/*.test.tsx`, the four keys `created`, `updated`,
  `lastCommit`, `started`, a closed allowlist whose every entry carries its reason — and it reads source because behaviour cannot: a fresh literal is green for
  thirty days. `.ts` suites are out of scope (they pass `now` explicitly), and a literal behind a NAME passes the guard, which `board.test.tsx`'s `CREATED` uses
  deliberately and says so. Why:
  [invariants.md](docs/subsystems/invariants.md#a-fixture-date-is-relative-to-the-clock-the-assertion-runs-under)
- Tests are flat in `test/`, `*.test.ts` / `*.test.tsx`; component suites opt into jsdom with a `@jest-environment jsdom` docblock. Skill tests live next to the
  tool they cover (`skills/*/tools/*.test.mjs`) and run under node's own test runner, not jest — but `pnpm test` runs both runners, via `scripts/test-all.mjs`.
  The split is which runner executes a file, not which ones one word covers; see the Invariants entry. Cases that pin a **skill's prose** rather than a tool
  live in `skills/backlog/tools/backlog.test.mjs` too (`backlog-groom`'s stamp order and its closing `Groomed on disk only` line, `backlog-execute`'s pre-review
  checks and the `agents/backlog-reviewer.md` half that reads them): that glob is the node runner's only reach into `skills/` — the other half of the pair,
  `scripts/*.test.mjs`, covers `scripts/` and nothing else — and none of those files sits beside a `tools/` directory. The one exception is deliberate — the
  `Groomed on disk only` cases assert `skills/backlog-orchestrate/SKILL.md`'s half of that seam too, in this suite rather than in `orchestrate.test.mjs`,
  because the rule is two skills agreeing on one sentence and a suite that reads only one half cannot catch them drifting apart; the reviewer/execute pair is
  the same shape. They read the other file, never import it — the "one skill's `tools/` may never import another's" rule is untouched. `backlog-retro` splits
  its suite in two — `retro.test.mjs` (the CLI, spawned as a child process) and `retro-lib.test.mjs` (the modules under `tools/lib/`) — and BOTH sit at the
  `tools/` level on purpose: `test:skills`'s globs are `skills/*/tools/*.test.mjs` and `scripts/*.test.mjs`, so a file under `tools/lib/` matches neither and
  would never be run, which is the same as not existing.

<!-- docs-sync:
  sources:
    - server/src
    - client/src
    - shared
    - skills
    - agents
    - scripts
    - test
    - package.json
    - docker-compose.yml
    - vite.config.ts
    - pnpm-workspace.yaml
  kind: index
  verified: d3dbf8855e78b4ae70c792eeb7696167a44ce8a4
-->
