---
paths: ["server/src/items/**"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **The seven `/api/items/*` write routes are guarded like the agents POSTs, refused for a `files` project, and serialised per item.** Every one of them is
  `@UseGuards(SameOriginPostGuard)` (`items-write.controller.ts`, one decorator on the class) and each is a thin pass-through to an `ItemWriter` method:
  `ItemsService.writerFor` gates the `project` against the registry by a RAW string compare, resolves the marker per request, and answers `unregistered` (404)
  / `files` (400, `this project's items are files — the skills write them directly`) / `unsupported` (400, carrying `resolveSource`'s own reason) / the call.
  None of those four makes a network request. `FilesSource` has no `writer` at all, and that absence IS the rule. The adapter answers a VALUE for every
  failure (`WriteRefusal`), and the controller is the only layer mapping one to a status: `no-token` 503 · `not-found` 404 · `conflict` 409 · `rate-limited`
  429 · anything else 502. `heartbeat` also takes `finished: { at, status }` (task-48), validated field by field and accepted on a RELEASED claim, where it
  sets `finished` and nothing else — `finish` stamps a claim its terminal stage already released. `claim` takes an optional `host` (bug-46), validated by
  `optional()` as a non-empty string or a 400 naming the field: absent is a value (a caller that sends none writes no `host` key at all), but a blank or a
  non-string is a mistake worth hearing about. It is never derived here — a hostname read in the compose stack is a container id. `GithubSource` keeps a `Map<urn, Promise>` so two local sessions never race on one item, and every response is absorbed into the
  poller's cache — but a write never moves `polledAt`, because nothing was polled. The token stays in the process; no response carries it. An eighth route,
  `GET /api/items/claim`, is a READ (unguarded like every other GET) and exists because `start` and `stop` are two processes. Why:
  [invariants.md](docs/subsystems/invariants.md#the-seven-item-write-routes-are-guarded-refused-for-files-and-serialised-per-item)
- **A project's source is a committed marker, resolved per request, and an `unsupported` one never falls back to `files`.** `resolveSource`
  (`server/src/items/sources/resolve.util.ts`) reads `backlog/source.json` per request, caches nothing, and answers `missing` / `files` / `tracker` /
  `unsupported`; `ItemsService` dispatches over the adapters registered under `ITEM_SOURCES` and **throws at boot** if two claim one kind. Absent means `files`;
  an explicit `{"kind":"files"}` is honoured, and `files` never has to be registered. An unsupported marker contributes **no items** and one
  `ItemsIndex.errors` entry (prefixed with the marker's path), with `source: 'unsupported'`, zero counts and `missing: false` — `missing` still means no
  `backlog/` at all, whose `source` is `null`. `SourceKind` is the closed list of adapters this build ships (`'files' | 'github'` since task-45) and widens only with the adapter;
  `BacklogItem.source` is required so the compiler is the fixture checklist. Why:
  [invariants.md](docs/subsystems/invariants.md#a-projects-source-is-a-committed-marker-resolved-per-request-and-an-unsupported-one-never-falls-back-to-files)
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
- **The middle rung of "last touched" comes from git, not the item file.** `lastCommit` (`server/src/items/git-dates.util.ts`) is the committer date of the last
  commit touching the file, keyed relative to the project path; every failure degrades to `created`, never throws. The container needs `git` installed and
  `safe.directory` in system config (Dockerfile). Memoised per project against the mtimes of `index` and `logs/HEAD` — the one cache in `items/`. Why:
  [invariants.md](docs/subsystems/invariants.md#the-middle-rung-comes-from-git-not-the-item-file)
- **The Orchestrate sheet's `uncommitted` flag is read from git per request, memoised nowhere, and must never join the memo one file over.**
  `uncommittedItemPaths` (`server/src/items/uncommitted.util.ts`), behind `GET /api/items/uncommitted`, is the one implementation. The question is "differs from
  `main`", never "differs from `HEAD`"; two git reads (`diff` plus `ls-files --others`), never one; a sibling endpoint, never a `BacklogItem` field; `known`
  gates the render; nothing derived reads it; it changes no default selection. Any surface stating a consequence must split it: absent from `main` is skipped,
  present-but-edited is executed on `main`'s bytes. Why:
  [invariants.md](docs/subsystems/invariants.md#the-orchestrate-sheets-uncommitted-flag-is-read-from-git-per-request-and-memoised-nowhere)
