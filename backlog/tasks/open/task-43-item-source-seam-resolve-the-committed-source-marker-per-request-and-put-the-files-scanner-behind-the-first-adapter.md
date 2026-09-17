---
id: task-43
title: Item-source seam: resolve the committed source marker per request and put the files scanner behind the first adapter
created: 2026-09-17
from: idea-12
---

## Goal

Phase 1 of `docs/superpowers/specs/2026-09-17-tracker-backed-backlog-design.md` (§3–§4, §12.1): the server stops assuming every registered project's items are
files. A project's source is read off a committed marker, `backlog/source.json`, per request; today's scanner becomes the `files` adapter behind an `ItemSource`
interface; `ItemsService` dispatches over the registered adapters; and both shared payload shapes say which source each row came from. **Nothing visible
changes on the board** — `/api/items` and `/api/projects` return what they return today plus one `source` field each — and that is the acceptance test: a seam,
proven by the payload diff being exactly those fields, so phase 2 can add a GitHub adapter without touching the service's control flow again.

## Plan

This plan states behaviour and exact test cases, never literal code: signatures, names, expected values and edge cases are given, and the implementer writes
the code. The spec is the argument; this plan is the map of it. Line numbers are as of 2026-09-17 and are hints only — anchor edits on the quoted text.

### Step 0 — read §3–§4 of the spec, then re-verify the premise

Read the spec's §3 (the marker and its resolution table) and §4 (the seam) before touching anything. Then confirm the three facts this plan stands on, and stop
to say so in `## Outcome` if any has moved:

- `server/src/items/items.service.ts` is the only place `scanProject` is called on behalf of the read routes; `server/src/agents/agents.service.ts` calls
  `scanProject`, `buildAllowlist` and `resolveAllowed` for its own dispatch re-scan (lines ~1186 and ~1354–1359) and **this task leaves those calls alone**
  (see "What this task deliberately does not touch").
- `tsconfig.json` includes `test/**/*`, so `pnpm run typecheck` sees every fixture literal in `test/` — Step 5 relies on the compiler as its checklist.
- No `backlog/source.json` exists in any registered project yet (`ls */backlog/source.json` under `~/Documents/custom-projects` is empty), so the only
  resolution any real project takes in this phase is `files`.

### Step 1 — the shared shapes

In `shared/types.ts`:

- Add `SourceKind`, a string union of the adapters this build ships. **In this task it is the single member `'files'`.** Its doc comment says why it is closed
  and narrow: a kind named here without an adapter behind it would be a lie the resolver could not keep, so phase 2 widens it to `'files' | 'github'` in the
  same commit that registers the GitHub adapter.
- `BacklogItem` gains `source: SourceKind`, **required**, placed beside `path` (both are "where this row came from"). Doc: which adapter produced the row; the
  client ignores it until a second kind exists; required so the shape stays total and every fixture names its source.
- `ProjectSummary` gains `source: SourceKind | 'unsupported' | null`, **required**. Doc: `null` exactly when `missing` is `true` (no store, no source);
  `'unsupported'` when `backlog/source.json` is present but cannot be honoured — malformed, no string `kind`, or a kind with no adapter in this build — with the
  reason travelling in `ItemsIndex.errors`, never in this summary; otherwise the adapter's kind. State in the doc that `unsupported` **never** reads as `files`,
  and point at the spec's §3.2 for why (a tracker project whose marker cannot be read would otherwise render stale clone files as ghosts).

Run `pnpm run typecheck`; expect it to fail on every `BacklogItem` and `ProjectSummary` literal that lacks `source` — the scanner's, the service's and the
fixtures'. That red list is the input to Steps 4 and 5.

### Step 2 — `resolveSource`

Create `server/src/items/sources/resolve.util.ts`, a pure function over the filesystem with no Nest dependency:

- `SOURCE_MARKER = 'source.json'`, exported, the one spelling of the file name.
- `SourceMarker` — an object with a string `kind` and any other keys (`repo` for GitHub later); the resolver does not validate the other keys, the adapter does.
- `ResolvedSource`, a discriminated union of four: `{ kind: 'missing' }`, `{ kind: 'files' }`, `{ kind: 'tracker'; marker: SourceMarker }`,
  `{ kind: 'unsupported'; reason: string }`.
