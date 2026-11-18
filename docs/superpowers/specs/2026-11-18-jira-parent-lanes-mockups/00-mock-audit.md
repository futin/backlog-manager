# Jira parent lanes — mock audit

The four files beside this one are the picked artboards of the Design-canvas artifact "Jira parent lanes" (<https://claude.ai/artifact/QTu3kedaND4mjoLmWFigpG>,
private, Version 7), read against the code on `origin/main` at `186d0ba2` on 2026-11-18. The canvas names two of them differently: `Board.dc.html` is the
canvas's `Main.dc.html`, `List.dc.html` its `ListGrouped.dc.html`; `BoardDeep.dc.html` and `ListDeep.dc.html` keep their names. The canvas also holds the
options that were not picked (`BoardRail`, `BoardClusters`, `ListParentColumn`); they are not copied here.

**The repo copies carry fictional sample data.** The canvas was drawn from two live boards; this repo is public, so every ticket key, summary, person
and site name in the copies was swapped for an invented one (`PAY-…`, `acme.atlassian.net`, `Dana Novak`). Markup, layout, counts and states are byte-for-byte
what the canvas shows.

A mock fixes layout, controls, copy and states. It does not fix the list of things a surface carries: the mocks were drawn to answer "whose child is this",
and they leave out parts of today's card, list and deck that have nothing to do with that question. **Where a mock and the spec differ, the spec wins, and
nothing today's surfaces do is dropped unless the spec says so by name.** Section numbers are the spec's
([2026-11-18-jira-parent-lanes-design.md](../2026-11-18-jira-parent-lanes-design.md)).

## Board (`Board.dc.html`, `BoardDeep.dc.html`)

