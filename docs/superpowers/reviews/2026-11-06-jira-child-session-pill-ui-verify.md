# /ui-verify — Jira child-session pill (2026-11-06)

Verdict: **PASS**, after one fix. There is no mock; the reference is the design approved in chat (List cell fold pill, Children-row session pill, Agent-pane
"on a child" line), so geometry and screenshots are what was checked. Branch Vite on 5191 proxying the stack's API (real Jira data: a live `permission`
session on TIMIFY-26366, a sub-task under TIMIFY-26359), headless Chromium 1.63 from the npx cache, light theme. Fixture: `page.route` on
`/api/jira/sessions` adds a second live session on the same child so the List's `+1` draws.

## Inventory

| View | Reference | How opened | States |
| --- | --- | --- | --- |
| Jira › Board › List, Session cell | approved chat design | rail → Jira, view `list`, board `My tasks` | live on a folded child, `+1` |
| Jira Detail, Children rows | approved chat design | click TIMIFY-26359's row | child with a live session, child without |
| Jira Detail, Agent pane | approved chat design | same | no own session, child live → line; click opens child |

## Geometry

- 1440, List: Session cell `↳ TIMIFY-26366` pill **96 > 90 — clipped to `TIMIFY-26…` at 132 px. Defect, fixed**: column 132 → 140 px (DESIGN.md's fixed
  sum 996 → 1004). Re-measured: 96 = 96, whole. Other lines are the existing Summary/Key ellipses (`jira-issues-title`, `jira-issues-cut`), by design.
- 600: `jira-issues-scroll 1120>550` — the table's designed container-query scroll below its 1120 px min-width; the page does not scroll. Modal: nothing of
  its own overflows; the Agent line's text fits (154 = 154).

## Regions

- List Session cell: dot + `Working · 2 s` on line one, `↳ TIMIFY-26366` FoldMark + `+1` on line two — **match**.
- Detail Children: TIMIFY-26366's row carries `● Working` before `In Progress`; TIMIFY-26360 has none — **match**.
- Detail Agent pane: `No session on this ticket` / default line / `● Working on TIMIFY-26366 →` — **match**; click opens TIMIFY-26366 with the `←
  TIMIFY-26359` back chip — **match**.
- 600 px modal: same three marks, one column — **match**.

Screenshots: `/private/tmp/claude-501/-Users-andrejajevtic--claude-spares-spare-Q5rjM3/88efa7b3-3417-4258-9db9-6a1c4428c29c/scratchpad/list-1440b.jpg`, `/private/tmp/claude-501/-Users-andrejajevtic--claude-spares-spare-Q5rjM3/88efa7b3-3417-4258-9db9-6a1c4428c29c/scratchpad/modal-1440.jpg`, `/private/tmp/claude-501/-Users-andrejajevtic--claude-spares-spare-Q5rjM3/88efa7b3-3417-4258-9db9-6a1c4428c29c/scratchpad/child-1440.jpg`, `/private/tmp/claude-501/-Users-andrejajevtic--claude-spares-spare-Q5rjM3/88efa7b3-3417-4258-9db9-6a1c4428c29c/scratchpad/list-600.jpg`, `/private/tmp/claude-501/-Users-andrejajevtic--claude-spares-spare-Q5rjM3/88efa7b3-3417-4258-9db9-6a1c4428c29c/scratchpad/modal-600.jpg`.
