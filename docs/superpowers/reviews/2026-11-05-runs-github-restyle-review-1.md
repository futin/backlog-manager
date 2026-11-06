# Plan review 1 — Runs and GitHub restyle (plan 3 of 4)

Plan: `docs/superpowers/plans/2026-11-05-runs-github-restyle.md` (commit `71cfc741`). Spec: `docs/superpowers/specs/2026-11-05-app-restyle-design.md`
§4.6–§4.8, §6, §8, §9, §10. Plan 1 (`2026-11-05-jira-restyle.md`) read for the interfaces this plan consumes; plan 2 (`2026-11-05-jira-rest-restyle.md`)
does not exist yet. Every code claim below was checked against `main` at `71cfc741`.

## Verdict: APPROVE WITH FIXES

No Critical findings. Six Important ones, all fixable in the plan text: one contract the plan takes from an unwritten plan, one layout mechanism left to a
guess, one wrong CSS family name, one spec sentence silently dropped, and two test gaps against the plan's own Review Focus list.

## Checklist

1. **Coverage.** Every spec section in scope maps to a task: §4.6 bullets 1–2 → Task 5, bullets 3–4 → Task 6; §4.7 Watchdog → Task 7, Ticks → Task 8;
   §4.8 Inbox → Tasks 2–3, Matrix and Cards → Task 4, the split Merge → Tasks 1–2; §6 `Squash and merge` → Task 2 (:106-107); §8 "SplitChip reuse",
   "Ticks strip", "Watchdog", "Guards", "Last task is `/ui-verify`" → Tasks 2, 8, 7, every Step 4, Task 10; §9 §8.4.1 / §8.4.2 / §8.11 / §8.7 → Tasks 9
   and 2. §8 "Segmented counts" is plan 2's. One spec sentence has no task and is dropped without saying so (I4).
2. **Values.** Copy strings match the spec (`Idle · nothing to watch`, `Policy in Settings`, `N failures in a row`, `Merge` / `Enable auto-merge` /
   `Disable auto-merge` / `Update branch`, `Auto-merge on`, `Blocked`, `controls live on the machine that ran it`, `PR opened · … · #462`) and the code
   (`checks failing`, `sync off`, `draft` — `prs.ts:93-100,130-137`; `BM_AGENTS off` — `test/watchdog-monitor.test.tsx:188`). One divergence: the spec
   writes `next check in 18 s`, the code and its pinned test write `42s` (`run-watchdog.ts:172-173`, `watchdog-monitor.test.tsx:604`) — see I6.
3. **Reality.** Every cited path, export and line checked: `mergeBlock` :93, `autoMergeBlock` :130, `prChips` :72, `PR_KEYS` :144, `whyLine` :173,
   `defaultMethod` :184 (`prs.ts`); `LEVEL_LABEL` :30, `levelCounts` :163, `primaryKey` :285, `MATRIX_COLUMNS` :299, `matrixCells` :320, `columnCounts`
   :364, `LEVEL_DOT` :374 (`pr-layouts.ts`); `STATUS_ORDER` `runs-list.ts:277`; `itemStageSpans` :123 and `MACHINE_STAGES` :230 (`run-stats.ts`);
   `STAGE_TONE` :52, `stageChipClass` :113, `runStatusChip` :272, `runDotTone` :311 (`run-stage.ts`); `prNumber` :285, `statusNote` :360
   (`run-detail.ts`); `stateLine` :158, `sweepFraction` :202, `WATCHDOG_KIND_TONE` :280 (`run-watchdog.ts`); `CountPair` :196, `LiveRow` :232, the
   machine tile :879-883 (`RunsView.tsx`); `TickRow` :193, `tick-row-halted` :212 (`TickMonitor.tsx`); `omitUpdatingReason` (`PrActions.tsx:52`);
   `.prs-matrix-scroll` (`styles.css:3212`); guard 7 (`design-guards.test.ts:380-396`), `FAMILIES` :323; the `> button` precedent `styles.css:1288`;
   `PINNED` (`daylight-contrast.test.ts:393`); test line cites in `prs-actions` :154-155, `prs-inbox` :90-91/:117/:178/:210/:225/:276, `prs-matrix`
   :111-112/:210-212/:324/:383, `prs-view` :207/:443-450/:475/:502-520/:967-970/:1031, `dialog-count-docs` :87-96, `stage-bars` :28-76, `run-detail`
   :223-226/:970-990/:1168, `runs-view` :1834-1839/:2753, `watchdog-monitor` :512-513/:600-604, `tick-monitor` :277 — all as the plan says. `TickProject.recent`
   is served newest first (`tick.service.ts:155`), `RECENT_MAX = 50` (`tick-state.mjs:18`). One false name: `.prs-card*` (I3). `ui/SplitChip`, `ui/Glyphs`
   and `test/ui-split.test.tsx` do not exist yet — plan 1 Task 1 creates them, correctly cited.
