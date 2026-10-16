# Jira board — children fold into their top ancestor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Jira board draws one card per top issue (G-A): every on-board descendant folds into its topmost on-board ancestor, the card says how many
issues sit under it and how far along they are, a filter that matches a folded issue rings its top card (F1), and the issue modal's Subtasks list becomes a
Children tree whose rows open that issue in the same modal.

**Architecture:** Client-only. One derivation, `foldBoard` in `client/src/lib/jira.ts`, is the only walk of the parent chain; the board, the band count, the
filters and the modal tree all read its result (`tops`, `under`, `childrenOf`). Every sentence the new surfaces print has its home in `lib/jira.ts` beside
the existing ones. Two looks drawn by two surfaces get a home in `components/ui/` — `SpreadBar` (the 4 px three-segment bar) and `JiraTypeIcon` (hoisted out
of `JiraCard`) — and `Marker` gains a `match` tone. The modal receives the fold's `childrenOf` as a snapshot prop threaded through `JiraView`, the slot that
already holds the open issue.

**Tech Stack:** React 18 + Vite, TypeScript strict, jest (node and jsdom projects) + Testing Library, pnpm. No new dependencies, no server change.

**Spec:** [docs/superpowers/specs/2026-10-16-jira-grouped-board-design.md](../specs/2026-10-16-jira-grouped-board-design.md) — §3 the fold, §4 the card and
band, §5 filters (F1), §6 the modal, §7 what does not change, §8 goals and anti-goals, §9 testing, §10 docs. It amends
[2026-10-15-jira-integration-design.md](../specs/2026-10-15-jira-integration-design.md) §1, §6.2 and §6.3; where they disagree, the grouped-board spec wins.
Mocks: https://claude.ai/artifact/JHdzBd5RCpWWSJwjKNFHZL, row "Grouped board" — `GroupTop.dc.html`, `ModalChildren.dc.html`, `GroupFilter.dc.html` F1. Their
numbers are illustrative; the spec's wording wins over the mock's wherever they differ.

