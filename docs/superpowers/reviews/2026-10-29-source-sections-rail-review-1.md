# Review 1 — Source Sections rail reshape plan (Plan A)

Plan: `docs/superpowers/plans/2026-10-29-source-sections-rail.md` (229 lines). Spec: `docs/superpowers/specs/2026-10-29-source-sections-design.md`.
Reviewer: fresh subagent, Fable 5.1. Code facts verified against the worktree (client/server identical to `main` — `git diff main --stat` is empty there).
GitHub › PRs and its server work are Plan B by the plan's own statement (plan:19-20) and are not reported as gaps.

## Verdict: REVISE

One Critical: the plan's Review Focus 1 promises no GitHub row "not even for one frame" on a files-only machine, while the plan's own drawn rule and
provisional-`github` landing draw that row during the unknown window and drop it on the answer — the spec's named anti-goal. Eight Important findings, mostly
unstated destinations and missed homes an implementer would have to guess at.

## Checklist coverage

1. **Coverage** — every rail-reshape spec section maps to a task except: the Sources card's per-repo "can the token reach it" read-out (spec:60, 135) and the
   `Opens on` option rule for Files/GitHub (spec:158, `landingOptions`). Spec test cases (Review Focus 1–5) each name a task and a test; RF1's test cannot pass as
   designed (C1).
2. **Values** — the sync-off sentence (plan:28, 210) matches spec:121 byte-for-byte. Rail labels and tree labels match spec:19-25. Sources-card copy (`token set`,
   `as <login>`, `not configured`) is the plan's own; spec gives no literals, so no mismatch — but `not set` (plan:206) replaces today's `no token — set
   BM_GITHUB_TOKEN in .env and restart` (TrackersGroup.tsx:79) without saying it is a deliberate rewording (M10).
3. **Reality** — every Create path is absent and every Modify path present (checked 50 paths). `settings.ts:340` is the comment the plan cites. `PROJECT_KEY`
   is in `view-keys.ts:25`. `useWindowFocus` exists (`useWindowFocus.ts:17`) but is the wrong layer (I3). `landingOptions` lives in `SettingsView.tsx:90`, not in
   `lib/settings.ts` as its comment at settings.ts:252 implies — the plan never names it (I8).
4. **Interfaces** — `settleSection`'s two signatures disagree (M1); `onOpenFilesPage`/`onOpenGithubPage` are produced in Task 4 and consumed in Task 6 ✓;
   `inSource` is produced in Task 5 and consumed there ✓; `useProjectsContext` Task 2 → Tasks 3, 6 ✓.
5. **Order** — Task 3 leaves `App.tsx` uncompilable until Task 4 (plan:129-130) while plan:32 makes `pnpm run typecheck` a per-commit gate (M5). Nothing else
   depends on a later task.
6. **Tests** — fixtures discriminate (three projects A/B/C with distinct names and titles, plan:175). Gaps: `drawnSources` never exercises `null` alone (M2);
   no test for a legacy `archive` landing on Files (I2); no test for the Opens-on options (I8); no test for the per-repo reach line (I5).
7. **Conventions** — "behaviour, never literal code" holds throughout; soft budgets stated (plan:7). The repo's own rule that `useRefreshing` is the layer every
   board poller enters through is contradicted by Task 2 (I3).

## Critical

