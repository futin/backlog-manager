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

**Columns.** The Board's columns are the distinct non-empty `status.name` values among **every issue of the loaded, unfiltered list** — cards and
on-board lane headers alike, so a status only a parent carries still has its column — plus every name in the board's saved order whether or not an issue
has it now, so a column the user placed does not jump away while it is empty. Filters and search change only the counts and the cards, never the set of
columns. Lane-header issues still sit in no column and are not counted, as today. A status's category is the one of the **first issue seen** in the loaded
list's order, the rule `boardFilterOptions` already applies to a name two categories share (`client/src/lib/jira.ts`), and its rank is that
`CATEGORY_RANK`. A column's dot takes its category's tone (`statusTone`); a saved name no loaded issue carries has no category, and its dot takes the
`todo` tone, the page's default grey.

**Order** (my call). Start from the saved names in their saved order. Then take the unsaved names sorted by `CATEGORY_RANK` and then by name (the
`byText` compare `boardFilterOptions` uses), and insert each one in turn **immediately after the last column already in the list whose rank is lower than or
equal to its own**, or at the front when there is none. A saved name with no category has no rank and is skipped by that search. With nothing saved, this
gives category order with names sorted inside it: on the TIMIFY payload quoted above (no `In Progress` card), the first open reads `In Review`,
`In Testing`, `To Do`, `Done`. With `In Progress` on the list too, it reads `In Review`, `In Testing`, `To Do`, `In Progress`, `Done`. One reorder in the
sheet, adding `In Progress` by name if no issue has it yet, fixes it for good.

**Storage.** `JiraBoard` gains `columns: string[]`, status names in order and `[]` when nothing is saved. Read and write apply one normalisation: trim
each entry, drop any that is not a string or whose trimmed length is not 1–100, remove duplicates (first one kept), keep the first 50. `readBoard` warns
per dropped entry in the usual way; a missing or non-array `columns` reads as `[]`, so every board saved before this change still loads.
`parseBoardWrite` accepts an optional `columns`. A non-array is a 400 with `columns must be an array of status names`; bad entries are dropped rather than
refused, so one odd status name can never fail a save of the board's name and queries. When a write leaves `columns` out, `writeBoard`'s
`{ ...stored, ...board }` merge keeps the stored value.

**Sheet.** The board settings sheet (`JiraBoardSheet.tsx`) gains a `Columns` section, hint `the Board's columns, left to right`. Its rows come from the
same derivation as the Board, fed with the issues of the sheet's one existing mount read of `/api/jira/boards/:id/issues` (today it seeds the roots'
summaries) and with the section's working list, which starts as the board's saved `columns`. Until that read lands, or when it fails (the read stays
silent and is not retried, as today), or on a new board (which has no read), the rows are the working list alone. When the read lands, the unsaved
statuses join by the Order rule, and every move already made survives, because a move edits the working list and the working list is the "saved" input.
- Each row: the status name, `Move <name> up` and `Move <name> down` icon buttons (accessible names exact; the first row's up and the last row's down are
  disabled), and, only on a row no loaded issue carries, `Remove <name>`, which takes it out of the working list. A status some issue carries cannot be
  removed: it would come straight back.
- Under the rows: a text field with placeholder `Add a status by name` and an `Add` button, which appends the trimmed name to the working list (no-op when
  it is empty or already there). This is how a column exists before any issue has that status.
- `Reset to default` empties the working list.
- Empty, with no rows: `No columns yet — they appear once this board has issues.`
- On save the sheet sends `columns` only when the section was touched (a move, add, remove or reset). It then sends the full list as drawn, or `[]` after a
  reset with nothing touched since. An untouched section leaves `columns` out, and the stored order is kept. Names the write would drop are never sent: the
  derivation skips empty names, and `Add` refuses a name over 100 characters, the field's `maxLength`.
- No live preview: the Board takes the order on save, as it takes the rest of the board.

