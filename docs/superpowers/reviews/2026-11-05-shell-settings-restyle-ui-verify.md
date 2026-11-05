# Shell + Settings restyle (plan 4) — /ui-verify, 2026-11-05

Branch `feat/app-restyle`, worktree `backlog-manager-restyle`, from HEAD `0a05909b`. Method: `~/.claude/skills/ui-verify/SKILL.md` and the plan 3 precedent
(`2026-11-05-runs-github-restyle-ui-verify.md`), driven by the locally cached Playwright library (headless Chromium) because the Playwright MCP was down. The
branch's own Vite on `127.0.0.1:5197` (pid 64833) proxying to the user's API on 4322; mocks served by `python3 -m http.server 5198` (pid 64830). Light theme.
Viewports 1440×1000, 600×1000 (under the 700 px `NARROW_QUERY` fold) and 390×844. Precedence: the design guards (`test/design-guards.test.ts`, the 11 px floor,
uppercase only in `.rail-kicker`, the CSP) over spec `2026-11-05-app-restyle-design.md` §3, §4.9–§4.10, §5, §7, over the mocks.

**Verdict: PASS** after fix commit `d93ddff8` — eight defects found (D1–D6, D8, D9), all fixed and re-measured. Two shapes are kept as deviations (below).

## Live vs fixture

Fixtures are `page.route('**/api/**')` handlers built from `shared/types.ts`; GETs to these are fulfilled, every other GET continues to the live API, and **every
non-GET is answered 503 and logged** — none was logged, and no page error was raised in any scenario.

| Endpoint | Fixture |
| --- | --- |
| `/api/orchestrator/runs` | plan 3's runs fixture — 7 live runs, so the Runs count draws `7` |
| `/api/prs` | plan 3's PRs fixture — 3 need you, so the GitHub count draws `3` |
| `/api/dashboards` | the live payload plus a third remote, `Devbox` (account null, token unset, a long host name) |
| `/api/dashboards/machines` | the live payload plus `Devbox` at 91 % (5 h) / 40 % (week) |

Everything else — Jira status, trackers, settings, watchdog, timezone, tick policy — is the user's live API, read with GETs only.

## Inventory

| Mock (`specs/2026-11-05-jira-restyle-mockups/`) | Live surface | Scenarios |
| --- | --- | --- |
| `Shell.dc.html` — rail, status pills | `SideRail`, `ServiceChips` | `shell`, `clickGh`, `clickRuns` |
| `Shell.dc.html` — Jira popover open | `JiraChip` → `ServiceHead` | `jiraPop` |
| (same head, GitHub) | `TrackerChip` → `ServiceHead` | `ghPop` |
| `Settings.dc.html` — Local | `SettingsView` Local | `local` |
| `SettingsMore.dc.html` — Shared | Sources, Orchestrator watchdog, Backlog tick, Time zone | `shared` |
| `SettingsMore.dc.html` — Dashboards | `SuggestCard`, `DashboardsList`, `DashboardDetail` | `dashboards` |

## Geometry (overflow script: every element with `scrollWidth > clientWidth + 1` and `overflow-x` not visible, plus page sideways scroll)

After the fix, at 1440, 600 and 390:

```
shell        no OV, no sideways scroll (Board lines below excepted)
jiraPop      no OV                     [role=dialog][Jira] 1086,47 330x337 @1440 · 12,667 576x321 @600 · 12,511 366x321 @390
ghPop        no OV                     [role=dialog][Tracker] 988,47 330x726 @1440 · 12,288 576x700 @600 · 12,241 366x591 @390
local        no OV
shared       no OV
dashboards   no OV
TYPE scan    no text under 11 px, no uppercase run outside .rail-kicker, in any scenario
rail @1440   .rail-link[GitHub|Jira|Runs|Settings] 216 wide (was 72–96)
             .rail-count[3 PRs need you] 196,87 22x20   (over the GitHub row, 77–117)
             .rail-count[7 live runs]    196,300 22x20  (over the Runs row, 290–330)
ground       body/rail rgb(244,244,243) --board · maincol #fff --strip · main --board with the corner · open row and rail-foot #fff
```

