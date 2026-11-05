# Runs + GitHub restyle (plan 3) — /ui-verify, 2026-11-05

Branch `feat/app-restyle`, worktree `backlog-manager-restyle`. Method: `~/.claude/skills/ui-verify/SKILL.md`, driven by the locally cached Playwright library (headless
Chromium 1246) because the built-in browser pane was hidden and cropped its shots to 706×189 (autopilot decision 57). The branch's own Vite on `127.0.0.1:5197` (pid 88597)
proxying to the user's API on 4322; mocks served by `python3 -m http.server 5198` (pid 88592). Light theme. Viewports 1440×1000, 600×1000 (under the 700 px
`NARROW_QUERY` fold) and 390×844. Precedence: spec `2026-11-05-app-restyle-design.md` §4.6–§4.8, §6, §9 over the mocks; the design guards (`test/design-guards.test.ts`,
the 11 px floor, the one uppercase rule, CSP) over both. The user's docker stack on 5177 was read (GET only) to tell a regression from a pre-existing state.

**Verdict: PASS** after the fix commit — seven defects found (D1–D7), all fixed and re-measured. Four pre-existing narrow-width states (P1–P4) reproduce identically on
`main` and are listed, not fixed: they are outside this plan's diff.

## Live vs fixture

Fixtures are `page.route('**/api/**')` handlers built from `shared/types.ts`. GETs to the endpoints below are fulfilled; every other GET continues to the live API;
**every non-GET is answered 503 and logged** — none was logged in any scenario, and no page error was raised.

