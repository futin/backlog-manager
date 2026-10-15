# Client composability: backlog-manager (A) vs claude-agents-dashboard (B)

Read-only comparison, 2026-10-15. A = `/Users/andrejajevtic/Documents/custom-projects/backlog-manager` @ `5511bd1`; B = `/Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard` @ `1ea48ec`.
All paths below are relative to each repo's `client/src/` unless prefixed.

## Verdict

A is not structurally behind B. B's "composable architecture" is a convention, not a library: feature folders, a thin per-section container that owns one data hook,
presentational views sharing one props interface, feature-local `atoms.tsx`, pure `lib/` view-models with direct unit tests, and a mutation hook per endpoint. A already
has most of that, and is ahead on shared UI primitives. A's raw LOC numbers are mostly comments (A is 61% comment lines, B 24%). The real gaps are narrower: A's four
largest views still hold pure derivations, a three-step wizard and async-action plumbing inline, and its refetch-on-focus/poll triad is hand-copied across six hooks.

## 1. B's client architecture

**Folder layout.** `components/` holds feature folders (`sessions/`, `usage/`, `management/`, `configs/`, `analytics/`, `settings/`) plus shell pieces at the root
(`SideRail.tsx`, `Toolbar.tsx`, `ChatDrawer.tsx`, `SpawnPanel.tsx`, `PanelChrome.tsx`, `Popover.tsx`, `Chevron.tsx`). `hooks/` has 33 hooks, one per endpoint or
behaviour. `lib/` has 39 pure modules. There is no `components/ui/` directory.

**Composition: container, then a view registry, then atoms.**
- `components/SessionsView.tsx:40-190` is the container. It is 121 lines of code and owns the one `useSessions()` poll (`:50`), the view state (`:54-83`) and the one
  `/api/health` poll it threads to its children (`:84-87`, and the comment explains why it is shared instead of re-polled). It derives through `lib/filterSort.ts`
  (`applyView`/`describeEmpty`, `:106-113`) and picks one of five layouts (`:136-141`).
- `components/sessions/views.ts:4-12` is the `ViewProps` interface every layout takes. `ListView`, `TilesView`, `BoardView`, `SplitView` and `TriageView` each run 52-108 LOC.
- `components/sessions/atoms.tsx:21-184` holds the entity atoms (`Dot`, `StatusPill`, `Title`, `Tags`, `Bar`, `ChatButton`, `LaunchPill`...) that every layout reuses.
  `analytics/atoms.tsx` and `management/GitParts.tsx:18-177` follow the same pattern.
- Shared chrome lives in `PanelChrome.tsx:17,51` (`PanelHead`, `MinimisedPanel`).
- Heavy pieces are lazy-loaded: the sections at `App.tsx:16-20`, and the drawer and spawn panel at `SessionsView.tsx:23,25`.

**Pure view-models in `lib/`, tested directly.** `lib/filterSort.ts:203,228` (`applyView`, `describeEmpty`) is covered by `test/filter-sort.test.ts`.
`lib/projectsView.ts` drives `management/ProjectsView.tsx:12,43`. `lib/stopControl.ts` (`stopControl()` returns a render model) is covered by
`test/stop-control.test.ts`. 30% of B's client code lines are in `lib/` (2945 of 9805).

**Data fetching.** There is no query cache and no shared store. Each hook hand-rolls `fetch` plus `setInterval` plus an `alive` flag: `hooks/useSessions.ts:21-58`,
`useAnalytics.ts:16-37`, `useUsageRates.ts:20-42`, and near-identical `usePendingMessage.ts:61-83` / `usePendingPlan.ts:63-85` / `usePendingQuestion.ts:66-91`. The one
factored poll is `lib/gitPoll.ts:25-49` (`startGitPoll`, a visibility-aware schedule with injected timers that tests can fake), consumed by `hooks/useGitStats.ts:38-48`.
Context is used only for settings (`hooks/useSettings.tsx:14`) and configs scope (`hooks/useConfigsScope.tsx:44`).

**Mutations.** Each mutation is a hook that owns `pending`, `error` and `needsToken`, and components only call it: `hooks/useStopSession.ts` and `hooks/useSpawn.ts:33`
(used at `SpawnPanel.tsx:58`).

**Size.** The largest B components are `settings/SettingsView.tsx` (718 LOC, 583 code), `usage/UsageProfile.tsx` (616 / 440) and `SpawnPanel.tsx` (358 / 277, 12 `useState`).
B is not uniformly small either.

