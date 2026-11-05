# Jira › Sessions page + issue List on Jira › Board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This plan specifies behaviour, signatures and exact test cases — never literal code.** That overrides the writing-plans template's "code blocks required"
> rule (global CLAUDE.md, Learnings). Where a step names a test, the test's name and assertions are the contract; write the scaffolding yourself, and if a
> value in this plan disagrees with the spec or the code, the spec and the code win — say so in the task report. Every size budget here is soft.

**Goal:** Split Jira › Board › List into two things: an **issue table** on Jira › Board (one row per board card) and a new **Jira › Sessions** page that
hosts today's session table unchanged.

**Architecture:** `JiraPage` gains `'sessions'`; `JiraView` draws a new `JiraSessionsView` for it, beside the same Detail modal and launch sheet the Board page
has. The board-loading half of `JiraBoardView` (stored pick → board → `useJiraBoard` → fold) moves into one hook both pages call, and `BoardPicker` moves into
its own file both pages draw. `JiraBoardView`'s `list` view draws a new `JiraIssueList` fed by the same fold, filters and `boardAgents` the deck uses.

**Tech Stack:** React 18 + TypeScript (client), jest + Testing Library (jsdom), pnpm.

**Spec:** `docs/superpowers/specs/2026-11-05-jira-sessions-page-design.md`. Mocks: `docs/superpowers/specs/2026-11-05-jira-sessions-page-mockups/canvas/`
(`Main.dc.html`, `SessionsB.dc.html`, `SessionTable.dc.html`, `Rail.dc.html`).

## Global Constraints

- Read `.claude/rules/board.md` and `.claude/DESIGN.md` before touching `client/src/**`. CSP: no `<style>` element and no `style=` attribute in markup.
- The rail is the only page switch (DESIGN.md §8.0): no in-page control switches Board ↔ Sessions ↔ Setup.
- No server change, no new poller: every sessions read is `useJiraSessionsContext()`; every board read is `useJiraBoard`.
- The Board view (deck + shelves) renders exactly as today.
- Comments explain _why_, at the repo's existing density. New prose wraps at 160 columns.
- Tests are flat in `test/` (jest). Run only touched suites locally (`pnpm exec jest <files>`), plus `pnpm run typecheck`. CI runs the full suite.
- Commits: one per task, conventional prefix, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `git add <files>` by path, never `-A`.

## Review Focus

1. **Board unusable + `All tickets` off on Sessions** — the List bar (chips, selects, `All tickets`) must still be drawn so the user can turn `All tickets`
   on. Pinned in Task 3.
2. **Badge click while on Setup or Board/List** — lands on Sessions with `Needs you` + `All tickets`, and does not touch the Board page's stored view. Task 1.
3. **A live session only on a folded child** — the top's Session cell shows it; the child never becomes a row. Task 4.
4. **Two live sessions on one card** (needs + working; lost + starting) — the cell names the deck's lead session (`boardAgents` order). Task 4.
5. **Detail write from the Sessions page** — `nudge` re-reads the board list there, as on the Board page. Task 3.

---

### Task 1: `sessions` page in the model, the rail tree and the badge

**Files:**
- Modify: `client/src/lib/jira-page.ts` (type, `JIRA_PAGES`, header comment)
- Modify: `client/src/components/SideRail.tsx` (~L209-222 badge `onClick`; ~L478-490 `RAIL_JIRA_LABEL` + its comment)
- (`JiraView.tsx` needs no edit here: its `page === 'setup' ? … : <Board>` already draws the Board page for `'sessions'` until Task 3.)
- Test: `test/jira-lib.test.ts` (~L597), `test/rail.test.tsx` (~L625-656)

**Interfaces:**
- Produces: `type JiraPage = 'board' | 'sessions' | 'setup'`; `JIRA_PAGES = ['board', 'sessions', 'setup']`; rail label `Sessions`.

- [ ] **Step 1: Tests first.**
  - `jira-lib.test.ts`: `JIRA_PAGES` equals `['board', 'sessions', 'setup']`; `isJiraPage('sessions')` is `true`.
  - `rail.test.tsx`, rename the badge case to "lands on the Sessions page with Needs you and All tickets set": start with page `setup` and stored view
    `board`; after the click, page is `'sessions'`, view is still `'board'`, filters match `{ chip: 'needs-you', allTickets: true }`, `onChange` called once
    with `'jira'`. Add: with view `'list'` stored before the click, it is still `'list'` after (the badge no longer writes the view).
  - `rail.test.tsx`: the open Jira tree's buttons read `Board`, `Sessions`, `Setup` in that order; picking `Sessions` sets the page to `'sessions'`.
  - `rail.test.tsx`: the badge is still a sibling inside the Jira row's `.rail-group` (existing case — keep it passing), and no element under the Jira
    tree's `Sessions` entry carries a count.