| part | mock | code today | change (spec §) |
| ---- | ---- | ---------- | --------------- |
| Column header | One row above every lane: `To Do n`, `In Progress n`, `Done n` | Three `BoardColumn`s, each with its own header and count (`JiraShelves`) | One shared header row; a count is the cards shown in that column across all lanes, lane-header issues not counted (§3.1) |
| Lane | One band per parent: header row, then three cells under the three columns | None. Cards are the fold's tops, in three columns | New (§1, §3) |
| Lane header, parent on the board | Chevron, type tile, key, summary, status pill, `↳ <parent>` chip, spread bar, count, `Run ▾`, `↗` | That issue is a card today: tile, key, crumb, priority pill, title, assignee disc + name, status, age, `↗`, fold block, marker row (mapped-repo chip, match marker, worktree chip, `MrChip`, `Run ▾`), ended line + reopen | The header is that issue's card laid out as a row: it keeps priority, assignee, age, mapped-repo chip, worktree chip, `MrChip`, `Run ▾`, the ended line and its own session state, which the mock leaves out (§3.2) |
| Lane header, parent off the board | Chevron, type tile, key, summary, status pill, `not on this board` tag, spread bar, count, `↗`; no `Run ▾` | None. The parent is the `parent` crumb on each child card: `<KEY> · <summary>` | New. Type and status come from the child's `parent.fields`; a missing one draws nothing in its place (§2, §3.2) |
| Nested lane | Indented one step under its parent lane, with the `↳` chip | None | New (§1.3, §3.2) |
| Card | Tile, key, priority or status pill, title, disc, status, age, `MrChip`, `Run ▾` | As in the row above this one's "code today" | Keeps everything but three things: the drawn `parent` crumb, the fold block (`N children` line + `SpreadBar`), and the match marker with its `jira-card-match` ring. The `root` and `mine` crumbs, assignee name, `↗`, mapped-repo chip, worktree chip and ended line stay although the mock omits them (§3.4) |
| Card with a live session | Green left edge, state line (`Working · 12m`), `Open` button; stays in its lane | Removed from its column while live (`boardShelves`' `away`), drawn only in the deck | Stays in its cell, at its usual place and never behind the cut, with a state line and the session's open control; `Run ▾` stays and draws whatever `runChipState` says (§3.4) |
| `+ N more` | Per lane cell, after 5 cards | Per column: `SHELF_LIMIT` 8 / 8 / 3, a flat `Chip` with `aria-expanded`, `show fewer` to close | Per lane cell, after 5; same chip, same `show fewer` (§3.3) |
| Lane order | Generator's own ranking: live, in progress, other, all done | Columns sort cards newest-updated first | Open lanes, then settled ones; newest update first inside each group; a live session does not move a lane (§3.5). The mock's order is not the rule |
| Settled lane | Collapsed, at the bottom | A top whose work is done sits in the Done column | Collapsed by default, after the open lanes (§3.5, §3.6) |
| `No parent` lane | A lane with a plain label, after the open lanes | Parentless tops are cards like any other | New; last lane of its group (§3.5) |
| Agent deck | `Agents · 1 working`, one card: `↳ parent`, title, context meter, `Open` | `JiraAgentDeck`: tally (`n need you`, `n working`), per card state line, type icon, key, `FoldMark` naming the top, title, crumb (`run · repo · surface · model`), `MrChip`, context meter, `SessionOpen`, handover error | Unchanged but for the mark and the filter: `FoldMark` names the issue's direct parent, on the board or off it, and an entry is filtered by its own issue, not its top's. The mock's card is a simplification (§5) |
| Band | `<site> · 16 issues · 8 parents · polled 54 s ago` | `bandSub`: `<site> · N issues from 1 query · M cards · polled … · <failure> · first 500 shown` | `M cards` becomes `M parents`, on the Sessions page's band too; every other part stays (§6.1) |
| `Group` control | Removed in Version 7 | Never existed | None is added: lanes are the only Board (§Decisions) |
| Filters, search | Drawn as today | `foldMatches`: a top stays when it or anything folded under it matches; a matching child rings its top | Plain per-issue matching; a lane with no matching issue under it hides (§6.2) |

## List (`List.dc.html`, `ListDeep.dc.html`)

| part | mock | code today | change (spec §) |
| ---- | ---- | ---------- | --------------- |
| Rows | A header row per parent on a tinted ground, child rows indented under it | One row per top; children are a `N under it` marker | Lane header rows and child rows, in the Board's lane order (§4.1) |
| Columns | Session, Key, Summary, Type, Status, Delivery, Priority, `Who` (disc only), Updated, Run | Session, Key, Summary, Type, Status, Delivery (only while the delivery index is non-null), Priority, Assignee (disc + name), Sprint, Updated, Run | Today's columns, all of them. `Who` and the missing Sprint column are mock shorthand (§4.2) |
| Header row, parent on the board | The parent's own values in every column, `Run ▾` | A top's row | Same cells as any row, plus chevron and count in the Summary cell (§4.2) |
| Header row, parent off the board | Key, summary, type, status; `–` elsewhere; no `Run ▾` | None | New; cells Jira did not send are empty, not `–`-filled guesses (§4.2) |
| `N under it` | Gone; the header row shows the count | In the Summary cell of a top with children | Removed with the fold (§4.2) |
| Session cell | The row's own state | The top's lead session, a `FoldMark` when it runs on a folded child, `+N` for more | The row's own sessions: state and age, `+N` when the key has several. The `FoldMark` goes — no row stands for another issue (§4.3) |
| Updated | Each row's own stamp | `rolledUpdated`: the newest across the top and everything under it | Each row's own `updated`; the roll-up survives only as the lane's sort stamp (§3.5, §4.3) |
| Cut | None; an open lane shows every row | None | None (§4.1) |
| Delivery quick filter | Not drawn | `.jira-issues-quick` `Segmented` above the table | Stays (§4.4) |
| Empty states | Not drawn | `No issues match` / `No issues` | Stay (§4.4) |

## Drawn on a mock, not built

- **The `Who` column and the absent Sprint column.** The List keeps Assignee (disc and name) and Sprint.
- **The simplified deck card.** The deck keeps its state line, crumb, `MrChip`, meter, `SessionOpen` and handover error.
- **The lane order.** The generator ranked lanes by live session, then in-progress, then the rest. The spec orders by open-before-settled and newest
  update (§3.5).
- **The reduced lane header for an on-board parent.** The mock shows status, parent chip, spread, count and `Run ▾`; the built header carries everything
  the issue's card does (§3.2).
- **`–` in an off-board header row's unknown cells.** Built as empty cells.
- **The live session.** One ticket was given a mocked `Working · 12m` session at 38 % context to show a live card in a lane and in the deck at once. It
  is sample state, not a state the page invents.
- **Pixel values.** Every size, colour and radius in the mocks is hand-written inline style. The built surfaces compose the tokens and primitives in
  `client/src/styles.css` and `components/ui/`; where a mock value breaks a design guard (`test/guards/design-guards.test.ts`: the 11 px floor, the one
  uppercase rule, the `.jira-issues-*` geometry), the guard wins.
