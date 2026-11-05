# Jira restyle (plans 1 + 2) — /ui-verify, 2026-11-05

Branch `feat/app-restyle`, worktree `backlog-manager-restyle`. Method: `~/.claude/skills/ui-verify/SKILL.md` with the built-in browser pane (Playwright down). The branch's own Vite on
`127.0.0.1:5197` (pid 52962) proxying to the user's API on 4322; mocks served by `python3 -m http.server 5198` (pid 52961). Light theme. Viewports 1440×1000, 600×1000 (under the
700 px `NARROW_QUERY` fold) and 390×844 where a parked item named it. Precedence: the two 2026-11-05 specs and `.claude/DESIGN.md` guards over the mocks.

**Verdict: FAIL** — 21 defects (D1–D21), most of them column widths and narrow-width layout; none is a missing feature.

## Live vs fixture

| State | Source |
| ----- | ------ |
| Board shelves, cards, Detail dialog, Move-to, Run menu, List rows, Setup (connection, boards, repos, worktrees, skills), Launch sheet | **live** (timify.atlassian.net, board My tasks `b_315394d3`, 36 issues / 7 cards) |
| Sessions empty state (0 sessions, My tasks, 7 d) | **live** |
| Agent deck (6 live cards), Sessions table filled, List Session column with live states, Session actions menu | **fixture** — `window.fetch` patched for `/api/jira/sessions` only, shapes from `shared/types.ts` (`JiraSessionsPayload`, `DashboardRow`): TIMIFY-26359 plan, -20521 working, -15868 permission (context), -20942 answer (skill), -20939 quiet, -20940 lost (branch link, dashboard surface), -20941 ended |

Nothing was written: no Start session, no Remove/Confirm/Make default, no Save. The skill-row `×` was opened and dismissed with `Keep`. Fetch patch removed at the end.

## Inventory

| Plan | Mock | Live view | 1440 | 600 | 390 |
| ---- | ---- | --------- | ---- | --- | --- |
| 1 | RunButton.dc.html (col A) | Card split Run + Run menu | ✓ | – | ✓ |
| 1 | Card.dc.html | Board card | ✓ | ✓ | ✓ |
| 1 | Board.dc.html | Board shelves | ✓ | ✓ | ✓ |
| 1 | Modal.dc.html | Detail dialog + Move-to | ✓ | – | ✓ |
| 2 | JiraList.dc.html | Board › List | ✓ | ✓ | ✓ |
| 2 | JiraSessions.dc.html | Jira › Sessions (filled + empty) | ✓ | ✓ | – |
| 2 | JiraSetup.dc.html | Jira › Setup | ✓ | ✓ | ✓ |
| 2 | JiraLaunch.dc.html | Launch sheet + agent deck | ✓ | – | ✓ (sheet) |

## Geometry (overflow script: every element with `scrollWidth > clientWidth + 1` and `overflow-x` not visible, plus page sideways scroll)

- Board 1440 / 390: page clean (`docW = vw`). Only `SPAN.jira-card-crumb` ellipses (by design), e.g. `360>245 [Work it end to end · microserv]`, `285>121 [↳ TIMIFY-20938 [Nest Migration]`.
- List 1440: `DIV.jira-issues-scroll 1175>1150` — the extra 25 px is the Run split spilling its 80 px cell (D1); page clean. Priority `td` ellipsis on every `Not prioritized` row (D2).
- List 600: `DIV.jira-issues-scroll 1198>550` (box scrolls, page does not — OK); Session cells clip the age (D4).
- Sessions 1440: `TD.jira-list-ctx 86>84 [18%]`, `TD 72>68 [Desktop]`, `TD.jira-list-run 132>88 [Work it end to end]`, `184>88 [Open with the ticket loaded]`,
  `SPAN.jira-list-branch 315>80`, `SPAN 130>80 [dev-api-graphql-proxy]` (D13–D15).
