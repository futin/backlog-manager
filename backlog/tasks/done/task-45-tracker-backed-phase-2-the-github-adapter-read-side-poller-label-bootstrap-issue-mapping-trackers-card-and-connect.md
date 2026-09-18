---
id: task-45
title: Tracker-backed phase 2: the GitHub adapter read side - poller, label bootstrap, issue mapping, Trackers card and connect
created: 2026-09-18
from: idea-12
tags: architecture, multi-machine, tracker, github, poller, settings
updated: 2026-09-18T09:20:00Z
started: 2026-09-18T08:16:05Z
execute-elapsed: 3835
execute-tokens: 641464
---

## Goal

Phase 2 of the tracker-backed direction ([spec §5](../../../docs/superpowers/specs/2026-09-17-tracker-backed-backlog-design.md)). Phase 1 (task-43) landed the
`ItemSource` seam with exactly one adapter behind it; this phase registers the second one and makes it visible. Its result is the first one a person can see:
**GitHub issues render on the board beside file items, from every machine**, with a poll age stating how old the view is.

Read side only. Nothing in this phase writes an item, claims one, or dispatches against a tracker project — phase 3 does that. The one write to GitHub is the
label bootstrap (§5.2), and it is a bootstrap rather than a lifecycle write: the issue→item mapping cannot work without the label set, and the poller is the
first thing that touches a repo holding a token.

## Plan

**How to read this plan.** It specifies behaviour, signatures and exact expected values — deliberately **not** literal code, including for the tests. This is a
standing override of `writing-plans`' "code blocks required" rule: handed code gets transcribed verbatim, so a defect in the plan becomes a defect in the branch
with nobody positioned to catch it, and test scaffolding is the worst offender because it reads as boilerplate. The **`## Test cases` section is
authoritative** — implement against those expected values and disagree with anything here that contradicts them. Any size figure below is a **soft target**,
never a rule to compress a load-bearing behaviour away.

### Step 1 — widen the shared shapes

`shared/types.ts`:

- `SourceKind` widens from `'files'` to `'files' | 'github'`. This is the change that retires two casts: `ItemsService.adapterFor`'s
  `resolved.marker.kind as SourceKind` and the same cast in `projects()`. Both comments say so outright — delete the casts and the paragraphs explaining them,
  do not leave them standing.
- `BacklogItem` gains three fields, all **required**, same reasoning task-43 used for `source`: the compiler is the checklist for fixture literals.
  - `url: string | null` — the issue's `html_url`; `null` for a files item.
  - `assignee: string | null` — first assignee's login; `null` for a files item and for an unassigned issue.
  - `untyped: boolean` — default `false`; `true` only for a tracker issue carrying no `type:*` label.
- `ProjectSummary` gains four fields present only for tracker projects (§5.4). Decide their absent spelling ONCE and state it in the doc comment: prefer `null`
  over optional, matching how `source: null` was handled, so the shape stays total.
  - `repo: string | null` — `owner/name`.
  - `polledAt: string | null` — ISO, `null` before the first successful sync.
  - `access: 'ok' | 'no-token' | 'forbidden' | 'not-found' | 'rate-limited' | 'error' | null`.
  - `detail: string | null` — the rate-limit reset time, or the error text. Note the asymmetry with `unsupported`, whose reason deliberately lives in
    `ItemsIndex.errors` and NOT on the summary: `detail` is a live connection state that moves every tick, not a per-read parse failure, which is why it may
    sit here without making `errors` a second home for anything.

`untyped` is a **rendered badge and nothing derived reads it** (§5.3): an untyped issue is an idea to every predicate until someone labels it. Do not let it
reach `deriveGroomed`, `isStale`, `lastTouched` or the gate.

### Step 2 — the token and the GitHub client

- `BM_GITHUB_TOKEN`, read from the environment in the server process only. **The token never leaves the server** (§5.6) — no route returns it, the client never
  sees it, and the browser never talks to GitHub. This is the same shape as CLAUDE.md's "The browser never talks to the dashboard"; add the GitHub sibling of
  that invariant rather than assuming the existing sentence covers it.
