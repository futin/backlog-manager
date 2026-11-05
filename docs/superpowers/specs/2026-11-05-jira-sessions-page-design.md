# Jira › Sessions page, and an issue List on Jira › Board — design

Date: 2026-11-05. Mocks: [`2026-11-05-jira-sessions-page-mockups/canvas/`](2026-11-05-jira-sessions-page-mockups/canvas/) (also live on the canvas at
https://claude.ai/artifact/XnhQCrbwHKoQBd7UnmJEPt). Builds on [2026-11-03-jira-sessions-design.md](2026-11-03-jira-sessions-design.md) (§7.1 deck, §7.2 List,
C4 rail badge, C7 List).

## Why

Jira › Board has a `Board | List` switch. Board is the agent deck over the status shelves; List is the **session** table (live above ended). The user wants
to see the board's **issues** as a list too — the same tickets the Board view shows, as a table — and the word "List" on an issues page should mean that.
Sessions and their history are a different thing to look at, so they get a page of their own.

## What changes, in one paragraph

The Jira rail tree becomes **Board · Sessions · Setup**. The session table moves, whole, from Jira › Board › List to the new **Jira › Sessions** page. Jira ›
Board keeps its `Board | List` switch: **Board is unchanged** (deck + shelves, running sessions still on the board), and **List becomes an issue table** — one
row per board card.

## Goals

1. Jira › Board › List shows the board's issues as a table: the tickets Setup's roots and queries collect, folded the way the Board folds them.
2. Jira › Sessions shows every session the current List shows today, with every control it has today.
3. Nothing the user can do today is lost — every control on today's List, and the rail badge's one-click route to "what needs me", survive the move.

## Non-goals

- No change to the Board view (deck, shelves, cut at 8 / 8 / 3, worktree chips, `Run ▾` on cards).
- No change to the server, the sessions payload, polling, or what a session row shows.
- No new filters on the session table, and no new columns on it.

## Anti-goals (would be a failure even if it works)

- **Sub-tasks as rows in the issue List.** Most sub-tasks belong to other people; the user must not see all of them. The List is the board's cards, not every
  issue the board loaded.
- A second sessions poller, or the Sessions page and the deck disagreeing for a tick — both keep reading the ONE sessions answer (`useJiraSessionsContext`).
- A board picker on Sessions that remembers a different board from the Board page's picker.

## Decided with the user

| # | Decision | Mock |
| - | -------- | ---- |
| D1 | Board view on Jira › Board stays exactly as it is, live sessions included. | — |
| D2 | Jira › Board › List = issue table. One row per **top** (a board card, `foldBoard(...).tops`), never a folded sub-task or child. | `Main.dc.html` |
| D3 | Issue List columns: Session (live dot + word) · Key · Summary (+ `N under it` when the card folds others) · Type · Status · Assignee · Sprint · Updated. Row click opens the same issue modal a card opens (with the fold's `childrenOf`, so its Children tree still reaches folded issues). | `Main.dc.html` |
| D4 | Issue List uses the Board view's filters and search unchanged — FilterBar (type, assignee, sprint) and the summary search, through `foldMatches`, so a top stays when an issue folded under it matches. | `Main.dc.html` |
| D5 | Jira › Sessions = **option B**: today's session table moved as-is, **keeping the board picker and the `All tickets` toggle** (off = the picked board's tickets, on = every linked ticket). | `SessionsB.dc.html` + `SessionTable.dc.html` |
| D6 | Rail order: Jira › Board · Sessions · Setup. | `Rail.dc.html` |

Rejected, and removed from the mocks so nothing builds from them: a Sessions page with no board picker over every linked ticket; a Sessions page with a
live-session deck above an ended-only history; an issue List with sub-tasks indented under their top.

## The two pages, in detail

### Jira › Board

- Band, picker, search box and FilterBar exactly as on the Board view today. The FilterBar is drawn in **both** views now (today it is Board-only, because
  List rows were sessions). The search box's label and placeholder become the Board's (`Search issues` / `search summaries`) in both views.
- Board view: unchanged.
- List view: the issue table of D2–D4. Every top that survives the filters is a row — including tops that have a live session (on the Board those are on the
  deck rather than a shelf) — with no `+ N more` cut. Order: the fold's `sortTops` order (newest `updated` across a top and everything under it), the same
  order the shelves use.
- The Session cell: empty when nothing is live on the card. When a session is live on the top **or on any issue folded under it**, a dot and the state word
  in the deck's vocabulary (`needs you` in the live fill, `working` in the progress fill; starting / lost as the deck names them). When several are live, the
  most urgent wins, by `deckGroup`'s order. The cell is display only — not a link; the whole row opens the issue modal.
- The Updated cell shows the **rolled-up** time — the newest `updated` across the top and everything folded under it — the same value `sortTops` sorts by,
  so the column reads sorted.
- Loading, `board unavailable`, `jira.json cannot be read`, and `No boards yet` read exactly as the Board view's do.