**Board.** `JiraLaneBoard` draws its header and its cells from the derived list instead of `JIRA_COLUMNS`. A cell's key becomes `lane:status-name`, which
means a cell opened past its cut is remembered per status. The counts are per column. `laneColumnCounts` keys by status name. The cut of 5 per cell is
unchanged. When there are no columns at all (an empty list and nothing saved), the header row draws no columns and the empty line (`No issues`)
stays under it.

**Width.** The header grid and the cell grid take `repeat(var(--jira-cols), minmax(0, 1fr))`, as today with a variable count. The component sets
`--jira-cols` to `max(N, 1)` through React's `style` prop, which writes CSSOM and is allowed under the `style-src 'self'` CSP, as
`ui/Popover.tsx` does with `--ui-popover-width`. There is no sideways scroll: `.jira-lanes` stays the sticky header's container, and columns share the
width as the three do today. At 1440 px, five columns are about 230 px each; past about seven columns, cards get narrow, a known limit. Nested lanes keep
today's indent. The `max-width: 700px` single-column rule stays.

**Untouched.** `columnOf`, `foldProgress`, the spread bar, the settled-lane rule, `statusTone` and the List keep reading category. `columnOf` is renamed
only if it would read wrong beside the new status-keyed helper. That is the builder's call.

## Tests (behaviour, not code)

- The derivation, given TIMIFY's statuses (To Do / new, In Progress / indeterminate, In Review / new, In Testing / new, Done / done):
  - with all five on the list and nothing saved → `In Review, In Testing, To Do, In Progress, Done`;
  - with no `In Progress` issue and nothing saved → `In Review, In Testing, To Do, Done`;
  - with saved `[To Do, In Progress, In Review, In Testing, Done]` → exactly that;
  - with saved `[To Do, In Progress, Done]` → `To Do, In Review, In Testing, In Progress, Done` (both are new-rank: each goes right after the last
    column of rank ≤ new, so `In Review` lands after `To Do` and `In Testing` after `In Review`);
  - with the non-monotone saved `[To Do, In Progress, In Review, In Testing, Done]` and a new `Blocked` (new) → `Blocked` goes after `In Testing`, before
    `Done`;
  - with an unsaved `QA` (indeterminate) and saved `[In Progress, To Do]` → `In Progress, To Do, QA` (the last column of rank ≤ indeterminate is
    `To Do`, rank new);
  - with nothing on the list and nothing saved → `[]`.
- A status only an on-board lane header carries still gets a column, and a status with an empty name gets none.
- A name carried as `new` by the first issue and `indeterminate` by a later one takes `new`.
- Filtering to one status keeps every column; only the counts and cards change.
- A saved name no issue carries still draws a column, with a count of 0 and the `todo` tone.
- A card whose status is `In Testing` sits in the `In Testing` cell, not in `To Do`.
- `readBoard`: a missing `columns` → `[]`; a non-array → `[]`; a non-string entry, a blank one, a duplicate, and a 51st entry are each dropped, and the
  board is kept.
- `parseBoardWrite`: a write that leaves `columns` out keeps the stored order (through `writeBoard`); a non-array → 400
  `columns must be an array of status names`; a blank entry, a 101-character one and a duplicate are dropped, not refused.
- The sheet: moving a row up and saving posts the new order; `Reset to default` posts `[]`; an untouched section posts no `columns`; `Add` appends a name;
  `Remove` shows only on a row no loaded issue carries; moves made before the issues read lands survive it.
- The design guards (`test/guards/design-guards.test.ts`) and the source guards the touched symbols are pinned in still pass.

## Left to the builder

- Where the derivation lives (`client/src/lib/jira.ts` beside `laneColumnCounts` is the natural home).
- The exact layout of the sheet section, which composes `components/ui/` primitives per `.claude/DESIGN.md`.
- Which subsystem docs need a line (`docs/subsystems/jira.md` for `columns`, `board.md` for the columns).
- `/ui-verify` on the live TIMIFY board as the last plan task, including a 5-column board at the pane's width.
