# Jira integration — phase 2, the Jira section — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The client half of the read side and the config half of the write side: a `Jira` rail section with two pages (Board, Setup), a read-only issue
modal, a shell chip and a Trackers row — and the three `jira.json` write routes (`boards`, `boards/delete`, `repos`) that Setup saves through. Nothing is
written to Jira in this phase; the assign/transition controls are phase 3, Run ▾ and the Skills card phase 5.

**Architecture:** Server: `config.util.ts` gains its writers on `writeSyncInterval`'s contract (merge one entry into the raw parsed file, temp file plus
rename, refuse an unreadable file), a new `jira-write.controller.ts` behind `SameOriginPostGuard` validates and calls them, and the poller gains one method
that sweeps a just-saved board at once. Client: one `JiraProvider` over `useJira` (the `useTrackers` shape) feeds the rail, the chip, the Trackers row and
both pages; `lib/jira.ts` is the one home of every derivation; the pages compose existing primitives (`Band`, `FilterBar`, `BoardColumn`, `Modal`,
`FormSheet`, `Popover`, `Segmented`, `Select`, `Confirm`, `SettingsGroup`/`SettingsRow`) and add no new `ui/` primitive beyond the three hoists the spec names.

**Tech Stack:** NestJS 11 on Node 22, React 18 + Vite, TypeScript strict, jest (node and jsdom projects) + supertest + Testing Library, pnpm. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-10-15-jira-integration-design.md](../specs/2026-10-15-jira-integration-design.md) — §1 overrides of the mocks, §2 scopes,
§3 `config.util.ts` and the poller's save rule, §4 shapes, §5 the three write routes and their validation, §6.1–6.5 the client, §10 security, §11 testing,
§12 phase 2, §13 the section-and-tree rule. Mocks and their audit: [`2026-10-15-jira-mockups/`](../specs/2026-10-15-jira-mockups/00-mock-audit.md). Phase 1's
plan ([2026-10-16-jira-phase-1-server-read.md](2026-10-16-jira-phase-1-server-read.md)) is what the server side already holds.

