# Source Sections — Rail Reshape (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This plan states behaviour and exact test cases, never literal code** (the global CLAUDE.md overrides writing-plans' "code blocks required"). Signatures,
> values and edge cases are binding; bodies are the implementer's. Disagree with the plan where the code proves it wrong, and say so in the task's report.
> Size budgets anywhere in it are soft.

**Goal:** Replace the rail's root `Board` and `Archive` with per-source rows — `Files ▸ Board · Archive` and `GitHub ▸ Board · Archive · Settings` — beside the
unchanged `Jira`, move the `Trackers` card's pieces to GitHub › Settings and a new `Sources · this machine` card on Shared, and keep every stored section,
landing preference and deep link landing on a real page.

**Architecture:** One pure `lib/sources.ts` decides which source a project belongs to, which source rows are drawn, and where a provisional section settles.
One shell-level `ProjectsProvider` (beside `TrackersProvider`/`JiraProvider`) supplies the projects answer with the Jira-style unknown / present / absent
states. `BoardView` and `ArchiveView` take a `source` prop and filter to it; the rail draws the two new rows through the existing `RailTree`.

**Tech Stack:** React 18 + Vite client, NestJS server, jest (jsdom for `.tsx` suites), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-29-source-sections-design.md`. Plan B (`2026-10-29-source-sections-prs.md`, written after this one lands) adds
GitHub › PRs; this plan leaves the GitHub page list open to that one extra member.

## Global Constraints

- Rail order: `files`, `github`, `jira`, `runs`, `settings`; Archive is no longer a root section.
- Row labels `Files`, `GitHub`, `Jira`, `Runs`, `Settings`; tree labels `Board`, `Archive`, `Settings` (GitHub), `Board`, `Archive` (Files).
- A source's sub-pages are switched by the rail's tree alone, or by an `onOpen<Source>Page` pair built once in `App` and threaded down — never an in-page control.
- `ProjectSummary.source` → section: `github` → GitHub; `files`, `unsupported`, `null` → Files. Display grouping only; `ItemsService.writerFor` is untouched.
- New sync-off sentence, byte-exact: `sync is off for <repo> — turn it on in GitHub › Settings`.
- Every new component cites its `.claude/DESIGN.md` subsection in a header comment; derivations live in `client/src/lib/`, shared looks in `components/ui/`.
- Comments explain why, at the repo's existing density; new prose wraps at 160 columns.
- Headlines changed in CLAUDE.md are byte-equal in `docs/subsystems/invariants.md` and their `.claude/rules/*.md` bullet (`test/claude-rules.test.ts`).
- Run only the suites a task touches (`pnpm run test:jest -- <files>`); CI runs the full suite. `pnpm run typecheck` before each commit.

## Review Focus

1. **A machine with only files projects** and a stored `backlog-manager.section` of `board`: lands on Files › Board once projects answer; the GitHub row is
   never drawn, not even for one frame. → Task 4, test `legacy board settles on Files when no github project`.
2. **`GET /api/projects` fails at load** with a stored `github` section: the section is held (Board in its loading/unavailable shape), the GitHub row stays,
   nothing falls. → Task 4, test `unknown projects answer holds the stored source section`.
3. **The last GitHub project is unregistered while GitHub is on screen**: on that answer the row disappears and the shell falls to Files › Board (or Runs if
   no Files row) and records the fallen section. → Task 4, test `github row vanishing falls to the first drawn source`.
4. **An `unsupported` project's warning** shows on Files › Board and never on GitHub › Board. → Task 5, test `unreachable and index errors only on files`.
5. **A stored `Opens on` of `board` or `archive`** from before the change is kept as a pin (settled like a section), not dropped to `last`. → Task 3, test
   `legacy landing board/archive is kept`.

---

### Task 1: `lib/sources.ts` — source grouping, drawn rows, settling

**Files:**
- Create: `client/src/lib/sources.ts`
- Test: `test/sources-lib.test.ts`

**Interfaces:**
- Produces:
  - `type SourceSection = 'files' | 'github'`
  - `sourceSectionOf(source: ProjectSummary['source']): SourceSection`
  - `type DrawnSources = { files: boolean; github: boolean }`
  - `drawnSources(projects: readonly ProjectSummary[]): DrawnSources`
  - `firstDrawn(drawn: DrawnSources): Section` — `files` if drawn, else `github` if drawn, else `runs`
  - `settleSection(section: Section, drawn: DrawnSources): Section` — `section` itself unless it is a source section whose row is not drawn; then: a
    provisional `github` falls to `files` if drawn, else `firstDrawn`

- [ ] **Step 1: Write the failing tests** — `sourceSectionOf`: `github`→`github`; `files`, `unsupported`, `null` → `files`. `drawnSources`: `[]` →
  `{files:false, github:false}`; one `files` + one `github` → both true; one `unsupported` only → `{files:true, github:false}`. `firstDrawn`: both → `files`;
  github only → `github`; none → `runs`. `settleSection`: (`github`, github drawn) → `github`; (`github`, files only) → `files`; (`files`, github only) →
  `github`; (`files`, none) → `runs`; (`jira`, none) → `jira` (non-source sections pass through); (`settings`, none) → `settings`.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/sources-lib.test.ts` — FAIL, module not found.
- [ ] **Step 3: Implement** the five exports, pure, no React, importing nothing from `lib/sections.ts` (Task 3 changes it): `firstDrawn` returns
  `SourceSection | 'runs'`, and `settleSection` is generic — `settleSection<S extends string>(section: S, drawn): S | SourceSection | 'runs'` — touching only
  `files`/`github` values, so it types against today's union and Task 3's alike.
- [ ] **Step 4: Run** the suite — PASS. `pnpm run typecheck` — clean.
- [ ] **Step 5: Commit** `feat(client): derive source sections from project sources`.

### Task 2: `ProjectsProvider` — the shell's one projects answer

**Files:**
- Create: `client/src/hooks/ProjectsContext.tsx`
- Modify: `client/src/App.tsx` (wrap `AppShell` beside `TrackersProvider`/`JiraProvider`)
- Test: `test/projects-context.test.tsx`

**Interfaces:**
- Consumes: `drawnSources` (Task 1).
- Produces: `ProjectsProvider`, `useProjectsContext(): { data: ProjectSummary[] | null; drawn: DrawnSources | null; reload: () => void }` — `data`/`drawn`
  `null` while unknown (not answered, or every read so far failed); after a success, a later failure keeps the last answer (the `useJira` rule).

- [ ] **Step 1: Write the failing tests** — (a) before the fetch resolves, `data` and `drawn` are `null`; (b) a `200` with one `github` project →
  `drawn = {files:false, github:true}`; (c) a `500` first → still `null`; (d) success then a `500` on `reload()` → keeps the first answer; (e) a window
  `focus` event triggers exactly one re-read (use `useWindowFocus`); (f) two `reload()` calls while one read is in flight produce one follow-up, not two
  (`useCoalescedFetch`).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** with `useCoalescedFetch` (unarmed — no interval; reads on mount, on `reload`, on window focus). Registry changes are rare and
  a commit-time fact, which is why there is no timer; say so in the header comment. `useProjectSources` (Runs) stays as is.
- [ ] **Step 4: Run** — PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(client): one shell-level projects answer`.

### Task 3: Section list, page stores, landing clamp, rail rows

**Files:**
- Modify: `client/src/lib/sections.ts` (header comment + `SECTIONS`), `client/src/lib/settings.ts` (landing clamp + its comment),
  `client/src/components/SideRail.tsx` (rows, trees, labels, icons, drawn rule)
- Create: `client/src/lib/source-page.ts`, `client/src/hooks/useSourcePage.ts`
- Test: `test/rail.test.tsx`, `test/nav.test.tsx`, `test/settings.test.ts`, `test/jira-sections.test.tsx` (update), `test/source-page.test.ts` (new)

**Interfaces:**
- Consumes: `useProjectsContext` (Task 2).
- Produces:
  - `SECTIONS = ['files', 'github', 'jira', 'runs', 'settings']`
  - `type FilesPage = 'board' | 'archive'`, `FILES_PAGES`, `FILES_PAGE_KEY = 'backlog-manager.files-page'`, `isFilesPage`
  - `type GithubPage = 'board' | 'archive' | 'settings'`, `GITHUB_PAGES`, `GITHUB_PAGE_KEY = 'backlog-manager.github-page'`, `isGithubPage` (Plan B adds `prs`)
  - `useFilesPage(): [FilesPage, (p: FilesPage) => void]`, `useGithubPage(): [GithubPage, (p: GithubPage) => void]` — module stores shaped like `useJiraPage`
  - `resolveLegacySection(raw: unknown): { section: Section; page: 'board' | 'archive' | null }` in `source-page.ts` — `board` → (`github`, `board`),
    `archive` → (`github`, `archive`), a valid section → (itself, `null`), anything else → (`github`, `null`)

- [ ] **Step 1: Write the failing tests** —
  - `source-page.test.ts`: `resolveLegacySection` for `'board'`, `'archive'`, `'runs'`, `'jira'`, `'projects'`, `42`, `undefined` (expected values above).
  - `settings.test.ts`: `legacy landing board/archive is kept` — a stored landing `board` clamps to `github`, `archive` to `github` (and the page store is
    told `archive`; assert through `resolveLegacySection`); `last` and `runs` unchanged; `nonsense` → `last`.
  - `rail.test.tsx`: with projects `drawn = {files:true, github:true}` the rail's rows read `Files, GitHub, Runs, Settings` (+ `Jira` when configured);
    Files' tree is `Board, Archive`; GitHub's is `Board, Archive, Settings`; with `{files:false, github:true}` there is no Files row; while `drawn` is `null`
    and the current section is `github`, the GitHub row is drawn and the Files row is not; a tree pick from another section changes section and page in one
    click and marks `aria-current="true"` only on the current section's tree.
  - `nav.test.tsx` / `jira-sections.test.tsx`: replace every `board`/`archive` section literal with the new sections; behaviour asserted stays the same.
- [ ] **Step 2: Run** those suites — FAIL.
- [ ] **Step 3: Implement.** The drawn rule per source row mirrors `drawn(id)` for Jira: `drawn[id] === true`, or `drawn === null && section === id`.
  `RAIL_LABEL`/`RailIcon` get `files` and `github` entries (Files: the current Board icon; GitHub: a branch-style outline per DESIGN.md §6) and lose
  `board`/`archive`. `LANDINGS` maps legacy values through `resolveLegacySection` before `pickOne`, so `Opens on` keeps a legacy pin; update the long
  comment at `settings.ts:340` to say so. `sections.ts`'s header gains a paragraph on why Board/Archive became per-source rows (spec Intent).
- [ ] **Step 4: Run** — PASS; typecheck clean (App.tsx will not compile until Task 4 — do Tasks 3 and 4 in one commit if the build must stay green, else
  stub the two branches in `App` minimally here).
- [ ] **Step 5: Commit** `feat(client): files and github rail rows with their page trees`.

### Task 4: App shell — render, hold-and-fall, settling

**Files:**
- Modify: `client/src/App.tsx` (`FALLBACK_SECTION`, `resolveSection`, initializer, `report`, the Jira fall, the per-section render, the `onOpen<Source>Page`
  pairs), `client/src/lib/deep-link.ts` only if its `SECTIONS` check needs no change (it should not)
- Create: `client/src/components/github/GithubSettingsView.tsx` (a page holding Task 6's sync card; until Task 6, it renders the existing `TrackersGroup`)
- Test: `test/source-sections.test.tsx` (new), `test/deep-link-app.test.tsx`, `test/section-boundary.test.tsx` (update)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `onOpenFilesPage(p: FilesPage)`, `onOpenGithubPage(p: GithubPage)` built in `App`, passed to `BoardView`/`SettingsView` as needed by Task 6.

- [ ] **Step 1: Write the failing tests** in `source-sections.test.tsx` (mock `fetch` for `/api/projects`, `/api/items`, `/api/jira`, `/api/trackers`):
  - `legacy board settles on Files when no github project` — stored `board`, projects `[files]` → Files › Board, stored key becomes `files`.
  - `legacy archive settles on GitHub archive` — stored `archive`, projects `[github]` → GitHub › Archive.
  - `unknown projects answer holds the stored source section` — stored `github`, projects `500` → GitHub section rendered, GitHub row present, stored key
    still `github`.
  - `github row vanishing falls to the first drawn source` — on GitHub, reload answers `[files]` → Files › Board, key `files`; answers `[]` → Runs.
  - `jira fall uses the source fallback` — on Jira, `/api/jira` says `configured:false`, projects `[github]` → GitHub.
  - `nothing registered opens on Runs` — no stored key, projects `[]` → Runs.
  - Each of Files › Board, Files › Archive, GitHub › Board, GitHub › Archive, GitHub › Settings renders its view (assert a landmark text from each).
  - `deep-link-app.test.tsx`: `?section=runs&runs=history` unchanged; `?section=board` is ignored (plain load).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** `FALLBACK_SECTION = 'github'` (provisional, constant — spec Fallback). The initializer uses `resolveLegacySection`, writes the
  legacy page into the matching page store, and leaves settling to an effect keyed on `drawn` and `section` that calls `change(settleSection(section,
  drawn))` when the result differs — only once `drawn` is non-null (unknown holds). The Jira fall becomes `change(drawn === null ? 'github' : firstDrawn(drawn))`
  — while unknown it lands provisionally and the settling effect corrects it. `report` keys become `files`, `github`, `runs`. Render: `files` + page →
  `BoardView source="files"` / `ArchiveView source="files"`; `github` + page → the same with `github`, or `GithubSettingsView`.
- [ ] **Step 4: Run** — PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(client): shell renders source sections and settles legacy landings`.

### Task 5: `BoardView` and `ArchiveView` filtered to one source

**Files:**
- Modify: `client/src/components/board/BoardView.tsx`, `client/src/components/archive/ArchiveView.tsx`, and the derivation that feeds them in `client/src/lib/`
  (put the per-source filter in `lib/sources.ts`: `inSource(projectPath, projects, source): boolean`)
- Test: `test/archive.test.tsx`, `test/board.test.tsx`, `test/board-hook.test.tsx`, `test/sources-lib.test.ts`

**Interfaces:**
- Consumes: `sourceSectionOf` (Task 1).
- Produces: `BoardView` prop `source: SourceSection` (required), `ArchiveView` prop `source: SourceSection` (required); `inSource` in `lib/sources.ts`.

- [ ] **Step 1: Write the failing tests** — fixtures with one project per source (`files` A, `github` B, `unsupported` C, distinct names and item titles):
  - Board `source="github"` shows only B's items, the project picker lists only B; `source="files"` shows A's and lists A and C.
  - `unreachable and index errors only on files` — C's unreachable warning and an `ItemsIndex.errors` entry for A appear on Files › Board, neither on GitHub.
  - Archive `source="files"` lists only A's archived items; `source="github"` only B's; the count line names the filtered set.
  - A stored project pick that belongs to the other source falls open to "all" on this page (the existing fail-open, per page).
  - `inSource`: path of B with `github` → true, with `files` → false; unknown path → false.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — filter items, projects and warnings by `inSource` before every existing derivation, so counts, filters, the Orchestrate
  sheet's project list and the run chip read the filtered set. The persisted project-pick key (`PROJECT_KEY` in `client/src/lib/view-keys.ts`, read by both views) becomes per source (`<PROJECT_KEY>.<source>`) so the two boards do
  not fight over one value.
- [ ] **Step 4: Run** — PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(client): board and archive draw one source each`.

### Task 6: Trackers card split — GitHub › Settings and `Sources · this machine`; the sync-off sentence

**Files:**
- Create: `client/src/components/github/GithubSyncGroup.tsx` (each github project's sync picker, moved from `TrackersGroup`),
  `client/src/components/settings/SourcesGroup.tsx`
- Modify: `client/src/components/github/GithubSettingsView.tsx`, `client/src/components/settings/SettingsView.tsx` (Shared: Sources card first, Trackers
  card gone), delete `client/src/components/settings/TrackersGroup.tsx` once empty; `server/src/tracker/poller.service.ts` (`syncOffBlock` sentence),
  `client/src/lib/tracker.ts` (`syncOffReason` copy), `.env.example`
- Test: `test/settings-view.test.tsx`, `test/sources-group.test.tsx` (new), `test/tracker-sync-interval.test.ts`, `test/tracker-lib.test.ts`,
  `test/tracker-sync-refusals.test.ts`, `test/tracker-board.test.tsx`, `test/tracker-abort.test.ts`, `test/settings-trackers.test.tsx` (today's `TrackersGroup` suite — its cases move to the two new suites)

**Interfaces:**
- Consumes: `useProjectsContext`, `useTrackers` context, `useJiraContext`; `onOpenGithubPage` and `onOpenJiraPage` from `App` (Task 4).
- Produces: `SourcesGroup({ onOpenGithubPage, onOpenJiraPage })`, `GithubSyncGroup()`.

- [ ] **Step 1: Write the failing tests** —
  - `sources-group.test.tsx`: Files row `2 projects` with each files project's `backlog.mjs connect` command (the exact command `TrackersGroup` shows today);
    GitHub row `token set` when the token is set and no github project is registered (no login), `as <login>` plus the rate-limit read-out when the poller
    has one, `not set` without a token, and `n projects`; Jira row `configured · <site> · n boards` or `not configured`; a link on the GitHub row calls
    `onOpenGithubPage('settings')`, on the Jira row `onOpenJiraPage('setup')`.
  - `settings-view.test.tsx`: Shared shows `Sources` first and no `Trackers`; GitHub › Settings shows each github project's sync picker and changing one
    POSTs `/api/trackers/sync` exactly as before.
  - The five tracker suites: their `SENTENCE` constants become `sync is off for <repo> — turn it on in GitHub › Settings`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — move, do not copy: every row of `TrackersGroup` lands in exactly one of the two new cards (spec "Parts of the how"); both
  sentences change together; `.env.example`'s description of where sync is set follows.
- [ ] **Step 4: Run** — PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(client): split the Trackers card into GitHub settings and a Sources card`.

### Task 7: Docs, invariants and rules

**Files:**
- Modify: `CLAUDE.md` (Layout `client/src/` bullet: sections list, Trackers card home; Invariants: the Settings headline and any tree-rule headline that
  changes), `docs/subsystems/invariants.md` (Settings-is-three-pages: a host card on a source's settings page is allowed; tree rule applied to Files/GitHub;
  source rows' hold-and-fall), `.claude/rules/board.md` (matching bullets), `docs/subsystems/board.md`, `.claude/DESIGN.md` (§8.0 rail rows; a §8.x note
  for source sections; §8.5 Archive per source; §8.6 Settings Sources card)
- Test: `test/claude-rules.test.ts`, `test/csp.test.ts` (unchanged; run to prove it)

- [ ] **Step 1: Edit** each doc; every changed headline byte-equal in its three homes.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/claude-rules.test.ts test/csp.test.ts` — PASS.
- [ ] **Step 3: Run** `pnpm run typecheck` and the jsdom suites touched by Tasks 3–6 together — PASS.
- [ ] **Step 4: Commit** `docs: source sections on the rail`.
