# Jira › Board — parent lanes — design

Status: written, awaiting approval. Date: 2026-11-18. Branch `feat/jira-parent-lanes`. Amends
[2026-10-16-jira-grouped-board-design.md](2026-10-16-jira-grouped-board-design.md): its fold (§3), card fold block (§4) and filter rule (§5) are replaced by
this spec on the Board page; its modal (§6) stands. Mocks: the Design-canvas artifact "Jira parent lanes"
(<https://claude.ai/artifact/QTu3kedaND4mjoLmWFigpG>, private, Version 7), copied into
[2026-11-18-jira-parent-lanes-mockups/](2026-11-18-jira-parent-lanes-mockups/) and read against the code in
[00-mock-audit.md](2026-11-18-jira-parent-lanes-mockups/00-mock-audit.md).

| Mock | What it fixes |
| ---- | ------------- |
| [Board.dc.html](2026-11-18-jira-parent-lanes-mockups/Board.dc.html) | The Board on a board where every parent is off it: shared column header, one lane per parent, the off-board lane header, the `No parent` lane, settled lanes collapsed at the bottom |
| [BoardDeep.dc.html](2026-11-18-jira-parent-lanes-mockups/BoardDeep.dc.html) | The Board on a deep board: an on-board parent as a lane header with `Run ▾`, a nested lane, a live card in its lane and in the deck, `+ N more` in a cell |
| [List.dc.html](2026-11-18-jira-parent-lanes-mockups/List.dc.html) | The List on the first board: a header row per parent, child rows indented under it |
| [ListDeep.dc.html](2026-11-18-jira-parent-lanes-mockups/ListDeep.dc.html) | The List on the deep board: on-board header rows with their own cells, nested header rows |

The mocks carry fictional sample data; the layout, controls, copy and states are what they fix. Where a mock and this spec differ, this spec wins — the
audit lists every such place.

## Intent

The Board page answers "what is on this board" and fails at "what belongs to what". Today it folds every issue into its topmost on-board ancestor and draws
only those tops as cards, with the parent as a one-line crumb. On a board built from a personal query — "my sprint tasks" — no parent is on the board at all,
so nothing folds: sixteen cards in three columns that differ only in a grey crumb. Sub-tasks of one story sit apart, issues of unrelated epics sit
together, and the page reads as one undifferentiated pile.

Jira's own board solves this with swimlanes: one lane per parent, each lane a small To Do / In Progress / Done board of that parent's children, and a parent
shown as the lane's header even when only its child is the user's. This spec builds that, for the Board and for the List, so that the first thing the eye
separates is the parent and the second is the status.

## Goals

- Every issue on the Board is drawn under its direct parent, and the parent is a visible header, whether or not the parent is itself on the board.
- Each parent's children read as their own small board: three status cells under one shared column header.
- The List shows the same grouping in the same order: a header row per parent, its children under it.
- Each loaded issue is drawn exactly once per view (plus, for a live session, once in the agent deck).
- Nothing a card, a list row or the deck does today is lost, except what this spec removes by name: three things on the card (§3.4), the List's two
  roll-ups (§4.2, §4.3) and the deck's filtering by top (§5).
- No new Jira request to draw the page.

## Non-goals

- The Detail dialog. Its Children tree, parent link, sessions and delivery pane are untouched (grouped-board spec §6).
- The Sessions and Mentions pages, Setup, the launch sheet, the Jira chip.
- A way to switch lanes off, or to group by anything else (epic, assignee, sprint). Lanes are the only Board and grouped rows the only List.
- Drag and drop, or moving an issue between statuses from a lane. Status changes stay in Detail.
- Showing an off-board parent's own parent, assignee, priority or epic.
- Lane-level actions: no "run all", no bulk move.

## Anti-goals

- **A lane that hides work.** A collapsed lane, a cut cell and a filtered lane each say how many issues they hold. An issue that silently is not on the page
  is the failure this page exists to prevent.
- **A page that jumps.** Starting or ending a session does not reorder lanes or move a card to another place.
- **A second hierarchy rule.** One function decides which lane an issue is in; Board, List, deck mark and band count all read it. Two walks of the parent
  chain that can disagree is how the grouped board's first draft broke.
- **A request per lane.** A board with forty parents must not make forty calls to draw.

## Constraints

- **"On the board" is the loaded list, exactly** — `GET /api/jira/boards/:id/issues`, with its 14-day Done window and 500 cap. An issue that is not in it is
  off the board, whatever Jira holds.
- **The server reads Jira on a sweep and the client reads the cache.** Drawing must not add an outbound call (`.claude/rules/jira.md`; the
  rendered-age invariant in `CLAUDE.md`). A read on a click is allowed and already exists (`useParentRead`, Detail's parent link).
- **A malformed cache must not hang or empty the page.** `foldBoard` is cycle-safe today; the lane model keeps that guarantee (§1.4).
- **`Run ▾` is never hidden for the dashboard's sake**, and `JiraRunMenu` stays one component reading `runChipState` alone (`.claude/rules/board.md`).
- **Item files and Jira issues are not written by this change.** It is a read-side and layout change only.
- **Design guards hold**: the 11 px floor, the one uppercase rule, and the `.jira-issues-*` geometry rules in `test/guards/design-guards.test.ts`.
- **`shared/types.ts` is the one home of shared shapes**; the widened parent lives there and both sides compile against it.
- **The page's CSP is `style-src 'self'`** (`.claude/rules/board.md`): a lane's indent is a class or a data attribute, never a `style=` attribute.

## Approaches

Three ways to build it were laid out; the user picked the first.

1. **A lane model replaces the fold (picked).** A new pure function in `client/src/lib/jira.ts` groups the loaded list by direct parent and returns lanes;
   Board and List both draw from it; `foldBoard`'s fold-to-top, `foldMatches`, `cardFold` and the shelves built on them are deleted. The server's issue
   mapper carries the parent's type and status, which Jira already sends. Costs a wide diff across the Board page's lib, components and tests; leaves one
   hierarchy rule.
2. **Lanes drawn on top of the fold.** Keep `foldBoard`, add a second grouping pass for display. Smaller diff, but two rules for "where is this issue":
   the fold says topmost ancestor, the lanes say direct parent, and filters, the deck mark and the band would each have to pick one. Rejected: it is the
   second-hierarchy anti-goal.
3. **Server-side lanes.** The API returns lanes, with each off-board parent fetched in full. Gives the header an assignee and a priority, at the cost of a
   request per off-board parent on every sweep, a new cache with its own age, and a parent that can be newer or older than its children. Rejected: the user
   chose a header that needs no extra call, and a sixth rendered-age cache is not worth two fields.

## Decisions

The user's, each taken from a question with the options sketched on the canvas:

| # | Decision |
| - | -------- |
| D1 | **Board: parent lanes.** One lane per parent with its own To Do / In Progress / Done cells under one shared column header. |
| D2 | **List: rows under their parent.** A collapsible header row per parent, child rows indented below it. |
| D3 | **An off-board parent's header shows type and status, with no extra calls.** Both are mapped from the `parent.fields` Jira sends inside each child. No epic chip, no assignee. |
| D4 | **The lane is the direct parent.** On a deep board every issue sits in its direct parent's lane; an on-board issue that has children on the board is a lane header — with its own `Run ▾` and status — instead of a card, and shows a chip for its own parent. Each issue is drawn once. |
| D5 | **Lanes replace the flat view.** No `Group` control; the `N children` fold block on a card goes. |
| D6 | **The lane model replaces the fold** (approach 1). |
| D7 | **A card with a live session stays in its lane**, with a live state on it; the agent deck above stays as the "running now" strip, so the ticket shows in both. |
| D8 | **A lane cell shows 5 cards, then `+ N more`**, which opens that cell. |

Everything below that is not one of these eight is marked **(my call)**: a choice made while writing, with its reason, open to correction.

## 1 The lane model

One pure function, `laneBoard(issues)`, in `client/src/lib/jira.ts`, replaces `foldBoard` as the page's single reading of the parent links. It takes the
loaded list and returns the lanes in drawing order. Names are the builder's; the behaviour is this.

### 1.1 Headers and cards

- An issue is **on the board** when it is in the loaded list.
- A **header issue** is an on-board issue that is the `parent.key` of at least one other on-board issue, counting only the parent links §1.4 keeps.
- A **card** is every on-board issue that is not a header issue.

### 1.2 Which lanes exist

- One **on-board lane** per header issue. Its header is the issue itself.
- One **off-board lane** per key that is the `parent.key` of at least one *card* and is not on the board. Its header is a stub built from that card's
  `parent` (§2). When several cards name the same off-board parent, the stub is read from the most recently updated one, the first in `sortForBoard`'s
  order — its payload is the freshest **(my call)**.
- One **`No parent` lane** when at least one card has no parent.

A card's lane is its parent's lane, or `No parent`. A header issue is never a card, in any lane.

An off-board parent whose only on-board children are header issues gets no lane **(my call)**: a lane with a header nobody can act on and no card under it
is noise. That header issue is a root lane and names its parent in its chip instead (§3.2).

### 1.3 Nesting

A header issue with a parent whose lane exists is a **nested lane**: it is drawn directly after its parent lane's own cells, one indent step in, and its
descendants' lanes nest under it in turn **(my call)**. Every other lane is a root lane. This is what keeps D4's "each issue once" readable on a deep board:
an epic's lane holds the epic's direct cards, then the lane of each story under it.

The **subtree** of a lane is every on-board issue under its header: its own cards, the header issues of its nested lanes, and those lanes' subtrees
**(my call)**. A nested lane's header is an issue on this board like any card, so everything that reads a subtree — the settled test, the sort stamp, the
count and the spread bar (§3.2, §3.5) — counts it. Without that, an off-board epic over an In Progress story whose sub-tasks are all Done would read as
finished, fold itself and sink to the bottom with live work inside.

### 1.4 The guard

Whatever the parent links say, every loaded issue is drawn exactly once and the function returns. The rule is the one `foldBoard` has today, kept: **an
issue whose walk up its parent chain comes back to itself is a cycle member, and a cycle member's parent link is ignored** — for every purpose in this spec
it is an issue with no parent. So `A` under `B` under `A` is two parentless issues, an issue that is its own parent is one, and an issue that merely
hangs off a cycle keeps its real parent. A parentless cycle member then falls where §1.1–§1.2 put any parentless issue: a root lane when something on the
board is under it, a card in `No parent` when nothing is. The loaded list is a cache the server filled from someone else's data; a cycle in it must cost
an oddly placed issue, never a hung tab or a missing one. The `↳` chip and the deck's mark read the parent the lane model kept, not the raw field, so a
cycle member is not drawn pointing at a lane it is not in.

### 1.5 What the old fold still serves

`childrenOf` — the on-board parent → direct-children index, in which a cycle member is nobody's child — is what Detail's Children tree, `modalTree` and
`childSessions` read. It stays, built in the same pass, and holds exactly the edges §1.4 keeps, so it is the same index for the same input as today.

Everything else fold-shaped loses its last caller: `foldBoard`'s `tops` and `under`, `sortTops`, `rolledUpdated`, `cardFold`,
`foldMatches`, `matchMarker`, `childrenLine`, `boardShelves` with `Shelf` and `ShelfCard`, `SHELF_LIMIT`, `topSessionCell` with `TopSessionCell`
(§4.3 replaces the roll-up), and `DeckEntry.top` (§5). `boardAgents` takes the loaded issues, not a fold. Each is deleted unless something outside the
Board and Sessions pages still calls it — the builder greps, and a function with a remaining caller stays untouched. Two that do stay: `foldProgress`
and `JiraProgress`, which `modalTree` calls and a lane's spread bar reads for the same three-way split. `childSessions` builds deck entries as well, so
its entries lose `top` with the deck's.

**The Sessions page reads the fold too** — `fold.tops.length` for its band and `fold.childrenOf` for the Detail it hosts
(`JiraSessionsView`). It moves to the lane model with the Board **(my call)**: its `childrenOf` comes from the same function and its band reads the same
count (§6.1). Keeping `foldBoard` alive for one band number would be the second hierarchy rule the anti-goals rule out.

## 2 Server: the parent's type and status

`server/src/jira/map-issue.ts` already requests `parent` and already receives, inside it, more than it keeps. Confirmed against the live site on
2026-11-18: an issue's `fields.parent` is `{ id, key, fields: { summary, status: { name, statusCategory: { key } }, priority: { name }, issuetype: { name,
subtask, hierarchyLevel } } }`.

`JiraIssue.parent` in `shared/types.ts` widens from `{ key, summary }` to carry two more fields:

- `type: { name, level, subtask } | null` — mapped exactly as the issue's own `type` is (`hierarchyLevel` when it is a number, else `-1` for a sub-task and
  `0` otherwise). `null` when `parent.fields.issuetype` is absent or has no string `name`.
- `status: { name, category } | null` — mapped exactly as the issue's own `status` is, through `categoryOf`. `null` when `parent.fields.status` is absent
  or has no string `name`.

Each is nullable on its own, because Jira omits a field the token cannot see. The client treats `null` — and a field absent altogether, as from an API
one version behind the client — as "not known" and draws nothing in that place
(§3.2). The parent's priority is in the payload and is deliberately not mapped: D3 asks for type and status.

No route, no request field and no cache changes; the fields ride the issue the sweep already stores. The issue cache is memory-only, so nothing mapped the
old way outlives the restart that ships this. Every place that builds a `parent` by hand gains the two fields — `stubIssue` in
`client/src/lib/jira-list.ts` on the client, and the test fixtures.

## 3 Board

### 3.1 Column header

One header row above all lanes — `To Do`, `In Progress`, `Done`, in `JIRA_COLUMNS`' order and tones — replaces the three per-column headers. Each count is
the number of cards in that column across every lane that pass the filters and search — whether or not their lane is folded or their cell is cut, so a
default page with its settled lanes folded still says how much is Done. Header issues are not in any column and are not counted there **(my call)**: the
band counts issues, the columns count cards. The row stays visible while the lanes scroll under it.

### 3.2 Lane header

A full-width row above the lane's three cells. Left to right: a chevron button that folds the lane (§3.6) — `aria-expanded`, and an `aria-label` of `Collapse
<KEY>` or `Expand <KEY>`, `Collapse No parent` or `Expand No parent` for that lane, the same words on the List's header rows — then the parent, then on the
right the lane's spread bar and count, then the parent's actions.

**The count and the spread bar cover the lane's subtree** **(my call)** — every on-board issue under this header at any depth, nested lanes' headers
included (§1.3), split by status category in `SpreadBar`'s existing three tones — so a folded lane still says how much it holds. The count reads
`n issues` (`1 issue`).

**An on-board parent's header is that issue's card laid out as one row (my call).** The mock draws a reduced header; the issue was a full card yesterday
and loses nothing by becoming a header. It carries: type tile, key, title (a button that opens Detail, as the card's is), status, priority pill when set,
assignee disc (name in its `title`), age stamp, the `↗` link to Jira, the mapped-repo chip, the worktree chip, `MrChip`, `Run ▾` reading `runChipState`,
the ended line with its reopen chip, and — when a session is live on the header's own key — the same live state line and open control a live card draws
(§3.4). When it has a parent it carries a chip `↳ <KEY>`, whether that parent is a lane above it or not on the board at all. The chip is `FoldMark`, which
gains an optional title so it can carry the parent's summary; its header comment, which still says "the top it folds under", is rewritten. A crumb draws
by the card's rule (§3.4). The title truncates to one line first; the row may wrap its right-hand cluster
under the title at narrow widths rather than drop a control.

**An off-board parent's header** carries what the stub knows and nothing else: type tile (omitted when `type` is `null`), key, summary, status pill (omitted
when `status` is `null`), the tag `not on this board`, the spread bar and count, and the `↗` link to Jira (`https://<site>/browse/<key>`, composed the way
`stubIssue` already does from the status payload's site; no link while the site is unknown). It has no `Run ▾`, no assignee, no priority, no parent chip: none
of that is known without a call, and a control that works on some headers and is absent on others must be absent for a visible reason — the tag is that reason.
A stub's summary can be empty — Jira sent none — and the summary button then reads the key, so the header always has its way into Detail.
Clicking its summary reads the parent once — `GET /api/jira/issue/:key`, through the shared parent read in `lib/jira-parent.ts` (`askParent`) — and opens Detail
on what lands, the summary inert while the read is out and the failure sentence shown on that header alone **(my call)**. An answer is acted on only while
the header that asked is still drawn and no other off-board header has been clicked since: the newest click wins, and a read that lands for a header that
has gone, or been overtaken, opens nothing. The failure sentence sits under that header's summary and is cleared by the next click on any off-board
header. That is a request on a click, not a request to draw. `Run ▾` on that parent is then one step away, in Detail.