- `resolveSource(projectPath: string, known: ReadonlySet<string>): ResolvedSource`, where `known` is the set of adapter kinds the caller has registered. Rules,
  in order, matching the spec's §3.2 table:
  1. No `backlog/` directory → `missing`.
  2. No `backlog/source.json` → `files`.
  3. The file cannot be read (it is a directory, permissions) → `unsupported`, reason names the marker's absolute path and says it cannot be read.
  4. The text is not valid JSON → `unsupported`, reason names the path and the word `JSON`.
  5. The value is not an object with a string `kind` (an array, `{}`, `{ "kind": 3 }`) → `unsupported`, reason names the path and the word `kind`.
  6. `kind` is `'files'` → `files` — an explicit marker for the implicit source is honoured, not refused; `files` never has to be in `known`.
  7. `kind` is in `known` → `tracker` with the parsed marker.
  8. Otherwise → `unsupported`, reason names the path and quotes the kind (`unsupported source kind "github"`).

Every `reason` begins with the marker's absolute path, the way scan errors begin with the item file's path, so `ItemsIndex.errors` stays one shape. The
function never throws and never caches: one `existsSync`, one `readFileSync`, one `JSON.parse`, per call — the same cost class as re-reading the registry, and
the header comment says so, citing the registry's own rule as the precedent.

Write `test/source-resolve.test.ts` first (cases in `## Test cases`, group A), run it red, then implement.

### Step 3 — the `ItemSource` interface and the `files` adapter

Create `server/src/items/sources/source.ts`:

- `ItemSource` with three members: `readonly kind: SourceKind`; `list(project: RegistryProject, marker: SourceMarker | null): Promise<{ items: BacklogItem[];
  errors: string[] }>`; `body(ref: string, registry: Registry): Promise<string | null>`. Asynchronous throughout because a tracker adapter reads a cache a
  poller fills; the files adapter simply resolves. `marker` is `null` for `files` and carried now so phase 2 does not change the signature. No `summary` yet —
  the spec's §4.1 defers it to phase 2, the first phase with a value for it.
- `ITEM_SOURCES`, an injection token (a `Symbol` or string constant) under which the module provides `ItemSource[]`.

Create `server/src/items/sources/files.source.ts`, an `@Injectable()` `FilesSource`:

- `kind` is `'files'`.
- `list` returns `scanProject(project)`; the marker is ignored.
- `body` is today's `ItemsService.body` moved here verbatim in behaviour: resolve through `buildAllowlist(registry)` and `resolveAllowed`, refuse anything not
  ending in `.md`, read, strip frontmatter, fall back to the raw text when the frontmatter does not parse, `null` on every failure.

In `server/src/items/scan.util.ts`, the item literal gains `source: 'files'`. That is the only edit to the scanner.

In `server/src/items/items.module.ts`, provide `FilesSource` and `ITEM_SOURCES` (a factory over `FilesSource` returning the one-element array). Phase 2 appends
its adapter to the same factory; nothing else in the module changes then.

### Step 4 — `ItemsService` dispatches; the controller awaits

`ItemsService` takes `ITEM_SOURCES` beside the registry and builds a `ReadonlyMap<SourceKind, ItemSource>` in its constructor, **throwing** if two adapters share
a kind — a boot-time failure with the duplicated kind in the message, never a silent last-wins. `known` for the resolver is that map's key set.

- `index()` becomes `async`. Per registered project it calls `resolveSource(project.path, known)`: `missing` → skipped, as today; `files` → the files adapter's
  `list(project, null)`; `tracker` → the adapter for `marker.kind` with the marker; `unsupported` → the reason pushed onto `errors`, no items. The existing
  comment about a missing store being `/api/projects`' news stays.
- `projects()` becomes `async`. Per project: `source` is `null` for `missing`, `'files'` for `files`, `marker.kind` for `tracker`, `'unsupported'` for
  `unsupported`; counts are derived from the adapter's `list` for the first two live cases and are the all-zero `SectionCounts` for `missing` and
  `unsupported`; `missing` keeps its meaning — no `backlog/` at all — so an unsupported project is `missing: false`.
- `body(ref)` becomes `async` and delegates to the files adapter's `body(ref, registry)`. Leave a two-line comment that phase 2 dispatches on the ref's shape
  here (a URN goes to the tracker adapter, a path to files) and that this is the seam's one place for that decision.
- `uncommitted()` is untouched, synchronous, files-only by nature.

`ItemsController`: `projects`, `index` and `body` become `async` and await the service. Paths, status codes and content types are unchanged.

Write the service's duplicate-kind case (group B) red before the constructor change; the rest of the service is pinned by group C through supertest.