- Sessions 600: `DIV.jira-list-scroll 1120>550` (box scrolls, page does not — OK) plus the same cell list.
- Launch sheet 1440: `INPUT.set-text 273>218` (branch Name field; text input, acceptable). Body scrolls `919>838` inside a 952 px sheet.
- Launch sheet 390: `SPAN.sheet-title 434>247`, `SPAN.launch-tile-title 61>35 [End to end]`, `76>35 [Ticket loaded]`, `SPAN.launch-tile-sub 104>35`, `86>35` (D18).
- Setup 1440 (worktrees expanded): `SPAN.jira-wt-path 446>208`, `530>177` (ellipsis, has title — OK); measured: `.jira-wt-list` 288–830 inside `.set-group` 264–825, repo `×` at 814–830 (D19).
- Setup 390 (worktrees expanded): **page scrolls sideways, docW 590 vs 390**; collapsing the toggle returns docW to 390 (D19).
- Setup 600: `.jira-setup-skill` computed `flex-direction: column`; `INPUT.jira-setup-add-path` 172×160 (D20, D21).

## Per region

### Board shelves (Board.dc.html) — 1440
- Steel ground, tone dots, white count pills, column order: **match**.
- Agent deck above the shelves: see JiraLaunch below.

### Card (Card.dc.html) — 1440
- Head (type tile, key, crumb), title, who row (disc, status dot + word), split Run: **match**.
- Repo branch glyph 10 px vs spec §4.2's 14 px: **defect D6**.
- Priority pill horizontal padding 7 px vs 8 px: **defect D7**.
- Foot order — match Marker before repo, spec §4.2 says repo, match, tree: **defect D8** (from source, `JiraCard.tsx:164` vs `:169`; match state not exercised live).
- Ended line `run ended 2h ago · Reopen` under the foot: **match**.
- Crumb ellipsis in the head: **match** (by design).

### Run button + Run menu (RunButton.dc.html col A) — 1440, 390
- Split Run, grouped menu, 40 px rows, default marked in place, 11 px group heads, footer: **match**.
- Popover radius 12 vs spec 14: **deviation** (the `Popover` primitive's radius, shared by every menu).
- Skill tile glyph reads as `+` rather than the mock's sparkle: **deviation** (it is `GlyphTile`'s `sparkle` at 28 px).
- Context row sub-line `Open with the ticket loaded` repeats its own label: **defect D12** (spec §4.1 prescribes the words, so it needs a spec ruling).
- 390: the narrow panel is `position: fixed; top: auto` and stays glued while the page scrolls; bottom rows and footer unreachable: **defect D11**.

### Detail dialog + Move-to (Modal.dc.html) — 1440, 390
- Head, agent band, empty state, facts grid: **match**. Description/Children sit in the Ticket column leaving the left column empty: **pre-existing** (same on main).
- Priority pill pushed to the far right of its fact value (`margin-left: auto` from `.jira-card-prio`): **defect D9**.
- Move-to at 1440 (current row first with tick, category dots, footer): **match**.
- Move-to at 390 covers its own Status chip: **defect D10**.

