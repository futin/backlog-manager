---
paths: ["client/src/**"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **A starting entry blocks what a run file blocks, on every surface** (bug-21). `runClaimBlock` (`shared/agent.ts`) takes `starting` as a required third
  parameter, no `[]` default; the block is project-wide and deliberately coarse; the toolbar Orchestrate control hides on it; `POST /api/agents/orchestrate`
  refuses a starting project with the same `RUN_IN_PROGRESS_CODE`. `runHoldsItem` deliberately does NOT gain the parameter. Why:
  [invariants.md](docs/subsystems/invariants.md#a-starting-entry-blocks-what-a-run-file-blocks-bug-21)
- **Escape has one owner, and the topmost dialog is the only one that closes.** `hooks/useDialogEscape.ts` is a module-level LIFO stack plus a single `window`
  listener; six dialogs are on it — the item modal, `LaunchSheet`, `OrchestrateSheet`, since Jira phase 2 `JiraIssueModal` and `JiraBoardSheet`, and since the
  release chip `ReleasesDrawer` — and
  none binds its own (bug-23 — four until task-37 took the run drawer off the Board, whose content is the Runs page's inline detail sheet and never a dialog
  again; three from then until Jira phase 2). Since task-40 the hook is called by the overlay shells (`ui/Modal.tsx`, `ui/FormSheet.tsx`, and `ui/Drawer.tsx`, whose one composer is `ReleasesDrawer`), not by the
  surfaces themselves: `Modal`'s composers are `ItemModal` and `JiraIssueModal`, `FormSheet`'s are `LaunchSheet`, `OrchestrateSheet` and `JiraBoardSheet`, so
  the two Jira surfaces joined by construction. One further entry is not a dialog: `ui/Confirm.tsx` (bug-53), the inline confirmation the run's Stop, the
  item modal's claim release (#225) and the board sheet's `Delete board` open, joins the stack while it is drawn, so Escape dismisses it and nothing under it
  — it paints no scrim and is not counted. The second is `ui/Popover.tsx`, with six composers — the tracker's (`components/TrackerChip.tsx`), the band's
  Filters and Sort, the Jira chip's (`components/JiraChip.tsx`), the Jira board's picker (`components/jira/JiraBoardView.tsx`) and the board sheet's roots
  search (`components/jira/JiraBoardSheet.tsx`); the Jira board's Filters are `FilterBar`'s own — mounted only while open, which joins the same way and closes
  only itself; its click-outside is its own `pointerdown` listener, since the stack owns the key and not the pointer. Still six dialogs counted.
  Ranking is by mount order; entries are removed by identity, never popped.
  Why:
  [invariants.md](docs/subsystems/invariants.md#escape-has-one-owner-and-the-topmost-dialog-is-the-only-one-that-closes)
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
- **Settings is two pages, the page is the scope, and the rail is the only thing that switches them.** `settingsScope` (`client/src/lib/settings.ts`) is
  `local | shared`: Local is this browser's `localStorage`, Shared is what the API reads off the host. No card mixes the two — which is why `Claude Agents` is
  two cards and why `open dashboard ↗` sits beside the per-device field supplying its href — and there is no in-page switch at any width, the same rule Runs'
  two pages follow, and Jira's since phase 2. One `RailTree` renders every tree — Runs, Jira and Settings, three call sites; `SECTIONS`/`Section` live in
  `client/src/lib/sections.ts` because the rail reading `useSettings` closed a
  cycle with `lib/settings.ts`. Why:
  [invariants.md](docs/subsystems/invariants.md#settings-is-two-pages-the-page-is-the-scope)
- **The Jira section's two pages are switched by the rail's tree, or a link threaded down from it, never by an in-page control; the section is drawn only
  when `GET /api/jira` says configured.** `jira` sits in `SECTIONS` (`lib/sections.ts`) between `archive` and `settings` UNCONDITIONALLY — `resolveSection`
  runs in a `useState` initializer, before the status exists — and the conditional half is the shell's alone. `SideRail`'s `drawn` skips the row unless the
  shell's one `useJira` (`JiraProvider`) says `configured: true`, or the status is unknown (`data` null) while `jira` is the section on screen. `App`'s
  hold-and-fall effect moves a `jira` section to `board`, through `change`, on `configured === false` and on nothing else; unknown holds, drawn in
  `JiraView`'s `loading…` or `Jira unavailable` shape. The page is `JIRA_PAGES` (`board | setup`), `JIRA_PAGE_KEY` and `isJiraPage` in `lib/jira-page.ts`,
  held by `hooks/useJiraPage.ts` — `useRunsMode`'s module store, because the rail's `RailTree` and the in-page links are two mounted writers. The links
  (`Open board` on Setup's Boards rows, `Open Setup` on the empty board) are `onOpenJiraPage`, built once in `App` as `setJiraPage(p)` then `change('jira')`
  and handed down through `JiraView`; no page, the chip's popover or the Trackers row's `Jira › Setup` text draws a switch of its own. Settings' `Opens on`
  offers `Jira` only while configured (`landingOptions`), keeping a stored `jira` pin's option; a `landing: 'jira'` takes the same fall. Why:
  [invariants.md](docs/subsystems/invariants.md#the-jira-sections-two-pages-are-switched-by-the-rails-tree-and-the-section-is-drawn-only-when-configured)
- **`contentWidth` is stamped before first paint, and the CSP hash travels with the script that stamps it.** `data-width` on `<html>`, written twice — by
  `client/index.html`'s inline script and by `useSettings`, whose dependency list must carry it or the setting works on reload and not on the click. One CSS
  block releases `.wrap` **and** `.wrap.wide`; the cap goes, the `margin: 0` stays. Editing that script invalidates `THEME_SCRIPT_SHA256`
  (`server/src/security.ts`), and dev has no CSP, so the failure is invisible until the built app is served. Why:
  [invariants.md](docs/subsystems/invariants.md#contentwidth-is-stamped-before-first-paint-and-the-csp-hash-travels-with-it)
- **An environment-level block hides the dispatch control; the per-item ones disable it.** With `BM_AGENTS` off the board shows no dispatch buttons — do not
  "improve" that into disabled buttons. Three per-item blocks keep their button, read by `DispatchButton` in this order: project visibility (`dispatchGate`), a
  local session's `started:` stamp (`progressBlock`, `client/src/lib/item-progress.ts` — ANY stamp, fresh or stale, for a files item; a tracker claim past
  `CLAIM_STALE_MS` lets the click through unless a run or the board's own session holds it, #227), an orchestrator claim (`runClaimBlock`).
  Exactly one lets the click through, and only when it speaks alone: the visibility block re-asks the status through `useReverify`
  (`client/src/hooks/useReverify.ts`), whose one caller is `GatedChip` (`components/ui/GatedChip.tsx`, rule in `lib/gate-view.ts`), which `DispatchButton` and
  the toolbar Orchestrate control both compose (bug-13, bug-16, #272); the other blocks keep swallowing it. Why:
  [invariants.md](docs/subsystems/invariants.md#environment-level-blocks-hide-the-dispatch-control-per-item-ones-disable-it)
- **A crashed run renders as crashed, never as nothing.** The Board counts it in `RunChip`'s own line (`1 run · crashed ›`) and says nothing the payload does
  not carry; badges, card live strips and `runClaimBlock` stay freshness-based. The Runs page reads the same payload (bug-29): `MergedRun.live` is the data
  authority, `MergedRun.isLive` the presentation gate; both status badges read `crashed` through `runStatusChip` (`lib/run-stage.ts`), never from `authority`,
  and the dot beside each reads `runDotTone` (same file). A crashed run is a **Live sheet row** and never a History one — which sheet a row is in is
  `splitLive`'s call on `running`/`paused` presence, freshness deliberately excluded — and its three readings (`no heartbeat for <age>`,
  `last reported <id> at <stage>` or `all items at rest`, `watchdogClause`) travel in one element or the row says less than the strip it replaced. `crashed` is
  **not** a sixth `RunStatus`. Why: [invariants.md](docs/subsystems/invariants.md#a-crashed-run-renders-as-crashed-never-as-nothing)
- **`useOrchestratorRuns` polls while any run is `running`, fresh or not** — and, since task-48, while any REMOTE run is `running`, which is the only way this
  machine sees another's progress. Why:
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
  host ceiling. Why: [invariants.md](docs/subsystems/invariants.md#launch-sheet-modeleffort-pickers-seed-from-settings-never-the-last-launch)
- **"Queue wait is not work."** `itemDurationMs` (`client/src/lib/run-time.ts`) is the one implementation of "how long did this item take"; machine time
  (`runStageTotals`) excludes `pending` too; `MACHINE_STAGES` is the closed list of what counts. Why:
  [invariants.md](docs/subsystems/invariants.md#queue-wait-is-not-work)
- **A client poller built on `useCoalescedFetch` never has two of its own requests in flight: its timer is armed by an answer, and a trigger that lands
  mid-flight folds into one follow-up (`useTrackers` and `useJira` are the deliberate exceptions, #231).** `lib/coalesced-poll.ts` (`createCoalescedPoll`, pure
  of React) is the one home of poll scheduling and `hooks/useCoalescedFetch.ts` is its React shell; no board poller is a `setInterval` (`useNow`'s clock tick is
  a display, not a request). `trigger()` while idle starts the task; while one is in flight it starts nothing and returns ONE queued follow-up's promise, shared
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
