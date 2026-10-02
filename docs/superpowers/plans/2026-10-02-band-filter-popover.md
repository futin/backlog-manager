# Band filter track and shared Popover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This plan overrides writing-plans' "code blocks required" rule, on purpose.** It specifies behaviour, signatures, exact copy and exact test cases — never
> literal code. Code handed over in a plan gets transcribed verbatim, and a bug in the plan then becomes a bug in the branch with nobody positioned to catch it
> (seven defects traced to plan text in two earlier projects, this repo among them). Where the plan and your reading of the code disagree, the spec and the
> code win: say so in your report, do not bend the code to the plan. Line numbers are as of `fdc1fb1` and will drift; find the text, not the number. The size
> of each task is a soft guide, not a budget — never compress a rule away to stay short.

**Goal:** Replace the board band's three native `<select>` chips with the dashboard's filter track (filter icon + count badge │ `Sort: <key> (<dir>)` + sort
icon), each icon opening a popover; give Archive the filter button alone; move the tracker's popover onto the same new `ui/Popover` primitive.

**Architecture:** One new primitive, `ui/Popover` (panel shell, Escape through `useDialogEscape`, its own `pointerdown` click-outside, phone shape from
`useNarrow`). One new component, `FilterBar` (the track, which popover is open, the sort popover's rows), used by Board and Archive, which keep owning their
own state and pass their filter sections in as children. `TrackerChip` renders its panel through `Popover`. No server change, no shared type change.

**Tech Stack:** React 19 + Vite client, jest + Testing Library (jsdom) for every suite this plan touches, plain CSS in `client/src/styles.css`.

**Spec:** [docs/superpowers/specs/2026-10-01-band-filter-popover-design.md](../specs/2026-10-01-band-filter-popover-design.md) — read it whole before Task 1;
its two review reports sit beside it under `docs/superpowers/reviews/`.

## Global Constraints

- Copy, verbatim: `Filters`, `Clear all`, `Project`, `· one at a time — Orchestrate needs one` (Board only), `All projects`, `Status`, `Open`, `In progress`,
  `Done`, `All`, `Sort by`, `Created` / `when it was filed`, `Name` / `title, A–Z`, `Project` / `grouped by repo`, `Ascending`, `Descending`,
  `Live cards always sort first, whatever the order.`, `Sort: Created (desc)` / `Sort: Name (asc)` / `Sort: Project (asc)`.
- Accessible names: filter button `Filters` or `Filters, N set`; sort button `Change sort`; both carry `aria-haspopup="dialog"` and `aria-expanded`.
  **Plan decision (the spec is silent):** the two popovers' dialog names are `Filters` and `Sort by`, their own headers; the tracker's stays `Tracker`.
  The Project picks are one `role="group"` named `Project`; the Status switch is `Segmented` labelled `Status`; the direction switch is `Segmented` labelled
  `Direction`; each sort option row is a `button` with `aria-pressed`.
- Count line: ` in <project name>` appended when a project is picked — `9 open in brickwright`, `9 items in brickwright`, `<n> archived in brickwright`;
  unchanged with project `all` (`31 open across 5 projects`).
- Sizes: badge text 11 px (guard 3's floor — never 10); popover widths 300 (filter, sort) and 420 (tracker); offset 8 px; `z-index: 20`.
- Class families: `.ui-popover` + `.ui-popover-narrow` inside the ui primitives block; `.filter-bar*` outside it. **Guard 7 checks every class token in an
  outside selector**, so no `.filter-bar*` rule may name `.ui-seg`, `.ui-chip` or any other family — reach the Status switch by `[role="group"]` and its
  buttons by element.
- No 700 px media block may restate `.ui-popover` (guard 7 counts the bare selector across the whole sheet). The phone shape is the `ui-popover-narrow` class.
- The picked pick is `Chip size={28} pressed` — `Chip`'s own pressed look, NOT ink (§8.3's one ink chip is Orchestrate). Status and direction switches are
  `Segmented pill`. Project dots are `Dot hue={hues.hueFor(p.name)}`.
- Every new component's header comment cites its `.claude/DESIGN.md` subsection; comments explain *why*, at the density the surrounding code has; authored
  text wraps at 160 columns; commit bodies at 72. Tests are flat in `test/` (jest).
- `usePersistedState` keys: `PROJECT_KEY` (from `lib/view-keys.ts`, unchanged), `STATUS_KEY` and `SORT_KEY` (local, unchanged), and one new direction key
  declared beside `SORT_KEY` in `BoardView.tsx` — value `'backlog-manager.sort-dir'`.

## Review Focus

The five inputs most likely to bite a real reader that the spec's own tests do not exercise — each has its test in the owning task:

1. **Upgrade with a stored sort key and no direction key.** A reader who picked `By name` last week has `backlog-manager.sort = "name"` and no direction stored.
   They must land on `Name (asc)`, A→Z, exactly as today — not on a global `desc` default. (Task 4.)
2. **Two checkouts of one repo** share a name. Both get a chip (keyed by path, never by name), each picks its own path, and the board narrows to that path's
   items. (Task 4.)
3. **A stale stored project path** (unregistered since). The filter fails open: `All projects` is the pressed chip, the button reads `Filters` with no badge,
   and the count line has no suffix. (Task 4.)
4. **Picking a project while the popover is open.** Orchestrate appears after the track; the popover stays open and is still the only one; `FilterBar` must
   not remount (its open state would be lost). (Task 4.)
5. **Clear all with a search typed and a non-default sort.** The search text and the sort label are untouched. (Task 4.)

---

### Task 1: `ui/Popover` primitive

**Files:**
- Create: `client/src/components/ui/Popover.tsx`
- Modify: `client/src/styles.css` (the ui primitives block, which starts at `/* ── ui primitives` and ends at `/* ── end ui primitives`)
- Modify: `test/design-guards.test.ts` (guard 7's `FAMILIES`)
- Modify: `docs/subsystems/board.md` (the primitive table, ~42-59), `.claude/DESIGN.md` §8.7, `docs/subsystems/invariants.md` (~1589, "nothing else floating")
- Test: `test/ui-popover.test.tsx` (new)

**Interfaces:**
- Produces: `Popover({ label: string; width: number; anchor: RefObject<HTMLElement | null>; onClose: () => void; children: ReactNode })`, exported from
  `ui/Popover.tsx`. Renders `<div className="ui-popover[ ui-popover-narrow]" role="dialog" aria-label={label}>` with the width applied inline as the
  un-capped value (the CSS caps it). The caller mounts it conditionally and renders it inside a `position: relative` wrapper that also holds the anchor.

- [ ] **Step 1: Write the failing suite** — `test/ui-popover.test.tsx`, rendering a harness with a button (the anchor), the popover mounted while a boolean
  is true, and a sibling outside both. Cases:
  - Mounted: a `dialog` named by `label` is present and contains the children. Not mounted: no `dialog`.
  - Escape calls `onClose` once.
  - With a second `useDialogEscape` entry mounted AFTER the popover (use `ui/Confirm`, which is one), Escape calls only the Confirm's dismiss, not the
    popover's `onClose`.
  - `pointerdown` on `document.body` calls `onClose`; `pointerdown` on a child inside the panel does not; `pointerdown` on the anchor does not.
  - Unmount, then Escape and a body `pointerdown`: `onClose` is not called again.
  - Narrow: with `window.matchMedia` stubbed to `{ matches: true, … }` (copy the stub shape from `test/ui-modal.test.tsx`'s
    `takes the full-screen shape from useNarrow` case, and restore it after), the dialog carries class `ui-popover-narrow`; unstubbed it does not.
  - Source check (read `client/src/styles.css` the way `test/tracker-chip.test.tsx`'s phone guard does): the `.ui-popover-narrow` rule contains
    `position: fixed`, `top: auto`, `left: 12px`, `right: 12px`, `width: auto`; the `.ui-popover` rule contains `z-index: 20` and `top: calc(100% + 8px)`.
    Carry over the phone guard's comment on why `top: auto` matters (the base `top` resolves against the viewport once fixed).
- [ ] **Step 2: Run it, see it fail** — `pnpm exec jest --runInBand test/ui-popover.test.tsx` → fails: cannot find module `ui/Popover`.
- [ ] **Step 3: Implement.**
  - `Popover`: `useDialogEscape(onClose)`; one `document` `pointerdown` listener added on mount, removed on unmount, that ignores targets inside the panel or
    inside `anchor.current`; `useNarrow()` picks the modifier class. The header comment says why dismissal has two owners (the stack owns the key, not the
    pointer — lift the reasoning from `TrackerChip.tsx`'s header), why it measures and portals nothing, why the anchor is ignored on pointerdown (the
    anchor's click toggles; closing on its pointerdown first would reopen it on the click), and that it is not counted among the dialogs (no scrim).
  - CSS, in the primitives block: `.ui-popover` — `position: absolute; top: calc(100% + 8px); right: 0; z-index: 20`, `--strip` fill, 1 px `--hairline`
    border, 12 px radius, `0 8px 24px var(--shadow2)`, 16 px padding, `color: var(--ink)`, `text-align: left`, `max-width` = viewport less 48 px divided by
    `--font-scale` (copy the `calc(… / var(--font-scale, 1))` idiom the sheet already uses for viewport measures). `.ui-popover-narrow` — `position: fixed;
    top: auto; margin-top: 8px; left: 12px; right: 12px; width: auto; max-width: none; max-height: 70vh; overflow-y: auto`. Comment: the phone reason (the
    narrow `.rail` is a scroll container) and the z-index reason (Archive's sticky month kickers).
  - Guard 7: add `'.ui-popover'` to `FAMILIES`.
  - Docs: board.md's primitive table gains a `Popover` row (`.ui-popover`; `label`, `width`, `anchor`, `onClose`, children; used by `FilterBar` and
    `TrackerChip`). DESIGN.md §8.7 and invariants.md's "nothing else floating" sentence each gain one clause admitting `Popover`'s panels, which float
    without a scrim.
- [ ] **Step 4: Run** the new suite plus `test/design-guards.test.ts`, `test/dialog-count-docs.test.ts`, `test/claude-rules.test.ts` → all pass.
- [ ] **Step 5: Commit** — `feat(ui): add the Popover primitive`.

### Task 2: the tracker popover moves onto `Popover`

**Files:**
- Modify: `client/src/components/TrackerChip.tsx` (the `pointerdown` effect ~39-46; `TrackerPopover` ~143-196; the header comment ~19-22)
- Modify: `client/src/styles.css` (`.tracker-pop` ~338-342 and its 700 px rule ~363)
- Modify: `client/src/hooks/useDialogEscape.ts` (header ~30, ref comment ~72), `.claude/rules/board.md` (Escape bullet), `docs/subsystems/invariants.md`
  (Escape section, ~1593), `docs/subsystems/board.md` (~110, ~254-256), `.claude/DESIGN.md` §8.0 (the tracker sentence, ~186)
- Test: `test/tracker-chip.test.tsx`

**Interfaces:**
- Consumes: `Popover` (Task 1).
- Produces: nothing new. `TrackerPopover` stays file-private.

- [ ] **Step 1: Change the tests first.**
  - Replace the phone guard `escapes the phone rail: under 700 px the popover is fixed, not absolute` with: under a matching `matchMedia` stub, the open
    `Tracker` dialog carries `ui-popover-narrow`. (The CSS half moved to the Popover suite in Task 1.)
  - Add, if not already present: a section change closes the popover; the dialog is named `Tracker`; `pointerdown` inside the panel keeps it open.
  - Keep every other existing case as is (opens on click, Escape closes, outside pointerdown closes, rows and API line render).
- [ ] **Step 2: Run** `pnpm exec jest --runInBand test/tracker-chip.test.tsx` → the narrow case fails (no `ui-popover-narrow` on the panel yet).
- [ ] **Step 3: Implement.**
  - `TrackerPopover` renders through `Popover` at `width={420}`, `label="Tracker"`, anchored to the chip button (a new ref on it). Its content markup and
    `.tracker-pop-*` content classes stay. Drop its own `useDialogEscape` call and `TrackerChip`'s `pointerdown` effect — `Popover` owns both now. Keep the
    section-change effect. Drop `data-testid="tracker-pop"` only if nothing reads it (`grep -rn "tracker-pop\"" test/` — today nothing does).
  - CSS: delete the `.tracker-pop` shell rule and its 700 px override, keeping the comment's 420 px reasoning by moving it to the `width={420}` call site.
    Keep `.tracker-pop-id`, `-who`, `-sub`, `-api`, `-note` and the rest.
  - Docs: everywhere the non-dialog Escape entries are listed as `Confirm` and `TrackerPopover`, name `Confirm` and `Popover` (the tracker's, and from
    Task 4 the band's two). The `useDialogEscape.ts` ref comment says "the tracker popover" — it becomes `Popover`. **`Three of them now, not four` stays
    word for word**, and "three dialogs" stays true. DESIGN.md §8.0's tracker sentence records the visible change: 12 px radius (was 16), `0 8px 24px`
    shadow (was `0 24px 64px`), a hairline border, 16 px padding (was 14/16), 8 px offset (was 6). board.md's tracker paragraph says its dismissal is
    `Popover`'s.
- [ ] **Step 4: Run** `test/tracker-chip.test.tsx`, `test/rail-bar-style.test.ts`, `test/dialog-count-docs.test.ts`, `test/claude-rules.test.ts`,
  `test/design-guards.test.ts` → pass.
- [ ] **Step 5: Commit** — `refactor(tracker): render the tracker popover through Popover`.

### Task 3: `FilterBar`

**Files:**
- Create: `client/src/components/FilterBar.tsx`
- Modify: `client/src/styles.css` (a `.filter-bar*` block beside `.board-band-search`, ~390, outside the primitives block)
- Modify: `docs/subsystems/board.md` (~72, the top-level `components/` list gains `FilterBar`)
- Test: `test/filter-bar.test.tsx` (new)

**Interfaces:**
- Consumes: `Popover` (Task 1).
- Produces, from `FilterBar.tsx`:
  - `type SortDir = 'asc' | 'desc'`.
  - `FilterBar({ count: number; onClear: () => void; children: ReactNode; sort?: FilterBarSort })` — `children` is the filter popover's body, below its
    `Filters` / `Clear all` header.
  - `type FilterBarSort<K extends string> = { key: K; dir: SortDir; options: { value: K; label: string; hint: string }[]; onKey: (k: K) => void;
    onDir: (d: SortDir) => void }`. (Generic or `string`-keyed — your call; Board's `SortKey` must type-check through it.)
  - `ProjectPicks({ projects: RegistryProject[]; value: string; allValue: string; hues: ProjectHues; hint?: string; onPick: (path: string) => void })` —
    the `Project` section both pages use, so its markup has one home: the `Project` heading with the optional hint, then `All projects` and one chip per
    project keyed by **path**, labelled by name, with its hue dot.

- [ ] **Step 1: Write the failing suite** — `test/filter-bar.test.tsx`. Cases:
  - Count 0: the filter button is named `Filters`, shows no badge, lacks class `on`. Count 2: named `Filters, 2 set`, badge text `2`, has class `on`.
  - Clicking the filter button opens a dialog named `Filters` holding the children and the `Clear all` control; clicking the button again closes it;
    `aria-expanded` follows.
  - `Clear all` calls `onClear` at count 2; at count 0 it is inert (`aria-disabled`, and clicking does not call `onClear`). The popover stays open after it.
  - With `sort`: the label reads `Sort: Created (desc)` for `{ key: 'created', dir: 'desc' }`; clicking `Change sort` opens a dialog named `Sort by` with
    the three rows, the chosen row `aria-pressed="true"`, a `Direction` switch and the foot line. Clicking a row calls `onKey` with its value; clicking
    `Ascending` calls `onDir('asc')`. Neither closes the popover.
  - One at a time: with the filter popover open, clicking `Change sort` leaves only the `Sort by` dialog in the document.
  - No `sort` prop: no `Change sort` button, no `Sort:` text, no divider element.
  - `ProjectPicks`: `All projects` plus one chip per project in registry order; exactly one chip is `aria-pressed="true"` — `All projects` when `value === allValue`,
    otherwise the chip whose path equals `value` (callers pass the fail-open `projectValue`, so a stale path never reaches it); clicking a chip calls `onPick`
    with that project's **path**; with two projects of the same name, two chips render and each reports its own path; `hint` renders after the heading only
    when given.
- [ ] **Step 2: Run** `pnpm exec jest --runInBand test/filter-bar.test.tsx` → fails: module not found.
- [ ] **Step 3: Implement.**
  - Wrapper: one `position: relative` element with `margin-left: auto` (the dashboard's `.ctlwrap`; comment why — the band's right slot wraps, and the
    track must stay at the right of its line so a right-aligned 300 px panel stays on-screen), holding the track and, after it, whichever `Popover` is open
    (`width={300}`, anchored to its own button). Both panels therefore share the track's right edge — the spec says so in §1.
  - Track: `--hairline2` fill, 12 px radius, 3 px padding. Icon buttons 34 × 30, `border: 0`, 9 px radius, `--ink2`; class `on` = `--strip` fill and
    `0 1px 2px var(--shadow)`, colour `--ink`. Icons: the dashboard's funnel and up/down arrows at 18 px, stroke 1.5 — take the SVG paths from
    `../claude-agents-dashboard/client/src/components/Toolbar.tsx`, `aria-hidden`. Badge: 16 px disc, `--ink` fill, `--strip` text at 11 px / 500, at
    the button's top-right. Divider 1 × 18, `--ink3` at 45 % opacity. Sort label 13 px `--ink2`, key in a `<b>` at `--ink` 500, `white-space: nowrap`;
    hidden in the 700 px block (a `.filter-bar-sortlab` rule there is fine — it is not a primitive family).
  - Filter popover body: header row (`Filters` 14 px / 500 `--ink`; `Clear all` 12 px `--ink2` at its right, `--ink3` while inert), then children.
    Section headings 12 px `--ink2`, hint `--ink3`. Picks wrap with a 6 px gap.
  - Sort popover: `Sort by` header; three 36 px option rows (label 13 px / 500, hint 11 px `--ink3`, tick visible only when chosen); 1 px `--hairline`
    rule; `Segmented pill` `Direction` with `Ascending` / `Descending`; foot line 11 px `--ink3`. Its comment notes the foot line is this board's own.
  - Status switch full width: `.filter-bar-switch > [role="group"] { display: flex }` and `.filter-bar-switch button { flex: 1 }` — or equivalent with no
    family token in the selector (Global Constraints). Comment: content-sized it overflows the 268 px content box by ~2 px.
  - Header comment: §8.3 (and §8.5 for Archive's use); one popover at a time; picks do not close it (the dashboard's behaviour).
- [ ] **Step 4: Run** `test/filter-bar.test.tsx` and `test/design-guards.test.ts` → pass.
- [ ] **Step 5: Commit** — `feat(board): add the FilterBar track and its popovers`.

### Task 4: the Board band uses `FilterBar`, and sort gains a direction

**Files:**
- Modify: `client/src/components/board/BoardView.tsx` (keys ~28-45; `COMPARATORS` and `sortItems` ~100-175 and their call site; the query comment ~259-262;
  the count line ~484-492; the band ~663-735; the Orchestrate click comment ~786-792)
- Modify: `client/src/lib/view-keys.ts` (header ~10-16: the direction key joins the two Board-only keys kept local)
- Modify: `.claude/DESIGN.md` §8.3 (the band paragraph), `docs/subsystems/board.md` (~77, the band sentence)
- Create: `test/helpers/filter-bar.ts`
- Test: `test/board.test.tsx`, `test/tracker-board.test.tsx`, `test/orchestrator-start-ui.test.tsx` (~201-210 only — the sheet's own selects stay),
  `test/board-live-cards.test.tsx`

**Interfaces:**
- Consumes: `FilterBar`, `ProjectPicks`, `SortDir` (Task 3).
- Produces (test-only): `test/helpers/filter-bar.ts` — `pickProject(name: string, nth = 0)`, `pickStatus(label: 'Open' | 'In progress' | 'Done' | 'All')`,
  `pickSort(label: 'Created' | 'Name' | 'Project')`, `pickDirection(label: 'Ascending' | 'Descending')`, `clearFilters()`. Each opens its popover if that
  dialog is not already open, then clicks within the dialog; none closes it. Async, using `userEvent`.

- [ ] **Step 1: Migrate the existing cases, then write the new ones.** Every `userEvent.selectOptions(getByLabelText('Project' | 'Status' | 'Sort'), …)` in
  the four suites becomes the matching helper (paths → project names: `/abs/alpha` → `alpha`; status values → labels: `started` → `In progress`; sort
  `name` → `Name`). Assertions about what the board shows stay, except count lines with a project picked gain the suffix (`2 done` → `2 done in alpha`).
  `status select offers open, in progress, done and all, in that order` becomes: the `Status` switch's buttons read `Open`, `In progress`, `Done`, `All`.
  New cases in `board.test.tsx`:
  - The band holds no `<select>`; it holds `Search items`, the `Filters` button and `Change sort`, and Orchestrate renders after the track once a project is
    picked.
  - Picking `beta` narrows every column and the count line reads `<n> open in beta`.
  - Clear all after picking `alpha` and `Done`: all projects, `Open`, count line `5 open across 2 projects`, button `Filters`.
  - Sort `Name` + `Ascending` orders A→Z and + `Descending` Z→A; `Created` + `Descending` is newest first; `Project` + `Descending` orders projects Z→A
    and keeps newest first inside each project.
  - An in-progress card is first in its column under `Created` with both directions.
  - Natural direction: from `Created (desc)`, picking `Name` reads `Sort: Name (asc)`; with `Created (asc)` showing, picking `Created` again leaves
    `Sort: Created (asc)`.
  - Stored direction `"sideways"` with sort `name` → `Sort: Name (asc)` and A→Z. Stored sort `"newest"` still falls back to `created` (existing case).
  - Stored status `"stale"`: no `Status` button pressed, button `Filters, 1 set`, count line `0 items across 0 projects`; Clear all restores `Open` and
    `5 open across 2 projects`.
  - **Review Focus 1:** sort `"name"` stored, no direction key → `Sort: Name (asc)`, A→Z.
  - **Review Focus 2:** two registered projects named `alpha` at different paths, items in each → two `alpha` chips; picking the second shows only the
    second path's items.
  - **Review Focus 3:** stored project `"/abs/gone"` → `All projects` pressed, button `Filters`, no badge, count line `5 open across 2 projects`.
  - **Review Focus 4:** open the filter popover, pick `alpha` → the `Filters` dialog is still open, Orchestrate is visible, one dialog in the document.
  - **Review Focus 5:** type `bug` in search, pick `Name`, pick `alpha`, Clear all → search still `bug`, label still `Sort: Name (asc)`.
- [ ] **Step 2: Run** the four suites → the migrated and new cases fail (no `Filters` button yet).
- [ ] **Step 3: Implement.**
  - Direction state: `usePersistedState<SortDir | null>(SORT_DIR_KEY, null)`; the effective direction is the stored one when it is `'asc'` or `'desc'`,
    otherwise the current key's natural direction (`created` → `desc`, `name`/`project` → `asc`). That is what makes Review Focus 1 hold: the fallback is
    `null`, never a fixed direction. Picking a **different** key stores the new key and that key's natural direction; re-picking the current key stores
    nothing; the switch stores the direction it was given.
  - Comparators: the direction flips the key's OWN comparison only. `liveRank` stays the primary key in both directions; `project`'s newest-first tie-break
    does not flip. The `?? COMPARATORS.created` fallback stays, and its long comment's "the Status select sitting right above it" passage is rewritten:
    the recovery for a stale status is now the raised filter button and `Clear all`.
  - Filter count = (`projectValue` ≠ `ALL`) + (`status` ≠ `'open'`) — `projectValue`, the fail-open value. Clear all sets project `ALL` and status `open`.
  - Band children, in order: `RunChip`, search, `FilterBar` (children: `ProjectPicks` with the Board hint, then the `Status` heading and its
    `Segmented pill` switch; `sort` with the three options and hints), then Orchestrate. `FilterBar` must be one stable element whatever the filters are,
    so its open state survives a pick (Review Focus 4).
  - Count line: append ` in ${name}` when `projectValue !== ALL`, the name read from `registered` by path.
  - Comments: the query comment ("the selects … permanently state their own value") now credits the raised filter button and the count line's project name;
    the Orchestrate click comment's "the filter is a live `<select>`" says the filter can change between click and answer; the band's header comment
    describes the track instead of three filter chips.
  - Docs: DESIGN.md §8.3's band paragraph describes the track, both popovers, the pressed-chip look and why it is not ink; board.md ~77 the same in a line;
    `lib/view-keys.ts`'s header names the direction key among the Board-only keys kept local.
- [ ] **Step 4: Run** the four suites, then `pnpm run test:jest` → pass, except the two WSL-kernel supertest-bind cases if this is that machine (they fail
  on a pristine tree too; prove it there rather than chasing them).
- [ ] **Step 5: Commit** — `feat(board): filter track with sort direction replaces the band's selects`.

### Task 5: Archive uses `FilterBar`, and the select styling goes

**Files:**
- Modify: `client/src/components/archive/ArchiveView.tsx` (the project comment ~131-135, the fail-open comment ~147-149, the count line ~193-194, the band
  and its comment ~229-271)
- Modify: `client/src/styles.css` (`.board-filter`, `.board-filter:focus`, `.board-filter-mark` ~397-409 and the Board section comment ~385 "one search
  field and one filter select, declared once"; the Runs project select comment ~1716-1718, whose "Same shape the Board's own filters wear" clause goes)
- Modify: `.claude/DESIGN.md` §8.5 (Archive's band sentence)
- Test: `test/archive.test.tsx`

**Interfaces:**
- Consumes: `FilterBar`, `ProjectPicks` (Task 3); `test/helpers/filter-bar.ts` (Task 4).

- [ ] **Step 1: Tests.** Migrate `archive.test.tsx` ~421 to `pickProject('alpha')`. Rewrite the band case (~330-337): it holds `Search items` and the
  `Filters` button; `queryByRole('button', { name: 'Change sort' })` and `queryByLabelText('Sort')` are both absent; the open `Filters` dialog has the
  `Project` group and no `Status` group; the `Project` heading carries no hint text (no `Orchestrate needs one` anywhere in the dialog). Picking `alpha`
  suffixes the count line: `<n> archived in alpha`.
- [ ] **Step 2: Run** `pnpm exec jest --runInBand test/archive.test.tsx` → fails.
- [ ] **Step 3: Implement.** Band: search, then `FilterBar` with no `sort` and `ProjectPicks` without a hint; count = (`projectValue` ≠ `ALL`); Clear all
  sets `ALL`. Count line gains ` in <name>`. Rewrite the three comments that name the select (the chip-wrapped select is gone; the raised button and the
  suffixed count line now state the filter). Delete the `.board-filter*` rules — `grep -rn "board-filter" client/ test/` must come back empty — and the
  stale clauses in the two CSS comments. DESIGN.md §8.5: the band holds search and the filter button, Project only.
- [ ] **Step 4: Run** `test/archive.test.tsx`, `test/design-guards.test.ts` → pass.
- [ ] **Step 5: Commit** — `feat(archive): filter button replaces the project select`.

### Task 6: whole-suite and in-browser verification

- [ ] `pnpm test` (both runners), `pnpm run typecheck`, `pnpm run build` → green (WSL caveat as in Task 4). Paste the summary lines in the report.
- [ ] In the browser, daylight theme, on a dev server you start and stop yourself by recorded pid (never a pattern kill): at 1440 × 900 and at 375 × 812,
  open each popover on Board and Archive and the tracker popover. Check: the panels' right edge meets the track's; nothing clips under Archive's month
  kickers; on the phone the panels are full width under their button and the sort label is hidden; the badge digit is legible; the Status switch fits in
  one row. Report what you saw, with screenshots.
- [ ] Fix anything found as its own commit, then hand back. Do not push — publishing is the user's call.
