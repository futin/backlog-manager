# Jira Board: one column per status, ordered per board

Status: written, awaiting approval. Date: 2026-11-18. Branch `feat/jira-status-columns`. Amends
[2026-11-18-jira-parent-lanes-design.md](2026-11-18-jira-parent-lanes-design.md) §3.1 and §3.3 (the three category columns).

## Intent

Moving a TIMIFY ticket to `In Testing` or `In Review` makes it look as if it left the Board. It has not: the payload still carries it
(on 2026-11-18, `My sprint tasks` had 9 To Do, 1 In Testing, 1 In Review and 3 Done). The Board draws three columns, one per Jira **status category**
(`JIRA_COLUMNS` in `client/src/lib/jira.ts`), and the TIMIFY workflow files `In Testing` and `In Review` under the **To Do** category. So those cards land
in the To Do column among work nobody has started, and the In Progress column they came from goes empty.

The user wants the Board laid out the way their Jira board is: a column for each status (`To Do`, `In Progress`, `In Review`, `In Testing`, `Done`), so a
ticket's status and its column always agree.

## Goals

- One column per **status name** on the Board's lanes, in place of the three category columns: the shared column header and every lane's cells.
- The column order is **per board**, saved in `jira.json`, and edited in the board's settings sheet. Ordering by category alone cannot get it right: on
  TIMIFY the category order puts `In Review` and `In Testing` before `In Progress`.
- A status that appears on the board for the first time gets a column on its own, in a predictable place, with nothing to set up.

## Non-goals

- Reading the columns of a real Jira (agile) board. Tested 2026-11-18: the configured token gets `401 scope does not match` on `/rest/agile/1.0/board`,
  and a board built from roots or JQL has no Jira board behind it anyway.
- Hiding a status or merging several statuses into one column. Can come later on top of the saved order.
- Moving an issue by dragging it between columns. Status changes stay in Detail.
- The List. Its Status column already names the status, and it stays as it is.

## Anti-goals

- A card must never vanish because its status is missing from the saved order. Every status present gets a column.
- Category keeps every meaning it has today: the status dot's tone, the spread bar's three tones, a lane being settled (all Done), the Done window. Only
  the **column a card sits in** moves from category to status name.

## Approaches

| | Approach | Trade-off |
|-|----------|-----------|
| **Picked** | **Per-board order.** A column for each status on the board, with a default order and a per-board order saved in `jira.json` | No new token scope, and it works for boards built from roots and JQL. It costs a write route field and a sheet section |
| | Import the Jira board's columns | Matches Jira exactly, several statuses to a column included, but needs a new token with board scope, a board id on every saved board, and a fallback for boards that have no Jira board |
| | Fixed name heuristic (`To Do`, `In Progress`, `In Review`, `In Testing`, `QA`, `Done`, …) | Cheapest, but nothing can be configured and an unknown status ends up in a guessed spot |

The user picked the per-board order on 2026-11-18.

## Design

**Columns.** The Board's columns are the distinct `status.name` values among the board's **cards** (lane-header issues sit in no column, as today), plus
every name in the board's saved order whether or not a card has it now, so a column the user placed does not jump away while it is empty. A column's dot
takes the tone of its status's category (`statusTone`). A saved name that no card on the board carries has no category to read, so it is drawn neutral.

**Order** (my call). The saved names come first, in the saved order. Every name that is not saved goes in by **category rank** (new, then indeterminate,
then done): it sits after the last column of a lower or equal rank and before the first column of a higher rank. Two unsaved names of the same category are
ordered by name. With nothing saved, that gives category order with names sorted inside it. So the first time it opens, TIMIFY reads `In Review`,
`In Testing`, `To Do`, `In Progress`, `Done`, and one reorder in the sheet fixes it for good.

**Storage.** `JiraBoard` gains `columns: string[]`, status names in order and `[]` when nothing is saved. `readBoard` keeps every non-empty trimmed string
and drops the rest with the usual per-entry warning. A missing key reads as `[]`, so every board saved before this change still loads. `parseBoardWrite`
accepts an optional `columns` (an array of 1–100-character strings, at most 50 of them, duplicates removed in order); when a write leaves it out, the
board's stored value is kept. That way the existing sheet save cannot wipe the order.

**Sheet.** The board settings sheet (`JiraBoardSheet.tsx`) gains a `Columns` section: one row per column in the order above, using the same derivation fed
with the board's currently loaded issues, each row with up and down buttons, plus `Reset to default`. Saving writes the full list as it is drawn.
Reordering saves with the rest of the sheet. There is no live preview.

**Board.** `JiraLaneBoard` draws its header and its cells from the derived list instead of `JIRA_COLUMNS`. A cell's key becomes `lane:status-name`, which
means a cell opened past its cut is remembered per status. The counts are per column. `laneColumnCounts` keys by status name. The cut of 5 per cell is
unchanged.

**Width.** The header grid and the cell grid take `repeat(N, minmax(240px, 1fr))` from a CSS variable the component sets (`--jira-cols: N`). When N
columns do not fit, `.jira-lanes` scrolls sideways as a single block, so the header stays over its cells. The `max-width: 700px` single-column rule stays.

**Untouched.** `columnOf`, `foldProgress`, the spread bar, the settled-lane rule, `statusTone` and the List keep reading category. `columnOf` is renamed
only if it would read wrong beside the new status-keyed helper. That is the builder's call.

## Tests (behaviour, not code)

- The derivation, given TIMIFY's statuses (To Do / new, In Progress / indeterminate, In Review / new, In Testing / new, Done / done):
  - with no saved order → `In Review, In Testing, To Do, In Progress, Done`;
  - with saved `[To Do, In Progress, In Review, In Testing, Done]` → exactly that;
  - with saved `[To Do, In Progress, Done]` → `In Review` and `In Testing` go after `To Do` (the last saved new-rank column) and before `In Progress`, in
    name order.
- A saved name with no card still draws a column, with a count of 0 and the neutral tone.
- A card whose status is `In Testing` sits in the `In Testing` cell, not in `To Do`.
- `readBoard`: a missing `columns` → `[]`; a non-string entry is dropped with a warning and the board kept.
- `parseBoardWrite`: a write that leaves `columns` out keeps the stored order; an over-long name, more than 50 names, or a non-array → 400 naming
  `columns`.
- The sheet: moving a row up and saving posts the new order; `Reset to default` posts `[]`.
- The design guards (`test/guards/design-guards.test.ts`) and the source guards the touched symbols are pinned in still pass.

## Left to the builder

- Where the derivation lives (`client/src/lib/jira.ts` beside `laneColumnCounts` is the natural home).
- The exact layout of the sheet section, which composes `components/ui/` primitives per `.claude/DESIGN.md`.
- Which subsystem docs need a line (`docs/subsystems/jira.md` for `columns`, `board.md` for the columns).
- `/ui-verify` on the live TIMIFY board as the last plan task, including a 5-column board at the pane's width.
