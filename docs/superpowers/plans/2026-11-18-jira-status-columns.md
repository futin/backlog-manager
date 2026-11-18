# Jira Board status columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Jira Board draws one column per status name, in place of the three status-category columns, in an order saved per board and edited in the
board sheet.

**Architecture:** The order is stored as `columns: string[]` on each board in `jira.json`, normalised in one server helper used by both read and write. A
pure client derivation, `boardColumns(issues, saved)`, turns the loaded list plus the saved order into the column list. `JiraLaneBoard` and
`JiraBoardSheet` both draw from it. Category keeps every other meaning it has today.

**Tech Stack:** NestJS server (`server/src/jira/`), React client (`client/src/`), jest + Testing Library suites in `test/jira/`.

**Spec:** `docs/superpowers/specs/2026-11-18-jira-status-columns-design.md` (read it in full; section names below are the spec's).

**This plan specifies behaviour, signatures and exact test cases, never literal code.** Write the bodies yourself. Where you disagree with a step, say so
in your report instead of transcribing it.

## Global Constraints

- Columns come from **every issue of the loaded, unfiltered list** (cards and on-board lane headers), plus every saved name. Filters change only counts
  and cards.
- A status's category is the **first issue seen**'s; rank is `CATEGORY_RANK` (`client/src/lib/jira.ts:939`, new 0, indeterminate 1, done 2); names
  compare with that file's `byText`.
- Order rule: saved names first, in order; then the unsaved names sorted by (rank, `byText`), each inserted **immediately after the last column already
  in the list whose rank ≤ its own**, else at the front. Saved names that no issue carries have no rank and are skipped by that search.
- An empty status name → one column keyed `''`, labelled `No status`. It is never saved, never a sheet row, and never sent.
- Normalisation (read and write): trim, drop non-strings and anything whose trimmed length is not 1–100, dedupe (first kept), keep the first 50.
- Copy, exact: section `Columns`, hint `the Board's columns, left to right`, `Move <name> up`, `Move <name> down`, `Remove <name>`,
  placeholder `Add a status by name`, `Add`, `Reset to default`, `No columns yet — they appear once this board has issues.`, 400
  `columns must be an array of status names`.
- `data-tone` stays `statusTone`'s slug (`todo` | `doing` | `done`); a column with no category takes `todo`. `data-col`, `lanes-col-<name>` and
  `cell-<lane key>-<name>` use the status name.
- No inline `style=` in markup: set `--jira-cols` through React's `style` prop (CSSOM), as `client/src/components/ui/Popover.tsx:88` does.
- Wrap new prose and comments at 160 columns. Comments explain *why*, at the repo's existing density.

## Review Focus

1. **A card with no cell.** Every card in a drawn lane must land in exactly one cell: the cells' card count summed per lane equals `view.cards.length`.
   It is pinned in Task 3, including an empty-name card and a card whose status is not in the saved order.
2. **A sheet save that wipes the order.** Saving the name or interval without touching Columns must keep the stored `columns`. It is pinned through the
   route in Task 1 and through the posted body in Task 4.
3. **A hand-edited `jira.json`**, with `columns: "x"`, `[1, " ", "A", "A"]` or 60 names, must load and normalise without dropping the board (Task 1).
4. **Statuses arriving after the sheet opened.** Moves made before the issues read lands must survive it (Task 4).
5. **The sticky header out of step with the cells** at N ≠ 3 columns. It is checked by eye in `/ui-verify` (Task 5) at 1440 px with 5 columns, and at
   ≤ 700 px.

---

### Task 1: Server — store and validate `columns`

**Files:**
- Modify: `shared/types.ts:965-971` (`JiraBoard`)
- Modify: `server/src/jira/config.util.ts`: `readBoard` (124-150), `JiraBoardWrite` (325-331), `parseBoardWrite` (351-379), `writeBoard` (541-572)
- Test: `test/jira/jira-config.test.ts` (`readJiraConfig — boards`, line 91), `test/jira/jira-config-write.test.ts` (`parseBoardWrite` 72,
  `writeBoard` 154), `test/jira/jira-write-routes.test.ts` (board route cases)

**Interfaces:**
- Produces: `JiraBoard.columns?: string[]` in `shared/types.ts`. It is optional in the TYPE so every existing fixture still typechecks, but
  `readBoard` always sets it, and client readers use `board.columns ?? []`.
- Produces: `normaliseColumns(raw: unknown, onDrop?: (index: number, why: string) => void): string[]` and the constants `JIRA_COLUMNS_MAX = 50` and
  `JIRA_COLUMN_NAME_MAX_CHARS = 100`, exported from `config.util.ts`.
- Produces: `JiraBoardWrite.columns?: string[]` (absent = keep stored).

- [ ] **Step 1: Write failing tests.**
  - `readJiraConfig — boards`: with no `columns` → `columns: []`; with `columns: "x"` → `[]`; with `[1, " ", " In Review ", "In Review", "Done"]` →
    `['In Review', 'Done']`, a warning per dropped entry, and the board kept; with 60 distinct names → the first 50.
  - `parseBoardWrite`: a body with no `columns` → `value.columns` is `undefined`; `columns: 'x'` → `{ ok: false, error: 'columns must be an array of
    status names' }`; `['To Do', '', 'a'.repeat(101), 'To Do', 'Done']` → `['To Do', 'Done']`; `[]` → `[]`.
  - `writeBoard`: an update with `columns: ['B', 'A']` stores and returns them; a later update without `columns` leaves the raw file's `columns` as
    `['B', 'A']` and returns `columns: ['B', 'A']`; a create without `columns` returns `columns: []` and writes no `columns` key.
  - Route (`POST /api/jira/boards`): an update that leaves `columns` out answers with the stored order.
- [ ] **Step 2: Run them.** Run `pnpm exec jest test/jira/jira-config.test.ts test/jira/jira-config-write.test.ts test/jira/jira-write-routes.test.ts`.
  Expect the new cases to FAIL.
- [ ] **Step 3: Implement.** `readBoard` sets `columns: normaliseColumns(value.columns, …)`, using the file's existing `drop(file, where, why)` for the
  warnings. `parseBoardWrite` gives a 400 on a present non-array, and otherwise normalises silently. `writeBoard` puts `columns` on the stored object only
  when `input.columns !== undefined`. Build the merged object so that an omitted `columns` does not overwrite the raw key, and return the board as
  `readBoard` would read it back.
- [ ] **Step 4: Run them.** Run the same command. Expect PASS. Then run `pnpm run typecheck`. Expect it clean.
- [ ] **Step 5: Commit.** `git add` the four source and test files by path, then
  `git commit -m "feat(jira): store a per-board status column order"`.

### Task 2: Client lib — derive the columns

**Files:**
- Modify: `client/src/lib/jira.ts`: add beside `laneColumnCounts` (around 525-536); change `laneColumnCounts`
- Test: `test/jira/jira-lib.test.ts` (new `describe('boardColumns')`; update `laneColumnCounts` at 2443-2457)

**Interfaces:**
- Consumes: `JiraBoard.columns` (Task 1).
- Produces: `export interface JiraBoardColumn { name: string; label: string; category: JiraStatusCategory | null }` (`label` is `name`, or `No status`
  for `''`).
- Produces: `export function boardColumns(issues: readonly JiraIssue[], saved: readonly string[]): JiraBoardColumn[]`
- Produces: `export function columnTone(col: JiraBoardColumn): JiraColumnSlug`: `statusTone(category)`, or `'todo'` when `category` is `null`.
- Changes: `laneColumnCounts(views): ReadonlyMap<string, number>`, keyed by `status.name`. A name with no card is absent, and callers read `?? 0`.

- [ ] **Step 1: Write failing tests**, with TIMIFY statuses To Do/new, In Progress/indeterminate, In Review/new, In Testing/new, Done/done. Expected
  `.map((c) => c.name)`:
  - all five carried, `saved []` → `['In Review', 'In Testing', 'To Do', 'In Progress', 'Done']`;
  - no In Progress, `saved []` → `['In Review', 'In Testing', 'To Do', 'Done']`;
  - all carried, saved `[To Do, In Progress, In Review, In Testing, Done]` → exactly that;
  - all carried, saved `[To Do, In Progress, Done]` → `['To Do', 'In Review', 'In Testing', 'In Progress', 'Done']`;
  - all carried plus `Blocked`/new, saved `[To Do, In Progress, In Review, In Testing, Done]` →
    `['To Do', 'In Progress', 'In Review', 'In Testing', 'Blocked', 'Done']`;
  - `In Progress`, `To Do` and `QA`/indeterminate carried, saved `[In Progress, To Do]` → `['In Progress', 'To Do', 'QA']`;
  - `To Do` and `QA`/indeterminate carried, saved `[To Do, In Progress]` (In Progress uncarried) → `['To Do', 'QA', 'In Progress']`, and the
    `In Progress` column has `category: null` with `columnTone` `'todo'`;
  - an issue with `status.name ''` → a column `{ name: '', label: 'No status' }`;
  - `X` as new on the first issue and as indeterminate on a later one → category `new`;
  - `[]` issues and `saved []` → `[]`.
  - `laneColumnCounts`: keep the existing two cases, rewritten to the map (`get('To Do') === 2`, `get('Done') === 1`, `get('In Progress')` undefined).
- [ ] **Step 2: Run them.** Run `pnpm exec jest test/jira/jira-lib.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `boardColumns`, `columnTone` and the new `laneColumnCounts`. Reuse `CATEGORY_RANK` and `byText`. Do not duplicate
  `boardFilterOptions`' first-seen loop if it can be shared cleanly.
- [ ] **Step 4: Run them.** Run the same command. Expect PASS.
- [ ] **Step 5: Commit.** `feat(jira): derive the Board's columns from statuses and the saved order`

### Task 3: Board — draw the status columns

Look: the lane is unchanged from the parent-lanes mock `docs/superpowers/specs/2026-11-18-jira-parent-lanes-mockups/Board.dc.html`. Only the number and
labels of the header columns and cells change: one per status (spec §Board, §Width).

**Files:**
- Modify: `client/src/components/jira/JiraLaneBoard.tsx` (header 155-165, cells 113-150, file header comment)
- Modify: `client/src/components/jira/JiraBoardView.tsx:325-341`: pass `issues={list.issues}`
- Modify: `client/src/styles.css:1673-1676, 1721`: `repeat(var(--jira-cols, 3), minmax(0, 1fr))`. Keep the ≤ 700 px rule.
- Modify: `.claude/DESIGN.md` §8.9.1 (the lanes and column-header text that says three columns, one per status category), `docs/subsystems/board.md`
- Test: `test/jira/jira-board.test.tsx` (helpers at 327, 330, 622, 1936-1938; every `cell-<lane>-<slug>` / `lanes-col-<slug>` id)

**Interfaces:**
- Consumes: `boardColumns`, `columnTone`, `laneColumnCounts` (Task 2); `board.columns ?? []`.
- Produces: `JiraLaneBoard` prop `issues: readonly JiraIssue[]`, the unfiltered loaded list.

- [ ] **Step 1: Migrate and write the tests.** Move the existing ids from slug to status name (`todo` → the fixture's To Do name, and so on). Then add:
  - a fixture with To Do, In Progress, In Review, In Testing and Done cards draws five `lanes-col-*` headers in `boardColumns` order, and the
    `In Testing` card is inside `cell-<lane>-In Testing`, not `cell-<lane>-To Do`;
  - `board.columns = ['To Do', 'In Progress', 'In Review', 'In Testing', 'Done']` draws them in that order;
  - a saved name no issue carries draws a header with count `0` and `data-tone="todo"`;
  - filtering down to one status keeps every header, and the others count `0`;
  - an empty-name card is in `cell-<lane>-` under a `No status` header (Review Focus 1);
  - for every drawn lane, the cards summed across its cells equal the lane's matching cards (Review Focus 1);
  - an empty list with nothing saved draws the header row with no columns and `No issues`;
  - the header carries `--jira-cols` = number of columns (`max(N, 1)`) on its `style`.
- [ ] **Step 2: Run them.** Run `pnpm exec jest test/jira/jira-board.test.tsx`. Expect the new cases to FAIL.
- [ ] **Step 3: Implement.** Derive `cols = useMemo(() => boardColumns(issues, board.columns ?? []), …)`. The header and each lane's cells map over `cols`.
  A cell's cards are `view.cards.filter((c) => c.status.name === col.name)`, the open-cell id is `${lane.key}:${col.name}`, `data-col={col.name}` and
  `data-tone={columnTone(col)}`. Set `--jira-cols` on `.jira-lanes`, so both grids inherit it.
- [ ] **Step 4: Run them.** Run the same command, then `pnpm exec jest test/guards`, then `grep -l "laneColumnCounts\|JiraLaneBoard\|lanes-col-" test -r`
  and run every hit. Expect PASS.
- [ ] **Step 5: Commit.** `feat(jira): draw one Board column per status`

### Task 4: Board sheet — the Columns section

**Files:**
- Modify: `client/src/components/jira/JiraBoardSheet.tsx`: state beside 100-108, the mount read 115-132 (keep the parsed issues too), `save` 146-165,
  and a new section after the queries
- Modify: `client/src/styles.css` (the section's rows, from the existing `.jira-sheet-*` family), `.claude/DESIGN.md` §8.9.3, `docs/subsystems/jira.md`
- Test: `test/jira/jira-setup.test.tsx`

**Interfaces:**
- Consumes: `boardColumns` (Task 2); `JiraBoardWrite.columns` semantics (Task 1).

- [ ] **Step 1: Write failing tests**, with `fetch` mocked as the suite already does:
  - an edited board with `columns: ['To Do', 'Done']`, whose read returns issues with To Do, In Review and Done, shows rows
    `To Do, In Review, Done` (In Review by the Order rule: after the last rank ≤ new, `To Do`);
  - `Move In Review up`, then save → the POST body has `columns: ['In Review', 'To Do', 'Done']`;
  - saving with Columns untouched → the POST body has no `columns` key;
  - `Reset to default`, then save → `columns: []`;
  - typing `QA` + `Add` → a `QA` row at the end, with `Remove QA`; `To Do` (carried) has no `Remove` button; `Add` with a name already drawn does nothing;
  - the first row's `Move … up` and the last row's `Move … down` are disabled;
  - a move made while the read is still pending survives the read landing (resolve the mocked fetch after the click);
  - a new board (`board: null`) with nothing added shows `No columns yet — they appear once this board has issues.`;
  - an empty-name issue in the read produces no row.
- [ ] **Step 2: Run them.** Run `pnpm exec jest test/jira/jira-setup.test.tsx`. Expect FAIL.
- [ ] **Step 3: Implement.** Keep a working list (`string[] | null`, where `null` = untouched and the board's saved `columns` is used) and a `touched`
  flag. The first edit materialises the drawn list (no `''`) and then applies the edit. Rows are `boardColumns(readIssues, working ?? saved)` minus `''`.
  The add field has `maxLength={100}`. Compose `components/ui/` primitives (`SettingsRow`, `Chip`, icon buttons) per `.claude/DESIGN.md`; do not add a
  new primitive.
- [ ] **Step 4: Run them.** Run the same command, then `pnpm exec jest test/board/dialog-escape.test.tsx test/guards`. Expect PASS.
- [ ] **Step 5: Commit.** `feat(jira): order the Board's columns from the board sheet`

### Task 5: `/ui-verify`

- [ ] Run `/ui-verify` on the live stack (`http://localhost:5177`, Jira › Board, board `My sprint tasks`) against the spec's §Board and §Width, using
  `Board.dc.html` for the lane look. Check: one column per status, with the In Testing / In Review cards in their own columns; header names over their
  cells at 1440 px; the ≤ 700 px single column; the sheet's Columns section, reordered and saved, then reflected on the Board. Fix any defect on the branch
  and re-run the touched suites.