- [ ] **Step 2:** `pnpm exec jest test/jira-lib.test.ts test/rail.test.tsx` — the new cases fail.
- [ ] **Step 3: Implement.** Badge: `setJiraPage('sessions')`, `setJiraListFilters({ chip: 'needs-you', allTickets: true })`, `onChange('jira')`,
  close menu; drop `setJiraView` (and its import if now unused). `RAIL_JIRA_LABEL.sessions = 'Sessions'`; update the label comment ("these three pages").
- [ ] **Step 4:** Same command plus `test/jira-setup.test.tsx test/jira-detail.test.tsx test/jira-launch.test.tsx test/jira-sections.test.tsx` (page store
  users) — pass. `pnpm run typecheck` — clean (a `Record<JiraPage, …>` anywhere else that misses `sessions` shows up here; fix it).
- [ ] **Step 5: Commit** `feat(jira): sessions page in the Jira rail tree; the badge opens it`.

### Task 2: One board loader and one picker for both pages

Pure refactor — no behaviour change. The Board page must render byte-for-byte as before.

**Files:**
- Create: `client/src/hooks/usePickedJiraBoard.ts`
- Create: `client/src/components/jira/JiraBoardPicker.tsx` (today's `BoardPicker` from `JiraBoardView.tsx`, moved; same markup, aria and classes)
- Modify: `client/src/components/jira/JiraBoardView.tsx` (consume both)
- Modify: `.claude/rules/board.md` L21 and `client/src/hooks/useDialogEscape.ts` ~L48 (both name the Jira picker's `Popover` composer; it now lives in
  `components/jira/JiraBoardPicker.tsx`)
- Test: `test/jira-board.test.tsx` (existing suite is the regression net)

**Interfaces:**
- Produces: `usePickedJiraBoard(nudge: number): PickedJiraBoard` where `PickedJiraBoard` is
  `{ boards: readonly JiraBoardStatus[]; board: JiraBoardStatus | null; unreadable: string | null; pick: (id: string) => void; list: <useJiraBoard's return>;
  fold: JiraFold; loaded: boolean; shown: JiraBoardStatus | null }`. Semantics exactly today's `JiraBoardView` lines: stored pick under `JIRA_BOARD_KEY`,
  `pickBoard`, `board === null` when `configUnreadable` is set, `loaded = !list.loading && !(list.error && list.issues.length === 0)`, `shown` = the board
  with `polledAt` advanced to the list's when newer (today's `newer()` moves with it). `fold = foldBoard(list.issues)`, memoised on `list.issues`.
- Produces: `JiraBoardPicker({ boards, current, onPick })` — today's `BoardPicker` props; `current` is non-null, so callers draw it only once `board` is.

- [ ] **Step 1:** Run `pnpm exec jest test/jira-board.test.tsx test/jira-list.test.tsx test/jira-detail.test.tsx` — green baseline.
- [ ] **Step 2: Implement** the hook and the picker file; `JiraBoardView` calls them and keeps everything else (filters, deck, shelves, worktrees, band).
  The hook's header comment says why it exists (two pages read one stored pick — spec C4 — and must load it the same way, `nudge` included).
- [ ] **Step 3:** Same command — still green, no test edited. `pnpm run typecheck`.
- [ ] **Step 4: Commit** `refactor(client): one picked-board loader and one picker for the Jira pages`.

### Task 3: `JiraSessionsView` — the Sessions page

Mock: **`SessionsB.dc.html`** (page) with **`SessionTable.dc.html`** (table). The table and its bar are today's `JiraSessionList`, unchanged in look.

**Files:**
- Create: `client/src/components/jira/JiraSessionsView.tsx`
- Modify: `client/src/components/jira/JiraSessionList.tsx` (one new prop, below)
- Modify: `client/src/components/jira/JiraView.tsx` (draw it for `page === 'sessions'`, with the Detail modal and launch sheet beside it; header comment:
  "drawn beside the Board and Sessions pages", three pages)