**The header must not mount `useParentRead`.** That hook retains its key for as long as it is mounted, and the shared store answers every later ask from
the copy it holds while any holder is up — which is why the Run menu mounts it only inside its open panel. On a header that is always drawn it would pin
the parent's first read for the life of the page, and Detail's own parent link and the Run menu's `Run on` toggle would be handed that stale copy too.
The header asks on click and holds nothing afterwards.

**The `No parent` lane's header** is the label `No parent`, the spread bar and the count.

**A nested lane** is indented one step per depth, capped at three steps **(my call)** so a pathological chain cannot push cards off the page.

### 3.3 Cells and the cut

Under the header, three cells aligned to the three columns. A cell holds the lane's own cards (not its nested lanes') whose status falls in that column
(`columnOf`), sorted by `sortForBoard` — newest update first, key as tie-break. A live session does not change a card's place: the page must not jump
(anti-goals).

A cell shows its first 5 cards, **plus any card past the fifth that has a live session (my call)** — inside an open lane the cut may hide finished and waiting
work, never running work, and exempting a card from the cut moves nothing. Past that it draws the existing flat chip — `+ N more`, `aria-expanded`, `N` being
the cards actually hidden — which opens that one cell; open, the chip reads `show fewer`. Which cells are open is page state, lost on reload, as the shelves' is
today. One constant replaces `SHELF_LIMIT`'s three.

