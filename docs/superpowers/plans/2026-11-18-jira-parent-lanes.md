# Jira Parent Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Jira › Board page draws one lane per parent — the parent as a header, its children in their own To Do / In Progress / Done cells — and the
List draws the same lanes as header rows with child rows under them, so it is always clear which issue belongs to which parent.

**Architecture:** One pure function, `laneBoard(issues)`, in `client/src/lib/jira.ts` replaces `foldBoard` as the page's single reading of the parent links; a
second, `laneViews`, applies the filters to it. The Board and the List render those views and share one fold state per board (`localStorage`, clamped on
read). The server only widens `JiraIssue.parent` with the type and status Jira already sends. New pieces are built beside the fold first (Tasks 1–3), the Board
and then the List move onto them (Tasks 4–5), and the fold and its helpers are deleted last (Task 6), so every task ends with a green build.

**Tech Stack:** NestJS (server mapper), React 18 + Vite (client), TypeScript, jest + Testing Library (jsdom), pnpm.

**Spec:** [docs/superpowers/specs/2026-11-18-jira-parent-lanes-design.md](../specs/2026-11-18-jira-parent-lanes-design.md) — section numbers below (§) are
the spec's. Mocks and their audit: `docs/superpowers/specs/2026-11-18-jira-parent-lanes-mockups/` (`Board.dc.html`, `BoardDeep.dc.html`, `List.dc.html`,
`ListDeep.dc.html`, `00-mock-audit.md`). The mock files are 75–190 KB each: grep them for the part a step names, never read one whole.