**Plan conventions (they override the writing-plans template where the two differ):**
- Every task states BEHAVIOUR and EXACT TEST CASES — inputs, expected values, edge cases — never literal code. The implementer writes the code and the test
  bodies, and is expected to disagree with a case here when the spec or the code says otherwise (and to say so in the commit). Reason: handed code gets
  transcribed verbatim, bugs included (the user's CLAUDE.md, "Learnings").
- Signatures in **Interfaces** are the one place a name is fixed; a later task that consumes a name must spell it exactly as the producing task does.
- Size budgets are soft targets, never a reason to drop a rule or a comment. Every new file carries a header comment that explains WHY, at the density
  `client/src/hooks/useTrackers.ts` and `server/src/jira/*.ts` have, and cites the spec section it implements; every new component also cites its DESIGN.md
  subsection (§8.9.1 Board, §8.9.2 Issue modal, §8.9.3 Setup, §8.9.4 Chip and Trackers row — written in Task 13, cited from Task 7 on). New prose wraps at 160.
- Commit after every task with the message given; nothing is pushed by this plan. The branch is `feat/jira-phase-2-section`, cut from `main`; the PR title
  (`ci / pr-title`) is `feat(jira): the Jira section — board, issue modal, setup, chip`.
- Run only the suites a task touches (`pnpm run test:jest -- test/<name>.test.ts[x]`); CI runs the whole suite on the PR. `pnpm run typecheck` before each
  commit. A task that moves a file runs every suite that imports it (`grep -rl` the old path under `test/` first).

## Rulings this plan makes where the spec is silent

Each is a decision, recorded so a reviewer can reject it by number rather than rediscover it.

- **R1 — `JiraStatusPayload` gains two fields.** `armed: boolean` (the poller's `armed` getter — the Connection row's `every 15 s` / `idle` has no other
  source) and `home: string | null` (`os.homedir()`, read per call; `null` while unconfigured — the Repositories card shows a path with `$HOME` as `~`, and
  the browser has no other way to know `$HOME`; the compose stack passes the host's `HOME` through, so the container's `homedir()` is the host's).
- **R2 — a save waits for its own sweep, bounded.** `POST /api/jira/boards` awaits the poller's sweep of that board, raced against
  `JIRA_SAVE_SWEEP_WAIT_MS = 20_000`, then answers. Why: the client reloads the board and `GET /api/jira` on the answer (§6.1), and a route that answered
  before the sweep would hand back the pre-save list with nothing on the client's clock to fetch it again for up to a whole interval (or ever, for `off`).
  The cap keeps a slow Jira from holding the sheet open; past it the save has still landed, and the next status poll catches the list up.
- **R3 — query ids across an edit.** A query sent WITH an id that the stored board holds keeps it; any other query (no id, or an id the board does not
  hold, or a non-`q_` id) is minted a new one. A query's identity is never inferred from its label or JQL.
- **R4 — path normalisation for `repos`.** Trim; `~` alone or a leading `~/` expands to `homedir()`; `~user/…` is a 400; the result must be absolute and must
  not contain an empty segment (`//`), a `.` or a `..` segment (400 `path must be absolute and normalised: <path>`) — the dashboard compares paths as raw
  strings, so the server stores exactly one spelling; one trailing `/` is removed (`/` alone stays `/`); duplicates are removed AFTER normalisation.
- **R5 — the three query presets' JQL** (one home: `JIRA_QUERY_PRESETS` in `lib/jira.ts`): `Assigned to me` → `assignee = currentUser() AND statusCategory
  != Done`; `Open in current sprint` → `sprint in openSprints() AND statusCategory != Done`; `Unresolved in <KEY>` → `project = "<KEY>" AND resolution =
  Unresolved` (the key is picked from a `Select` over `/api/jira/projects` that the chip reveals in place). All three are bounded (P2), and the check line
  verifies them like any other row. `+ Custom JQL` adds an empty row labelled `Custom query`.
- **R6 — the Popover composer count.** `useDialogEscape.ts`'s comment says `Popover` has three composers; this phase adds three (the Jira chip's, the board
  picker, the roots search), so it reads six. The Jira board's Filters are `FilterBar`'s own popover, already counted.
- **R7 — what the modal leaves out in phase 2.** No `Assign to me`, `Move to…` (phase 3), `Run ▾` or `Stop session` (phase 5), and no `session` fact (phase 5;
  `JiraIssueDetail.session` is still typed `null`). The controls row is simply absent, not drawn disabled.
- **R8 — `polledAt: null`.** A board not swept yet reads `not polled yet` wherever an age would be (Band, Setup row, chip popover), never `NaN` or `0 s`.
- **R9 — one age formatter.** Every poll/check age on a Jira surface goes through `pollAge` (`client/src/lib/tracker.ts`), which prints `12 s` under a minute
  and `elapsedSince` above — the spec writes both `Xs` (§6.2) and `3 s` (§6.4); the existing formatter decides, so Jira and GitHub ages read alike.
- **R10 — the chip draws one initial**, the first letter of `me.name` (`?` while `me` is null), as `TrackerChip` does and §6.5 says; `initialsOf` (two
  letters) is the CARD's reading only.
- **R11 — a non-string board `id`** (`7`, `{}`, `true`) in a `POST /api/jira/boards` body is a 400 naming `id`; `null` or absent is a create; any string goes
  to `writeBoard`, where one the file does not hold is the 404.

## Global Constraints

Copied from the spec and CLAUDE.md; every task's requirements include these.

- **The browser never talks to Jira.** Every request the client makes is to `/api/jira…`; no `avatarUrls` image, no `browse` link fetched — a `browse` link is
  an `<a target="_blank" rel="noreferrer">` built by the SERVER (`JiraIssue.url`) and rendered as given.
- Writes (`POST /api/jira/boards`, `/boards/delete`, `/repos`): `application/json` + same origin via `SameOriginPostGuard` (403 otherwise); 400 malformed,
  naming the field; 503 `Jira is not configured` while unconfigured; 404 for an id the file does not hold; 409 when `jira.json` exists and cannot be read or
  parsed (the file left byte-identical). Order inside a handler: guard → validate (400) → configured (503) → write (404/409) → re-aim. Config writes stay open
  under `access: unauthorized` (§8) — they touch only `jira.json`. Every error body is `{ error }`.
- Board validation (§5): trimmed `name` 1–80; `interval` in `SYNC_INTERVALS`; ≤ 20 roots, each passing `isJiraKey`, deduplicated; ≤ 10 queries, each a
  trimmed `label` 1–80 and a `jql` 1–`JIRA_JQL_MAX_CHARS` (2 000, the existing one home in `config.util.ts`); at least one root or query. Ids are server-minted
  — `b_`/`q_` plus 8 lower-case hex (`isJiraId`) — and a client id on CREATE is ignored. Repos validation: `project` matches `JIRA_PROJECT_KEY_RE`; ≤ 10 paths
  after R4; an empty list removes the key.
- Writers follow `writeSyncInterval`: read the RAW file; ENOENT → start from `{}`; unreadable or unparsable → throw `JiraConfigUnreadableError` and write
  nothing; a parsed non-object → replaced; otherwise merge ONE entry (a board by id, one project's list by key) and keep everything else — malformed entries
  and unknown top-level keys included — then write `JSON.stringify(next, null, 2) + '\n'` to a temp file in the same directory and `rename` it over.
- `jira` joins `SECTIONS` between `archive` and `settings`; the rail draws it only while `GET /api/jira` says `configured: true`; the two pages are switched by
  the rail's tree ALONE (the Runs/Settings rule) or by a link threaded down from `App` (`onOpenJiraPage`), never by an in-page control.
- Per-browser keys: `backlog-manager.jira-board` (`usePersistedState`) and `backlog-manager.jira-page` (module store, `useRunsMode`'s shape). Filters and the
  summary search are per mount, never persisted.
- Constants, one home each: `JIRA_SWEEP_CALL_CEILING = 100` and `JIRA_429_RED_MS = 15 * 60_000` and `JIRA_QUERY_PRESETS` in `lib/jira.ts`;
  `JIRA_STATUS_FLOOR_MS = 15_000` in `useJira.ts`; `JIRA_SAVE_SWEEP_WAIT_MS = 20_000` in `poller.service.ts`; `JIRA_JQL_CHECK_DEBOUNCE_MS = 500` in the board
  sheet; `JIRA_BOARD_FILTER_FROM = 6` (the Boards card's filter field appears at six boards) in `lib/jira.ts`. The board poll reuses `BOARD_TRACKER_POLL_MS` (`client/src/hooks/useBoard.ts`).
- jsdom suites mock `fetch`; fixture dates are relative to the clock the assertion runs under (`test/helpers/dates.ts`); NO suite reaches a real Jira.
- Styles go in `client/src/styles.css` and must pass `test/design-guards.test.ts` (11 px floor, one uppercase rule, one home per `ui` family); colours are
  existing tokens only.
- `.claude/rules/*.md` bullets are anchored once each into `docs/subsystems/invariants.md`; CLAUDE.md headlines are byte-equal with the rule file's bold spans
  (`test/claude-rules.test.ts`).

## Review Focus

Inputs the spec implies but names no test for, most likely to bite first; each line's test is added to the task that owns the code.

1. Saving a board while the site is still connecting or inside a 429 window must still answer 200 with the board within `JIRA_SAVE_SWEEP_WAIT_MS`, the
   board then reading `not polled yet` (R8) — never a hung sheet, never a 503 — Tasks 2 and 3.
2. `jira.json` that stops parsing while the Setup sheet is open: Save answers 409, the sheet stays open with every edit intact and the server's sentence
   under the footer; the Board page reads `jira.json cannot be read`, never `No boards yet` — Tasks 3, 8 and 10.
3. A stored `backlog-manager.jira-board` that names a deleted board (deleted here or in another browser) or is garbage must fall to the first board by
   name with NO request to `/boards/<that id>/issues`; with no boards at all, `No boards yet` and its chip to Setup — Task 8.
4. Repository paths: `~/x/` → `<home>/x`; `/a//b`, `/a/./b`, `/a/../b`, `x/y`, `~bob/x` → 400; `/a/b` and `/a/b/` in one list → one entry; 11 distinct paths
   → 400 — Task 1.
5. A status read that FAILS at load with the stored section `jira` must keep the shell on Jira in the Board's unavailable shape (only `configured: false`
   moves it to `board`), and a later `configured: false` must move it — Task 7.

---

## File structure

| file                                                         | responsibility                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `shared/types.ts` (modify)                                    | `armed`, `home` on `JiraStatusPayload` (R1)                                                            |
| `server/src/jira/config.util.ts` (modify)                     | the writers, `JiraConfigUnreadableError`, the write-time parsers, `normaliseRepoPath`                  |
| `server/src/jira/poller.service.ts` (modify)                  | `boardSaved(id)`, `boardDeleted(id)`, `armed`/`home` in `status()`                                     |
| `server/src/jira/jira-write.controller.ts` (new)              | the three POSTs                                                                                       |
| `server/src/jira/jira.module.ts` (modify)                     | registers the write controller                                                                        |
| `client/src/components/ui/Fact.tsx` (new, hoisted)            | `Fact`, out of `ItemModal.tsx`                                                                        |
| `client/src/lib/markdown.ts` (new, hoisted)                   | `renderMarkdown`, the sanitising `marked` config out of `ItemModal.tsx`                               |
| `client/src/components/ui/SettingsRow.tsx` (moved)            | `SettingsGroup`, `SettingsRow`, from `components/settings/`                                           |
| `client/src/components/board/BoardColumn.tsx` (modify)        | `BoardColumnSlug` gains `todo`, `doing`, `done`                                                       |
| `client/src/lib/jira.ts` (new)                                | every Jira derivation                                                                                 |
| `client/src/lib/jira-page.ts`, `client/src/hooks/useJiraPage.ts` (new) | the page key, members, guard; the module store                                                |
| `client/src/hooks/useJira.ts`, `client/src/hooks/JiraContext.tsx`, `client/src/hooks/useJiraBoard.ts` (new) | the status read on its clock; its provider; one board's list           |
| `client/src/lib/sections.ts`, `client/src/components/SideRail.tsx`, `client/src/App.tsx`, `client/src/lib/settings.ts`, `client/src/components/settings/SettingsView.tsx` (modify) | the section, its tree, the shell's hold-and-fall, the landing option |
| `client/src/components/jira/JiraView.tsx` (new, lazy)         | the section: picks Board or Setup                                                                     |
| `client/src/components/jira/JiraBoardView.tsx`, `JiraCard.tsx` (new) | the Board page                                                                                 |
| `client/src/components/jira/JiraIssueModal.tsx` (new)         | the read-only modal                                                                                   |
| `client/src/components/jira/JiraSetupView.tsx`, `JiraBoardSheet.tsx`, `JiraReposGroup.tsx`, `JiraConnectionGroup.tsx` (new) | the Setup page and its sheet                         |
| `client/src/components/JiraChip.tsx` (new), `client/src/components/settings/TrackersGroup.tsx` (modify) | the shell chip; the Trackers row                                   |
| `client/src/styles.css` (modify)                              | the Jira surfaces' rules                                                                              |
| tests (new): `test/jira-config-write.test.ts`, `test/jira-write-routes.test.ts`, `test/jira-lib.test.ts`, `test/use-jira.test.tsx`, `test/jira-sections.test.tsx`, `test/jira-board.test.tsx`, `test/jira-modal.test.tsx`, `test/jira-setup.test.tsx`, `test/jira-chip.test.tsx` | per task |
| tests (modify): `test/jira-poller.test.ts`, `test/jira-routes.test.ts`, `test/ui-modal.test.tsx`, `test/settings-view.test.tsx`, `test/settings-trackers.test.tsx`, `test/dialog-count-docs.test.ts` | per task |
| docs: `.claude/DESIGN.md`, `.claude/rules/board.md`, `.claude/rules/jira.md`, `docs/subsystems/invariants.md`, `docs/subsystems/jira.md`, `docs/subsystems/board.md`, `CLAUDE.md`, `client/src/hooks/useDialogEscape.ts` (comment only) | Task 13 (and Task 3 for the server-side rule) |

Not in this phase: `POST /api/jira/skills` and the Skills card, `jiraDefaultAction` (5); assign/transition, the modal's controls, the splice (3);
`skills/jira` (4); Run ▾, the launch sheet, the prompt route, dispatch, stop, the live map and the card's live strip (5).

---

### Task 1: `jira.json`'s writers

**Files:**
- Modify: `shared/types.ts` (R1's two fields — the poller fills them in Task 2; until then `status()` must still compile, so add them there as `armed:
  this.armed`, `home: homedir()` / `false`, `null` in this task)
- Modify: `server/src/jira/poller.service.ts` (`status()` only — R1's two fields)
- Modify: `server/src/jira/config.util.ts` (header: the "reader half" paragraph becomes the writers' contract; keep the reasoning)
- Test: `test/jira-config-write.test.ts` (new); `test/jira-config.test.ts` stays as is

**Interfaces:**
- Produces: `class JiraConfigUnreadableError extends Error { readonly file: string }` (message: `settings/jira.json <reason> — fix or delete it by hand;
  nothing was written`); `parseBoardWrite(body: unknown): { ok: true; value: JiraBoardWrite } | { ok: false; error: string }` where `JiraBoardWrite = { id:
  string | null; name; roots: string[]; queries: { id: string | null; label; jql }[]; interval: SyncInterval }` (trimmed, deduped roots);
  `parseReposWrite(body: unknown, home: string): { ok: true; value: { project: string; paths: string[] } } | { ok: false; error: string }`;
  `normaliseRepoPath(raw: string, home: string): string | null` (R4; `null` = refused); `writeBoard(input: JiraBoardWrite, file?): JiraBoard` (throws
  `JiraConfigUnreadableError`, or `JiraUnknownIdError` for an update naming an id the read config does not hold); `deleteBoard(id: string, file?): void`
  (same two errors); `writeRepos(project: string, paths: string[], file?): void`; `mintJiraId(kind: 'b' | 'q' | 's'): string`.

- [ ] **Step 1: Write the failing tests** — `test/jira-config-write.test.ts`, each on a temp `BM_JIRA_FILE`:
  - `parseBoardWrite`: a valid body round-trips trimmed (`'  Payments  '` → `'Payments'`); each of these is `ok: false` and the error names the field —
    `name` `''`/`'   '`/81 chars; `interval` `'2m'`/missing; 21 roots; a root `'pay-1'`; 11 queries; a query label `''`/81 chars; a jql `''`/2 001 chars; no
    roots AND no queries; a non-object body (`null`, `[]`, `'x'`). `['PAY-1', 'PAY-1']` reads as one root. A body with `id: 'b_0000000z'` is `ok` with `id`
    kept as given — whether it exists is `writeBoard`'s question, and a malformed id on an update is the 404 the route gives; `id: 7` or `id: {}` is `ok: false` naming `id` (R11).
  - `writeBoard` create: no file → the file now holds exactly one board whose id matches `/^b_[0-9a-f]{8}$/`, each query a fresh `q_` id; the returned board
    equals `readJiraConfig().boards[0]`. A create whose body carried `id: null` and query ids `['q_deadbeef']` mints new ones for both (R3: no stored board
    holds them).
  - `writeBoard` update: a stored board with queries `q_aaaaaaaa` (`A`) and `q_bbbbbbbb` (`B`); an update sending `[{ id: 'q_bbbbbbbb', label: 'B2' }, { id:
    null, label: 'C' }, { id: 'q_cccccccc', label: 'D' }]` stores `q_bbbbbbbb` with label `B2`, a new id for `C`, a NEW id for `D` (not `q_cccccccc`), and
    no `A`. The board's position in `boards` is unchanged.
  - preservation: a file holding `{ "boards": [<valid b1>, { "id": 7 }, <valid b2>], "repos": {...}, "skills": [...], "note": "mine" }` — updating `b2`
    leaves `{ "id": 7 }`, `repos`, `skills` and `"note"` byte-equal in the parsed result, and the order `b1, {id:7}, b2`. `"boards": {}` (an object) on a
    create becomes `[newBoard]` and the other keys survive.
  - unknown id: an update naming `b_12345678` that the file does not hold throws `JiraUnknownIdError`; the file is byte-identical afterwards. So does
    `deleteBoard('b_12345678')`.
  - unreadable: a file holding `{ "boards": [` → every writer throws `JiraConfigUnreadableError` and the file is byte-identical; a path that is a directory →
    the same. A parsed non-object (`[1,2]`) → replaced by a file holding only the written entry.
  - atomic: after a write the directory holds no `*.tmp` file; a write into a missing `settings/` directory creates it.
  - `deleteBoard`: removes every raw entry whose `id` equals the id (a duplicate hand-edited twice goes too), keeps the rest in order.
  - `normaliseRepoPath` with `home = '/Users/ada'`: `'~'` → `'/Users/ada'`; `'~/x/'` → `'/Users/ada/x'`; `'  /a/b/  '` → `'/a/b'`; `'/'` → `'/'`; `'/a//b'`,
    `'/a/./b'`, `'/a/../b'`, `'x/y'`, `'~bob/x'`, `''` → `null`.
  - `parseReposWrite`: `{ project: 'PAY', paths: ['/a/b', '/a/b/', '~/c'] }` → `['/a/b', '/Users/ada/c']`; `project: 'pay'`/`'P'`/`'PAY-1'` → error naming
    `project`; 11 distinct paths → error naming `paths`; a refused path → error `path must be absolute and normalised: <the raw path>`; `paths: []` is ok.
  - `writeRepos`: sets one key, leaves other keys (and a hand-written invalid key `"pay"`) untouched; `paths: []` removes the key; `"repos": []` (an array)
    becomes `{ PAY: [...] }`.
  - `mintJiraId('q')` matches `isJiraId('q', …)`; 1 000 mints are distinct.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/jira-config-write.test.ts` — FAIL (exports missing).
- [ ] **Step 3: Implement** on `writeSyncInterval`'s contract (Global Constraints). The parsers validate with the readers' own helpers (`isJiraKey`,
  `isSyncInterval`, `JIRA_PROJECT_KEY_RE`, `JIRA_JQL_MAX_CHARS`) and add only the write-time bounds. `mintJiraId` uses `crypto.randomBytes(4)`. A minted id
  that collides with one already in the file is minted again.
- [ ] **Step 4: Run** the new suite and `test/jira-config.test.ts` — PASS; `pnpm run typecheck`.
- [ ] **Step 5: Commit** — `feat(jira): jira.json writers — boards, delete, repos, on writeSyncInterval's contract`

### Task 2: The poller sweeps a saved board at once

**Files:**
- Modify: `server/src/jira/poller.service.ts`
- Test: `test/jira-poller.test.ts` (extend; its existing cases drive sweeps by `await poller.tick()` with real timers — the new `boardSaved` cases add
  `jest.useFakeTimers()` in their own `describe`, restored after each)

**Interfaces:**
- Consumes: `writeBoard`, `deleteBoard` (Task 1).
- Produces: `JiraPollerService.boardSaved(id: string): Promise<void>` — resolves when a sweep that includes this board has finished, or after
  `JIRA_SAVE_SWEEP_WAIT_MS`, whichever is first; never rejects. `JiraPollerService.boardDeleted(id: string): void` — drops the cache now. `status()` fills
  `armed` and `home` (R1). Exported `JIRA_SAVE_SWEEP_WAIT_MS = 20_000`.

- [ ] **Step 1: Write the failing tests:**
  - a `5m` board swept 10 s ago is NOT due; `boardSaved(id)` sweeps it now (one more `search/jql` call for it), its `polledAt` moves, and its next due time
    is 5 m from THIS sweep.
  - an `off` board already swept once: `boardSaved` sweeps it once more; the chain is not left armed for it afterwards (`armed === false` with no other board).
  - only the saved board is forced: a second `5m` board swept 10 s ago gets no call from that sweep.
  - a sweep in flight when `boardSaved` is called: the promise resolves only after a sweep that STARTED after the call has finished (the in-flight one read
    `jira.json` before the save).
  - the boot not answered (`myself` failing): `boardSaved` resolves (the sweep returns early, as `run()` does), `polledAt` stays `null`, the board stays owed.
  - inside a 429 window: resolves without a search call.
  - a sweep that takes longer than `JIRA_SAVE_SWEEP_WAIT_MS`: the client's own 10 s deadline (`JIRA_TIMEOUT_MS`) would abort one stalled call, so build it
    from several calls each held under 10 s and totalling over 20 s — `jest.spyOn(client, 'search')` returning promises the test resolves by hand (or a
    `delay` hook added to `test/helpers/jira.ts`'s fake). `boardSaved` resolves at 20 s of fake time, and once the test releases the remaining calls the
    sweep's answer still lands in the cache.
  - `boardDeleted(id)`: `boardIssues(id)` is `null` once the file no longer holds the board, and the cache map no longer holds the id.
  - `status().armed` follows `armed`; `status().home` is `homedir()` when configured and `null` when not.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/jira-poller.test.ts` — the new cases FAIL.
- [ ] **Step 3: Implement.** A `forced: Set<string>` that `due()` honours and the sweep clears per board as it sweeps it, and that `owed()` counts — not a
  reset of the cache's `polledAt`, which would empty the board's last good list (`coldOwed` reads `polledAt`). `boardSaved` adds the id, then: a sweep in
  flight → await it, then `tick()`; else clear the pending timer and `tick()`. Race the result against the cap with a `setTimeout` (fake-timer friendly, as
  the client's deadline is).
- [ ] **Step 4: Run** the suite — PASS; typecheck.
- [ ] **Step 5: Commit** — `feat(jira): a saved board is swept at once and its due time reset`

### Task 3: The three write routes

**Files:**
- Create: `server/src/jira/jira-write.controller.ts`
- Modify: `server/src/jira/jira.module.ts` (controllers list; the header's "phase 2's write routes" sentence becomes present tense)
- Modify: `test/jira-routes.test.ts` (the `POST /api/jira/boards is 404` case is DELETED — it pinned phase 1's absence; `GET /api/jira/prompt is 404` stays)
- Modify: `.claude/rules/jira.md` (the jira.json bullet: "Phase 1 has NO write path…" becomes the writers' mechanism — `writeBoard`/`deleteBoard`/`writeRepos`,
  merge-one-entry, temp-plus-rename, `JiraConfigUnreadableError` → 409, `boardSaved` → R2's bounded wait); `docs/subsystems/invariants.md`'s matching section
  (the reasoning for refusing rather than replacing, restated for three writers — #270's story is the precedent, cite it)
- Test: `test/jira-write-routes.test.ts` (new; supertest through `listenLoopback`, `JiraClient` overridden on `test/helpers/jira.ts`'s fake)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: `POST /api/jira/boards` → 200 `JiraBoard` (the stored board, ids minted); `POST /api/jira/boards/delete` `{ id }` → 200 `{ ok: true }`;
  `POST /api/jira/repos` `{ project, paths }` → 200 `{ project, paths }` (as stored). All `@HttpCode(200)`.

- [ ] **Step 1: Write the failing tests:**
  - guard: no content type → 403; `Origin: http://evil.test` → 403; a disallowed `Host` → the allowlist's refusal (whatever `test/jira-routes.test.ts` already
    asserts for reads).
  - order: an unconfigured server with a malformed body → 400 (not 503); with a valid body → 503 `Jira is not configured`, and no file is created.
  - `boards` create → 200, the body's `id` matches `b_…`, `GET /api/jira`'s `boards` lists it, and the fake Jira saw the board's search before the answer came
    (R2). An `interval: 'off'` board likewise has a `polledAt` in `GET /api/jira` right after the 200.
  - `boards` update of an unknown well-formed id → 404 `unknown board`; of a malformed id (`'x'`) → 404 `unknown board` too (the read routes' rule).
  - `boards` with `name: ''` → 400 whose `error` names `name`.
  - review focus 1: the fake's `myself` failing (boot unanswered) → create answers 200 and `GET /api/jira` shows the board with `polledAt: null`.
  - `boards/delete` → 200; a second delete of the same id → 404; `{}` → 400 naming `id`.
  - `repos` with `~/x/` → 200 `{ project: 'PAY', paths: ['<home>/x'] }`; `paths: []` → 200 and `GET /api/jira`'s `repos` has no `PAY`.
  - review focus 2: a `jira.json` holding `{ "boards": [` → every POST answers 409 whose `error` contains `jira.json` and `nothing was written`, and the file is
    byte-identical afterwards.
  - under `access: unauthorized` (the fake answering 401 to `myself`) → `boards` create still 200 (§8: config writes stay open).
- [ ] **Step 2: Run** the new suite and `test/jira-routes.test.ts` — FAIL.
- [ ] **Step 3: Implement.** `@UseGuards(SameOriginPostGuard)` per route (imported from `agents/origin.guard.ts`, as `tracker-sync.controller.ts` does).
  `JiraConfigUnreadableError` → 409 with its message; `JiraUnknownIdError` → 404 `unknown board`; any other throw is Nest's 500. After a board write: `await
  this.poller.boardSaved(id)`; after a delete: `this.poller.boardDeleted(id)` then `this.poller.arm()`; after repos: nothing (no sweep reads repos).
- [ ] **Step 4: Run** both suites and `test/claude-rules.test.ts` — PASS; typecheck.
- [ ] **Step 5: Commit** — `feat(jira): POST boards, boards/delete and repos, guarded`

### Task 4: The three hoists and the widened column slug

Pure moves: no behaviour changes, every existing suite stays green.

**Files:**
- Create: `client/src/components/ui/Fact.tsx` (from `ItemModal.tsx:190`), `client/src/lib/markdown.ts` (the `marked.use({...})` config, `escapeHtml`, the
  scheme allowlists and `classifyTarget`/`isAllowedTarget`, exported as `renderMarkdown(source: string): string`)
- Move: `client/src/components/settings/SettingsRow.tsx` → `client/src/components/ui/SettingsRow.tsx` (`git mv`; names kept); update its importers
  (`SettingsView`, `TrackersGroup`, `WatchdogGroup`) and the import-path regex in `test/settings-view.test.tsx` (~line 661)
- Modify: `client/src/components/board/ItemModal.tsx` (imports both hoists); `client/src/components/board/BoardColumn.tsx` (`BoardColumnSlug` gains `'todo'
  | 'doing' | 'done'`, drawn with a plain `Dot` and no ramp — `RAMP_SLUGS` stays the four); `client/src/styles.css` (`.board-col-todo|doing|done` if the
  column's look needs per-slug rules)

**Interfaces:**
- Produces: `Fact({ label, children })`; `renderMarkdown(source: string): string` (sanitised HTML; the ONE `marked` config — `marked.use` runs once, at module
  load of `lib/markdown.ts`); `SettingsGroup`, `SettingsRow` at the new path; `BoardColumnSlug` widened.

- [ ] **Step 1:** `grep -rl "settings/SettingsRow\|ItemModal" test client/src` — the suites to run.
- [ ] **Step 2: Move**, then add one case to the suite that covers `ItemModal`'s Markdown (find it with the grep): `renderMarkdown('[x](javascript:alert(1))')`
  renders no `javascript:` href — the hoist kept the sanitiser. And one to `test/board-column*` (or wherever `BoardColumn` is tested): a `todo` column renders
  its label and count and no ramp element.
- [ ] **Step 3: Run** every suite from Step 1, `test/design-guards.test.ts` and `test/ui-modal.test.tsx` — PASS; typecheck.
- [ ] **Step 4: Commit** — `refactor(client): hoist Fact, the Markdown renderer and SettingsRow to shared homes`

### Task 5: `lib/jira.ts`, the page key and its store

**Files:**
- Create: `client/src/lib/jira.ts`, `client/src/lib/jira-page.ts`, `client/src/hooks/useJiraPage.ts`
- Test: `test/jira-lib.test.ts` (new, pure; jsdom only for the store)

**Interfaces:**
- Produces (`lib/jira-page.ts`): `type JiraPage = 'board' | 'setup'`, `JIRA_PAGES`, `JIRA_PAGE_KEY = 'backlog-manager.jira-page'`, `isJiraPage(v: unknown)`.
  (`hooks/useJiraPage.ts`): `useJiraPage(): [JiraPage, (p: JiraPage) => void]`, `setJiraPage(p)` — `useRunsMode`'s shape, `'board'` the fallback.
- Produces (`lib/jira.ts`), every one pure:
  - `JIRA_COLUMNS: { slug: 'todo' | 'doing' | 'done'; label: string; category: JiraStatusCategory }[]` — `To Do`/`new`, `In Progress`/`indeterminate`,
    `Done`/`done`; `columnOf(issue): 'todo' | 'doing' | 'done'`.
  - `sortForBoard(issues): JiraIssue[]` — `updated` descending, ties by key ascending; never mutates.
  - `cardAgeStamp(issue): string` — `resolved` for a `done` issue that has one, else `updated` (formatted by `formatCreated` in `lib/item-age.ts`).
  - `crumbOf(issue, board: JiraBoard, me): { kind: 'root' } | { kind: 'parent'; key; summary } | { kind: 'mine' } | null` — precedence `root` (the key is one
    of `board.roots`) → `parent` → `mine` (assignee is `me.accountId`) → `null`.
  - `bandSub(board: JiraBoardStatus, site: string, now: number): { text: string; failing: boolean }`.
  - `boardRowLine(board: JiraBoardStatus, now: number): { text: string; failing: boolean }` — Setup's row.
  - `initialsOf(name: string): string` — first letter of the first two words, upper-cased; `''` → `'?'`.
  - `callsReading(calls, now): { fraction: number; red: boolean }` — `min(sweep / JIRA_SWEEP_CALL_CEILING, 1)`; red while `now − last429At < JIRA_429_RED_MS`.
  - `soonestBoard(boards, now): JiraBoardStatus | null` — the syncing board (interval not `off`) whose next poll is soonest; `null` when none syncs.
  - `pickBoard(storedId: unknown, boards): JiraBoardStatus | null` — the stored one when present, else the first by name (`localeCompare`), else `null`.
  - `boardsForSetup(boards): JiraBoardStatus[]` — by name, `off` boards last.
  - `unmappedProjects(status): { key; name }[]` — `status.projects` whose key has no `repos` entry.
  - `displayPath(path: string, home: string | null): string` — `home` prefix (at a segment boundary) → `~`.
  - `JIRA_QUERY_PRESETS` (R5), `JIRA_SWEEP_CALL_CEILING`, `JIRA_429_RED_MS`, `JIRA_BOARD_FILTER_FROM`.
  - `isJiraStatusPayload(v: unknown): v is JiraStatusPayload` — the shape guard `useJira` reads through (as `isTrackersPayload` is).

- [ ] **Step 1: Write the failing tests:**
  - `columnOf`: `new` → `todo`, `indeterminate` → `doing`, `done` → `done`.
  - `sortForBoard`: three issues with `updated` of 3 d, 1 h, 2 d ago → 1 h, 2 d, 3 d; equal stamps `PAY-10`, `PAY-2` → `PAY-10` before `PAY-2` (string order),
    and the input array is unchanged.
  - `cardAgeStamp`: a done issue with `resolved` → `resolved`; a done issue with `resolved: null` → `updated`; an `indeterminate` issue with a stale
    `resolved` → `updated`.
  - `crumbOf` on a board with root `PAY-1`: `PAY-1` itself (with a parent `PAY-0`) → `root`; `PAY-2` with parent `PAY-1` assigned to me → `parent`; `PAY-3`
    with no parent assigned to me → `mine`; `PAY-4` with neither → `null`; `me: null` never yields `mine`.
  - `bandSub` (site `acme.atlassian.net`): 14 issues, 2 roots, 1 query, polled 12 s ago → `acme.atlassian.net · 14 issues from 2 roots and 1 query · polled 12 s
    ago`; 0 roots, 2 queries → `… from 2 queries …` (zero omitted, plural); `1 issue` singular; `polledAt: null` → `… · not polled yet` (R8); `truncated` →
    the text ends `· first 500 shown`; a `failures` entry → `failing: true` and the text names Jira's message (first failure; `+N more` when several).
  - `boardRowLine`: `1m` board → `2 roots · 1 query · 14 issues · every 1m · polled 12 s ago`; `off` → `… · sync off · last polled 12 s ago`; zero counts omitted.
  - `initialsOf('Ada Lovelace')` → `AL`; `'ada'` → `A`; `'Jean-Luc Picard Jr'` → `JP`; `''` → `?`.
  - `callsReading`: 40 calls → 0.4; 140 → 1; `last429At` 10 min ago → red; 16 min ago → not red; `null` → not red.
  - `soonestBoard`: a `5m` board polled 1 m ago and a `1m` board polled 30 s ago → the `1m` one; only `off` boards → `null`; a syncing board with `polledAt:
    null` is the soonest of all.
  - `pickBoard`: stored id present → it; stored id absent (deleted) → first by name (`Alpha` before `beta` — case-insensitive); stored value `42` or `null` →
    first by name; no boards → `null`.
  - `boardsForSetup`: `Zed (1m)`, `alpha (off)`, `Beta (5m)` → `Beta`, `Zed`, `alpha`.
  - `unmappedProjects`: projects `PAY`, `OPS`; repos `{ PAY: [...] }` → `[OPS]`.
  - `displayPath('/Users/ada/x', '/Users/ada')` → `~/x`; `('/Users/ada', '/Users/ada')` → `~`; `('/Users/adam/x', '/Users/ada')` → unchanged; `home: null` →
    unchanged.
  - `isJiraStatusPayload`: a full phase-2 payload → true; missing `boards` or `armed` → false; `null` → false.
  - `useJiraPage`: two hook instances; `setJiraPage('setup')` from one re-renders the other with `setup`; a stored `'banana'` reads `board`; the value is stored
    as JSON.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/jira-lib.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; typecheck.
- [ ] **Step 5: Commit** — `feat(jira): lib/jira derivations and the page store`

### Task 6: `useJira`, `JiraProvider`, `useJiraBoard`

**Files:**
- Create: `client/src/hooks/useJira.ts`, `client/src/hooks/JiraContext.tsx`, `client/src/hooks/useJiraBoard.ts`
- Test: `test/use-jira.test.tsx` (new; fake timers, mocked `fetch`)

**Interfaces:**
- Consumes: `isJiraStatusPayload`, `soonestBoard` (Task 5).
- Produces: `interface JiraState { data: JiraStatusPayload | null; loading: boolean; error: boolean; reload: () => void }`; `useJira(): JiraState`;
  `JiraProvider`, `useJiraContext(): JiraState` (`TrackersContext`'s shape, a LOADING default); `useJiraBoard(id: string | null, interval: SyncInterval |
  null): { issues: JiraIssue[]; polledAt: string | null; loading: boolean; error: boolean; reload: () => Promise<unknown> }`; `JIRA_STATUS_FLOOR_MS`.

- [ ] **Step 1: Write the failing tests:**
  - one fetch of `/api/jira` on mount; a window `focus` refetches at once and leaves exactly one pending timer.
  - the timer: one `1m` board polled 10 s ago → next fetch at 50 s (+ the same slack `useTrackers` uses); a `1m` board polled 55 s ago → at the 15 s floor;
    only `off` boards → no timer at all (advance 10 min, one fetch total); `configured: false` → no timer; a failed fetch → `error: true`, the previous `data`
    kept, retry at the floor.
  - only the newest read may write: two reloads whose fetches settle in reverse order → the state is the second's.
  - `useJiraBoard('b_1', '1m')` fetches `/api/jira/boards/b_1/issues` and again at `BOARD_TRACKER_POLL_MS`; with `interval: 'off'` it fetches once and never
    again; `id: null` fetches nothing; changing `id` fetches the new board at once; `reload()` fetches at once whatever the interval.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** `useJira` follows `useTrackers` (sequence counter, one timer, focus refetch) aimed at `soonestBoard`'s `polledAt +
  SYNC_INTERVALS[interval] + slack`, floored at `JIRA_STATUS_FLOOR_MS`. `useJiraBoard` is `useCoalescedFetch` armed while `id !== null && interval !== 'off'`.
- [ ] **Step 4: Run** — PASS; typecheck.
- [ ] **Step 5: Commit** — `feat(jira): the status hook on the boards' clock, its provider, and the board hook`

### Task 7: The section, its tree, and the shell's hold-and-fall

**Files:**
- Modify: `client/src/lib/sections.ts` (`jira` between `archive` and `settings`; the header's "four strings" note follows), `client/src/components/SideRail.tsx`
  (`RAIL_LABEL.jira = 'Jira'`, an icon in `ICON_PATHS`, a `RailTree` over `JIRA_PAGES` with labels `Board`/`Setup` in their own `Record`, the entry skipped
  unless `useJiraContext().data?.configured === true` — while `data` is `null` (unknown) the entry IS drawn when the current section is `jira`, so the held
  section has a row), `client/src/App.tsx` (`JiraProvider` beside `TrackersProvider`; the lazy `JiraView`; `onOpenJiraPage`; the fall), `client/src/lib/settings.ts`
  and `client/src/components/settings/SettingsView.tsx` (`Opens on: Jira` offered only while configured)
- Create: `client/src/components/jira/JiraView.tsx` (renders `JiraBoardView` or `JiraSetupView` by `useJiraPage()`; until Tasks 8 and 10 land, each page may
  be a placeholder that Tasks 8/10 replace — the placeholder must not ship past Task 10)
- Modify: `.claude/DESIGN.md` — §8.9's four headings as one-line stubs, so the citations from this task on resolve; Task 13 fills them
- Test: `test/jira-sections.test.tsx` (new)

**Interfaces:**
- Consumes: Tasks 5–6.
- Produces: `JiraView({ onOpenJiraPage }: { onOpenJiraPage: (p: JiraPage) => void })` — default export, lazy; `onOpenJiraPage(p)` in `App` is `setJiraPage(p)`
  then `change('jira')`, the `onOpenWatchdog` pair's shape.

- [ ] **Step 1: Write the failing tests** (render `App`, mock `fetch` per URL):
  - `configured: false` → no `Jira` rail link; `configured: true` → a `Jira` link between `Archive` and `Settings`.
  - with the section `jira` current, the tree shows `Board` and `Setup`; clicking `Setup` renders the Setup page and stores `"setup"` under
    `backlog-manager.jira-page`; no element inside the Jira page switches pages (assert no button named `Board`/`Setup` inside `main`).
  - stored section `jira` + `GET /api/jira` → `configured: false` → the Board section renders and `backlog-manager.section` reads `board`.
  - review focus 5: stored section `jira` + `GET /api/jira` failing (500, then network error) → the shell stays on Jira and shows the Board's unavailable
    shape; a later answer `configured: false` (advance to the floor) moves it to `board`.
  - stored section `jira` while the status has not answered yet → the shell renders the Jira section's loading state, not the Board.
  - Settings › Local › `Opens on` lists `Jira` only while configured; `landing: 'jira'` stored on a machine whose status says `configured: false` opens on
    `board`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** `resolveSection` already accepts any member of `SECTIONS`; the fall lives in `AppShell` as an effect on `useJiraContext().data`,
  calling `change('board')` only on the transition into `configured: false` while the section is `jira`.
- Modify: `test/nav.test.tsx` (~line 388 pins `SECTIONS` to the four names — it becomes the five, `jira` between `archive` and `settings`)
- [ ] **Step 4: Run** this suite plus `test/nav.test.tsx`, `test/section-boundary.test.tsx`, `test/settings-view.test.tsx` and every suite that renders `SideRail` (`grep -rl
  SideRail test`) — PASS; typecheck.
- [ ] **Step 5: Commit** — `feat(jira): the Jira rail section and its Board/Setup tree`

### Task 8: Jira › Board

**Files:**
- Create: `client/src/components/jira/JiraBoardView.tsx`, `client/src/components/jira/JiraCard.tsx`
- Modify: `client/src/components/jira/JiraView.tsx`, `client/src/styles.css`
- Test: `test/jira-board.test.tsx` (new; the style of `test/tracker-board.test.tsx`)

**Interfaces:**
- Consumes: `pickBoard`, `bandSub`, `columnOf`, `sortForBoard`, `crumbOf`, `cardAgeStamp`, `initialsOf`, `JIRA_COLUMNS` (5); `useJiraContext`,
  `useJiraBoard` (6); `onOpenJiraPage` (7); `BoardColumn`, `Band`, `FilterBar`/`FilterSection`, `Chip`, `Popover`.
- Produces: `JiraCard({ issue, board, me, onOpen })`; `JiraBoardView({ onOpenJiraPage, onOpenIssue })` where `onOpenIssue(issue)` opens Task 9's modal (this
  task wires it to a state slot the modal fills).

Behaviour (§6.2): Band title = board name, sub = `bandSub` (red while `failing`); the right slot holds the picker — a `Chip` reading the board name that opens
a `Popover` listing every board by name, picking one sets `backlog-manager.jira-board` and does nothing else — and the summary search (case-insensitive
substring over key and summary). `FilterBar` with three sections: type (the distinct `type.name`s of the loaded list), assignee (`anyone` / `me` /
`unassigned`; `me` absent while `me` is null), sprint (the distinct sprint names, plus `no sprint` when some issue has none). Three `BoardColumn`s from
`JIRA_COLUMNS`, each `sortForBoard`ed. A card: type name as its icon's title, key, crumb (`root`, `↳ PAY-120 Refund flows`, `Assigned to me`), summary,
initials + assignee name (or `unassigned`), the RAW status name as a pill, the age; a marker row with priority and `N subtasks` (`1 subtask`, nothing at
zero). Clicking a card calls `onOpenIssue`. No Run ▾ and no live strip (phase 5). Empty states: no boards → `No boards yet` with a chip whose click is
`onOpenJiraPage('setup')`; `configUnreadable` → `jira.json cannot be read — <reason>` in the same slot and no picker; a board with no issues → three empty
columns. Below 700 px the columns stack as the Board's do.

- [ ] **Step 1: Write the failing tests:**
  - a two-board payload, stored pick = the second → its issues are fetched and only `/boards/<second>/issues` is requested.
  - review focus 3: stored pick `b_deadbeef` (no such board) → the first board by name is shown and NO request names `b_deadbeef`; stored pick `{"x":1}` →
    the same.
  - picking another board in the picker's popover stores it and fetches its list; the popover holds board names and nothing else (no `Edit`, no `New`).
  - Band sub reads exactly `bandSub`'s text for the fixture; a failing board's sub carries the failing class.
  - three columns with counts; a `done` issue lands in Done; order within a column follows `updated` descending.
  - card face for a fixture issue: key, `↳ PAY-120 Refund flows`, summary, `AL Ada Lovelace`, the status pill `In Review` (raw name), `2 subtasks`, priority
    `High`; an issue with `subtasks: 1` reads `1 subtask`; `0` draws no subtasks marker; no `<img>` anywhere on the page.
  - filters: assignee `me` hides others' cards; `unassigned` shows only `assignee: null`; type and sprint narrow likewise; the search `refund` matches on
    summary, `pay-12` on key; clearing restores all. Nothing is written to localStorage by a filter or the search.
  - `boards: []` → `No boards yet`; clicking its chip opens Setup (the page store reads `setup`).
  - review focus 2: `configUnreadable: 'does not parse as JSON'` → `jira.json cannot be read — does not parse as JSON`, and NOT `No boards yet`.
  - clicking a card calls `onOpenIssue` with that issue.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**, composing the existing card classes (`.board-card`, `.board-card-face`) and adding only the head/crumb/foot rows' rules.
- [ ] **Step 4: Run** this suite, `test/design-guards.test.ts`, `test/tracker-board.test.tsx` — PASS; typecheck.
- [ ] **Step 5: Commit** — `feat(jira): the Board page — band, picker, filters, three columns, cards`

### Task 9: The read-only issue modal

**Files:**
- Create: `client/src/components/jira/JiraIssueModal.tsx`
- Modify: `client/src/components/jira/JiraBoardView.tsx` (opens it), `test/ui-modal.test.tsx` (the composer list becomes `[board/ItemModal.tsx,
  jira/JiraIssueModal.tsx]`, the test name says two files, and the "no run modal" case stays)
- Test: `test/jira-modal.test.tsx` (new)

**Interfaces:**
- Consumes: `Modal`, `Fact`, `renderMarkdown` (4); `displayPath` (5); `useJiraContext` (6).
- Produces: `JiraIssueModal({ issue, onClose }: { issue: JiraIssue; onClose: () => void })` — fetches `GET /api/jira/issue/:key` on open.

Behaviour (§6.3 minus R7): facts — key with `open in Jira ↗` (`issue.url`), type · parent, status with its category, priority · sprint, assignee · reporter,
labels, created · updated, on boards (names, from `detail.boards` against the status's boards), repository (the mapped paths through `displayPath`, or the hint
`no repository mapped for <KEY> — Jira › Setup › Repositories`). Body: the description through `renderMarkdown`, a Subtasks list of `detail.children` (key,
summary, raw status), and the line `Comments stay in Jira — v1 neither reads nor writes them` with the link. While the detail loads, the facts come from the
card's own `issue`; a failed read leaves those facts and shows `could not read the ticket — <server error>` where the body would be.

- [ ] **Step 1: Write the failing tests:**
  - opening fetches `/api/jira/issue/PAY-131` once; the facts render the fixture's values; the `open in Jira ↗` link's `href` is the issue's `url` with
    `target="_blank"` and `rel` containing `noreferrer`.
  - a description with `**bold**` renders `<strong>`; one with `[x](javascript:alert(1))` renders no `javascript:` href.
  - `children` render as a list with their raw status names; none → no Subtasks heading.
  - repository: `repos: { PAY: ['/Users/ada/pay'] }`, `home: '/Users/ada'` → `~/pay`; no mapping → the hint text.
  - a 502 `{ error: 'Jira unreachable: timeout' }` → the card's facts still drawn and `could not read the ticket — Jira unreachable: timeout`.
  - R7: no button named `Assign to me`, `Move to`, `Run`, or `Stop session`.
  - Escape closes it (the `Modal` shell owns the key).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** this suite, `test/ui-modal.test.tsx`, `test/dialog-escape.test.tsx` — PASS; typecheck.
- [ ] **Step 5: Commit** — `feat(jira): the read-only issue modal`

### Task 10: Jira › Setup — the Boards card and the board sheet

**Files:**
- Create: `client/src/components/jira/JiraSetupView.tsx` (two hand-balanced columns of cards, Settings' shape, stacking below 700 px; Boards first),
  `client/src/components/jira/JiraBoardSheet.tsx`
- Modify: `client/src/components/jira/JiraView.tsx`, `client/src/styles.css`
- Test: `test/jira-setup.test.tsx` (new; this task's cases, Task 11 appends)
- `JiraSetupView` owns the ONE `/api/jira/projects` fetch per mount and hands the list to the sheet and to Task 11's Repositories card — neither fetches
  it itself.

**Interfaces:**
- Consumes: `boardsForSetup`, `boardRowLine`, `JIRA_QUERY_PRESETS`, `JIRA_BOARD_FILTER_FROM` (5); `useJiraContext` (6); `onOpenJiraPage` (7);
  `SettingsGroup`/`SettingsRow` (4); `FormSheet`, `Segmented`, `Popover`, `Confirm`, `Select`, `Chip`.
- Produces: `JiraSetupView({ onOpenJiraPage })`; `JiraBoardSheet({ board, onClose, onSaved })` (`board: null` → new).

Behaviour (§6.4): Boards card — a `New board` chip in the head; rows from `boardsForSetup`, each name + `boardRowLine` (red when failing) + `Open board`
(stores the pick, then `onOpenJiraPage('board')`) + `Edit`; a filter field above the rows from the sixth board on (substring on name). The sheet
(`FormSheet`) has three sections: **Name & sync** (name `.set-text`, interval `Segmented` over `SYNC_INTERVALS`, default `1m`); **Roots** (rows with ×; a
search field whose `Popover` lists `/api/jira/search?q=` results — key + summary — and a pick adds the key; a search error shows under the field);
**Queries** (preset chips per R5 plus `+ Custom JQL`; a row is label `.set-text` + JQL `.sheet-prompt` textarea + the check line from
`/api/jira/jql/check`, debounced `JIRA_JQL_CHECK_DEBOUNCE_MS`: `4 issues match · checked 3 s ago`, or Jira's parse message in red); footer `Delete board`
(edit only, through `Confirm`) / `Cancel` / `Save` — `Create board` for a new one, disabled until a non-blank name and at least one root or query. Save
POSTs the board (query rows carry their stored ids, R3), and on 200 calls `useJiraContext().reload()` and closes; on a 4xx/5xx the sheet stays open with
every edit intact and the server's `error` under the footer. Delete POSTs `boards/delete` and, on 200, reloads and closes.

- [ ] **Step 1: Write the failing tests:**
  - rows sort per `boardsForSetup`; each reads its `boardRowLine`; `Open board` stores the pick and switches the page store to `board`.
  - five boards → no filter field; six → a filter field, and typing narrows the rows.
  - `New board` opens the sheet titled for a new board, interval `1m` selected, `Create board` disabled; typing a name alone keeps it disabled; adding a
    root through the search (mock `/api/jira/search?q=pay` → `[PAY-1]`, pick it) enables it.
  - the search request carries the field's text URL-encoded; an empty field sends nothing.
  - `+ Assigned to me` adds a row whose label is `Assigned to me` and whose JQL is R5's text; `+ Unresolved in a project…` reveals a project `Select`
    (from `/api/jira/projects`) and picking `PAY` adds `Unresolved in PAY` / `project = "PAY" AND resolution = Unresolved`.
  - the check line: typing JQL fires ONE `/api/jira/jql/check` request 500 ms after the last keystroke (fake timers; three keystrokes 100 ms apart → one
    request); `{ ok: true, count: 4 }` → `4 issues match · checked 0 s ago`; `{ ok: false, message: "Field 'sprnt' does not exist" }` → that message in red.
  - Save of an edited board POSTs `/api/jira/boards` with `content-type: application/json`, the stored board's `id`, and the stored query ids on the rows
    that came from it (a preset row added in this edit has `id: null`).
  - review focus 2: Save answering 409 `{ error: 'settings/jira.json does not parse as JSON — fix or delete it by hand; nothing was written' }` → the sheet
    stays open, the name field still holds the edit, and the message is shown.
  - `Delete board` → `Confirm` → accept POSTs `boards/delete` with the id; dismiss POSTs nothing.
  - Escape with the sheet open closes the sheet only (the page stays on Setup).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** this suite, `test/dialog-escape.test.tsx`, `test/ui-form-sheet.test.tsx`, `test/design-guards.test.ts` — PASS; typecheck.
- [ ] **Step 5: Commit** — `feat(jira): the Setup page's Boards card and the board sheet`

### Task 11: Jira › Setup — Repositories and Connection

**Files:**
- Create: `client/src/components/jira/JiraReposGroup.tsx`, `client/src/components/jira/JiraConnectionGroup.tsx`
- Modify: `client/src/components/jira/JiraSetupView.tsx`
- Test: `test/jira-setup.test.tsx` (append)

**Interfaces:**
- Consumes: `unmappedProjects`, `displayPath` (5); `useJiraContext` (6).

Behaviour (§6.4): **Repositories** — one row per mapped path (`PAY · Payments`, the path through `displayPath`, ×), a warning row per `unmappedProjects`
entry (`no repository yet — <KEY> cards cannot Start until a path is mapped`), and an add row: project `Select` over `/api/jira/projects` (fetched when the
Setup page mounts — never on a poll), a path `.set-text`, `Add`. × and Add POST `/api/jira/repos` with the project's WHOLE new list (§5 "replaces one
project's list"); a refusal shows the server's `error` under the add row and keeps the typed path. The hint: `a path the dashboard cannot see is refused at
dispatch, not here`. **Connection** — read-only rows: site; signed in as `me.name` (never an email) or `no identity`; token kind `classic`/`scoped` with the
hint naming `read:jira-work`, `write:jira-work`, `read:jira-user`; last sweep — `every 15 s` while `armed`, `idle` otherwise, then `· N calls` and `· last 429
<age>` or `· no 429 since start`; and the line `restart the server to change it`.

- [ ] **Step 1: Write the failing tests:**
  - repos `{ PAY: ['/Users/ada/pay', '/Users/ada/pay-2'] }`, home `/Users/ada` → two rows reading `~/pay`, `~/pay-2`; × on the second POSTs `{ project: 'PAY',
    paths: ['/Users/ada/pay'] }`.
  - projects `PAY`, `OPS` with only `PAY` mapped → the `OPS` warning row.
  - Add with `OPS` and `~/ops` POSTs `{ project: 'OPS', paths: ['~/ops'] }` (the SERVER expands), then reloads the status; a 400 `path must be absolute and
    normalised: x/y` shows that text and the field still holds `x/y`.
  - `/api/jira/projects` is fetched once per Setup mount, and not again when the status reloads.
  - Connection: `me: { name: 'Ada Lovelace' }`, `tokenKind: 'scoped'`, `armed: true`, `calls: { sweep: 12, last429At: null }` → `Ada Lovelace`, `scoped` with the
    three scopes named, `every 15 s · 12 calls · no 429 since start`; `armed: false` → `idle · …`; `me: null` → `no identity`. No element contains `@`
    (no email) for a fixture whose payload has none.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite — PASS; typecheck.
- [ ] **Step 5: Commit** — `feat(jira): the Setup page's Repositories and Connection cards`

### Task 12: The shell chip and the Trackers row

**Files:**
- Create: `client/src/components/JiraChip.tsx`
- Modify: `client/src/App.tsx` (the chip beside `TrackerChip` in both homes — the strip and the rail bar's `chipSlot` — drawn only while configured; still
  one element per home, never two hidden by CSS), `client/src/components/settings/TrackersGroup.tsx`, `client/src/styles.css`
- Test: `test/jira-chip.test.tsx` (new), `test/settings-trackers.test.tsx` (extend)

**Interfaces:**
- Consumes: `soonestBoard`, `callsReading`, `initialsOf` (5); `pollProgress` (`lib/tracker.ts`); `useJiraContext` (6); `Meter`, `Popover`, `Chevron`.

Behaviour (§6.5): on the `.tracker-chip*` classes — one initial (R10), `Jira · <first name>`, a POLL meter from `pollProgress(soonest.polledAt,
now, SYNC_INTERVALS[soonest.interval])` (empty with no syncing board), a CALLS meter from `callsReading` (red while red), and a red pip while `access` is not
`ok`. Its `Popover` is a reading only — site, one line per board (name · `polled <age>` or `not polled yet` · its failure), calls, last 429 — with no link
and no button. Settings › Shared › Trackers gains one read-only row after the GitHub rows while configured: `<site> · N boards · intervals live on Jira ›
Setup` (`1 board` singular).

- [ ] **Step 1: Write the failing tests:**
  - unconfigured → no chip, no Trackers row; configured → one chip in the strip at desktop width and one in the rail bar below 700 px (never both).
  - the chip reads `A` and `Jira · Ada` for `me.name = 'Ada Lovelace'`; `me: null` → `?`.
  - `access: 'unauthorized'` → the red pip; `ok` → none.
  - CALLS: `sweep: 140` → the meter full; `last429At` 5 min ago → its red class.
  - the popover lists one line per board, a failing board's line carries Jira's message, and the popover contains no `<a>` and no `<button>`.
  - the Trackers row reads `acme.atlassian.net · 2 boards · intervals live on Jira › Setup`; one board → `1 board`; the row has no control.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** this suite, `test/settings-trackers.test.tsx`, `test/tracker-chip.test.tsx`, `test/dialog-escape.test.tsx` — PASS; typecheck.
- [ ] **Step 5: Commit** — `feat(jira): the shell chip and the Trackers row`

### Task 13: Docs, rules and the count guards

**Files:**
- Modify: `.claude/DESIGN.md` — new **§8.9 Jira** with §8.9.1 Board, §8.9.2 Issue modal, §8.9.3 Setup, §8.9.4 Chip and Trackers row (what each surface
  composes and why, at §8.3/§8.6's density; the spec's §1 overrides of the mocks restated where they are visual); §8.7: "the item modal, and the only modal
  anywhere in this app" and "composed by the one surface that needs opening and closing, the item, and not by two" become two composers (the item modal and
  the Jira issue modal), with the reason a second one is right now (it is the same sidecar reading, a ticket instead of an item, and it holds no run state);
  the sheet paragraph names `JiraBoardSheet` as `FormSheet`'s third composer; the dialog count reads **five**.
- Modify: `client/src/hooks/useDialogEscape.ts` (comment only): `Three of them now, not four` keeps its history and adds that phase 2 makes it five (the two
  Jira surfaces join through the `Modal`/`FormSheet` shells, by construction); the `Popover` composers become six (R6).
- Modify: `test/dialog-count-docs.test.ts` — three → five: the entry matches `all five dialogs`, names `ItemModal`, `LaunchSheet`, `OrchestrateSheet`,
  `JiraIssueModal`, `JiraBoardSheet`; the bullet matches `five dialogs`; the hook comment matches the new sentence; the `RunDrawer`/`never a dialog`
  assertions stay.
- Modify: `.claude/rules/board.md` — the Escape bullet's count and names; a NEW bullet with the §13 headline **The Jira section's two pages are switched by
  the rail's tree, or a link threaded down from it, never by an in-page control; the section is drawn only when `GET /api/jira` says configured.** (mechanism:
  `JIRA_PAGES`/`useJiraPage`, the rail's skip, `onOpenJiraPage`, the shell's hold-and-fall, the landing option) anchored to a new invariants section.
- Modify: `docs/subsystems/invariants.md` — the Escape section's count and names (the "mounts all three together" sentence says the suite proves the ranking
  on the Board's three and the Jira two join through the same shells); the new section-and-tree section (why: the Runs/Settings precedent, and why an
  unconfigured machine must not show an entry it cannot fill); the jira.json section already updated in Task 3.
- Modify: `CLAUDE.md` — the new headline under Invariants (byte-equal with the bullet's bold span) with its `Why:` link; the `client/src/` layout line names
  the Jira section (five lazy sections, the Jira chip and its two pages); the `server/src/` line's `jira/` mention gains its three write routes.
- Modify: `docs/subsystems/jira.md` — the writers, the three routes, `boardSaved`, R1's two fields, and a Client section (the provider, the hooks, the pages,
  the chip); `docs/subsystems/board.md` — the rail's fifth section and its tree, the `ui/` table gains `Fact` and `SettingsRow`, `lib/markdown.ts`.
- Test: `test/claude-rules.test.ts`, `test/dialog-count-docs.test.ts`.

- [ ] **Step 1:** Edit `test/dialog-count-docs.test.ts` first; run it — FAIL.
- [ ] **Step 2:** Write the docs above. Prose wraps at 160; rule bullets carry mechanism only, the reasoning goes to `invariants.md`.
- [ ] **Step 3: Run** `pnpm run test:jest -- test/claude-rules.test.ts test/dialog-count-docs.test.ts test/csp.test.ts` — PASS.
- [ ] **Step 4: Commit** — `docs(jira): the Jira section in DESIGN, rules, invariants and the subsystem docs`

---

## Self-review (run by the author before handing the plan over)

- **Spec coverage (§12 phase 2):** rail entry and tree — T7; `JiraProvider` — T6; Board page — T8; read-only modal with the `Fact` and `marked` hoists —
  T4, T9; Setup with the board sheet, Repositories and Connection — T10, T11; the boards and repos write routes and the `jira.json` writers — T1–T3; the
  chip and the Trackers row — T12; the section-and-tree rule — T13; DESIGN.md §8.9, §8.7's count and its two sentences, `board.md`'s Escape bullet,
  `invariants.md`'s Escape section and `test/dialog-count-docs.test.ts` three → five — T13. `SettingsRow` promotion — T4. `BoardColumnSlug` widening — T4.
  Skills routes and card, `jiraDefaultAction`, Run ▾, the session fact and strip, the modal's controls — deliberately absent (phases 3 and 5).
- **§11's suites for this phase:** `jira-config` (writers, as `jira-config-write`), `jira-routes` (writes, as `jira-write-routes`), `jira-poller` (save),
  `use-jira`, `jira-lib`, `jira-sections`, `jira-board`, `jira-modal`, `jira-setup` — all present; `jira-chip` added.
- **Names across tasks:** `boardSaved`/`boardDeleted` (T2 → T3); `parseBoardWrite`/`parseReposWrite`/`writeBoard`/`deleteBoard`/`writeRepos`/
  `JiraConfigUnreadableError`/`JiraUnknownIdError` (T1 → T3); `useJiraContext`, `useJiraBoard`, `useJiraPage`/`setJiraPage`, `onOpenJiraPage` (T5–T7 →
  T8–T12); `renderMarkdown`, `Fact`, `SettingsGroup`/`SettingsRow` (T4 → T9–T12).
- **Open for the reviewer:** R1 widens §4's payload; R2 makes a board save wait up to 20 s; R4's refusal of `.`/`..`/`//` is stricter than §5's wording.