### Jira › Sessions

- A page of its own (`JiraPage` gains `'sessions'`), drawn by a new page component that hosts today's `JiraSessionList` unchanged in behaviour.
- Band: title `Sessions`; sub-line names the picked board (the mock's `Payments Q4 · 3 live · read 4 s ago` is drawn copy, not a spec — the builder
  picks a sub that says only what the page actually knows); right slot: the **same** board picker (same stored pick, `backlog-manager.jira-board`) and the
  sessions search (`Search sessions`, key · summary · repo · branch). No FilterBar.
- Under the band: the List's own bar as today — chips with counts (All, Needs you, Working, Ended), Repo and Run selects, `All tickets`, the 24 h / 7 d /
  30 d / All window — then the table with every column it has today, the link-store warning, row → Detail, `Run ▾` where it exists today.
- The page needs the picked board's loaded `issues` and the fold's `childrenOf`, because `JiraSessionList` scopes and stubs rows from them — so it loads the
  picked board the way the Board page does.
- Empty and failure states: with `All tickets` **off**, the page reads as the Board page does (`loading…`, `board unavailable`, `jira.json cannot be
  read`, `No boards yet`) — the scope is the board, so without it there is nothing to scope to. With `All tickets` **on**, the table draws whatever state
  the board is in — scoped to every linked ticket, off-board rows stubbed from their link snapshot as today — because that is where the badge sends the user,
  and "what needs me" must not wait on a board read. The band still says what is wrong with the board; the picker is drawn only when there are boards.
- The Detail modal and the launch sheet must open from the Sessions page as they do from today's List (`JiraView` hosts them beside the Board page only
  today).
- Filters stay `useJiraListFilters`' module store, so they survive a page switch as they survive a view switch today.

### The rail badge (C4)

Clicking the Jira row's `N need you` badge opens **Jira › Sessions** with `Needs you` pressed and `All tickets` on — today it opens Jira › Board and flips
the view to List. It no longer touches the Board page's view. **The badge stays on the Jira row**, where it is today, so it shows with the Jira tree
collapsed; the Sessions tree entry carries no count.

### Stored view

`backlog-manager.jira-view` keeps its two values. A browser that stored `list` lands on the issue table after this ships, not on sessions — accepted; the
badge and the rail are the routes to sessions now.

## Constraints

- Repo rules apply: `.claude/rules/board.md` (client), `.claude/DESIGN.md` (§8.0 the rail is the only page switch; §8.9.1 Jira Board), CSP — no inline
  `<style>`/`style=` markup; the rail labels stay the one place a page is named.
- `test/` source guards count callers of shared hooks (e.g. `useJiraSessionsContext`, poll hooks). A new caller must be added to the scoped run before push
  (CLAUDE.md, "Touched includes the source guards").
- **Peer work in flight:** branch `fix/jira-list-row-opens` (worktree `.worktrees/jira-list-row-opens`) changes `JiraSessionList.tsx`, `styles.css`,
  `DESIGN.md` and `test/jira-list.test.tsx` — a click anywhere on a List row opens Detail. Whichever lands second rebases; the moved table keeps that behaviour.
- Docs that describe the old shape must follow: `.claude/DESIGN.md` §8.9.1 (deck and view switch paragraph; List), `docs/subsystems/board.md` where it names
  the Jira pages, and the rail labels' comments in `SideRail.tsx`.

## Left to the builder

- Component names and file split (e.g. `JiraSessionsView`, `JiraIssueList`), and whether board loading is lifted into a shared hook or repeated.
- The issue table's markup and classes, following the session table's styling and the mock's density; responsive behaviour at narrow widths (the table
  scrolls in its box, as the session table does).
- Exact Sessions sub-line copy.
- Test layout, beyond: the issue List never renders a folded issue as a row; a fold match keeps its top; the badge lands on Sessions with the two filters set;
  the Board view's render is unchanged; `JIRA_PAGES` order is board, sessions, setup.
- The plan ends in `/ui-verify`: the live views shot beside `Main.dc.html` and `SessionsB.dc.html` at 1440 px with fixture data for sessions, asserting no
  horizontal overflow (global CLAUDE.md, "A UI plan built from picked mocks…").

## Calls I made (not discussed — check these)

- C1. FilterBar now shows on both Board-page views; its filters were Board-only only because List rows used to be sessions.
- C2. The issue List's live dot rolls up sessions on folded children to their top, most urgent wins.
- C3. No `+ N more` cut in the issue List — a list is where you go to see them all.
- C4. Sessions page shares the Board page's stored board pick rather than having its own.
- C5. A stored `list` view silently becomes the issue table; no migration.
- C6. The `N need you` badge stays on the Jira rail row, not on the Sessions entry.
- C7. The issue List's live dot is display only, not a link to the Sessions page.
- C8. With `All tickets` on, Sessions draws its table even while the board is loading, unavailable or absent.
- C9. The issue List's Updated column shows the rolled-up time (newest across the fold), matching the sort.
