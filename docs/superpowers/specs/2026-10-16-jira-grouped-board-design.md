# Jira board — children fold into their top ancestor (amends the Jira design)

**Amends:** [2026-10-15-jira-integration-design.md](2026-10-15-jira-integration-design.md) §1 (board layout row), §6.2 (Jira › Board), §6.3 (issue
modal). Where the two disagree, this document wins. Phase 2 shipped the flat layout; this lands as its own plan and PR, before phase 3.
**Mocks:** https://claude.ai/artifact/JHdzBd5RCpWWSJwjKNFHZL (canvas, version 11), the row titled "Grouped board". Picked: `GroupTop.dc.html` (G-A),
`ModalChildren.dc.html`, `GroupFilter.dc.html` F1. Rejected: `GroupSubtasks.dc.html` (G-B), `GroupExpand.dc.html` (G-C), `GroupStrays.dc.html` (G-D),
`GroupFilter.dc.html` F2. The mocks use generic PAY data; their numbers are illustrative.

## 1. Intent

A board built from epic roots draws every descendant as its own card. The user's "My tasks" board (2026-10-16) has 29 issues, 22 of them children of
another issue on the board and 13 of those grandchildren, so the columns read as a list of subtasks rather than a list of work. The user wants the board
to show the work items and say how much sits under each one, and to reach the children by opening the card. The user had expected this from option B. The
picked B was flat, and the user is changing that now.

**Success:** that board reads as 7 cards. Each parent card says how many issues sit under it and how far along they are. Nothing that was reachable before
becomes unreachable: every folded issue opens from its top card's modal, and a filter that matches a folded issue still finds its card.

## 2. Decisions and their alternatives

| question | picked | rejected |
| --- | --- | --- |
| how deep cards fold | **G-A**: every on-board descendant folds into its **topmost on-board ancestor**, at any depth | **G-B**: only subtasks (`type.level` −1) fold, and stories and tasks stay cards under their epic (17 → 9 in the mock against 17 → 5) |
| how the children are reached | **the modal only**: the card opens the modal, and its Children section lists them | **G-C**: an inline expand toggle on the card; **both** |
| a child whose column differs from its top card's | **stays folded**: the progress bar on the card shows the spread | **G-D**: it surfaces as a dashed card in its own column |
| a filter or search that matches a folded child but not its top card | **F1**: the top card shows, ringed, with a note naming the match | **F2**: the parent drops out and the child shows alone with its crumb |

## 3. The fold — `lib/jira.ts`, one derivation

