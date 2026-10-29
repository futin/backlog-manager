# Review 1 recheck — Source Sections rail reshape plan (Plan A)

Plan: `docs/superpowers/plans/2026-10-29-source-sections-rail.md` (275 lines, revision `git diff HEAD~1`). Spec: `docs/superpowers/specs/2026-10-29-source-sections-design.md`.
Previous review: `docs/superpowers/reviews/2026-10-29-source-sections-rail-review-1.md` (REVISE: C1, I1–I8, M1–M11).
Reviewer: fresh subagent, Fable 5.1. Scope: the changed hunks only, with surrounding plan text read where a changed line depends on it. Code facts verified
in the worktree (`client/`, `server/`, `test/`, `.claude/rules/`, `docs/` all at `main`'s state).

## Verdict: APPROVE WITH FIXES

Every review-1 finding is resolved by a change that actually targets it (table below). No new Critical. Two Important: one is a rule the revision added
(a `files`/`github` `Opens on` pin is provisional) without the reason that forces it or the consequence it has under a failed first read, which reads as a
contradiction of spec:36; the other is a row on GitHub › Settings whose normal text the new row→card table leaves unspecified, so its "replaced on a 409"
test has nothing to replace.

## Coverage — does each change resolve the finding it targets?

| Review 1 | Changed lines | Resolved? |
| --- | --- | --- |
| C1 flicker on a files-only machine | plan:36-38, 114-117, 126-128, 132-133, 157-160, 172-177 | Yes. `resolveLegacySection` carries `provisional`; the rail's drawn rule is `drawn[id] === true \|\| (drawn === null && section === id && !provisional)`; `main` renders the loading shape while `provisional && drawn === null`; RF1's test asserts no `GitHub` row before `/api/projects` resolves and a no-key mirror is added. |
| I1 landing clamp writing a page store | plan:44-45, 122-124, 135-136 | Yes. The clamp maps `board`/`archive` → `github` before `pickOne` (`settings.ts:352` is `LANDINGS`, `:376` the `pickOne`), the page is dropped, no store write. |
| I2 legacy `archive` settling on Files › Board | plan:162-163, 173-174 | Yes. The initializer writes the legacy page into BOTH page stores; test `legacy archive settles on Files archive when no github project` asserts `FILES_PAGE_KEY = archive`. |
| I3 `useCoalescedFetch` + hand-wired `useWindowFocus` | plan:87-93 | Yes. `useRefreshing(task)` with no `armed` (`client/src/hooks/useRefreshing.ts:23-33` is mount + focus through the one coalesced trigger); `.claude/rules/board.md:121-124` is the bullet cited; Task 7 adds `ProjectsProvider` to its reader list (plan:266). Tests (e)/(f) hold through it unchanged. |
| I4 eight unlisted suites rendering `<BoardView`/`<ArchiveView` | plan:187-190 | Yes. The eleven names match `grep -l '<BoardView\|<ArchiveView' test/*.tsx` exactly. |
| I5 per-repo reach line on the Sources card | plan:232-234, 248 | Yes. `<repo> · <trackerState>` from `lib/tracker.ts:270`, two repos in different `access` states. |
| I6 unassigned `TrackersGroup` rows | plan:242-254 | Yes for every row I6 named (see M3 for two it did not). |
| I7 sentence and card homes | plan:216-218, 265-269 | Yes. `.claude/rules/tracker.md:107`, `invariants.md:3424`, `api.md:139`, `jira.md:9, 270, 316, 319`, `DESIGN.md:497-505`, `board.md:58, :62` all verified at those lines. |
| I8 `Opens on` offer rule | plan:101-102, 137-139 | Yes. Mirrors `landingOptions` (`SettingsView.tsx:90-92`); two cases named. See M2 for the existing case that changes too. |
| M1–M11 | plan:61-63, 66, 70-71, 148, 140-142, 203-204, 219-222, 229-232, 238-240, 92-93 | All applied as suggested. |

## Checklist on the changed lines

1. **Coverage** — above. The revision's one new rule beyond review 1's suggestions is plan:173 "a section from a landing pin of `files`/`github` is
   provisional too" (I1 below).
2. **Values** — sync-off sentence (plan:239) byte-equal to spec:121. `no token — set BM_GITHUB_TOKEN in .env and restart` (plan:232) is
   `TrackersGroup.tsx:134` verbatim. `nothing registered yet` (plan:237, 249) is `:106`; `checking…`/`unavailable` (plan:253) is `:80`; `the last read
   failed — showing the previous answer` (plan:254) is `:115`. `Files` row `2 projects` and the Jira row's fields match spec:135-136. `FILES_PAGE_KEY =
   archive` (plan:163) matches the key named at plan:111.
3. **Reality** — every Create path (plan:52, 78, 103, 149, 212-213, and the six new test files) is absent; every Modify/Test path present. Line references
   verified: `board.md:58` (Jira fall to `board`), `:62` (`Trackers row's Jira › Setup`), `:121-124` (`useRefreshing` reader list), `tracker.md:107`,
   `invariants.md:3424`, `api.md:139`, `jira.md:9/270/316/319`, `DESIGN.md:497-505` (§8.9.4), `backlog.test.mjs:4015`, `tracker-abort.test.ts:211`,
   `tracker-sync-interval.test.ts:269` (inline), `tracker-lib:473`/`tracker-sync-refusals:31`/`tracker-board:453` (`SENTENCE` constants),
   `settings-view.test.tsx:268, 283, 912` (`Trackers` in group-title lists), `settings-trackers.test.tsx:92-214` (picker describe), `SettingsView.tsx:90-92`
   (`landingOptions`), `tracker.ts:270` (`trackerState`), `App.tsx:181` (`change('board')`), `App.tsx:154` (`report` keys `board`/`runs`/`archive`),
   `deep-link.ts:23` (`readDeepLink` reads `SECTIONS` at runtime). One slip: plan:221-222 names "token/connect" cases in `settings-trackers.test.tsx` that
   do not exist (M1).
4. **Interfaces** — `settleSection<S extends string>` now has one signature (plan:62-63, 70-71). `SideRail` prop `provisional` (plan:117) is what Task 4
   passes (plan:176). `resolveLegacySection`'s shape (plan:114-116) is what Task 4 consumes (plan:172). `useRefreshing`'s trigger returns `Promise<T>`
   while `reload: () => void` (plan:84) — a wrap, not a mismatch.
5. **Order** — Tasks 3 and 4 share one commit (plan:140-142, 180), which removes the typecheck-gate contradiction. Task 3's `SettingsView` reads
   `useProjectsContext` from Task 2 ✓. Nothing depends on a later task.
6. **Tests** — the new cases discriminate: `'github'` → (`github`, `null`, false) beside `'board'` → (`github`, `board`, true) (plan:120-121); two repos
   in different `access` states (plan:233); the held-unresolved `/api/projects` promise is what makes RF1's assertion fail before the flag exists
   (plan:157-158). Two existing cases the changed lines do not mention will fail and must change (M2); one fixture detail (M4).
7. **Convention** — behaviour and test cases, no literal code; the row→card table is a mapping, not code.

**New contradictions with unchanged plan/spec text:** I1 (plan:173 vs spec:36 and spec:151-153). None other found; plan:203-204 (run chip reads every
run) now agrees with spec:129.

## Critical

None.

## Important

- **[I1] plan:172-173 vs spec:36, 151-153** — "a section from a landing pin of `files`/`github` is provisional too" is a rule the spec does not have: its
  provisional list is "the constant, a legacy `board`/`archive`, an unrecognised stored value", and spec:36 says an unknown answer "draws a source row only
  if that section is the one on screen, and keeps it". A reader with a real `github` pin (stored while the row was drawn, per the new offer rule at
  plan:137-139) therefore gets, on every load, no GitHub row until `/api/projects` answers, and under RF2's failed first read (plan:39-40) no source row at
  all and the loading shape until some later read succeeds — where a stored `github` SECTION keeps its row. The reason the plan needs this is real but
  unstated: `clampSettings` is pure (plan:123) and returns `github` for a legacy `board` pin and a real `github` pin alike, so `settings.landing` cannot
  tell them apart in the initializer (`App.tsx:115` seeds from `settings.landing`). → Either (a) say so at plan:173 and name the accepted consequence
  (a pinned reader's source row appears on the answer, and a failed first read leaves no source row and the loading shape), adding that case to RF2's
  test; or (b) make only a legacy pin provisional by resolving the pin through `resolveLegacySection` on the RAW stored landing (the `SETTINGS_STORAGE_KEY`
  blob's `landing` field, read once in the initializer, next to the clamped value) — then a real `github`/`files` pin behaves as spec:36 says. (a) is the
  smaller change; (b) is what the spec says.
- **[I2] plan:236-237, 246-247** — `github-settings.test.tsx`: "a 409 replaces that repo's line with its refusal hint", and the table sends "per-repo 409
  refusal hint replacing the project line" to GitHub › Settings "beside its picker" — but the project line it replaces today (`github <repo> ·
  <trackerState>`, `TrackersGroup.tsx:90, 156`) is sent to the Sources card (plan:248), and "move, do not copy" forbids it on both. So the per-repo row on
  GitHub › Settings has a name (`project.name`) and a picker and NO stated hint; an implementer must guess what the refusal replaces (nothing? the repo? a
  copy of the state line?). → State the row: name `project.name`, hint `<repo>` (the sync key — `TrackersGroup.tsx:34` "two checkouts of one repo share the
  key, so both rows move" is the reason the repo, not the path, is the line), the picker; a 409 replaces that hint with the refusal and the next pick for
  that repo clears it (the moved case at `settings-trackers.test.tsx:139`).

## Minor

- **[M1] plan:221-222** — "its token/connect/Jira cases to `sources-group.test.tsx`": `settings-trackers.test.tsx` has two describes only, the picker
  (`:92-214`) and the Jira row (`:216-246`); nothing in it asserts the token/login line or a `connect` command. Say "its Jira-row cases (`:216-246`)"; the
  token/connect cases in `sources-group.test.tsx` are new.
- **[M2] plan:137-139** — `settings-view.test.tsx:230-245` pins the `Opens on` options as `['Last used', 'Board', 'Runs', 'Archive', 'Settings']` and
  selects `archive`. Under the new rule (and `renderView()` at `:95-99` mounts no projects provider, so `drawn` is `null`) that case changes, and the plan
  says only "Add". State what it becomes — e.g. with no projects answer the list is `Last used, Runs, Settings`; the pick is `runs` — so the implementer
  does not choose the baseline that the two added cases are measured against.
- **[M3] plan:242-254** — the table covers every row review 1 named but not two `ProjectLine` variants: an `unsupported` project's `a source marker this
  build cannot read — see the board’s warnings` (`TrackersGroup.tsx:160`) and a `null` project's `no backlog/ store` (`:161`). Both count toward the Files
  row's `n projects` (plan:229). Say whether they ride on the Files row beside the `connect` commands or are dropped (the Board's warning already says it).
- **[M4] plan:233** — `trackerState` (`tracker.ts:270`) reads `access`, `detail`, `polledAt` AND `interval`, with the access reason taking precedence.
  The two-repo fixture should hold `polledAt`/`interval` equal and vary `access` only, so the differing text is provably the reach reading.
- **[M5] plan:125-129** — `rail.test.tsx` renders `<SideRail section onChange>` with no provider (`rail.test.tsx:45`), and `useJiraContext`/`useTrackersContext`
  return the context default outside one (`JiraContext.tsx:22-24`). "with projects `drawn = …`" needs a `ProjectsProvider` over a stubbed `fetch`, or a
  mocked `useProjectsContext`; name which (and give `useProjectsContext` the same no-throw default so the existing rail cases keep rendering).
- **[M6] plan:249** — `nothing registered yet` on GitHub › Settings is reachable only in the held state (the page sits under a row drawn only with ≥1
  github project); keep it, but say it is the held/unknown state's text so nobody writes a case that navigates there with a drawn row and no project.
- **[M7] plan:233** — "(`lib/tracker.ts:270`, from `TrackerProjectRow.access`/`.detail`)": `trackerState` takes `Pick<ProjectSummary, …>` and
  `TrackerProjectRow` satisfies it structurally (`shared/types.ts:541-557`), as `TrackersGroup.tsx:156` already relies on — fine, just say "as today's
  `ProjectLine` calls it".