- `docker-compose.yml` must pass it through the way `BM_AGENTS` is passed (bug-25): **an interpolation with a default, never a literal**. `test/compose-env.test.ts`
  is where that is pinned — extend it for this variable rather than writing a second test file.
- A thin client module over `fetch`, its own file, with no Nest decorators, so it is testable without a module. It records `x-ratelimit-remaining` and
  `x-ratelimit-reset` from **every** response, including `304`s.

### Step 3 — the poller

New service. **It is a second outbound-calling module**, so CLAUDE.md's "`agents/` — the one outbound-calling module" line becomes false the moment this lands.
Update that line in the same commit; do not leave the Layout section asserting something the tree contradicts.

- Shape: a `setTimeout` chain in `agents/watchdog.service.ts`'s shape, NOT a `setInterval`. Read that file's "Why a setTimeout chain rather than setInterval"
  header and follow it, including the guard against a concurrent `arm()` starting a second chain.
- **Armed only while at least one registered project resolves to `github` AND a token is present**; disarmed the tick it finds neither. This mirrors the
  watchdog's "armed / idle / off" invariant — a standing interval against an empty registry is the thing that rule exists to prevent.
- `TRACKER_POLL_MS = 15_000`, one named constant, one home.
- Each tick, two conditional requests per connected repo, both with `If-None-Match`:
  1. issues: `state=all&per_page=100&sort=updated&direction=asc&since=<hwm>`
  2. comments: `issues/comments?per_page=100&sort=updated&direction=asc&since=<hwm>` — **made in this phase, read by nothing until phase 3.** Do not skip it
     because it has no reader yet; the spec makes the call now so phase 3's per-item claim watching is already cheap.
- First sync has no `since` and paginates to the end. `hwm` is the newest `updated_at` seen. `since` is **inclusive**, so re-seeing an issue is an upsert, never
  a duplicate — the cache is keyed by issue number.
- Anything carrying `pull_request` is **dropped**: the issues endpoint returns PRs too.
- **Cache: in memory, per repo, lost on restart, rebuilt by the first sync.** It is the one cache in the server whose age is a rendered value. The registry's
  "re-read per request, never cache" rule is untouched and must stay stated as untouched — this cache exists because the rate limit makes a per-request fetch
  impossible, and `polledAt` being visible on the board is what keeps it honest.
- Rate limit: on `403`/`429` with `retry-after`, or `remaining: 0`, sleep until the reset and set the project's `access` to `rate-limited` with `detail` naming
  the reset time. A secondary-limit response backs off 60s.

### Step 4 — the label bootstrap

Eight labels, created idempotently by the poller the first time a repo syncs successfully and any is missing: `type:bug`, `type:idea`, `type:task`,
`type:refactor`, `kind:chore`, `kind:debt`, `runner-fix`, `in-progress`. One list, one home, shared with `connect`'s issue forms so the two cannot drift.

### Step 5 — the `github` adapter

New adapter implementing `ItemSource` (`server/src/items/sources/`), registered by **appending it to `items.module.ts`'s `ITEM_SOURCES` factory and its
`inject` list**. `items.service.ts`'s control flow must not change — that is the seam's whole claim, and this phase is the test of it.

`list(project, marker)` reads the repo off `marker` and answers from the cache. Mapping per §5.3's table — the exact values are in `## Test cases`. Two rows
deserve naming here because they are the ones easy to get wrong:

- `section` comes from the one `type:*` label. **None → `ideas` with `untyped: true`. Two → the first alphabetically, AND a scan error** in `ItemsIndex.errors`.
- `status`: open → `open`; closed with `state_reason` `completed` **or none** → `done`; closed with any other reason (`not_planned`, `duplicate`) → `terminal`,
  and `section` becomes `out-of-scope`. **The type label stays on the issue** so the original type is recoverable.

`body(ref, registry)` answers the cached body for a URN `gh:<owner>/<repo>#<n>`. `ItemsService.body()` currently delegates unconditionally to the files adapter;
its header already names this phase as the place the **shape test** arrives — a URN to the tracker adapter, a filesystem path to files. That dispatch is the
seam's one home for the decision; do not add a second one in the controller.