4. **Interfaces.** Within this plan every Consumes is Produced earlier (Task 1 → 2 → 3 → 4; `stagePillTone`, `stateWord`, `tickStrip` each produced in the
   task that uses them). From plan 1: `SplitChip` (`label`, `labelMore`, `dashed`, `disabled`, `size`, `title`, `moreRef`, `open`), `Glyph`, `GlyphName` —
   match plan 1 :55-63. From plan 2: nothing is pinned anywhere (I1).
5. **Order.** No forward dependency. Tasks 5–8 are independent of 1–4; Task 9 after all; Task 10 last. Plan 1–2 prerequisite stated at :15 and :21.
6. **Tests.** Each task's Step 1 cases would fail before its implementation and assert behaviour (names, attributes, posted payloads, widths), not
   internals. Fixtures discriminate (`mergeMain` seven cases with distinct outputs; stage widths 75/25; 15 vs 3 tick entries; `done 3, failed 1`). Review
   Focus 1, 4, 5 have tests (Task 1 `pending + autoMergeAllowed: false`; Task 6 crashed card; Task 8 15 → 12 and 3 → 3). Review Focus 2 and 3 do not
   (I5, I2).
7. **Conventions.** No literal code anywhere; line counts soft (:21); `git add <paths>`, 160 columns, comments at density inherited from plan 1 (:25-26).

**Repo guards.** Guard 7: the plan's structural-selector rule (:27-29) and the `.ui-split-main[aria-disabled]` placement inside the primitives block
(:78) satisfy it. `daylight-contrast` `PINNED`: :30-32 says every new tint selector joins it; `Pill` tones already pinned (`.ui-pill-warn`, `.ui-pill-done`
at :402-403). `run-pulse`: `RunsView.tsx:7-8` is the only Runs caller of `useOrchestratorRuns` / `useReportWorking`; `WatchdogMonitor`, `TickMonitor`
and `RunDetail` call neither (grep), and the plan adds no caller (:34). `dialog-count-docs`: the hook-comment regex at :96 moves with the count (:117).
`watchdog-coupling` :182-205 counts CALLS of `watchdogStoodDown(`, so a comment naming it in `WatchdogMonitor` stays safe (:35 holds). CSP: the only
per-element values are React `style` props (`StageBars.tsx:73` precedent, `Popover.tsx:88`) — :33 holds. `board.md`: no new `ui-*` family outside the
primitives block; Task 2's `.ui-split-main[aria-disabled]` is inside it.

## Important