An empty cell is empty: no placeholder card, no text.

### 3.4 Card

A card is today's `JiraCard` minus three things:

- **The `parent` crumb.** The lane header says it. `crumbOf`'s precedence — root, then parent, then mine — does not change; the card and the header
  simply draw nothing for the `parent` kind **(my call)**. So a followed root still reads `root`, a parentless issue assigned to me still reads
  `Assigned to me`, and an issue under a parent draws no crumb. Dropping the rung instead would print `Assigned to me` on every card of a "my tasks"
  board — the sameness this change is here to remove.
- **The fold block** — the `N children` line and its `SpreadBar`. A card has no children on the board by definition (§1.1).
- **The match marker and the `jira-card-match` ring.** They marked a card whose folded child matched a filter; nothing is folded (§6.2).

Everything else stays where it is: type tile, key, priority pill, title, assignee disc and name, status, age, `↗`, mapped-repo chip, worktree chip,
`MrChip`, `Run ▾`, the ended line with reopen.

**A card whose key has a live session stays in its cell (D7).** It gains a state line — the deck card's `STATE_LABEL[state] · age` — an accent on its
leading edge in that state's tone, and the session's open control (`SessionOpen`, the deck's). `Run ▾` stays on it and draws what `runChipState` says, which
for a live key is the disabled chip with its reason. A key with several live sessions shows the lead one (`deckOrder`'s first) and `+N` **(my call)**. A
`starting` reservation counts as live, as it does in the deck.

### 3.5 Lane order

**(my call, replacing the mock's ranking.)** A lane is **settled** when every issue in its subtree (§1.3) is Done and, for an on-board lane, its header issue is
Done too; otherwise it is **open**. An off-board header's own status does not count: it is not on the board, and a lane whose only work left is someone
else's is finished as far as this board goes.

Settled, the sort stamp and the fold default (§3.6) read the whole subtree, never the filtered one **(my call)**: a filter hides cards, it does not
reorder lanes or fold and unfold them. The count and the spread bar read the matching issues (§6.2), so the bar and the number beside it always agree.

Root lanes draw open first, then settled. Within each group they sort by the newest `updated` across the header issue (when on the board) and every issue in the
subtree, newest first, lane key as tie-break — the rule `sortTops` applies to a top and everything under it today. The `No parent` lane is the last lane of
whichever group it falls in. Nested lanes sort among their siblings by the same rule and are not split from their parent: a settled nested lane stays under its
open parent.

A live session does not change the order. The deck is where running work is surfaced; a lane that leaps to the top when a run starts moves the page under
the pointer.

### 3.6 Folding a lane

The chevron folds a lane: its cells and its nested lanes are hidden, its header — with count and spread — stays. Settled lanes start folded, open lanes
start open **(my call)**: finished work should cost one line.

A person's toggle is remembered per board in `localStorage`, as overrides only — lane key → open or closed, the `No parent` lane under a reserved id — so
a lane the person never touched follows the default as it settles or reopens **(my call)**. It is **one storage key holding a board id → overrides map**,
not a key per board: `usePersistedState` reads storage once on mount and never again when its key changes, and picking another board does not remount the
page, so a per-board key would write board A's folds under board B's name. An override for a lane no longer on the board is dropped when its board's
entry is next written — judged against the unfiltered lanes of a loaded list, never against a filtered view or a list still loading, either of which
would wipe overrides for lanes that are merely not shown.

**The stored value is clamped on read**, as the panel filters are (`clampJiraPanelFilters`): anything but an object of board entries, each an object whose
values are `open` or `closed`, reads as no overrides — a bad board entry drops alone, a bad lane value drops alone. `usePersistedState` hands back a
stored `null`, string or array exactly as it found it, and indexing one by board id would take the page down.

**While the search box holds text, folding is ignored**: every shown lane draws open and the chevron is disabled **(my call)**. A match hidden inside a
folded lane reads as no match. Panel filters do not do this — they survive a reload and would pin every lane open for good; under a filter a folded lane's
count already says what it holds.

## 4 List

### 4.1 Rows

The List draws the same lanes in the same order (§3.5), as rows of one table: a **header row** per lane, then one row per card in the lane, then the lane's
nested lanes. Child rows are indented under their header by one step in the Key cell, nested header rows by their depth, with §3.2's cap. Within a lane,
card rows sort by `sortForBoard` across all statuses — the Status column says the status, so the List does not split a lane in three.

There is no cut in the List **(my call)**: a row is one line, and a list that hides rows cannot be scanned or searched by eye. Folding is §3.6's, shared with
the Board — one stored state per board, so a lane folded in one view is folded in the other.

### 4.2 Columns

Today's, all of them, in today's order: Session, Key, Summary, Type, Status, Delivery (only while the delivery index is non-null), Priority, Assignee (disc
and name), Sprint, Updated, Run. The mock's `Who` and its missing Sprint column are shorthand, not a change.

- **Every header row, of all three kinds, carries the chevron (§3.6) and the lane's count in its Summary cell.** Folds are shared with the Board (§4.1) and
  settled lanes start folded, so a header row without a chevron would be a lane nobody can open from the List. The count takes the place of today's
  `N under it` and its class: `.jira-issues-under` stays as the count's class, because a design guard pins its `flex: none` rule.
- **A header row for an on-board parent** fills every cell with that issue's own values, exactly as a row does, and draws `Run ▾`. Its Summary cell also
  carries the parent chip (`↳ <KEY>`) when it has a parent.
- **A header row for an off-board parent** fills Key, Summary, Type and Status from the stub and leaves the other cells empty **(my call — the mock draws
  `–`)**: an empty cell says "not known", a dash reads as "none". Its Summary cell also carries the `not on this board` tag; its Run cell is empty; its key
  links to Jira by the Board header's rule (no link while the site is unknown) and its summary opens Detail as on the Board (§3.2).
- **The `No parent` header row** carries the label `No parent` in its Summary cell, beside the chevron and the count; every other cell is empty.

Header rows sit on a tinted ground so the eye finds the groups before it reads a cell. The `.jira-issues-*` classes and their geometry rules are kept; the
indent is padding inside the Key cell, not a change to the table's columns. Every header row keeps the table's full cell count — an unknown value is an
empty `td`, never a `colSpan` — because the table is `table-layout: fixed` and sizes its trailing columns by position.

### 4.3 Session and Updated

Each row stands for one issue, so two roll-ups go:

- **Session** shows the row's own key: the lead live session's state and age, else the newest ended one, `+N` when the key has more live sessions, as
  today. The `FoldMark` that said "this is running on a child" goes with the fold.
- **Updated** shows the row's own `updated`. The newest-across-the-subtree stamp survives only inside the lane sort.

### 4.4 What stays

The Delivery quick filter above the table, `rowOpens`' click rule, the Key link to Jira, `No issues match` and `No issues`.

## 5 Agent deck

`JiraAgentDeck` stays as it is — tally, state line, crumb, `MrChip`, context meter, `SessionOpen`, handover error — with three changes:

- **Its entries no longer leave the board.** `boardAgents` still lists every live session on an on-board issue; `boardShelves`' removal of those issues
  from the columns is gone with the shelves.
- **Its `FoldMark` names the direct parent.** It drew `↳ <top key>` when the session ran on a folded child. It now draws `↳ <parent key>` for any issue
  with a parent, on the board or off **(my call)** — the same chip a lane header draws — so a deck card says which lane to look in. `DeckEntry.top`
  goes; `deckCrumb`'s `↳` lead names the direct parent the same way.
- **It is filtered by its own issue (my call).** Today an entry shows when its top is kept, and a top is kept when anything folded under it matches. With
  no fold, an entry shows when the issue its session runs on passes the filters and search — the rule every card follows (§6.2).

## 6 Band, filters, search

### 6.1 Band

`bandSub`'s `M cards` becomes `M parents` — the number of lanes that have a parent header, the `No parent` lane not counted. Today the part draws while
there are fewer cards than issues; it now draws while the count is above zero. Its other parts are unchanged. `bandSub` is one function, so the Sessions
page's band reads `M parents` too (§1.5). `FilterBar`'s `showing` and `GitlabBandLine` take the matching **issues** where they took shown tops —
`GitlabBandLine` keys an MR by project and MR number, so a sub-task that falls back to its parent's MR is not counted twice.

### 6.2 Filters and search

Matching is per issue: `matchesBoardFilters` on each loaded issue, nothing rolled up. `foldMatches` is deleted.

- A card that does not match is not drawn.
- **A lane is drawn when any issue in its subtree matches, or its own on-board header issue does (my call).** The subtree includes nested lanes' headers
  (§1.3), so a nested lane that is drawn always has its ancestors drawn above it: a filter never lifts a nested lane out to the root.
- A lane drawn only because its header issue matches draws as a header with empty cells and neither count nor spread bar: the header is an issue on this
  board that the filter asked for, and there is nothing under it to count.
- A lane that is drawn draws its header even when the header issue does not itself match: it is what says whose children these are. A header issue shown
  only for that reason is not counted in `showing`.
- Counts on a lane header and in the column header are of matching issues.

## 7 What does not change

Detail and everything in it; the board picker, the view switch and its stored pick; the filter panel's four filters, their storage key and the search
box; `JiraRunMenu`, `runChipState` and the launch sheet; the delivery index and `ticketDelivery` (its `via` is per issue and never read the fold); the
Sessions page's rows, filters and layout (only where its band count and its `childrenOf` come from moves, §1.5); polling, the status payload and every
route; the empty and error states of the page (`loading…`, `board unavailable`, `No boards yet`, the
unreadable-config line).

## 8 Known limits

- **An off-board parent's own parent is unknown.** Jira sends one level of `parent`. An off-board story whose epic is on the board therefore draws as a
  root lane, not nested under that epic. Fixing it needs a call per off-board parent — approach 3's cost — and is left out.
- **A lane's header can be staler than Jira.** An off-board header's status is as fresh as its freshest child's last sweep. It is a label, not a control;
  Detail reads the truth on click.
- **The 500 cap and the Done window cut lanes too.** A parent whose children fell outside the loaded list shows fewer cards than Jira does. The band's
  `first 500 shown` already says so.

## 9 Testing

Behaviour, not markup. The suites that pin today's fold are rewritten to pin the lanes; the cases below are the ones that must exist.

**`laneBoard` (`test/jira/jira-lib.test.ts`)**

- Three cards under one off-board parent → one off-board lane holding all three; the stub's summary, type and status are the most recently updated card's.
- A card with no parent → the `No parent` lane; no such lane when every card has a parent.
- An on-board issue with two on-board children → a header issue, not a card; its lane holds the two.
- Epic → story → two sub-tasks, all on board, plus one direct child of the epic → the epic's lane holds one card; the story's lane is nested at depth 1
  directly after it and holds two.
- A header issue whose parent is off the board and has no card of its own → a root lane; no lane for that parent.
- An off-board parent with one card and one header-issue child → an off-board lane with one card and one nested lane.
- `A` under `B` under `A`, nothing else → two cards in `No parent`, no other lane, the call returns. An issue that is its own parent → one card in
  `No parent`. `A` under `B` under `A` with `C` under `A` → `A` is a root lane holding `C`, `B` is a card in `No parent`.
- Order: an open lane updated a week ago sorts before a settled lane updated a minute ago; two open lanes sort by newest subtree `updated`; equal stamps
  break by key; `No parent` is last among open lanes when it holds an open card and last among settled ones when it does not.
- Settled: an on-board header that is In Progress over all-Done cards is open; an off-board header that is In Progress over all-Done cards is settled; an
  off-board header over a nested lane whose header is In Progress and whose cards are all Done is open.
- A lane with one card and a nested lane of two cards has a subtree count of 4: three cards and the nested header.
- `childrenOf` is the same index `foldBoard` returned for the same input, the cycle cases included.

**Mapper (`test/jira/jira-map-issue.test.ts`)**

- A parent with `issuetype { name: 'Epic', hierarchyLevel: 1, subtask: false }` and `status { name: 'In Progress', statusCategory: { key:
  'indeterminate' } }` → `type { name: 'Epic', level: 1, subtask: false }`, `status { name: 'In Progress', category: 'indeterminate' }`.
- A parent with only a summary → `type: null`, `status: null`, key and summary kept. The suite's existing parent assertions (the full-issue case and the
  parent-without-a-summary case) compare whole objects and are updated to carry the two fields.
- A parent whose `issuetype` has a name, no `hierarchyLevel` and `subtask: true` → `level: -1`.
- A parent whose `status` has a name and an unknown category key → category `new`, `categoryOf`'s answer for the issue's own status in that case.

**Board (`test/jira/jira-board.test.tsx`)**

- A header for an off-board parent draws the tag and no `Run ▾`; with `type: null` it draws no tile and with `status: null` no pill.
- A header for an on-board parent draws `Run ▾`, and the parent chip when it has a parent.
- A card under a parent draws no crumb, also when it is assigned to me; a parentless card assigned to me reads `Assigned to me`; a followed root under a
  parent reads `root`.
- A cell with 7 cards draws 5 and `+ 2 more`; the chip opens only that cell and then reads `show fewer`.
- A card with a live session is in its cell, at its `sortForBoard` place, with the state line and an open control, and its issue is in the deck too.
- A cell with 7 cards whose 7th has a live session draws 6 and `+ 1 more`, the live one after the first five.
- Clicking an off-board header's summary makes one request for that key and opens Detail on the answer; drawing the board makes none.
- Two off-board headers clicked in turn, the first read landing last → Detail opens on the second parent only. A failed read shows its sentence under
  that header and the next header click clears it.
- An off-board header whose stub summary is `''` draws the key as its summary button, and the click opens Detail.
- A settled lane starts folded and an open one open; a toggle is stored for that board and read back on remount; switching to a second board without a
  remount shows that board's own folds, and toggling there leaves the first board's stored.
- With search text, a folded lane holding a match draws open and its chevron is disabled.
- Stored folds of `null`, a string, an array, and a map whose one board entry holds a junk lane value each draw the page with default folds.
- A filter that matches one card of a three-card lane draws the lane with one card and a count of 1; a filter that matches none of a lane's cards hides the
  lane; a filter that matches only an on-board header draws that header with empty cells.
- A filter that matches only a nested lane's header draws its parent lane's header above it, with empty cells, and the nested header under it.
- A deck entry shows when its own issue matches and hides when only its parent does.
- The column header counts cards, not header issues, and counts a card inside a folded lane.
- The band reads `… · 16 issues from 1 query · 8 parents · …` for sixteen issues under eight parents.

**List (`test/jira/jira-board.test.tsx`)**

- Rows come in lane order: header row, its card rows, its nested header rows.
- The Sprint and Assignee columns are drawn.
- An off-board header row has empty Priority, Assignee, Sprint, Updated and Run cells.
- A row's Session cell shows its own key's session and never a `FoldMark`; a row's Updated is its own stamp.
- Folding a lane in the List folds it on the Board.
- A settled off-board lane and a folded `No parent` lane each open from the chevron on their own List header row.
- A header row's count carries `.jira-issues-under`.

**Also rewritten.** `test/jira/jira-delivery-surfaces.test.tsx` builds a fold (`foldBoard`, `cardFold`) and renders `JiraCard` and `JiraIssueList` with
today's props; `test/ui/ui-fold-mark.test.tsx` pins `FoldMark`; the `bandSub` cases in `test/jira/jira-lib.test.ts` and the band assertions in
`jira-board.test.tsx` read the band's `M cards`. Each moves to the lane model's shapes with its intent kept.

**Guards.** `test/guards/design-guards.test.ts` passes unchanged. Before pushing, grep `test/` for every symbol this change deletes or adds a caller of
(`foldBoard`, `boardShelves`, `SHELF_LIMIT`, `topSessionCell`, `FoldMark`, `askParent`, `usePickedJiraBoard`, `usePersistedState`) and add each hit to the
scoped run (`CLAUDE.md`, "Touched includes the source guards").

## 10 Docs that move with the code

- `docs/subsystems/jira.md` — the sections describing the fold, the shelves, `SHELF_LIMIT` and "one row per top".
- `.claude/DESIGN.md` §8.9.1 — the Board: lanes, lane header, the live card, `FoldMark`'s new meaning, and the List's "one row per board card" paragraph.
- The header comments that describe the fold where the code no longer does: `JiraCard`, `JiraIssueList`, `jira-deck.ts`, `FoldMark`,
  `GitlabBandLine` ("over the tops"), `useParentRead` (a third asker that does not hold).
- `docs/subsystems/board.md` and `.claude/rules/board.md` where either names a deleted symbol.
- The grouped-board spec gets a one-line note at its top pointing here; its text is a record and is not rewritten.
- Each new lane component cites its `.claude/DESIGN.md` subsection in its header comment, as `.claude/rules/board.md` asks of every component.

## Left to the builder

- Names: the lane function, its return shape, the storage key for folds, the cell-limit constant.
- Whether the lane header and the card share one component with two layouts or are two components over shared parts — as long as §3.2's list is met and
  `JiraRunMenu` stays the one Run control.
- How the live state line, `SessionOpen` and the existing ended line compose on one card without repeating a control.
- The indent step and the tint of a List header row, from the tokens in `client/src/styles.css`.
- How the column header stays in view (sticky row or a fixed head over a scrolling body).
- Which of the fold's helpers still have a caller outside the Board page, and so stay (§1.5).
- The order of work. One PR.