### Step 5 — fixtures follow the compiler

Run `pnpm run typecheck` and add `source: 'files'` to every `BacklogItem` and `ProjectSummary` literal it names, until it is green. As of today that is the
ten `fakeItem` helpers (`test/agents-shared.test.ts`, `board.test.tsx`, `board-column.test.tsx`, `board-live-cards.test.tsx`, `dialog-escape.test.tsx`,
`dispatch-button.test.tsx`, `item-progress.test.ts`, `item-stale.test.ts`, `item-touched.test.ts`, `orchestrator-start-ui.test.tsx`), the standalone item
literals in `agents-prompt.test.ts`, `archive.test.tsx`, `board-run-chip.test.tsx`, `item-modal.test.tsx`, `item-month.test.ts`, `launch-sheet.test.tsx`,
`nav.test.tsx` and `orchestrate-uncommitted.test.tsx`, and the `ProjectSummary` literals in nine of those files. **Do not hunt by grep; the compiler's list is
the checklist**, and if it names a file not listed here, that file is in scope too. No test's assertions change in this step — only literals gain a field.

### Step 6 — the e2e suite grows two projects

In `test/helpers/store.ts`, `makeProject` gains an optional third parameter, `marker?: string`, written **verbatim** to `backlog/source.json` when given — a
string rather than an object so a malformed marker can be produced.

In `test/items.test.ts`, register two more projects beside `alpha`, `beta` and `ghost`:

- `gamma`, no items, marker `{"kind":"nope"}` — a kind this build has no adapter for.
- `epsilon`, one open idea, marker `{"kind":"files"}` — the explicit spelling of the implicit source.

Then the cases in `## Test cases`, group C. Existing count assertions in the suite grow by exactly what these two fixtures add (`byName.size` becomes 5; the
errors array gains one entry); assert the new error by its prefix, never by index.

### Step 7 — docs

Four edits, each in the file that is the fact's one home:

- `docs/subsystems/api.md`, the `items/` paragraph: `/api/projects` gains `source`; every `/api/items` row carries `source`; a project's source is resolved per
  request from `backlog/source.json` (absent means `files`); an `unsupported` marker contributes no items and one error, and never reads as `files`. The
  Interfaces bullet "Each project's store — read-only, always" gains one clause: its `backlog/source.json`, when present, names the tracker that owns its
  items (link the spec). Leave the `docs-sync` provenance comment at the foot of the file exactly as it is — `/docs-sync` re-baselines it, not this task.
- `docs/subsystems/invariants.md`: a new `##` section titled exactly
  `A project's source is a committed marker, resolved per request, and an unsupported one never falls back to files`, placed immediately before
  `## The Orchestrate sheet's uncommitted flag is read from git per request and memoised nowhere`. Content, in this file's voice: the marker is per project
  and committed because source is a property of the project, not the machine (spec §2.3); it is read per request like the registry; `unsupported` never falls
  back because a tracker project whose marker cannot be read would render a stale clone's files as ghosts beside the real items on another machine's board;
  `ItemsService` refuses two adapters of one kind at boot. Cite the spec and this task.
- `CLAUDE.md`, Invariants list, directly after the `Item bodies are served through a registry-built allowlist` entry: one entry stating the rule in the list's
  bold-rule-then-detail shape, ending with `Why:` linking the new anchor
  (`docs/subsystems/invariants.md#a-projects-source-is-a-committed-marker-resolved-per-request-and-an-unsupported-one-never-falls-back-to-files`).
- `.claude/rules/items.md`, new, `paths: ["server/src/items/**"]`, the same three-line pointer shape as the four existing rules files, pointing at the new anchor,
  at `#the-middle-rung-comes-from-git-not-the-item-file` and at `#the-orchestrate-sheets-uncommitted-flag-is-read-from-git-per-request-and-memoised-nowhere`.
  `test/claude-rules.test.ts` picks it up unchanged.

### What this task deliberately does not touch

- **`server/src/agents/agents.service.ts`.** Its dispatch re-scan calls `scanProject` and the allowlist directly and keeps doing so: dispatch stays files-only
  until phase 3 lifts it for tracker items, and routing it through the seam now would be a change with no test to prove it.
- **The client.** No component reads `source` yet; the FE work is phase 2's.
- **`backlog.mjs`.** `connect`, the marker's writer, is phase 2 (spec §5.7). This task creates no marker anywhere but under `test/`.
- **`uncommitted.util.ts`, `git-dates.util.ts`, `allow.util.ts`.** Unchanged; the files adapter calls them where the service did.