- Modify: `client/src/components/jira/JiraBoardView.tsx` (the `list` branch no longer draws `JiraSessionList`; Task 4 fills it — until then draw nothing
  but the band in `list`, or land Tasks 3 and 4 together if the reviewer prefers)
- Test: `test/jira-list.test.tsx` (retarget), `test/jira-detail.test.tsx` and `test/jira-launch.test.tsx` (only if a case reaches the List through the
  Board page's `list` view — retarget it to the Sessions page)

**Interfaces:**
- Consumes: `usePickedJiraBoard(nudge)`, `JiraBoardPicker` (Task 2); `JiraPage` `'sessions'` (Task 1).
- Produces: `JiraSessionsView({ onOpenJiraPage, onOpenIssue, onRun, nudge })` — same prop types as `JiraBoardView`.
- `JiraSessionList` gains `unavailable: ReactNode | null`. When non-null **and** `allTickets` is off: the bar and the link-store warning draw as today; the
  table, the `No sessions` line and the foot are replaced by `<div className="board-empty">{unavailable}</div>`. When `allTickets` is on it is ignored. The
  bar's counts read zero in that state (spec: expected).

Behaviour:
- Band: title `Sessions`; sub names the picked board (builder's copy — say only what the page knows; when there is no usable board, say what is wrong:
  the spec's empty-state wording). Right slot: `JiraBoardPicker` when `boards.length > 0` and `unreadable === null`; the search input with
  `aria-label="Search sessions"`, placeholder `search key, summary, repo, branch` (today's list placeholder). No FilterBar, no `JiraViewSwitch`.
- Search text is `useState('')` in this component, passed as `search`.
- `JiraSessionList` always mounts. `issues` = `list.issues` when loaded, else `[]`; `childrenOf` = `fold.childrenOf`. `unavailable` =
  `jira.json cannot be read — <reason>` / `No boards yet` + `Open Setup` chip (`onOpenJiraPage('setup')`) / `loading…` / `board unavailable` — the Board
  page's states, same precedence (unreadable, no board, loading, failed) — else `null`.

- [ ] **Step 1: Tests first** (in `test/jira-list.test.tsx`; `renderList` now sets page `'sessions'` and drops `setJiraView`; every existing case must pass
  unchanged against the new page).
  - "the Sessions page draws its own band: title Sessions, the board picker, `Search sessions`, and no Board | List switch and no Filters button".
  - "with All tickets off and no boards, draws the List bar and `No boards yet` with an Open Setup chip — and turning All tickets on draws the off-board
    rows": status with `boards: []`, a live link on `OFFBOARD-9`; assert `group 'Show'` present, `All tickets` chip present, `No boards yet` text; click
    `All tickets`; assert a row `OFFBOARD-9`.
  - "with All tickets on, the table draws while the board list fails": board issues route returns 500; links on a board key and an off-board key; both rows
    drawn (stubbed from snapshot), no `board unavailable` line in the body.
  - "with All tickets off and the board list failing, the body reads `board unavailable` under the bar".
  - "picking a board on the Sessions page is the Board page's pick": click the picker, pick `Beta`; `localStorage['backlog-manager.jira-board']` is Beta's
    id; switch page to `board` (`setJiraPage`) and the band title is `Beta`.
  - "a row click opens Detail on the Sessions page, and a landed write re-reads the board list": count fetches of `/api/jira/boards/<id>/issues`; open
    Detail from a row; fire `Assign to me` (stub `/api/jira/issue/assign` ok); the count goes up by one without advancing timers.
  - "search is per page: text typed on Sessions is not in the Board page's search after a switch".
  - "a Sessions row's `Run ▾` › a pick opens the launch sheet": an ended row on a ticket with no live run; open `Run ▾`, pick `Work it end to end`; a dialog
    named for the launch sheet (as `test/jira-launch.test.tsx` finds it) is open, hosted by `JiraView`, and Detail is not.
  - In `test/jira-board.test.tsx`: "the FilterBar is drawn in List too" (Filters button present with view `list`) and "the search reads `Search issues` in
    both views" — these pin Step 3's C1 change in this task, not Task 4.
- [ ] **Step 2:** `pnpm exec jest test/jira-list.test.tsx` — the new cases fail.
- [ ] **Step 3: Implement** the page, the prop, the `JiraView` dispatch and the `JiraBoardView` `list` branch removal. The `JiraBoardView` search label
  becomes `Search issues` / `search summaries` in both views, and the FilterBar is drawn in both views (C1) — move its `view === 'board'` guard out now,
  keeping it the one element in one place (the existing comment explains why), and rewrite that comment.
- [ ] **Step 4:** `pnpm exec jest test/jira-list.test.tsx test/jira-board.test.tsx test/jira-detail.test.tsx test/jira-launch.test.tsx test/jira-sections.test.tsx test/rail.test.tsx`
  and `pnpm run typecheck` — green.
- [ ] **Step 5: Commit** `feat(jira): Jira › Sessions page hosts the session table`.

### Task 4: `JiraIssueList` — the issue table on Jira › Board › List

Mock: **`Main.dc.html`** — columns, density, the `N under it` suffix, the status pill. Its indented-child rows and `└` glyph are leftovers of a rejected
option: draw **no** indented rows.

**Files:**
- Modify: `client/src/lib/jira-deck.ts` (two pure helpers)
- Modify: `client/src/lib/jira.ts` (export the rolled-up time `sortTops` already computes, so the column and the sort share one function)
- Create: `client/src/components/jira/JiraIssueList.tsx`
- Modify: `client/src/components/jira/JiraBoardView.tsx` (`list` branch draws it)
- Modify: `client/src/styles.css` (a `.jira-issues-*` family modelled on `.jira-list-*` ~L1430-1460: same scroll box, hairline, row height, header type;
  column widths so 1440 px has no horizontal scroll with the rail open; the box scrolls, the page never does)
- Test: `test/jira-lib.test.ts` (helpers), `test/jira-board.test.tsx` (component)

**Interfaces:**
- Consumes: `foldBoard`, `foldMatches`, `matchesBoardFilters`, `boardAgents` (existing); Task 3's `JiraBoardView` without the session table.
- Produces:
  - `rolledUpdated(top: JiraIssue, under: JiraFold['under']): string | null` in `lib/jira.ts` — the newest parseable `updated` ISO across the top and
    its folded issues, as given; `null` when none parses. `sortTops` parses it (`null` → 0, today's "unparseable is oldest"), so the sort and the column read
    one value. The Updated cell is `elapsedSince(rolled, now)` when non-null, empty otherwise.
  - `topSessionState(agents: readonly DeckEntry[]): Map<string, JiraSessionState>` in `lib/jira-deck.ts` — per `top.key`, the state of the **first**
    entry in the array as given. `boardAgents` already returns entries in `deckOrder` (group, then newest start, then id), so the cell and the deck agree on
    which session leads a card; this helper adds no ordering of its own.
  - `issueCellWord(state: JiraSessionState): string` in `lib/jira-deck.ts` — `plan|permission|reply|answer → 'needs you'`, `working → 'working'`,
    `quiet → 'quiet'`, `lost → 'lost contact'`, `starting → 'starting'`, `ended → ''` (never reached — `boardAgents` drops ended links).
  - `JiraIssueList({ tops, fold, sessions, now, onOpenIssue })` where `tops` is the filtered top list in `sortTops` order and `sessions` the map above.

Behaviour (spec "Jira › Board"):
- One row per kept top (`foldMatches(fold, keep)` keys), all of them, `sortTops` order, no cut. Folded issues are never rows.
- Columns: Session (dot via `listDotTone` + word, or empty) · Key · Summary (+ ` N under it` muted, `N = fold.under.get(key).length`, only when N > 0) ·
  Type (`type.name`) · Status (raw `status.name` in the card's `Pill tone="neutral"`) · Assignee (`name` or `unassigned`) · Sprint (`sprint` or `—`) ·
  Updated (`elapsedSince(rolledUpdated(...), now)` from `lib/item-age.ts`; empty when `null`).
- Row click (anywhere but a link) → `onOpenIssue(top, fold.childrenOf)`. The Session cell is not a link. Each row carries `data-key`.
- No rows after filters → `board-empty` line `No issues match` (or `No issues` when no filter or search is applied — builder may reuse the Board's own empty
  wording if it has one; pick one and test it).

- [ ] **Step 1: Tests first.**
  - `jira-lib.test.ts` `topSessionState`, fed **through `boardAgents`** (a fold + payload, not hand-ordered entries): top A with `working` on itself
    and `plan` on its child → A `plan`; top B with `lost` started 10:00 and `starting` (a status reservation) at 10:05 on its child → B `starting` (newest
    start leads inside `other`, `deckOrder`'s rule); no live links → empty map; A and B in one call stay apart.
  - `jira-lib.test.ts` `issueCellWord`: each of the nine states except `ended` maps to its word above.
  - `jira-lib.test.ts` `rolledUpdated`: top updated 5 d ago with a child updated 1 d ago → the child's ISO string; no children → its own; top
    unparseable with a parseable child → the child's; nothing parseable → `null`. Existing `sortTops` cases stay green unedited.
  - `jira-board.test.tsx`, new `describe('the issue List')` using the `GROUP` fold fixture (~L534-575), `setJiraView('list')`:
    - "draws one row per top and no folded issue, in `sortTops` order": row `data-key`s equal `['PAY-120', 'PAY-180', 'PAY-190']` (the fixture's
      `sortTops(fold.tops, fold.under)`), and no folded key is a row. Plus a case where an In Progress or Done top is the newest, so the List's order
      differs from the Board's column order — the List puts it first.
    - "names how many issues fold under a top": `PAY-120` row reads `<fold.under.get('PAY-120').length> under it` — the whole fold, so pick a fixture top
      whose under count differs from its direct-children count and assert the under count; a top with exactly one folded issue reads `1 under it`; a top
      with none has no suffix.
    - "a session live only on a folded child marks its top": link `working` on a child of `PAY-120`; the `PAY-120` row's Session cell reads `working`;
      no row has the child's key.
    - "the deck's lead session names the card": `working` on the top and `answer` on its child → `needs you`, and the deck (Board view) leads that card
      with the same session.
    - "keeps a top whose folded issue matches the search" (F1 parity): search a grandchild's summary; the top's row is drawn.
    - "the FilterBar filters the List's rows": assignee `me` leaves only my tops.
    - "Updated reads the rolled-up time": a top 5 d old with a child 1 d old reads `1d` (whatever `elapsedSince` prints for 1 day — assert against
      `elapsedSince` called with the same instant).
    - "a row click opens the modal with the fold": same assertion as the card-click case (~L621).
- [ ] **Step 2:** `pnpm exec jest test/jira-lib.test.ts test/jira-board.test.tsx` — fail.
- [ ] **Step 3: Implement** helpers, component, styles, wiring.
- [ ] **Step 4:** Same command + `test/design-guards.test.ts test/csp.test.ts test/filter-bar.test.tsx`, `pnpm run typecheck` — green.
- [ ] **Step 5: Commit** `feat(jira): Jira › Board › List is an issue table`.

### Task 5: Docs and rules follow the new shape

**Files:** `.claude/rules/board.md` (L56-63: "three pages", `JIRA_PAGES` (`board | sessions | setup`), where the modal is drawn), `.claude/DESIGN.md`
§8.0 (Jira sub-nav list), §8.9 and §8.9.1 (view switch paragraph: List = issue table; new paragraph for Sessions), `docs/subsystems/invariants.md`
(§ "The Jira section's two pages…"), `docs/subsystems/jira.md` (rail entry's pages, `backlog-manager.jira-page` values, `JIRA_PAGES`, the List),
`docs/subsystems/board.md` (Jira pages), code comments in `lib/jira-view.ts` (List is issues now) and `hooks/useJiraListFilters.ts` (filters belong to
the Sessions page). Edit only the sentences that are now false; do not reflow neighbours.

- [ ] **Step 1:** `grep -rn "two pages\|board | setup\|Board.*List.*session\|jira-view" .claude docs/subsystems client/src/lib/jira-view.ts client/src/hooks/useJiraListFilters.ts`
  — every hit that describes the old shape is in the edit list.
- [ ] **Step 2:** Edit. Re-run the grep; no stale hit remains.
- [ ] **Step 3:** `pnpm exec jest test/design-guards.test.ts` (it reads DESIGN.md) — green.
- [ ] **Step 4: Commit** `docs(jira): the Sessions page and the issue List in the rules and docs`.

### Task 6: `/ui-verify` against the mocks

- [ ] Invoke `/ui-verify` with the mocks `Main.dc.html` (Jira › Board › List) and `SessionsB.dc.html` (Jira › Sessions) at 1440 px, light theme, with
  fixture data that has live and ended sessions and a top with folded issues. Record: screenshots side by side, `document.documentElement.scrollWidth`
  vs `clientWidth` (no horizontal page overflow) on both pages, and the Board view unchanged against `main`. Start any server by recorded pid and kill only
  that pid.
- [ ] Fix defects on the branch, one commit each; re-shoot.