`ItemSource` gains `summary(project)` (§5.4 — phase 2 is the first phase with a value for it). `source.ts`'s header says it was deferred to exactly here.
`FilesSource` returns the four fields as `null`.

### Step 6 — the client

- **Cards** (`ItemCard.tsx`): the id string already renders, so `#31` is free. A link-out control when `url` is set; `untyped` draws a badge. `assignee` draws a
  login beside the in-progress bar — but that bar has no claim to stand on until phase 3, so render the login only where it does not imply a claim.
- **The band** (`ui/Band.tsx`, board): per connected project, the poll age (`polled 12 s ago`), replaced by the `access` reason when it is not `ok`. The band
  already holds the run chip, so it is the board's status line. Exact drawing is this task's call under `.claude/DESIGN.md` §8, and the component must cite its
  subsection in a header comment like every other.
- **Item modal** (`ItemModal.tsx`): the cached body by URN, **no per-open fetch**, with the poll age beside it — the body is at most one interval old and the
  age says so.
- **Archive**: closed issues by `closed_at`; `terminal` renders as out-of-scope, as today.
- **Orchestrate sheet**: `GET /api/items/uncommitted` answers `known: false` for a tracker project — the question has no meaning there — and the chip's existing
  `known` gate keeps it off. Note the invariant this must not breach: `uncommitted` stays a sibling endpoint, never a `BacklogItem` field, and nothing derived
  reads it.
- **Dispatch**: hidden for tracker projects, the **environment-level way (no buttons)**, because a spawned session would run file-writing skills against a
  project with no files. This is the existing distinction CLAUDE.md pins — environment-level blocks hide the control, per-item ones disable it — so it belongs
  on the hide side, not as a fourth disabled state in `DispatchButton`. Phase 3 lifts it.

### Step 7 — the Trackers card

Shared Settings page, `scope="this machine"`, beside Claude Agents. **Read-only; nothing on this card POSTs and there is no connections file.**

- One row per platform: `GitHub — as futin, issues read/write, 4,812 of 5,000 left, resets 14:32`, or `no token — set BM_GITHUB_TOKEN in .env and restart`.
- One row per registered project: name, source (`files` / `github futin/x`), poll age, access state.
- For a **files** project whose `origin` is on GitHub, the row also shows the exact command to connect it — `backlog.mjs connect github futin/x` — as copyable
  text, with the repo read off `origin` **per request**, the way `uncommitted` reads git per request. Not memoised, and explicitly not joining the `git-dates`
  memo one file over.

This card is Shared, not Local, and the page IS the scope — no in-page switch at any width. Do not mix a per-device field into it.

### Step 8 — `backlog.mjs connect github [owner/repo]`

- Refuses inside a linked worktree and outside a git repo, like every other command — the discriminator is a `commondir` entry in the `gitdir:` target, never
  "`.git` is a file".
- Defaults `owner/repo` from `origin`; refuses when there is none and none was given.
- **Refuses a project that still has item files under `backlog/`** — that is `import`'s job (phase 5). `connect` is for an empty or absent store.
- Writes `backlog/source.json` and, unless `--no-forms`, four issue forms under `.github/ISSUE_TEMPLATE/` — one per type, each pre-applying its `type:*` label
  and carrying that section's headings as form fields, so an issue filed in the web UI has the skeleton `deriveGroomed` reads. Blank issues stay enabled; the
  `untyped` badge exists for those.
- Prints the files to commit. **Needs no server running** — the label set is the poller's job.
- `backlog.mjs` keeps its single-writer relationship with `registry.json` untouched: `connect` writes the project's own marker, not the registry.
- The file must keep ending with `process.exitCode = main(...)`, never `process.exit(...)`, and `backlog.test.mjs`'s source guard covers it.

### Step 9 — docs

`CLAUDE.md` (the outbound-calling line, a Trackers/poller entry, the token invariant), `docs/subsystems/invariants.md` (the reasoning for each new rule, with
anchors), `docs/subsystems/api.md`, `docs/subsystems/board.md`, `docs/overview.md`, and a `.claude/rules/` pointer if a new path scope earns one — remembering
that a rule with no `paths:` loads in every session and that `test/claude-rules.test.ts` asserts the shape.