- **Top card.** Defined recursively: `top(X)` is X when X's `parent` is `null`, when its `parent.key` is not in the board's loaded list, or when the
  walk up from X comes back to X — a self-parent, or any member of a cycle; otherwise `top(X)` is `top(parent(X))`. Every non-top issue folds under its
  `top`, so each issue lands exactly once, a cycle draws as its members side by side, and a child of a cycle member folds under that member. Jira has no cycles,
  but the list is our own cache, and a malformed one must not hang the page. `foldBoard(issues) → { tops: JiraIssue[], under: Map<topKey, JiraIssue[]>,
  childrenOf: Map<key, JiraIssue[]> }` is the one home of this walk. `childrenOf` is the on-board parent → direct-children index the walk builds anyway,
  and the modal's tree reads it for whichever issue the modal shows, a mid-level one included. It holds only **fold edges**, child → the parent it folded
  under, so a top is nobody's child and the index is acyclic by construction: the tree recurses it with no guard of its own. Every `under`
  and `childrenOf` list is in `sortForBoard` order (the issue's own `updated`, descending); only the tops sort differently (Sort, below). The board, the band count, the filters and the modal tree
  all read `foldBoard`. None of them walks parents on its own.
- **What "on the board" means** is the loaded list, exactly. So it covers four cases that need no extra code:
  - A parent that left through the 14-day Done window is not on the board, so its open children become tops and keep their parent crumb.
  - A parent cut by the 500 cap behaves the same way.
  - A query hit whose parent is off the board is a top.
  - A query hit that is also a descendant of a root folds like any other descendant. Dedup by key already happened on the server.
- **Column.** A top card sits in its **own** status category's column. Folded issues never move it.
- **Sort.** Tops sort by the newest `updated` across the top and everything under it, descending, with the existing key tie-break. Activity on a child
  therefore moves its parent up. *(Author's call: the flat board sorted by the issue's own `updated`, and a parent whose subtasks are being worked would
  otherwise sink.)* The card's age reading stays the top issue's own: its `updated`, or `resolved` on a Done card that has one. The sort key is not drawn. The one home of this order is
  `sortTops(tops, under)` in `lib/jira.ts`. The board applies it per column where it applies `sortForBoard` today (`JiraBoardView.tsx:81`), after the
  filter.

## 4. The card — `JiraCard`, §6.2 amended

- **Unchanged:** type icon, key, crumb precedence (`root`, else the parent crumb when the parent is off the board, else `Assigned to me`, else nothing),
  title, person, raw status pill, age, priority. `Run ▾` and the live strip do not exist yet (phase 5), and this change adds neither.
- **Replaced:** the `N subtasks` marker (from `JiraIssue.subtasks`, which counts only Jira subtasks, on board or not) goes away. A top with folded issues
  draws a **fold block** above the marker row instead:
  - `C children · D below them`. C is the direct children on the board and D is everything deeper; at D = 0 the line is `C children` (`1 child`). *(Author's call on
    the wording: the mock's line.)*
  - A **4 px progress bar** over all folded issues, segmented done / in progress / to do in `--fill-progress`, `--fill-live` and `--ink3` — the repo's
    fill tokens (`shared/theme.css`), since the Jira column dots are all the plain `Dot` and carry no hue to borrow — with a 12 px `--ink3` line under it: `2 done · 4 in progress · 3 to do`, each zero omitted.
  - A top with nothing folded draws no fold block, and nothing marks its Jira subtasks count. A subtask off the board is not this board's business.
- **Column count pill:** counts cards (tops), not issues.
- **Band sub-line:** gains an `M cards` part when M < N (the mocks' `17 issues as 5 cards` is superseded by the line below). When nothing folds it stays
  as it is. The source counts (`from R roots and Q
  queries`) are unchanged. *(Builder-check ruling.)* N and M both come from the **loaded list**: N is its length and M is `tops.length`, both unfiltered.
  Today `bandSub` reads N from the status poll's `board.count`, a different poller that can disagree with the list for one interval. A line that says
  "17 as 5" has to count one list. `bandSub` therefore takes the fold's two numbers. The cards count is its own ` · `-separated part after the sources:
  `acme.atlassian.net · 17 issues from 2 roots and 1 query · 5 cards · polled 8 s ago`. While the list has not loaded — `useJiraBoard` loading, or a
  failed first read that holds no list — the band reads today's line from `board.count`, with no cards part.
- **For phase 5, not built here:** a live session on a folded issue shows its strip on the top card, naming the folded key. `Run ▾` on the card runs the
  top issue, and a folded issue is run from its own modal. *(Author's call, recorded so phase 5 does not rediscover it.)*

## 5. Filters and search — F1

- A top card is shown when **it** matches, or when **any issue folded under it** matches. "Matches" means the existing `matchesBoardFilters` plus the
  summary/key search, applied per issue, unchanged.
- When the top shows only because of folded matches, the card carries a 2 px `--amber-solid` inset ring and a marker in a new `MarkerTone` `match`, inked
  `--amber-text` (theme.css: an amber word beside an amber mark that already carries the signal):
  - `1 match: PAY-162` when there is one match.
  - `N matches` when there is more than one, with the keys in the marker's `title`.
- A top that matches on its own draws neither, even if folded issues match too. The ring answers "why is this here", and a card that matches needs no answer.
- The filter options (`boardFilterOptions`) still derive from **every** loaded issue, folded or not. A type that only subtasks carry must still be pickable.
- With no filter and no search, nothing is ringed.

## 6. The modal — §6.3 amended

- The body's **Subtasks** list becomes **Children**: a pill with the direct-children count and, right-aligned, `N in all` when deeper issues exist. Under
  that sits the same progress bar as the card's, over all descendants, then a **tree**:
  - Direct children come from the detail read's `children`, which is already fetched fresh on open.
  - Each child's own descendants come from the **board's cached list**, indented 22 px per level, so the tree costs no Jira call beyond the one the modal
    already makes.
  - Rows are new: today's list draws key, summary and status text only (`JiraIssueModal.tsx:154`). Each row is a button with the type icon, key,
    summary, assignee initials and the raw status pill, composed from the card's own pieces. `TypeIcon`, private to `JiraCard.tsx` today, moves to
    `components/ui/JiraTypeIcon.tsx`. The progress bar is `components/ui/SpreadBar.tsx`, drawn by both the card and the modal. CLAUDE.md gives a look
    that two surfaces draw one home in `components/ui/`, and nothing there draws segments today: `ProgressRow` is one fill at DESIGN §3's 10 px.
  - **The tree draws each key once.** The detail read's placement wins: an issue already drawn as a direct child is skipped where `childrenOf` would
    draw it deeper. A reparent between the last poll and the open can otherwise put one issue in both places. An issue the card counted that the tree
    no longer reaches is simply absent, because the tree is the fresher of the two.
- **Where the board's list comes from.** *(Builder-check ruling.)* Today `JiraView` holds `openIssue`, the modal gets only `issue`
  (`JiraView.tsx:54`), and the list lives in `JiraBoardView`'s `useJiraBoard`. Opening a card passes the fold's `childrenOf` alongside the issue
  (`onOpenIssue(issue, childrenOf)`). `JiraView` holds both, and the modal takes `childrenOf` as a prop. It is a snapshot taken when the modal opened.
  The direct children are re-read fresh by the detail call anyway, and a modal that reshuffled its tree under the reader on every board poll would be
  worse. Neither a context nor lifting the hook: one prop through one parent is the smaller change.
- **A row opens that issue's modal** in place of the current one, through a setter `JiraView` passes down (`onOpenIssue` again, with the same snapshot). It is the same single modal: there is never a second modal on the stack, so Escape's one
  owner and the composer count do not change. *(Author's call: a stack of modals would need a back affordance the design does not have.)*
- A modal opened with no board context (none exists today, but phase 5's launch paths may) draws the direct children only.
- A child that the detail read returns but the board does not hold (outside the Done window, or past the cap) still lists, from the detail read, with no
  subtree.
- **What the modal counts.** *(Builder-check ruling.)* The progress bar and `N in all` count the tree **as drawn**: the detail read's children, plus each
  one's descendants from `childrenOf`. A child the board does not hold therefore counts as itself.
- While a filter or search is active, the modal does not mark the matching rows. *(Non-goal: see §8.)*

## 7. What does not change

Server, routes, `JiraIssue`, the sweep, the cache and `jira.json`. This is a client-only change. `JiraIssue.subtasks` stays on the wire, unread by the board: the
ticket block prints `detail.children.length` (`block.ts:76`), not this field, but dropping a wire field is a server change this design does not need. No new persisted state: the fold is derived on every render, never stored, and there is no flat/grouped toggle.

## 8. Goals, non-goals, anti-goals

- **Goals:** the folded board described above; every issue still reachable in two clicks or fewer from its top card's modal (one per level); filters
  never hide an issue that matches.
- **Non-goals:** an in-place expand on the card; a flat/grouped switch; marking filter matches inside the modal tree; reordering children in the modal (it
  keeps the detail read's order for direct children and `childrenOf`'s `sortForBoard` order for deeper ones).
- **Anti-goals:** a fold that pulls a card out of its own column; a second walk of the parent chain anywhere outside `foldBoard`; any Jira call added by
  the fold or the tree.

## 9. Testing

- `jira-lib` (jest, pure): `foldBoard` covers depth 1, 2 and 3, a parent off the board, a parent dropped by the Done window (absent from the list), a query
  hit that folds, a self-parent and a two-cycle (each terminates, every member is a top, each issue appears exactly once, and `childrenOf` holds no edge between them), a child of a cycle member
  folding under that member, `sortTops` by newest-under, the progress counts, and the
  `C children · D below them` wording at 0/1/many.
- `jira-board` (jsdom): the board draws tops only, with the right column counts and band line; a filter on a folded child shows its top ringed with `1
  match: KEY`; a top that matches itself draws no ring; the filter options still offer a type only a folded issue carries.
- `jira-modal` (jsdom): the Children tree indents the board's grandchildren; a row click swaps the modal's issue and leaves one dialog on the stack; a
  detail child absent from the board lists with no subtree and counts once; with no `childrenOf` the tree is the direct children only; a reparented issue
  that is both a detail child and a `childrenOf` descendant draws and counts once, as the direct child.
- `jira-board` also: the band reads `… · 17 issues from 2 roots and 1 query · 5 cards · …` from the loaded list, keeps today's line while the list is
  loading and when nothing folds; `N matches` past one.

## 10. Docs that move with the code

DESIGN.md §3 (a line beside "Progress bars: 10 px": the card-scale `SpreadBar` is 4 px, three segments in `--fill-progress`, `--fill-live`, `--ink3`, 2 px
gaps, so `SpreadBar` has a subsection to cite); DESIGN.md §8.9.1 (the "flat cards" sentence, the marker-row bullet, a fold-block bullet, the ring) and §8.9.2 (Subtasks → Children, the tree, the row
swap); `docs/subsystems/jira.md`'s board paragraph; the Jira spec's §1 row, §6.2 and §6.3 already point here.