## 2. A's client, measured

**Layout.** `components/{board,runs,archive,settings,ui}`, `hooks/` (16 hooks), `lib/` (22 modules). The four sections are lazy at `App.tsx:13-16`. Providers are
`SettingsProvider` and `TrackersProvider` (`App.tsx:51-56`). There are 19 primitives in `components/ui/`, reused across components (Dot ×9, Chip ×9, Pill ×5, Band ×5,
Sheet/Select/Segmented ×4–5...). 38 of 43 component files cite DESIGN.md §.

**Code versus comment.** Measured by stripping comments and blank lines:

| File (A) | Raw LOC | Code | Comment | `useState` | Effects | In-file fn components |
| --- | --- | --- | --- | --- | --- | --- |
| `components/runs/RunsView.tsx` | 1380 | 466 | 869 | 4 | 2 | 6 (`CountPair`, `LiveRow`, `StartingRow`, `HistoryRow`, `RemoteTag`, view) |
| `components/board/OrchestrateSheet.tsx` | 1191 | 406 | 745 | 14 | 3 | 1 |
| `components/runs/RunDetail.tsx` | 1065 | 433 | 596 | 2 | 1 | 1 |
| `components/board/BoardView.tsx` | 988 | 297 | 652 | 5 (+4 `usePersistedState`) | 0 | 1 |
| `components/settings/SettingsView.tsx` | 565 | 281 | 250 | 0 | 0 | 8 |
| `components/runs/WatchdogMonitor.tsx` | 549 | 259 | 271 | 0 | 0 | 1 |
| `components/board/ItemCard.tsx` | 523 | 172 | 339 | 0 | 0 | 1 |

The `useState`/effect counts subtract the import line. Totals: A client code is 6502 lines (comments 10310); B is 11932 (comments 4219). Code share: A has `lib/` 1268,
`hooks/` 577 and `components/` 4562, so 20% in `lib/`. B has 2945 / 2068 / 6792, so 25% in `lib/`. Read on code lines, no A component is larger than B's largest
(583).

**Prop drilling.** The depth is shallow (≤3): `BoardView → ItemCard → DispatchButton` carries `agents`/reverify; `BoardView:735` passes `runs`/`starting` to `RunChip`;
`App` takes `onWorking` from each view (`useReportWorking`). This is the same shape as B's `SessionsView → AsideBoard/SpawnPanel` threading `remoteAnswer` and
`SessionsView onLink` (`SessionsView.tsx:48,52`). It is not a gap.

**Poll ownership.** `useOrchestratorRuns` is called by `BoardView:274`, `RunsView:757` and `ArchiveView:130`. Only one section is mounted at a time, and `App.tsx:84-87`
deliberately declines a fourth shell-level poller. That matches B's rule of one poll per section (`SessionsView.tsx:84-87`).

**Fetch and poll idiom duplication (hooks).** The same triad (mount fetch, `window` focus refetch, conditional `setInterval`, `mountedRef`/`alive` guard) is hand-written in:
- `hooks/useBoard.ts:60-101` (focus `:79`, interval `:96`)
- `hooks/useOrchestratorRuns.ts:100-314` (mounted ref, focus, interval `:284`)
- `hooks/useWatchdog.ts:150-212` (focus, interval `:205`)
- `hooks/useOrchestratorArchive.ts:30-94` (mounted ref and focus)
- `hooks/useAgents.ts:25-75` (focus `:66-72`)
- `hooks/useTrackers.ts:90-200` (a self-arming `setTimeout` with a sequence counter, plus focus)
- `hooks/useProjectSources.ts:21-31` (a `cancelled` flag)

None of them shares a schedule primitive.

**One-shot fetch effects inside components.** These use the "`alive`/`cancelled` flag + set state" idiom:
- `components/board/OrchestrateSheet.tsx:328-345` (merge-check), `:368-380` (uncommitted), `:402-415` (branches)
- `components/runs/RunDetail.tsx:219-265` (archived run)
- `components/board/ItemModal.tsx:312` (item body, a raw `fetch`)
- `components/board/LaunchSheet.tsx:~50-63` (plan)

The fetch functions themselves live in `lib/agents.ts` (115-706), which is good. The lifecycle around them does not.

