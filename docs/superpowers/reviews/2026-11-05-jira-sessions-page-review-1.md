# Plan review 1 — `docs/superpowers/plans/2026-11-05-jira-sessions-page.md`

Reviewed against `docs/superpowers/specs/2026-11-05-jira-sessions-page-design.md` on 2026-11-05, in the `jira-sessions-page` worktree at `c1971a8a`.
Every claim below was checked by reading the cited code; nothing was taken from the plan's description of it.

**Verdict: APPROVE WITH FIXES.** No Critical findings. Four Important ones: one test in Task 4 asserts a relation the code does not guarantee (it passes
on the GROUP fixture by coincidence), one interface in Task 4 leaves a ms → ISO conversion to a guess whose obvious answer prints garbage, one spec
requirement (launch sheet from the Sessions page) has no test, and one comment that Task 2 makes false is in no task's edit list.

## 1. Coverage — spec section → task

| Spec section / line | Task |
| --- | --- |
| What changes (L15-17), Goals 1-3 (L21-23) | Tasks 1, 3, 4 |
| Anti-goal: sub-tasks as rows (L33) | Task 4 "draws one row per top and no folded issue", "a session live only on a folded child" |
| Anti-goal: second poller (L35) | Global constraint (plan L26); `JiraSessionList` reads `useJiraSessionsContext` already (`JiraSessionList.tsx:87-90`) |
| Anti-goal: picker remembering a different board (L36) | Task 2 hook over `JIRA_BOARD_KEY`; Task 3 test "picking a board on the Sessions page is the Board page's pick" |
| D1 Board view unchanged (L42) | Task 2 regression net (`test/jira-board.test.tsx`), Task 6 shot vs `main` |
| D2 one row per top (L43) | Task 4 |
| D3 columns + row click with `childrenOf` (L44) | Task 4 columns list (plan L175-178), "a row click opens the modal with the fold" |
| D4 filters + search via `foldMatches` (L45) | Task 4 "keeps a top whose folded issue matches the search", "the FilterBar is drawn in List and filters the rows" |
| D5 Sessions = option B with picker and `All tickets` (L46) | Task 3 |
| D6 rail order (L47) | Task 1 (`JIRA_PAGES` order test, tree-buttons test) |
| Jira › Board: FilterBar both views, search label both views (L56-57) | Task 3 Step 3 (implementation), Task 4 tests (see Minor 7 — the test lands a task late) |
| List view: every top, no cut, `sortTops` order (L59-61) | Task 4 behaviour L174; test "draws one row per top…" (see Important 1) |
| Session cell: roll-up, words, `listDotTone`, first `boardAgents` entry, display only (L62-66) | Task 4 helpers `topSessionState`, `issueCellWord`; tests for both; "not a link" in behaviour L178 |
| `N under it` over the whole fold, singular, no suffix at 0 (L67-68) | Task 4 "names how many issues fold under a top" |
| Updated = rolled-up time (L69-70) | Task 4 `rolledUpdatedMs` + "Updated reads the rolled-up time" (see Important 2) |
| Loading/unavailable states on Board (L71) | untouched on the Board page (the `list` branch sits under `loaded`, `JiraBoardView.tsx:227-247`) |
| Sessions page: own page, `JiraPage` gains `'sessions'` (L75) | Tasks 1, 3 |
| Band title/sub/picker/search, no FilterBar (L76-78) | Task 3 behaviour L117-119, test "the Sessions page draws its own band…" |
| List bar + table + warning + Detail + `Run ▾` (L79-80) | Task 3 (`JiraSessionList` mounted whole); existing `jira-list` cases retargeted |
| Loads the picked board like the Board page (L81-82) | Task 2 hook, Task 3 consumes |
| Bar in every state, `unavailable` prop, counts read zero (L83-86) | Task 3 interface L112-114, tests "with All tickets off and no boards…", "…board list failing…" |
| Empty/failure states off vs on (L87-90) | Task 3 behaviour L121-123, tests L128-133 |
| Detail modal and launch sheet from Sessions (L91-92) | Detail: Task 3 test L136-137. **Launch sheet: no test — Important 3** |
| Filters stay the module store; search per mount (L93-95) | Task 3 behaviour L120, test "search is per page…" |
| `nudge` handed to the board load (L96-97) | Task 2 hook signature, Task 3 test "…a landed write re-reads the board list" |
| Rail badge (L101-103) | Task 1 tests (page, view untouched, filters, no count on the Sessions entry) |
| Stored view, C5 (L107-108) | nothing to build; no task needed |
| Constraints: rules, CSP, suites to run (L112-119) | plan L24-29; Task 4 Step 4 runs `design-guards`, `csp`, `filter-bar`. `jira-view-store` and `use-jira` never run (Minor 10) |
| Docs and comments (L121-125) | Task 5 (+ Task 1 for the `SideRail` label comment, Task 2 for board.md L21). `useDialogEscape.ts:48` missing — Important 4 |
| Builder's calls C1-C9 (L140-148) | C1 Task 3/4; C2 Task 4 `topSessionState`; C3 Task 4 L174; C4 Task 2; C5 none needed; C6 Task 1; C7 Task 4 L178; C8 Task 3 L131-132; C9 Task 4 |
| `/ui-verify` last (L135-136) | Task 6 |

