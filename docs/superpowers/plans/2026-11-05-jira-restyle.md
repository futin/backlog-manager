# Jira restyle (split Run, grouped menu, card marks, Move-to popover) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Jira board's Run control, Run menu, card, columns and detail dialog per the Jira restyle spec, without changing what any action does.

**Architecture:** One new primitive (`ui/SplitChip`) and one glyph file (`ui/Glyphs.tsx`); three pure tone helpers in `client/src/lib/jira.ts`; the rest is
`JiraRunMenu`, `JiraCard`, `BoardColumn` (one optional prop), `JiraShelves` and `JiraDetail` composing them, with CSS in `client/src/styles.css`.

**Tech Stack:** React + TypeScript (Vite), plain CSS with daylight tokens (`shared/theme.css`), jest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-11-05-jira-restyle-design.md` (plan 1 of 4 in `docs/superpowers/specs/2026-11-05-app-restyle-design.md` §10).
Mocks: `docs/superpowers/specs/2026-11-05-jira-restyle-mockups/` (`RunButton.dc.html` column A, `Card.dc.html` "proposed · idle", `Board.dc.html`,
`Modal.dc.html`) and `00-mock-audit.md` for what each mock draws that is NOT built.

**How to read this plan (override of writing-plans' code-block rule).** This plan gives behaviour, names, signatures, exact values and exact test CASES —
never literal code. Write the code and the test bodies yourself; if a case here looks wrong against the code, say so in your report rather than transcribe
it. Line counts are soft. Where the plan and the spec differ, the spec wins; report the difference.

## Global Constraints

- Line cites predate #472 (b3c73fa5, merged under this plan): `client/src/lib/jira.ts` cites past :574 sit 12 lines lower (`runChipState` :738,
  `skillCommand` :757, `resolveJiraAction` :767, `transitionOptions` :861) and `test/jira-board.test.tsx` cites past :298 sit 28 lower. Find by content.
- Uppercase: `text-transform: uppercase` stays in exactly one rule, `.rail-kicker`. Menu headers are sentence case, 11/600 `--ink3`, `letter-spacing: .04em`.
- Type floor: every px font-size ≥ 11 px (mock 10.5 / 11.5 px → 11 px).
- Tint form: `color-mix(in srgb, var(--<mark>) N%, var(--strip)|var(--steel))`, marks `--green-solid --amber-solid --red --magenta --cyan --mustard`; a word on
  a tint keeps 4.5:1; never bare `var(--amber)` in `styles.css`.
- Every `ui-*` family is declared once, inside `/* ── ui primitives` … `/* ── end ui primitives` in `client/src/styles.css`.
- CSP `style-src 'self'`: no `style=` attributes in markup, no `<style>` element; per-element values go through CSSOM (none planned).
- No new theme tokens, no dark-only rules.
- Tests: flat in `test/`, jest. Run only touched suites locally (`pnpm exec jest <files>`); CI runs the rest. Before each commit,
  `grep -l <symbol> test/` for every shared symbol the task adds a caller of, and add the hits to the run.
- Comments explain why, at the repo's existing density. Wrap new prose at 160 columns.
- Commit after each task: `git add <paths>` then `git commit` (never `git add -A`), message ending with
  the executing session's own attribution line.

## Review Focus

1. A Jira site with a custom priority scheme (`P1`, `Blocker`, `Trivial`) — the pill must draw the grey tone with no glyph, not crash or vanish (Task 3).
2. A preferred action that names a skill that no longer exists (`jiraDefaultAction` stale) — the left half must pick what `resolveJiraAction` falls back to,
   and the `default` mark must sit on that same row (Task 2).
3. Two transitions landing in one status, and a transition back to the current status — rows must use `transitionOptions` labels and the current-status row
   is `aria-disabled` and first (Task 6).
4. A double click on a Move-to row while the post is out — one POST only; the chip is disabled while `busy` (Task 6).
5. A project with zero, one and three mapped repository paths — foot draws nothing / basename / `3 repos` with all paths in its title (Task 3).

---

### Task 1: `ui/Glyphs` and the `ui/SplitChip` primitive

**Files:**
- Create: `client/src/components/ui/Glyphs.tsx`, `client/src/components/ui/SplitChip.tsx`, `test/ui-split.test.tsx`
- Modify: `client/src/styles.css` (inside the primitives block), `test/design-guards.test.ts:323` (`FAMILIES`)

**Interfaces:**
- Produces: `Glyph({ name, size? }: { name: GlyphName; size?: 14 | 16 | 10 })` and
  `type GlyphName = 'play' | 'document' | 'sparkle' | 'robot' | 'person' | 'flag' | 'branch' | 'tag' | 'calendar' | 'ring' | 'grid' | 'tick' | 'up' | 'down' | 'equals'`
  — outline, 1.5 px stroke, round joins, `currentColor`, `aria-hidden`, default 14 px box. You draw the paths.
- Produces: `SplitChip(props)` with `label: string` (main half's `aria-label`), `labelMore: string` (chevron half's `aria-label`), `children: ReactNode`
  (main half's visible content), `icon?: ReactNode`, `onMain(): void`, `onMore(): void`, `open: boolean` (chevron `aria-expanded`, `Chevron dir="up"`
  while open), `disabled?: boolean` (both halves), `dashed?: boolean`, `size?: 28 | 32` (default 28), `title?: string` (group AND both halves),
  `moreRef?: RefObject<HTMLButtonElement>` (the chevron button, for the Popover anchor and focus return). Renders
  `<span role="group" class="ui-split [ui-split-28] [ui-split-dashed]">` with two `<button type="button">`: `.ui-split-main` and `.ui-split-more`
  (`aria-haspopup="dialog"`). Both halves stop click propagation and Enter/Space keydown propagation (a card is the usual parent).

- [ ] **Step 1: Write the failing tests** in `test/ui-split.test.tsx`:
  - renders a group holding exactly two buttons, named by `label` and `labelMore`;
  - clicking the main half calls `onMain` once and `onMore` zero times; the reverse for the chevron;
  - `disabled` disables both buttons; `dashed` puts `ui-split-dashed` on the group; `size={32}` drops `ui-split-28`;
  - `open` sets `aria-expanded="true"` on the chevron, `false` otherwise; the chevron has `aria-haspopup="dialog"`;
  - `title` lands on the group and on both buttons;
  - a click and an Enter keydown on either half do not reach a parent `onClick` / `onKeyDown` spy.
  - `test/design-guards.test.ts`: append `'ui-split'` to `FAMILIES`.
- [ ] **Step 2: Run** `pnpm exec jest test/ui-split.test.tsx test/design-guards.test.ts` — expect FAIL (module missing; family not declared).
- [ ] **Step 3: Implement** `Glyphs.tsx`, `SplitChip.tsx`, and the `.ui-split*` rules inside the primitives block: radius 10; heights 28 / 32; ink fill on
  the `.ui-chip-ink` precedent (`--ink` ground, `--on-accent` text); a 1 px divider between halves in `--on-accent` at reduced opacity via a pseudo-element
  `opacity` (not a `color-mix` over `transparent`); hover lifts only the hovered half to `--ink2`; `.ui-split-dashed` = `--strip` ground, dashed
  `--hairline2`, `--ink3` text (today's no-repo chip look); `:disabled` cursor default, no hover lift.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(jira): SplitChip primitive and outline glyphs`.

### Task 2: `JiraRunMenu` becomes the split Run with a grouped menu (mock `RunButton.dc.html`, column A)

**Files:**
- Modify: `client/src/components/jira/JiraRunMenu.tsx` (whole component; `MODAL_PANEL_WIDTH` at :62 goes), `client/src/styles.css` (`.jira-run*` section)
- Test: `test/jira-board.test.tsx`, `test/jira-detail.test.tsx`, `test/jira-list.test.tsx`, `test/daylight-contrast.test.ts`

**Interfaces:**
- Consumes: `SplitChip`, `Glyph` (Task 1); `runChipState`, `resolveJiraAction`, `skillCommand` (`client/src/lib/jira.ts:726,745,755`); `pollAge`
  (`client/src/lib/tracker.ts:37`); `Popover` (`ui/Popover.tsx:39`).
- Produces: unchanged signature `JiraRunMenu({ issue, onPick, home = 'card' })`, `home: 'card' | 'modal'`; size 28 for `card` (also the Sessions rows,
  which pass no `home`), 32 for `modal`.

Behaviour (spec §4.1): left half = `Run <key>` (aria) showing play glyph + `Run`; click calls `onPick(resolveJiraAction(settings.jiraDefaultAction,
data.skills))` and does NOT open the menu. Chevron = `Run options for <key>`, toggles a 300 px `Popover` labelled `Run menu` in every home. Menu order:
header `Built in`; `execute` row (sub-line `Work the ticket end to end`), `context` row (`Open with the ticket loaded`); header `Skills on this machine · N`
and one row per skill in `data.skills` order (sub-line `skillCommand(prompt)` in mono) — header omitted when N is 0; footer `Every choice opens the launch
sheet first` above a hairline. Rows 40 px, 28 px radius-8 tile on `--strip-hi` with a 14 px `--ink2` glyph (play / document / sparkle). The preferred row
stays in place (no longer pulled first), its tile `color-mix(in srgb, var(--green-solid) 14%, var(--strip))` with a `--green` glyph and a right-end tick +
`default` at 11/500 `--green`; the row's accessible name is its label only (sub-line and mark `aria-hidden`). After a pick the menu closes and focus moves to
the chevron. States from `runChipState` (unchanged): `no-repo` → `dashed` + `disabled`, title `no repository mapped for <key> — Jira › Setup ›
Repositories`; `live` → `disabled`, title `a session is running on <key>`, text `Running` + ` · <age>` — `pollAge` of `status.live[key].startedAt` (`JiraLiveSession.startedAt`, `shared/types.ts:922`) when that entry exists, else of the
newest open `how === 'run'` link's `startedAt` in `sessions.links` (the same predicate `runChipState` uses, `lib/jira.ts:733-735`) — a 6 px steady `--green-solid` dot before
it, and the Jira-local tint `.jira-run[data-state='live'] > [role='group']` = `color-mix(in srgb, var(--green-solid) 14%, var(--strip))` with `--green`
text. Spec §4.1 writes this selector as `… .ui-split`, which guard 7 (`test/design-guards.test.ts:380-396`) fails: no selector outside the primitives block
may carry a `ui-*` family token anywhere in it. The `> [role='group']` form follows the `> button` precedent at `styles.css:1288`; report the deviation.
`data-state` stays on the `.jira-run` wrapper. `.jira-run[data-state='no-repo'] > button { border-style: dashed }` (`styles.css:1288`) goes (the `dashed`
prop replaces it); `.jira-modal-controls .jira-run { position: static }` (`:1293`) is removed in Task 5, with the modal controls row.

- [ ] **Step 1: Update/write the failing tests.**
  - `jira-board.test.tsx`: a card's foot holds buttons `Run <key>` and `Run options for <key>`; clicking `Run <key>` opens the launch sheet with the default
    action and no dialog named `Run menu` appears; clicking `Run options for <key>` opens `Run menu`; with `jiraDefaultAction` set to a skill, the row
    carrying `default` is that skill and the first row is still `execute`; with `jiraDefaultAction` naming a skill not in `data.skills`, `default` sits on
    the row `resolveJiraAction` returns; with `data.skills` empty there is no `Skills on this machine` text; the footer text is exactly `Every choice opens
    the launch sheet first` (the existing `opens the launch sheet` assertion at :831 moves to it); after picking a row, `document.activeElement` is
    `Run options for <key>`. The existing no-repo case at :761-767 asserts BOTH halves are disabled and carry the no-repo title. The sites that click
    `runChip()` (`/^Run PAY-/`, the left half, :756) and then read `Run menu` — :826, :838, :849, :862, :931 — click `Run options for <key>` instead.
  - `jira-detail.test.tsx`: `modalRun()` still finds `Run PAY-131`; clicking it opens the launch sheet with no `Run menu`; `Run options for PAY-131` opens it;
    `live` and `no-repo` cases assert both halves disabled with the existing titles; the live left half's text starts `Running`; the existing :580 case
    (`SESSION()`, started 3 h back) reads `Running · 3h`; and with only a live link (no `status.live` entry) started
    `hoursAgo(2)` reads `Running · 2h`. The sites that click `modalRun()` and then read `Run menu` — :550, :555, :568, :1061 — click `Run options for
    PAY-131`; :570 `--ui-popover-width` `234px` → `300px`; :572-573 (`scrollIntoView({ block: 'nearest' })` on open in the modal) STAYS — the band can still
    sit in a column that scrolls under 700 px. :589-590 (no-repo click opens nothing) stands.
  - `jira-list.test.tsx` (Sessions rows): the sites at :308 and :500-501 that click `Run PAY-131` and expect `Run menu` (:290 only asserts presence and stands) click `Run options for
    PAY-131` instead; add one case: clicking `Run PAY-131` on a Sessions row opens the launch sheet directly.
  - `daylight-contrast.test.ts` `PINNED`: add `.jira-run-opt-default .jira-run-tile` (`--green-solid`, 14, `--strip`) and `.jira-run[data-state='live'] >
    [role='group']` (`--green-solid`, 14, `--strip`) — the key must equal the CSS selector after whitespace normalisation, quotes included; retitle the case from `the ten tint sites` to the new count after Task 3.
- [ ] **Step 2: Run** `pnpm exec jest test/jira-board.test.tsx test/jira-detail.test.tsx test/jira-list.test.tsx test/daylight-contrast.test.ts` — FAIL.
- [ ] **Step 3: Implement** in `JiraRunMenu.tsx` and the `.jira-run*` CSS.
- [ ] **Step 4: Run** the same command plus `test/design-guards.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(jira): split Run button and grouped Run menu`.

### Task 3: Card marks (mock `Card.dc.html`, "proposed · idle")

**Files:**
- Modify: `client/src/lib/jira.ts` (three helpers), `client/src/components/jira/JiraCard.tsx`, `client/src/styles.css` (`.jira-card-*`)
- Test: `test/jira-lib.test.ts`, `test/jira-board.test.tsx`, `test/daylight-contrast.test.ts`

**Interfaces:**
- Produces in `client/src/lib/jira.ts`:
  - `priorityTone(name: string | null): 'high' | 'med' | 'low' | 'other' | null` — case-insensitive: `highest`/`high` → `high`, `medium` → `med`,
    `low`/`lowest` → `low`, any other string → `other`, `null` → `null`.
  - `typeTone(type: JiraIssue['type']): 'bug' | 'story' | 'neutral'` — the SAME precedence `JiraTypeIcon` uses (`ui/JiraTypeIcon.tsx:5-13`): a sub-task or a
    level ≥ 1 type is `neutral` whatever its name; then name `bug` → `bug`, `story` → `story`; else `neutral`. Extract the shared test so both read it.
  - `statusTone(category: JiraStatusCategory): JiraColumnSlug` — via `JIRA_COLUMNS` (`new` → `todo`, `indeterminate` → `doing`, `done` → `done`).
- Consumes: `Glyph` (Task 1); `useJiraContext` for `status.repos[issue.project.key]` (the read is `lib/jira.ts:731`).

Behaviour (spec §4.2): head = 18 px radius-5 `.jira-card-type[data-tone]` tile around `JiraTypeIcon` (bug `color-mix(--red 12%, --strip)` + `--red`
glyph; story `color-mix(--green-solid 14%, --strip)` + `--green`; neutral `--strip-hi` + `--ink2`; title = type name), key at 600 `--ink`, crumb as today,
priority pill pushed right. Priority pill `.jira-card-prio[data-tone]`, 18 px, radius 999, 11/500: `high` red 12% + `--red` text + up glyph; `med`
`--amber-solid` 14% + `--amber-ink` + equals glyph; `low` `--strip-hi` + `--ink3` + down glyph; `other` the low look with no glyph; `null` nothing; title
`priority <name>`. Who row: 22 px disc `color-mix(--magenta 14%, --strip)`, initials 11/600 `--magenta` (unassigned keeps today's dashed empty disc), name
12/400 `--ink2`, then a 6 px `.jira-status-dot[data-tone=<statusTone>]` (`todo` `--ink3`, `doing` `--amber-solid`, `done` `--green-solid`) and the RAW status
name at 12/500 `--ink2` replacing the neutral `Pill`; age and `↗` unchanged. Foot (always drawn): left, branch glyph + basename of the one mapped path, or
`N repos`, title = all paths joined; nothing when none mapped; then the existing `match` marker and worktree chip; right, the split Run. The ended line
stays after the foot.

- [ ] **Step 1: Failing tests.**
  - `jira-lib.test.ts`: `priorityTone` for `Highest`, `high`, `MEDIUM`, `Low`, `lowest`, `P1` (→ `other`), `''` (→ `other`; the card treats `''` like `null` and draws no pill, as `JiraDetail.tsx:364` does), `null`; `typeTone` for a bug, a
    story, a task, a sub-task whose type name is `Bug` (→ `neutral`), an epic named `Story` at level 1 (→ `neutral`); `statusTone` for all three categories.
  - `jira-board.test.tsx`: `High` → a pill titled `priority High` with `data-tone="high"` and a glyph; `Medium` → `med`; `Lowest` → `low`; `P1` → `other`
    and no glyph; `null` → no element titled `priority …`. Status renders `In Review` (no `· in progress`) and a `.jira-status-dot` with
    `data-tone="doing"`. Type tile `data-tone` is `bug` / `story` / `neutral` for the three fixture types. Foot repository: one path `/x/microservice` →
    text `microservice`; two paths → `2 repos` with both paths in its title; none mapped → no repository element; the `ended-line` still follows the foot.
  - `daylight-contrast.test.ts` `PINNED`: `.jira-card-type[data-tone="bug"]` (`--red`, 12, `--strip`), `[data-tone="story"]` (`--green-solid`, 14,
    `--strip`), `.jira-card-prio[data-tone="high"]` (`--red`, 12, `--strip`), `[data-tone="med"]` (`--amber-solid`, 14, `--strip`), `.jira-card-av`
    (`--magenta`, 14, `--strip`); the words `--red`, `--amber-ink`, `--magenta`, `--green` pass 4.5:1 over those tints on daylight. Retitle the case to the
    count it now pins.
- [ ] **Step 2: Run** `pnpm exec jest test/jira-lib.test.ts test/jira-board.test.tsx test/daylight-contrast.test.ts` — FAIL.
- [ ] **Step 3: Implement** helpers, `JiraCard`, CSS. `grep -l 'JiraTypeIcon\|initialsOf' test/` and add hits to the run.
- [ ] **Step 4: Run** — PASS (plus `test/design-guards.test.ts`).
- [ ] **Step 5: Commit** `feat(jira): card marks — type tile, priority pill, status dot, repository foot`.

### Task 4: Jira columns take a tone and a ground (mock `Board.dc.html`)

**Files:**
- Modify: `client/src/components/board/BoardColumn.tsx:63`, `client/src/components/jira/JiraShelves.tsx:54`, `client/src/styles.css`
- Test: `test/jira-board.test.tsx`, `test/board-column.test.tsx`, `test/archive.test.tsx`

**Interfaces:**
- Consumes: `JiraColumnSlug` (`JIRA_COLUMNS`).
- Produces: `BoardColumn` gains optional `tone?: 'todo' | 'doing' | 'done'`, written as `data-tone` on the column root; only `JiraShelves` passes it.

Behaviour (spec §4.3): with `tone`, the column has a `--steel` ground, radius 16, 12 px padding with the header inside; header dot `--ink3` / `--amber-solid`
/ `--green-solid`; name 13/600 `--ink`; count pill on `--strip` at 11/500 `--ink2` (not a new `Pill` tone). Mechanism: `Dot` has no such tones and a page
rule naming `.ui-dot` / `.ui-pill` fails guard 7, so with `tone` set `BoardColumn` draws a page-local `.board-col-dot` span in place of `Dot` and a
page-local `.board-col-count` span in place of the `Pill` (inside the existing
`.board-col-pill` `data-testid="col-count"` wrapper, which five `jira-board` assertions read), both styled under `.board-col[data-tone]`. Without `tone`, nothing changes (still `Dot` +
`Pill`).

- [ ] **Step 1: Failing tests.** Jira shelves: the three columns carry `data-tone` `todo`, `doing`, `done` in that order, each with one `.board-col-dot`
  and a `.board-col-count` holding the column's count. A Board (and Archive, if a suite
  renders it) column has no `data-tone` attribute.
- [ ] **Step 2: Run** the suites — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS (plus `test/design-guards.test.ts`, `test/daylight-contrast.test.ts`).
- [ ] **Step 5: Commit** `feat(jira): toned column ground on the Jira shelves`.

### Task 5: Detail dialog — head tile, Agent band, glyph-labelled facts (mock `Modal.dc.html`)

**Files:**
- Modify: `client/src/components/jira/JiraDetail.tsx`, `client/src/components/ui/Fact.tsx` (gains `icon?: ReactNode`), `client/src/styles.css`
  (`.jira-detail-*`)
- Test: `test/jira-detail.test.tsx`

**Interfaces:**
- Consumes: `typeTone` (Task 3), `Glyph` (Task 1), `JiraRunMenu home="modal"` (Task 2).

Behaviour (spec §4.4, "Head", "Agent column", "Ticket column"): crumbs lead with the Task 3 type tile; key 600 `--ink`; title stays 22/600. The Agent column
opens with `.jira-detail-agent-band` (`--strip`, radius 12, 16 px padding): the `Agent` label row; when no session is live, a 36 px dashed tile with a
16 px robot glyph in `--ink3`, `No session on this ticket` 13/500 `--ink`, sub-line 12 `--ink3` `default: <default action's label> · last run <age>` (`last
run <age>` = `pollAge(endedAt, now)` of the newest ended link — the same `ended` list `History` draws, `JiraDetail.tsx:304-311` — and `· last run …` is
omitted when `ended` is empty; no repository here), and the 32 px split Run on that row; with live sessions, `.jira-sess` cards follow inside the
band and the Run sits on the label row, with `Next session takes over once this one ends.` (`JiraDetail.tsx:316`) beside it. `History` stays below the
band. The `.jira-modal-controls jira-detail-run` row and `no session is running on this ticket` (`:301`) go. Facts `dl`: label column 96 px, each `dt` a
14 px glyph + word — via `Fact`'s new optional `icon`, drawn as an `aria-hidden` sibling BEFORE the label, the word left a direct text node of the `dt`
(the suite's `fact()` helper, `test/jira-detail.test.tsx:194-200`, matches direct text only; the item modal passes no icon and is unchanged) (Status ring, Assignee person, Reporter person, Priority flag, Sprint calendar, Parent branch, Labels tag, Created · updated calendar, On
boards grid, Repository branch, Session play); all eleven rows, order and conditions as today. Values as today except: priority = the Task 3 pill;
assignee gets the 22 px magenta disc before the name; labels as 24 px `--strip-hi` chips `.jira-detail-label` at 11/500 `--ink2`, wrapping.

- [ ] **Step 1: Failing tests.** No live session: the band shows `No session on this ticket`; with the built-in default the sub-line is exactly
  `default: Work it end to end`, with `jiraDefaultAction` set to the `Groom ticket` skill fixture it is `default: Groom ticket` (two cases, so a
  sub-line-vs-label swap fails); the button `Run PAY-131` is inside `.jira-detail-agent-band`. With one ended link `endedAt: hoursAgo(1)` the sub-line ends
  `· last run 1h`; with none it has no `last run`. Existing cases that invert: :548 (`.jira-modal-controls` contains the Run) → the band contains it; :748
  (`no session is running on this ticket`) → that text is absent and `No session on this ticket` present; :808-814 (Run last in the column, after
  `.jira-hist-list`) → the band, holding the Run, PRECEDES `.jira-hist-list`. With a live
  session the `.jira-sess` card is inside the band. Facts: `Priority` value has `data-tone`; labels render one element per label; the eleven `dt` words
  are unchanged and in today's order (`On boards`, `Repository`, `Session` assertions stand).
- [ ] **Step 2: Run** `pnpm exec jest test/jira-detail.test.tsx` — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS (plus guards).
- [ ] **Step 5: Commit** `feat(jira): detail Agent band and glyph-labelled facts`.

### Task 6: Status chip + Move-to popover, the eighth Popover composer (mock `Modal.dc.html`)

**Files:**
- Modify: `client/src/components/jira/JiraDetail.tsx:237,348-353`, `client/src/styles.css`, `client/src/hooks/useDialogEscape.ts:47`,
  `.claude/rules/board.md:20`, `docs/subsystems/invariants.md:2242`, `.claude/DESIGN.md` (§8.7 paragraph naming `Popover` — seven composers)
- Test: `test/jira-detail.test.tsx`, `test/dialog-count-docs.test.ts:94`

**Interfaces:**
- Consumes: `statusTone` (Task 3), `transitionOptions` (`lib/jira.ts:849`), `Popover`, `Chip`, `Chevron`, `Glyph`.

Behaviour (spec §4.4, "Status and Move to"): one 28 px `Chip` `.jira-detail-status` — 6 px `statusTone` dot, raw status name, `Chevron` — with
`aria-label="Move to"`, `aria-haspopup="dialog"`, `aria-expanded`; opens a 240 px `Popover` labelled `Move to`: header `Move to` 11/600 `--ink3`; one 36 px row
per transition, Jira's order, except the row whose `to.name` equals the current status (when offered) which is drawn FIRST with a stroked tick and
`aria-disabled="true"` (clicking it does nothing) — every row landing on the
current status is pinned first, in Jira's order, then the rest in Jira's order; each row a 6 px dot in `statusTone(t.to.category)` and the `transitionOptions` label; footer `Jira
transitions, applied on click` 11 px `--ink3`. A pick posts `POST /api/jira/issue/transition { key, transitionId }` once and closes. Disabled exactly when the
select was (`busy || !moveReady`), titles `transitions unavailable` (failed detail read) / `no transitions offered` (empty), no title while loading or busy.
The `· <category>` word after the status goes. First enabled row takes focus on open.

- [ ] **Step 1: Failing tests** (`jira-detail.test.tsx`): `moveSelect()` → the button named `Move to`; opening shows a dialog `Move to` with one row per
  transition labelled by `transitionOptions` (the existing two-to-one-status fixture shows the transitions' own names); a row click posts `{ key,
  transitionId }` exactly once and closes the dialog; two quick clicks post once; the chip is disabled while the post is pending; title `transitions
  unavailable` after a failed read; `no transitions offered` on an empty list; current status pinning, two fixtures: (a) a new three-transition fixture `[Start → In Progress, Back to
  review → In Review, Done → Done]` on an `In Review` issue renders rows `[In Review (aria-disabled), In Progress, Done]` (labels are
  `transitionOptions`', i.e. the landing status when unique); (b) the :867-874 fixture renders
  `[In Review, In Review (2)]` both `aria-disabled`, then `In Testing`. Focus: on open the first ENABLED row is `document.activeElement` (in (a), `In Progress`);
  Escape closes and returns focus to the `Move to` chip. The four `In Review ·
  in progress` assertions (:235, :421, :437, :446) become `In Review` plus a dot with
  `data-tone="doing"`. `dialog-count-docs.test.ts`: `seven composers` → `eight composers` (the hook comment), DIALOG count assertions unchanged.
- [ ] **Step 2: Run** `pnpm exec jest test/jira-detail.test.tsx test/dialog-count-docs.test.ts` — FAIL.
- [ ] **Step 3: Implement**; move "seven composers" → "eight composers" in `useDialogEscape.ts`, `board.md`, `invariants.md` and `DESIGN.md` §8.7, naming
  `JiraDetail`'s Move-to popover in each list.
- [ ] **Step 4: Run** — PASS (plus `test/design-guards.test.ts`, `test/daylight-contrast.test.ts`).
- [ ] **Step 5: Commit** `feat(jira): status chip with a Move-to popover`.

### Task 7: DESIGN.md §8.9.1 / §8.9.2 overrides

**Files:** Modify: `.claude/DESIGN.md` (§8.9.1 "The card", "Columns", "`Run ▾` and the ended line"; §8.9.2 "Agent column", "Ticket column", "Controls").

Write spec §7's first four bullets into those paragraphs (the fifth, §8.7's composer count, is Task 6's), each with its reason from the spec (§4.2 for the priority sentence it replaces). Edit sentences in
place; do not reflow untouched prose. No test; run `pnpm exec jest test/design-guards.test.ts test/dialog-count-docs.test.ts` in case either reads
DESIGN.md. Commit `docs(design): Jira restyle overrides in §8.9`.

### Task 8: `/ui-verify` against the mocks

Invoke the `ui-verify` skill on the branch. Compare at 1440 px with fixture data (a project with skills, one with none, a no-repo project, a live
session): the shelves vs `Board.dc.html`; a card vs `Card.dc.html` (idle); the open Run menu vs `RunButton.dc.html` column A; the dialog with the Move-to
popover open vs `Modal.dc.html`; plus the dialog under 700 px (band stacks above the Ticket pane; 32 px Run and both popovers fit). Differences listed in
`00-mock-audit.md` as not built are expected. Fix defects on the branch, re-run the touched suites, commit `fix(jira): ui-verify findings` if any.
