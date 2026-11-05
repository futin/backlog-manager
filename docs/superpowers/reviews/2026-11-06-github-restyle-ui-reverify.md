# GitHub views after #473 — /ui-verify re-run, 2026-11-06

`main` at `fc31d538`. Own Vite on `127.0.0.1:5199` (pid 69237, killed after), proxying to the docker API on 4322. Driven by the cached Playwright library (headless
Chromium), light theme, 1440×1000 (+ 600 spot checks). Harness: scratchpad `harness.mjs` (scenario JSON → `page.route` fixtures, overflow scan, JPEG shots).
Fixtures: `/api/prs` built from `shared/types.ts` `PullRequest` — 7 PRs over 2 repos: failing, failing + approved + behind, changes requested + behind, conflicts,
pending, draft, auto-merge armed. Every non-GET answered 503; none fired. The docker build on 5177 renders identically to the branch Vite (same geometry numbers).

**Verdict: FAIL.** The #473 pass recorded most of the differences below as "deviations" justified by its own plan or DESIGN.md, not by a design guard — so the
mock lost to the plan. The user's reading (Inbox looks unstyled, the board ground is cut) is right on every point checked.

Mocks: `docs/superpowers/specs/2026-11-05-jira-restyle-mockups/` — `Board.dc.html`, `PRs.dc.html`, `PRsLayouts.dc.html`.

## Geometry

No page scrolls sideways at 1440 or 600. Only overflow line: `SPAN.board-card-proj-name 137>132` (×3) on the GitHub Board — an ellipsized project name, intended.

## Board (Board.dc.html)

| Region | Verdict | Reading |
| ------ | ------- | ------- |
| Column ground | **defect B1** | GitHub columns have no ground at all — cards sit straight on the well. The mock draws a `--steel` radius-16 ground per column. Spec §4.3 limited the ground to Jira; the user overrides that. |
| Column height | **defect B2** | Jira column grounds end at their last card: `In Progress` (0 issues) is a 40 px strip, `Done` (1 issue) ends at y≈365 while `To Do` runs past the fold. Mock: all columns one height, down to the well's foot. Cause: `.board-columns { align-items: start }` (`client/src/styles.css:1126`). |
| Column head, dot, count | match | |

## PRs › Inbox (PRs.dc.html)

| Region | Verdict | Reading |
| ------ | ------- | ------- |
| Row ground | **defect I1** | Rows are boxless with a hairline between (DESIGN §8.11 "Row anatomy"); the mock draws every row as its own white, bordered, rounded card with a gap. This is the "wrong css" — Matrix and Cards sit on white sheets, Inbox rows float on the grey well. |
| Status tile | **defect I2** | 32 px faint tile; mock 40 px. |
| Pills | **defect I3** | Text-only; mock leads each check/mergeability pill with its glyph (✕, ✓, clock). Counts (`2 of 9`) need data the payload lacks — deviation. |
| Meta line | **defect I4** | Pills and meta on two lines, repo name inline after the title; mock: pills then `author · head → base · age` on ONE line, branch in mono. |
| Head | **defect I5** | `N open` pill alone at the band's right, layout switch on its own toolbar row, `polled` far right. Mock: band sub-line `● N open in M repos · polled 1m ago`, layout switch at the band's right. Same head in Matrix and Cards mocks. |
| Triage | **defect I6** | No level dot in each option; mock draws red / amber / grey dots. (No pressed option by default is by design — no `all`.) |
| `Quiet` heading | defect I7 | A bare 13 px word between rows; reads as stray text once rows are cards. |
| Auto-merge pill | **defect I8** | `auto-merge · squash` is the solid `live` fill — the one solid pill among tints, loudest thing on the page. Mock: tinted. |
| Merge menu | **defect I9** | Row icons ~12 px bare glyphs; mock 28 px tinted tiles. Default-row tick not visible at 1440 (check). |
| Blocked split | match | Dashed `Blocked` half, as the matrix mock draws. |

## PRs › Matrix (PRsLayouts.dc.html)

| Region | Verdict | Reading |
| ------ | ------- | ------- |
| Table, header counts, problem pills, dots | match | |
| Title | defect M1 | Wraps to two lines; mock one line with ellipsis, repo short name beneath. |
| Auto-merge cell | deviation | `squash` text vs mock `on · squash` pill — DESIGN §8.11 colour rule. |
| Head | defect I5 | as Inbox. |

## PRs › Cards (PRsLayouts.dc.html)

| Region | Verdict | Reading |
| ------ | ------- | ------- |
| Grid | **defect C1** | One card per row at 1440; mock two-up. DESIGN §8.11 recorded this as a deviation without a guard behind it. |
| Card head | defect C2 | Checks-tone tile, `futin/…` full name, polled age under the name, pill far right. Mock: dark repo glyph tile, short name, `N open` pill beside the name, polled age at right. |
| Rows | defect I4 | Shared `PrRow` — same two-line spread as Inbox; mock compact. |

## Screenshots (scratchpad `shots/`)

`mock-board.jpg`, `live-board-1440.jpg`, `live-board-full.jpg`, `live-jira-1440.jpg` (B2), `mock-prs.jpg`, `mock-prslayouts.jpg`, `rx-inbox-1440.jpg`,
`rx-inbox-menu-1440.jpg`, `rx-matrix-1440.jpg`, `rx-cards-1440.jpg`.

Not checked: narrow widths beyond the overflow scan, dark theme.
