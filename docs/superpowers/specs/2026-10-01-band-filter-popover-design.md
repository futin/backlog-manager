# Board band: the dashboard's filter track and a shared Popover

Date: 2026-10-01. Status: approved in brainstorming. Mock A of three, rendered by injection into the live board in daylight (the contact sheet stayed in the brainstorm
session's scratchpad; §1 describes what it drew).

## Why

The two apps sit in neighbouring tabs. Since `f311b1e` their rails match to the pixel; the next thing a reader sees change when switching tabs is the
toolbar. The dashboard's (`../claude-agents-dashboard/client/src/components/Toolbar.tsx`) is one recessed track — a filter icon that carries a count badge
and lifts onto paper while something is filtered, a divider, `Sort: <key> (<dir>)` and a sort icon — each icon opening a popover. This board's band has a
search field and three native `<select>`s in outline chips, so the picker is the OS's own and nothing on the band says "something is hidden" except the
selects' current text.

What the user asked for: the band should look like the dashboard's toolbar. What they decided (2026-10-01, in order):

1. The project filter stays **single-select** — Orchestrate needs exactly one project picked, and that rule stays as it is.
2. Sort gains an **ascending/descending** direction, so the label can read like the dashboard's.
3. **Archive** gets the same filter button (Project only).
4. The count line **names the picked project** (`9 open in brickwright`), because the picker is now behind a popover.
5. Mock **A**: search stays its own field; the track holds filter and sort only.
6. **`TrackerPopover` moves onto the same new `Popover`** in this change, so the board has one popover look.

## 1. What it looks like

Band, left to right on the right-hand side: run chip · search field · **filter track** · Orchestrate. Nothing else moves; the title and count line stay left.

- **Track**: `--hairline2` fill, 12 px radius, 3 px padding — the dashboard's `.seg` ground. Inside it, two 34 × 30 icon buttons with 18 px, 1.5 px-stroke
  outline icons (the dashboard's funnel and up/down arrows), a 1 × 18 px `--ink3` divider at 45 % opacity, and the 13 px `--ink2` sort label whose key is
  `--ink` 500: `Sort: Created (desc)`.
- **Filter button state**: raised (`--strip` fill, `0 1px 2px var(--shadow)`) only while a filter is set — §8's "a raised control marks a state, never a
  button". The badge is a 16 px `--ink` disc with `--strip` text at **11 px** (the dashboard draws 10 px; design guard 3 puts this board's floor at 11).
- **Popover panel** — the dashboard's `.pop` and `.acct-pop`, which share one shell: `--strip`, 1 px `--hairline` border, 12 px radius,
  `0 8px 24px var(--shadow2)`, 16 px padding, 8 px below its button, right-aligned to it. Width is the caller's (300 px for the filter and sort popovers,
  420 px for the tracker's), capped at the viewport less 48 px, divided by `--font-scale` like every other viewport measure in this sheet.
- **Filter popover**: a header row `Filters` with `Clear all` at its right (12 px `--ink2`, `--ink3` and inert when nothing is set). `Project` — hint
  `· one at a time — Orchestrate needs one` — over pick chips: `All projects`, then every registered project with its project-hue `Dot`. `Status` over a
  four-way switch: `Open`, `In progress`, `Done`, `All`.
- **Sort popover**: header `Sort by`; three option rows, each label with an 11 px `--ink3` hint and a tick shown only on the chosen one — `Created` (when it
  was filed), `Name` (title, A–Z), `Project` (grouped by repo); a 1 px rule; an `Ascending` / `Descending` switch; an 11 px `--ink3` foot line,
  `Live cards always sort first, whatever the order.`
- **Below 700 px** the sort label is not drawn; the two icons stay.

Reuse, per §12.1's one-home rule: pick chips are `Chip` at `size={28}` with `pressed` for the chosen one (that is the filled ink look the mock draws); both
switches are `Segmented` with `pill`, the skin Settings' density and text-size rows already use; project dots are `Dot hue`. The track, the icon button, the divider, the sort label and the
option row are new and live in `FilterBar`'s own class family, not in `components/ui/`.

## 2. Components

### `ui/Popover` (new primitive)

Owns the panel and the two ways it closes; owns nothing about what is inside it.

- Props: an accessible `label`, a `width`, the `anchor` element (the button that opens it, as a ref), `onClose`, children.
- Rendered only while open — the caller mounts it conditionally — which is what lets it join the Escape stack with a plain `useDialogEscape(onClose)`, the
  shape `ui/Confirm` and `TrackerPopover` already have: mounted last, it is topmost; unmounted, the key goes back to whatever is under it.
- Click-outside is its own `document` `pointerdown` listener, because the stack owns the key and not the pointer (the reasoning `TrackerChip.tsx` already
  records). A pointerdown inside the panel or on the `anchor` is not "outside": the anchor's own click toggles it, and closing on its pointerdown first would
  reopen it on the click.
- `role="dialog"` and `aria-label={label}`. It is not counted among the dialogs (it paints no scrim), exactly like `Confirm` and the tracker popover today.
- Class family `ui-popover`, declared once inside the ui primitives block (design guard 7).

### `TrackerPopover` (moved)

Renders through `Popover` at 420 px. Its own `.tracker-pop` shell rule goes — position, radius, padding and shadow are `Popover`'s now — and its content
rules (`.tracker-pop-id`, rows, the API line) stay. Its `pointerdown` listener in `TrackerChip` goes too, because `Popover` carries it. Visible change: 16 →
12 px radius, the deep `0 24px 64px` shadow becomes the dashboard's `0 8px 24px`, a hairline border appears, padding 14/16 → 16. DESIGN.md §8.0's tracker
paragraph is rewritten to say so.

### `FilterBar` (new, `client/src/components/FilterBar.tsx`)

The track and its two popovers, used by Board and Archive.

- Props: the filter popover's content (the caller's sections), the count of filters set, `onClear`, and an optional sort description — the current key and
  direction, the three options with their labels and hints, and the two setters. No sort prop → the track is the filter button alone (Archive).
- Owns which popover is open: one at a time, opening one closes the other, clicking the open one's button closes it.
- Buttons: `aria-haspopup="dialog"`, `aria-expanded`; the filter button's `aria-label` is `Filters` or `Filters, N set`; the sort button's is `Change sort`.

## 3. Behaviour

### Filters

- **Project**: unchanged state — `usePersistedState(PROJECT_KEY, 'all')`, path-valued, name-labelled, with the existing fail-open on a stale stored path.
  Picking a chip sets it; picking the chosen one again does nothing (there is always exactly one selection, `All projects` included).
- **Status**: unchanged state and values (`open`, `started`, `done`, `all`), labels `Open`, `In progress`, `Done`, `All`, persisted under `STATUS_KEY`.
- **Count of filters set** = (project ≠ all) + (status ≠ open). The search query is not counted: it is visible in its own field.
- **Clear all** sets project to `all` and status to `open`. It does not clear the search and does not touch sort.
- **Count line**: when a project is picked, the existing line gains ` in <project name>` — Board: `9 open in brickwright`, `4 in progress in brickwright`;
  Archive builds the same suffix onto its own line. With `all` the line is unchanged (`31 open across 5 projects`).
- **Orchestrate**: every rule unchanged. It still reads `projectValue`, still hides on an unfiltered board, and its click handler still captures the path at
  click time.

### Sort

- Keys unchanged (`created`, `name`, `project`), still persisted under `SORT_KEY`, still falling back to `created` on an unrecognised stored value.
- **Direction**: a new persisted value under a new key in `lib/view-keys.ts` (`asc` | `desc`). Each key has a natural direction — `created` → `desc` (newest
  first, today's default), `name` and `project` → `asc` (A–Z, today's behaviour). Picking a key in the popover sets its natural direction; the switch then
  flips it. An unrecognised stored direction falls back to the current key's natural one.
- The direction applies to the key's **own** comparison only. `project`'s tie-break (newest first within a project) stays newest first in both directions.
- `liveRank` stays the primary key in both directions: in-progress cards sort first whichever way the selected key runs.
- Label: `Sort: Created (desc)`, `Sort: Name (asc)`, `Sort: Project (asc)`.

### Closing

Escape closes the topmost entry on the stack and nothing under it — with the filter popover open inside a page that also has the item modal open, Escape
closes whichever mounted last. Pointerdown outside closes. Selecting a pick or an option does **not** close the popover (the dashboard's behaviour: several
changes in one visit); Clear all does not close it either.

## 4. Tests

Behaviour, not literal code: these are the cases the plan must make exist. Where a test currently drives a `<select>` by its `aria-label`, it now opens
the popover by its button and clicks the pick — the assertion about what the board shows stays the same.

**`ui/Popover` (new suite)**

- Renders a `role="dialog"` named by `label` when mounted; nothing when not.
- Escape calls `onClose`; with a second stack entry mounted after it, Escape calls only the later one's.
- Pointerdown on `document.body` calls `onClose`; pointerdown inside the panel does not; pointerdown on the anchor does not.
- Unmounting removes its Escape entry and its pointerdown listener (a later Escape and a later body pointerdown call nothing).

**`FilterBar`**

- Filter button label is `Filters` at count 0 and `Filters, 2 set` at count 2; the badge shows `2`; the button carries the raised state only when count > 0.
- Opening sort while filter is open closes filter; clicking the open button again closes it.
- No sort prop → no sort button, no divider, no sort label.

**Board** (`board.test.tsx` and the suites that drive its selects: `tracker-board`, `orchestrator-start-ui`, `board-live-cards`)

- The band holds the run chip, search, the filter track and Orchestrate, and no `<select>`.
- Picking a project narrows every column by `projectPath` (today's case, through the popover) and the count line reads `<n> open in <name>`.
- Status: Done shows only done items inside their own columns; In progress narrows to started items; the switch offers the four labels in order.
- Clear all after picking a project and Done restores all projects and Open; Clear all is inert at count 0.
- Sort: `Name` ascending orders A→Z and descending Z→A; `Created` descending is newest first (today's default case); `Project` descending orders projects
  Z→A while keeping newest first inside each project.
- An in-progress card sorts above the others under `Created` ascending as well as descending.
- A stored unrecognised direction falls back to the key's natural direction; an unrecognised key still falls back to `created` (today's case).
- Picking `Name` after `Created (desc)` lands on `Name (asc)`.
- Orchestrate appears once a project is picked through the popover, exactly where it appeared through the select.

**Archive** (`archive.test.tsx`)

- The band holds search and a filter button and no sort control; the filter popover has Project only — no Status section.
- Picking a project narrows Archive and suffixes its count line.

**Tracker chip** (its existing suites)

- Every current behaviour holds through `Popover`: opens on click, Escape closes it, outside pointerdown closes it, its rows and API line render.

**Design guards**

- Guard 7's family list gains `ui-popover`, declared once inside the primitives block.
- No px-literal font size in the new rules is under 11 (guard 3, unchanged — it will catch a copied 10 px badge).

## 5. Docs

- `.claude/DESIGN.md` §8.3 — the band paragraph describes the track and both popovers instead of the three filter chips; §8.0 — the tracker popover's shell
  is `Popover`'s; §8.5 — Archive's band sentence names the filter button with Project only.
- `docs/subsystems/board.md` — the primitive table gains a `Popover` row (`.ui-popover`; `label`, `width`, `anchor`, `onClose`, children; used by the band's
  `FilterBar` and `TrackerChip`), and any sentence naming the band's selects is rewritten.
- `.claude/rules/board.md` — the Escape bullet's list of non-dialog stack entries reads `Confirm` and `Popover` (the tracker's, and the band's two) instead
  of naming `TrackerPopover`; still three dialogs counted. Its reasoning section in `docs/subsystems/invariants.md` (`## Escape has one owner…`) gets the
  same correction. CLAUDE.md's headline is unchanged, so `test/claude-rules.test.ts` keeps passing byte-for-byte.

## Out of scope

- Multi-select projects (decided against: Orchestrate's single-project rule).
- Moving search into the track (mock B, decided against).
- Any change to the Runs page's own band filters.
- The dashboard's view switcher: this board has one layout.
