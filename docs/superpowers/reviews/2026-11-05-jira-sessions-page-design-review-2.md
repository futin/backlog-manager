# Review 2 — `docs/superpowers/specs/2026-11-05-jira-sessions-page-design.md`

Reviewer: Fable 5.1 subagent, 2026-11-05, under an autopilot run. Round 2: the whole document re-read against the code at HEAD `6eb855e8` (this worktree,
`.worktrees/jira-sessions-page`), round 1's report (`2026-11-05-jira-sessions-page-design-review-1.md`) and the edits made for it (`git diff HEAD~1 --
docs/superpowers/specs/`). Checklist: facts vs code, internal consistency, edge cases, copy vs mocks, scope, hard rules (CLAUDE.md, `.claude/rules/board.md`).
Every code claim below was checked by a narrow read of the file cited; spec line numbers are the current document's.

## Verdict: APPROVE WITH FIXES

No Critical finding. Round 1's seven Important findings are fixed in the text and the fixes are true to the code: the Session cell's vocabulary (L62-65)
now matches `JiraSessionState` and `needsYou` (`shared/jira-sessions.ts:7,36-38`) and `listDotTone` (`client/src/lib/jira-list.ts:276-282`); the bar-over-
every-state rule (L81) closes the unreachable-`All tickets` hole; the five-filter store (L88-90) matches `clean` in `client/src/hooks/useJiraListFilters.ts`;
`nudge` (L91-92) is `useJiraBoard`'s third parameter (`client/src/hooks/useJiraBoard.ts:55`); the suite list (L109-112) names real files; #458 is on `main`;
the docs list (L114-118) now carries `board.md`'s Jira mechanism and the three code comments. What is left: one guard the suite list still misses, two
places where the builder must guess (the live-dot roll-up's home and tie-break, and how a bar that lives inside `JiraSessionList` is drawn without the
table), and one undefined number in D3.

## Important

- **[I] spec:109-112 — the suite list misses the one guard that goes red the moment `JIRA_PAGES` gains `'sessions'`: `test/jira-lib.test.ts:597`
  `expect(JIRA_PAGES).toEqual(['board', 'setup'])`. The spec's own instruction (L111-112, "`grep -l` in `test/` for every shared hook the new page adds a
  caller of") would not surface it, because `JIRA_PAGES` is a value this change EDITS, not a hook it adds a caller of. The same file also pins `sortTops`
  (L755-770), which C9 touches if the rolled-up `updated` is exported from it.** → Add `test/jira-lib.test.ts` to the list (naming L597), and widen the
  grep instruction to "every symbol the diff changes or adds a caller of" (`test/jira-setup.test.tsx:10-12` and `test/jira-detail.test.tsx:14` import
  `useJiraPage` / `jira-page` too and belong in the scoped run).

- **[I] spec:62-65 (C2) — the roll-up the Session cell needs already exists and sorts differently from the spec's tie-break. `boardAgents`
  (`client/src/lib/jira-deck.ts:71-109`) maps every live link and Starting reservation on a top OR on anything folded under it to `{ issue, top }` and sorts
  by `deckOrder` (`jira-deck.ts:63-65`: group rank, then NEWEST `startedAt`, then id). The spec does not name it, and its within-`other` rule ("`lost`
  before `starting`") contradicts `deckOrder`, which inside `other` puts the newer start first regardless of state. A builder who reads the first
  `boardAgents` entry per top key — the obvious one-home-in-`lib/` implementation (`.claude/rules/board.md`, "Every derivation has one home in `lib/`") —
  ships a different winner than the spec says for a fold with a `lost` link and a newer `starting` reservation; a builder who follows the spec writes a
  second roll-up.** → Say the cell is "the first `boardAgents(fold, sessions, live)` entry whose `top.key` is the row's, in `deckOrder`" and drop the
  `lost`-before-`starting` clause (or, if that tie-break is wanted, say a new comparator in `lib/jira-deck.ts` is needed and that `deckOrder` is not it, and
  name a test case: a top with a `lost` link started 10:00 and a `starting` reservation at 10:05 reads `lost contact`).

- **[I] spec:73,77,81 — the three lines cannot all hold as written. L73 hosts "today's `JiraSessionList` unchanged", L77 says "the List's own bar as
  today", and L81 says the bar is drawn in every state above a body that swaps to the Board page's empty lines. The bar is markup INSIDE `JiraSessionList`
  (`client/src/components/jira/JiraSessionList.tsx:96-128`), a component that returns bar + link-store warning + table in one element and requires
  `issues` and a non-null `childrenOf` (L71-74). To draw the bar over `board unavailable` / `No boards yet` the builder must either lift the bar into a
  component of its own, or give `JiraSessionList` a body-override prop, or mount it with empty inputs (which draws `No sessions`, not the Board page's
  line). The spec says none of these. Also unstated: what the bar's chip counts and selects read in that state — with `All tickets` off and no board,
  `buildListRows` keeps no row (`client/src/lib/jira-list.ts:136-137`), so the chips read `All 0 · Needs you 0 · Working 0 · Ended 0` and the Repo/Run
  selects offer only `All repos` / `Any run` beside the empty line.** → Name the split (recommend: the bar becomes its own component, `JiraSessionList`
  keeps the warning + table, and L73's "unchanged" becomes "unchanged in behaviour; its bar is lifted out so the page can draw it alone"), and state the
  zero-count bar as the expected rendering of that state so the build's reviewer does not flag it.

- **[I] spec:44 (D3) — `N under it` has two candidate values and the spec picks neither. For a top that folds others, `foldBoard` gives both
  `childrenOf.get(key)` (direct children on the board) and `under.get(key)` (everything folded, every depth) (`client/src/lib/jira.ts:212-269`); the
  Board card draws both numbers through `cardFold` → `childrenLine` as `C children · D below them` (`jira.ts:300-316,391-396`). The mock (`Main.dc.html`,
  `3 under it`) does not say which. A builder must guess, and the two differ exactly when a sub-task has children of its own.** → Define N (recommend:
  `under.get(key).length`, everything folded, since D3's own sentence says "when the card folds others" and the row's modal reaches all of them), say
  `N under it` is new copy with its home beside `childrenLine` in `lib/jira.ts`, and give the singular (`1 under it`).

## Minor (do not block)

- spec:56 and 45 — "the summary search" / placeholder `search summaries`: the Board's search matches KEY or summary (`client/src/lib/jira.ts:660-661`), so
  the issue List's search also matches keys. Say "the Board's search (key or summary)" so a builder does not narrow it to summary to match the placeholder.
- spec:56 vs `Main.dc.html` — the mock's search box is `placeholder="Search issues"` with no separate label; the code's is `aria-label="Search issues"`,
  `placeholder="search summaries"` (`JiraBoardView.tsx:193-194`). The spec takes the code's words, which is right; call the mock difference out (checklist 4).
- spec:97 vs `Rail.dc.html` — the mock draws `Board · Sessions · Setup` and NO badge on the Jira row (47 lines, no `rail-badge`); the spec keeps the badge
  there. Say the mock omits it on purpose so `/ui-verify` does not read the missing badge as a regression.
- spec:77-78 — still "as today" with no explicit "where the mock and today's table differ in copy, today's table wins" (round 1 Minor, unchanged).
  `SessionTable.dc.html` says `Resume` (code: `Reopen`) and `needs you · permission` (code: `STATE_LABEL` words); `SessionsB.dc.html` draws the window as
  chips and `Repo: any ▾` (code: `Select`s labelled `Repo` / `Run` / `Ended within`, `JiraSessionList.tsx:107-124`).
- spec:67 / C9 — the Updated cell's FORMAT is still unstated (round 1 Minor, unchanged); the mock's `4m` / `1h` / `2w` is the card's `cardAgeStamp` shape.
  And `sortTops` computes the rolled-up key inline (`jira.ts:278`) under a comment that says "The sort key is never drawn" (`jira.ts:275`): C9 needs that
  key exported from `lib/jira.ts` (one home) and the comment changed.
- spec:85 — "the picker is drawn only when there are boards" (round 1 Minor, unchanged): `JiraBoardView` also drops it while `configUnreadable` is set
  (`JiraBoardView.tsx:124,162`); say "as `JiraBoardView` decides today".
- spec:69 and 82-83 — the Board page's `No boards yet` line carries an `Open Setup` chip that calls `onOpenJiraPage('setup')` (`JiraBoardView.tsx:168-170`).
  If the Sessions page "reads as the Board page does", it needs `onOpenJiraPage` threaded from `JiraView` as `JiraBoardView` has it (`JiraView.tsx:91`);
  the page's props list (L73-92) never names it.
- spec:59 — the F1 ring marker (`1 match: PAY-162`, the Board card's "why is this here" for a top kept by a folded match, `jira.ts:318-336`) is not
  among D3's columns; say the issue List draws no marker (or where it goes), since D4 keeps such tops.
- spec:114-118 — `hooks/useJiraView.ts:6-7` ("the rail badge's click (C4 sets page `board` and view `list`)") and `JiraBoardView.tsx:198-200` (the
  FilterBar-is-Board-only comment C1 reverses) are two more comments that state the old shape and are not in the list.
- spec:116-117 — `.claude/rules/board.md`'s last rule ("Every component cites its `.claude/DESIGN.md` subsection") means the new page and the issue List
  need a subsection to cite; the list names §8.9.1 edits but not that a Sessions subsection (§8.9.x) is added. Not guarded by `test/design-guards.test.ts`
  (no citation guard there), so a plan-level note is enough.
- spec:98 — "the Sessions tree entry carries no count": fine, but `useJiraNeedsYou` returns `null` while the dashboard is unreachable and the rail keeps the
  last count (`client/src/hooks/useJiraNeedsYou.ts:8,18-19`), so a stale badge can land on a Sessions page whose `Needs you` chip reads 0. Today's List has
  the same gap; worth one sentence that it is accepted.

## Checked and found correct (for the record)

- Session-state words: `needsYou` is exactly `plan | permission | reply | answer` (`shared/jira-sessions.ts:36-38`); `deckGroup` ranks
  `needs, working, quiet, other` (`client/src/lib/jira-deck.ts:24-32`); `listDotTone` gives `quiet` and `starting` the same `paused` fill and `lost`
  `crashed` (`jira-list.ts:276-282`) — the spec's "one word per state" over a shared fill is consistent.
- `ListFilters` is `{chip, repo, run, window, allTickets}` and nothing else (`useJiraListFilters.ts:26-34`); the search is `JiraBoardView`'s per-mount
  `filters.search` (`JiraBoardView.tsx:130,195`).
- `useJiraBoard(id, interval, nudge)` (`useJiraBoard.ts:55`); a `null` id "reads as empty and not loading" (header), so with no board and `All tickets` on
  the table draws at once (C8 holds).
- `JiraView` hosts `JiraDetail` and `JiraLaunchSheet` beside `JiraBoardView` only and bumps `nudge` from `onWrote` (`JiraView.tsx:72,85-110`).
- The badge handler is `setJiraPage('board'); setJiraView('list'); setJiraListFilters({chip:'needs-you', allTickets:true}); onChange('jira')`
  (`SideRail.tsx:214-219`), drawn only while `needsYouCount > 0` (L209); `test/rail.test.tsx:637-655` asserts the old triple.
- `JIRA_PAGES = ['board', 'setup']`, order is the tree's (`client/src/lib/jira-page.ts:12-15`); `JIRA_VIEWS = ['board', 'list']` (`lib/jira-view.ts:14-16`).
- `SHELF_LIMIT {todo:8, doing:8, done:3}` (`jira-deck.ts:136`); FilterBar is `Type · Assignee · Sprint`, gated `view === 'board'` (`JiraBoardView.tsx:201-223`).
- `buildListRows` scopes on `board.has(key)` unless `allTickets`, and stubs off-board rows from the link snapshot (`jira-list.ts:136-148`).
- Docs anchors cited at L114-118 exist: `docs/subsystems/invariants.md:3354`, `docs/subsystems/jira.md:9,43,275`, `docs/subsystems/board.md:61`,
  `.claude/DESIGN.md:180` (§8.0), `:439` (§8.9), `:443` (§8.9.1); old spec `2026-11-03` §7.1 L207, §7.2 L220, C4 L90, C7 L100 as cited at L4-5.
- Mocks: `Main.dc.html` draws the eight D3 columns and no `+ N more`; `SessionsB.dc.html` draws `Search sessions`, the four chips, `All tickets` and the
  four windows; `Rail.dc.html` draws `Board · Sessions · Setup` (D6).
- Hard rules: no inline `<style>`/`style=` in the spec; the picker's `Popover` composer move is named for `board.md`'s exact set; the sessions answer stays
  the one `JiraSessionsContext`; the rail stays the only page switch (C7 keeps the live dot a non-link).