- **[C1] plan:36-37 vs plan:120-121, 125, 156** — Review Focus 1 says that on a machine with only files projects and a stored `board` "the GitHub row is never
  drawn, not even for one frame". But Task 3's rail test (plan:120-121) and its drawn rule (plan:125, mirroring `SideRail.tsx:116`) draw the GitHub row while
  `drawn === null && section === 'github'`, and Task 4 (plan:156) makes a legacy `board` — and the no-key default `FALLBACK_SECTION = 'github'` — the section
  `github` before any answer. The shell cannot tell a provisional `github` from a stored real one: both are the string `'github'` in `section`. So on every
  files-only machine the first load after the change (and every load for a user whose `Opens on` pin clamped to `github`, see I1) draws the GitHub row during
  the unknown window and drops it on the answer — exactly the anti-goal at spec:82 ("A rail row that appears on a guess and vanishes on the answer"). The two
  Task 4 tests `legacy board settles on Files…` (plan:146) and `unknown projects answer holds the stored source section` (plan:148) cannot both hold without a
  second bit of state. → Make provisionality explicit: the initializer (via `resolveLegacySection`, which already knows it mapped a legacy or unknown value)
  returns `{ section, provisional }`; while `provisional && drawn === null` the rail draws no source row and `main` renders the section's loading shape; the
  settle effect clears the flag when it writes the settled value back. Thread `provisional` to `SideRail` (a prop, like `section`). Then make RF1's test assert
  `queryByRole('link'|'button', {name:'GitHub'})` is absent before the `/api/projects` promise resolves, and add the mirror case for a no-key first load.
  (Alternative: drop the "never drawn" claim and accept spec:36's literal reading — but spec:82 forbids that outcome, so the flag is the fix.)

## Important

- **[I1] plan:117-118** — `legacy landing board/archive is kept`: "the page store is told `archive`; assert through `resolveLegacySection`" asks a PURE clamp
  (`clampSettings`, settings.ts:369-376, `pickOne` over `LANDINGS` settings.ts:352) to write a page store. `clampSettings` runs on every settings read, so a
  write there would reset the GitHub page to Archive on every load; and `Landing = Section | 'last'` (settings.ts:35) has no slot to remember a page. → Say the
  landing clamp maps `board`/`archive` → `github` and drops the page (a pin names a section, as `landing: 'jira'` does); delete the page-store assertion; keep
  `last`/`runs` unchanged and `nonsense` → `last`. If the page must survive, that is a change to `Landing`'s shape and needs its own step.
- **[I2] plan:156-158 vs spec:157** — the settle effect calls `change(settleSection(section, drawn))` and only the section moves. The initializer "writes the
  legacy page into the matching page store" — GitHub's. When a legacy `archive` settles to Files ("else Files' SAME page while the Files row is drawn"),
  Files' page store still reads its default `board`, so the reader lands on Files › Board. No Task 4 test covers legacy `archive` + files-only. → Have the
  initializer record the legacy page for BOTH stores (or have the settle step write it into the destination's store), and add `legacy archive settles on
  Files archive when no github project` → Files › Archive, key `files`, `FILES_PAGE_KEY` = `archive`.
- **[I3] plan:89, 92-93** — Task 2 builds `ProjectsProvider` on `useCoalescedFetch` plus a hand-wired `useWindowFocus`. `.claude/rules/board.md:121-124`
  (mechanism of the `useCoalescedFetch` invariant) says `hooks/useRefreshing.ts` "is the layer every board poller enters through … owning the mount +
  window-focus triggers once", and `useRefreshing.ts:7-14` is exactly mount + focus with no timer when `armed` is omitted. → Build on `useRefreshing(task)`
  (no `armed`), drop `useWindowFocus` from the plan, keep tests (e) and (f) as stated — they hold through `useRefreshing` unchanged — and add
  `ProjectsProvider` to the board.md bullet's reader list in Task 7.
- **[I4] plan:169, 173** — `BoardView`/`ArchiveView` gain a REQUIRED `source` prop, and Task 5 lists three suites. Eleven suites render `<BoardView` or
  `<ArchiveView>`: `test/archive.test.tsx`, `board-column.test.tsx`, `board-run-chip.test.tsx`, `board-live-cards.test.tsx`, `board.test.tsx`,
  `dispatch-button.test.tsx`, `dialog-escape.test.tsx`, `orchestrator-start-ui.test.tsx`, `plan-review-chip.test.tsx`, `remote-starting-ui.test.tsx`,
  `tracker-board.test.tsx`. `tsconfig.json:19` includes `test/**/*` and jest is `ts-jest` with default diagnostics (jest.config.ts:4), so the eight unlisted
  suites fail both `pnpm run typecheck` (the plan's own commit gate, plan:32) and their own run. → List all eleven under Task 5's Test files, each passing a
  `source` that matches its fixture's project.
- **[I5] spec:60, 135-136 — no task** — the Sources card's GitHub row must show "whether the token can reach each registered repo". Task 6's
  `sources-group.test.tsx` (plan:204-207) covers `token set` / `as <login>` / rate limit / `n projects` only. The data is already in the payload
  (`TrackerProjectRow.access` and `.detail`, shared/types.ts:541-556; `trackerState(project, now)`, client/src/lib/tracker.ts:270, is the line
  `TrackersGroup.tsx:92` draws today). → Add to the GitHub row (or one sub-row per repo) the reach reading per registered github repo, and a test with two
  repos in different `access` states so a swapped or unscoped line fails.
- **[I6] plan:212** — "every row of `TrackersGroup` lands in exactly one of the two new cards", but the plan assigns only the sync picker, the token/login/rate
  row, `connect` and the Jira row. Unassigned rows at `client/src/components/settings/TrackersGroup.tsx`: the `data === null` `checking…`/`unavailable` row
  (:33-34), the per-repo refusal hint that replaces the project line on a 409 (:41-44, pinned by `test/settings-trackers.test.tsx:127-160`), the
  `github <repo> · <trackerState>` project line (:89-94), `nothing registered yet` (:60), and the `the last read failed — showing the previous answer` row
  (:69). → A row → card table in Task 6 (refusal + state line + `nothing registered` belong with the picker on GitHub › Settings; `checking…`/`unavailable`
  and the stale-answer row are needed on BOTH cards since each reads `useTrackersContext`), and say which of `settings-trackers.test.tsx`'s cases move
  to which new suite.
- **[I7] plan:220-224 (Task 7 file list)** — the sentence and the Trackers card have homes the plan does not name, and three of them are guarded or
  mechanism tier: `.claude/rules/tracker.md:107` carries the literal `sync is off for <owner/name> — turn it on in Settings › Shared › Trackers` as the
  mechanism bullet of the sync-off invariant; `docs/subsystems/invariants.md:3424` repeats it inside the entry; `docs/subsystems/api.md:139` repeats it;
  `docs/subsystems/jira.md:9, 270, 316, 319` describe "the Trackers row"; `.claude/DESIGN.md:497-505` is §8.9.4 "Chip and Trackers row";
  `.claude/rules/board.md:58` says the Jira fall moves to `board` and `:62` names "the Trackers row's `Jira › Setup` text". → Add `tracker.md` and the
  invariants sync-off entry to Task 6 (they change with the server literal, same commit), and `api.md`, `jira.md`, DESIGN §8.9.4 and board.md:58/62 to Task 7.
- **[I8] spec:158 — no task** — "The `Opens on` preference clamps the same way" covers the clamp, but the OFFER is `landingOptions`
  (`client/src/components/settings/SettingsView.tsx:90-92`): Jira is offered only while configured and a stored `jira` pin keeps its option. The plan names
  no rule for the `Files` and `GitHub` options (offered always? only while `drawn[id]`? before the projects answer?) and no task touches `landingOptions`
  or has `SettingsView` read `useProjectsContext`. Offered unconditionally, a pin to a row this machine never draws lands every load on the provisional
  flicker of C1. → State the rule (mirror Jira: offer a source while its row is drawn, withhold while unknown, keep a stored pin's option) and add two
  cases to `settings-view.test.tsx`: `{files:true, github:false}` offers `Files` and not `GitHub`; a stored `github` pin keeps its option.

## Minor

- **[M1] plan:60-61 vs plan:69-71** — Interfaces type `firstDrawn(): Section` and `settleSection(section: Section, …): Section`, Step 3 makes
  `settleSection` generic and forbids importing `lib/sections.ts`. One signature; if the no-import rule stands, `Section` cannot appear in Task 1 at all.
- **[M2] plan:65** — `drawnSources` tests `unsupported` alone but never `null` alone; spec:19 counts both. Add `[null]` → `{files:true, github:false}`.
- **[M3] plan:210** — "their `SENTENCE` constants": `test/tracker-abort.test.ts:211` and `test/tracker-sync-interval.test.ts:269` inline the literal. Also
  `skills/backlog/tools/backlog.test.mjs:4015` carries the old sentence as a stubbed 409 body under the node runner — it will not fail, but the fixture
  goes stale; update it in Task 6.
- **[M4] plan:137** — "Modify … `deep-link.ts` only if its `SECTIONS` check needs no change (it should not)" is self-cancelling. `readDeepLink`
  (deep-link.ts:14-22) reads `SECTIONS` at runtime, so it needs no edit; say "unchanged, run `test/deep-link.test.ts`".
- **[M5] plan:129-130** — Task 3 knowingly leaves `App.tsx` uncompilable, while plan:32 gates every commit on `pnpm run typecheck`. Decide: one commit for
  Tasks 3+4, or a two-line stub in Task 3 (the plan offers both; pick one so the implementer does not).
- **[M6] plan:182-183** — "the run chip read the filtered set": spec:129 says the run chip "stays" and says nothing about filtering runs by source. Filtering
  hides a files project's live run from GitHub › Board's chip (and vice versa). Say it is intended, with a test, or leave the chip reading all runs on this
  machine.
- **[M7] plan:208** — `settings-view.test.tsx` is asked to assert GitHub › Settings, which `GithubSettingsView` draws, not `SettingsView`. Name a
  `github-settings.test.tsx` (it also inherits the picker cases from `settings-trackers.test.tsx:92-214`).
- **[M8] plan:204** — Files row `2 projects`: say whether `unsupported`/`null` projects count (they draw the row, spec:19) — the fixture should include one.
- **[M9] test/settings-view.test.tsx:268, 283, 912** pin `Trackers` in Shared's group-title lists; Task 6 lists the suite, so this is only a note that those
  three assertions change to `Sources` first.
- **[M10] plan:206** — `not set` replaces today's `no token — set BM_GITHUB_TOKEN in .env and restart` (TrackersGroup.tsx:79), which told the reader the fix.
  If the shorter copy is intended, say so; otherwise keep the instruction.
- **[M11] plan:93** — "Registry changes are rare and a commit-time fact" — `backlog.mjs register` writes `registry.json` without a commit; "a fact of the
  machine, not of this tab" is the accurate reason for mount+focus over a timer.