**How to read this plan (overrides the template's "tests as code" habit).** Tasks specify behaviour, signatures and exact test cases — fixture, input,
expected value — and no literal implementation or test code. Write the code and the test bodies yourself from them; if a signature here is wrong for the code
you find, say so in the task's commit body and use what is right. No size budget in this plan is hard. Where a mock and the spec differ, the spec wins
(`00-mock-audit.md`, "Drawn on a mock, not built").

## Global Constraints

- **pnpm only.** Tests: `pnpm exec jest <paths>`; types: `pnpm run typecheck`. Never run the whole `pnpm test` locally — CI is the full-suite gate. Each task
  runs the suites it touched plus the source guards: before the commit, `grep -l <symbol> test/` for every symbol the task adds a caller of, and add each
  hit to the run (CLAUDE.md, "Touched includes the source guards").
- **Read the rule file before the first edit under its glob:** `.claude/rules/board.md` (`client/src/**`), `.claude/rules/jira.md`
  (`server/src/jira/**`), `.claude/rules/items.md` (`shared/types.ts`), `.claude/rules/tests.md` (`test/**`).
- **This repository is public.** Every fixture, comment and doc line uses invented data only: keys `PAY-<n>`, site `acme.atlassian.net`, person
  `Dana Novak`. No real ticket key, summary, customer or person name anywhere.
- **CSP `style-src 'self'`:** no `style=` attribute and no inline style object. Depth, tone and state reach CSS through classes and `data-*` attributes.
- **Drawing makes no request.** No new route, request field, poller or cache. The only new call is `askParent(key)` on a click (§3.2).
- **`Run ▾` is never hidden on an on-board issue**, and `JiraRunMenu` keeps reading `runChipState` alone (`.claude/rules/board.md`).
- **Every new or rewritten component cites its `.claude/DESIGN.md` subsection (§8.9.1) in its header comment**; comments explain why, at the density of the
  file they sit in.
- **Exact copy** (§3, §4, §6): `not on this board`, `No parent`, `+ N more`, `show fewer`, `n issues` / `1 issue`, `M parents` / `1 parent`, `No issues`,
  `No issues match`, `↳ <KEY>`, and the chevron's `aria-label`: `Collapse <KEY>` / `Expand <KEY>`, `Collapse No parent` / `Expand No parent`.
- **A jsdom suite's fixture dates are relative to the clock** — `daysAgoDate` / `daysAgoStamp` from `test/helpers/dates.ts` for `created`, `updated`,
  `lastCommit`, `started` in any `*.test.tsx` (`test/guards/fixture-clock.test.ts`). Jest suites stay one level down in `test/<feature>/`.
- **Fixtures discriminate.** Every field a test asserts gets its own value (two parents never share a summary, two cards never share an `updated`), and
  per-key logic (per board, per lane) is exercised with at least two keys.
- **`test/guards/design-guards.test.ts` passes unchanged**: the 11 px floor, the one uppercase rule, the `.jira-issues-*` geometry, `.jira-issues-under`'s
  `flex: none`.
- **New text wraps at 160 columns** (tables and code exempt); commit bodies at 72. Commits end with
  `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>` (or the executing model's own line). Stage by path, never `git add -A`. Nothing is pushed.

## Review Focus

Input classes the spec implies and no spec test case names. Each has its test in the task that owns the code.

1. **A parent that moves onto or off the board between two polls** — the same lane key flips between an off-board stub header and an on-board header. The
   lane keeps its fold override and its place; the header gains (or loses) `Run ▾`; nothing throws. → Task 4.
2. **A poll that removes a lane while one of its cells is open or a parent read is out.** The page draws the new list without error, and a read landing
   for the gone header opens nothing. → Task 4.
3. **Stored folds whose board id or lane key is an `Object.prototype` name** (`constructor`, `__proto__`, `toString`) — a board id comes from a
   hand-written `jira.json`. Lookups are own-property only: such a board reads as no overrides and can still store its own. → Task 3.
4. **Two cards that name the same off-board parent with different payloads and the same `updated`.** The stub is picked by `sortForBoard`'s key tie-break,
   so it does not flicker between polls. → Task 2.
5. **A parent chain six deep.** Every issue is drawn once, lane `depth` runs 0–5, and the drawn indent stops at three steps. → Task 2 (model), Task 4
   (drawn cap).

---

## File map

| File | Change | Task |
| ---- | ------ | ---- |
| `shared/types.ts` | Modify — `JiraIssue.parent` gains `type`, `status`; export `JiraParentRef` | 1 |
| `server/src/jira/map-issue.ts` | Modify — map the parent's type and status | 1 |
| `client/src/lib/jira.ts` | Modify — parser null-normalises (1); lane model (2); views, cut, folds (3); `crumbOf` kept parent (4); `bandSub` parents, fold helpers deleted (6) | 1–4, 6 |
| `client/src/lib/jira-list.ts` | Modify — `stubIssue` builds the wider parent | 1 |
| `client/src/lib/jira-deck.ts` | Modify — `sessionCells`, `endedByKey` added, shelves deleted (4); `DeckEntry.parent`, `boardAgents`, `deckCrumb` changed, `topSessionCell` deleted (6) | 4, 6 |
| `client/src/hooks/useLaneFolds.ts` | Create — the per-board fold state | 4 |
| `client/src/hooks/useOffBoardParent.ts` | Create — the click-to-read of an off-board parent | 4 |
| `client/src/hooks/usePickedJiraBoard.ts` | Modify — returns `lanes` beside `fold` (4), then instead of it (6) | 4, 6 |
| `client/src/components/jira/JiraLaneBoard.tsx` | Create — column header, lanes, cells, the cut | 4 |
| `client/src/components/jira/JiraLaneHeader.tsx` | Create — the three header kinds, the chevron | 4 |
| `client/src/components/jira/JiraShelves.tsx` | Delete | 4 |
| `client/src/components/jira/JiraCard.tsx` | Modify — no `parent` crumb, fold block or match ring; live state | 4 |
| `client/src/components/jira/JiraBoardView.tsx` | Modify — Board branch (4), List branch (5), band and deck (6) | 4–6 |
| `client/src/components/jira/GitlabBandLine.tsx` | Modify — prop `tops` → `issues` | 4 |
| `client/src/components/ui/FoldMark.tsx` | Modify — optional `title` | 4 |
| `client/src/components/jira/JiraIssueList.tsx` | Modify — lane header rows and indented card rows | 5 |
| `client/src/components/jira/JiraAgentDeck.tsx`, `JiraBandSub.tsx`, `JiraSessionsView.tsx` | Modify — direct parent mark; `M parents`; lane model | 6 |
| `client/src/styles.css` | Modify — lane, live-card and List header-row rules; the fold's and shelves' rules removed | 4–6 |
| `docs/subsystems/jira.md`, `docs/subsystems/board.md`, `.claude/DESIGN.md`, `.claude/rules/board.md`, the 2026-10-16 grouped-board spec | Modify — §10 | 7 |
| `test/jira/jira-map-issue.test.ts`, `jira-lib.test.ts`, `jira-board.test.tsx`, `jira-delivery-surfaces.test.tsx`, `jira-session-open.test.tsx`, `test/ui/ui-fold-mark.test.tsx`, fixture literals in 18 suites | Modify | 1–6 |

---

### Task 1: The parent's type and status, end to end (§2)

**Files:**
- Modify: `shared/types.ts` (`JiraIssue.parent`, ~l.921–945), `server/src/jira/map-issue.ts` (parent mapping, ~l.125), `client/src/lib/jira.ts`
  (`parseJiraBoardIssues`, ~l.1007), `client/src/lib/jira-list.ts` (`stubIssue`, ~l.107)
- Test: `test/jira/jira-map-issue.test.ts`, `test/jira/jira-lib.test.ts` (`describe('parseJiraBoardIssues')`), `test/jira/jira-list.test.tsx`
- Modify (fixtures only): every suite `grep -rl "parent: { key" test/` lists — 18 files, `test/jira/jira-board.test.tsx` holding the most (19 literals)

**Interfaces:**
- Produces: `JiraIssue['parent']` = `{ key: string; summary: string; type: <the shape of JiraIssue['type']> | null; status: <the shape of
  JiraIssue['status']> | null } | null` — both new fields required and nullable. `export type JiraParentRef = NonNullable<JiraIssue['parent']>` from
  `shared/types.ts`.

- [ ] **Step 1: Write the failing mapper tests** in `test/jira/jira-map-issue.test.ts`:
  - parent `fields: { summary: 'Checkout', issuetype: { name: 'Epic', hierarchyLevel: 1, subtask: false }, status: { name: 'In Progress', statusCategory:
    { key: 'indeterminate' } } }` → `parent` equals `{ key, summary: 'Checkout', type: { name: 'Epic', level: 1, subtask: false }, status: { name:
    'In Progress', category: 'indeterminate' } }`.
  - parent with only `summary` → `type: null`, `status: null`, key and summary kept.
  - parent `issuetype: { name: 'Sub-task', subtask: true }` (no `hierarchyLevel`) → `type.level` is `-1`; `issuetype: { name: 'Task' }` → `level` `0`.
  - parent `status: { name: 'Odd', statusCategory: { key: 'mystery' } }` → `status.category` is `'new'`.
  - parent `issuetype: { subtask: true }` (no string `name`) → `type: null`; parent `status: {}` → `status: null`.
  - The suite's two existing whole-object parent assertions (the full-issue case, the parent-without-a-summary case) gain the two fields.
- [ ] **Step 2: Write the failing client tests.** `parseJiraBoardIssues`: a row whose `parent` is `{ key: 'PAY-1', summary: 'Checkout' }` parses to a
  parent with `type: null` and `status: null`; a row whose parent carries both keeps them unchanged; `parent: null` stays `null`. `stubIssue('PAY-9',
  { summary, type, parentKey: 'PAY-1' }, site).parent` equals `{ key: 'PAY-1', summary: '', type: null, status: null }`.
- [ ] **Step 3: Run them — expect FAIL.** `pnpm exec jest test/jira/jira-map-issue.test.ts test/jira/jira-lib.test.ts test/jira/jira-list.test.tsx`
- [ ] **Step 4: Implement.** Widen the type in `shared/types.ts`. In `map-issue.ts` map the parent's `issuetype` and `status` through the same code path
  the issue's own `type` and `status` take: today that mapping is inline in `mapJiraIssue`, so lift each into one helper called twice, not a copy. A
  parent field is `null` when its object is absent or has no string `name`. The parent's `priority` stays unmapped, with a comment saying D3 asks for
  type and status only. In `parseJiraBoardIssues` turn an absent or non-object
  `type` / `status` on a row's parent into `null`. In `stubIssue` add the two `null`s.
- [ ] **Step 5: Fix the fixtures.** `pnpm run typecheck`, then add `type: null, status: null` to every hand-built `JiraIssue` `parent` literal it
  names — only those: a raw Jira payload (`parent: { key, fields }`, as in `jira-poller.test.ts` and `jira-map-issue.test.ts`) is the mapper's input
  and stays as it is. No assertion changes besides the two in Step 1.
- [ ] **Step 6: Run — expect PASS.** `pnpm run typecheck` and `pnpm exec jest` over the three suites of Step 3 plus every suite Step 5 edited.
- [ ] **Step 7: Commit** — `feat(jira): map a parent's type and status`.

### Task 2: The lane model — `laneBoard` (§1, §3.5)

**Files:**
- Modify: `client/src/lib/jira.ts`
- Test: `test/jira/jira-lib.test.ts` (new `describe('laneBoard')`, using the suite's `issue(over)` and `ago(now, ms)` helpers)

**Interfaces:**
- Consumes: `JiraParentRef` (Task 1); existing `sortForBoard`, `columnOf`, `JiraChildrenIndex`, and the walk inside `foldBoard`.
- Produces, all exported from `client/src/lib/jira.ts`:

```ts
export const NO_PARENT_LANE = 'none'; // never a Jira key: a key always holds a '-'
export interface JiraLane {
  key: string;                       // the parent's key, or NO_PARENT_LANE
  kind: 'board' | 'off' | 'none';    // parent on the board | parent off the board | the No parent lane
  header: JiraIssue | null;          // kind 'board': the header issue
  stub: JiraParentRef | null;        // kind 'off': the parent as the freshest card carries it
  cards: readonly JiraIssue[];       // the lane's own cards, sortForBoard order
  lanes: readonly JiraLane[];        // nested lanes, in §3.5 order
  depth: number;                     // 0 for a root lane, +1 per nesting, uncapped (the draw caps it)
  subtree: readonly JiraIssue[];     // every on-board issue under the header: cards, nested headers, their subtrees
  settled: boolean;                  // §3.5
  stamp: number;                     // newest `updated` (ms) across the on-board header and the subtree
}
export interface JiraLanes {
  lanes: readonly JiraLane[];        // root lanes, in §3.5 order
  childrenOf: JiraChildrenIndex;     // the index foldBoard returns for the same input
  parentOf: ReadonlyMap<string, JiraParentRef | null>; // every on-board key → the parent §1.4 keeps (null: none, or a cycle member)
}
export function laneBoard(issues: readonly JiraIssue[]): JiraLanes;
```

- [ ] **Step 1: Write the failing tests.** Keys are `PAY-<n>`; every issue gets a distinct `updated`; unless a case says otherwise all statuses are To Do.
  1. *Off-board lane, freshest stub.* `PAY-11` (3 h ago), `PAY-12` (1 h ago), `PAY-13` (2 h ago), each with `parent.key: 'PAY-1'`, `PAY-1` not in the
     list. `PAY-12`'s parent is `{ summary: 'Checkout v2', type: Epic/1/false, status: In Progress/indeterminate }`; the other two carry `summary:
     'Checkout'`, `type: null`, `status: null`. → one lane: `key 'PAY-1'`, `kind 'off'`, `header null`, `stub` deep-equal to `PAY-12`'s parent, `cards`
     keys `['PAY-12', 'PAY-13', 'PAY-11']`, `depth 0`, `lanes []`.
  2. *Stub tie (Review Focus 4).* Two cards under off-board `PAY-1` with the same `updated` and different parent summaries → the stub is the parent of
     whichever `sortForBoard` puts first, and the answer is the same with the input array reversed.
  3. *No parent.* Case 1 plus parentless `PAY-20` → lane keys `['PAY-1', 'none']`, the last of `kind 'none'` holding `PAY-20`. Case 1 alone → no lane
     of `kind 'none'`.
  4. *On-board header.* `PAY-30` with children `PAY-31`, `PAY-32` on the board → one lane, `kind 'board'`, `header.key 'PAY-30'`, two cards; `PAY-30`
     is in no lane's `cards`; no `none` lane.
  5. *Nesting.* Epic `PAY-40`; story `PAY-41` under it; `PAY-42`, `PAY-43` under `PAY-41`; `PAY-44` under `PAY-40`. → one root lane `PAY-40` with
     `cards` `['PAY-44']` and `lanes` = one lane `PAY-41`, `depth 1`, two cards. Root `subtree` has exactly the 4 keys `PAY-41`…`PAY-44`; nested
     `subtree` the 2.
  6. *Header under an off-board parent with no card.* `PAY-51` (parent `PAY-50`, off board), `PAY-52` under `PAY-51` → one root lane `PAY-51`
     (`kind 'board'`, `depth 0`); no lane keyed `PAY-50`; `parentOf.get('PAY-51')?.key` is `'PAY-50'`.
  7. *Off-board parent with a card and a header child.* `PAY-61` and `PAY-62` under off-board `PAY-60`; `PAY-63` under `PAY-62` → one root lane
     `PAY-60` (`kind 'off'`), `cards` `['PAY-61']`, `lanes` = lane `PAY-62` at `depth 1` holding `PAY-63`.
  8. *Cycles.* (a) `PAY-71` under `PAY-72` under `PAY-71`, nothing else → exactly one lane, `kind 'none'`, both as cards; `parentOf` is `null` for
     both; the call returns. (b) `PAY-73` whose parent is `PAY-73` → one `none` lane, one card. (c) case (a) plus `PAY-74` under `PAY-71` → root lane
     `PAY-71` (`kind 'board'`) holding `PAY-74`, and a `none` lane holding `PAY-72`; `parentOf.get('PAY-74')?.key` is `'PAY-71'`.
  9. *Order.* An open lane whose newest issue is 7 days old sorts before a settled lane updated a minute ago. Two open lanes: `PAY-81` (header 5 days
     old, one card 1 h old) sorts before `PAY-85` (newest issue 2 h old). Two open lanes with equal stamps, keys `PAY-91` and `PAY-92` → `PAY-91`
     first. A `none` lane holding the newest open card on the board is still the last open lane and sits before every settled lane; a `none` lane whose
     cards are all Done is the last lane of all, also when it is the newest. Nested lanes: under one open parent, a settled nested lane updated a minute
     ago sorts after an open sibling updated a week ago, and stays inside its parent.
  10. *Settled.* On-board header In Progress over two Done cards → `settled false`. Off-board stub whose status is In Progress over two Done cards →
      `settled true`. A nested header counts: case 7's shape with `PAY-62` In Progress and `PAY-61`, `PAY-63` Done → `settled false` on
      `PAY-60`'s lane; flip `PAY-62` to Done → `true`.
  11. *Six deep (Review Focus 5).* A chain `PAY-101` ← `PAY-102` ← … ← `PAY-106`, plus a card `PAY-107` under `PAY-106` → walking `lanes[0].lanes[0]…`
      gives depths 0, 1, 2, 3, 4, 5; counting every header and every card across the tree gives 7, each key once.
  12. *`childrenOf`.* For cases 5 and 8a–8c the index equals a hand-written map (case 5: `PAY-40 → {PAY-41, PAY-44}`, `PAY-41 → {PAY-42, PAY-43}`; 8a
      and 8b: no entry; 8c: `PAY-71 → {PAY-74}`), compared per parent as key sets. **And**, while `foldBoard` still exists, every fixture of this
      `describe` asserts `laneBoard(x).childrenOf` deep-equals `foldBoard(x).childrenOf` — Task 6 removes that line with `foldBoard`.
- [ ] **Step 2: Run — expect FAIL** (`laneBoard` is not exported). `pnpm exec jest test/jira/jira-lib.test.ts -t laneBoard`
- [ ] **Step 3: Implement `laneBoard`.** The cycle rule and `childrenOf` must be `foldBoard`'s, not a second copy: lift the walk `foldBoard` already has
  into one module-private helper that both functions call, leaving `foldBoard`'s behaviour untouched (its own `describe('the fold')` still passes).
  Header issue, card, which lanes exist, nesting, subtree: §1.1–§1.3. Settled, stamp and order: §3.5 — root lanes open first then settled, each group
  by `stamp` descending then lane key by the comparator `sortForBoard` breaks ties with, the `none` lane last in its group; nested lanes sorted among
  their siblings by the same rule. Nothing here reads a clock or a session.
- [ ] **Step 4: Run — expect PASS.** `pnpm exec jest test/jira/jira-lib.test.ts` (whole suite: the fold's own cases must still pass) and
  `pnpm run typecheck`.
- [ ] **Step 5: Commit** — `feat(jira): add the lane model beside the fold`.

### Task 3: Filtered views, the cell cut and the fold store (§3.1, §3.3, §3.6, §6)

**Files:**
- Modify: `client/src/lib/jira.ts`
- Test: `test/jira/jira-lib.test.ts` (new `describe('lane views')`, `describe('laneCell')`, `describe('lane folds')`)

**Interfaces:**
- Consumes: `JiraLane`, `JiraLanes`, `NO_PARENT_LANE` (Task 2); existing `JiraProgress`, `foldProgress`, `JiraColumnSlug`.
- Produces, all exported from `client/src/lib/jira.ts`:

```ts
export interface JiraLaneView {
  lane: JiraLane;
  headerMatches: boolean;            // kind 'board' and the header issue matches; false for the other kinds
  cards: readonly JiraIssue[];       // the lane's matching cards, lane order
  lanes: readonly JiraLaneView[];    // the nested lanes that are drawn
  count: number;                     // matching issues in the subtree (nested headers included, this lane's own header not)
  progress: JiraProgress;            // foldProgress over those same issues
}
export function laneViews(board: JiraLanes, matches: (issue: JiraIssue) => boolean): JiraLaneView[];
export function laneColumnCounts(views: readonly JiraLaneView[]): Record<JiraColumnSlug, number>; // matching cards per column, every depth
export function laneParents(board: JiraLanes): number;               // lanes whose kind is not 'none', every depth, unfiltered
export const LANE_CELL_LIMIT = 5;
export const LANE_INDENT_CAP = 3;
export function laneCell(cards: readonly JiraIssue[], isLive: (key: string) => boolean, open: boolean): { shown: JiraIssue[]; hidden: number };

export const JIRA_LANE_FOLDS_KEY = 'backlog-manager.jira-lane-folds';
export type LaneFold = 'open' | 'closed';
export type LaneOverrides = Readonly<Record<string, LaneFold>>;      // lane key → override
export type JiraLaneFolds = Readonly<Record<string, LaneOverrides>>; // board id → overrides
export function clampLaneFolds(v: unknown): JiraLaneFolds;
export function laneOverrides(folds: JiraLaneFolds, boardId: string): LaneOverrides;   // own-property lookup; {} when absent
export function laneOpen(lane: JiraLane, overrides: LaneOverrides): boolean;           // the override, else !lane.settled
export function setLaneFold(folds: JiraLaneFolds, boardId: string, board: JiraLanes, laneKey: string, open: boolean): JiraLaneFolds;
```

- [ ] **Step 1: Write the failing tests.**
  - `laneViews`, on Task 2's fixtures: (a) a three-card lane and a predicate matching one card → that lane's view has 1 card, `count 1`, `progress`
    summing to 1. (b) a predicate matching none of a lane's issues nor its header → no view for it. (c) a predicate matching only the on-board header
    `PAY-30` of case 4 → one view, `headerMatches true`, `cards []`, `count 0`. (d) case 5 with a predicate matching only `PAY-41` → root view
    `PAY-40` with `headerMatches false`, `cards []`, `count 1`, and one nested view `PAY-41` with `headerMatches true`, `count 0`. (e) case 5,
    everything matching → root `count 4`, nested `count 2`, root `progress` summing to 4. (f) the view order is the lanes' order.
  - `laneColumnCounts`: case 5 with `PAY-40` and `PAY-41` In Progress, `PAY-42` Done, `PAY-43` and `PAY-44` To Do, everything matching →
    `{ todo: 2, doing: 0, done: 1 }` (headers are in no column); with a predicate hiding `PAY-43` → `todo: 1`.
  - `laneParents`: case 5 → 2; case 3 → 1; case 8a → 0; the same numbers whatever predicate `laneViews` is later given (it takes none).
  - `laneCell`: 7 cards, none live, closed → the first 5, `hidden 2`. 7 cards, the 7th live → 6 shown (the first five, then the 7th), `hidden 1`. 7
    cards open → 7, `hidden 0`. 5 cards → `hidden 0`. 6 cards, the 6th live → 6, `hidden 0`.
  - `clampLaneFolds`: `null`, `'x'`, `42`, `[]`, `[{ 'PAY-1': 'closed' }]` → no board has overrides. `{ b1: { 'PAY-1': 'closed', 'PAY-2': 'junk' },
    b2: 'nope', b3: ['open'], b4: null }` → `laneOverrides(_, 'b1')` equals `{ 'PAY-1': 'closed' }`; `b2`, `b3`, `b4` read `{}`.
  - Prototype names (Review Focus 3): for folds parsed from `'{"b1":{"PAY-1":"closed"}}'`, `laneOverrides(folds, 'constructor')`,
    `laneOverrides(folds, '__proto__')` and `laneOverrides(folds, 'toString')` are each `{}`. With `board` = the `setLaneFold` case's board below
    (it holds lane `PAY-1`), for each of the ids `'constructor'` and `'__proto__'`: `setLaneFold(folds, id, board, 'PAY-1', false)` then
    `laneOverrides(_, id)` equals `{ 'PAY-1': 'closed' }`, `b1` is unchanged, and `JSON.parse(JSON.stringify(result))` clamps back to the same two
    board entries. `clampLaneFolds(JSON.parse('{"__proto__":{"PAY-1":"closed"},"b1":{"__proto__":"closed","PAY-1":"open"}}'))` → the `__proto__`
    board reads `{ 'PAY-1': 'closed' }`, `b1` reads `{ 'PAY-1': 'open' }`, and `({})['PAY-1']` is still `undefined` (`Object.prototype` untouched).
  - `laneOpen`: a settled lane with `{}` → `false`; an open lane with `{}` → `true`; `{ [lane.key]: 'open' }` on a settled lane → `true`;
    `{ [lane.key]: 'closed' }` on an open lane → `false`.
  - `setLaneFold`: from `{ b1: { 'PAY-9': 'closed', 'PAY-1': 'open', 'PAY-2': 'closed' }, b2: { 'PAY-9': 'closed' } }` and a `board` whose lanes are
    `PAY-1` (with a nested `PAY-2`) and `none`: `setLaneFold(folds, 'b1', board, 'none', false)` → `b1` equals
    `{ 'PAY-1': 'open', 'PAY-2': 'closed', none: 'closed' }` (the stale `PAY-9` pruned, the nested lane's override kept), `b2` still
    `{ 'PAY-9': 'closed' }`. The input object is not mutated.
- [ ] **Step 2: Run — expect FAIL.** `pnpm exec jest test/jira/jira-lib.test.ts -t "lane views|laneCell|lane folds"`
- [ ] **Step 3: Implement.** A lane is in the views when any issue of its `subtree` matches or its own on-board header does (§6.2). `clampLaneFolds`
  follows `clampJiraPanelFilters`' shape: never throws, drops a bad board entry alone and a bad lane value alone. `setLaneFold` prunes its board's entry
  against every lane key in `board` at any depth — the caller hands it the unfiltered lanes of a loaded list (§3.6), which Task 4's hook guarantees.
  A toggle is always stored, also when it equals the default: the lane was touched.
- [ ] **Step 4: Run — expect PASS**, whole suite plus `pnpm run typecheck`.
- [ ] **Step 5: Commit** — `feat(jira): add lane views, the cell cut and the fold store`.

### Task 4: The Board draws lanes (§3, §5 filter, §6.2)

Mocks: `Board.dc.html` (lanes, both header kinds, the `No parent` lane, a live card, `+ N more`, a folded settled lane) and `BoardDeep.dc.html` (nested
lanes and the `↳` chip). Read `00-mock-audit.md`'s Board table first: the on-board header and the card keep parts the mocks leave out.

**Files:**
- Create: `client/src/components/jira/JiraLaneBoard.tsx`, `client/src/components/jira/JiraLaneHeader.tsx`, `client/src/hooks/useLaneFolds.ts`,
  `client/src/hooks/useOffBoardParent.ts`
- Modify: `client/src/components/jira/JiraCard.tsx`, `client/src/components/jira/JiraBoardView.tsx`, `client/src/components/jira/GitlabBandLine.tsx`,
  `client/src/components/ui/FoldMark.tsx`, `client/src/hooks/usePickedJiraBoard.ts`, `client/src/lib/jira.ts` (`crumbOf`), `client/src/lib/jira-deck.ts`,
  `client/src/styles.css`
- Delete: `client/src/components/jira/JiraShelves.tsx`
- Test: `test/jira/jira-board.test.tsx` (the Board describes), `test/jira/jira-lib.test.ts` (`describe('lib/jira-deck')`, `describe('crumbOf')`),
  `test/ui/ui-fold-mark.test.tsx`, `test/jira/jira-delivery-surfaces.test.tsx` (its `JiraCard` renders), `test/jira/jira-session-open.test.tsx` (the
  import pin at ~l.249)

**Interfaces:**
- Consumes: Tasks 1–3; existing `askParent(key): Promise<JiraIssue>` (`client/src/lib/jira-parent.ts`), `SessionOpen` / `OpenChip`
  (`components/jira/SessionOpen.tsx`), `STATE_LABEL` (`shared/jira-sessions.ts`), `SpreadBar`, `Chip`, `runChipState`, `endedLine`, `deckOrder`,
  `boardAgents(fold, payload, live)` as it is today.
- Produces:
  - `usePickedJiraBoard` returns `lanes: JiraLanes` (memoised on `list.issues`) **beside** `fold` — `fold` leaves in Task 6.
  - `crumbOf(issue, board, me, parent: JiraParentRef | null = issue.parent)` — the precedence root → parent → mine is unchanged; the fourth parameter
    is the parent the lane model kept.
  - `FoldMark({ issueKey, title }: { issueKey: string; title?: string })` — `title` attribute is `title ?? issueKey`.
  - `GitlabBandLine({ issues }: { issues: readonly JiraIssue[] })`.
  - In `client/src/lib/jira-deck.ts`: `interface SessionCell { state: JiraSessionState; since: string; more: number; lead: DeckEntry | null }`;
    `sessionCells(agents: readonly DeckEntry[], links: readonly SessionLink[]): Map<string, SessionCell>` keyed by the session's **own** issue key — the
    first live entry for a key leads (`agents` is already in `deckOrder`), `more` counts that key's other live entries; a key with none live and an
    ended link reads `state 'ended'`, `since` = the newest `endedAt`, `more 0`, `lead null`; a key with neither has no entry.
    `endedByKey(payload: JiraSessionsPayload | null): Map<string, SessionLink[]>` — each key's ended links, newest end first (what `boardShelves`
    computed inline).
  - `useLaneFolds(boardId: string | null, board: JiraLanes, searching: boolean): LaneFoldState`, with
    `interface LaneFoldState { isOpen(lane: JiraLane): boolean; toggle(lane: JiraLane): void; locked: boolean }` — one
    `usePersistedState(JIRA_LANE_FOLDS_KEY, {})` clamped on every read; `searching` makes `isOpen` true for every lane, `toggle` a no-op and `locked`
    true, without touching what is stored.
  - `useOffBoardParent(onOpen: (issue: JiraIssue) => void, drawn: ReadonlySet<string>): OffBoardRead`, with
    `interface OffBoardRead { reading: string | null; failed: { key: string; message: string } | null; ask(key: string): void }` — `drawn` is the set
    of off-board lane keys on screen now, read at landing time.
  - `JiraCard` props: `issue, board, me, now, parent: JiraParentRef | null, session: SessionCell | null, ended, trees, onOpen, onRun` — `fold` and
    `matches` are gone.
  - `JiraLaneBoard` and `JiraLaneHeader` props are the implementer's; Task 5 reuses from `JiraLaneHeader.tsx` only an exported chevron button
    `LaneChevron({ label, open, locked, onToggle }: { label: string; open: boolean; locked: boolean; onToggle: () => void })` (`label` is `<KEY>` or
    `No parent`).

- [ ] **Step 1: Write the failing lib and primitive tests.** `sessionCells`: two live entries on `PAY-12` (needs-you first in `deckOrder`) and one on
  `PAY-13` → `PAY-12` reads the first entry's state and `since`, `more 1`, `lead` that entry; `PAY-13` `more 0`. A key with one ended link and no live
  one → `'ended'`, `since` its `endedAt`; with two ended links → the newer `endedAt`. A session on a child does not give its parent's key an entry.
  `endedByKey`: two ended links on one key come newest first; a live link is not in it. `crumbOf` with a fourth argument of `null` on an issue that has
  a raw parent and is assigned to me → the `mine` kind; with no fourth argument → `parent` kind, as today. `FoldMark` with `title="Checkout v2"` →
  that `title`; without → the key. Remove the `boardShelves` / `SHELF_LIMIT` cases.
- [ ] **Step 2: Write the failing page tests** in `test/jira/jira-board.test.tsx`, replacing the describes that pin columns of tops, the fold block, the
  match ring and the shelves (`the columns`, `the card`, `filters and search`, `the fold`, `the agent deck and the status shelves`; keep every
  `Run ▾`, worktree-chip and deck case of those and of `Run ▾ on the card, and the deck card for a live key`, re-anchored to lanes). Build fixtures
  with the suite's `issue(over)` and `daysAgoStamp`. Cases:
  1. An off-board header draws the tag `not on this board` and no `Run ▾`; with the stub's `type: null` no type tile, with `status: null` no status
     pill; with both set, both. Its `↗` links to `https://acme.atlassian.net/browse/<KEY>`, and is absent while the status payload has no site.
  2. An on-board header draws `Run ▾`; one that has a parent draws `↳ <parent key>` whose `title` is the parent's summary; one without draws no chip.
  3. Crumbs: a card under a parent draws no crumb, also when assigned to me; a parentless card assigned to me reads `Assigned to me`; a followed root
     under a parent reads `root`.
  4. A cell with 7 cards draws 5 and `+ 2 more` (`aria-expanded="false"`); clicking opens only that cell (another 7-card cell in a second lane still
     shows 5) and the chip reads `show fewer`.
  5. A card with a live session is in its cell at its `sortForBoard` place, shows `<STATE_LABEL> · <age>` and an open control, keeps `Run ▾`, and its
     issue is in the deck too.
  6. A cell with 7 cards whose 7th has a live session draws 6 — the live one after the first five — and `+ 1 more`.
  7. Drawing the board makes no `/api/jira/issue/` request. Clicking an off-board header's summary makes exactly one, for that key, and Detail opens
     (`onOpenIssue`) on the answer; while it is out the summary button is disabled.
  8. Two off-board headers clicked in turn, the first read resolving last → `onOpenIssue` is called once, with the second parent. A rejected read shows
     its sentence under that header only; clicking another off-board header clears it.
  9. A stub whose summary is `''` draws its key as the summary button, and the click still opens Detail.
  10. Folds: a settled lane starts folded (header drawn, no card of it in the document, chevron `aria-label` `Expand <KEY>`,
      `aria-expanded="false"`); an open one starts open (`Collapse <KEY>`); the `No parent` lane's chevron reads `Collapse No parent`. A toggle
      survives a remount on the same board. Picking a second board without a remount shows that board's default folds; toggling there leaves the first
      board's override in `localStorage` (read `JIRA_LANE_FOLDS_KEY` back and assert both board ids).
  11. With search text, a folded lane holding a match draws open and its chevron is disabled; clearing the search folds it again and the stored value
      never changed.
  12. `localStorage` holding `null`, `"x"`, `[]` and `{ "<board id>": { "PAY-1": "junk" } }` under `JIRA_LANE_FOLDS_KEY` each draw the page with
      default folds.
  13. Filters: one matching card in a three-card lane → that lane with one card and `1 issue`; no matching card → the lane is gone; a filter matching
      only an on-board header → that header with three empty cells and neither count nor spread bar; a filter matching only a nested lane's header →
      its parent's header above it with empty cells, the nested header under it.
  14. A deck entry shows when its own issue matches the filters and hides when only its parent does.
  15. The column header reads the card counts — a board with one on-board header over 2 To Do cards and a folded settled lane of 3 Done cards reads
      `To Do 2`, `In Progress 0`, `Done 3` — and header issues add nothing. A lane header's count covers its subtree: Task 2's nesting shape reads
      `4 issues` on the root header and `2 issues` on the nested one, each beside a spread bar.
  16. `showing` reads 3 of 16 when three of sixteen loaded issues match. The band cases that sit inside today's `the fold` describe (`3 cards`)
      move to `the band` describe unchanged — the band still says `M cards` until Task 6 rewrites them.
  17. An empty loaded list draws the column header with zeros and `No issues`; filters that match nothing draw it with `No issues match`.
  18. *Review Focus 1.* Rerender with the parent of an open off-board lane now in the list → the header draws `Run ▾` and no tag; a stored override
      for that lane key still applies.
  19. *Review Focus 2.* Open a cell's `+ N more`, start a parent read on an off-board header, then rerender with a list that no longer holds that
      lane's cards → no error, the lane is gone, and the read's late answer does not call `onOpenIssue`.
  20. *Review Focus 5.* A six-deep chain draws every issue once, and its six lane elements carry the depths 0, 1, 2, 3, 3, 3 in document order —
      the attribute is there and stops at `LANE_INDENT_CAP`.
- [ ] **Step 3: Run — expect FAIL.** `pnpm exec jest test/jira/jira-board.test.tsx test/jira/jira-lib.test.ts test/ui/ui-fold-mark.test.tsx`
- [ ] **Step 4: Implement the lib and primitives** — `sessionCells`, `endedByKey`, `crumbOf`'s parameter, `FoldMark`'s `title` (rewrite its header
  comment: it names the direct parent, not "the top it folds under"), `usePickedJiraBoard`'s `lanes`. Delete `boardShelves`, `Shelf`, `ShelfCard`,
  `SHELF_LIMIT` from `jira-deck.ts`.
- [ ] **Step 5: Implement the hooks.** `useLaneFolds` per its interface; `toggle` writes through `setLaneFold` with the **unfiltered** `board`.
  `useOffBoardParent`: `ask(key)` clears `failed`, sets `reading`, calls `askParent(key)`; when it settles, act only if `key` is still the newest ask
  **and** is in `drawn` at that moment — then `onOpen(issue)` on success, `failed` on rejection (the sentence `useParentRead` shows for a failed
  read — read that hook and use the same words); otherwise drop the answer. It must not call `useParentRead`, `retainParent` or `releaseParent`
  (§3.2: a retained key pins a stale copy for the whole page).
- [ ] **Step 6: Implement `JiraLaneHeader`, `JiraLaneBoard` and the card changes** from §3.1–§3.4 and the two mocks. Column header: one row, `JIRA_COLUMNS`'
  labels and tones, `laneColumnCounts`' numbers, sticky while the lanes scroll. Lane: header row, then three cells (`laneCell` per cell; which cells
  are open is `useState` keyed by lane key and column, not persisted), then nested lanes; a folded lane draws its header only. Depth reaches CSS as a
  `data-depth` of `Math.min(depth, LANE_INDENT_CAP)`. The on-board header is the issue's card laid out as a row and keeps every control §3.2 lists;
  share those parts with `JiraCard` rather than copying them. `.claude/rules/board.md` puts a look more than one surface draws in
  `client/src/components/ui/` (precedent: `JiraTypeIcon`, `FoldMark`): each piece of markup and class both the card and the header draw becomes a
  presentational primitive there, taking plain props, with its own `test/ui/` case and its row in `docs/subsystems/board.md`'s primitives table; the
  pieces that carry behaviour (`JiraRunMenu`, `MrChip`, `SessionOpen`, `OpenChip`) stay in `components/jira/` and both mount them. `JiraCard.tsx`
  therefore still imports from `./SessionOpen` itself, and the source pin keeps reading that file. `JiraCard`: draw nothing for the
  `parent` crumb kind, drop the fold block, the match marker and the `jira-card-match` ring; with `session?.lead` set draw the state line, the
  leading-edge accent (class plus `data-state`) and `SessionOpen` as `DeckCard` mounts it, `+N` from `session.more`. `Run ▾` is untouched. Update the
  import pin in `jira-session-open.test.tsx` to the new `./SessionOpen` import line, keeping its intent — one home for `OpenChip`.
- [ ] **Step 7: Rewire `JiraBoardView`'s Board branch.** One predicate — `matchesBoardFilters` AND, while a delivery filter is picked and the index is
  loaded, `matchesDelivery` — feeds `laneViews(lanes, matches)`; `deck` = live entries whose **own** `issue` matches; `FilterBar`'s `showing` =
  `{ shown: <matching issues>, total: list.issues.length, note: <unchanged> }`; `GitlabBandLine` gets the matching issues. `searching` is true exactly
  when `matchesBoardFilters` would treat `search` as non-empty. The List branch keeps its old `rows`, `fold` and `cellStates` until Task 5, so its
  describes must still pass; change a List assertion in this task only where it reads `showing`. Delete `JiraShelves.tsx`.
- [ ] **Step 8: Styles.** Lane, header, cell, live-card and nested-indent rules in `client/src/styles.css` from the tokens and primitives already there
  (the mocks' inline pixel values are not the source); remove `.jira-card-fold`, `.jira-card-match` and the shelf rules that lost their markup.
- [ ] **Step 9: Run — expect PASS.** `pnpm run typecheck`; `pnpm exec jest` over the five test files above plus `test/guards/design-guards.test.ts`,
  `test/guards/fixture-clock.test.ts` and every suite
  `grep -l "FoldMark\|askParent\|usePersistedState\|SessionOpen\|JiraRunMenu\|SpreadBar\|JiraCard\|usePickedJiraBoard" -r test/` lists.
- [ ] **Step 10: Commit** — `feat(jira): draw the Board as parent lanes`.

### Task 5: The List draws lanes (§4)

Mocks: `List.dc.html` (header rows on a tinted ground, indented child rows, an off-board header row) and `ListDeep.dc.html` (nested header rows). Read
`00-mock-audit.md`'s List table first: the `Who` column, the missing Sprint column and the `–` cells are mock shorthand, not the build.

**Files:**
- Modify: `client/src/components/jira/JiraIssueList.tsx`, `client/src/components/jira/JiraBoardView.tsx` (List branch), `client/src/styles.css`
- Test: `test/jira/jira-board.test.tsx` (`the issue List`, `Run on`, `Delivery quick filter` describes), `test/jira/jira-delivery-surfaces.test.tsx`
  (its `JiraIssueList` renders)

**Interfaces:**
- Consumes: `JiraLaneView`, `LaneFoldState`, `OffBoardRead`, `SessionCell`, `LaneChevron`, `LANE_INDENT_CAP` (Tasks 3–4).
- Produces: `JiraIssueList({ views, folds, sessions, parentOf, site, read, now, filtered, onOpenIssue, onRun })` with `views: readonly JiraLaneView[]`,
  `folds: LaneFoldState`, `sessions: ReadonlyMap<string, SessionCell>`, `parentOf: JiraLanes['parentOf']`, `site: string`, `read: OffBoardRead`; `now`,
  `filtered`, `onOpenIssue`, `onRun` as today.

- [ ] **Step 1: Write the failing tests.**
  1. Rows come in lane order: for Task 2's nesting shape the row keys read `PAY-40` (header), `PAY-44`, `PAY-41` (nested header), then its two cards
     in `sortForBoard` order — a To Do and a Done card of one lane are not split by status.
  2. The Sprint and Assignee columns are drawn, Assignee as disc and name.
  3. An off-board header row has the table's full cell count, its Key, Summary, Type and Status filled from the stub, the tag `not on this board` in
     Summary, and empty Session, Delivery (when that column is drawn), Priority, Assignee, Sprint, Updated and Run cells; no cell carries `colSpan`.
  4. The `No parent` header row carries `No parent`, a chevron and the count in Summary; every other cell is empty.
  5. An on-board header row fills every cell with its own values, draws `Run ▾`, and carries `↳ <KEY>` when it has a parent.
  6. A row's Session cell shows its own key's session — a live session on `PAY-42` gives `PAY-42`'s row the state and `PAY-41`'s row (its parent)
     nothing — and no `FoldMark` is drawn in any Session cell; two live sessions on one key read the lead's state and `+1`.
  7. A row's Updated is its own stamp: a header updated 9 days ago over a card updated today shows the 9-day stamp.
  8. Folding a lane from its List chevron and switching to the Board shows it folded there (and the reverse).
  9. A settled off-board lane and a folded `No parent` lane each open from the chevron on their own header row.
  10. Every header row's count carries the class `.jira-issues-under` and reads `n issues` / `1 issue`.
  11. Indent: a nested header row at depth 1 and its card rows at depth 2 carry those depths on the Key cell's data attribute; a depth-5 lane's rows
      carry `LANE_INDENT_CAP`.
  12. Clicking an off-board header row's summary makes one request and opens Detail; its key links to `https://acme.atlassian.net/browse/<KEY>` and is
      plain text while the site is unknown.
  13. `No issues` and `No issues match` still draw; the Delivery quick filter still narrows the rows, now per issue.
- [ ] **Step 2: Run — expect FAIL.** `pnpm exec jest test/jira/jira-board.test.tsx test/jira/jira-delivery-surfaces.test.tsx`
- [ ] **Step 3: Implement.** One `tbody` walk over the views: header row, card rows (all statuses, lane order) while the lane is open, nested lanes;
  no cut. Header rows get a tint class; the indent is padding inside the Key cell selected by a `data-depth` attribute (cap as on the Board) — the
  table's columns, `table-layout: fixed` and the `nth-child` width rules do not change. `rowOpens`' click rule, the Key link and the quick filter stay.
  The header comment of `JiraIssueList.tsx` is rewritten: it no longer draws "one row per top".
- [ ] **Step 4: Rewire `JiraBoardView`'s List branch** onto `views`, the shared `folds` and `read`, and `sessionCells`; remove the memo's `rows`,
  `cellStates` and its `foldMatches` / `sortTops` / `topSessionCell` calls.
- [ ] **Step 5: Run — expect PASS.** `pnpm run typecheck`; the two suites, `test/guards/design-guards.test.ts`, `test/guards/fixture-clock.test.ts`,
  and every suite `grep -l "JiraIssueList" -r test/` lists.
- [ ] **Step 6: Commit** — `feat(jira): draw the List as parent lanes`.

### Task 6: Deck, band and Sessions page on the lane model; the fold is deleted (§1.5, §5, §6.1)

Mock: `Board.dc.html` — the band's `8 parents` and the deck card's `↳` mark. The deck card itself is drawn simplified there (`00-mock-audit.md`).

**Files:**
- Modify: `client/src/lib/jira-deck.ts`, `client/src/lib/jira.ts`, `client/src/hooks/usePickedJiraBoard.ts`,
  `client/src/components/jira/JiraAgentDeck.tsx`, `client/src/components/jira/JiraBandSub.tsx`, `client/src/components/jira/JiraSessionsView.tsx`,
  `client/src/components/jira/JiraBoardView.tsx`, `client/src/styles.css`
- Test: `test/jira/jira-lib.test.ts` (`bandSub`, `the fold` with its nested `bandSub with a fold`, `lib/jira-deck` describes),
  `test/jira/jira-board.test.tsx` (`the band`, deck cases), `test/jira/jira-list.test.tsx` (the Sessions page), and every other suite the grep of Step 5
  lists (`jira-launch.test.tsx` and `jira-sections.test.tsx` among them)

**Interfaces:**
- Consumes: `JiraLanes`, `laneParents`, `JiraParentRef` (Tasks 1–3).
- Produces:
  - `DeckEntry` loses `top` and gains `parent: JiraParentRef | null` — the parent the lane model kept for `issue`.
  - `boardAgents(issues: readonly JiraIssue[], parentOf: JiraLanes['parentOf'], payload, live): DeckEntry[]`.
  - `childSessions(issues, payload, live)` — unchanged signature; its entries carry `parent: null` (a Children row draws no `↳`).
  - `deckCrumb(entry, skills, opts)` — the lead is `↳ <entry.parent.key>` whenever `entry.parent` is not `null` and `opts.lead !== false`.
  - `bandSub(board, site, now, counts: { issues: number; parents: number } | null)` — the part reads `M parents` / `1 parent` and is pushed while
    `parents > 0`; `JiraBandSub`'s prop is renamed `counts` to match.
  - `usePickedJiraBoard` returns `lanes` and no `fold`.

- [ ] **Step 1: Write the failing tests.**
  - `bandSub`: `{ issues: 16, parents: 8 }` → the text holds `16 issues from 1 query · 8 parents`; `{ issues: 3, parents: 1 }` → `1 parent`;
    `{ issues: 4, parents: 0 }` → no parents part; `null` → as today. Replace the `cards` cases.
  - `boardAgents`: a live link on `PAY-42` (kept parent `PAY-41`) → its entry's `parent.key` is `'PAY-41'`; a live link on cycle member `PAY-71` →
    `parent null`; on `PAY-11` under off-board `PAY-1`, whose own parent summary is `'Checkout'` while its sibling `PAY-12`'s (the lane's stub)
    is `'Checkout v2'` → `parent.key 'PAY-1'` and `parent.summary 'Checkout'`, the card's own; a link on a key not in `issues` → no entry; a
    `starting` reservation → an entry, as today.
  - `deckCrumb`: an entry with `parent.key 'PAY-41'` leads `↳ PAY-41`; with `{ lead: false }` it does not; with `parent: null` it does not.
  - Page, `band`: sixteen issues under eight parents read `… · 16 issues from 1 query · 8 parents · …`; the same text with a filter that hides half of
    them; one parent reads `1 parent`; a board of parentless issues has no parents part.
  - Page, deck: a deck card whose issue has an off-board parent draws `↳ <parent key>` with the parent's summary as `title`; a deck card on a
    parentless issue draws no mark.
  - Sessions page (`test/jira/jira-list.test.tsx`): its band reads the same `M parents` for the same list, and a row's Detail still gets its children
    (`childrenOf`).
- [ ] **Step 2: Run — expect FAIL.** `pnpm exec jest test/jira/jira-lib.test.ts test/jira/jira-board.test.tsx test/jira/jira-list.test.tsx`
- [ ] **Step 3: Implement** the deck, band, hook and Sessions-page changes above; `JiraBoardView` passes
  `counts={loaded ? { issues: list.issues.length, parents: laneParents(lanes) } : null}` and `lanes.childrenOf` wherever it passed `fold.childrenOf`;
  `JiraAgentDeck` draws `FoldMark` from `entry.parent` with its summary as `title` and rewrites the header comment lines that speak of tops.
- [ ] **Step 4: Delete the fold.** For each of `foldBoard`, `JiraFold`, `sortTops`, `rolledUpdated`, `cardFold`, `foldMatches`, `matchMarker`,
  `childrenLine`, `topSessionCell`, `TopSessionCell`: `grep -rn "\b<name>\b" client/ server/ shared/` — delete it when the only hits are its own
  definition, leave it untouched when a caller outside the Board and Sessions pages remains (and say which in the commit body). `foldProgress`,
  `JiraProgress`, `JiraChildrenIndex`, `modalTree` and the walk helper `laneBoard` uses stay. Remove their test cases, the `describe('the fold')` cases
  that pin `tops` / `under` (the `childrenOf` and cycle cases already live in `describe('laneBoard')`), and Task 2's temporary
  `foldBoard`-equivalence assertions. The `foldProgress` and `modalTree` cases stay; where one builds its index with `foldBoard(x).childrenOf` it reads
  `laneBoard(x).childrenOf` instead. Remove CSS that lost its markup.
- [ ] **Step 5: Run — expect PASS.** `pnpm run typecheck`; `pnpm exec jest test/guards` and every suite this grep lists (after the edits, its first
  four names must have no hit left):

```bash
grep -l "foldBoard\|boardShelves\|SHELF_LIMIT\|topSessionCell\|FoldMark\|askParent\|usePickedJiraBoard\|usePersistedState\|SessionOpen\|JiraRunMenu\|SpreadBar\|JiraCard\|bandSub\|boardAgents\|deckCrumb\|childSessions" -r test/
```
- [ ] **Step 6: Commit** — `feat(jira): move the deck, band and Sessions page to the lane model`.

### Task 7: Docs that move with the code (§10)

**Files:**
- Modify: `docs/subsystems/jira.md` (~l.338–356 and ~l.657–661: the fold, `sortTops`, the shelves, `SHELF_LIMIT`, "one row per top"),
  `.claude/DESIGN.md` — all of §8.9.1 (~l.606–630: "The fold", the deck and view-switch paragraph, "The shelves", "Columns", the card's fold-block and
  foot bullets, the List's "one row per board card") and the §8.9.6 sentence at ~l.845 ("a top is kept when a folded child's own MR matches"),
  `docs/subsystems/board.md` (~l.129: `SpreadBar`'s "used by" cell names `JiraCard`'s fold block; plus any row Task 4 added or outdated) and
  `.claude/rules/board.md` wherever `grep -n` finds a symbol or part Task 4 or 6 deleted, the grouped-board spec of 2026-10-16 under
  `docs/superpowers/specs/`
  (`2026-10-16-jira-grouped-board-design.md` — one line at its top: superseded for the Board and List by this spec), and the header comments §10
  lists (`GitlabBandLine.tsx`, `useParentRead.ts`, `jira-deck.ts`) wherever they still describe tops, the fold or the shelves

- [ ] **Step 1: Rewrite, never append.** Each passage describes the lanes as the page now works — lane model, header kinds, the cut of 5, fold storage
  and its clamp, per-issue matching, `M parents` — in the document's own register; a rule file keeps mechanism only and links its `Why:`. Do not
  reflow untouched paragraphs.
- [ ] **Step 2: Check.** `grep -rni "foldBoard\|boardShelves\|SHELF_LIMIT\|topSessionCell\|sortTops\|cardFold\|foldMatches\|JiraShelves" docs/subsystems
  .claude/DESIGN.md .claude/rules client/src` returns nothing; `grep -rni "fold block\|match marker\|shelves\|shelf" docs/subsystems/jira.md
  docs/subsystems/board.md .claude/DESIGN.md .claude/rules/board.md` returns only lines about another page (name each survivor in the commit body);
  `pnpm exec jest test/guards` passes (the guards read the docs and rule files).
- [ ] **Step 3: Commit** — `docs(jira): describe parent lanes`.

### Task 8: `/ui-verify` — mock against the live page

- [ ] **Step 1: Invoke the `ui-verify` skill** with the four mock files and `00-mock-audit.md`. Fixture data must show, on one board: an on-board
  header with a parent chip, an off-board header with and without type and status, a nested lane, the `No parent` lane, a settled folded lane, a cell
  past the cut, and a card with a live session. Check the Board and the List at desktop width and at 375 px (no horizontal page scroll; the header
  row wraps its right-hand cluster rather than dropping a control), light and dark.
- [ ] **Step 2: Fix every defect on this branch**, each with a test where jsdom can see it, and re-run the touched suites.
- [ ] **Step 3: Commit** the fixes and keep the report path for the final review. Deliberate differences from the mocks are the ones
  `00-mock-audit.md` lists under "Drawn on a mock, not built" — anything else is a defect.