**Async-action state inline in components.** `busy`/`error` `useState` plus `.then/.catch/.finally` plus `ApiError` code mapping appears in:
- `components/RunControls.tsx:123,145,170-191` (it has a `busyRef` double-click guard)
- `components/board/LaunchSheet.tsx:45-46,73-92` (no ref guard)
- `components/board/OrchestrateSheet.tsx:256-257,618-720` (its own 409/`RUN_IN_PROGRESS_CODE` branch at `:709`)
- `components/board/ClaimRelease.tsx:28-29`

**Derivations living in component files.** These are pure, tested only through renders:
- `components/runs/RunsView.tsx:234-475`: `runKey`, `mergeRuns` (`:264`), `parseStartedAt`, `sortByStartedAtDesc` (`:301`), `splitLive` (`:343`), `groupByDay` (`:373`),
  `STATUS_ORDER`, `queueCounts` (`:464`). They are exercised only via `test/runs-view.test.tsx`, whose comments at `:731,798,810,832,946` describe `mergeRuns`
  regressions caught by render.
- `components/board/BoardView.tsx:121-243`: `COMPARATORS`, `resolveSortKey` (`:159`), `liveRank` (`:203`), `sortItems` (`:221`). They are exercised only via
  `test/board.test.tsx` (comment `:817` even notes the render test cannot tell two implementations of `sortItems` apart).
- `components/runs/RunDetail.tsx:142-176` (`rowsFromArchive`/`rowsFromLive`) and about 35 derived constants in the render body, `:318-516` (counts, labels, mode notes,
  boundary item). Most call into `lib/` already, but the assembly is inline.

This contradicts A's own documented rule that every derivation has one home in `lib/`.

**Hand-restated control.** `components/board/BoardView.tsx:776-830` re-implements `DispatchButton`'s hide-versus-disable, `aria-disabled` click, `aria-busy` and
reverify-on-click behaviour for the Orchestrate chip. The comment at `:779-783` says it was "restated by hand rather than reused because DispatchButton's signature is
fixed around one `BacklogItem`".

## 3. Gaps (each costs something; B's equivalent cited)