**Plan conventions (they override the writing-plans template where the two differ):**
- Every task states BEHAVIOUR, SIGNATURES and EXACT TEST CASES — inputs, expected values, edge cases — and never literal implementation or test code. The
  implementer writes the bodies and is expected to disagree with a case here when the spec or the code says otherwise, and to say so in the commit body.
  Reason: handed code gets transcribed verbatim, bugs included (the user's global CLAUDE.md, "Learnings").
- Signatures in **Interfaces** are the one place a name is fixed; a later task that consumes a name spells it exactly as the producing task does.
- Size budgets are soft targets, never a reason to drop a rule or a comment. Comments explain _why_ at the density the touched files already have (CLAUDE.md
  "Conventions"); match it rather than stripping it. New prose — comments, docs — wraps at 160 columns.
- **Every component carries a header comment citing its `.claude/DESIGN.md` subsection** — `SpreadBar` cites §3 (the line Task 6 adds) and §8.9.1;
  `JiraTypeIcon` §8.9.1; `JiraCard`/`JiraBoardView` §8.9.1; `JiraIssueModal` §8.9.2 — and the spec section it implements. Task 6 writes the DESIGN.md text
  the citations point at; the citations land with the code.
- **Read the path-scoped rules before editing**: `.claude/rules/board.md` for anything under `client/src/`, `.claude/rules/tests.md` for anything under
  `test/`. They load on a `Read` of a matching file but NOT through `Write` or `codegraph_explore`, so open them by hand. The two that bite here: Escape has
  one owner (the modal row swap must never mount a second `Modal`), and a jsdom suite's fixture dates come from `daysAgoStamp`/`daysAgoDate`
  (`test/helpers/dates.ts`), never a literal (`test/fixture-clock.test.ts` guards it). Tests stay flat in `test/`.
- Run only the suites a task names (`pnpm run test:jest -- test/<name>.test.ts[x]`) plus `pnpm run typecheck`; CI runs the whole suite on the PR. Never the
  full `pnpm test` before a push (CLAUDE.md).
- Commit after every task with the message given. Branch `feat/jira-grouped-board` (already checked out in `.worktrees/jira-grouped-board`; never switch it,
  never touch the main checkout). It also carries `090ede5`, an unrelated committed fix — leave it alone. PR title (`ci / pr-title`):
  `feat(jira): fold children into their top card`.

## Global Constraints

Verbatim from the spec; every task's requirements include these.

- Client-only: no change under `server/`, `shared/types.ts` (`JiraIssue.subtasks` stays on the wire, unread by the board), routes, the cache or `jira.json`.
- No new persisted state, no flat/grouped toggle: the fold is derived on every render, never stored.
- No Jira call added by the fold or the tree: the modal still makes exactly one request, `GET /api/jira/issue/:key`, per issue it shows.
- `foldBoard` is the only code that walks the parent chain (§8 anti-goal). Nothing else follows `parent.key` upward.
- A top card sits in its **own** status category's column; folded issues never move it (§8 anti-goal).
- Copy, exactly: `C children · D below them`; at D = 0 `C children`, and `1 child`; progress caption `2 done · 4 in progress · 3 to do` with each zero
  omitted; `1 match: PAY-162`; `N matches` (keys in the marker's `title`); the modal heading `Children`, its pill the direct-children count, and `N in all`;
  the band's cards part `M cards` (`1 card`) as its own ` · `-separated part after the sources.
- Looks, exactly: the spread bar is 4 px tall, three segments done / in progress / to do in `--fill-progress`, `--fill-live`, `--ink3`, 2 px gaps; the
  caption under it is 12 px `--ink3`; the F1 ring is a 2 px `--amber-solid` inset ring; the `match` marker is inked `--amber-text`; the modal tree indents
  22 px per level.

## Rulings this plan makes where the spec is silent

Each is a decision, numbered so a reviewer can reject it by number.

- **R1 — sparse maps.** `under` and `childrenOf` hold an entry only for a key with at least one issue under it; readers use `?? []`. `tops` keeps the input
  list's order (sorting is `sortTops`'s job, per column).
- **R2 — `bandSub`'s fold is a required parameter.** `fold: { issues: number; cards: number } | null`, no default — `lib/jira.ts`'s rule for `now`, for the
  same reason: a default is how the next call site forgets it. `null` means "the list has not loaded" and reproduces today's line from `board.count`.
- **R3 — "the list has loaded"** is exactly the condition under which the board draws columns today: not `list.loading`, and not (`list.error` with an empty
  list). The band and the columns read one condition, so the band cannot claim cards the columns are not drawing.
- **R4 — two new primitive families.** `SpreadBar` draws `.ui-spread…` and `JiraTypeIcon` draws `.ui-type-icon` (the svg rule today scoped as
  `.jira-card-type svg` moves there), both declared inside the `/* ── ui primitives` block, and `test/design-guards.test.ts` guard 7's `FAMILIES` gains both.
  `.jira-card-type` keeps only its layout (`inline-flex`, `flex: none`).
- **R5 — `SpreadBar` draws only non-zero segments** (so a zero never leaves a double gap), sized by `flex-grow` proportional to its count, and renders
  nothing at all when the three counts sum to zero.
- **R6 — the ring is a page class**, `.jira-card-match` on the `.board-card` element (`box-shadow: inset 0 0 0 2px var(--amber-solid)`), not a `.board-card`
  variant and not a ui family.
- **R7 — where the new pieces sit on the card.** The fold block goes after the foot and before the marker row (§4: "above the marker row"). The `match`
  marker is the marker row's FIRST word, before the priority; the marker row now draws when there is a priority or a match.
- **R8 — the modal draws the bar with the same caption** as the card: `SpreadBar` is one look, and a bar without its numbers is decoration.
- **R9 — the tree's "each key once" skip set** is the modal's own key plus every direct child's key, plus each key as it is emitted. Seeding all direct
  children first is what lets a reparented issue land as the direct child even when the stale branch that also holds it is drawn earlier; seeding the
  modal's own key stops a stale snapshot from drawing the open issue inside its own tree.
- **R10 — tree rows are `li > button`** inside a `ul`, each `li` carrying `data-depth` (0 for a direct child) and its indent as `depth × 22 px`. The button's
  accessible name contains the key and the summary.
- **R11 — `subtasksMarker` is deleted** with its last reader (Task 3), not left exported and unread.

## Review Focus

Inputs the spec implies that no case above would otherwise reach, most likely first. Each has a case in the owning task.

1. **A cached list with a cycle** (a self-parent, a two-cycle, a child hanging off a cycle member): the page must render and terminate, each issue once.
   → Task 1 (`foldBoard` cases), and Task 3 draws a two-cycle board without hanging.
2. **A filter matching only a grandchild** (depth 2): its depth-0 top shows, ringed, naming the grandchild's key — not the intermediate story. → Task 4.
3. **A top whose folded issues are all in other columns**: it stays in its own column and its bar says so; the other columns do not gain those issues. →
   Task 3 (`PAY-170` is Done under a To Do epic; the Done column stays empty).
4. **A modal row for an issue the board does not hold**: it opens in the same single modal from its own detail read, with direct children only, and
   Escape closes that one modal. → Task 5.
5. **Filters never move the band**: the band's issue and card counts are the unfiltered list's, whatever the filters hide. → Task 4.

---

### Task 1: The fold and its sentences in `lib/jira.ts`

**Files:**
- Modify: `client/src/lib/jira.ts` (new section `── The fold`, between `── Columns, order, the card` and `── Sentences`; `bandSub` gains its fold),
  `client/src/components/jira/JiraBoardView.tsx` (`BandSub` passes `null` for now — Task 3 passes the real numbers)
- Test: `test/jira-lib.test.ts`; `test/jira-board.test.tsx` (its one direct `bandSub` call gains the fourth argument `{ issues: 4, cards: 4 }`, text
  unchanged)

**Interfaces:**
- Produces (all exported from `client/src/lib/jira.ts`):
  - `type JiraChildrenIndex = ReadonlyMap<string, readonly JiraIssue[]>`
  - `interface JiraFold { tops: JiraIssue[]; under: ReadonlyMap<string, readonly JiraIssue[]>; childrenOf: JiraChildrenIndex }`
  - `foldBoard(issues: readonly JiraIssue[]): JiraFold`
  - `sortTops(tops: readonly JiraIssue[], under: JiraFold['under']): JiraIssue[]`
  - `interface JiraProgress { done: number; doing: number; todo: number }`; `foldProgress(issues: readonly JiraIssue[]): JiraProgress`
  - `progressLine(p: JiraProgress): string | null`
  - `childrenLine(direct: number, deeper: number): string | null`
  - `cardFold(topKey: string, fold: JiraFold): { line: string; progress: JiraProgress; caption: string } | null`
  - `foldMatches(fold: JiraFold, keep: (issue: JiraIssue) => boolean): Map<string, string[]>`
  - `matchMarker(keys: readonly string[]): { word: string; title: string | undefined } | null`
  - `interface JiraTreeRow { issue: JiraIssue; depth: number }`;
    `modalTree(selfKey: string, children: readonly JiraIssue[], childrenOf: JiraChildrenIndex | null): { rows: JiraTreeRow[]; progress: JiraProgress }`
  - `bandSub(board: JiraBoardStatus, site: string, now: number, fold: { issues: number; cards: number } | null): { text: string; failing: boolean }`

Behaviour:
- `foldBoard` (§3). `top(X)` is X when `X.parent` is `null`, when `X.parent.key` is not a key in the list, or when X lies on a cycle (the walk up from X
  returns to X); otherwise `top(parent(X))`. The algorithm the signature does not determine: walk up from X recording the path; stop at a node whose parent
  is absent or off the list (that node is the top), or at the first parent already on the path — then the cycle is the path from that parent's position to
  the end, and the top is the first node of the walk that lies on that cycle (for X on the cycle that is X itself; for a child of a cycle member it is that
  member). Memoise per key so the whole list is linear. Every non-top X is appended to `under[top(X)]` and to `childrenOf[X.parent.key]` — fold edges only,
  so a top is nobody's child and `childrenOf` is acyclic by construction. Every `under` and `childrenOf` list is in `sortForBoard` order. The input array is
  never mutated (it is the poller's cache copy).
- `sortTops` — newest `updated` across the top and everything in `under[top.key]`, descending; ties by key in plain string order (`sortForBoard`'s
  tie-break); an unparseable stamp counts as 0. Returns a new array.
- `foldProgress` buckets by `columnOf`: `done` → done, `doing` → doing, `todo` → todo. `progressLine` prints the non-zero parts in the order done, in
  progress, to do (`2 done · 4 in progress · 3 to do`), `null` when all three are zero.
- `childrenLine(direct, deeper)` — `null` at `direct === 0`; otherwise `C children` / `1 child`, plus ` · D below them` when `deeper > 0`.
- `cardFold` — `null` when `under` has nothing for the key; else `direct` = `childrenOf[topKey]`'s length, `deeper` = `under[topKey]`'s length minus
  `direct`, `line` = `childrenLine`, `progress` = `foldProgress(under[topKey])`, `caption` = `progressLine(progress)`.
- `foldMatches` (§5, F1) — for each top: if `keep(top)`, the map gets `top.key → []`; else if any issue in `under[top.key]` is kept, `top.key → ` those
  keys in `under`'s order; else the top is absent (hidden). `keep` is the board's existing `matchesBoardFilters(i, applied, me)`, unchanged.
- `matchMarker` — `[]` → `null`; one key → `{ word: '1 match: <KEY>', title: undefined }`; more → `{ word: '<N> matches', title: keys joined ', ' }`.
- `modalTree` (§6, R9) — direct children at depth 0 in the given order; after each, its descendants from `childrenOf` depth-first in the index's order at
  depth + 1, skipping (with its whole branch at that point) any key in the skip set. `childrenOf: null` → the direct children only. `progress` counts the
  rows as drawn.
- `bandSub` (§4) — `fold === null`: today's text exactly. Otherwise the issue part counts `fold.issues` (not `board.count`), and when
  `fold.cards < fold.issues` a part `M cards` (`1 card`) follows the sources part. Polled, failure and `first 500 shown` keep their places after it.

- [ ] **Step 1: Write the failing tests** in `test/jira-lib.test.ts` (stamps from `ago(now, …)` / `daysAgoStamp`, never literals). Keys below are fixture
  names; give each a distinct `updated` so the `sortForBoard` order is a fact of the case. A shared helper asserts, for every `foldBoard` case, that the
  multiset of `tops` keys plus every `under` list's keys equals the input's keys exactly once each.
  - depth 1: `[E1, S1→E1]` → tops `[E1]`, under `E1: [S1]`, childrenOf `E1: [S1]`, no entry for `S1`.
  - depth 2 and 3: `[E1, S1→E1, T1→S1, U1→T1]` → tops `[E1]`; under `E1` holds S1, T1, U1 in `sortForBoard` order; childrenOf `E1: [S1]`, `S1: [T1]`,
    `T1: [U1]`, no `U1` entry.
  - parent off the board: `S2→X-9` with no `X-9` in the list → `S2` is a top, and `crumbText(crumbOf(S2, …))` still reads `↳ X-9 <summary>`.
  - parent dropped by the Done window (absent from the list): `[S1→E1, T1→S1]` → tops `[S1]`, under `S1: [T1]`.
  - a query hit that folds: `[E1, S1→E1, Q1→S1]` where Q1 is the query's hit → Q1 under `E1`, childrenOf `S1: [Q1]`.
  - self-parent: `[A→A]` → tops `[A]`, no under, no childrenOf; returns (does not hang).
  - two-cycle: `[A→B, B→A]` → tops `[A, B]` in input order; `under` and `childrenOf` empty.
  - child of a cycle member: `[A→B, B→A, C→A]` → tops `[A, B]`, under `A: [C]`, childrenOf `A: [C]`, nothing between A and B.
  - the input array is unchanged after the call (same order, same objects).
  - `sortTops`: two tops, P (own `updated` 5 d ago, a folded child updated now) and Q (own `updated` 1 d ago, nothing folded) → `[P, Q]`; two tops with equal
    newest stamps → key order; an unparseable `updated` sorts last.
  - `foldProgress` + `progressLine`: `{2,4,3}` → `2 done · 4 in progress · 3 to do`; `{0,1,0}` → `1 in progress`; `{1,0,2}` → `1 done · 2 to do`; all zero →
    `null`.
  - `childrenLine` at 0/1/many: `(0,0)` → `null`; `(1,0)` → `1 child`; `(3,0)` → `3 children`; `(1,1)` → `1 child · 1 below them`; `(2,7)` →
    `2 children · 7 below them`.
  - `cardFold`: the depth-3 fixture with S1 in progress, T1 done, U1 to do → for `E1`: `line` `1 child · 2 below them`, caption
    `1 done · 1 in progress · 1 to do`; for a top with nothing folded → `null`.
  - `foldMatches` on `[E1, S1→E1, T1→S1, R]`: keep-all → `{E1: [], R: []}`; keep only T1 → `{E1: ['T1']}`; keep E1 and T1 → `{E1: []}`; keep nothing →
    empty map; on the two-cycle, keep only B → `{B: []}`.
  - `matchMarker`: `[]` → `null`; `['PAY-162']` → `{ word: '1 match: PAY-162', title: undefined }`; `['PAY-162', 'PAY-161']` →
    `{ word: '2 matches', title: 'PAY-162, PAY-161' }`.
  - `modalTree`: `childrenOf` null → direct children only, all depth 0; nested index (A → [A1], A1 → [A2]) with children `[A, B]` → rows A/0, A1/1, A2/2,
    B/0; a direct child absent from the index lists with nothing under it; reparent — children `[A, X]`, index `A: [X, Y]` → rows A/0, Y/1, X/0 (X once);
    the index holding `selfKey` under a child → that row is skipped; `progress` counts the rows as drawn.
  - `bandSub` with a fold: board with 2 roots, 1 query, `count: 14`, fold `{ issues: 17, cards: 5 }`, polled 12 s ago →
    `acme.atlassian.net · 17 issues from 2 roots and 1 query · 5 cards · polled 12 s ago`; fold `{ issues: 14, cards: 14 }` → today's line exactly; fold
    `{ issues: 3, cards: 1 }` → contains ` · 1 card · `; fold `{ issues: 0, cards: 0 }` → `0 issues`, no cards part; truncated with a fold → `first 500
    shown` still last; `null` → identical to the pre-change text for each existing `bandSub` case (update those cases to pass `null`).
- [ ] **Step 2: Run** `pnpm run test:jest -- test/jira-lib.test.ts` — FAIL (the new names are not exported).
- [ ] **Step 3: Implement** the section in `lib/jira.ts`, each export with a header comment in the file's existing density citing grouped-board spec §3–§6.
  The `count` helper's noun union gains `'card'`. Update `BandSub` in `JiraBoardView.tsx` to pass `null` and the `bandSub` call in `test/jira-board.test.tsx`.
- [ ] **Step 4: Run** `pnpm run test:jest -- test/jira-lib.test.ts test/jira-board.test.tsx` — PASS; `pnpm run typecheck` — clean.
- [ ] **Step 5: Commit** — `feat(jira): foldBoard — children fold into their top ancestor`

### Task 2: The primitives — `SpreadBar`, `JiraTypeIcon`, the `match` marker

**Files:**
- Create: `client/src/components/ui/SpreadBar.tsx`, `client/src/components/ui/JiraTypeIcon.tsx`
- Modify: `client/src/components/ui/Marker.tsx` (`MarkerTone` gains `'match'`; its header says what the tone is for), `client/src/components/jira/JiraCard.tsx`
  (the private `TypeIcon` is deleted and the card imports `JiraTypeIcon`), `client/src/styles.css` (`.ui-spread…`, `.ui-type-icon`, `.ui-marker-match`
  inside the ui primitives block; `.jira-card-type svg` removed), `test/design-guards.test.ts` (guard 7's `FAMILIES` gains `.ui-spread` and
  `.ui-type-icon`), `test/ui-marker.test.tsx` (the tone loop gains `'match'`)
- Test: `test/ui-spread-bar.test.tsx` (new, jsdom, the shape of `test/ui-progress-row.test.tsx`)

**Interfaces:**
- Produces: `SpreadBar({ done, doing, todo, caption }: { done: number; doing: number; todo: number; caption?: string | null })`;
  `JiraTypeIcon({ type }: { type: JiraIssue['type'] })` — the same glyph table `TypeIcon` has today, `aria-hidden`, class `ui-type-icon`;
  `MarkerTone = 'groomed' | 'kind' | 'done' | 'stale' | 'untyped' | 'match'`.

Behaviour: `SpreadBar` is a 4 px track of up to three segments — done `--fill-progress`, in progress `--fill-live`, to do `--ink3` — 2 px gaps, each
non-zero segment `flex-grow` by its count (R5), nothing rendered when all are zero; the caption, when given, sits under it at 12 px `--ink3`. The track is
`role="img"` with an `aria-label` equal to the caption (or, without one, the three counts in the caption's own words), since the segments are decoration. No
text inside the bar. `.ui-marker-match` is `color: var(--amber-text)` — never bare `--amber` (design-guards forbids it).

- [ ] **Step 1: Write the failing tests** — `ui-spread-bar`: `{2,4,3}` draws three segments in order done/doing/todo, each with its class, and flex-grow 2,
  4, 3; `{0,1,0}` draws exactly one segment; `{0,0,0}` renders nothing (container empty); the caption `2 done · 4 in progress · 3 to do` is drawn and is the
  track's accessible name. `ui-marker`: the `match` tone lands as `ui-marker-match`. `design-guards` guard 7 with the two families added fails until the CSS
  declares them inside the block.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/ui-spread-bar.test.tsx test/ui-marker.test.tsx test/design-guards.test.ts` — FAIL.
- [ ] **Step 3: Implement** the two components (headers: `SpreadBar` cites DESIGN.md §3's spread-bar line and §8.9.1 plus spec §4/§6 — and why it is not
  `ProgressRow`: one fill at 10 px against three segments at card scale; `JiraTypeIcon` cites §8.9.1 and says why it moved: the card and the modal tree both
  draw it). Move the svg look into `.ui-type-icon`. `JiraCard` renders `<JiraTypeIcon>` inside its existing `.jira-card-type` span (title unchanged).
- [ ] **Step 4: Run** the three suites plus `test/jira-board.test.tsx`, `test/daylight-contrast.test.ts` — PASS; typecheck.
- [ ] **Step 5: Commit** — `feat(ui): SpreadBar, JiraTypeIcon and the match marker`

### Task 3: The board draws tops — columns, sort, fold block, band

**Files:**
- Modify: `client/src/components/jira/JiraBoardView.tsx`, `client/src/components/jira/JiraCard.tsx`, `client/src/lib/jira.ts` (delete `subtasksMarker`,
  R11), `client/src/styles.css` (`.jira-card-fold…` — the fold block's layout and its line)
- Test: `test/jira-board.test.tsx`

**Interfaces:**
- Consumes: `foldBoard`, `sortTops`, `cardFold`, `bandSub`'s fold, `JiraFold`, `JiraChildrenIndex` (Task 1); `SpreadBar`, `JiraTypeIcon` (Task 2).
- Produces: `JiraBoardView({ onOpenJiraPage, onOpenIssue })` with `onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex) => void` — a card click
  passes the current fold's `childrenOf` (spec §6, "Where the board's list comes from"). `JiraCard` gains `fold: ReturnType<typeof cardFold>` and
  `matches: readonly string[]` (Task 4 fills `matches`; this task passes `[]`). `JiraView` compiles unchanged: its one-argument setter is assignable.

Behaviour (§3, §4): `foldBoard(list.issues)` memoised on the list; the column split reads `fold.tops` (filtered as today, per top — Task 4 replaces this with
F1), each column `sortTops(colTops, fold.under)` in place of `sortForBoard`; the column count pill counts cards. The card draws, after the foot and before the
marker row (R7), the fold block when `fold !== null`: the `line` (style per `GroupTop.dc.html`; 12/500 `--ink2` if the mock is ambiguous), then
`SpreadBar` with the `caption`. The `N subtasks` marker is gone: nothing on the card reads `issue.subtasks`. The card's age stays `cardAgeStamp(top)`.
`BandSub` receives `{ issues: list.issues.length, cards: fold.tops.length }` when the list has loaded (R3), else `null`, both unfiltered.

- [ ] **Step 1: Rewrite the fixture and write the failing tests.** The existing ALPHA cases keep their meaning with ONE fixture change: `PAY_131.parent`
  becomes `{ key: 'PAY-99', summary: 'Payments platform' }` (off the board), so PAY-131 stays a top and its crumb case now reads `↳ PAY-99 Payments
  platform`. Replace the `2 subtasks` / `1 subtask` assertions with: no element on the board contains the text `subtask`. `onOpenIssue` assertions become
  `toHaveBeenCalledWith(<issue>, expect.any(Map))`. Add a `GROUP` list (stamps via `daysAgoStamp`), served for ALPHA's id inside a `describe('the fold')`,
  with ALPHA's `count` left at 4 so the band case below can tell the list from the status:
  - `PAY-120` Epic, a root, To Do, updated 5 d; `PAY-160` Story → PAY-120, In Progress, 4 d; `PAY-161` `Sub-task` (level −1, `subtask: true`) → PAY-160,
    Done, updated and resolved 3 d; `PAY-162` `Sub-task` → PAY-160, To Do, 0 d, summary `Ledger rounding fix`; `PAY-170` Story → PAY-120, Done, 6 d;
    `PAY-180` Task, no parent, To Do, 1 d, summary `Standalone task`; `PAY-190` Task → `PAY-999` (off the board), In Progress, 2 d.
  - Cases: the columns' counts are `2`, `1`, `0`; To Do reads `[PAY-120's summary, Standalone task]` (PAY-120 first through PAY-162's 0 d, though its own
    `updated` is the older); no folded summary is drawn anywhere (PAY-160/161/162/170); the Done column is empty although PAY-161 and PAY-170 are done
    (Review Focus 3). PAY-120's card reads `2 children · 2 below them` and `2 done · 1 in progress · 1 to do`, its spread bar draws three segments, and its
    age reads `cardAgeStamp` of PAY-120 itself (`5d`, not `now`). PAY-180's and PAY-190's cards draw no fold block; PAY-190's crumb reads `↳ PAY-999 …`.
  - clicking PAY-120's card calls `onOpenIssue(PAY-120, map)` with `map.get('PAY-120')` → `[PAY-160, PAY-170]` and `map.get('PAY-160')` → `[PAY-162,
    PAY-161]`.
  - the band reads `acme.atlassian.net · 7 issues from 1 root and 1 query · 3 cards · polled 10m ago` — 7 from the list although the status says 4.
  - while the issues request is unanswered (a `fetch` that never resolves for `/issues`) the band reads `bandSub(ALPHA, site, now, null).text` — `4 issues`,
    no cards part; on ALPHA's own list (nothing folds) it reads today's line, no cards part.
  - a two-cycle list (`PAY-1 → PAY-2`, `PAY-2 → PAY-1`) renders both as cards and the page settles (Review Focus 1).
- [ ] **Step 2: Run** `pnpm run test:jest -- test/jira-board.test.tsx` — FAIL.
- [ ] **Step 3: Implement.** Update `JiraCard`'s and `JiraBoardView`'s header comments for the fold (they currently describe flat cards and a subtasks
  marker), citing DESIGN.md §8.9.1 and grouped-board spec §3/§4. Delete `subtasksMarker` and its import.
- [ ] **Step 4: Run** `pnpm run test:jest -- test/jira-board.test.tsx test/jira-lib.test.ts test/jira-modal.test.tsx test/design-guards.test.ts` — PASS
  (`jira-modal`'s two `JiraView` cases must still pass untouched); typecheck.
- [ ] **Step 5: Commit** — `feat(jira): the board draws one card per top issue`

### Task 4: Filters and search find folded issues (F1)

**Files:**
- Modify: `client/src/components/jira/JiraBoardView.tsx`, `client/src/components/jira/JiraCard.tsx`, `client/src/styles.css` (`.jira-card-match`, R6)
- Test: `test/jira-board.test.tsx`

**Interfaces:**
- Consumes: `foldMatches`, `matchMarker`, `matchesBoardFilters`, `boardFilterOptions` (Task 1 / existing); `Marker` tone `match` (Task 2).
- Produces: `JiraCard`'s `matches` now carries the ring keys; nothing new for later tasks.

Behaviour (§5): the shown tops are `foldMatches(fold, (i) => matchesBoardFilters(i, applied, me))`; a shown top whose ring keys are non-empty gets the
`.jira-card-match` class and, first in its marker row (R7), `<Marker tone="match" title={…}>` with `matchMarker`'s word and title. `boardFilterOptions` keeps
reading `list.issues` — every loaded issue, folded or not. The band's numbers stay unfiltered (Task 3). With no filter and no search every top keeps itself,
so nothing is ringed — no special case.

- [ ] **Step 1: Write the failing tests** on the `GROUP` list:
  - search `ledger` → exactly one card, PAY-120's, with class `jira-card-match` and the marker `1 match: PAY-162` carrying `ui-marker-match` — PAY-162 is a
    grandchild, so this is also Review Focus 2; To Do counts `1`, In Progress `0`.
  - search `PAY-1` (every key matches) → every top drawn, no element with `jira-card-match`, no `match` marker.
  - the Type filter offers `Sub-task` although no card is one; picking it → PAY-120 alone, ringed, marker `2 matches` with `title` `PAY-162, PAY-161`.
  - with a filter active, the band text is unchanged (`7 issues … · 3 cards`) — Review Focus 5.
  - no filter and no search → no `jira-card-match` anywhere.
  - search `standalone` → PAY-180 alone, not ringed.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/jira-board.test.tsx` — FAIL.
- [ ] **Step 3: Implement**; extend the card's header with the ring's "why is this here" reasoning (§5).
- [ ] **Step 4: Run** `pnpm run test:jest -- test/jira-board.test.tsx test/design-guards.test.ts test/daylight-contrast.test.ts` — PASS; typecheck.
- [ ] **Step 5: Commit** — `feat(jira): a filter that matches a folded issue rings its top card`

### Task 5: The modal's Children tree and the row swap

**Files:**
- Modify: `client/src/components/jira/JiraIssueModal.tsx`, `client/src/components/jira/JiraView.tsx`, `client/src/styles.css` (`.jira-modal-subtasks`,
  `-subkey`, `-substatus` give way to a `.jira-tree…` family: head row, rows, indent)
- Test: `test/jira-modal.test.tsx`

**Interfaces:**
- Consumes: `modalTree`, `progressLine`, `JiraChildrenIndex` (Task 1); `SpreadBar`, `JiraTypeIcon` (Task 2); `initialsOf`, `Pill`; the board's
  `onOpenIssue(issue, childrenOf)` (Task 3).
- Produces: `JiraIssueModal({ issue, childrenOf, onOpenIssue, onClose }: { issue: JiraIssue; childrenOf: JiraChildrenIndex | null; onOpenIssue: (issue:
  JiraIssue, childrenOf: JiraChildrenIndex | null) => void; onClose: () => void })`. `JiraView` holds `{ issue, childrenOf } | null` and passes one setter
  as both the board's `onOpenIssue` and the modal's.

Behaviour (§6): when `detail.children` is non-empty the body draws, in place of `Subtasks`: a head row — an `h3` `Children`, a `neutral` `Pill` with
`detail.children.length`, and right-aligned `N in all` (N = rows drawn) only when rows outnumber the direct children — then `SpreadBar` over
`modalTree(...).progress` with its caption (R8), then the tree (R10): each row a button with `JiraTypeIcon`, key, summary, assignee initials (the empty
disc when unassigned, as on the card) and the raw status as a `neutral` `Pill`. A row click calls `onOpenIssue(row.issue, childrenOf)` — the same snapshot
— so `JiraView` swaps the one modal's issue; `JiraIssueModal`'s existing key-stamped read then fetches the new issue's detail. Never a second `Modal`. The
snapshot is taken when the card is clicked and is not refreshed by later board polls. No filter marking inside the tree (§8 non-goal).

- [ ] **Step 1: Write the failing tests.** `mount` gains `childrenOf` (default `null`) and `onOpenIssue` (default a `jest.fn()`). Children fixtures reuse
  `CARD` with distinct keys, statuses and `parent`.
  - the existing Subtasks case becomes: heading `Children`, its pill `2`, two rows naming `PAY-132 Wire the refund call` and `PAY-133 Receipt copy` with
    their raw statuses; no heading `Subtasks` anywhere; no `in all` (nothing deeper, `childrenOf` null — "with no `childrenOf` the tree is the direct children
    only"). The "no heading when there are none" case asserts `Children` instead.
  - nested: detail children `[PAY-160, PAY-170]`, `childrenOf` `{PAY-160: [PAY-162, PAY-161]}` → rows in order PAY-160, PAY-162, PAY-161, PAY-170 with
    `data-depth` 0, 1, 1, 0 and the depth-1 rows indented 22 px; `4 in all`; caption matches the four rows' statuses.
  - a detail child the board does not hold: children `[PAY-160, PAY-175]`, index `{PAY-160: [PAY-161]}` → three rows, PAY-175 at depth 0 with nothing
    under it, `3 in all`, the caption sums to three.
  - reparent: children `[PAY-160, PAY-161]`, index `{PAY-160: [PAY-161, PAY-162]}` → PAY-161 drawn once, at depth 0; `3 in all`.
  - a row click calls `onOpenIssue` with that row's issue and the very `childrenOf` object the modal was given.
  - `JiraView` swap (extend the `describe('JiraView — …')` block; board list = Task 3's `GROUP` shape; detail answers keyed by URL, PAY-120's carrying
    children `[PAY-160, PAY-170]` and PAY-162's its own summary and no children): click PAY-120's card → dialog `PAY-120 …`; the tree holds PAY-162 at depth
    1 from the snapshot; click the row `PAY-162` → the dialog's name becomes `PAY-162 Ledger rounding fix`, `getAllByRole('dialog')` has length 1, and
    `/api/jira/issue/PAY-162` was requested exactly once; Escape → no dialog.
  - Review Focus 4 (same setup, but PAY-120's detail children are `[PAY-160, PAY-175]`, PAY-175 absent from the board list, and PAY-175's detail has no
    children): PAY-175's row opens `PAY-175` in the same single dialog, which draws no `Children` heading; Escape closes it and no dialog is left.
  - the existing `JiraView` cases (open/close, the slot cleared on a page switch) still pass.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/jira-modal.test.tsx` — FAIL.
- [ ] **Step 3: Implement.** Update both header comments: `JiraIssueModal` (cites DESIGN.md §8.9.2 and grouped-board spec §6 — the snapshot, the swap, why
  never a second modal) and `JiraView` (the slot now holds the issue AND its snapshot).
- [ ] **Step 4: Run** `pnpm run test:jest -- test/jira-modal.test.tsx test/jira-board.test.tsx test/dialog-escape.test.tsx test/ui-modal.test.tsx
  test/design-guards.test.ts` — PASS; typecheck.
- [ ] **Step 5: Commit** — `feat(jira): the issue modal's Children tree, one modal throughout`

### Task 6: Docs that move with the code (spec §10)

**Files:**
- Modify: `.claude/DESIGN.md` (§3, §8.9.1, §8.9.2), `docs/subsystems/jira.md` (the client section's `lib/jira.ts`, Board and modal bullets),
  `client/src/components/ui/SpreadBar.tsx` only if its §3 citation needs the final wording

Behaviour:
- DESIGN.md §3: a line beside `Progress bars: 10 px tall…` — the card-scale `SpreadBar`: 4 px, three segments in `--fill-progress`, `--fill-live`, `--ink3`,
  2 px gaps.
- §8.9.1: the "flat cards sorted by `updated`" sentence becomes the fold (G-A; tops sorted by the newest `updated` under them; picked over G-B/G-C/G-D, one
  clause each, the way the section records `Main.dc.html`'s rejection); a fold-block bullet (line, bar, caption); the marker-row bullet loses `N subtasks`
  and gains the `match` marker; the F1 ring; the column count counts cards; the band's `M cards` part.
- §8.9.2: `Subtasks` → `Children` — the head row, the bar, the tree (22 px per level, the row's pieces, each key once), and the row swap in the one modal.
- `docs/subsystems/jira.md`: the `lib/jira.ts` bullet loses the subtasks marker and names `foldBoard`/`sortTops`/the fold sentences; the Board bullet says
  the board draws tops and a card click passes the fold's `childrenOf`; the modal bullet describes the Children tree and the swap. Do NOT re-stamp the
  docs-sync footer (its source is `server/src/jira`, which this change does not touch).
- Then `grep -rn "subtasksMarker\|N subtasks\|1 subtask\|Subtasks" docs/subsystems .claude client/src` — every hit is either updated or a deliberate
  historical reference (specs and plans under `docs/superpowers/` stay as written).

- [ ] **Step 1: Edit** the three DESIGN.md subsections and `docs/subsystems/jira.md`, new prose at 160 columns, existing prose not reflowed.
- [ ] **Step 2: Verify** the grep above, then `pnpm run test:jest -- test/claude-rules.test.ts test/design-guards.test.ts` — PASS (they read these
  files).
- [ ] **Step 3: Commit** — `docs(jira): the grouped board in DESIGN.md and the Jira subsystem doc`

---

## Self-review notes

- Spec coverage: §3 → Task 1 (+ the board's use in Task 3); §4 card/band → Tasks 2–3; §5 → Task 4; §6 → Tasks 1 (`modalTree`), 2 (primitives), 5; §7 is
  the Global Constraints' first line; §8 anti-goals → Global Constraints; §9 → the cases in Tasks 1, 3, 4, 5; §10 → Task 6.
- §4's phase-5 note (live strip, `Run ▾` on a folded issue) is recorded in the spec and deliberately has no task.