## Test cases

Authoritative. Where this section and the Plan disagree, this section wins.

**`resolveSource` with `github` registered**

- a marker `{"kind":"github","repo":"futin/x"}` and `known` containing `github` → `{ kind: 'tracker', marker }`; the same marker with `known` **not** containing
  it → `{ kind: 'unsupported' }`, reason ending `unsupported source kind "github"`. This pair must keep passing unchanged — it is the load-bearing negative.

**Issue → `BacklogItem`** (one issue fixture per row, asserting the whole mapped object, not a field)

- labels `['type:bug']` → `section: 'bugs'`, `untyped: false`.
- labels `[]` → `section: 'ideas'`, `untyped: true`, and **no** entry in `errors`.
- labels `['type:task','type:bug']` → `section: 'bugs'` (first alphabetically), `untyped: false`, **and exactly one** `errors` entry naming the issue.
- labels `['type:bug','kind:debt','backend']` → `kind: 'debt'`, `tags: ['backend']` — the `type:*` and `kind:*` labels are consumed, every other label is a tag.
- labels `['type:task','runner-fix']` → the same `runnerFix` the gate reads today is `true`, and `runner-fix` is consumed, not left in `tags`.
- `state: 'open'` → `status: 'open'`.
- `state: 'closed'`, `state_reason: 'completed'` → `status: 'done'`, section unchanged.
- `state: 'closed'`, `state_reason: null` → `status: 'done'`, section unchanged.
- `state: 'closed'`, `state_reason: 'not_planned'` → `status: 'terminal'`, `section: 'out-of-scope'`, **and the `type:*` label still present in the source data**
  so the original type is recoverable.
- `state: 'closed'`, `state_reason: 'duplicate'` → same as `not_planned`.
- `id` is `#<number>`; `path` is `gh:<owner>/<repo>#<n>`; `url` is `html_url`; `source` is `'github'`.
- `assignees: []` → `assignee: null`; two assignees → the **first** login.
- `lastCommit` is `''` **always** — assert it explicitly, because the client's `lastTouched` precedence falls through the middle rung on it.
- `updated` is `updated_at` verbatim; `created` is the **date part** of `created_at`.
- `started` and `phase` are `''`, and the four counters are `0` — phase 2 values, asserted so phase 3 has a red test when it fills them.
- `groomed` is `deriveGroomed(section, body)` over the issue body, unchanged — one case proving a groomed body reads `true` and a skeleton one `false`.
- an object carrying `pull_request` is **absent from the result entirely**.

**Poller**

- armed when a project resolves to `github` and a token is present; **disarmed** when the token is absent, when no project resolves to `github`, and when both.
- a `304` leaves the cache and `polledAt` unchanged and costs no rate-limit budget.
- `since` is inclusive: re-seeing an already-cached issue **upserts** — the item count does not grow.
- first sync sends no `since` and paginates past `per_page`; assert two pages are both consumed.
- `403` with `remaining: 0` → `access: 'rate-limited'`, `detail` naming the reset, and no further request until the reset.
- a secondary-limit response backs off 60s.
- the comments request **is made** on every tick — assert the call, since nothing reads its result in this phase and it would otherwise be dropped silently.

**`ProjectSummary`**

- a files project → `repo`, `polledAt`, `access`, `detail` all `null`, `source: 'files'` — the existing payload plus four nulls.
- a github project before its first sync → `polledAt: null`, `access` reflecting the token state, `missing: false`.
- a github project with **no token** → `access: 'no-token'` and **`missing: false`** — explicitly not missing, which is the sentence §5.4 spends a line on.
- `counts` is over the cache, and a `done` item is excluded from it exactly as today.

**Service dispatch**

- two adapters registered for one kind still throws at boot, naming the kind.
- `body()` with a filesystem path goes to files; with a `gh:` URN goes to the github adapter; with a URN for an **unconnected** project returns `null` (404 at
  the route), never a files-allowlist lookup.
- `/api/items` for a registry of one files project and one github project returns both projects' items in one payload, with `source` distinguishing them.

**`connect`**