| # | Size | A location | Gap | B pattern | Suggested refactor |
| - | ---- | ---------- | --- | --------- | ------------------ |
| 1 | M | `components/runs/RunsView.tsx:234-475` | `mergeRuns`/`splitLive`/`groupByDay`/`sortByStartedAtDesc`/`queueCounts` are pure derivations inside the component, tested only through renders; this breaks A's own lib-home rule | `lib/filterSort.ts:203,228` + `test/filter-sort.test.ts` | Move them to `lib/runs-list.ts` with a direct unit test, leaving RunsView as a container over `LiveRow`/`HistoryRow`. |
| 2 | S | `components/board/BoardView.tsx:121-243` | `COMPARATORS`/`resolveSortKey`/`liveRank`/`sortItems` live in the view; `test/board.test.tsx:817` admits the render test cannot discriminate implementations | `lib/filterSort.ts:203` (`applyView`) | Move the sort and filter pipeline to `lib/board-sort.ts` and unit-test the comparator table and `liveRank` directly. |
| 3 | M | `components/board/OrchestrateSheet.tsx:117-1191` (14 `useState`, steps inline at `:791`, `:977`, `:1060`) | One 1074-line function mixes draft state, three fetch effects, the start mutation and all three steps' JSX | `components/sessions/views.ts:4` + per-view files; `hooks/useSpawn.ts:33` | Extract a `useOrchestrateDraft` hook (state, effects, `start`) and render `ItemsStep`/`OrderStep`/`ModesStep` as presentational children. |
| 4 | M | `hooks/useBoard.ts:79,96`, `useOrchestratorRuns.ts:284`, `useWatchdog.ts:205`, `useOrchestratorArchive.ts`, `useAgents.ts:66`, `useTrackers.ts:116` | The mount-fetch, focus-refetch, conditional-interval and mounted-guard triad is hand-copied ×6, with no fake-timer-testable core | `lib/gitPoll.ts:25-49` consumed by `hooks/useGitStats.ts:38` | Add a `lib/refresh-schedule.ts` (injected deps, like `startGitPoll`) plus a `useRefreshing(loader, {pollMs, while})` hook, and fold the six onto it. |
| 5 | S | `components/board/OrchestrateSheet.tsx:328,368,402`, `runs/RunDetail.tsx:219-265`, `board/ItemModal.tsx:312`, `board/LaunchSheet.tsx:~50` | One-shot "fetch on key with an `alive` flag" effects are written inside components ×6 | `hooks/useSessionDetail.ts:12`, `hooks/useUsageRates.ts:20` | Add one `useFetched(key, loader)` hook in `hooks/` (it can share #4's core) and replace the six inline effects. |
| 6 | S | `components/RunControls.tsx:123-191`, `board/LaunchSheet.tsx:45,73-92`, `board/OrchestrateSheet.tsx:256,618-720`, `board/ClaimRelease.tsx:28` | The busy/error/`ApiError`-mapping async-action plumbing is repeated ×4 and inconsistent: only RunControls guards double-clicks with a ref | `hooks/useStopSession.ts`, `hooks/useSpawn.ts:33` | Add a `useAction(fn)` hook returning `{run, busy, error}` with the ref guard, so each mutation site keeps only its own code-specific branch. |
| 7 | S | `components/board/BoardView.tsx:776-830` vs `components/board/DispatchButton.tsx:78` | The hide/disable/`aria-busy`/reverify-on-click gate is written twice; the comment says DispatchButton's item-bound signature prevented reuse | `lib/stopControl.ts` (pure render model) + `useStopSession` + an atom | Split DispatchButton into a pure `gateView(reason, verifying)` in `lib/` plus a `GatedChip` in `components/ui/`, used by both. |
| 8 | M | `components/runs/RunDetail.tsx:142-176,318-516` | About 35 derived constants (counts, labels, notes, tones) are assembled in the render body of a single 433-code-line component | `lib/projectsView.ts` (`splitProjects`) driving `management/ProjectsView.tsx:12` | Add a pure `runDetailModel(source, live, now)` in `lib/` returning the header and summary fields, and unit-test it without jsdom. |

Rough total: 4×S, 4×M, no L. Gaps 4 and 5 can share one primitive, and gap 6 is independent of both.

## 4. Where A matches or beats B (not gaps)

- **Shared UI primitives.** A has a real `components/ui/` (19 primitives: `Chip`, `Pill`, `Dot`, `Sheet`, `FormSheet`, `Modal`, `Select`, `Segmented`, `Switch`, `Popover`,
  `Confirm`, `Ledger`, `Meter`, `Figure`...), with `test/ui-sheet.test.tsx` and `test/ui-form-sheet.test.tsx`. B scatters `Popover.tsx`/`Chevron.tsx` at the components root
  and re-declares a `Dot` per feature (`sessions/atoms.tsx:33`). A is ahead here.
- **Fetch functions centralised.** Every A request goes through `lib/agents.ts` with `unwrap`/`ApiError` (`:115-706`); the one exception is `ItemModal.tsx:312`. B calls
  `fetch()` with hand-built headers inside each hook, and once inside a component (`settings/SettingsView.tsx:158`).
- **Settings composition.** A's `settings/SettingsView.tsx` is 281 code lines across 8 in-file components plus `WatchdogGroup.tsx` and `TrackersGroup.tsx`. B's is one
  583-code-line component.
- **Pure-lib depth for the hard domain.** `lib/run-stats.ts`, `run-time.ts`, `run-stage.ts`, `run-watchdog.ts`, `tracker.ts` and `item-*.ts` each have a direct unit test
  (`test/run-stats.test.ts`, `run-time.test.ts`, `run-stage.test.ts`, `run-watchdog.test.ts`, `tracker-lib.test.ts`, `item-*.test.ts`). This is at least B's level.
- **Polling scope.** Polling is one section, one poller, and stops at idle: `useOrchestratorRuns` polls only while something is live (`:284`), and `useBoard` only while
  a tracker syncs (`:96`). B's `useSessions` polls unconditionally at `refreshMs`.
- **Escape ownership.** A has a single Escape owner (`hooks/useDialogEscape.ts`) for its dialog stack; B has `useBackClose`/`lib/backClose.ts` for a comparable concern.
- **Lazy sections and providers.** These are equivalent in both (`App.tsx:13-16` in A, `App.tsx:16-20` in B), with context used only for app-wide settings and one
  domain (Trackers in A, ConfigsScope in B).
- **Prop drilling.** Depth ≤3 and lift-to-shell reporting (`useReportWorking`) mirror B's `onLink`. This is parity.

## 5. Things not to "fix"

- Do not adopt a query-cache library to "match B". B has none, and A's one-poller-per-section with idle-off would need re-deriving under a cache.
- Do not strip comments to shrink files. The density is a documented A convention, and on code lines the files are already within B's range.
- Any refactor that moves a derivation must keep `test/claude-rules.test.ts` anchors and DESIGN.md citations intact, and new `ui/` primitives must cite their §8
  subsection.