Spec test cases named at L133-134 (never a folded row; fold match keeps its top; badge lands with both filters; Board view unchanged; `JIRA_PAGES`
order) each have a task: Task 4, Task 4, Task 1, Task 2/6, Task 1.

## 2. Values

All copy and expected values in the plan match the spec and the code: rail label `Sessions`; badge filters `{ chip: 'needs-you', allTickets: true }`
(`client/src/hooks/useJiraListFilters.ts:9`, `SideRail.tsx:217`); `Search sessions` / `search key, summary, repo, branch` and `Search issues` /
`search summaries` (`JiraBoardView.tsx:193-194`); `jira.json cannot be read — `, `No boards yet`, `Open Setup`, `loading…`, `board unavailable`
(`JiraBoardView.tsx:167-172, 246`); `board-empty` class; `backlog-manager.jira-board` (`lib/jira.ts:568`); state words (spec L63-64 = plan L169-170);
`JIRA_PAGES` order (spec L134 = plan L53); `role="group"` `Show` and the `All tickets` chip (`JiraSessionList.tsx:98, 124-125`).

## 3. Reality

Every Modify path exists; every Create path (`hooks/usePickedJiraBoard.ts`, `components/jira/JiraBoardPicker.tsx`, `JiraSessionsView.tsx`,
`JiraIssueList.tsx`) does not. Line references hold: `SideRail.tsx` badge `onClick` L209-222 and `RAIL_JIRA_LABEL` L478-490; `test/jira-lib.test.ts`
page-key case L595; `test/rail.test.tsx` badge case L639-655; `test/jira-board.test.tsx` GROUP fixture L534-575 and card-click case L619-627;
`styles.css` `.jira-list-*` L1430-1464; `.claude/rules/board.md` Popover composers L20-21 and the Jira two-pages bullet L56-63; DESIGN.md §8.0 L166,
§8.9 L437, §8.9.1 L443; `invariants.md` § L3354. Exported names consumed exist with the stated spelling: `foldBoard`, `foldMatches`, `matchesBoardFilters`,
`sortTops`, `JiraFold`, `pickBoard`, `JIRA_BOARD_KEY` (`lib/jira.ts`), `boardAgents`, `DeckEntry`, `deckOrder` (`lib/jira-deck.ts`), `listDotTone`
(`lib/jira-list.ts:276`), `elapsedSince` (`lib/item-age.ts:65`), `useJiraBoard(id, interval, nudge)` (`hooks/useJiraBoard.ts:55`), `setJiraPage`,
`setJiraView`, `setJiraListFilters`, `Pill tone="neutral"` (`JiraCard.tsx:122`). `JiraSessionState` has the nine members the plan counts
(`shared/jira-sessions.ts:7`). `renderList` in `test/jira-list.test.tsx:160-173` mounts `JiraView`, so retargeting by `setJiraPage('sessions')` works
and the "picking a board … switch page to `board`" case is reachable.

## 4. Interfaces and 5. Order

Task 3 consumes `usePickedJiraBoard(nudge)` and `JiraBoardPicker` (Task 2 produces both, same spelling) and `'sessions'` (Task 1). Task 4 consumes
existing lib exports plus Task 3's `JiraBoardView` without the session table. No task depends on a later one. One mismatch noted as Minor 9
(`current: JiraBoardStatus` vs the hook's nullable `board`).

## 6. Tests — findings

### Important

- **[I] plan:188-189** — "row `data-key`s equal the Board view's card keys for the same fixture, in the same order" is not a relation the code
  guarantees. The Board view's cards are per-column (`boardShelves`, `client/src/lib/jira-deck.ts:170-178`: `kept.filter(columnOf === col)` then
  `sortTops` per shelf, cut at `SHELF_LIMIT` 8/8/3 by the caller) with deck tops removed (`!away.has`, L170), while the List is one global `sortTops`.
  On GROUP it coincides — To Do `[PAY-120, PAY-180]` + In Progress `[PAY-190]` happens to equal the global order — so the test cannot fail a
  column-grouped implementation, and it is false the moment the fixture carries a live session. → Assert the row keys equal
  `sortTops(fold.tops, fold.under).map(k)` = `['PAY-120', 'PAY-180', 'PAY-190']` and that no folded key (`PAY-160/161/162/170`) is a row; add one case
  where a non-To-Do top is newest (e.g. PAY-190 `updated: daysAgoStamp(0)`) so the List order `[190, 120, 180]` differs from the column order and the
  sort is pinned.