- inside a linked worktree → exit `1`, naming the worktree and the project root.
- outside a git repo → refusal.
- no `origin` and no argument → refusal.
- a project with item files under `backlog/` → refusal naming `import`.
- success writes `backlog/source.json` with `kind: 'github'` and the repo, writes four issue forms, prints the files to commit, and **touches `registry.json`
  not at all**.
- `--no-forms` writes the marker and no forms.

**Client**

- a tracker project shows **no dispatch button at all** (hidden, not disabled) — assert absence, and assert a files project in the same render still has one.
- `untyped: true` draws the badge; `untyped: false` does not.
- `url` set draws the link-out; `url: null` does not.
- the band shows the poll age when `access` is `ok`, and the access reason in its place when it is not.
- the item modal renders the cached body with no fetch on open.
- `GET /api/items/uncommitted` answers `known: false` for a tracker project and the chip does not render.

**Guards**

- `test/compose-env.test.ts` extended: `BM_GITHUB_TOKEN` is passed through as an interpolation with a default, and no literal token string appears in the file.
- the token appears in **no** API response — assert over `/api/items`, `/api/projects` and the settings payload.

## Done when

- `pnpm test` green — **both runners** (`scripts/test-all.mjs`: jest, then `node --test`), `pnpm run typecheck` clean, `pnpm run build` green.
- A real repo connected end to end: `backlog.mjs connect github <owner>/<repo>`, commit the marker, restart the stack, and its issues render on the board beside
  the file projects with a live poll age. Record the issue count and the projects in the Outcome, the way task-43 recorded 240 items across 5 projects.
- The eight labels exist on that repo after the first sync, and a second sync creates none of them again.
- `items.service.ts`'s control flow is unchanged by this phase — diff it and say so in the Outcome. If it had to change, say what forced it; that is the seam
  failing its claim and is worth more than a green suite.
- Both `SourceKind` casts in `items.service.ts` are gone, along with the comments explaining them.
- CLAUDE.md no longer calls `agents/` the one outbound-calling module.
- Contract sweep and red proof, per `backlog-execute`'s pre-review checks.

**Not in this phase, on purpose**: any write route, the claim protocol, `backlog.mjs` API mode, dispatch against a tracker project, run state as a claim comment,
`import`, and deleting the files path. Those are phases 3–6, each captured as its own task `from: idea-12` when its turn comes.

## Outcome

2026-09-18 — done. Phase 2 of the tracker-backed direction landed: GitHub issues now render on the board beside file items, from one `/api/items` payload, with
a poll age stating how old the view is; a tracker project gets no dispatch control at all; and `backlog.mjs connect github` writes the marker that connects one.

**What landed, by step.** (1) `SourceKind` widened to `'files' | 'github'` and both casts in `items.service.ts` are gone — the map is keyed by `string` and the
summary's `source` is read off `adapter.kind`, which is the typed answer to the question the field asks; `BacklogItem` gained `url`/`assignee`/`untyped` and
`ProjectSummary` gained `repo`/`polledAt`/`access`/`detail`, all required, which named 31 fixture literals across 17 test files. (2) `server/src/tracker/` —
`token.util.ts` (read per call, never cached), `github.client.ts` (one constant host, no Nest decorators, rate-limit headers recorded from every response
including a `304`, no throw on any status). (3) `poller.service.ts` — a `setTimeout` chain in the watchdog's shape, `TRACKER_POLL_MS = 15_000`, armed only while
a project resolves to `github` and a token is present, two conditional requests per repo per tick, first-sync pagination, inclusive-`since` upsert, PRs dropped,
rate-limit sleep and a 60 s secondary backoff. (4) `labels.ts` — the eight, created idempotently and case-insensitively on a repo's first successful sync. (5)
`sources/github.source.ts`, registered by appending two lines to `items.module.ts`; `ItemSource` gained `summary`. (6) the client: band poll-age line, card
`untyped`/assignee/link-out, modal age beside the cached body, dispatch hidden, `uncommitted` `known: false`. (7) the `Trackers` card on Shared Settings, behind
the read-only `GET /api/trackers`. (8) `connect github [owner/repo] [--no-forms]` (implemented by a delegated session, reviewed here). (9) docs.