Before the fix the counts sat at `208,490` (1440) and `568,434` / `358,434` (phone menu), on top of each other mid-rail, and `.tracker-pop-sub` overflowed
`178>153` under `Sync now`.

Lines that are not this plan's: the Board's `board-card-proj-name` ellipsis and `board-card-assignee 35>27` (deliberate ellipses, unchanged by this plan), and
`runs-row-project` on Runs (plan 3's P3/P4, pre-existing).

## Per region

### Rail and ground (Shell.dc.html) — 1440, 600, 390
- Rows: full width after D1; the open row's white paper spans the rail as the mock's does. Sub-nav rows 178 wide under it. ✓
- Counts: centred over their own row's right end after D2, at every width, the Jira count included while its tree is open. ✓
- Ground: rail on `--board`, `.maincol` on `--strip` (decision 63), `.main` `--board` with the 24 px corner, white footer. ✓ (check b)
- Footer: version and `API connected`, no port (plan Task 12's expected difference). Brand tile glyph differs from the mock (deviation).

### Status pills and popovers (Shell.dc.html) — 1440, 600, 390
- Pills: `● GitHub 2m`, `● Jira 46 s`; Files pill has no age (expected). ✓
- Head: disc `AJ` after D5, name, `● connected ·` / `timify.atlassian.net` wrapping as the mock does after D3, `Sync now` right. ✓
- Figures: two `--strip-hi` tiles after D4 (`Last sweep` / `Calls`; GitHub `Last sweep` / `Rate limit`). ✓
- Rows: today's per-board and per-repo rows (plan Task 7), `Jira setup ↗` / `GitHub page ↗` last. The Jira sweep is site-wide (ruling). ✓

### Settings › Local (Settings.dc.html) — 1440, 600, 390
- One column (spec §4.10, DESIGN §8.6), cards Display, Board, Orchestrator, Dispatch, each `this browser`. Card heads have no glyph tiles (spec card anatomy). ✓
- Theme previews in each theme's own tokens (expected); Opens on is a `Segmented` (decision 64); long text behind `ⓘ more`. ✓

### Settings › Shared (SettingsMore.dc.html) — 1440, 600, 390
- Every row's hint is one line after D6; the paragraphs and per-project lines sit behind `ⓘ more`. ✓
- Watchdog status line is the phase word only (decision 65). Live view stays a row of its own (deviation 2). ✓
- Sources: status pill and link in the control slot (deviation 1). Backlog tick and Time zone match. ✓

### Settings › Dashboards (SettingsMore.dc.html) — 1440, 600, 390
- List rows: white `--strip` cards on the grey well after D8, picked row white with the ink outline, `5 h` / `week` after D9. ✓ (check c)
- Detail: Home facts Dashboard / Account / Token; remotes add Board and Machine name; account pill in the Account fact (ruling). ✓
- Status line is plain text, not the mock's green band; usage tiles use `Meter` with no big figure; Home has no Remove; Suggest card stays (spec). Deviations of record.

## Explicit checks

- **(a) Rail counts click through.** Before: FAIL — both counts hung from the sticky `.rail`, and a click at either landed on `NAV.rail` or a bare `DIV`; nothing
  navigated. After: PASS at every width — `elementFromPoint` at the count returns `SPAN.rail-label` inside `button.rail-link`, and the click navigates:
  `clickGh` from Runs → `section="github"`, `clickRuns` from GitHub → `section="runs"` (1440 also reads `aria-current=page` on the row; at 600/390 the menu
  closes on navigation, as designed). Both counts are `span role="img"`, never buttons.
- **(b) Shell ground** matches `Shell.dc.html` under decision 63 — see Geometry.
- **(c) Dashboards rows.** The reviewer was right: the rows were `background: none` inside a white `Sheet`, so they had no fill of their own. Fixed (D8).
- **(d) Overflow** is clean at 1440, 600 and 390 on the shell, Local, Shared and Dashboards, and with the Jira and GitHub popovers open.

## Defects

| # | Where | What | Fix (in `d93ddff8`) |
| --- | --- | --- | --- |
| D1 | `styles.css` `.rail-link` | rows shrank to their content (72–96 px); the open row's white was 91 px wide | `width: 100%` |
| D2 | `SideRail.tsx` | GitHub and Runs counts had no positioned wrapper; they hung from the sticky rail, overlapped mid-rail and ate the click; Jira's centred on row + open tree | each row's button and count share a `.rail-group`; the tree sits outside it |
| D3 | `styles.css` `.tracker-pop-sub` | `connected · timify.atlassian.net` clipped under `Sync now` (`nowrap`, 178>153) | wraps, dot pinned to the first line |
| D4 | `styles.css` `.tracker-pop-figure` | figures were hairline-topped columns; the mock draws tiles | `--strip-hi` tile, 10 px radius (a token, not a tint) |
| D5 | `JiraChip.tsx` | Jira disc drew `A`; mock and spec "initials disc" draw `AJ` | `initialsOf` from `lib/jira.ts` |
| D6 | `WatchdogGroup`, `TimeZoneGroup`, `SourcesGroup` | paragraph hints and ~10 repo lines broke spec §4.10 ("text longer than a line moves behind ⓘ more") | the mock's one-liners as hints, the long text in `more` |
| D8 | `DashboardsList.tsx`, `styles.css` | list rows had no fill inside a white Sheet; picked row `--steel` | rows are `--strip` cards on the well, no Sheet; picked keeps `--strip` with the ink edge |
| D9 | `DashboardsList.tsx` | row meters read `5 H` / `WEEK` — uppercase outside `.rail-kicker`; the mock and the detail say `5 h` / `week` | sentence case |

(D7 was considered and kept as deviation 1.)

## Deviations kept

1. **Sources pills** sit in the control slot, not beside the row name as the mock draws them. Moving them needs a new `SettingsRow` badge slot for one card.
2. **Watchdog foot**: the mock puts the status line and `Live view in Runs` in one foot; live keeps the status line and a `Live view` row
   (`settings-watchdog.test.tsx` pins the row names). The row's text is behind `ⓘ more` now, so it reads as one line.
3. Rulings and plan Task 12's expected differences, not defects: no API port, Jira count amber, `.rail-kicker` uppercase, theme previews in their own tokens, no
   sessions-in-use, the Files pill with no age, Local in one column, no glyph tiles in card heads, Dispatch with today's controls, the extra Board card, today's
   popover rows, the brand glyph, the plain Dashboards status line, `Meter` usage tiles, the Suggest card, no Remove on Home, and the fixture's `7 live runs`.

## Docs changed

`.claude/DESIGN.md` §8.0 (every row has a `.rail-group`; the popover figures are tiles and the sub wraps) and §8.6 (Dashboards rows), and
`docs/subsystems/board.md` (the rail count's `.rail-group`).

## Screenshots

In `/private/tmp/claude-501/-Users-andrejajevtic-Documents-custom-projects-backlog-manager/90b0ff1b-2d6c-4d71-b760-6e545b1f69c8/scratchpad/ui-verify-shell/`, after the fix:
- `shell-{1440,600,390}.jpg`, `clickGh-{…}.jpg`, `clickRuns-{…}.jpg`
- `jiraPop-{…}.jpg`, `ghPop-{…}.jpg`
- `local-{…}.jpg`, `shared-{…}.jpg`, `dashboards-{…}.jpg`
- mocks: `mock-Shell.jpg`, `mock-Settings.jpg`, `mock-SettingsMore.jpg`

## Tests

`pnpm exec jest` on rail, nav, jira-chip, jira-lib, settings-view, settings-watchdog, watchdog-hook, run-watchdog, sources-group, settings-timezone,
settings-dashboards, design-guards, daylight-contrast and csp: 564 passed after the four `sources-group` assertions that asked for "no button" were narrowed to
the link they meant (a row now carries `ⓘ more`). `pnpm run typecheck` is clean.