- **I1 — plan :9, :92, :130, :171, :193, :197, :220 — the names consumed from plan 2 have no pinned contract anywhere.** Plan 2 does not exist; this plan
  reads `runTone` (with the values `green` / `amber` / `grey` / `red` only implied by Task 5–6 test cases :182, :207), `GlyphTile` with `size` 18 / 32, a
  tone that renders `data-tone="red"` (:139) and a glyph name, `Segmented`'s `count` AND a level `Dot` inside an option (:133-134 — today's `Segmented`
  takes `{ value, label: string, disabled }` only, `Segmented.tsx:28`, and spec §4.1 gives it a count, not a dot), and a `ui-stripe` family with `data-tone`
  (:197). Any spelling plan 2 picks that differs breaks Tasks 3–8 at compile time. → Add a "Required from plan 2" block under Global Constraints with exact
  signatures: `runTone(status: OrchestratorRun['status']): 'green' | 'amber' | 'grey' | 'red'`; `GlyphTile({ glyph: GlyphName; tone: …; size: 18 | 32 })`
  rendering `data-tone`; `Segmented` option `count?: number` and whatever carries the level dot (or drop the dot from Task 3 — the spec's tabs have none);
  `.ui-stripe[data-tone]`. Plan 2's author then builds to it.
- **I2 — plan :154-155 and Review Focus 3 (:44-45) — the Matrix Merge menu's escape from `.prs-matrix-scroll` has no mechanism and no test.** `Popover`
  "measures nothing and portals nothing" and expects a `position: relative` parent (`Popover.tsx:24-25`); `.ui-popover` is `position: absolute`
  (`styles.css:3779`); `.prs-matrix-scroll` is `overflow-x: auto` (`styles.css:3212`), which the CSS overflow rules turn into `overflow-y: auto` too — so a
  280 px panel under the last expansion row is clipped and adds a vertical scrollbar to the box. "Render it so the scroll box does not clip it" leaves the
  implementer to choose between restructuring the Matrix (menu hosted outside the scroll box) and giving plan 1's `Popover` a portal mode (which changes
  its click-outside and Escape focus logic). → Pick one in Task 4 (recommended: host the expansion's `PrActions` outside the scroll box, since a portal
  changes plan 1's primitive) and add a structural jsdom case: the open `Merge menu` dialog is not a descendant of `.prs-matrix-scroll`.
- **I3 — plan :147 — `.prs-card*` does not exist.** `grep -c "\.prs-card" styles.css` is 0; Cards is drawn by `.prs-repo`, `.prs-repo-inner`,
  `.prs-repo-head`, `.prs-repo-sub`, `.prs-list`, `.prs-row*`, `.prs-chips`, `.prs-outcome` (`PrCards.tsx:40-126`). → Name those families.
- **I4 — plan :152-157 (Task 4) — spec §4.8's "shows the failing check names" is dropped without saying so.** The server serves no per-check names:
  `PullRequestRow.checks` is a five-value enum (`shared/types.ts:630`) and `PrRepoView.checksDetail` one sentence per repo (:666). The plan is right not to
  build it (spec §2 "no new data on any page"), and Task 9 :260 lists it among the not-built facts for DESIGN.md — but Task 4's implementer reads §4.8 and
  will look for the data. → State in Task 4: "failing check names are not served (`types.ts:630`) and are not built; report as a §4.8 deviation under
  spec §2", so the deviation is reported rather than discovered.
- **I5 — plan :109-118 (Task 2 tests) — Review Focus 2 has no test.** The cases cover passing, pending + allowed, armed and failing, but not armed +
  `syncOff`; `prs-view` :443-450 covers `syncOff` on an UNARMED row only. → Add: an armed PR on a `syncOff` repo — main reads `Auto-merge on #12`,
  `aria-disabled="true"`, `title` `sync off`, click POSTs nothing; the chevron is enabled and opens; `Merge`, `Disable auto-merge` and `Update branch` are
  each `aria-disabled` and described by `sync off`.
- **I6 — plan :223-224 (Task 7) — the countdown is drawn twice and the spec's spelling differs from the code's.** `stateLine` stays as the band sub and
  already reads `armed — watching …, next check in 42s` (`run-watchdog.ts:172-173`, pinned at `watchdog-monitor.test.tsx:604`), while the new band row draws
  `next check in N s` again; the spec writes `next check in 18 s` with a space. → Say which element carries the countdown (keep it in the new band row,
  drop it from the sub or keep the sub verbatim) and that the code's `42s` form wins over the spec's `18 s`, with the :600-604 assertion moved to whichever
  element holds it.

## Minor

- :72-73 — `{merge, <mergeBlock reason or null>}` and `<draft reason>` are not exact values: with a non-empty `methods` the first is `null`
  (`prs.ts:93-100`), the second is `'draft'`. Write them.
- :82 — "the tenth Popover composer": spec §3 calls the Merge menu the ninth and the deck's Open menu the tenth; by §10's order plan 2 lands first, so ten is
  the right final number. One clause saying so saves a reviewer the cross-check.
- :86 — `board.md:20` is the Confirm list (still true: Merge still opens `PrFoot`'s Confirm); the Popover-composer sentence is :21-22.
- :138 — `Needs you 1`: the count's place in the accessible name is plan 2's `Segmented` to define (today's tile reads `1 Needs you`, `prs-inbox` :119);
  say "as plan 2's `Segmented` names it".
- :193 — `runDotTone` returns `'live' | 'paused' | 'crashed' | undefined` (`run-stage.ts:311-314`), a `Dot` tone, not a stripe tone; fine as consumed for
  the detail's `Dot`, but the stripe and state pill tone is `runTone`'s (I1).
- :209 — the `run-detail` fixtures have `base: 'main'`, `prTarget: null`, `prUrl: null` (`run-detail.test.tsx:139-141, 180-182`); the pr-mode case needs its
  own fixture with `base: 'backlog/run-1'`, `prTarget: 'main'`, `prUrl: '…/pull/462'`.
- :210 — "a `merged` pill `data-tone`/class done": `Pill` renders `ui-pill-done` and no `data-tone` (`Pill.tsx:27`); assert the class.
- :217 — `watchdog-state` today wraps the FigureStrip (`WatchdogMonitor.tsx:225`) and `watchdog-phase` sits inside it (:232); `runs-view` :1838-1839 waits
  on `watchdog-phase` then asserts `watchdog-state`. Say which element keeps `watchdog-state` after the split (either keeps that test green).
- :256-258 — §8.4.3 does not name the item stage chip; §8.4.1 item 5 does (`DESIGN.md:338`, "the stage chip (glyph plus the real stage word, toned by
  `STAGE_TONE`…)"). Point the edit there.
- :74 — the `prPills` "unnamed blocked" case needs a fixture with `mergeState: 'blocked'` and no other fact and `checks !== 'pending'`
  (`pr-layouts.ts:87-88`), or `levelFacts` never emits `blocked`.
- :244-245 — the strip's `sr-only` summary `last 12 ticks: N ok, N failed` is drawn for a 3-entry project too; say `last N ticks` or accept the fixed
  wording.

## Parked (autopilot)

- #1: Matrix Merge menu — host outside the scroll box vs a Popover portal mode (recommended: outside; see I2).
