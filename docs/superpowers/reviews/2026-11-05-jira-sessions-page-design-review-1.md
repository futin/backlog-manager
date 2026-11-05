# Review 1 — `docs/superpowers/specs/2026-11-05-jira-sessions-page-design.md`

Reviewer: Fable 5.1 subagent, 2026-11-05, under an autopilot run. Checklist: facts vs code, internal consistency, edge cases, copy vs mocks, scope, hard
rules (CLAUDE.md + `.claude/rules/board.md`). Every code claim was checked by a narrow read of the file cited; line numbers are this worktree's
(`.worktrees/jira-sessions-page`, HEAD `33bd6aa8`).

## Verdict: APPROVE WITH FIXES

No Critical finding. The shape is sound and matches the code it builds on: `JIRA_PAGES` is a module store that the rail and threaded links already write,
`JiraSessionList` already takes `issues` + `childrenOf` and scopes/stubs from them, `useJiraListFilters` is already a module store, the badge handler already
sets page + view + filters in one place, and `useJiraBoard` is built on `useCoalescedFetch` so a second mount does not violate the poller rule. The fixes
below are stated facts that are false or stale, requirements the builder cannot resolve from the text, and a docs list that misses the rule file whose
mechanism the spec changes.

## Important

- **[I] spec:104-105 — "Peer work in flight: branch `fix/jira-list-row-opens` … Whichever lands second rebases" is stale: that branch is PR #458, merged
  2026-11-04 (`gh pr list --head fix/jira-list-row-opens --state all` → MERGED), and this worktree's base already carries it (`main` and this HEAD both have
  `rowOpens` in `client/src/components/jira/JiraSessionList.tsx:53,228,269`; `git log main -- JiraSessionList.tsx` → `4fab7273 feat(jira): a click anywhere on
  a List row opens Detail (#458)`).** → Replace the constraint with "row-click-opens-Detail (#458) is already on `main`; the moved table keeps it", and
  delete the rebase instruction so the builder does not go looking for a branch to rebase onto.

- **[I] spec:62-64 — the Session cell's vocabulary is incomplete and ambiguous. `DeckGroup` has four live groups — `needs | working | quiet | other`
  (`client/src/lib/jira-deck.ts:23-33`) — and the spec names words for `needs` ("needs you"), `working`, and "starting / lost" (both `other`), but not
  `quiet` (a live state: `shared/jira-sessions.ts:41-51` `STATE_LABEL.quiet = 'Quiet'`; `deckGroup` ranks it third). "In the deck's vocabulary" is also two
  vocabularies: the deck's STRIPS say `Waiting for permission`, `Working`, `Quiet`, `Lost contact` (`STATE_LABEL`), while only the deck's TALLY says
  `N need you` / `N working` (`client/src/components/jira/JiraAgentDeck.tsx:40-41`). And the tie inside `other` (a `starting` and a `lost` session on the same
  fold) has no rule — `deckGroup`'s order ranks groups, not states.** → Enumerate the four cells: word + fill for `needs`, `working`, `quiet`, `other`
  (give `other` one word per state, `starting` / `lost`), and state the within-group tie-break (suggest: `starting` over `lost`, as it is the one still
  becoming live; or the newest `updated`). Say the dot tone reuses `listDotTone` (`client/src/lib/jira-list.ts:276-282`) so the issue List's dot and the
  Sessions table's dot are the same fill for the same state.

