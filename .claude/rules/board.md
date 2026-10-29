---
paths: ["client/src/**"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **A starting entry blocks what a run file blocks, on every surface** (bug-21). `runClaimBlock` (`shared/agent.ts`) takes `starting` as a required third
  parameter, no `[]` default; the block is project-wide and deliberately coarse; the toolbar Orchestrate control hides on it; `POST /api/agents/orchestrate`
  refuses a starting project with the same `RUN_IN_PROGRESS_CODE`. `runHoldsItem` deliberately does NOT gain the parameter. Why:
  [invariants.md](docs/subsystems/invariants.md#a-starting-entry-blocks-what-a-run-file-blocks-bug-21)
- **Escape has one owner, and the topmost dialog is the only one that closes.** `hooks/useDialogEscape.ts` is a module-level LIFO stack plus a single `window`
  listener; eight dialogs are on it — the item modal, `LaunchSheet`, `OrchestrateSheet`, since Jira phase 2 `JiraIssueModal` and `JiraBoardSheet`, since the
  release chip `ReleasesDrawer`, since Jira phase 5 `JiraLaunchSheet`, and since the Dashboards page's add/edit sheet `DashboardSheet` — and
  none binds its own (bug-23 — four until task-37 took the run drawer off the Board, whose content is the Runs page's inline detail sheet and never a dialog
  again; three from then until Jira phase 2). Since task-40 the hook is called by the overlay shells (`ui/Modal.tsx`, `ui/FormSheet.tsx`), not by the
  surfaces themselves: `Modal`'s composers are `ItemModal` and `JiraIssueModal`, `FormSheet`'s are `LaunchSheet`, `OrchestrateSheet`, `JiraBoardSheet`, `JiraLaunchSheet` and `DashboardSheet`,
  so the three Jira surfaces and the Dashboards sheet joined by construction (`JiraLaunchSheet` is hosted once, in `JiraView`, and ranks above the issue modal because it MOUNTS later — it always opens while the modal is up — not because of its place in the JSX). `ReleasesDrawer` is the exception: its shell is ui-kit's since #298, so the wrapper calls the hook itself
  and passes `closeOnEscape={false}`, and ui-kit's drawer binds no key of its own. One further entry is not a dialog: `ui/Confirm.tsx` (bug-53), the inline confirmation the run's Stop, the
  item modal's claim release (#225), the board sheet's `Delete board`, the Skills card's `×` (`JiraSkillsGroup`), the Jira modal's `Stop session` and GitHub › PRs' `Merge` (`PrRow`) open, joins the stack while it is drawn, so Escape dismisses it and nothing under it
  — it paints no scrim and is not counted. The second is `ui/Popover.tsx`, with seven composers — the tracker's (`components/TrackerChip.tsx`), the band's
  Filters and Sort, the Jira chip's (`components/JiraChip.tsx`), the Jira board's picker (`components/jira/JiraBoardView.tsx`), the board sheet's roots
  search (`components/jira/JiraBoardSheet.tsx`) and `Run ▾`'s panel (`components/jira/JiraRunMenu.tsx`); the Jira board's Filters are `FilterBar`'s own — mounted only while open, which joins the same way and closes
  only itself; its click-outside is its own `pointerdown` listener, since the stack owns the key and not the pointer. Still eight dialogs counted.
  Ranking is by mount order; entries are removed by identity, never popped.
  Why:
  [invariants.md](docs/subsystems/invariants.md#escape-has-one-owner-and-the-topmost-dialog-is-the-only-one-that-closes)
- **ui-kit draws the version chip and the What's new drawer; this board only maps its tokens and places the chip.** Since ui-kit v0.3.0 every shape of the chip and the drawer — size, radius, spacing, the phone layout, the badge and baseline drawing — is
  ui-kit's, so the board's look matches the other two apps. `client/src/styles.css` carries the `--uk-*` mapping block and `.rail-release`, a wrapper that
  places `VersionChip` and styles nothing of it (the chip takes no `className`); a rule that restyles a `.uk-*` class, or sets a `--uk-*` property that is not
  one of the kit's public tokens, fails `test/ui-kit-guard.test.ts` (`ui-kit/guard`'s `checkHostCss` over every sheet this board ships, listed there so a new one
  is a deliberate add). The guard cannot see an unmapped token, so the same suite asserts the mapping sets `--uk-chip-bg` (the pill's well, per palette) and
  `--uk-zoom` (`--font-scale`, so the drawer fits the screen at any text size), and `test/ui-kit-tokens.test.ts` holds every token the kit reads to being mapped.
  The narrow chip's 44 px hit area overhangs the pill by 8 px, so no ancestor of `.rail-release` may clip (`overflow: hidden`/`clip`). Notes render through the
  kit's own `renderNotesHtml`; the wrapper passes no `renderNotes`. Why: [invariants.md](docs/subsystems/invariants.md#ui-kit-draws-the-version-chip-and-the-whats-new-drawer-this-board-only-maps-its-tokens-and-places-the-chip)
- **The strip's height and the well's gap are one token, `--main-gap`, read by the strip and the Runs page — never a px literal.** `--main-gap` is declared on
  `:root` (`50px`) and overridden to `0px` in the 700 px block, where `.topstrip` is `display: none`; `.topstrip`'s height is `var(--main-gap)`,
  `.runs-board`'s height subtracts it, and `.main` carries no `margin-top` (the strip IS the gap). `App.tsx` renders the tracker chip in ONE of two homes
  chosen by `useNarrow` — `.topstrip`, or `SideRail`'s `chipSlot` in the phone bar — never both hidden by CSS. Design guard 9 (`test/design-guards.test.ts`)
  pins the two declarations and the two readers. Why:
  [invariants.md](docs/subsystems/invariants.md#the-strips-height-and-the-wells-gap-are-one-token)
- **Board-versus-Archive is derived from `updated ?? lastCommit ?? created` and the run payload, never stored.** `isStale`/`leavesBoard`
  (`client/src/lib/item-stale.ts`) are the one implementation and `lastTouched` (`client/src/lib/item-touched.ts`) the one precedence; both predicates take
  `runs`, required, no `[]` default. Five rules no caller may re-decide: in progress is never stale; held by a fresh run (`runHoldsItem`) is never stale; done
  or rejected is never stale; unparseable or absent stamps read as fresh; a task never leaves the Board, it gains a `stale` marker. `staleDays` (default 30)
  clamps to the DEFAULT below `min`, never to the bound. Why:
  [invariants.md](docs/subsystems/invariants.md#board-versus-archive-is-derived-and-last-touched-has-three-rungs)
- **Settings is three pages, the page is the scope, and the rail is the only thing that switches them.** `settingsScope` (`client/src/lib/settings.ts`) is
  `local | shared | dashboards`: Local is this browser's `localStorage`, Shared and Dashboards are what the API reads off the host (Dashboards is the machine
  list and each machine's health and usage, its own page since they outgrew a card; its scope pill reads `this machine`, as Shared's does). No card mixes local
  and host — which is why `Claude Agents` was two cards and why `open dashboard ↗` sits beside the per-device field supplying its href — and there is no in-page
  switch at any width, the same rule Runs' three pages follow, and Jira's since phase 2. A host card may also sit on a source's own settings page — GitHub ›
  Settings' `Sync` (each repo's sync interval), as Jira › Setup holds `jira.json`'s — and Shared draws the read-only `Sources` card alone in its left column,
  Watchdog, Tick and Time zone in its right. One `RailTree` renders every tree — Files, GitHub, Jira, Runs and Settings, five call sites; `SECTIONS`/`Section`
  live in `client/src/lib/sections.ts` because the rail reading `useSettings` closed a cycle with `lib/settings.ts`. Why:
  [invariants.md](docs/subsystems/invariants.md#settings-is-three-pages-the-page-is-the-scope)
- **The Jira section's two pages are switched by the rail's tree, or a link threaded down from it, never by an in-page control; the section is drawn only when
  `GET /api/jira` says configured.** `jira` sits in `SECTIONS` (`lib/sections.ts`) between `github` and `runs` UNCONDITIONALLY — `resolveLegacySection`
  (`lib/source-page.ts`) runs in a `useState` initializer, before the status exists — and the conditional half is the shell's alone. `SideRail`'s `drawn` skips
  the row unless the shell's one `useJira` (`JiraProvider`) says `configured: true`, or the status is unknown (`data` null) while `jira` is the section on
  screen. `App`'s hold-and-fall effect moves a `jira` section, through `change`, on `configured === false` and on nothing else — to `firstDrawn`
  (`lib/sources.ts`) of the projects answer, or to the provisional `FALLBACK_SECTION` while that answer is unknown, for the settle to correct; unknown holds,
  drawn in `JiraView`'s `loading…` or `Jira unavailable` shape. The page is `JIRA_PAGES` (`board | setup`), `JIRA_PAGE_KEY` and `isJiraPage` in
  `lib/jira-page.ts`, held by `hooks/useJiraPage.ts` — `useRunsMode`'s module store, because the rail's `RailTree` and the in-page links are two mounted
  writers. The links (`Open board` on Setup's Boards rows, `Open Setup` on the empty board) are `onOpenJiraPage`, built once in `App` as `setJiraPage(p)` then
  `change('jira')` and handed down through `JiraView`; the Sources card's `Jira › Setup ↗` link is the same pair, threaded `App` → `SettingsView` → `SharedPage`
  → `SourcesGroup` and drawn only while configured; no page or the chip's popover draws a switch of its own. Settings' `Opens on` offers `Jira` only while
  configured (`landingOptions`), keeping a stored `jira` pin's option; a `landing: 'jira'` takes the same fall. Why:
  [invariants.md](docs/subsystems/invariants.md#the-jira-sections-two-pages-are-switched-by-the-rails-tree-and-the-section-is-drawn-only-when-configured)
- **A source row (Files, GitHub) is drawn only while a registered project has that source, and its pages are switched by the rail's tree or a link threaded down
  from it.** `files` and `github` sit in `SECTIONS` UNCONDITIONALLY and whether a row draws is the projects answer's: `ProjectsProvider`
  (`hooks/ProjectsContext.tsx`) is the shell's one read of `GET /api/projects`, through `useRefreshing` with no `armed` (mount + focus), keeping the last answer
  on a failure, and its `drawn` (`drawnSources`, `lib/sources.ts`) is `null` while unknown. `sourceSectionOf` puts `github` under GitHub and `files`,
  `unsupported` and a null source under Files — display grouping only, never a source of its own. `SideRail`'s `drawn` takes a source row when `drawn[id]` is
  true, or while the answer is unknown and that section is on screen and not `provisional`. `resolveLegacySection` (`lib/source-page.ts`) maps a stored
  `board`/`archive` to `github` with that page and anything unrecognised to `FALLBACK_SECTION` (`github`) with none, both provisional. `App` moves nothing while
  `drawn` is null; once it is known a provisional landing settles once, through `change` (`settleSection` for a page-named one, `firstDrawn` — Files, then
  GitHub, else Runs — otherwise), a legacy pin is rewritten to where it settled with `update({ landing })`, and a source section whose row is gone falls to
  `firstDrawn`; a provisional landing renders `SectionLoading` until it settles. The pages are `FILES_PAGES` (`board | archive`) and `GITHUB_PAGES` (`board |
  prs | archive | settings`), each with its key and guard, held by `useFilesPage`/`useGithubPage` (`hooks/useSourcePage.ts`), module stores like `useJiraPage`'s; the
  Sources card's `GitHub › Settings ↗` link is `onOpenGithubPage` (`setGithubPage(p)` then `change('github')`, built once in `App`), drawn only while
  `useProjectsContext().drawn?.github` — the rail's answer, never the tracker counts. Board and Archive take a required `source` and cut the index with
  `narrowToSource`, which routes each index error by `errorSource`: a `gh:` issue URN to GitHub, a registered project's path (longest, on a `/` or `:`
  boundary) to that project's source, anything else to Files; an empty cut reads `nothing registered yet` only with no project of that source, else
  `no items yet`. Hues come from the whole registry, and the project filter key is per source (`projectKey`, `lib/view-keys.ts`). Settings' `Opens on` offers
  Files and GitHub only while drawn (`landingOptions`), keeping a stored pin's option. Why:
  [invariants.md](docs/subsystems/invariants.md#a-source-row-is-drawn-only-while-a-registered-project-has-that-source-and-its-pages-are-switched-by-the-rails-tree)
- **`contentWidth` is stamped before first paint, and the CSP hash travels with the script that stamps it.** `data-width` on `<html>`, written twice — by
  `client/index.html`'s inline script and by `useSettings`, whose dependency list must carry it or the setting works on reload and not on the click. One CSS
  block releases `.wrap` **and** `.wrap.wide`; the cap goes, the `margin: 0` stays. Editing that script invalidates `THEME_SCRIPT_SHA256`
  (`server/src/security.ts`), and dev has no CSP, so the failure is invisible until the built app is served. Why:
  [invariants.md](docs/subsystems/invariants.md#contentwidth-is-stamped-before-first-paint-and-the-csp-hash-travels-with-it)
- **An environment-level block hides the dispatch control; the per-item ones disable it.** With `BM_AGENTS` off the Board shows no dispatch buttons — do not
  "improve" that into disabled buttons. The stated exception is the Jira card's `Run ▾`, which is not a Board dispatch control (next bullet). Five per-item blocks keep their button, read by `DispatchButton` in this order: project visibility (`dispatchGate`), a
  local session's `started:` stamp (`progressBlock`, `client/src/lib/item-progress.ts` — ANY stamp, fresh or stale, for a files item; a tracker claim past
  `CLAIM_STALE_MS` lets the click through unless a run or the board's own session holds it, #227), an open PR (`inReviewBlock`, `shared/agent.ts` — a
  tracker issue labelled `in-review`; the server's `plan`/`dispatch` read the same helper), an outsider's issue no groom of ours has pinned
  (`unvettedBlock`, `shared/agent.ts` — `BacklogItem.unvetted`, #341; after in-review and before plan-review, here and in both server ladders), an
  orchestrator claim (`runClaimBlock`).
  Exactly one lets the click through, and only when it speaks alone: the visibility block re-asks the status through `useReverify`
  (`client/src/hooks/useReverify.ts`), whose one caller is `GatedChip` (`components/ui/GatedChip.tsx`, rule in `lib/gate-view.ts`), which `DispatchButton` and
  the toolbar Orchestrate control both compose (bug-13, bug-16, #272); the other blocks keep swallowing it. The plan-review rung (`planReviewBlock`, after
  in-review) is the one that changes the button rather than disabling it, and only on the card: given `onReview`, it draws `Review plan`, which opens the item
  (#367) — never while the unvetted rung speaks, since approving a plan does not vet it. Why:
  [invariants.md](docs/subsystems/invariants.md#environment-level-blocks-hide-the-dispatch-control-per-item-ones-disable-it)
- **Run ▾ on a Jira card is never hidden for the dashboard's sake: Copy prompt is its second exit, and only Start hides.** `JiraRunMenu`
  (`components/jira/JiraRunMenu.tsx`) is one component for the card's marker row and the issue modal's controls row, and it reads `runChipState` (`lib/jira.ts`)
  alone: `no-repo` draws a dashed chip that opens nothing, a live key a disabled one, anything else a `Popover` — and with agents off it still draws and still
  opens, because the launch sheet's `Copy prompt` needs no dashboard. `JiraLaunchSheet` asks `projectDispatchGate` and draws `Start` only on a `disabled` or
  `enabled` answer, never on `hidden`, and draws none before the agents status has landed; `Copy prompt` waits on the preview and a clipboard and on nothing
  else. Do not hide `Run ▾` on `BM_AGENTS` off to match the Board's buttons. Why:
  [invariants.md](docs/subsystems/invariants.md#run--on-a-jira-card-is-never-hidden-for-the-dashboards-sake)
- **A crashed run renders as crashed, never as nothing.** The Board counts it in `RunChip`'s own line (`1 run · crashed ›`) and says nothing the payload does
  not carry; badges, card live strips and `runClaimBlock` stay freshness-based. The Runs page reads the same payload (bug-29): `MergedRun.live` is the data
  authority, `MergedRun.isLive` the presentation gate; both status badges read `crashed` through `runStatusChip` (`lib/run-stage.ts`), never from `authority`,
  and the dot beside each reads `runDotTone` (same file). A crashed run is a **Live sheet row** and never a History one — which sheet a row is in is
  `splitLive`'s call on `running`/`paused` presence, freshness deliberately excluded — and its three readings (`no heartbeat for <age>`,
  `last reported <id> at <stage>` or `all items at rest`, `watchdogClause`) travel in one element or the row says less than the strip it replaced. `crashed` is
  **not** a sixth `RunStatus`. Why: [invariants.md](docs/subsystems/invariants.md#a-crashed-run-renders-as-crashed-never-as-nothing)
- **`useOrchestratorRuns` polls while any run is `running`, fresh or not** — and, since task-48, while any REMOTE run is `running`, which is the only way this
  machine sees another's progress, and, since multi-dashboard, while `remoteStarting` is non-empty, so a `Starting on <machine>` row disappears when its entry
  clears and not when something else wakes the poll — through the same single coalesced request, never a second one in flight. Why:
  [invariants.md](docs/subsystems/invariants.md#a-crashed-run-renders-as-crashed-never-as-nothing)
- **The board offers a hand resume exactly when the watchdog will not spawn one — absent a stop request, which suppresses both sides — and that is one
  function, not two agreeing expressions.** `watchdogStoodDown`
  (`shared/agent.ts`) is read by `watchdog.service.ts`'s `visit()` and by whichever surface offers the click — `RunStrip` until task-37, NOTHING in between, and
  `RunControls` from task-38, which is ONE reader for both surfaces that offer it (the Runs detail head and the Watchdog page's rows draw the same component, so
  `WatchdogMonitor` must never call the predicate itself). `test/watchdog-coupling.test.tsx`'s reader list is an exact set for that reason. Its three inputs
  `spawningEnabled()`, `watchdogExhausted` (`attempts >= maxAttempts`) and bug-35's `watchdogFailing` (`consecutiveFailures >= maxAttempts`) are single
  implementations too, all three DERIVED and never stored; `failing` is a REQUIRED property with no default, so a caller cannot opt out of the third and put
  the board back to offering Resume while the sweeper still spawns. Pinned by
  `test/watchdog-coupling.test.tsx` and `test/watchdog-sweep.test.ts` driving both sides from one table of hand-checked verdicts. Why:
  [invariants.md](docs/subsystems/invariants.md#the-resume-coupling-the-board-offers-a-hand-resume-exactly-when-the-sweeper-will-not)
- **The launch sheet's model/effort pickers seed from Settings, never the last launch** (`dispatchDefaultModel` / `dispatchDefaultEffort` in
  `client/src/lib/settings.ts`, clamped against `MODELS`/`EFFORTS`). Permission mode has no stored default — it comes from `plan.defaultMode`, clamped to the
  host ceiling. The execute sheet's Finish picker seeds the same way from `executeDefaultFinish` (clamped by `pickOne` over `EXECUTE_FINISHES`), and its Base
  select seeds to the literal `main` every open — a base is never stored. Why:
  [invariants.md](docs/subsystems/invariants.md#launch-sheet-modeleffort-pickers-seed-from-settings-never-the-last-launch)
- **"Queue wait is not work."** `itemDurationMs` (`client/src/lib/run-time.ts`) is the one implementation of "how long did this item take"; machine time
  (`runStageTotals`) excludes `pending` too; `MACHINE_STAGES` is the closed list of what counts. Why:
  [invariants.md](docs/subsystems/invariants.md#queue-wait-is-not-work)
- **A client poller built on `useCoalescedFetch` never has two of its own requests in flight: its timer is armed by an answer, and a trigger that lands
  mid-flight folds into one follow-up (`useTrackers` and `useJira` are the deliberate exceptions, #231).** `lib/coalesced-poll.ts` (`createCoalescedPoll`, pure
  of React) is the one home of poll scheduling and `hooks/useCoalescedFetch.ts` is its React shell; `hooks/useRefreshing.ts` (#285) is the layer every board
  poller enters through — `useBoard`, `useAgents`, `useOrchestratorRuns`, `useWatchdog`, `useTicks`, `useOrchestratorArchive`, `TimeZoneProvider` (#241) and
  `ProjectsProvider` (no `armed`: none of the three polls) and `useMachines` (60 s, mounted only by Settings › Dashboards, so its `armed` is constant `true`) and `usePullRequests` (60 s, mounted by GitHub › PRs and by GitHub › Settings' Access card, same constant `armed` — the server's PR cache has no timer, so those two mounts are the only things that ever read PRs) — owning the
  mount + window-focus triggers once; no board poller is a `setInterval` (`useNow`'s clock tick is a display, not a request). `trigger()` while idle starts the task; while one is in flight it starts nothing and returns ONE queued follow-up's promise, shared
  by every trigger that arrived meanwhile and run when the flight settles, so its answer was requested after the caller asked. The timer is a `setTimeout`
  re-armed `intervalMs` after the LAST request of a chain settles, at most one pending, cleared the moment `armed` goes false (an in-flight request finishes;
  nothing re-arms after it) and on unmount, which also drops a queued follow-up. `armed`
  stays each hook's OWN condition for "something is moving" — `useOrchestratorRuns`'s live/remote/starting/grace test, `useBoard`'s `hasSyncingTracker`, the
  watchdog's `live` (its sweeper's phase picks only the period, 5 s armed and 15 s otherwise, #270) — and `useAgents` passes none (mount, focus and the
  explicit `reload`, coalesced). A hook still guards the state its settled request
  sets with `useMountedRef`. `useTrackers` is the deliberate exception, and the rule is scoped to the hooks built on this for it: its timer chases the server's
  own poll clock, and a focus refetch, the timer's read and `saveInterval`'s refetch CAN overlap — it guards writes by sequence number (only the newest read may
  write) instead of preventing the overlap (#231). `useJira` (`hooks/useJira.ts`) is the second exception, the same shape on the same counter: its timer is
  aimed at the soonest board's next sweep (`polledAt + interval + TRACKER_FETCH_SLACK_MS`, floored at `JIRA_STATUS_FLOOR_MS`), no timer while unconfigured or
  with no syncing board, and focus, timer and a Setup save's `reload` may overlap. `useJiraBoard` IS built on `useCoalescedFetch`. Why:
  [invariants.md](docs/subsystems/invariants.md#a-client-poller-built-on-usecoalescedfetch-never-has-two-of-its-own-requests-in-flight)
