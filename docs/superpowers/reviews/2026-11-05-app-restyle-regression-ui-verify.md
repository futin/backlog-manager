# App restyle (after plan 4) — regression /ui-verify, 2026-11-05

Branch `feat/app-restyle`, worktree `backlog-manager-restyle`, HEAD `b47c0d7c` at the start. A LIGHT pass: not a full mock comparison, only "did plan 4's shell
change — rail tiles, `.rail-group` / `.rail-count` / `.rail-foot`, rail on `--board` and `.maincol` on `--strip`, the status pills and their popovers, one runs
poll per tab (`OrchestratorRunsProvider`) and the shell-level `PullRequestsProvider` — break a page that the two earlier verdicts already passed".

**Verdict: PASS** after one fix (R1, `e4898333`). No other regression.

## Method

- Locally cached Playwright library, headless Chromium, node scripts in the session scratchpad (the Playwright MCP was down). Light theme (`daylight`).
- The branch's own Vite on `127.0.0.1:5197` (pid 61625) proxying to the user's API on 4322; mocks on `python3 -m http.server 5198` (pid 61627). The user's docker
  stack on 5177/4322 was only read.
- **Baseline build.** `git archive b0005a9d` (the last commit before plan 4) of `client shared vite.config.ts package.json tsconfig.json`, served by a second Vite
  on `127.0.0.1:5199` (pid 96190, restarted as pid 212 with `fs.strict: false` so the fonts load through the symlinked `node_modules`). Every scenario ran on both
  builds with the same fixtures and the outputs were diffed line by line — so anything identical on both is, by construction, not plan 4's doing.
- **Fixtures.** `page.route('**/api/**')`: plan 3's runs / archive / PRs / watchdog / ticks fixtures, a `/api/jira/sessions` fixture covering plan, working,
  permission, answer, quiet, lost and ended on My tasks keys, and an `/api/projects` patch that makes three projects `source: 'files'` (live data has no Files
  project, so the Files page would otherwise be empty). Every other GET went to the live API; every non-GET was answered 503 and logged — none fired.
- Per scenario at 1440×1000, 600×1000 and 390×844: the overflow probe and type scan from the earlier passes, plus a shell probe — ground colours of body / rail /
  `.maincol` / `.main`, the well's corner radius, rail and main rects, rail↔content overlap, `elementFromPoint` hits after scrolling (sticky rail over content), and
  for every open overlay its hits at the centre, over the rail and over the strip (z-order).

## Inventory (28 scenarios × 3 widths, 76 screenshots)

- Jira: Board, List, Sessions, Setup, Detail dialog, Launch sheet, Run menu.
- Runs: History, Watchdog, Ticks, run Detail.
- GitHub: PR Inbox, Matrix, Cards, Merge menu.
- Files.
- Narrow menu open on each section (Jira, Runs, GitHub, Files) — narrow widths only.
- Pill popovers: Jira pill over List and over Runs, GitHub pill over Matrix and over Sessions.

## Results

**Geometry.** `all-now.txt` and `all-pre4.txt` (392 lines each) differ only in:

- the rail ground — `rgb(244,244,243)` (`--board`) now, `#fff` before: plan 4's intended change; `.maincol` white, `.main` `--board` with its 24 px corner at
  1440 and 0 px at the narrow widths, as specified;
- the plan-4 Jira popover's new size, and the GitHub pill's name (`Tracker:` → `GitHub`): intended;
- the narrow menu's height (R1 below).

Every overflow line, every overlay hit, every sticky-rail hit and every scroll position is otherwise identical on the two builds.

**Z-order.** The Detail dialog's and the Launch sheet's scrims cover the rail and the strip at every width; the Run menu, the Merge menu and all four pill
popovers are topmost at every sampled point; under 700 px the popovers become bottom sheets. The sticky rail never overlaps page content at 1440.

**Type scan.** No line under the 11 px floor, no uppercase outside `.rail-kicker`. No page errors.

**Screenshots against the mocks** (`docs/superpowers/specs/2026-11-05-jira-restyle-mockups/`): Jira Board, Jira Launch sheet, Runs History and PR Inbox at 1440,
Jira Sessions at 390 — rail on `--board`, `.maincol` white, the well's corner and the pills all as mocked; nothing the earlier verdicts passed has moved.

## Regressions

- **R1 — narrow open menu ran past the viewport; fixed in `e4898333`.** Plan 4's tiles and `.rail-group` gaps grew the open phone menu from 862 to 889 px at
  390×844, and from 990 to 1024 px with Files projects, which outgrows even 600×1000. The bar is sticky and could not scroll, so `.rail-foot` (version chip,
  `API connected`) sat at 822–872 in an 844 px viewport and was unreachable until the document itself ran out. Fix: the ≤700 px `.rail` takes
  `max-height: calc(100vh / var(--font-scale, 1))` and `overscroll-behavior: contain`; `overflow-x: hidden` already makes the y-axis `auto`, so the open menu now
  scrolls itself. Re-measured at 390×844, 600×1000 and 700×600 on all four sections: open rail = viewport height, scrolled to its end the foot is fully inside the
  viewport and hit-testable, and the closed bar is still 53 px. Guards: `design-guards`, `daylight-contrast`, `rail-bar-style`, `motion-style`, `rail`, `nav`,
  `shell-strip`, `ui-kit-guard`, `ui-kit-tokens`, `chevrons`, `live-bar-style`, `runs-list-scroll-style`, `ui-modal-scroll-style`, `csp` — 163/163 pass;
  `pnpm run typecheck` clean.

## Pre-existing states (not regressions)

- **P1** (PR Inbox at 390): looks the same as at plan 3; not separately measured.
- **P2** Matrix scrolls sideways at 390 (`prs-matrix-scroll 619>294`): still reproduces.
- **P3** `runs-row-project` ellipsis: still reproduces.
- **P4** `run-track-name 54>39` at 390: still reproduces.
- **P5 (new to the record, not new to the code)** Runs History at 1440×1000 outgrows its fixed-height `.runs-board`: the live sheet is `flex: none` (392 px live,
  803 px with the fixture) and the history sheet keeps its 240 px minimum, so the document reaches 1085–1496 px; the rail's sticky containing block `.shell` is
  only 1000 px tall, so the rail scrolls off with it. Identical on the pre-plan-4 build; Ticks is 72 px taller, as plan 3 already recorded. Not fixed here.
- Every other overflow line is a deliberate ellipsis or scroll box and is identical on both builds: List / Sessions title, cut and branch cells,
  `jira-issues-scroll 1120>550`, `jira-run-label` on Setup at 390 and in the Run menu, `sheet-title`, `run-drawer-item-verify-tail 11>0`,
  `board-card-assignee 35>27`, the `ui-ledger` scroll boxes.

## Artefacts

Session scratchpad `ui-verify-regress/`: `now/` and `pre4/` (screenshots and per-scenario output), `all-now.txt`, `all-pre4.txt`, `menu-5197-390.jpg` (the cut
foot before the fix), `menu-fixed-390.jpg` (the foot reached by scrolling the menu after it), `menufix.mjs` (the re-measure).

## Teardown

pids 61625 (Vite 5197), 61627 (mocks 5198), 96190 and 212 (baseline Vite 5199) were killed by pid; 5197, 5198 and 5199 confirmed free.