| State | Source |
| ----- | ------ |
| History tiles, machine-time bar, past-run ledger, past-run detail (`run-20261018-214053`, PR-opened line) | **live** |
| Live runs: running, paused, crashed (`fresh: false` + watchdog record), failed with fix-exhausted attention, a 14-item run with every stage, aborted branch-mode, remote (Linux) | **fixture** — `/api/orchestrator/runs` (live runs + fixtures prepended) and `/api/orchestrator/archive` (`current` set, so `mergeRuns` lists them) |
| Watchdog off / idle / armed (`nextTickAt` +42 s, 3 watched, 9 events of every kind) | **fixture** — `/api/agents/watchdog` (`WatchdogStatus`) |
| Ticks: 5 live projects, `backlog-manager` halted at 3 in a row, ixray streak 2, brickwright given 15 entries (1 failed, 1 skipped) | **live** + fixture entries |
| PRs: 11 open across 5 repos — failing+behind, conflicting, pending, armed, approved, draft, changes requested; release-kit with auto-merge off and three methods; ui-kit sync off with an armed PR (#33); lookout forbidden; guide-manager empty | **fixture** — `/api/prs` (`PullRequestsPayload`) |

## Inventory

| Mock | Live view | 1440 | 600 | 390 |
| ---- | --------- | ---- | --- | --- |
| Runs.dc.html | Runs › History: tiles, machine time, Live cards, detail | ✓ | ✓ | ✓ |
| Runs.dc.html | Run detail (paused, crashed, running, remote, past with PR) | ✓ | ✓ | ✓ |
| RunsOps.dc.html | Runs › Watchdog (off, idle, armed) | ✓ | ✓ | ✓ |
| RunsOps.dc.html | Runs › Ticks | ✓ | ✓ | ✓ |
| PRs.dc.html | GitHub › PRs › Inbox + Merge menu | ✓ | ✓ | ✓ |
| PRsLayouts.dc.html | GitHub › PRs › Matrix (+ expansion, Merge menu on the last row) | ✓ | ✓ | ✓ |
| PRsLayouts.dc.html | GitHub › PRs › Cards | ✓ | ✓ | ✓ |

## Geometry (overflow script: every element with `scrollWidth > clientWidth + 1` and `overflow-x` not visible, plus page sideways scroll)

No view scrolls the page sideways at any width. `sr-only` lines are ignored. Remaining lines after the fixes, all scroll boxes doing their job:

| View | Width | Line | Reading |
| ---- | ----- | ---- | ------- |
| Watchdog Activity | 600 / 390 | `DIV.ui-ledger 524>504`, `524>294` | the Ledger's own sideways scroll (was 702 before D6) |
| Ticks Activity | 390 | `DIV.ui-ledger 465>294` | same (was 1213 at EVERY width before D6) |
| Matrix | 600 / 390 | `DIV.prs-matrix-scroll 745>504`, `619>294` | the table scrolls inside its box, dot + PR sticky (DESIGN §8.11) |
| History rows | 1440 | `SPAN.runs-row-project 109>53…160>81` | project names ellipsize in the past-run ledger — P3 |
| Run detail StageTrack | 390 | `SPAN.run-track-name 54>39…` | stage names clip — P4 |

Type scan (own-text under 11 px, uppercase outside `.rail-kicker`): **no line** on any view at any width.

Height: the Ticks page at 1440×1000 now stands 72 px taller than the viewport (figures 116 px + Projects 657 px + Activity at its 120 px floor). That is the
price of D5's fix and is the right one — before it the three figures were drawn 5 px tall.

## Per region

### History — tiles and machine time (Runs.dc.html) — 1440, 600, 390

- Runs tile: status bar over glyph-count lines (`3 running`, `4 paused`, `101 done`, `16 aborted`, `4 failed`) — **match**.
- The other four tiles carry no bars — **deviation**, spec §4.6 draws a breakdown only on Runs.
- Done is grey in the bar — **deviation**, `runTone` (§4.1): done is not a problem tone.
- Tile label text comes from `Figure` — **deviation**, primitive owns the type.
- Machine time: one stacked bar across the sixth cell, legend in `MACHINE_STAGES` order, existing mark tokens rather than the mock's hex — **match** / **deviation** (§6).
- Legend value sat at the far edge of its cell and read as the next swatch's number — **D1, fixed**: value now sits beside its word (`dispatched 127h 10m`).

### History — Live cards (Runs.dc.html) — 1440, 600, 390

- Card with tone stripe, state pill, mono-ground id, `N of M items` meter — **match**.
- Stripe rather than the mock's dot — **deviation**, plan Task 6.
- Meter label above the bar — **deviation**, `Meter` primitive.
- Crashed card: red stripe, `⚠ crashed` pill, `no heartbeat for 46m · …` second line — **match**.
- Meta line kept machine and age at the leading edge; the mock packs `remote · Linux · age` to the trailing edge — **D2, fixed** (`.runs-card-id + * { margin-left: auto }`).

### Run detail (Runs.dc.html) — 1440, 600, 390

- Head: project, id on steel ground (§8.1), status as coloured `runs-status` text rather than a pill — **deviation**, same element the crash derivation writes.
- Remote sentence `controls live on the machine that ran it` capped at 20ch and wraps — **deviation**, #233's cap (styles.css `.run-detail-remote`).
- Facts grid (Started, Machine, Base · mode, Cost), pill chips (merged / skipped / attention / fix loops / active / queued) — **match**. Machine fact on remote runs only
  — **deviation**, DESIGN §8.4.1.
- Items: outcome pill and stage-span line — **match**; StageTrack kept and the mock's per-item stage bar not built — **deviation**, plan.
- `PR opened · backlog/run-2026-10-18-2 → main · #302` closes the sheet — **match**.

### Watchdog (RunsOps.dc.html) — 1440, 600, 390, off / idle / armed

- Status band: ring tile, dot + `Watching 3` / `Idle · nothing to watch` / `Off · BM_AGENTS off`, sub with `next check in 42s` once, sweep meter, `Policy in Settings ›` —
  **match** (the countdown appearing once is intentional).
- Watching sheet head with a count pill — **match**.
- Policy as three figures below the band, not a row inside it — **deviation**, spec §4.7 `FigureStrip`.
- Activity as a five-column ledger with kind pills, not the mock's timeline — **deviation**, spec §4.7 / DESIGN §8.4.2.
- Activity detail never wrapped (`.watchdog-table td`'s `nowrap` out-ranked the detail rule) — **D6, fixed**, shared with Ticks.

### Ticks (RunsOps.dc.html) — 1440, 600, 390

- 12-cell strip per project, oldest left, newest last (31 entries → 12 cells, last title `12:02 · execute #266 · failed`; 15 → 12; 2 → 2) — **match**.
- Halted project: red `3 failures in a row` pill, reason line, `Reset`; ixray amber `2 failures in a row`, no Reset; the pink row fill is gone — **match** (the red
  pill is intentional).
- Breaker / last 24 h / policy figures collapsed to 5 px at 1440×1000 — **D5, fixed** (see Defects). Pre-existing on main (14 px there) but it hid the page's only figures.

### Inbox (PRs.dc.html) — 1440, 600, 390

- Triage `Segmented` with counts — **match** in content; it drew the default stroked skin, three loose chips beside a track-skinned layout switch — **D3, fixed**
  (`track`). No level dot inside an option — **deviation**, plan Task 3.
- Row: checks `GlyphTile` (red ×, amber clock, green ✓), `#n` + title + repo, checks and mergeability pills, `author · head → base · age` — **match**.
  Pills carry no icon and the meta line sits on its own line rather than beside the pills — **deviation**, `Pill` primitive and DESIGN §8.11 row anatomy. No author
  avatar or branch glyph, branch not mono — **deviation**, spec §4.8 names neither; one face (DESIGN §1).
- Split Merge: ink only for the page's primary (`#485` approved), outline otherwise — **deviation**, plan Task 2's primary rule; the mock fills every Merge.
- Blocked half drew a SOLID border and ink word — **D4, fixed**: dashed `--hairline2` border, `--ink3` word.
- `Auto-merge on` on an armed PR (`#482`), enabled, menu row `Disable auto-merge` — **match**.
- Merge menu on `#485`: Merge / Enable auto-merge / Update branch, one line each, the primary row ticked, popover 1100–1380 px, no clipping ancestor — **match**. The mock's
  `Checks` button and `Open on GitHub` menu row are not built — **deviation**, spec §4.8 draws Open as the icon button only and names no Checks control.

### Matrix (PRsLayouts.dc.html) — 1440, 600, 390

- Header counts as pills (Checks 1 red; Review 2, Mergeable 1, Base 1 amber), problem cells as pills, every other cell plain ink — **match**.
- `running` and `squash` in the in-motion tone, `—` for no auto-merge where the mock draws a green `on · squash` pill and `off` — **deviation**, DESIGN §8.11 (colour
  marks problems; `live` is in motion).
- Worth-a-look dot is `--mustard` (the `paused` Dot tone), not the mock's amber — **deviation**, `LEVEL_DOT` / `Dot` has no amber tone.
- Titles wrap rather than ellipsize — **deviation**, DESIGN §8.11.
- Expansion panel after the Ledger, blocked half reading `checks failing` — **match** (the position is intentional). No failing check names — **deviation**, no
  per-check data is served (spec §2; autopilot decision 24).
- Merge menu from the panel hung right-anchored over the side rail (popover x 140–420, the pane starts at 264) — **D7, fixed**.

### Cards (PRsLayouts.dc.html) — 1440, 600, 390

- One card per repo with open PRs, `N open` pill, polled age, compact rows with the same tile, pills and split; empty repo counted in the toolbar
  (`1 repo with no open PRs`); forbidden repo in the toolbar note; sync-off pill and sentence in ui-kit's card — **match**.
- Cards stack in one column, not the mock's two-up grid — **deviation**, DESIGN §8.11 "Grouping (Cards)".
- Head tile is the worst row's checks tone, not a repo glyph; polled age under the name rather than at the right — **deviation**, plan Task 4 / `SheetHead` slots.

## Defects

| # | Region | Was | Fix | Re-measured |
| - | ------ | --- | --- | ----------- |
| D1 | History machine-time legend | value right-aligned in a `1fr` cell, nearer the next swatch | `.run-bars-item` columns `8px auto auto`, `justify-content: start`; value not right-aligned | value beside its word at 1440; no entry overflows its cell at 1440 / 600 / 390 (both legends) |
| D2 | Live card meta | machine and age at the leading edge | `.runs-card-id + * { margin-left: auto }` | `remote Linux 18m` / `42m` at the trailing edge |
| D3 | Inbox triage | default stroked `Segmented` | `track` prop, as the layout switch | one recessed ground; `prs-inbox.test.tsx` asserts `ui-seg-track` |
| D4 | Split Merge, blocked | `dashed` + `outline` both passed; `.ui-split-outline` (later, equal weight) repainted the border solid and the word ink | `PrActions` passes the outline skin only when the half is not blocked | `ui-split ui-split-28 ui-split-dashed`, `border-top-style: dashed`, word `rgb(107,107,107)`; test asserts no `ui-split-outline` on a blocked half |
| D5 | Ticks figure strip | `.ui-figure-strip` (`overflow: hidden`, so automatic min-height 0) shrank to 5 px inside the fixed-height `.runs-board` flex column | `.watchdog-monitor > :not(.watchdog-activity) { flex-shrink: 0 }` — only Activity gives up height | strip 116 px at 1440×1000; Watchdog unchanged (902 px board, Activity 215 px) |
| D7 | Matrix Merge menu | right-anchored under a leading-edge split: over the rail | `.prs-matrix-panel .prs-keys-merge > [role='dialog']:not([class*='narrow']) { left: 0; right: auto }` (the Jira Status chip's flip) | popover 304–584 at 1440; narrow bottom sheet untouched (12–588 at 600, 12–378 at 390) |
| D6 | Watchdog + Ticks Activity detail | `.watchdog-table td { white-space: nowrap }` (0,1,1) beat `.watchdog-table-detail` (0,1,0): never wrapped | `.watchdog-table td.watchdog-table-detail`, plus `overflow-wrap: anywhere` | Ticks ledger fits at 1440 and 600 (was 1213 px in 1104); Watchdog 702 → 524 at 600 |

No new `color-mix` tint (daylight PINNED and the twenty-one count untouched); no `ui-*` token in a page selector; no `style=` / `<style>`.

### Pre-existing, reproduced on main (5177) — not fixed

| # | Where | State |
| - | ----- | ----- |
| P1 | Inbox / Cards row at 390 | the repo name sits beside the title and squeezes it to ~150 px, five-line titles |
| P2 | Matrix at 390 | the 60cqw sticky PR cell breaks titles mid-word (`refactor(agen` / `ts)`) |
| P3 | History past-run ledger | project names ellipsize at 1440 (53–81 px shown) and collapse at 390 |
| P4 | Run detail StageTrack at 390 | stage names clip (`dispatched` 54 > 39 px) — §8.4.3 untouched by this plan |

## Parked checks

1. **Keyboard reach to the Matrix expansion panel.** The row `tr` (`pr-mrow-<key>`) carries `aria-expanded="true"` and `aria-controls` equal to the panel's `id`
   (`:r2l:-expand` = `:r2l:-expand`). From the expanded first row it takes **22 Tabs** to reach the panel's first control (`Merge #471`): two stops per remaining row
   (`tr`, then the `#n` link) across the 11 rows. That is the cost autopilot decision 53 accepted for keeping the panel outside the scroll box; a screen reader can
   follow `aria-controls`. Not a defect; a skip link or moving focus into the panel on expand would be a follow-up idea.
2. **The Sheet around the Matrix does not clip the Merge menu.** On the last row (`futin/ui-kit#34`) the menu has **no clipping ancestor** at 1440, 600 or 390, and
   the document width stays the viewport's. The right-edge case is the Inbox / Cards split (popover 1100–1380 in a 1440 viewport, no clipping ancestor). The one
   fault found was placement, not clipping — D7.
3. **Auto-merge-armed PR on a sync-off repo** (`futin/ui-kit#33`): the main half reads `Blocked` in the dashed skin (after D4), accessible name `Auto-merge on #33`,
   `aria-disabled="true"`, `title="sync off"`, `aria-describedby` → `sync off`; the chevron stays enabled and opens the menu, whose rows read `sync off`. Renders
   sanely at all three widths.

## Docs to change (not edited here — another agent holds them)

- `.claude/DESIGN.md` §8.11 (Matrix): the open row's Merge menu hangs from the split's LEFT edge (D7), the Jira Status chip's flip.
- `.claude/DESIGN.md` §8.11 (Inbox): the Triage `Segmented` uses the `track` skin, the layout switch's own (D3); the blocked split half is the dashed skin alone (D4).
- `.claude/DESIGN.md` §8.4.2 / §8.4 Ticks: only the Activity sheet shrinks in the monitor column; every other child keeps its content height (D5), so Ticks may
  scroll the page at short viewports.
- `docs/subsystems/board.md`: nothing found that names these mechanics.

## Screenshots

All under `/private/tmp/claude-501/-Users-andrejajevtic-Documents-custom-projects-backlog-manager/90b0ff1b-2d6c-4d71-b760-6e545b1f69c8/scratchpad/ui-verify-runs-github/`:

- Mocks: `mock-Runs.jpg`, `mock-RunsOps.jpg`, `mock-PRs.jpg`, `mock-PRsLayouts.jpg`
- History: `history-{1440,600,390}.jpg`, `history-*-tall.jpg`, `crop-history-1440.jpg` (D1, D2 after)
- Detail: `detail-run-20261018-214053-{1440,600,390}.jpg`, `detail-run-uv-{paused,crashed,running}-1440.jpg`
- Watchdog: `wd{Off,Idle,Armed}-{1440,600,390}.jpg`, `wdArmed-*-tall.jpg`
- Ticks: `ticks-{1440,600,390}.jpg`, `ticks-fixed-1440.jpg` (D5 after), `ticksBox-1440.jpg`
- PRs: `prs{Inbox,Matrix,Cards}-{1440,600,390}.jpg`, `crop-inbox-top.jpg` (D3, D4 after), `crop-blocked.jpg` (D4 before), `prsMenuInbox-crop-1440.jpg`,
  `prsMenuMatrixLast-view-{1440,600,390}.jpg` (D7), `prsExpand-view-{1440,390}.jpg`, `crop-prs-390.jpg`
- Main comparison: `../main-cmp/prsInbox-390.jpg`, `../main-cmp/prsMatrix-390.jpg`, `../main-cmp/crop-390.jpg` (P1, P2)

## Tests

`pnpm exec jest test/design-guards.test.ts test/daylight-contrast.test.ts test/csp.test.ts test/prs-actions.test.tsx test/prs-inbox.test.tsx test/prs-matrix.test.tsx
test/prs-view.test.tsx test/runs-view.test.tsx test/tick-monitor.test.tsx test/watchdog-monitor.test.tsx test/stage-bars.test.tsx` — 11 suites, 376 tests, all pass.
`pnpm run typecheck` clean. No shared hook gained a caller.
