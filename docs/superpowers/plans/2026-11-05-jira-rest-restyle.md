# Jira rest restyle (List, Sessions, Setup, launch sheet, deck) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the rest of Jira — List, Sessions, Setup, the launch sheet and the deck card — and build the shared pieces later plans reuse (state tones and
stripe, glyph tile, Segmented counts, the FilterBar restyle), without changing what any action does.

**Architecture:** One pure tone module (`client/src/lib/tones.ts`), one primitive (`ui/GlyphTile`), one family (`.ui-stripe`), two additive props on existing
primitives (`Segmented` `count`, `SplitChip` `href`/`variant`), one Jira component (`SessionOpen`, the split Open and its menu — the ninth `Popover`
composer); the rest is the Jira views composing them, with CSS in `client/src/styles.css`.

**Tech Stack:** React + TypeScript (Vite), plain CSS with daylight tokens (`shared/theme.css`), jest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-11-05-app-restyle-design.md` §4.1 (plan-2 pieces), §4.2–§4.5, §9 (§8.9.1 / §8.9.3 / §8.9.5) — plan 2 of 4 (§10). Runs
after plan 1 (`docs/superpowers/plans/2026-11-05-jira-restyle.md`) on the same branch. Mocks: `docs/superpowers/specs/2026-11-05-jira-restyle-mockups/`
(`JiraList.dc.html`, `JiraSessions.dc.html`, `JiraSetup.dc.html`, `JiraLaunch.dc.html`) and `00-mock-audit.md` "Round 2" for what each draws that is NOT built.

**How to read this plan (override of writing-plans' code-block rule).** This plan gives behaviour, names, signatures, exact values and exact test CASES —
never literal code. Write the code and the test bodies yourself; if a case here looks wrong against the code, say so in your report rather than transcribe
it. Line counts are soft. Where the plan and the spec differ, the spec wins; report the difference. Line numbers are pre-plan-1; plan 1 shifts some.
#472 (b3c73fa5) also shifted test lines after this plan was written (`jira-board.test.tsx` cases ~27-28 lower, `jira-lib.test.ts` ~28 lower): every test
line cited here is a pointer to a case NAME — re-grep by that name before editing.

## Global Constraints

- Everything in plan 1's Global Constraints holds: one uppercase rule (`.rail-kicker`), 11 px floor, the tint form `color-mix(in srgb, var(--<mark>) N%,
  var(--strip)|var(--steel))`, no new theme tokens, CSP `style-src 'self'` (no `style=`, no `<style>`), flat jest tests, touched suites only, `git add
  <paths>` (never `-A`), commit message ending with the executing session's attribution line, comments at the repo's density, prose wrapped at 160.
- **Guard 7** (`test/design-guards.test.ts:380-396`): a selector OUTSIDE the primitives block (`/* ── ui primitives` … `/* ── end ui primitives`,
  `styles.css:3258-3846`) may not carry a `ui-*` family token anywhere, descendant side included. Page CSS never writes `.jira-x .ui-split`, `.foo
  .ui-stripe`, `.bar .ui-seg`; reach a primitive structurally (`.jira-run[data-state='live'] > [role='group']`, precedent `styles.css:1288` `> button`) or
  give the page its own span/class. Every `.ui-*` rule this plan adds sits inside the block.
- **`PINNED` keys** (`test/daylight-contrast.test.ts:393`) equal the CSS selector exactly — quotes included, whitespace normalised. Stripes and dots are marks,
  not tints, and are not pinned; tiles and pills on a tint are. Retitle the case to the count it pins after each task that adds sites.
- Popover composers: plan 1 leaves EIGHT; this plan's `SessionOpen` menu makes NINE (Task 4). The DIALOG count does not move. `FilterBar` adds none.
- `ui/Fact` gains `icon?` in plan 1 Task 5; the `dt` word stays a direct text node — no task here wraps it.
- No server change. The server never writes git: a worktree row's `Remove` keeps copying `removeCommand` and running nothing.
- Before each commit, `grep -l <symbol> test/` for every shared hook or helper a task adds a caller of; the task names the hits found at planning time.

## Review Focus

1. A session whose Desktop button is disabled (hand-over could fork a live transcript) — the split's main half or menu row must keep `desktopButton`'s
   disabled state and title, and a phone must still hide Desktop (Task 4).
2. A Detail card with Unlink AND Stop, one with neither (a `run` link, agents off) — the first gets a three-row menu at most, the second collapses to today's
   single Open; Stop's `Confirm` still replaces the control in place and still posts once (Task 4).
3. A List top whose only session ended on a folded child two hours ago, and a top with a live child and an older ended self — `Ended · 2h` and the live state
   respectively; never both (Task 5).
4. A launch for a project mapped to two paths with the same basename, or to five paths — the Repository control must stay unambiguous (Task 7).
5. Sessions with `All tickets` on and an unavailable board, at window `All` — the empty title is `No linked sessions`, `Show 30 days` is hidden (Task 6).

---

### Task 1: State tones, the `.ui-stripe` family, `ui/GlyphTile`

**Files:**
- Create: `client/src/lib/tones.ts`, `client/src/components/ui/GlyphTile.tsx`, `test/tones.test.ts`, `test/ui-glyph-tile.test.tsx`
- Modify: `client/src/styles.css` (inside the primitives block), `test/design-guards.test.ts:323` (`FAMILIES`), `test/daylight-contrast.test.ts:393`

**Interfaces:**
- Produces `type StateTone = 'amber' | 'green' | 'grey' | 'red'`; `sessionTone(state: JiraSessionState): StateTone` (`plan`/`permission`/`reply`/`answer`
  amber, `starting`/`working` green, `quiet`/`ended` grey, `lost` red); `runTone(status: OrchestratorRun['status']): StateTone` (`running` green, `paused`
  amber, `done`/`aborted` grey, `failed` red). Both are exhaustive switches so a new member fails the type check.
- Produces CSS `.ui-stripe[data-tone]` — a 3 px left edge drawn as an inset box-shadow (`green` `--green-solid`, `amber` `--amber-solid`, `red` `--red`,
  `grey` `--hairline2`); on a table row the block's own `tr.ui-stripe > :first-child` carries it. And `.ui-stripe-dot[data-tone]`: 6 px round dot, same marks.
- Produces `GlyphTile({ glyph, tone = 'neutral', size = 28 }: { glyph: GlyphName; tone?: 'neutral' | 'green' | 'red' | 'amber' | 'ink'; size?: 18 | 28 | 32 })`
  — `<span class="ui-glyph-tile" data-tone data-size aria-hidden>` around `Glyph` (14 px; 10 px at size 18). Radius 5 / 8 / 9. Tones: neutral `--strip-hi`
  + `--ink2`; green `color-mix(in srgb, var(--green-solid) 14%, var(--strip))` + `--green`; red `color-mix(… var(--red) 12% …)` + `--red`; amber
  `color-mix(… var(--amber-solid) 14% …)` + `--amber-ink`; ink `--ink` + `--on-accent`. Consumes `Glyph`, `GlyphName` (plan 1 Task 1).

- [ ] **Step 1: Failing tests.** `tones.test.ts`: every `JiraSessionState` member (iterate `Object.keys(STATE_LABEL)`) maps to the spec tone above; every
  run status maps; nine session cases and five run cases, each named. `ui-glyph-tile.test.tsx`: default renders `data-tone="neutral"` `data-size="28"`
  and an `svg`; `tone="ink" size={18}` sets both attributes; the tile is `aria-hidden`. `design-guards`: append `'.ui-stripe'` and `'.ui-glyph-tile'` to
  `FAMILIES`. `daylight-contrast` `PINNED`: `.ui-glyph-tile[data-tone='green']` (`--green-solid`, 14, `var(--strip)`), `[data-tone='red']` (`--red`, 12),
  `[data-tone='amber']` (`--amber-solid`, 14) — keys spelled exactly as your CSS; the glyph words pass 4.5:1 over them (the existing contrast case).
- [ ] **Step 2: Run** `pnpm exec jest test/tones.test.ts test/ui-glyph-tile.test.tsx test/design-guards.test.ts test/daylight-contrast.test.ts` — FAIL.
- [ ] **Step 3: Implement** the module, the component and the rules in the block.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(ui): state tones, stripe and glyph tile primitives`.

### Task 2: `Segmented` counts

**Files:** Modify `client/src/components/ui/Segmented.tsx:28` (option type), `client/src/styles.css` (block). Test: `test/ui-segmented.test.tsx`.

Behaviour: options gain `count?: number`; when present a `<span class="ui-seg-count">` follows the label inside the button (11/600, `--ink3`,
`font-variant-numeric: tabular-nums`; `--ink2` on the pressed option), so the accessible name is `Needs you 1` (a space precedes the span, as `JiraSessionList.tsx:109` does today). Absent → no span, today's markup exactly.

- [ ] **Step 1: Failing tests:** an option `{ label: 'Needs you', count: 1 }` is a button named `Needs you 1` holding `.ui-seg-count` text `1`; `count: 0`
  still renders `0`; an option without `count` has no `.ui-seg-count` and the name is the bare label; `aria-pressed` unchanged.
- [ ] **Step 2: Run** `pnpm exec jest test/ui-segmented.test.tsx` — FAIL. **Step 3: Implement.**
- [ ] **Step 4: Run** it plus the guard hits for `Segmented` — `test/settings-view.test.tsx test/runs-view.test.tsx test/daylight-contrast.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(ui): Segmented options carry an optional count`.

### Task 3: `FilterBar` restyled in place (mock `JiraList.dc.html`, the open Filter popover)

**Files:** Modify `client/src/components/FilterBar.tsx:61-140,202-215`, `client/src/styles.css` (`.filter-bar*`). Test: `test/filter-bar.test.tsx`.

**Interfaces:** `FilterBar` gains `showing?: { shown: number; total: number; note?: string }`. Everything else unchanged.

Behaviour (spec §4.1): the filter popover drops its `Filters` / `Clear all` head row; each `FilterSection` is a labelled chip group — heading 11/600 `--ink3`,
`letter-spacing: .04em`, sentence case (the hint stays after it), chips wrap at 6 px gaps, a hairline between sections. A foot row ends the popover:
`Showing N of M` (plus ` · <note>` when given) at 11 px `--ink3` on the left, and on the right the clear button, visible text `Clear`, `aria-label="Clear
all"` kept (existing lookups stand), still `aria-disabled` at count 0 and still leaving the panel open. No `showing` → the foot holds `Clear` alone. The Sort
popover is untouched. Escape closes and returns focus to the chip (today's `Popover`).

- [ ] **Step 1: Failing tests:** `showing={{ shown: 3, total: 6, note: 'options come from the loaded issues' }}` renders `Showing 3 of 6 · options come from
  the loaded issues`; without it no `Showing` text; the clear control's visible text is `Clear` and its name `Clear all`; it resets every group (existing
  case, run against the foot); no element with class `filter-bar-head` inside the Filters dialog; Escape returns focus to the funnel chip.
- [ ] **Step 2: Run** `pnpm exec jest test/filter-bar.test.tsx` — FAIL. **Step 3: Implement.**
- [ ] **Step 4: Run** with the `FilterBar` guard hits `test/board.test.tsx test/archive.test.tsx test/jira-board.test.tsx` (helper `test/helpers/filter-bar.ts`
  needs no change while the name stays `Clear all`) — PASS. **Step 5: Commit** `feat(filters): chip-group popover with a showing line`.

### Task 4: `SessionOpen` — the split Open, the ninth Popover composer (mock `JiraLaunch.dc.html`, deck card)

**Files:**
- Create: `client/src/components/jira/SessionOpen.tsx`, `test/jira-session-open.test.tsx`
- Modify: `client/src/components/ui/SplitChip.tsx` (plan 1), `client/src/components/jira/JiraSessionCard.tsx:69-124,183-203`,
  `client/src/components/jira/JiraAgentDeck.tsx:52-90`, `client/src/components/ui/Meter.tsx:23-36` (`height?: 4`), `client/src/styles.css`, `client/src/hooks/useDialogEscape.ts:47`, `.claude/rules/board.md:20`,
  `docs/subsystems/invariants.md:2242`, `.claude/DESIGN.md:415` (§8.7)
- Test: `test/ui-split.test.tsx`, `test/jira-detail.test.tsx`, `test/jira-board.test.tsx`, `test/dialog-count-docs.test.ts:94`, the `Meter` suite
  (`grep -l "ui/Meter" test/`: `height={4}` sets `data-height="4"`; absent → no attribute)

**Interfaces:**
- `SplitChip` gains `href?: string` (main half renders `<a target="_blank" rel="noreferrer">` named by `label`, role link) and `variant?: 'ink' | 'outline'`
  (default `ink`; outline = `Chip`'s outline look). Additive; plan 1's props unchanged. While `disabled`, an `href` main half renders as plan 1's
  `<button disabled>` (no `href`), since an anchor has no `disabled`.
- Factor `OpenChip`'s branch choice into `openTarget(button: OpenButton, sessionId: string, row: DashboardRow | null, launch, phone: boolean, linkBase): {
  kind: 'href'; href } | { kind: 'handover' } | { kind: 'disabled'; title: string | null } | null` in `client/src/lib/jira-sessions.ts` (null = not shown);
  `OpenChip` keeps rendering from it.
- Produces `SessionOpen({ issueKey, sessionId, row, launch, state, buttons, onHandover, onUnlink?, onStop?, busy? })` — `buttons` is `openButtons(...)`'s
  answer; `onUnlink` / `onStop` are passed only where the card offers them today (Unlink: `branch` link; Stop: `stopState` and agents enabled, `useAgents`).

Behaviour (spec §4.5): menu rows = the secondary Open (when `openTarget` shows it; a disabled one is an `aria-disabled` row with its title), `Unlink`, `Stop
session`. No rows → today's single `OpenChip`. Otherwise a `SplitChip` (size 28): main half = the primary Open by `openTarget` (`href`, handover click, or
disabled with title); `label` = the primary's own label (`Open in Dashboard`, `Answer in Dashboard`, …), `labelMore` = `More for <key>`; `variant` ink when
`needsYou(state)`, else outline. The chevron opens a 220 px `Popover` labelled `Session actions` (36 px rows, first enabled row focused, Escape returns to the
chevron). `Stop session` closes the menu and swaps the split for today's `Confirm` (same label, test id `jira-stop-confirm`, copy and answers). Unlink calls
`onUnlink(sessionId)` and closes. `busy` disables both halves.

Deck card (`DeckCard`): `LiveStrip` goes; the card takes `.ui-stripe` with `data-tone={sessionTone(state)}`; first line `.ui-stripe-dot` + `STATE_LABEL[state]`
` · <pollAge(since)>` (no phase is served — spec §4.5's phase is not drawn); head `key` + a `↳ <top key>` pill only when the entry is folded (lifted out of
`deckCrumb`'s lead); summary; today's `.jira-card-crumb` (`run · repo · surface · model`, :24); a 4 px `Meter` (`Meter` gains `height?: 4` → `data-height="4"` on `.ui-meter`, styled in the primitives block — guard 7 forbids a
page-side `.jira-deck-ctx .ui-meter`; absent → today's 3.5 px track) with `context N%` (red ≥ 90, amber ≥ 70, as
`JiraSessionCard`'s); then `SessionOpen` with no `onUnlink`/`onStop`. A starting entry keeps `Starting…` and no buttons; :786's crumb assertion stands. Detail's
`JiraSessionCard` keeps its facts and replaces its OpenChips, Unlink and `StopSession` with one `SessionOpen` passing what it offers today.

- [ ] **Step 1: Failing tests.**
  - `ui-split.test.tsx`: `href` makes the main half a link with that href, `target="_blank"`; `variant="outline"` puts the outline class on the group.
  - `jira-session-open.test.tsx` (render with the providers `jira-detail.test.tsx` uses): no rows → one Open, no `More for PAY-1`; a secondary only → split
    whose menu holds it; `needsYou` state (`plan`) → ink main half, `working` → outline; Unlink row calls `onUnlink('s1')` once and closes; Stop row → the
    `jira-stop-confirm` box, `Stop session` there calls `onStop` once, `Keep running` restores the split; focus lands on the first enabled row on open;
    Escape closes and focuses the chevron; a disabled Desktop secondary is `aria-disabled` with `desktopButton`'s title.
  - `jira-detail.test.tsx`: `stopChip` (:473) and the Unlink cases (:694-727) open `More for <key>` first, then the row; :703 and :724-725 assert the menu
    lacks the row (or the chevron is absent).
  - `jira-board.test.tsx`: :979 opens the menu before `Stop session`; :783-785 and :802 read the deck card's state line and `data-tone`
    (`green` for working and starting) instead of `.board-card-live`; a deck card shows `context 42%` for `contextPct: 42`.
  - `dialog-count-docs.test.ts:94`: plan 1's `eight composers` → `nine composers`.
- [ ] **Step 2: Run** `pnpm exec jest test/ui-split.test.tsx test/jira-session-open.test.tsx test/jira-detail.test.tsx test/jira-board.test.tsx
  test/dialog-count-docs.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Move "eight composers" → "nine composers" in `useDialogEscape.ts`, `board.md`, `invariants.md` and DESIGN.md §8.7, naming
  `SessionOpen`'s menu (deck and Detail) in each list. `grep -l 'useAgents\|useNarrow\|Popover' test/` — hits at planning time `ui-popover`, `tracker-chip`,
  `filter-bar`, `jira-detail`, `dialog-count-docs` (Popover); none of the `useAgents`/`useNarrow` hits counts callers — add any that do.
- [ ] **Step 4: Run** — PASS (plus `test/design-guards.test.ts test/daylight-contrast.test.ts test/ui-popover.test.tsx`).
- [ ] **Step 5: Commit** `feat(jira): split Open with a session menu on the deck and in Detail`.

### Task 5: Jira › List (mock `JiraList.dc.html`)

**Files:**
- Modify: `client/src/components/jira/JiraIssueList.tsx:25-110`, `client/src/components/jira/JiraBoardView.tsx:147,188,214-221`,
  `client/src/lib/jira-deck.ts:112-131`, `client/src/lib/jira-list.ts:276` (delete `listDotTone` once Task 6 also drops it — do it there), `styles.css`
- Test: `test/jira-board.test.tsx:1298-1360`, `test/jira-lib.test.ts:1593-1615`

**Interfaces:**
- Replace `topSessionState` with `topSessionCell(agents: readonly DeckEntry[], links: readonly SessionLink[], fold: JiraFold): Map<string, { state:
  JiraSessionState; since: string }>` — a live entry as today (first in `deckOrder`, `since` = the entry's), else the newest ended link (`endedAt`) on the
  top or any issue folded under it (`ended`, `since` = `endedAt`); no key when neither. Remove `issueCellWord` and its test.
- `JiraIssueList` gains `onRun: (issue: JiraIssue, action: JiraAction) => void`; `sessions` becomes the new map.

Behaviour (spec §4.2): columns Session, Key, Summary, Type, Status, Priority, Assignee, Sprint, Updated, then an unlabelled action cell. Session cell:
`.ui-stripe-dot` (`sessionTone`) + `STATE_LABEL` word + ` · <pollAge(since)>`, or `—`. Type: plan 1's `.jira-card-type[data-tone]` tile with `JiraTypeIcon`,
then the name. Status: `.jira-status-dot[data-tone=<statusTone>]` + raw name. Priority: `.jira-card-prio` pill (`Not prioritised` for null, the grey `low`
look, no glyph). Assignee: the 22 px `.jira-card-av` disc + name. Plan 1's classes reused, so no new tint site. Summary one line, ellipsis, full text as
`title`. Action cell: `JiraRunMenu issue onPick={(a) => onRun(issue, a)}`, visible on `.jira-issues-row:hover` and `:focus-within` only (opacity 0 → 1; it
stays in the DOM and tabbable). The FilterBar passes `showing={{ shown: rows.length, total: tops.length, note: 'options come from the loaded issues' }}`.

- [ ] **Step 1: Failing tests.** `jira-lib.test.ts`: `topSessionCell` — a live `plan` on the top → `{ plan, since }`; a live child + older ended top → the
  live one; only an ended folded child (2 h ago) → `{ ended, since: endedAt }`; two ended links → the newer; nothing → no key. `jira-board.test.tsx`:
  headers `['Session','Key','Summary','Type','Status','Priority','Assignee','Sprint','Updated','']`; :1344 expects `Working · 2h` (the link's age: `linkOn`'s last argument is hours, `hoursAgo(h)` at :1294-1297), :1352
  `Waiting on your answer`; :1345 `sessionCell('PAY-180')` is `—` and :1330 scopes its `—` lookup to the Sprint cell; a row with priority `High` has a
  `priority High` pill; each row holds one `Run PAY-…` split; an ended-only top reads `Ended · 2h`; the summary cell's `title` is the full summary.
- [ ] **Step 2: Run** `pnpm exec jest test/jira-board.test.tsx test/jira-lib.test.ts` — FAIL.
- [ ] **Step 3: Implement.** `grep -l 'JiraRunMenu\|pollAge' test/` — `jira-detail`, `jira-lib`, `tracker-lib` at planning time; add them to the run.
- [ ] **Step 4: Run** — PASS (plus `test/jira-sessions-state.test.ts`, unchanged). **Step 5: Commit** `feat(jira): List rows take the card's marks and a Run`.

### Task 6: Jira › Sessions (mock `JiraSessions.dc.html`, filled and empty)

**Files:**
- Modify: `client/src/components/jira/JiraSessionList.tsx:63-150,250-330`, `client/src/components/jira/JiraSessionsView.tsx`, `client/src/lib/jira-list.ts`
  (add `sessionsEmptyTitle`, delete `listDotTone` at :276), `client/src/styles.css` (`.jira-list-*`, drop `.jira-list-count`)
- Test: `test/jira-list.test.tsx`, `test/rail.test.tsx` (guard: `useJiraListFilters`)

**Interfaces:**
- `sessionsEmptyTitle(board: string, window: ListWindow, allTickets: boolean): string` — `No sessions on <board> in the last 24 hours` / `… 7 days` /
  `… 30 days`; `No sessions on <board>` for `all`; with `allTickets` the lead is `No linked sessions` and the window phrase follows the same way.
- `JiraSessionList` gains `boardName: string` and `onOpenJiraPage` (threaded from `JiraSessionsView`).

Behaviour (spec §4.3): the bar is `Segmented` `label="Show"` over `LIST_CHIPS` with `CHIP_LABEL` words and `count: view.counts[c]`, then a `FilterBar` whose
count is the number of non-defaults (repo, run, window ≠ `7d`, allTickets) and whose `onClear` restores those defaults (chip and search untouched): sections
`Repository` (`All repos` + one chip per `view.repos`), `Run` (`Any run` + `view.runs`), `Ended within` (`24 h`, `7 d`, `30 d`, `All`), `Tickets` (one
pressed-state chip `All tickets`, title as today); `showing` = rows shown of all rows. Rows: `tr.ui-stripe` with `sessionTone`; cells Ticket (key 600 over
the summary 12 px `--ink3`, one line each), State (`.ui-stripe-dot` + `STATE_LABEL`), Run, Repository (mono), Where, Model, Context, Started (`time ·
age`), For, then the action — `SessionOpen` for a linked session (no Unlink/Stop), `JiraRunMenu` beside Reopen on ended rows as today. Empty (no rows, no
`unavailable` gate): when the chip is `all` and search empty, a centred block — 15/600 title from `sessionsEmptyTitle`, one 13 px `--ink3` line (`Sessions
started from this board's tickets show here.`), `Go to the board` (`onOpenJiraPage('board')`) and `Show 30 days` (sets window `30d`; hidden at `30d` or
`all`); otherwise today's `No sessions match` line.

- [ ] **Step 1: Failing tests.** `chip()` (:179) reads the `Show` group's buttons unchanged; `chipCount` (:180) reads `.ui-seg-count`; :271, :361 and
  :420/:423 open `Filters` and press `All tickets` inside the dialog; a Repository chip narrows rows as the select did; `Ended within` → `30 d` widens to
  the 10-day-old ended row; Clear resets repo/run/window/allTickets and leaves the `Show` pick; rows carry `ui-stripe` with `data-tone` amber for `plan`,
  grey for `ended`; the State cell reads `Waiting for plan approval`; empty with window `24h` → `No sessions on <board> in the last 24 hours`, `Show 30
  days` sets 30 d, `Go to the board` calls `onOpenJiraPage('board')`; at `all` the button is absent; :354 `No sessions match` stands; :289/:291 Reopen
  stands. `sessionsEmptyTitle` — all four windows × `allTickets` (in `test/jira-lib.test.ts` beside the other `jira-list` helpers, or this file).
- [ ] **Step 2: Run** `pnpm exec jest test/jira-list.test.tsx test/rail.test.tsx` — FAIL. **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS (plus `test/design-guards.test.ts`; `grep -l 'listDotTone' test/` is empty). **Step 5: Commit** `feat(jira): Sessions with counted
  states, a filter popover and stripes`.

### Task 7: Launch sheet (mock `JiraLaunch.dc.html`, the sheet)

**Files:** Modify `client/src/components/jira/JiraLaunchSheet.tsx:250-410`, `client/src/lib/jira.ts` (add `launchFootLine`), `styles.css`. Test:
`test/jira-launch.test.tsx`, `test/jira-lib.test.ts`.

**Interfaces:** `launchFootLine(repo: string | null, choice: JiraBranchChoice | null): string | null` — null without a repo; `Starts in <basename>` + ` on the
checkout itself` (`none`) / ` on a new worktree` (`new`) / ` on <branch>` (`continue`); a null choice (section not ready) ends after the basename.

Behaviour (spec §4.5): the Action select becomes a `role="group" aria-label="Action"` of three 64 px picture tiles (`aria-pressed`, `aria-label` = title,
sub-line as `aria-describedby`): `End to end` (`GlyphTile` play, `plan, change, test, PR`), `Ticket loaded` (document, `you drive`), `A skill` (sparkle;
sub-line the picked skill's name, else `N on this machine`; disabled with title `no skills on this machine` when there are none). Pressing `A skill`
picks the first skill and reveals `Select label="Skill"` (the skills, plus today's stale-skill option when the action names a deleted one). Pressed tile:
`--ink3` 1.5 px stroke on `--strip-hi`, its tile `ink`. `Open in` stays the pill `Segmented`. Repository: a `Segmented label="Repository"` of basenames
(title = full path) for 2–4 paths with distinct basenames; a `Select` otherwise; static text for one path. The Segmented starts with NO option pressed (today's `choose…`,
`JiraLaunchSheet.tsx:340`) until the person picks; the gate and `Start session` behave exactly as with the select's empty value (`jira-launch` :246 stays). The prompt sits in a mono code box
(`--steel`, radius 10) with a `Copy` chip top-right (same clipboard handler as `Copy prompt`). `Assign to me` switch and the `Move to` select share a row;
Model, Effort, Permissions share the next; Remote control keeps its switch and line. Foot: `launchFootLine` at 12 px `--ink3` left, `Copy prompt` (flat)
and `Start session` (ink) right — the same gate, title and POST as today's `Start`.

- [ ] **Step 1: Failing tests.** `launchFootLine` — the three modes, null repo, null choice. `jira-launch.test.tsx`: the ~13 `Action` / `Repository`
  combobox lookups move to the tile and Segmented buttons; `startButton` (:219) and :236 → `Start session`; the default action presses its tile; a
  skill-row launch presses `A skill` and the Skill select shows that skill; a no-skill project has `A skill` disabled with its title; five paths or two
  `/a/api` + `/b/api` → a Repository combobox; the foot reads `Starts in microservice on a new worktree` for a `new` choice; `Copy` and `Copy prompt` write
  the same text; every POST payload assertion unchanged.
- [ ] **Step 2: Run** `pnpm exec jest test/jira-launch.test.tsx test/jira-lib.test.ts` — FAIL. **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS (plus `test/ui-segmented.test.tsx test/daylight-contrast.test.ts`). **Step 5: Commit** `feat(jira): launch sheet with action
  tiles`.

### Task 8: Setup — connection banner and board rows (mock `JiraSetup.dc.html`, top)

**Files:** Modify `client/src/components/jira/JiraSetupView.tsx`, `client/src/components/jira/JiraConnectionGroup.tsx`, `client/src/lib/jira.ts:483`
(`boardRowLine`), `styles.css`. Test: `test/jira-setup.test.tsx:982-1025`, `test/jira-lib.test.ts`, `test/daylight-contrast.test.ts`.

**Interfaces:** `boardRowLine` also returns `facts: string[]` (the non-null `root`/`query`/`issue` counts and `every <n>` / `sync off`) and `age: string |
null` (the polled phrase); `text` is unchanged.

Behaviour (spec §4.4): the Connection group becomes a banner card at the top: 40 px `.jira-setup-av` disc (`initialsOf(me.name)`,
`color-mix(in srgb, var(--magenta) 14%, var(--strip))`, `--magenta` 13/600; `?` with `no identity`), `Connected as <name>` 15/600, then `<site> · <tokenKind>`
12 px `--ink3` and `restart the server to change it`; three figures (label 11 px `--ink3`, value 15/600): `Last sweep` = `pollAge` of the newest board
`polledAt` (`—` when none), `Every` = `15 s` armed / `idle`, `Calls` = `calls.sweep` with the `sweepLine(...).rate` under it (red when `red`); right, a
`Pill` — `Healthy` (`live`) on `ok`; `warn` for `rate-limited` / `unreachable`; `bad` otherwise — the failing pill's text is `accessPhrase` and the server
`detail` follows on a red line. Boards: one row each — name 13/600, the facts as 11 px `Pill`s, the age at 12 px `--ink3`, `Edit`, `Open` (visible text;
`aria-label="Open board <name>"` kept); a failing board keeps its red failure line. `New board` stays the group's action.

- [ ] **Step 1: Failing tests.** `boardRowLine` facts/age for an `off` board, a never-polled board and a three-root board. Setup: the :978-1019 cases read
  the banner — `Connected as Ada Lovelace`; `every 15 s` → `Every 15 s`; idle → `Every idle`; `no 429 since start` / `last 429 4m ago` under `Calls 12` / `3`;
  `no identity`; an `unauthorized` access → a `bad` pill reading `Jira rejected the credentials` plus the detail; `ok` → `Healthy`; `restart the server to
  change it` still drawn; the scope loop at :985 is deleted (scopes are not served and not drawn, spec §4.4) — the token row is `<site> · <tokenKind>` only. Board rows show `6 roots`, `every 1m` pills and `Open` named `Open board <name>`. `PINNED`: `.jira-setup-av` (`--magenta`, 14).
- [ ] **Step 2: Run** `pnpm exec jest test/jira-setup.test.tsx test/jira-lib.test.ts test/daylight-contrast.test.ts` — FAIL. **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS (plus `grep -l 'initialsOf\|sweepLine\|accessPhrase' test/` hits). **Step 5: Commit** `feat(jira): Setup connection banner and
  board rows`.

### Task 9: Setup — repositories, worktrees, skills (mock `JiraSetup.dc.html`, lower groups)

**Files:** Modify `client/src/components/jira/JiraReposGroup.tsx:219-315`, `client/src/components/jira/JiraWorktreeRow.tsx:18`,
`client/src/components/jira/JiraSkillsGroup.tsx`, `client/src/components/settings/SettingsView.tsx:546`, `styles.css`. Test: `test/jira-setup.test.tsx`
(:776-819, :899-970), `test/settings-view.test.tsx`.

Behaviour (spec §4.4). Repositories: one row per mapping — project key `Pill`, path mono, then a toggle `Chip` `N worktrees` (`1 worktree`; `aria-expanded`,
collapsed by default; absent at zero trees), then fields `Base branch` and `Branch name`. The toggle, its worktree list and the two fields keep today's
once-per-PATH rule (`shownDefaults`, `JiraReposGroup.tsx:71,144`): drawn under a path's first mapping in key order only — `jira-setup.test.tsx:899-926`
(`/home/ada/pay` under PAY and OPS, ONE trees block) stays green. Placeholders: base `<refs.defaultBase> (default)` when the refs
read lists one, else `(default)`; pattern `{key}-{slug} (default)`. Expanded: a sub-head `Open worktrees beside this checkout` and one `WorktreeRow` per
tree. `WorktreeRow` gains `projectKey?: string`: branch 600, path mono `--ink3`, a state `Pill` (`session live` `live` when `liveKey`, else `idle`), a
ticket `Pill` from `keysInBranch(tree.branch, [projectKey])[0]` when one, and `Remove` copying `removeCommand` as today. Skills: rows in the Run menu's shape —
`GlyphTile` (play / document for built-ins, sparkle for skills), label, command sub-line 11 px mono `--ink3`, right `default` (11 px `--ink3`) on the row
`resolveJiraAction(settings.jiraDefaultAction, skills)` names, `Make default` (flat chip; `update({ jiraDefaultAction: <execute|context|skill id> })`)
on the others; built-ins first under `Built in`, then `Skills on this machine · N` with each skill's `×` kept. Settings › Local `Jira default action`
hint gains ` Saved in this browser.` at its end.

- [ ] **Step 1: Failing tests.** :776 base placeholder `main (default)` with the fixture refs (`refsAnswer.defaultBase` :167; `develop` is the stored value) (`(default)` without); :778 `{key}-{slug} (default)`;
  :899-970 click `2 worktrees` (or the fixture's count) before reading rows; the toggle is `aria-expanded="false"` then `"true"`; a tree on `PAY-131-x` with
  a live key shows `session live` and `PAY-131`; another shows `idle`; `Remove` still copies the command and posts nothing. Skills: `default` sits on the
  resolved row; `Make default` on a skill row sets `jiraDefaultAction` to its id (read back through `useSettings`); the `×` Confirm still deletes.
  `settings-view.test.tsx`: the hint ends `Saved in this browser.`
- [ ] **Step 2: Run** `pnpm exec jest test/jira-setup.test.tsx test/settings-view.test.tsx` — FAIL. **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS (plus the `useSettings` guard hit `test/csp.test.ts` and `test/daylight-contrast.test.ts`). **Step 5: Commit**
  `feat(jira): Setup repositories, worktrees and skills rows`.

### Task 10: DESIGN.md §8.9.1 / §8.9.3 / §8.9.5 overrides

**Files:** Modify `.claude/DESIGN.md` (§8.9.1 List and Sessions, §8.9.3 Setup, §8.9.5 Launch sheet and the deck card).

Write spec §4.2–§4.5 into those paragraphs, each with its reason from the spec, plus the shared pieces where §8.9 first uses them (state tones and stripe,
glyph tile, Segmented counts, the FilterBar foot). Edit sentences in place; do not reflow untouched prose. §8.7's count is Task 4's. Run
`pnpm exec jest test/design-guards.test.ts test/dialog-count-docs.test.ts`. Commit `docs(design): Jira rest restyle overrides in §8.9`.

### Task 11: `/ui-verify` against the mocks

Invoke the `ui-verify` skill on the branch. At 1440 px with fixture data (a board with six tops, one live `working`, one `plan`, one ended-only top; three
skills; two mapped repos, one with two worktrees, one live): List with a row hovered and the Filter popover open vs `JiraList.dc.html`; Sessions filled and
empty (24 h window) vs `JiraSessions.dc.html`; Setup with a worktree list expanded vs `JiraSetup.dc.html`; the launch sheet and a deck card with its menu
open vs `JiraLaunch.dc.html`. Differences in `00-mock-audit.md` "Round 2" and spec §6 (Cost column, `Needs you · plan`, `Review plan`, `Terminal`, the
phase word, the mock's dropped Sessions columns) are expected. Fix defects on the branch, re-run touched suites, commit `fix(jira): ui-verify findings` if any.
