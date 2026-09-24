---
paths: ["client/src/**"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **A starting entry blocks what a run file blocks, on every surface** (bug-21). `runClaimBlock` (`shared/agent.ts`) takes `starting` as a required third
  parameter, no `[]` default; the block is project-wide and deliberately coarse; the toolbar Orchestrate control hides on it; `POST /api/agents/orchestrate`
  refuses a starting project with the same `RUN_IN_PROGRESS_CODE`. `runHoldsItem` deliberately does NOT gain the parameter. Why:
  [invariants.md](docs/subsystems/invariants.md#a-starting-entry-blocks-what-a-run-file-blocks-bug-21)
- **Escape has one owner, and the topmost dialog is the only one that closes.** `hooks/useDialogEscape.ts` is a module-level LIFO stack plus a single `window`
  listener; three dialogs are on it — the item modal, `LaunchSheet`, `OrchestrateSheet` — and none binds its own (bug-23 — four until task-37 took the run
  drawer off the Board, whose content is the Runs page's inline detail sheet and never a dialog again). Since task-40 the hook is called by the two overlay
  shells (`ui/Modal.tsx`, `ui/FormSheet.tsx`), not by the three surfaces themselves. One further entry is not a dialog: `ui/Confirm.tsx` (bug-53), the inline
  confirmation the run's Stop and the item modal's claim release (#225) open, joins the stack while it is drawn, so Escape dismisses it and nothing under it —
  it paints no scrim and is not counted. Ranking is by mount order; entries are removed by identity, never popped.
  Why:
  [invariants.md](docs/subsystems/invariants.md#escape-has-one-owner-and-the-topmost-dialog-is-the-only-one-that-closes)
- **Board-versus-Archive is derived from `updated ?? lastCommit ?? created` and the run payload, never stored.** `isStale`/`leavesBoard`
  (`client/src/lib/item-stale.ts`) are the one implementation and `lastTouched` (`client/src/lib/item-touched.ts`) the one precedence; both predicates take
  `runs`, required, no `[]` default. Five rules no caller may re-decide: in progress is never stale; held by a fresh run (`runHoldsItem`) is never stale; done
  or rejected is never stale; unparseable or absent stamps read as fresh; a task never leaves the Board, it gains a `stale` marker. `staleDays` (default 30)
  clamps to the DEFAULT below `min`, never to the bound. Why:
  [invariants.md](docs/subsystems/invariants.md#board-versus-archive-is-derived-and-last-touched-has-three-rungs)
- **Settings is two pages, the page is the scope, and the rail is the only thing that switches them.** `settingsScope` (`client/src/lib/settings.ts`) is
  `local | shared`: Local is this browser's `localStorage`, Shared is what the API reads off the host. No card mixes the two — which is why `Claude Agents` is
  two cards and why `open dashboard ↗` sits beside the per-device field supplying its href — and there is no in-page switch at any width, the same rule Runs'
  two pages follow. One `RailTree` renders both trees; `SECTIONS`/`Section` live in `client/src/lib/sections.ts` because the rail reading `useSettings` closed a
  cycle with `lib/settings.ts`. Why:
  [invariants.md](docs/subsystems/invariants.md#settings-is-two-pages-the-page-is-the-scope)
- **`contentWidth` is stamped before first paint, and the CSP hash travels with the script that stamps it.** `data-width` on `<html>`, written twice — by
  `client/index.html`'s inline script and by `useSettings`, whose dependency list must carry it or the setting works on reload and not on the click. One CSS
  block releases `.wrap` **and** `.wrap.wide`; the cap goes, the `margin: 0` stays. Editing that script invalidates `THEME_SCRIPT_SHA256`
  (`server/src/security.ts`), and dev has no CSP, so the failure is invisible until the built app is served. Why:
  [invariants.md](docs/subsystems/invariants.md#contentwidth-is-stamped-before-first-paint-and-the-csp-hash-travels-with-it)
- **An environment-level block hides the dispatch control; the per-item ones disable it.** With `BM_AGENTS` off the board shows no dispatch buttons — do not
  "improve" that into disabled buttons. Three per-item blocks keep their button, read by `DispatchButton` in this order: project visibility (`dispatchGate`), a
  local session's `started:` stamp (`progressBlock`, `client/src/lib/item-progress.ts` — ANY stamp, fresh or stale), an orchestrator claim (`runClaimBlock`).
  Exactly one lets the click through: the visibility block re-asks the status through `useReverify` (`client/src/hooks/useReverify.ts`), which the toolbar
  Orchestrate control shares (bug-13, bug-16); the other two keep swallowing it. Why:
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