- **[I] spec:79-82 (C8) — with `All tickets` OFF and the board absent/unavailable/unreadable, "reads as the Board page does" means drawing
  `JiraBoardView`'s empty states (`client/src/components/jira/JiraBoardView.tsx:162-178`: `jira.json cannot be read — …`, `No boards yet` + `Open Setup`,
  `board unavailable`), which draw NO `JiraSessionList` — and the `All tickets` chip lives inside `JiraSessionList`'s own bar
  (`client/src/components/jira/JiraSessionList.tsx` ~L95-118). So from those states the user cannot turn `All tickets` on; the only route to "what needs
  me" is the rail badge, which exists only while the count is > 0 (`client/src/hooks/useJiraNeedsYou.ts`). A fresh install with no boards and three
  ended sessions is unreachable.** → State that the Sessions page draws the List's bar (chips, selects, `All tickets`) ABOVE the Board-page empty line in
  every state, and only the table swaps for the empty line; or state explicitly that `All tickets` is unreachable there and the badge is the sole route (then
  C8's "must not wait on a board read" is only half-true and should say so).

- **[I] spec:85 — "Filters stay `useJiraListFilters`' module store, so they survive a page switch as they survive a view switch today" overstates what the
  store holds. `ListFilters` is `{chip, repo, run, window, allTickets}` (`client/src/hooks/useJiraListFilters.ts`); the search text is NOT in it — today it is
  `JiraBoardView`'s per-mount `filters.search` (`JiraBoardView.tsx:130,193-195`), passed to `JiraSessionList` as the `search` prop. A new page component
  has no search state until the builder invents one, and L74 only names the box's label.** → Say where the Sessions search text lives (recommend: per-mount
  `useState` on the new page component, cleared on page switch, matching the Board page's search today), and amend L85 to "the five list filters".

- **[I] spec:77-78 and 83 — the Sessions page must thread `JiraView`'s `nudge` into its board load. `JiraView` holds `nudge`
  (`client/src/components/jira/JiraView.tsx:72`) and bumps it from `JiraDetail`'s `onWrote` (L91), and `JiraBoardView` passes it as `useJiraBoard`'s third
  argument (`JiraBoardView.tsx:126`) so a link write re-reads the board. The spec says Detail opens from Sessions (L83) and the page "loads the picked board
  the way the Board page does" (L78), but never names `nudge`; a page that calls `useJiraBoard(id, interval)` without it stubs a just-linked ticket from
  its link snapshot until the next 15 s poll.** → Add: "the page takes `JiraView`'s `nudge` and passes it to its board load, as `JiraBoardView` does (L126)".

- **[I] spec:102-103 — "`test/` source guards count callers of shared hooks (e.g. `useJiraSessionsContext`, poll hooks)" names a guard that does not
  exist: no file under `test/` contains the string `useJiraSessionsContext` (`grep -rl useJiraSessionsContext test/` → none). The suites this change
  actually touches are `test/rail.test.tsx` (the badge click asserts page `board` + view `list` + the two filters), `test/jira-list.test.tsx` (mounts
  `JiraView` with `setJiraPage`/`setJiraView` and reads the session table), `test/jira-board.test.tsx` (`JiraBoardView` + `JiraView`),
  `test/jira-view-store.test.tsx` (`JIRA_VIEWS`), `test/filter-bar.test.tsx`, `test/use-jira.test.tsx` (`useJiraBoard`), and `test/design-guards.test.ts`
  / `test/csp.test.ts` if markup or styles move.** → Replace the example with that list so the scoped run (CLAUDE.md, "Touched includes the source
  guards") is right first time; keep the `grep -l <symbol> test/` instruction.

- **[I] spec:106-107 — the docs-that-must-follow list omits the rule file whose MECHANISM this spec changes. `.claude/rules/board.md:56-63` says "The Jira
  section's two pages … The page is `JIRA_PAGES` (`board | setup`)" and L21 places the Jira picker's `Popover` composer in `components/jira/JiraBoardView.tsx`
  (a shared picker drawn by two pages moves or gains a second composer, and that list is an exact set the Escape rule reasons over). Also stale after
  this ships: `docs/subsystems/invariants.md:3354-3356` (heading "The Jira section's two pages…"), `docs/subsystems/jira.md:9,43,275` ("two pages",
  `board | setup`, `JIRA_PAGES`), `docs/subsystems/board.md:61` ("Jira (Board, Setup)"), `.claude/DESIGN.md:439` (§8.9 "a Board/Setup tree that is its
  only page switch") and §8.0's rail paragraph, plus the code comments that assert the old shape: `client/src/lib/jira-view.ts:6` ("NOT a third
  `JIRA_PAGES` entry: the rail's Jira tree stays `Board` / `Setup`"), `client/src/hooks/useJiraListFilters.ts:9-10` (badge "flips the view in the same
  handler"), `client/src/components/SideRail.tsx:480-486` (`RAIL_JIRA_LABEL` "only labels these two pages have"). CLAUDE.md: every `.claude/rules/` file is
  the one home of its rules' mechanism, and `board.md` is injected on every `client/src/**` read.** → List `board.md` L56-63 and L21, `invariants.md`
  L3354, `jira.md`, `board.md` (subsystem) L61, DESIGN §8.0 + §8.9, and the three code comments, as docs the plan must carry.

## Minor (do not block)

- spec:82 "the picker is drawn only when there are boards" — `JiraBoardView.tsx:124,162` also drops the picker when `configUnreadable` is set
  (`server/src/jira/poller.service.ts:337`, `boards: []` on unreadable), so the condition is "boards AND readable"; the Board-page empty states already
  encode this, say "as `JiraBoardView` decides today".
- spec:33 vs D2 (L43): an anti-goal says no sub-tasks as rows, D2 says one row per `foldBoard(...).tops`. A sub-task whose parent is off the board IS a
  top (`client/src/lib/jira.ts:212-275`, parent off-board ⇒ top), so some sub-tasks are rows. Not a contradiction in behaviour (that is what the Board
  draws as a card too) but the anti-goal should say "no FOLDED sub-task as a row" so a reviewer of the build does not flag an orphan sub-task row as a
  failure.
- spec:49-50 "removed from the mocks so nothing builds from them" — `Main.dc.html` still carries the rejected indent option's code (`r[8]`, `'└ '`,
  `indentStyle`, `rowStyle`, every row at depth 0). It renders nothing, but a builder reading the mock source sees an indent mechanism; a one-line note
  ("dead indent code in `Main.dc.html` is not spec") or deleting it closes that.
- spec:72-76 — mock-vs-code copy differences are not called out (checklist 4). `SessionsB.dc.html` draws the window as chips `24 h / 7 d / 30 d / All`,
  `Repo: any ▾`, `Run: any ▾`, and `All tickets (off = this board only)`; the code draws a `Select` labelled `Ended within` with options `Ended: 24 h …
  Ended: all time`, `All repos`, `Any run`, and a chip `All tickets` with a title tooltip (`JiraSessionList.tsx` ~L95-118). `SessionTable.dc.html` says
  `Resume` for ended rows where the code says `Reopen`, and `needs you · permission` where the code draws `STATE_LABEL` words. L75-76 says "as today",
  which wins, but say so explicitly: "where the mock and today's table differ in copy, today's table wins".
- spec:44 `N under it` is a new phrase; `cardFold`/`childrenLine` (`client/src/lib/jira.ts:300-316`) is the Board's existing children copy. Either cite
  that helper as the source of the Summary suffix (one home in `lib/`, `board.md` L167) or say it is new copy and name its home.
- spec:65-66 / C9 — `sortTops`'s own comment says "The sort key is never drawn" (`client/src/lib/jira.ts:277-281`); C9 reverses that deliberately, so the
  plan should update that comment. The Updated cell's format (the mock's relative `4m` / `1h` / `2w`) is unstated — name the helper (the session table's
  relative-time formatter) so the two tables agree.
- spec:72 — the mock band sub `17 issues · 9 cards · read 12 s ago` (Main) and `Payments Q4 · 3 live · read 4 s ago` (SessionsB): the Board page's sub is
  `bandSub` (`client/src/lib/jira.ts:441-456`). The spec leaves Sessions' sub to the builder (L114), fine; but say the Board page's sub is `bandSub`
  unchanged so the Main mock's wording is not taken as a change.
- spec:89-91 — the badge handler today is `setJiraPage('board'); setJiraView('list'); setJiraListFilters({chip:'needs-you', allTickets:true}); onChange('jira')`
  (`SideRail.tsx:209-224`). The spec says it "no longer touches the Board page's view" — correct intent; note that `test/rail.test.tsx` asserts the old
  triple and must flip to `page === 'sessions'` with no `setJiraView` call.
- spec:95-96 — `useJiraView`'s header (`client/src/hooks/useJiraView.ts:7`) and `jira-view.ts:6` both describe List as "the session table"; they belong in
  the L106 docs list (covered by the Important finding above).
- spec:115-116 — "the Board view's render is unchanged" as a test: say how (snapshot of the deck + shelves DOM for a fixture, or the existing
  `test/jira-board.test.tsx` assertions kept green), otherwise it is not a test case.
- spec:117-118 — `/ui-verify` with "fixture data for sessions": the Sessions page under `All tickets` on also needs an off-board stubbed row in the fixture,
  since that is the C8 path the shot should prove.

## Checked and found correct (for the record)

- `JiraPage` / `JIRA_PAGES` are `'board' | 'setup'` in `client/src/lib/jira-page.ts:12-15`; a third entry is a one-line type + array change and
  `isJiraPage` follows.
- `JiraSessionList` props are `issues, search, now, childrenOf, onOpenIssue, onRun` — `childrenOf` non-null — so the page must load a board (L77 is true).
- `useJiraBoard` is built on `useCoalescedFetch` (`board.md` L164 says so explicitly), so a second mount on another page is its own instance and the
  poller rule holds; the sessions answer is the one `JiraSessionsProvider` (anti-goal L35 holds by construction).
- `foldBoard`, `sortTops`, `foldMatches`, `deckGroup`, `SHELF_LIMIT {todo:8, doing:8, done:3}` all exist as cited.
- Search label/placeholder are switched by view at `JiraBoardView.tsx:193-194`; FilterBar is gated `view === 'board'` at L201 — C1 describes the code.
- `backlog-manager.jira-board` is `JIRA_BOARD_KEY` (`client/src/lib/jira.ts:568`) read through `usePersistedState` + `pickBoard` (L580-586); sharing it
  between two pages needs no new store (C4 holds).
- CSP: no inline `<style>` / `style=` in the spec; the mocks' `indentStyle`/`rowStyle` are the one place a `style=` could leak into the build (Minor above).
