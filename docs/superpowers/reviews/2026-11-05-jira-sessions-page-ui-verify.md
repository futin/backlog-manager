# UI verify — Jira Sessions page + issue List (2026-11-05)

Verdict: **PASS after one fix** (Key column width, fixed on the branch).

Served: the branch's own Vite on 5197 (pid recorded, killed after), proxying to the running API on 4322 — real Jira data (`timify.atlassian.net`, boards `Globals`, `My
tasks`) and real session links, no fixtures. Mocks served from their own directory on 5198 (pid recorded, killed after). Playwright MCP was down; the built-in
browser was used. Light theme, 1440×1000 and 600×900 (the stylesheet's fold is `max-width: 700px`).

Caveat: the `.dc.html` mocks are Canvas templates, so their row placeholders (`{{r.key}}`) do not render outside Canvas. The band, controls, column order and
column widths were compared from the rendered frame plus the mock's source (`<th style="width: …">`); row content was compared against the mock's data array.

## Inventory

| View | Mock | Opened via | Data | States the mock draws |
| ---- | ---- | ---------- | ---- | --------------------- |
| Jira › Board › List | `canvas/Main.dc.html` | rail Jira › Board, view `List` | `Globals` (6 tops, no folds), `My tasks` (7 tops, 3 with folds) | rows with/without `N under it`, filter chip row, live dot |
| Jira › Sessions | `canvas/SessionsB.dc.html`, `canvas/SessionTable.dc.html` | rail Jira › Sessions | `My tasks`; All tickets off (0 rows) and on (2 ended sessions) | band, bar, table |
| Rail | `canvas/Rail.dc.html` | — | — | Board / Sessions / Setup under Jira |

## Geometry

1440 px, Board › List, before the fix: `TD.jira-issues-key 105>96` on every row — real keys (`TIMIFY-27xxx`, twelve characters) clipped; the mock's `PAY-131`
hid it. After widening Key to 120 px: only `BUTTON.jira-issues-title` (deliberate summary ellipsis). Summary column 382 px. No page sideways scroll.

1440 px, Sessions (All tickets on), before the second fix: `jira-list-title 701>11`, `jira-list-run 208>120`, `jira-list-branch 171>104`. After it (Ticket
45%, Repo · branch 23%, Where 17%, Model 15%; columns 206/105/78/69): `jira-list-title 701>71` (summary ellipsis, as intended), `jira-list-run 208>120` and
`jira-list-branch 171>81` (both ellipsise by design), and the Started cell `86>76` — see "Pre-existing" below. No page scroll. A 50 : 18 : 17 : 15 split was
tried first: summary 94 px, but the repo name `backlog-manager` (75 px) clipped at 58, so it was rebalanced.

600 px: `jira-issues-scroll 980>550` and `jira-list-scroll 1120>550`, both `overflow-x: auto` (the box scrolls, by design); the page never scrolls.

## Regions

Board › List:
- Band (title = board name, sub `site · N issues from N roots · N cards · polled …`, Board | List, picker, search, Filters): **match** (live sub wording is the
  Board page's own `bandSub`; the mock's `17 issues · 9 cards · read 12 s ago` is the same facts).
- Columns Session · Key · Summary · Type · Status · Assignee · Sprint · Updated, in that order: **match**. Widths within 8 px of the mock except Session (124 vs 92;
  the session word + dot need it) and Key (120 vs 104; fix above).
- `N under it` after the summary: **match** (`23 under it`, `2 under it`, `4 under it`).
- Rows = the Board's cards: **match** — `My tasks` Board view shows the same seven keys in the same set.
- Unassigned reads `unassigned`, not the mock's `—`: **deviation**, brief text (logged ruling).
- Key is a link to Jira in `--ink2`, not the mock's plain 600-weight text: **deviation** — the session table's Ticket key is the same link, and a key that
  opens Jira is the List's only way out to it without opening Detail.
- Sub-task rows (TIMIFY-20939…20942) appear: **deviation from the user's wording, match to spec** — they are cards on the Board too, because their parent
  TIMIFY-20938 is not collected by Setup. The List shows exactly the Board's tops.

Sessions:
- Band: title `Sessions`, sub leads with the board name, picker + `Search sessions` on the right, no Board | List, no Filters: **match**.
- Bar and table: the existing session table, unrestyled (spec: "moved as-is"): **match** to `SessionTable.dc.html`. The mock's restyled chips/segmented
  `Ended` control are SessionsB's illustration only; the spec chose the table as-is.
- Search placeholder `search key, summary, repo, branch` clips at `repo,`: **pre-existing** (same input, same text as main's List).

Rail: Jira › Board / Sessions / Setup, Sessions has no count: **match**.

## Pre-existing

- Session table's Ticket column (fixed on this branch at the user's choice): the four percentage columns share the 458 px left over after 692 px of fixed
  columns, and at 32 : 28 : 21 : 19 the summary got ~11 px beside a twelve-character key. Now 45 : 23 : 17 : 15, summary ~71 px, repo name, `Terminal` and
  `sonnet` whole. Same on main before this branch.
- Session table's Started column, untouched: 76 px holds 52 px of text, so `Wed 13:52` (62 px) clips by its last characters. Same on main.

## Screenshots

In the session's tool-results directory (`mcp-Claude_Browser-blob-*.jpg`); not committed.
