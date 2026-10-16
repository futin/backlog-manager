# Review 2 — Jira board: children fold into their top ancestor (2026-10-16)

Document: `docs/superpowers/specs/2026-10-16-jira-grouped-board-design.md`. Reviewer: Fable 5.1, fresh session, paths and checklist only. Every claim
below was checked against the code on `feat/jira-grouped-board` (HEAD `146cb6a`, "docs: address spec review 1") and against the three picked mocks read
from the linked canvas (`GroupTop.dc.html`, `ModalChildren.dc.html`, `GroupFilter.dc.html`, artifact version `1792161167-9a52`).

**Verdict: APPROVE WITH FIXES** — no Critical, four Important. Review 1's Critical (`--green2`) and all eight Important findings are resolved in this
revision; the four below are what the fixes opened or left.

## Critical

None.

## Important

- **[I] spec:30–33 — a descendant of a cycle member has no stated top, so `under` and `childrenOf` can disagree.** The rule covers an issue whose walk
  "comes back to itself" (self-parent, cycle member: a top) and an issue whose walk reaches `null` / an off-board key (folds into that top). It does not
  say where C lands when C's parent is A and A↔B is a cycle: C's walk is C → A → B → A, which meets a visited key that is not C. A single-walk
  implementation ends at B (the issue whose parent is already visited) and would put C under B in `under`, while the "fold edge" rule (child → the parent
  it folded under) puts C→A in `childrenOf` — B's card then says `1 child` and B's modal tree is empty, A's card says nothing and A's modal lists C.
  → State the rule recursively: `top(X)` is X when X's parent is `null`, off the board, or X's own walk returns to X; otherwise `top(X) = top(parent(X))`.
  Then C's top is A, the edge is C→A, and the two maps agree. Add "a child of a cycle member folds under that member" to the §9 `jira-lib` line.
- **[I] spec:37 contradicts spec:45 on the order of `tops`.** §3 says "Each list is in `sortForBoard` order (the issue's own `updated`, descending)"
  immediately after naming `tops`, `under` and `childrenOf`; §3 "Sort" says tops sort by the newest `updated` across the top and everything under it.
  `sortForBoard` is own-`updated` only (`client/src/lib/jira.ts:75–81`), and the newest-under key needs `under`, so an implementer who reads the first
  sentence sorts tops wrong, and one who reads the second has to decide whether `foldBoard` returns `tops` sorted or the board sorts them after the
  per-column split (`JiraBoardView.tsx:79–82` sorts per column today). → Say `under` and `childrenOf` values are in `sortForBoard` order and `tops` is in
  the newest-under order, and name which function applies it (a `sortTops(tops, under)` in `lib/jira.ts`, or `foldBoard` itself), since the §9 test
  "the sort by newest-under" needs a callable.
- **[I] spec:55–58, 85–86, 91–92 — the progress bar is a look two surfaces draw and the spec names no home; the 4 px size departs from DESIGN.md.**
  CLAUDE.md (Layout, `client/src/`) says "every look more than one surface draws has one home in `components/ui/`"; the 4 px segmented bar is drawn by
  the card (§4) and the modal (§6 "the same progress bar as the card's"), and nothing in `components/ui/` draws a segmented bar today (`ProgressRow.tsx`
  is one filled length over a track, 10 px; `Meter.tsx` is a reading, not segments). `TypeIcon` "moves to one shared home" (spec:91) without naming it.
  DESIGN.md §3 pins progress bars at 10 px (`ProgressRow.tsx:4–5` cites it), so the bar is a new size as well as a new look, and DESIGN.md requires
  every component to cite its subsection in a header comment. → Name `components/ui/` for both (e.g. `SegmentBar.tsx`, `TypeIcon.tsx`), and add to §10 the
  DESIGN.md line that records the 4 px three-segment bar and the tokens it reads, so the component has a subsection to cite.