### Not a runner fix

Nothing here changes `backlog-orchestrate`'s SKILL.md, `orchestrate.mjs`, `agents/backlog-reviewer.md` or `server/src/agents/`, so the frontmatter carries no
`runner-fix:` key.

### Assumptions this plan made without asking

- `SourceKind` is `'files'` alone in this task; the spec's §4.2 was amended the same day to say the union grows with each adapter.
- `ProjectSummary.source` is `null` for a missing project rather than a fifth string; the spec's §4.2 was amended to match.
- Adapters reach the service through a Nest injection token rather than a constructor-built list, so phase 2 registers its adapter in the module and edits
  nothing in the service.
- `body` stays a single files-only delegation in this task; the URN-versus-path dispatch is written when a URN exists to dispatch on.

## Test cases

Every case runs under `pnpm run test:jest`; nothing here needs a browser.

**A. `test/source-resolve.test.ts` — `resolveSource`**, one temp directory per case, `known` = `new Set(['files'])` unless stated:

1. A project path with no `backlog/` → `{ kind: 'missing' }`.
2. `backlog/` present, no `source.json` → `{ kind: 'files' }`.
3. Marker `{"kind":"files"}` → `{ kind: 'files' }`; also with `known` = `new Set()` — `files` never needs registering.
4. Marker `{"kind":"github","repo":"futin/x"}` with `known` = `new Set(['files', 'github'])` → `{ kind: 'tracker', marker: { kind: 'github', repo: 'futin/x' } }`.
5. The same marker with `known` = `new Set(['files'])` → `kind: 'unsupported'`, `reason` starts with the marker's absolute path and contains `github`.
6. Marker text `{nope` → `unsupported`, `reason` starts with the path and contains `JSON`.
7. Marker `[]`, marker `{}` and marker `{"kind":3}` → each `unsupported`, `reason` starts with the path and contains `kind`.
8. `backlog/source.json` is a directory → `unsupported`, `reason` starts with the path.
9. Calling the function twice on case 4's directory after rewriting the marker to `{"kind":"files"}` between the calls returns `tracker` then `files` — nothing
   is cached.

**B. `ItemsService` construction** (a unit case, no HTTP): constructing the service with two adapters whose `kind` is `'files'` throws, and the message contains
`files`; constructing it with one succeeds.

**C. `test/items.test.ts` through supertest**, with `gamma` and `epsilon` registered as Step 6 describes:

1. Every element of `/api/items`' `items` has `source: 'files'`.
2. No item has `projectPath` equal to `gamma`'s path; `epsilon`'s idea is present with `section: 'ideas'`, `status: 'open'`, `source: 'files'`.
3. `errors` contains exactly one entry that starts with `<gamma>/backlog/source.json` and contains `nope`; the pre-existing malformed-file error is still present.
4. `/api/projects` has five rows. `alpha`: `source: 'files'`, `missing: false`. `ghost`: `source: null`, `missing: true`, all-zero counts. `gamma`:
   `source: 'unsupported'`, `missing: false`, counts `{ bugs: 0, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 }`. `epsilon`: `source: 'files'`,
   `counts.ideas` is `1`.
5. Every existing case in the suite still passes with its expected values unchanged except the two counts Step 6 names.
6. The suite still listens once through `listenLoopback`; `test/supertest-bind.test.ts` stays green.

**D. Whole-repo gates**: `pnpm run typecheck` green; `pnpm test` green (both runners — the skill suites are untouched and must stay so); `pnpm run build` green;
`test/claude-rules.test.ts` green with the fifth rules file present.

## Done when

- `GET /api/items` and `GET /api/projects` against the registered projects on this machine return today's payloads plus `source: 'files'` on every item and
  `source: 'files'` on every present project, `null` on a missing one — checked by hand against `pnpm run dev` with a `curl` of each route, and the two
  diffs against the pre-change payloads are exactly those fields.
- Groups A–D above pass; `pnpm test`, `pnpm run typecheck` and `pnpm run build` are green.
- `docs/subsystems/api.md`, `docs/subsystems/invariants.md`, `CLAUDE.md` and `.claude/rules/items.md` carry the Step 7 text, and the `docs-sync` stamp in
  `api.md` is untouched.
- `## Outcome` names the count of fixture literals Step 5 touched and quotes the green `pnpm test` summary line.