- **[I] plan:164 + 177 + 199** — `rolledUpdatedMs(...): number` (plan L164) but the column is `elapsedSince(<rolled-up ISO>, now)` (L177) and
  `elapsedSince` takes a string (`client/src/lib/item-age.ts:65`). The conversion is unspecified; `updatedMs` maps an unparseable stamp to `0`
  (`client/src/lib/jira.ts:107-110`), so the obvious `new Date(ms).toISOString()` yields `1970-01-01…` and the cell prints `~20700d` where the card
  prints nothing (`elapsedSince` returns `null` on NaN, L83). → Have the helper return the newest ISO `updated` string across the fold (or `null` when
  none parses) and let `sortTops` parse it, or state the conversion and the `null` branch, and add the unparseable case to the `rolledUpdatedMs` test.
- **[I] plan:102-103 (Task 3) vs spec:91-92** — "the launch sheet must open from the Sessions page" has no test. The existing list cases only open
  `Run ▾`'s panel (`test/jira-list.test.tsx:279-310`), and `test/jira-launch.test.tsx:25` mounts the sheet standalone, so retargeting `renderList` pins
  Detail (plan L136-137) but not the sheet. → Add a Task 3 Step 1 case: on the Sessions page, a row's `Run ▾` › Start opens the launch sheet dialog
  (JiraView hosts it, `JiraView.tsx:104-108`).
- **[I] plan:74-78 (Task 2 files) and plan:210-214 (Task 5)** — `client/src/hooks/useDialogEscape.ts:48` names the Jira picker's `Popover` composer as
  `components/jira/JiraBoardView.tsx`; Task 2 moves it to `JiraBoardPicker.tsx` and updates only `.claude/rules/board.md` L21. The hook comment becomes
  false and no suite catches it (`test/dialog-count-docs.test.ts:87-95` pins `/seven composers/`, not the path). → Add `useDialogEscape.ts` L48 to
  Task 2's Modify list beside board.md L21; `docs/subsystems/invariants.md:2244` names "Jira board's picker" without a path and can stay.

### Minor

- plan:48-49 — `JiraView.tsx:85` is `page === 'setup' ? Setup : Board`, so `'sessions'` already falls through to the Board page; Task 1 needs no
  `JiraView` edit at all. Say "no change" rather than "one-line temporary fallthrough".
- plan:169-170, 186 — `issueCellWord(state: JiraSessionState)` must return something for `ended` (`shared/jira-sessions.ts:7`); the plan leaves it
  unspecified. It is unreachable through `boardAgents` (`jira-deck.ts:82` skips ended links), so state the return (`''`) and say why it is unreachable.
- plan:140-142 vs plan:198, 202 — C1 (FilterBar in both views) and the `Search issues` label in both views are implemented in Task 3 Step 3 but tested
  only in Task 4 Step 1; Task 3's Step 4 goes green without them. Move those two cases into Task 3 Step 1.
- plan:30 — the commit trailer hardcodes `Claude Opus 5.5`; the harness supplies the attribution line per session. Say "the attribution line the
  session was given".
- plan:83 vs plan:87, 118 — the hook's `board: JiraBoardStatus | null` but `JiraBoardPicker.current` is non-null (`JiraBoardView.tsx:273`); the
  Sessions page should narrow on `board !== null` (true whenever `boards.length > 0 && unreadable === null`, `lib/jira.ts:580-586`), not on
  `boards.length`. Say so to save the implementer a cast.
- plan:29, 66, 143, 205 vs spec:114-119 — the spec lists `test/jira-view-store.test.tsx` and `test/use-jira.test.tsx` among the suites to run locally;
  the plan never runs them. Neither is a source guard (`use-jira.test.tsx:292` calls `useJiraBoard` directly), so nothing is at risk; add them to
  Task 2 Step 3 or drop them from the spec.
- plan:179 — `No issues match` / `No issues` is copy the spec does not define (spec:71 covers only loading/unavailable); the plan flags it as a builder
  pick, which is fine — just keep the test asserting whichever is picked.
- plan:216 — the grep only reaches `docs/subsystems/jira.md:634` ("`jira-list` (the List view)") because `jira-view` matches `jira-view-store`; add
  `List view` to the pattern so the hit is deliberate.
- plan:112-114 — "the bar's counts read zero in that state" is true only because `issues = []` feeds `buildListRows` with no board rows; it is a
  consequence, not a mechanism. Fine as written; noting it so the implementer does not add a special case.

## 7. Conventions

The plan states behaviour, signatures and test cases, never literal code; budgets are soft; prose wraps at 160. Followed throughout.

## Decision logged

`autopilot decide` #8: keep Tasks 3 and 4 as separate commits (the plan offered landing them together at the reviewer's preference).
