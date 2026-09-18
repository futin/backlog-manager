---
id: task-45
title: Tracker-backed phase 2: the GitHub adapter read side - poller, label bootstrap, issue mapping, Trackers card and connect
created: 2026-09-18
from: idea-12
tags: architecture, multi-machine, tracker, github, poller, settings
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