### List (JiraList.dc.html) — 1440, 600, 390
- Columns: Session first, Key without a type tile, Type column kept: **deviation** (app spec §4.2 keeps today's columns).
- Filter button icon-only with badge, mock draws a `Filter` word: **deviation** (pre-existing `FilterBar` chip).
- Run cell: **defect D1**. Priority: **defect D2**. Summary: **defect D3**. Session age: **defect D4**. Hover at rounded corners: **defect D5**.
- 390: the box scrolls, the page does not: **match**.

### Sessions (JiraSessions.dc.html) — 1440, 600
- Empty state (live): centred title naming board and window, why-line, `Go to the board` / `Show 30 days`: **match**.
- Segmented `All / Needs you / Working / Ended` with counts, stripes on rows, Live/Ended group heads: **match**.
- State column holds `Waiting for plan approval` beside its dot: **match** (parked check OK).
- Open cell: **defect D13**. Context / Where / Run clipping: **defect D14**. Repository cell no title: **defect D15**.
- 600: box scrolls, page does not: **match**.

### Agent deck (JiraLaunch.dc.html, right column) — 1440, fixture
- Inset 3 px stripe in `sessionTone`, state dot + word + age, key (+ `↳` for folded), 2-line summary button, 4 px context meter, split Open: **match**.
- Main half ink only for needs-you, outlined for working and quiet: **match**.
- Age sits inline after the state word, mock right-aligns it: **deviation** (spec §4.5 lists "state word with phase and age", no placement; DESIGN §8.9.1 deck paragraph).
- Crumb `run · repo · …` renders at **16 px / ink**, larger than the 14 px title: **defect D16**.
- Lost card's collapsed Open (`Open in Dashboard`, no menu rows) is ink although `lost` is not needs-you: **defect D17**.
- Main half reads `Open in Desktop` while the menu's row reads `Dashboard` (narrow wording): **deviation**, minor — both come from `openButtons(..., { wide: false })`.
- Session actions menu (1440, first card): end-aligned to the chevron, hangs ~55 px left of the card into the gap, not clipped, no sideways spill: **OK**.

### Launch sheet (JiraLaunch.dc.html, left column) — 1440, 390
- Three picture tiles with the picked one inked, `A skill / 3 on this machine`: **match**.
- `Open in` and `Repository` as `Segmented`: **match**. Branch section (New/Continue, Base, Name, open-MR switch): today's control, **match** (spec §5.3).
- Prompt box: steel box with the `Copy` chip inside top-right, text padded clear of it: **match**. Set in Hanken, not mono: **deviation** (DESIGN §1/§8.1 guard: no monospace; spec §4.5 says mono).
- `Assign to me` + `Move to` on one row; Model / Effort / Permissions on one row of selects; Remote control switch with its line: **match**. Switches are the house Off/On pill
  (`ui/Switch`, DESIGN §8.2), not the mock's iOS toggle: **deviation** (guard).
- Foot `Starts in microservice on a new worktree` · `Copy prompt` · ink `Start session`: **match**.
- 390: tiles keep three columns at 95 px, text box 35 px (`End to …`, `Ticket l…`, `plan, ch…`): **defect D18**.

### Setup (JiraSetup.dc.html) — 1440, 600, 390
- Connection banner (initials disc, `Connected as`, site · token kind, three figures, `Healthy` pill): **match**.
- Boards as rows with fact chips, polled age, `Edit` + `Open`, `New board` head action: **match** (`Edit` is today's action; mock's `⋯` not in spec).
- Repositories: key pill, path as steel code span, worktree-count toggle, labelled `Base branch` / `Branch name` with `(default)`: **match**.
- Worktree list expanded: overflows the card at 1440 and widens the page at 390: **defect D19**.
- Skills: built-ins then `Skills on this machine · 3`, tile, label, command sub-line, `default` / `Make default`, `×`: **match** at 1440. The user's skills are named
  with their command, so label and sub-line repeat — data, not code.
- Skills at ≤700 px stack into five lines per row; long command label has no ellipsis: **defect D20**.
- Add-repository row at ≤700 px: path input 172×160: **defect D21** (pre-existing on main — same rule).

## Defects

| # | View | What is wrong | Likely file / selector | Fix |
| - | ---- | ------------- | ---------------------- | --- |
| D1 | List 1440 | Split Run (93 px) in the 80 px Run cell (56 px content) spills 24 px past `.jira-issues-scroll`'s right border, flush to the viewport edge; source of `scrollWidth 1175>1150` | `styles.css` `.jira-issues-table thead th:nth-child(10)` | Run column ≈112 px (or act padding 8 px), paid from Session 150 → ~120 |
| D2 | List | `Not prioritized` pill 85.3 px in an 84 px content box: `td` ellipsis cuts the pill's right edge and draws `…` outside it, on almost every live row | `th:nth-child(6)` (Priority, 108 px) | 116 px; fix the comment's spelling `Not prioritised` |
| D3 | List | Double ellipsis / cut under-count in Summary (`DevAPI/Spec Migration to Nest… …`, `… 2 u…`): title and `.jira-issues-under` are inline in an ellipsising `td` | `JiraIssueList` summary cell | Wrap in `.jira-issues-flex`, title `min-width: 0` + ellipsis, `.jira-issues-under { flex: none }` |
| D4 | List 1440/600 | Session age clipped for needs-you words (`Waiting for plan a…`, `Waiting on your a…`) though the CSS comment says the age is the reading | `JiraIssueList` session cell / `.jira-issues-session` | Age in a `flex: none` span; only the word ellipsises |
| D5 | List 1440 | Row hover tint paints square past the box's 12 px rounded bottom corners (box has no clip at wide widths) | `.jira-issues-row:last-child td:first-child / :last-child`, thead corners; likely `.jira-list-row` too | Matching `border-*-radius: 11px` on the corner cells |
| D6 | Card | Repo branch glyph 10 px vs spec §4.2 14 px | `JiraCard.tsx:170` | `size={14}` |
| D7 | Card | Priority pill padding 7 px vs spec 8 px | `.jira-card-prio` | `padding: 0 8px` |
| D8 | Card | Foot order is match, repo, tree; spec §4.2 is repo, match, tree | `JiraCard.tsx:164` vs `:169` | Move the match `Marker` after `jira-card-repo` |
| D9 | Detail | Priority pill pushed to the far right of its fact value | `.jira-card-prio { margin-left: auto }` reused in `.jira-detail-facts` | `.jira-detail-facts .jira-card-prio { margin-left: 0 }` |
| D10 | Detail 390 | Move-to narrow popover covers its own Status chip (panel top = chip top + 8): fixed panel's static position is the flex start of `.jira-detail-status` | `.jira-detail-status` / `Popover.tsx` narrow path | Make `.jira-detail-status` block/inline-block, or set the narrow panel's `top` from the anchor rect |
| D11 | Run menu 390 (card + List) | `.ui-popover-narrow` is `fixed; top: auto`: stays glued while the page scrolls (anchor 702→402, panel stayed 711–1034); on the List the panel ran to 930 in an 844 viewport — last rows and footer unreachable | `Popover.tsx:55,85`, `styles.css:3994` | Bottom sheet (`top: auto; bottom: 12px; max-height: 70vh; overflow-y: auto`) or top/max-height from the anchor via CSSOM, closing on scroll |
| D12 | Run menu, Setup | Context row's sub-line `Open with the ticket loaded` equals its label | `JiraRunMenu.tsx:86`, `JiraSkillsGroup.tsx:26` | Sub-line `A session, you drive` (mock); needs a spec §4.1 ruling |
| D13 | Sessions 1440 | Open cell 124 px (100 content) vs split `Open in Desktop` 148 px: overlaps For; ended row's Reopen + Run wraps to a 72 px row | `.jira-list-table thead th:nth-child(10)` | ~192 px, paid by Started 120 → 96 and Ticket; or a shorter label |
| D14 | Sessions | `▬ 18%` 86 px in 84 (`1…`); `Desktop` 72 in 68; Run clipped (`Work it e…`) with no title | `th:nth-child(7)`, `th:nth-child(5)`, `.jira-list-run` | Context 96, Where 80; `title` on `.jira-list-run` |
| D15 | Sessions | Repository cell ellipsises `dev-api-gra…` and the branch with no title | `td.jira-list-repo` in `JiraSessionList.tsx` | `title={`${repo} · ${branch}`}` |
| D16 | Deck | Crumb renders at 16 px / `--ink` (inherited) — larger than the 14 px title; it moved out of `.jira-card-head` (12 px, `--ink3`) into `.jira-deck-face` | `.jira-card-crumb` under `.jira-deck-face` | `.jira-deck-face .jira-card-crumb { font-size: 12px; color: var(--ink3) }` |
| D17 | Deck | Lost card's collapsed Open is ink; spec §4.5: ink only while the session needs you | `SessionOpen.tsx:73` (`!hasRows` → `OpenChip ... primary`) | `primary={needsYou(state)}` |
| D18 | Launch sheet 390 | Three tiles stay side by side at 95 px; text box 35 px (`End to …`, `plan, ch…`) | `.launch-tiles` | Under the narrow fold, one column (or drop the sub-line) |
| D19 | Setup | Expanded worktree list is wider than its card (`.jira-wt-list` to 830 in a card ending 825, repo `×` at 814–830); at 390 the page scrolls sideways (docW 590) | `.jira-setup-trees` (flex child, `min-width: auto`), `.jira-wt-branch` (`nowrap`, no shrink) | `.jira-setup-trees { min-width: 0 }`; `.jira-wt-branch { min-width: 0; overflow: hidden; text-overflow: ellipsis }` |
| D20 | Setup ≤700 | Skill rows take the narrow `.set-row { flex-direction: column }` reset: tile, label, sub-line, Make default and `×` each on their own line; the long label overflows the card by 2 px at 390 with no ellipsis | `.jira-setup-skill` vs `@media (max-width: 700px) .set-row` (`styles.css:1075`) | Keep `.jira-setup-skill { flex-direction: row; align-items: center }` under the fold; `.jira-run-text { min-width: 0 }` + label ellipsis |
| D21 | Setup ≤700 | Add-repository path input becomes 172×160: `flex: 1 1 160px` turns into a height once the row is a column (the hazard `styles.css:1070` describes) — pre-existing on main | `.jira-setup-add-path` | `flex: 1 1 auto` under the fold, or exempt `.jira-setup-add` from the column reset |

## Parked checks

- Move-to popover at 390 → **D10**.
- Plan-1 ledger minors (`jira-restyle/progress.md:40,51`): glyph 10 vs 14 → D6; pill 7 vs 8 → D7; repo before match → D8; crumb `margin-left: auto` lost → OK visually (the crumb fills the
  head's remaining width and ellipsises); ended line after foot → OK live (no test, as parked). Task-5 "live-state label row at narrow width" → **not exercised** (Detail with a
  live session at ≤700 px was not opened); reused `.jira-card-*` names in the dialog → D9 is the visible consequence.
- Session actions near the bottom edge → OK: no flip, the page scrolls to reveal it; deck card at 1440 hangs left into the gap, unclipped. Detail's session card → not exercised.
- Run menu at 390 → **D11**.
- Card / List hover tint at rounded corners → List **D5**; card not re-checked.
- List at 1440 sideways scroll → page none; the box's 25 px is D1.
- Sessions at 1440 → Repository no title **D15**; State fits — OK.
- Launch sheet at full width → OK (regions above); at 390 → **D18**. Copy chip → OK: fixed `aria-label="Copy"` is deliberate (the foot chip carries `Copied`), minor
  WCAG 2.5.3 label-in-name note while it reads `Copied` for 2 s.
- Setup skills row, long templates → **D20** (no ellipsis); Confirm inside the nowrap row at narrow width → wraps cleanly at 390 (`Remove` / `Keep` under the sentence), but
  only because D20 already turned the row into a column — re-check once D20 keeps it a row.
- `--stripe` nesting → OK: `.ui-stripe` is used in two places only (`JiraAgentDeck.tsx:67`, `JiraSessionList.tsx:323`), never nested, and every instance carries `data-tone`;
  the inheritance is latent.
- Rest-restyle parked list (`jira-rest-restyle/progress.md`): Task 4 deck Session actions spill → OK; Task 5 Run menu at 390 → D11, hover tint → D5, List 1440 → D1;
  Task 6 → D15 / State OK; Task 7 → D18 / Copy OK; Task 9 code-span treatment on setup path, skill command, worktree path → match; Confirm in skills row → see above;
  long templates → D20.

## Screenshots

`/private/tmp/claude-501/-Users-andrejajevtic-Documents-custom-projects-backlog-manager/90b0ff1b-2d6c-4d71-b760-6e545b1f69c8/scratchpad/ui-verify-jira/`:
`list-1440-run-spill.jpg`, `list-1440-run-spill-mag.jpg`, `list-600.jpg`, `board-deck-1440-live.jpg`, `board-deck-1440-mag.jpg`, `deck-session-actions-menu-mag.jpg`,
`mock-JiraLaunch-1440.jpg`, `launch-sheet-1440-norepo.jpg`, `launch-sheet-1440-prompt.jpg`, `launch-sheet-390.jpg`, `mock-JiraSetup-1440.jpg`, `setup-1440-top.jpg`,
`setup-1440-worktrees-expanded.jpg`, `setup-600-skills-stacked.jpg`, `setup-600-repos-addrow.jpg`, `setup-390-repos-sideways.jpg`, `setup-390-skill-confirm.jpg`,
`sessions-600.jpg`; every frame of the run, mocks and live, in order: `seq/001-…` to `seq/128-…` (the pane scales 1440 to 800 px, so detail frames were magnified with a body
transform).

Note: after a 390 → 600 resize the pane once kept a 1.51 visual-viewport zoom; it was cleared by resetting to desktop and re-emulating. Every number above is layout
(`getBoundingClientRect`, `scrollWidth`), not read off a zoomed frame.

Servers: pids 52962 (Vite 5197) and 52961 (http.server 5198) killed by pid after an `lsof` check; 5177/4322 untouched.

## Re-measure after cb995d1c

Method: Vite on 5197 (pid-owned, killed after) proxying the live API, `/api/jira/sessions` fixtured by a patched `window.fetch`, light theme, widths 1440 / 600 / 390,
the skill's overflow script per view. Setup at 600 and 390 was measured inside same-origin iframes of that width, because the pane kept a stale 1340 px layout viewport.
Screenshots: `remeasure/` in the session scratchpad.

Per defect:

- D1-D12, D14-D18: fixed. Proven by the layout numbers re-read at 1440, 600 and 390 (no element past the viewport, bottom sheets scroll with every row reachable).
- D13: partly fixed. The ended-row Open cell still stacks its label: it would need about 192 px and Ticket is guard-limited to 170 (design-guards). Left, minor.
- D19: not fixed by the wave. Fixed here: `.jira-setup-repo { flex-wrap: nowrap }`, so one long worktree path no longer widens the card (docW 1579 -> 1425 at 1440, `×` inside card).
- D20, D21: fixed (Setup skill rows stay rows at 600 and 390, add-path input 489x36 / 279x36).

New defects from the wave, both fixed here:

- N2: the live Run split `Running · 1h` is 140 px of content in a 112 px Run column and overflowed. Column is now 164 px (ready split 93 px).
- N3: under 700 px the phone block's `.set-row { align-items: flex-start }` beat `.set-row-stacked`, so the expanded worktree list sized to its content (542 px in a 489 px row at 600).
  Fixed with `align-items: stretch` on `.jira-setup-repo`.

Still open:

- N1: Sessions Where cell `Dashboard` is 88 px in an 80 px column (clipped). Minor, left.

Overflow output after the fixes (elements past the viewport, non-fixed): List, Sessions, Detail + Move-to, Run menu (390 sheet), deck card, Launch sheet: none at 1440 / 600 / 390.
Setup: 1440 none (docW 1425); 600 none (docW 585 = viewport less scrollbar); 390 none (docW 375).