- **[I] spec:86–88 with spec:103–104 — an issue can appear twice, or vanish, when the cache's parent and the detail read's parent disagree.** The tree's
  first level is the detail read's `children` (fresh, `parent in (KEY)`, `server/src/jira/poller.service.ts:366`) and every deeper level is
  `childrenOf` (the board poll's cache). A reparent in Jira between the poll and the open — X moved from under M's child Y to directly under M — makes
  X a detail child of M AND `childrenOf[Y]`'s member: two rows, one React key, counted twice in `N in all` and the bar. The reverse move (X from M to Y)
  makes X neither a detail child nor in `childrenOf[Y]`, so the card counted it and the tree omits it. The window is one poll interval, but §3 says
  "each issue lands exactly once" and §9 tests "counts once". → One sentence: the tree is deduplicated by key, the detail read's placement wins and a
  `childrenOf` descendant already drawn is skipped; add the reparent case to the `jira-modal` tests.

## Minor

- spec:5–7 — mock differences still not called out beyond the band line: `GroupTop.dc.html` draws bar → legend and puts `4 children · 5 below them` in
  the marker row as its first marker, not in a fold block above the row as spec:53–54 orders; `GroupFilter.dc.html` F1 reads `1 matches: PAY-162`
  (spec:77 `1 match`) and still draws `3 subtasks`; the mocks' column dots are coloured, the repo's are plain (`BoardColumn.tsx:80`).
- spec:50 — "the parent crumb when the parent is off the board" is still not what `crumbOf` does (`lib/jira.ts:118`: a parent crumb whenever
  `parent !== null`). Equivalent for an ordinary top, but a self-parent top (spec:31) draws `↳ <its own key> <its own summary>`; say whether that is
  accepted or the crumb is suppressed when `parent.key === key`.
- spec:73–74 — "`matchesBoardFilters` plus the summary/key search": the search is already inside `matchesBoardFilters` (`lib/jira.ts:380–381`); say
  "`matchesBoardFilters`, search included, applied per issue".
- spec:98 — a row swap sets `held` to `null` (`JiraIssueModal.tsx:78`), so the body reads `loading…` and the tree disappears until the new detail
  lands; one sentence so the `jira-modal` test expects it.
- spec:101–102 — the detail's children are capped at `JIRA_ROOT_CAP` (200, `poller.service.ts:366`); a board child past that cap is absent from the
  tree though the card counted it. Name it beside the Done-window case.
- spec:123 — `jira-lib (jest, pure)`: `test/jira-lib.test.ts` runs under `@jest-environment jsdom` (line 2) and uses `renderHook` (line 532).
- spec:135–136 — §10 misses two sentences that go stale: DESIGN.md §8.9.1 "Filters" ("the list is by `updated`", a sort the tops no longer use) and
  `docs/subsystems/jira.md:194–195` (the `lib/jira.ts` bullet names "subtasks marker"; spec:109 drops `subtasksMarker`'s only reader).
- spec:33 — `under: Map<topKey, JiraIssue[]>` is implied to hold ALL descendants (the card's `D` and the bar need it) while `childrenOf` holds direct
  ones; say "every descendant" once so `under` is not read as the direct list under another name.

## Checked and found true

- spec:3–4 — the Jira spec's §1 row (`:31`), §6.2 (`:214`) and §6.3 (`:229`) carry the "Amended 2026-10-16" pointer to this document.
- spec:11–12, 16 — 29 − 22 = 7 cards; 9 direct children + 13 grandchildren = 22.
- spec:23 — `type.level` −1 is a subtask (`shared/types.ts:566`); `GroupTop.dc.html` has 5 cards and `17 issues as 5 cards`.
- spec:30 — `JiraIssue.parent` is `{ key, summary } | null` (`shared/types.ts:574`).
- spec:40–43 — the Done window runs at map time and is off for the detail read (`.claude/rules/jira.md`, `poller.service.ts:354`); a dropped parent's
  key still feeds the next `parent in` round (`walk`, `:775–779`), so its open children ARE on the list; dedup by key, first occurrence wins
  (`sweepBoard`, `:729–735`); cap `JIRA_BOARD_CAP` 500 (`:111`) and `truncated` reported (`:758`).
- spec:44 — `columnOf` reads the issue's own category (`lib/jira.ts:66–68`).
- spec:47 — `cardAgeStamp` is `resolved` on a Done card with one, else `updated` (`lib/jira.ts:94–97`).
- spec:51 — no `Run ▾`, no live strip (`JiraCard.tsx`; DESIGN.md §8.9.1 last paragraph).
- spec:53 — the marker is `subtasksMarker(issue.subtasks)` (`JiraCard.tsx:44`, `lib/jira.ts:385`), and `subtasks` is `fields.subtasks.length`
  (`server/src/jira/map-issue.ts:142`) — Jira's subtasks, on board or not.
- spec:56–57 — `--fill-progress`, `--fill-live`, `--ink3` exist on every theme block (`shared/theme.css:27,43–44,96,110,123,156,163`); the three Jira
  columns are outside `RAMP_SLUGS` and draw the plain `<Dot />` (`BoardColumn.tsx:40,80`).
- spec:62–67 — `bandSub` reads `board.count` from the status (`lib/jira.ts:183–190`), parts joined by ` · ` with the polled phrase after the sources, so
  `… · 17 issues from 2 roots and 1 query · 5 cards · polled 8 s ago` fits the existing shape; `useJiraBoard` reports `loading: true` while
  `held.id !== id` and `issues: NO_ISSUES, error: true` on a failed first read (`useJiraBoard.ts:72,87–88`), so the stated fallback is decidable.
- spec:75–76 — `--amber-solid` is the mark token and `--amber-text` the word beside an amber mark (`theme.css:73–74,82,156`); `MarkerTone` is
  `groomed | kind | done | stale | untyped` (`Marker.tsx:3`), so `match` is new as stated; `Marker` takes `title` (`Marker.tsx:18`).
- spec:80 — options derive from the whole loaded list already (`JiraBoardView.tsx:76`).
- spec:90 — today's row is key, summary and the raw status name (`JiraIssueModal.tsx:153–155`); `TypeIcon` is private to `JiraCard.tsx:114`;
  `initialsOf` is in `lib/jira.ts:138`.
- spec:93–95 — `JiraView` holds `openIssue` and the modal takes `issue` only (`JiraView.tsx:42,54`); the list is `JiraBoardView`'s `useJiraBoard`
  (`:68`).
- spec:98–99 — one `Modal` mount, `useDialogEscape` called by the shell (`Modal.tsx:49`; `.claude/rules/board.md`), so an in-place issue swap keeps
  five dialogs counted.
- spec:109–110 — the ticket block prints `Subtasks (${detail.children.length})` (`server/src/jira/block.ts:76`); `JiraIssueDetail.children` is
  `JiraIssue[]` (`shared/types.ts:628`).
- spec:123–131 — `test/jira-lib.test.ts`, `jira-board.test.tsx`, `jira-modal.test.tsx` exist, flat in `test/` as `.claude/rules/tests.md` requires.
- The mocks' numbers agree with themselves: PAY-120 `4 children · 5 below them` = `2 done · 3 in progress · 4 to do` = 9 = `9 in all` in
  `ModalChildren.dc.html` (4 top-level rows, 5 indented); column pills 2 + 3 + 0 = 5 cards.
- Hard rules touched: client-only (no server, route, type or `jira.json` change); every derivation in `lib/jira.ts`; no new persisted state; Escape one
  owner; tests flat in `test/` — respected as written. The one Layout rule the text leaves open is the shared-look home (Important 3).