**`items.service.ts`'s control flow is unchanged for listing** — `index()` and `projects()` dispatch over the adapters exactly as phase 1 wrote them; the only
behavioural additions to that file are the two the plan asked for, both outside the listing path: `body()`'s ref-shape test (which phase 1's own comment named
this phase as the place for) and `uncommitted()`'s tracker answer. The seam's claim held.

**Verification.**

```
$ pnpm test
Test Suites: 117 passed, 117 total
Tests:       1872 passed, 1872 total
# tests 575
# pass 575
# fail 0
PASS  jest
PASS  node --test (skills)

$ pnpm run typecheck
$ tsc --noEmit                      (no output — clean)

$ pnpm run build
✓ built in 1.17s
```

**Live read-only probe against the real API** (`cli/cli`, through `GithubClient` + `mapIssue`, token from `gh auth token`, no writes):

```
status 200 etag true next true rate {"limit":5000,"remaining":4997,"reset":1789726568}
rows 100 items 30 pull requests dropped 70
sections {"ideas":30}
untyped 30 assigned 8 closed 30
conditional status 304 rate after {"limit":5000,"remaining":4997,"reset":1789726568}
labels status 200 count 83
```

That is the mapping and the budget rule against real payloads: 70 pull requests dropped out of 100 rows, every issue in a repo with no `type:*` labels landing
in `ideas` with `untyped: true`, and the conditional re-request answering `304` with `remaining` unmoved — a `304` costs nothing, measured rather than assumed.

Contract sweep: 17 sites updated (CLAUDE.md, docs/subsystems/invariants.md, docs/subsystems/api.md, docs/subsystems/board.md, docs/subsystems/skills.md,
docs/overview.md, .claude/DESIGN.md, .claude/rules/{items,board}.md, README.md, .env.example, shared/types.ts, server/src/items/items.service.ts,
server/src/items/sources/source.ts, server/src/items/uncommitted.util.ts, client/src/components/settings/SettingsView.tsx, test/claude-rules.test.ts,
test/settings-view.test.tsx, skills/backlog/SKILL.md)
Red proof: 29 tests went red with the change reverted

One site left standing on purpose: `docs/superpowers/plans/2026-09-04-orchestrator-watchdog.md` still calls `agents/` "the one outbound-calling module". It is a
dated plan document — `docs/superpowers/` is deliberately outside `/docs-sync`'s tracking as specs, plans and decision logs — and editing it would falsify a
record of what was true when it was written. Every NORMATIVE statement of that claim (CLAUDE.md, overview.md, api.md) was updated.

Two red proofs initially stayed green and both were test defects, fixed rather than noted: the `uncommitted` case passed because its fixture was not a git repo
at all (it now `git init`s the fixture and asserts the files answer would be `known: true`), and the body-route case passed because the unconnected repo was
also absent from the cache (a second case now disconnects a CACHED repo by rewriting the registry, so only the registry gate can produce the 404). A third
mutation exposed a real hole in the comments-per-tick case, which now drives a `304` tick.

**Decisions and disagreements a reviewer should see.**

1. **A `304` leaves `polledAt` unchanged** — this item's `## Test cases` says so in those words; the spec's §12.2 says a `304` MOVES `polledAt`. The item won,
   being the work order, and the code carries a comment at the branch saying so. The consequence is real: the rendered age means "how old are these items", not
   "how long since we last checked", so a repo nobody edits reads as increasingly stale while the poller is in fact healthy. Worth settling in phase 3; the
   spec's reading is the better product behaviour and this is a one-line change.
