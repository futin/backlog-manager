# Runs and GitHub restyle (History, Watchdog, Ticks, PRs, split Merge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle Runs › History, Runs › Watchdog, Runs › Ticks and GitHub › Pull requests per spec §4.6–§4.8, folding the PR key strip into one split
Merge with a Merge menu, without changing what any write does or which route it posts to.

**Architecture:** Three pure helpers in `client/src/lib/` (`mergeMain`, `checksTone`, `prPills`; `tickStrip`; `stagePillTone`), one optional prop on plan 1's
`ui/SplitChip`, a Merge menu that is the tenth `Popover` composer, and the existing components (`PrActions`, `PrInbox`, `PrMatrix`, `PrCards`, `RunsView`,
`StageBars`, `RunDetail`, `WatchdogMonitor`, `TickMonitor`) re-composed over plans 1–2's primitives, with CSS in `client/src/styles.css`. No server routes.

**Tech Stack:** React + TypeScript (Vite), plain CSS with daylight tokens (`shared/theme.css`), jest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-11-05-app-restyle-design.md` §4.6, §4.7, §4.8, §6, §8, §9 (plan 3 of 4, §10). Runs after plans 1 and 2 on the same branch.
Mocks: `docs/superpowers/specs/2026-11-05-jira-restyle-mockups/` — `Runs.dc.html`, `RunsOps.dc.html`, `PRs.dc.html`, `PRsLayouts.dc.html` — and
`00-mock-audit.md` ("Round 2") for what each draws that is NOT built.

**How to read this plan (override of writing-plans' code-block rule).** This plan gives behaviour, names, signatures, exact values and exact test CASES —
never literal code. Write the code and the test bodies yourself; if a case here looks wrong against the code, say so in your report rather than transcribe
it. Line counts are soft. Where the plan and the spec differ, the spec wins; report the difference. Line numbers cite `main` before plans 1–2 landed; re-grep.

## Global Constraints

- Everything plan 1's Global Constraints say (uppercase only in `.rail-kicker`, 11 px floor, the tint form, no new tokens, CSP `style-src 'self'`, flat jest
  tests, scoped local runs, `git add <paths>`, comments at the repo's density, 160-column prose) holds here unchanged.
- **Guard 7 reads the whole selector** (`test/design-guards.test.ts:380-396`): no selector outside the primitives block may carry a `ui-*` family token
  ANYWHERE, descendant side included — never `.prs-row .ui-split`, `.runs-card .ui-pill`, `.tick-row .ui-stripe`. Style placement with structural selectors
  on page classes (`.prs-merge > [role='group']`, the `> button` precedent at `styles.css:1288`) or with page-local spans carrying their own classes.
- Tints vs marks: pills, tiles and menu-row grounds are tints and every new tint selector joins `test/daylight-contrast.test.ts` `PINNED`, its key equal to
  the CSS selector exactly (quotes included, whitespace normalised). Stripes, bar segments and tick cells are marks (solid `--green-solid` / `--red` / …) and
  are not pinned. No mock hex is built (§6).
- Per-element widths (bar segments, progress fills) go through React's `style` prop, i.e. CSSOM — the `StageBars` precedent (`StageBars.tsx`, track fill).
- Plan 3 adds NO caller of `useOrchestratorRuns` or `useReportWorking` and moves none (plan 4 owns both); `test/run-pulse.test.ts` must stay green untouched.
- `watchdogStoodDown` stays read only through `RunControls`; `WatchdogMonitor` never calls it (`test/watchdog-coupling.test.tsx`).
- A crashed run still renders as crashed (`runStatusChip`, `runDotTone`, `lib/run-stage.ts:272,311`) on its live card, its detail and its History row.
- Every component touched cites its DESIGN.md subsection in its header comment (§8.4.1, §8.4.2, §8.11); every new derivation lives in `lib/`.
- Every `/api/prs/*` payload assertion in the PR suites is kept; only how a test reaches the control changes.

## Review Focus

1. A PR with checks `pending` on a repo with `autoMergeAllowed: false` — the main half must fall back to Merge with `mergeBlock`'s reason, not arm (Task 1).
2. An armed PR whose repo is `syncOff` — main half `Auto-merge on`, blocked, reason `sync off`; the chevron still opens and every row explains itself (Task 2).
3. The Merge menu opened on the LAST Matrix row inside `.prs-matrix-scroll` (`overflow-x: auto`) — the panel must not be clipped or add a vertical scrollbar
   to the box (Task 4).
4. A run that is `running` with a stale heartbeat — its live card is red-striped with the `crashed` pill and its second line, never a green running card (Task 6).
5. A tick project with 3 entries in `recent` and one with 50 — 3 cells and 12 cells, oldest left, no placeholder cells (Task 8).

---

### Task 1: PR helpers, `SplitChip`'s blocked main half, new glyphs

**Files:**
- Modify: `client/src/lib/prs.ts` (beside `mergeBlock` :93, `autoMergeBlock` :130), `client/src/lib/pr-layouts.ts` (beside `prChips` consumers and
  `levelFacts`), `client/src/components/ui/SplitChip.tsx`, `client/src/components/ui/Glyphs.tsx`
- Test: `test/prs-lib.test.ts`, `test/pr-layouts-lib.test.ts`, `test/ui-split.test.tsx`

**Interfaces:**
- Consumes: `mergeBlock`, `autoMergeBlock`, `prChips` (`lib/prs.ts:72`), plan 1's `SplitChip` and `GlyphName`.
- Produces: `mergeMain(pr: PullRequestRow, repo: PrRepoView): { mode: 'merge' | 'arm' | 'disarm'; block: string | null }` in `lib/prs.ts` —
  `pr.autoMerge` set → `disarm`, block `autoMergeBlock(...)`; else `pr.checks === 'pending'` and `autoMergeBlock(...)` null → `arm`, block null; else
  `merge`, block `mergeBlock(...)`. Reasons are the existing strings, verbatim.
- Produces: `checksTone(checks: PullRequestRow['checks']): 'red' | 'amber' | 'green' | 'neutral'` (failure → red, pending → amber, success → green,
  none / unknown → neutral) and `checksGlyph(checks): GlyphName` (cross, clock, tick, pull-request) in `lib/pr-layouts.ts`.
- Produces: `prPills(pr: PullRequestRow): PrChip[]` in `lib/pr-layouts.ts` — `prChips(pr)` plus, when `levelFacts` finds the unnamed blocked/unstable
  merge state, one `warn` chip reading the `mergeState` word, so no fact the Inbox verdict line carried is lost when that line goes (Task 3).
- Produces: `SplitChip` optional `mainBlockedBy?: string` — an element id; when set the main half gets `aria-disabled="true"` and `aria-describedby` = that
  id, stays focusable, and a click does not call `onMain`. The chevron is untouched by it. `GlyphName` gains `cross`, `clock`, `pull-request`, `merge`,
  `refresh`, `external`, `pause`, `cpu`, `coin` (skip any plan 2 already added).

- [ ] **Step 1: Failing tests.** `prs-lib`: `mergeMain` cases — success checks, mergeable → `{merge, null}`; checks `failure` → `{merge, 'checks failing'}`
  (exact `mergeBlock` string); `pending` + `autoMergeAllowed` → `{arm, null}`; `pending` + `autoMergeAllowed: false` → `{merge, <mergeBlock reason or null>}`;
  armed → `{disarm, null}`; armed + `syncOff` → `{disarm, 'sync off'}`; draft + pending → `{merge, <draft reason>}`. `pr-layouts-lib`: `checksTone` for all
  five values; `prPills` equals `prChips` for an ordinary row and adds exactly one `warn` chip for an unnamed `blocked` state. `ui-split`: `mainBlockedBy`
  sets `aria-disabled` + `aria-describedby` on the main half only; the main half is not `disabled` and is reachable by Tab; click calls `onMain` zero times;
  the chevron still calls `onMore`.
- [ ] **Step 2: Run** `pnpm exec jest test/prs-lib.test.ts test/pr-layouts-lib.test.ts test/ui-split.test.tsx` — FAIL.
- [ ] **Step 3: Implement.** `.ui-split-main[aria-disabled='true']` (inside the primitives block): cursor default, no hover lift.
- [ ] **Step 4: Run** the same plus `test/design-guards.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(prs): merge main-half, checks tone and pill helpers`.

### Task 2: `PrActions` becomes the split Merge with a Merge menu, the tenth Popover composer (mock `PRs.dc.html`, the open menu)

**Files:**
- Modify: `client/src/components/github/PrActions.tsx` (whole strip; props unchanged), `client/src/styles.css` (`.prs-keys*`), `client/src/hooks/useDialogEscape.ts:47`,
  `.claude/rules/board.md:20` (and its Confirm list :10-23 if it names the keys), `docs/subsystems/invariants.md:2242`, `.claude/DESIGN.md` §8.7 (the
  Popover-composer sentence plans 1–2 wrote)
- Test: `test/prs-actions.test.tsx`, `test/prs-inbox.test.tsx`, `test/prs-matrix.test.tsx`, `test/prs-view.test.tsx`, `test/dialog-count-docs.test.ts:87-96`,
  `test/daylight-contrast.test.ts`

**Interfaces:**
- Consumes: Task 1; `SplitChip`, `Popover` (`ui/Popover.tsx`), `GlyphTile` (plan 2); `updateBlock`, `whyLine`, `defaultMethod`, `PR_KEYS` (kept as the key
  set — `open` is still a key, drawn as the icon link), `primaryKey` (`lib/pr-layouts.ts:285`, unchanged).
- Produces: unchanged `PrActions` props; new optional `blockedText?: boolean` (Task 4's Matrix: the blocked main half shows the reason instead of `Blocked`).

Behaviour (spec §4.8): wrapper keeps `.prs-keys-side` / `data-testid="pr-keys-<key>"` and the `prs-why` line. Inside: a `SplitChip` size 28,
`label` = `<Word> #<n>`, `labelMore` = `Merge options for #<n>`, and an icon link `Open #<n> on GitHub` (external glyph, `href` `pr.url`, new tab, no referrer).
From `mergeMain`: `merge` → visible `Merge`, label `Merge #<n>`, click = today's `onMerge` (opens `PrFoot`'s Confirm with the method select, unchanged);
`arm` → `Auto-merge` / `Auto-merge #<n>`, click posts `/api/prs/auto-merge` exactly as today's key (`{enable:true}` or `{enable:true, method}`);
`disarm` → `Auto-merge on` / `Auto-merge on #<n>`, click posts `{enable:false}`. A blocked main half: `dashed`, visible `Blocked` (or the reason with
`blockedText`), `mainBlockedBy` → a visually hidden span holding the reason, `title` = reason. `busy` → SplitChip `disabled`; the Open link stays live.
The chevron opens a 280 px Popover labelled `Merge menu`: rows `Merge` (sub `asks first, then merges into <base>`), `Enable auto-merge` (sub
`GitHub merges when checks pass`) or, armed, `Disable auto-merge` (sub `GitHub stops waiting to merge`), `Update branch` (sub `merge <base> into <head>`), each
a `role="menuitem"`-free plain button with a `GlyphTile` size 18 (merge, clock, refresh). A blocked row is `aria-disabled`, its sub-line replaced by the reason
and pointed at by `aria-describedby`; picking an enabled row closes the menu, returns focus to the chevron and does what today's key did. On open, focus
lands on the first enabled row. `primaryKey`'s row (`merge` or `update`) carries an `aria-hidden` tick, the mock's mark. The menu reads `Merge`, never
`Squash and merge` (§6).

- [ ] **Step 1: Failing tests.** `prs-actions`: replace the `key(k, name)` helper (:154) and `openLink` (:155) with `main(k)` (the `Merge #n`-family button),
  `more(k)` (`Merge options for #n`) and `pick(k, row)` (open menu, click the row); every existing case (:165-398) keeps its payload assertion. New cases:
  passing checks → main named `Merge #12`, click shows `Confirm merge of #12`, confirming POSTs merge; pending + allowed → `Auto-merge #12`, click POSTs
  `{enable:true}` (with `method` when `defaultMethod` gives one); armed → `Auto-merge on #12`, enabled, POSTs `{enable:false}`, and the menu row reads
  `Disable auto-merge`; failing checks → main reads `Blocked`, `aria-disabled="true"`, `title` `checks failing`, described by a span with that text, click
  POSTs nothing, chevron enabled; menu lists exactly `Merge`, `Enable auto-merge`, `Update branch` in that order; a blocked `Update branch` row is
  `aria-disabled` with `updateBlock`'s reason; Escape closes and focuses the chevron; `Open #12 on GitHub` has `href` = `pr.url`. `prs-inbox` (`keysOf` :90,
  `mergeKey` :91, `keyNames` :225, Update :210), `prs-matrix` (:111-112, :210-212, :324, :383), `prs-view` (`keysIn` :207, `action` :448, :967-970, :1031,
  :443-477, :502-520): swap lookups to the new helpers, keep every payload. `dialog-count-docs`: the hook comment says `ten composers` and keeps the
  earlier history sentences.
- [ ] **Step 2: Run** `pnpm exec jest test/prs-actions.test.tsx test/prs-inbox.test.tsx test/prs-matrix.test.tsx test/prs-view.test.tsx test/dialog-count-docs.test.ts` — FAIL.
- [ ] **Step 3: Implement**, then move "nine composers" → "ten composers" in the four doc sites, naming `PrActions`' Merge menu in each list.
- [ ] **Step 4: Run** the same plus `test/design-guards.test.ts test/daylight-contrast.test.ts` (menu-row tile tints pinned) — PASS. Guard suites:
  `grep -l "Popover\|SplitChip\|GlyphTile" test/` and add every hit.
- [ ] **Step 5: Commit** `feat(prs): split Merge with a Merge menu`.

### Task 3: Inbox (mock `PRs.dc.html`)

**Files:** Modify: `client/src/components/github/PrInbox.tsx`, `client/src/styles.css` (`.prs-inbox*`, `.prs-tile*`). Test: `test/prs-inbox.test.tsx`,
`test/daylight-contrast.test.ts`.

**Interfaces:** Consumes: plan 2's `Segmented` `count`, `GlyphTile`; Task 1's `checksTone`, `checksGlyph`, `prPills`; `LEVEL_LABEL`, `levelCounts`
(`lib/pr-layouts.ts:30,163`).

Behaviour: the three triage tiles become one `Segmented` (label `Triage`) whose options are the three levels with `count` from `levelCounts` and the level
`Dot`; value `filter ?? 'all'` with no `all` option drawn, and choosing the pressed option clears the filter (today's toggle; the confirming-clear effect
stays). Each row: a `GlyphTile` size 32 in `checksTone` with `checksGlyph`; the `#n` link and title; a pill row from `prPills`; the meta line
`author · head → base · age` with the run-warning pill at its end; then `PrFoot` and `PrActions`. The verdict line, steps list and quiet-facts line go.

- [ ] **Step 1: Failing tests.** Tile cases (:117-160) re-pointed at `Segmented` buttons named `Needs you 1` etc.: clicking filters, clicking the pressed one
  clears, `aria-pressed` follows. Per-checks tile: failure row's tile has `data-tone="red"`, pending amber, success green, none neutral. Pills: a failing,
  behind row shows `checks failing` and `behind base` pills. The verdict/steps assertions (:178, :276) are rewritten to the pills; the run-warning pill
  is still in the meta line.
- [ ] **Step 2–4: Run** `pnpm exec jest test/prs-inbox.test.tsx test/prs-view.test.tsx test/ui-segmented.test.tsx test/design-guards.test.ts test/daylight-contrast.test.ts` — FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(prs): inbox rows with a checks tile and pills`.

### Task 4: Matrix and Cards (mock `PRsLayouts.dc.html`)

**Files:** Modify: `client/src/components/github/PrMatrix.tsx`, `client/src/components/github/PrCards.tsx`, `client/src/styles.css` (`.prs-matrix*`,
`.prs-cell-*`, `.prs-card*`). Test: `test/prs-matrix.test.tsx`, `test/prs-view.test.tsx`, `test/daylight-contrast.test.ts`.

**Interfaces:** Consumes: `MATRIX_COLUMNS`, `matrixCells`, `columnCounts`, `LEVEL_DOT` (`lib/pr-layouts.ts:299,320,364,374`), Task 1–3 pieces, `PolledAge`.

Behaviour — Matrix: header counts become pills (red for checks, amber otherwise, none at zero); a cell in tone `bad` or `meh` is a red / amber pill, every
other tone plain `--ink2` text (colour marks problems only); the dot column stays the triage. The expansion row (`pr-expand-<key>`, one open at a time)
holds `PrActions` with `blockedText` and `omitUpdatingReason`, then `PrFoot`. Narrow: the table keeps scrolling inside `.prs-matrix-scroll` (§7). The
Merge Popover must escape that box: render it so the scroll box does not clip it (verify in Task 10). Cards: head = `GlyphTile` (worst row's
`checksTone`), repo, an `N open` pill, `PolledAge`; rows compact with the same tile, `prPills`, the split; a departed outcome stays one quiet
`p.prs-outcome` line; an unreadable repo stays one line under the cards (`PrRepoNotes`).

- [ ] **Step 1: Failing tests.** Matrix: header `Checks` holds a pill `1` when one row fails, no pill at zero; a failing checks cell is a pill with
  `data-tone="bad"`, a passing one has no pill; expanding row B collapses row A; a blocked Merge in the expansion reads the reason text (`checks failing`)
  and is `aria-disabled`. Cards: head shows `2 open`; the departed line keeps its text; rows carry the tile and the split.
- [ ] **Step 2–4: Run** `pnpm exec jest test/prs-matrix.test.tsx test/prs-view.test.tsx test/design-guards.test.ts test/daylight-contrast.test.ts` — FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(prs): matrix problem pills and card rows`.

### Task 5: History figures — status bar and stacked machine time (mock `Runs.dc.html`, the tiles and stage bar)

**Files:** Modify: `client/src/components/runs/RunsView.tsx` (Figure `runs-tile-runs`, `runs-figure-runs-line`, `runs-tile-machine` :879-883),
`client/src/components/runs/StageBars.tsx`, `client/src/styles.css` (`.run-bars*`, `.runs-figure*`). Test: `test/stage-bars.test.tsx` (rewrite :28-76),
`test/runs-view.test.tsx`, `test/run-detail.test.tsx`.

**Interfaces:** Consumes: plan 2's `runTone`; `STATUS_ORDER` (`lib/runs-list.ts:277`), `MACHINE_STAGES` (`lib/run-stats.ts:230`), `formatSpanCompact`.
Produces: `StageBars({ totals, testId })` unchanged signature, new shape.

Behaviour: the Runs tile keeps its number and gains a 6 px bar of one segment per status with a count above zero, in `STATUS_ORDER`, width ∝ count,
2 px gap, `data-tone` = `runTone(status)` (marks); the existing glyph-count line stays under it. The other four tiles are untouched. `StageBars` becomes
one 10 px stacked bar (segments only for stages with time, width ∝ share, `data-stage`) over a legend of all seven `MACHINE_STAGES` (swatch, stage word,
`formatSpanCompact` or `—`). Segment colours by `data-stage`: dispatched `--green-solid`, reviewing `--cyan`, fixing `--amber-solid`, verifying `--magenta`,
inspecting `--mustard`, preflight and merging `--ink3`, the base rule `--steel`. Used unchanged by RunDetail's machine-time block.

- [ ] **Step 1: Failing tests.** `stage-bars`: legend has seven entries in `MACHINE_STAGES` order (`${testId}-${stage}`); a present stage shows
  `formatSpanCompact`, an absent one `—`; segments exist only for present stages and their widths sum to 100 %; `{dispatched: 3h, fixing: 1h}` gives 75 % /
  25 %; empty totals → seven dashes, no segment, the bar still drawn. `runs-view`: done 3, failed 1 → two segments `data-tone="grey"` / `"red"`, widths
  75 % / 25 %, and the glyph line unchanged.
- [ ] **Step 2–4: Run** `pnpm exec jest test/stage-bars.test.tsx test/runs-view.test.tsx test/run-detail.test.tsx test/design-guards.test.ts` — FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(runs): status bar and stacked machine time`.

### Task 6: Live run cards and the run detail (mock `Runs.dc.html`, live cards and the detail sheet)

**Files:** Modify: `client/src/components/runs/RunsView.tsx` (`LiveRow` :232; `CountPair` :196), `client/src/components/runs/RunDetail.tsx` (head :235-280,
facts :297-420, chips :479-520, items :557-700), `client/src/lib/run-stage.ts`, `client/src/styles.css`. Test: `test/runs-view.test.tsx`,
`test/run-detail.test.tsx`, `test/run-controls.test.tsx`, `test/watchdog-coupling.test.tsx`, `test/daylight-contrast.test.ts`.

**Interfaces:** Consumes: `runTone`, `GlyphTile`, `Glyph`; `runStatusChip`, `runDotTone`, `statusNote` (`lib/run-detail.ts:360`), `prNumber` (:285),
`itemStageSpans` (`lib/run-stats.ts:123`), `STAGE_TONE` (`lib/run-stage.ts:52`). Produces: `stagePillTone(stage: RunStage): PillTone` in `lib/run-stage.ts`
(active → live, done → done, bad → bad, warn → warn, idle / muted → neutral); `stageChipClass` stays for the board cards.

Behaviour — live card (`runs-row-<id>` button kept, `aria-current` kept): `ui-stripe` with `data-tone` = `runTone(status)`, `red` when crashed; project;
state pill (`running` live, `paused` warn with the pause glyph, `crashed` as today); run id in mono; machine (`RemoteTag`) · age; `N of M items` with a
4 px progress fill; the attention mark and the crashed second line (`runs-live-crashed-<id>`) kept. Detail head: Dot + project, run id mono in the sub,
right: the status pill (`runs-status`) and `run-detail-status-note` (`paused at a boundary` etc.), then `RunControls`, or for a remote run the line
`controls live on the machine that ran it` (`run-detail-remote`). Facts: a glyph-labelled four-cell grid — Started (calendar; started clock · wall, finished
under it), Machine (cpu), Base · mode (branch; base + the mode pill, questions under it), Cost (coin; usage `$ · N turns`); every fact testid survives on
the element holding that reading. Chips become `Pill`s with the same testids and texts. Each item head: id, title, an outcome `Pill` in `stagePillTone`
reading the real stage word (the stage chip goes), `RowTime`; under it one line `stage span · stage span` from `itemStageSpans`; `StageTrack` stays.
The `PR #n` link leaves the head for a closing line `PR opened · <base> → <prTarget> · #<n>` drawn only when `prNumber` is not null, link testid kept.

- [ ] **Step 1: Failing tests.** `runs-view`: a paused run's card has `data-tone="amber"` and a `paused` pill; a running fresh one green; a crashed one red
  with `crashed` and its line; card shows `1 of 3 items`. `run-detail`: remote line reads `controls live on the machine that ran it` (rewrite :1168 and
  runs-view :2753); a pr-mode run with `prUrl` `…/pull/462` renders `PR opened · backlog/run-1 → main · #462` and none without `prUrl`; an item at `merged`
  has a `merged` pill `data-tone`/class done, one at `fixing` live; facts still expose `run-detail-started`, `-on-machine`, `-base`, `-usage`, `-mode`;
  chips keep their texts (:223-226, :970-990). `stagePillTone` for one stage of each tone.
- [ ] **Step 2–4: Run** `pnpm exec jest test/runs-view.test.tsx test/run-detail.test.tsx test/run-controls.test.tsx test/watchdog-coupling.test.tsx test/run-pulse.test.ts test/design-guards.test.ts test/daylight-contrast.test.ts` — FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(runs): live run cards and an item-first detail`.

### Task 7: Watchdog (mock `RunsOps.dc.html`, Watchdog)

**Files:** Modify: `client/src/components/runs/WatchdogMonitor.tsx` (band, `watchdog-state` FigureStrip, Watching, Activity), `client/src/lib/run-watchdog.ts`
(beside `stateLine` :158), `client/src/styles.css`. Test: `test/watchdog-monitor.test.tsx`, `test/runs-view.test.tsx` (:1834-1882), `test/watchdog-coupling.test.tsx`.

**Interfaces:** Consumes: `stateLine`, `sweepFraction`, `WATCHDOG_KIND_TONE` (:280), `GlyphTile`, `Pill`. Produces: `stateWord(status): string` —
`Off · <reason>`, `Idle · nothing to watch`, `Watching N` — beside `stateLine`, which stays the band's sub (`watchdog-state-line`).

Behaviour: the status band is one sheet row — `GlyphTile` (ring), a `Dot` and `stateWord` in `watchdog-phase`, `next check in N s` from `nextTickAt` while
armed (no `checked N s ago`), the sweep meter (`watchdog-sweep`) under it while armed, and the flat `Policy in Settings` chip (`watchdog-policy-link`). The
policy moves to its own `FigureStrip cols={3}` below: Check every, Leave a resumed run alone, Give up after (`N resumes`), the resume-spawns line under it
(`watchdog-config-line`, `watchdog-policy-line` kept). Watching: title `Watching` with a count pill; empty state one line (`watchdog-rows-empty`). Activity
keeps its five columns; the kind cell becomes a `Pill` mapped live → live, done → done, bad → bad, warn → warn, muted → neutral, glyph kept.

- [ ] **Step 1: Failing tests.** Off → `watchdog-phase` reads `Off · BM_AGENTS off`; idle → `Idle · nothing to watch`; the three policy figures are inside a
  container that is NOT the status band and follows it in document order; armed with `nextTickAt` 42 s ahead → `next check in 42s` (keep :600-604); no text
  `checked`; Watching with none → one line; activity kind `failed` renders a pill with the `bad` tone (rewrite :512-513 from the class to the pill tone).
- [ ] **Step 2–4: Run** `pnpm exec jest test/watchdog-monitor.test.tsx test/runs-view.test.tsx test/watchdog-coupling.test.tsx test/design-guards.test.ts test/daylight-contrast.test.ts` — FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(runs): watchdog status band over its policy`.

### Task 8: Ticks (mock `RunsOps.dc.html`, Ticks)

**Files:** Modify: `client/src/components/runs/TickMonitor.tsx` (`TickRow` :192-260, activity outcome cell), `client/src/lib/ticks.ts`, `client/src/styles.css`
(`.tick-row-halted` goes). Test: `test/tick-monitor.test.tsx`, `test/ticks-lib.test.ts`.

**Interfaces:** Produces: `tickStrip(p: TickProject, zone): { tone: 'ok' | 'failed' | 'other'; title: string }[]` in `lib/ticks.ts` — the newest 12 of
`recent` (newest first, ≤ 50), reversed so oldest is first; tone `ok` / `failed` by `outcome`, anything else `other`; title `<clock> · <kind> <id> · <outcome>`.

Behaviour: each row: name; a halted project gets a red `N failures in a row` pill and the reason line (`since <clock> · last: <reason> on <id>`); a
non-halted project with `streak > 0` an amber pill of the same words; then the strip (`tick-strip`, cells `data-tone`, `title`, `aria-hidden` with one
`sr-only` summary `last 12 ticks: N ok, N failed`); the last-tick line; `Reset` on a halted project. The row loses `tick-row-halted`. Band, figures and
activity stay; the activity outcome cell becomes a Pill (ok done, failed bad, other neutral).

- [ ] **Step 1: Failing tests.** 15 `recent` entries → 12 cells, the last cell's title names the newest entry; 3 entries → 3 cells; outcomes `ok`, `failed`,
  `skipped` → `ok`, `failed`, `other`; a cell title reads `19:45 · execute #49 · ok` for a fixture at that clock; halted with streak 3 → a `3 failures in a
  row` pill with the bad tone and `Reset`; no row carries `tick-row-halted` (rewrite :277 to assert the pill instead); streak 2 not halted → amber pill, no Reset.
- [ ] **Step 2–4: Run** `pnpm exec jest test/tick-monitor.test.tsx test/ticks-lib.test.ts test/design-guards.test.ts test/daylight-contrast.test.ts` — FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(runs): tick strip per project`.

### Task 9: DESIGN.md §8.4.1, §8.4.2, §8.11 overrides

**Files:** Modify: `.claude/DESIGN.md` — §8.4.1 (:295; the figure strip's runs line and sixth cell, the Live sheet's "row, not a card", the detail head,
facts strip, chips, items, the PR link), §8.4.2 (:359; three figures → status band plus a policy row, the Activity kind), §8.4.3 if it names the item stage
chip, the Ticks paragraph, §8.11 (:546; Inbox tiles, the key strip → split Merge + Merge menu + Open icon, Matrix cells, Cards head and rows).

Write spec §9's bullets into those paragraphs, each with its reason from §4.6–§4.8, and the "not built" facts (failing check names, check counts,
`checked N s ago`). Edit in place; do not reflow untouched prose. Run `pnpm exec jest test/design-guards.test.ts test/dialog-count-docs.test.ts`.
Commit `docs(design): runs and PRs restyle overrides`.

### Task 10: `/ui-verify` against the mocks

Invoke the `ui-verify` skill on the branch at 1440 px with fixture data (a live, a paused and a crashed run; a finished pr-mode run with `prUrl`; an armed
watchdog and an idle one; a halted tick project with 15 entries and a quiet one with 3; PRs failing, pending, armed, blocked and behind across two repos
plus one unreadable): History tiles, live cards and detail vs `Runs.dc.html`; Watchdog and Ticks vs `RunsOps.dc.html`; Inbox with the Merge menu open vs
`PRs.dc.html`; Matrix (menu open on the last row) and Cards vs `PRsLayouts.dc.html`. `00-mock-audit.md`'s not-built rows and §6 are expected differences.
Fix defects on the branch, re-run the touched suites, commit `fix(runs): ui-verify findings` if any.
