# ui-verify — 2026-11-11-jira-run-on-parent

Verdict: **PASS** (one defect found and fixed on the branch).

Branch served by its own Vite (port 5199, pid recorded and killed). Headless Chromium (cached playwright 1.64) with every `/api/**` call fulfilled from
fixtures built from `shared/types.ts`; daylight theme (the default). Harness: `/private/tmp/claude-501/-Users-andrejajevtic-Documents-custom-projects-backlog-manager/4b63af8b-ab23-4c22-8717-346bcfbecb74/scratchpad/uiv/harness.mjs`.

## Inventory

| View | Mock | How opened | Data | States drawn |
| ---- | ---- | ---------- | ---- | ------------ |
| Sub-task Detail: head crumb link, Parent fact link, Agent band parent-live line | `specs/2026-11-11-jira-run-on-parent-mockups/parent-live-line.png` | Jira › Board, click the TIMIFY-28028 card | sub-task under TIMIFY-27763 (off board); two live sessions on the parent (working /microservice 12 m, quiet /api 40 m) | empty band + parent line, `+1 more` |
| Detail's `Run ▾` with the parent segment picked | `specs/2026-11-11-jira-run-on-parent-mockups/run-on-toggle.png` | same Detail, chevron, then the TIMIFY-27763 segment | parent detail fixture, 3 long-named skills, no sessions | parent read landed, rows enabled, default mark |

## Geometry (`scrollWidth > clientWidth` with `overflow-x` not visible, plus each `[role=dialog]` box against the viewport)

- 1440×900 Detail: none; dialog 60..1380.
- 375×812 Detail: `span.jira-detail-agent-child-text 262>99` — the parent-live line's deliberate ellipsis (`ChildSessionLine`'s skin), not an overflow.
- 1440×900 menu: `.jira-run-label` / `.jira-run-sub` on the long skill rows and the parent `execute` sub-line — the row's existing ellipsis, which the mock
  draws too (`Work TIMIFY-27763 end to …`). Menu panel 410..710, inside the viewport.
- 375×812 menu: the same skill-label ellipsis; menu panel 12..363 of 375.
- No page scrolls sideways at either width.

## Regions

parent-live-line.png
- Head crumb: **match** — `· in` then the parent key + summary underlined in the link green, `· SP-04-Nov` after.
- Agent band, empty shape: **match** — title, `default: Work it end to end`, then `Parent TIMIFY-27763 · Working · microservice →` under the sub-line, Run at the right.
- Parent line dot: **deviation** — the mock's grey dot is the session tone dot (green for Working), and its `Running · 12m` is `STATE_LABEL`'s `Working` with no age (spec §4.3).
- `+1 more`: **match** to spec §4.3 (the mock has a single parent session, the fixture two).
- `Parent` fact: **deviation** — the mock draws it as plain ink; spec §4.1 makes the fact's value the same link, and the spec wins.
- 375 px: **defect, fixed** — the button is an atomic inline box, so `· in` was orphaned on its own line above the wrapped link. Now `.jira-detail-crumb-parent`
  (inline-flex) keeps `· in` beside the link, whose text wraps in place. The parent line ellipsises beside the Run chip at 375, as the child line does.

run-on-toggle.png
- `Run on` head over a two-segment well: **match** — grey recessed well, the picked parent segment raised white, key over `parent story`.
- Built in rows: **match** — `Work it end to end` with `Work TIMIFY-27763 end to …` and the default mark, `Open with the ticket loaded` / `A session, you drive`.
- Skills section and footer: **match**.
- Panel placement: **match** — hangs under the Run chip at the Agent band's right edge.

## Screenshots

`/private/tmp/claude-501/-Users-andrejajevtic-Documents-custom-projects-backlog-manager/4b63af8b-ab23-4c22-8717-346bcfbecb74/scratchpad/uiv/live-detail-1440.jpg`, `live-detail-375.jpg`, `live-menu-1440.jpg`, `live-menu-375.jpg` (same directory).