2. **"No per-open fetch" in the item modal is a fetch to THIS app, not to GitHub.** The literal test-case wording ("renders the cached body with no fetch on
   open") cannot be satisfied without shipping every issue body inside `/api/items`, which the board re-reads every 15 s while a tracker is registered — and it
   would contradict Step 5, which requires the URN to reach `ItemsService.body()`'s new shape test. The modal therefore makes one request to
   `/api/items/body?path=gh:owner/repo%2331`, answered out of the poller's cache with no network call; the test asserts that one call and that nothing in the
   browser ever names `api.github.com`.
3. **`ItemSource.summary` takes `(project, marker)`**, not `(project)` as Step 5 wrote it: the adapter reads its repo off the marker exactly as `list` does, and
   a `summary` that found the repo another way would be a second resolution path for the question `resolveSource` already answered.
4. **`runnerFix` does not reach `BacklogItem`.** The `runner-fix` label is consumed (never a tag) and travels on the mapper's own result, because Step 1 fixes
   the three fields `BacklogItem` gains and nothing on the read side renders this one — phase 2 has no dispatch against a tracker project at all. Phase 3 is
   where it acquires a reader.
5. **The board polls while a tracker is registered** (`BOARD_TRACKER_POLL_MS`, 15 s, pinned equal to the server's `TRACKER_POLL_MS` by a test). Not in the plan,
   but without it `useBoard`'s mount-and-focus cadence would leave `polledAt` frozen and the band's live reading would be a lie. No tracker registered means no
   interval at all — the same "poll only while something is moving" shape `useOrchestratorRuns` has.
6. **`test/claude-rules.test.ts` now matches globs against tracked PLUS untracked-not-ignored files.** A rule file added in the same commit as the directory it
   scopes — which is how `.claude/rules/tracker.md` arrived — was a false red under a tracked-only universe. A typo'd glob still matches nothing either way.
7. **The client's `/api/trackers` body is shape-checked** (`isTrackersPayload`) before anything renders from it, the way `fetchAgentsStatus` already does. This
   was not defensive programming: the unguarded first version crashed the whole Shared Settings page in the existing settings suite, which stubs `fetch` with a
   single payload for every URL.

**Not done, deliberately: the live end-to-end connect.** The `## Done when` list asks for a real repo connected end to end — `connect`, commit the marker,
restart the stack, watch the issues render, and the eight labels created on the first sync. Two of those steps are writes to a real GitHub repository (the label
bootstrap) and to a machine's running stack, and this was an unattended orchestrator run with nobody to authorise them. The read-only probe above is what stands
in for the network half; the mapping, the poller's branches, the label bootstrap's create-only-what-is-missing arithmetic and the whole `/api/items` payload are
covered by hermetic suites (`tracker-map`, `tracker-poll`, `tracker-items`, `tracker-labels`, `tracker-origin`, `tracker-lib`, `tracker-board`). A person with a
token should run the connect on one real repo before this is treated as proven in the field.

### Fix pass — 2026-09-18, after review

Verdict `fix`; every Important and Minor finding addressed, none disputed. The reviewer was right about the shape of the miss on the Important one: the sweep
walked the section of `invariants.md` this task changed and stopped one paragraph short of the sentence naming the very type it widened.

**Important — `SourceKind`'s three homes, plus the claim about who reads `source`.** Four sentence edits: `CLAUDE.md`'s source-marker invariant and
`docs/subsystems/invariants.md`'s matching paragraph now read `'files' | 'github'` (both keep "widens only with the adapter, never ahead of one"), and
`BacklogItem.source`'s doc comment in `shared/types.ts` says what each value means for `path` (a filesystem path against a URN) and replaces "the client
ignores the field until a second kind exists" with the two readers it now has — `deriveAction`'s first line, which is what hides dispatch on a tracker project,
and `lib/tracker.ts`, which reads `ProjectSummary.source` rather than this one.

**Minor, all five.**

- `TrackersPayload`'s comment pointed at `test/tracker-token.test.ts`, which was never written; it now names `test/tracker-items.test.ts`'s
  `never puts the token in a payload` and the three routes that case covers.
- `shouldPoll`'s comment claimed `sweep()` "re-reads both halves after every await". It does not: it reads them once at the top of every tick. The comment now
  says that, and says what it buys — a token removed mid-tick costs at most the requests already in flight, because the next tick cannot start before this one
  finishes.
- `ensureLabels` was the one list read in the file not using `Array.isArray`, against the rule the two reads above it state in full. Fixed, and pinned by a new
  case (`survives a labels body that is not a list, and keeps ticking`): a 200 carrying valid non-array JSON now leaves the repo `ok` and the chain alive
  instead of throwing an unhandled rejection out of the timer. Red-proved — the case fails with the old `!== null` guard.
- `TrackersGroup` called `pollAge` with no `now`, the only call site not keeping the rule `lib/tracker.ts`'s header states. The card now reads the clock once
  per render and threads it down.
- The token guard's sentinel was `'tok'`, three characters that a legitimate payload could carry (a `detail` echoing GitHub's own "Bad credentials"). Now
  `ghp_task45SentinelValueNoPayloadMayCarry` — it could never have gone falsely green, but it could have gone falsely red.

The `304`/`polledAt` finding stands as implemented, per the item's own authoritative test case and the reviewer's own note.

```
$ pnpm test
Test Suites: 117 passed, 117 total
Tests:       1873 passed, 1873 total
# tests 575
# pass 575
# fail 0
PASS  jest
PASS  node --test (skills)

$ pnpm run typecheck
$ tsc --noEmit                      (no output — clean)

$ pnpm run build
✓ built in 1.19s
```

Contract sweep (fix pass): 3 sites updated (CLAUDE.md, docs/subsystems/invariants.md, shared/types.ts)
Red proof (fix pass): 1 test went red with the change reverted

#### Second fix pass — 2026-09-18

Verdict `fix` again; all six findings addressed, none disputed.

**Important — the link-out was half a pattern this repo had already written down.** The card's own `onKeyDown` bubbles from any descendant and calls
`preventDefault()` + `onOpen()`, and `preventDefault` on that keydown cancels the ANCHOR'S activation, so Enter on the focused link opened the modal and never
reached GitHub — with no other keyboard path to the issue, since the modal draws the tracker line but no link. The anchor now carries the same two-key guard
`DispatchButton` documents in full (`Enter`/`Space` only — stopping every key was itself a real bug there, because React delegates keydown at the root and
Escape stopped reaching the dialog stack). `test/tracker-board.test.tsx`'s case drives click, Enter AND Space now, and is **red-proved**: with the handler
emptied, the Enter assertion fails with the modal in the DOM.

**Minor, all five.**

- `ensureLabels` guarded the container and not the element: `[1]` or `[{}]` still threw on `undefined.toLowerCase()` inside the timer chain — the same hazard
  one level down. It now filters to elements carrying a string `name`, which is also the only element it could compare against the eight.
- `docs/subsystems/invariants.md`'s `docs-sync` block was left ~110 lines from the end by the first pass's append. Moved back to the last thing in the file,
  where `api.md`, `board.md` and `skills.md` keep theirs.
- The two origin parsers disagreed — the skill accepted `www.github.com` and any URL scheme, the server accepted neither, so the Trackers card stayed silent
  about a project `connect` would have connected. `parseGithubRemote` now uses the skill's grammar character for character (including the leading-slash /
  trailing-slash / `.git` strip ORDER, which only reduces `…/repo.git/` correctly one way), and the split is now guarded the way `labels.ts`'s is: a new case
  RUNS the skill's own `parseOriginRepo` in a node child over a file URL against a shared table of 20 remotes and asserts every answer matches — never an
  import, so the "one skill's `tools/` may not be imported" rule is untouched. A second case pins what they agree ON, so the pair cannot both be wrong in the
  same way and pass.
- `pollAge` and `trackerLine` lost their `now = Date.now()` defaults. Every call site already passed one; the default was the remaining way for the next call
  site to read its own clock silently, which is exactly the rule the module's header states.
- `styles.css`'s "four foot markers" now names the set rather than counting it (the count is what goes stale) and corrects the tone claim: `stale` and
  `untyped` are both `--amber`, not `--mustard`.

```
$ pnpm test
Test Suites: 117 passed, 117 total
Tests:       1875 passed, 1875 total
# tests 575
# pass 575
# fail 0
PASS  jest
PASS  node --test (skills)

$ pnpm run typecheck
$ tsc --noEmit                      (no output — clean)

$ pnpm run build
✓ built in 1.56s
```

Contract sweep (second fix pass): 1 site updated (client/src/styles.css — the marker-set comment)
Red proof (second fix pass): 1 test went red with the change reverted
