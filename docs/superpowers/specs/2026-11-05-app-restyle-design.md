# App restyle — the rest of Jira, Runs, GitHub › PRs, the shell and Settings (design, 2026-11-05)

Companion to `2026-11-05-jira-restyle-design.md` (the "Jira spec" below), which covers the Run split button, the card, the columns and the detail dialog.
This spec covers everything else the user asked to remodel in the same pass "so we don't come back again in 1 week": the rest of Jira, Runs and GitHub,
and the shell (side rail, status chips) with every Settings page. The user reviewed nine boards on the canvas
https://claude.ai/artifact/58gdjicygUebSYgFeCU83M (version 9, after one comment round of 15 threads) and adopted all of them, and chose to keep the rail
always open (no collapsible icon rail).

Mocks: `2026-11-05-jira-restyle-mockups/` beside this file now holds every board, copied off canvas version 9. `00-mock-audit.md` there has a row per
board: what it draws, what the code has, what this spec builds. Where a mock and this spec differ, the spec wins; §6 lists what a mock drew that is not
built or is built differently.

## 1. Intent

The user's complaint about the Jira board — "too default" — holds for the whole app: rows of identical outlined chips, facts as grey label-over-value
pairs, native selects, paragraph-long descriptions, meters squeezed into 28 px. The Jira spec answers it for one page with four moves: a primary action
that looks primary (the ink split button), facts as small coloured marks (tile, dot, pill), a tone carried by a stripe or a dot instead of a painted block,
and one popover where a row of equal controls used to be. This spec applies the same four moves everywhere else, with the same tokens, so the app reads as
one product. It adds no palette: every colour is a token the board already has and every tint follows the tint-form guard.

## 2. Goals, non-goals, anti-goals

**Goals**

- Every page that has a primary action shows it once, as the Jira spec's split button (`ui/SplitChip`) where there is a default plus alternatives (Run,
  Merge, Open), and as one ink button where there is not.
- Every list of things with a state (sessions, runs, ticks, PRs, dashboards) shows the state as a dot, pill or stripe in the state's tone, plus the word.
- Filters collapse into one `Filter` chip with a count badge that opens a popover of chip groups.
- Settings rows are a label, a one-line description and a control; long text sits behind an info toggle; enum choices that change behaviour are picture
  or icon cards; numbers are steppers.
- The shell's rail rows carry an icon tile and one count shape; the two top-right chips become one status pill per service, with the detail in the popover,
  and the user can ask for a sweep now.

**Non-goals**

- No change to what any action does: Run, Merge, Auto-merge, Update branch, Reset, Resume, Stop, Remove (still copies a command), Add skill, Map a
  repository keep their routes, payloads and confirmations. The one new behaviour is Sync now (§5).
- No new data on any page except what §5 adds. Where a mock drew a number the server does not have, §6 says what is built instead.
- No applied-filters row (the count lives in the Filter chip and its popover, as the Jira spec already decided), no sort chips, no column `⋯` menus.
- No collapsible or icon-only rail (the user's answer on the canvas thread).
- No new theme tokens; no dark-only rules.

**Anti-goals**

- A guard goes red and is loosened to pass. The Jira spec §3's list holds here unchanged; §3 below adds the ones this scope runs into.
- Two looks for one thing: a PR, a session or a run drawn one way in one layout and another way in the next. The PR Inbox, Matrix and Cards share the status
  tile, pills and split Merge; the Jira deck, Sessions page and List share the session state words and tones.
- A painted block for a failure (today's pink Ticks row). Failure is a red stripe, dot or pill, never a background fill over a whole row.

## 3. Constraints

The Jira spec §3 applies in full (uppercase, 11 px floor, tint form, primitives block, dialog and popover counts, CSP, DESIGN.md). In addition:

- **Popover composers.** The Jira spec moves the count from seven to eight. This spec adds composers: the List and Sessions `Filter` menus (one shared
  `FilterMenu` component composing `Popover` once counts once), and the PR split Merge's menu if it does not reuse the Run menu's composer. The plan states
  the final number and moves it in the same three places the Jira spec names (`.claude/rules/board.md`, `useDialogEscape`'s comment,
  `test/dialog-count-docs.test.ts`). The DIALOG count does not move: nothing here adds a `Modal`, `FormSheet` or `Confirm`.
- **The server never writes git.** The worktree list's `Remove` keeps copying `removeCommand` and running nothing.
- **Source guards over shared hooks.** `test/run-pulse.test.ts` pins every `useOrchestratorRuns()` caller. The rail's Runs count reads the live-run count
  from a value the shell already has or from an existing caller passed down, never a new caller; if a new caller is unavoidable, the guard's list moves in
  the same commit with the reason. The same check (`grep -l <symbol> test/`) runs for every hook or poller a new view reads.
- **The pollers stay armed only while something is connected**, and the tracker, Jira and PR cache ages stay rendered values. Sync now (§5) runs one sweep
  of a poller that is already armed; it never arms one.
- **Every new route lives under `/api`** and the Vite proxy keeps its one entry.
- **Tick history exists**: `state.json`'s `recent` keeps the last 50 ticks (`skills/backlog-tick/tools/tick-state.mjs`), served newest first in
  `TickProject.recent`. The 12-tick strip (§4.7) reads it; nothing new is stored.
- **The rail's uppercase kicker.** `.rail-kicker` is the one uppercase rule. The rail header's sub-line (`this machine` on the mock) is that element, so
  it renders uppercase; the mock's lowercase is a mock rendering, the same call the Jira spec made for menu headers.

## 4. Decided

### 4.1 Shared pieces (built first; the pages compose them)

- **`ui/SplitChip`** — the Jira spec §4.1's control, reused unchanged by the PR Merge (§4.8) and the deck card's Open (§4.5). Its `dashed` state is the
  blocked state everywhere (Run with no repository, Merge that cannot merge), with the reason as the title and, in the Matrix, as the label.
- **State stripe** — a 3 px left edge in the state's tone on a row or card: needs you (amber), working (green), ended (grey), failed (red). Used by the
  Sessions rows, the deck cards and the live run cards. The tone is never the only carrier: the state word sits in the row.
- **`FilterMenu`** — a `Filter` chip with a count badge (number of non-default groups) opening a popover of labelled chip groups, a `Showing N of M`
  line and `Clear`. Used by the Jira List (Type, Assignee, Sprint — today's filters, options from the loaded issues) and Sessions (Repository, Run, and
  the ended-row window 24 h / 7 d / 30 d / All — today's selects).
- **Segmented with counts** — `Segmented` gains an optional count per option (Sessions' All / Needs you / Working / Ended; PR Inbox's triage tabs).
- **Stepper** — `NumberField`'s look becomes `−  value unit  +`; typing into the value still works, and min/max clamp as today.
- **Status pill** — a dot plus a word plus an age, in tone (green connected, amber late, red down); the shell chips (§4.9) and the Sources rows (§4.10).
- **Glyph tile** — the Jira spec's tinted tile, used by the rail rows, the PR status tile, the launch sheet's action tiles and Settings' picture cards.

### 4.2 Jira › List (`JiraIssueList`; mock `JiraList.dc.html`)

The table keeps its columns (Key, Summary, Status, Priority, Assignee, Sprint, Session, Updated). Each cell uses the card's marks from the Jira spec §4.2:
type tile before the key, status dot + raw status word, the three-tone priority pill (`Not prioritised` grey), the 22 px initials disc. The Session cell
reads the deck's state word and tone (`Working · 12m`, `Needs you · plan`, `ended 2h ago`, `—`). The split Run shows on row hover and on keyboard focus
within the row only, so a page of ink buttons never stacks up; it is always in the DOM and tabbable. The summary is one line with an ellipsis and the full
text as its title. The band's filters become the `FilterMenu` (§4.1); the band's sub-line keeps `JiraBandSub`.

### 4.3 Jira › Sessions (`JiraSessionsView`, `JiraSessionList`; mock `JiraSessions.dc.html`)

The state filter is a `Segmented` with counts; the other filters go into the `FilterMenu`. Rows carry the state stripe; the Ticket cell is key over summary;
State is the deck's word and tone with the phase (`Needs you · plan`); Repository is mono; Started is time · age. Each row ends in the deck's action for that
state (§4.5). The Cost column is built only if the session's dashboard row carries a cost today; otherwise it is left out (the builder checks `row`). The
empty state is a centred block: a title naming the board and window (`No sessions on Globals this week`), one line on why, and two buttons — `Go to the
board` and `Show 30 days` (sets the existing window filter to 30 d; hidden when the window is already 30 d or All).

### 4.4 Jira › Setup (`JiraSetupView` and its groups; mock `JiraSetup.dc.html`)

- **Connection banner** on top: avatar, `Connected as <name>`, site and token scopes, then three figures (last sweep, every, calls · 429s) and a `Healthy`
  status pill. A disconnected or failing connection turns the banner's pill amber or red with today's error text.
- **Boards** become rows: name, then facts as chips (`6 roots`, `6 issues`, `every 1m`), then the polled age and `Open`. `New board` is the group's action.
- **Repositories** become one row per mapping: project key pill, path (mono), a worktree-count toggle chip, then labelled fields `Base branch` and `Branch
  name` (the placeholder text becomes `(default)` after the value when it is the default). The toggle expands `Open worktrees beside this checkout`: one
  `JiraWorktreeRow` per tree with branch, path, state pill, ticket pill and `Remove` (copies the command, as today).
- **Skills** use the Run menu's rows (Jira spec §4.1): built-ins first, then `Skills on this machine · N`, each with tile, label, command sub-line, and
  `default` or `Make default`. What a user adds here is what the Run menu shows.

### 4.5 Launch sheet and deck (`JiraLaunchSheet`, `JiraAgentDeck`, `JiraSessionCard`; mock `JiraLaunch.dc.html`)

- **Two doors, one sheet.** The split Run's left half opens the sheet with the default action picked; a Run menu row opens the same sheet with that row
  picked; a skill row lands on the third tile with the skill named. Nothing starts from the menu; `Start session` in the sheet is always the last click.
- **The sheet**: the action as three picture tiles (`End to end`, `Ticket loaded`, `A skill` — the third shows the picked skill's name, or `N on this
  machine` before one is picked); Repository and `Open in` (Terminal / Desktop app) as segmented controls; the prompt in a mono code box with `Copy`;
  `Assign to me` and `Move to In Progress` as two switches; Model, Effort and Permissions on one row of selects; Remote control as a switch with its one-line
  description; the foot says where it starts (`Starts in microservice on a new worktree`) with `Copy prompt` and the ink `Start session`.
- **The deck card**: state stripe; state word with phase and age; key + root pill; summary; repository; a context meter (today's context percentage); the
  split Open — main half opens the session as today, the chevron holds the other ways to open it (desktop, terminal). The main half is ink only when the
  session needs you; a working session's Open is outlined. Its label is today's action wording; `Review plan` on the mock is mock wording (§6).

### 4.6 Runs › History (`RunsView`, `StageBars`, `RunDetail`; mock `Runs.dc.html`)

- The five figure tiles stay, each gaining its own breakdown: Runs as a stacked bar of done / aborted / failed / live with the counts under it; the other
  four keep their number and one-line context.
- Machine time by stage is one stacked bar with a legend (stage, hours) in place of eight identical bars. Stage hues are tokens (§6), not the mock's hex.
- Live runs are cards: project, state pill (`paused`, `running`), run id, machine and age, `N of M items` with a progress bar. A click opens the detail.
- The detail's head holds the run's controls (Resume, Stop) and the `paused at a boundary` / `controls live on the machine that ran it` line; its facts are
  a glyph-labelled grid (Started, Machine, Base · mode, Cost); it opens on the timeline of its items, each with outcome pill, title, duration and its stage
  split; the run's outcome line (`PR opened · <branch> → main · #462`) closes it.

### 4.7 Runs › Watchdog and Ticks (`WatchdogMonitor`, `TickMonitor`; mock `RunsOps.dc.html`)

- **Watchdog** opens on a status band: the state (`Idle · nothing to watch`), `checked 12 s ago · next in 18 s`, and `Policy in Settings`; the policy sits
  in a row BELOW the status as three figures (Check every, Leave a resumed run alone, Give up after) — the user found them hard to read inline. Then
  `Watching N` (empty state as one line), then Activity (last 50, in memory) with the time, the event as an outcome pill and the detail.
- **Ticks** gives each project one row: name, a strip of its last 12 ticks (oldest left; `ok` green, `failed` red, anything else grey; hovering a cell titles
  it with time, kind, id and outcome), the last tick's line, and `Reset` on a halted project. A halted project carries a red `N failures in a row` pill and
  its reason; the pink row fill goes. The band and 24 h figure stay as today.

### 4.8 GitHub › Pull requests (`PrInbox`, `PrMatrix`, `PrCards`, `PrActions`; mocks `PRs.dc.html`, `PRsLayouts.dc.html`)

- **Inbox**: triage tabs as `Segmented` with counts (Needs you / Worth a look / Quiet). Each row leads with a status tile (red failing, amber pending, green
  ready), then title, then checks and mergeability as pills, then author · branch → base · age. The four outlined chips become one split Merge: the main
  half merges, or enables auto-merge while checks are still running; the menu holds Merge, Enable auto-merge and Update branch, each with one line on what it
  does; `Open on GitHub` becomes an icon button. A PR that cannot merge shows the dashed `Blocked` half with the reason as its title.
- **Matrix**: one row per PR, one column per fact (`MATRIX_COLUMNS`: checks, review, mergeable, base, auto-merge, plus Updated). Colour marks a problem only;
  each header counts its bad rows. The leading dot is the triage tone. One row expands at a time and shows the failing check names plus the Inbox row's
  actions; a blocked PR's Merge is the dashed half with the reason written in it.
- **Cards**: one card per repository with open PRs (none for a repo with nothing open), head `repo · N open · polled age`, then compact PR rows with the
  same status tile, pills and split Merge. A PR merged from this page stays as one quiet line until the next poll, as today; a repository that could not be
  read is one line under the cards, not a red card.

### 4.9 The shell (`SideRail`, `TrackerChip`, `JiraChip`; mock `Shell.dc.html`)

- **Rail header**: a glyph tile, `backlog manager`, and the `.rail-kicker` sub-line (§3). **Rows**: icon tile, label, count. The open section's pages are a
  quiet sub-list; the current page is a white (`--strip`) row, not a dot. The rail stays always open.
- **Counts** share one shape, the plain `.pill` with a number: amber when the number is things waiting on the user (GitHub: PRs that need you), grey
  otherwise (Jira: live sessions; Runs: live runs). Each count keeps the meaning its badge has today where one exists; `rail-badge` becomes this pill.
- **Footer**: version with a status dot, `API connected · 4322` beside it (the port the client actually talks to), keeping today's version click (the
  releases drawer). The dot reads whether the client's existing reads are answering — red with `API unreachable` when they fail; no new poller is added
  for it, and the builder picks which existing read it follows.
- **Top right**: one status pill per service (`GitHub ● 2m ago`, `Jira ● 9s ago`) replacing the meter chips. Green when the last sweep is on time, amber when
  it is late, red when the service is down. The popover keeps today's detail and gains a head: avatar, name, `● connected · <site>`, and `Sync now`; then
  two figures (last sweep with its interval, calls since start with 429s); then the per-board (Jira) or per-repo (GitHub) rows with their polled age and
  a per-row sync icon; then the setup link.

### 4.10 Settings (`SettingsView`, `SourcesGroup`, `TimeZoneGroup`, `WatchdogGroup`, `TickGroup`, `Dashboards*`; mocks `Settings.dc.html`, `SettingsMore.dc.html`)

- **All pages**: a `Local | Shared | Dashboards` segmented head with a sub-line saying where the page saves (`saves in this browser only` / `saved on the
  server`). One readable column of cards; each card has a title and a scope pill (`this machine`, `this server`); each row is a label, a one-line
  description and a control; text longer than a line moves behind an `ⓘ more` toggle (a button with `aria-expanded`).
- **Local**: Theme as picture cards, each a mini board drawn from that theme's own tokens (the preview element carries the theme's `data-theme`, so no
  colour is hard-coded); Density, Text size, Content width, Opens on as `Segmented`; Default merge mode as three icon cards (Merge into base, Leave branches,
  Open a PR) with one line each; the question-mode default and the dispatch defaults (Model, Effort, Permissions) as today's controls in the new rows.
- **Shared**: Sources — Files, GitHub, Jira as rows with a status pill and a link button (`Open`, `GitHub page`, `Jira setup`), and a foot `Last read
  <age> · Read again` (§5). Time zone as a select with the current offset. Orchestrator watchdog — an `Enabled` switch and three steppers, then its live
  status line and `Live view in Runs`. Backlog tick — three steppers (Halt after, Plans awaiting review, Open execute PRs).
- **Dashboards**: a two-pane page. The list: one row per machine with the prefer-order number, status dot, name, `this machine` tag, account pill and two
  meters (5 h, week) that turn amber then red near the limit, plus `Add a dashboard`. The detail: name with ↑ ↓ (prefer order), Edit, Remove; a status line
  (connected · spawn · sessions in use); two usage tiles (5-hour window, week) with reset times; Models and Efforts as pills, disallowed ones struck through
  with a title saying so; then the facts (dashboard URL, board URL, machine name, account). ↑ ↓ use the order Dispatch already reads; if no write exists
  for it today, the builder adds it to the existing dashboards write path rather than a new store.

## 5. Server additions

- **Sync now.** `POST /api/jira/sync` (optional `{ boardId }`) and `POST /api/tracker/sync` (optional `{ repo }`) ask the already-armed poller for one
  sweep now and return when it has finished, with the new cache ages. A poller that is not armed answers 409 and the button is disabled with that reason; a
  second call while a sweep runs joins it rather than starting another; calls closer than the poller's own interval floor (the builder sets it, at least
  5 s) return the last result without calling out. Both are reads of the outside service, so they respect the existing budget and 429 handling.
- **Read again** on the Sources card calls both and re-reads the registry; it shows the newest age when all three answer.
- Nothing else is added server-side. Every other number on these pages is served today.

## 6. Drawn on a mock, built differently or not at all

- Stage colours `#5c9a2e` and `#e9a24f` (Runs) and the theme-preview colours (Settings) are mock hex: the build uses stage tokens and each theme's own
  tokens.
- `Review plan` on the deck and Sessions rows is mock wording: the label is today's action wording for that state.
- The mock's 10.5 px and 11.5 px text, its uppercase micro headers and any lowercase kicker follow the Jira spec's rules (11 px floor, sentence case,
  `.rail-kicker` uppercase).
- The Cost column on Sessions is built only if the data is already served (§4.3).
- The `2 need you` sub-line under PRs in the rail is not built: the count pill already says it.
- `Squash and merge` wording: the menu names the merge the server performs today, not a method this app does not choose.
- The icon rail drawn on the first boards was a drawing shortcut; the rail is always open (§4.9).

## 7. Left to the builder

- Glyph paths for the new tiles (runs, PR status, settings icon cards), on the Jira spec's 14 px grid.
- The late threshold for a status pill (the sensible default: more than twice the sweep interval since the last sweep) and the meter thresholds for
  Dashboards (if Dispatch already has a skip threshold, use it; otherwise amber at 80 %, red at 95 %).
- Whether `FilterMenu` and the Run menu share a popover row rule; the primitives-block guard decides (declare once, in the block).
- The narrow-width behaviour of the rail, the PR Matrix (horizontal scroll inside the table, never the page) and the two-pane Dashboards (stacks).
- Focus order in every new popover: first enabled control on open, as the Run menu does.

## 8. Tests this changes or adds (behaviour and cases, not code — the plan states this override of writing-plans' literal-code rule)

- **`SplitChip` reuse**: the PR row has a button named `Merge #<n>` and `Merge options for #<n>`; the main half posts merge when checks pass and auto-merge
  while they run; the menu lists Merge, Enable auto-merge, Update branch; a blocked PR's main half is disabled with its reason as the title. Existing
  `/api/prs/*` call assertions keep their payloads.
- **`FilterMenu`**: the chip's badge counts non-default groups (0 hides it); picking a chip filters the rows and updates `Showing N of M`; `Clear` resets
  every group; Escape closes and returns focus to the chip. Jira List: options come from the loaded issues; Sessions: the window group drives the existing
  window state, and `Show 30 days` in the empty state sets it.
- **Segmented counts**: the count renders beside each label and is part of the option's accessible name.
- **Stepper**: − and + change the value by one step, clamp at min and max (the button at a bound is disabled), typing still works, and the existing
  NumberField tests keep passing against the new look.
- **Ticks strip**: a project with 15 `recent` entries draws 12 cells, newest right; outcomes map ok→green, failed→red, other→grey; each cell's title
  names time, kind, id and outcome; a halted project draws the red pill and Reset; no row carries the old fill class.
- **Watchdog**: the three policy figures render in their own row under the status line.
- **Rail**: every count is the same pill class; the GitHub count is amber exactly when PRs need you; the current page row carries `aria-current="page"`;
  the guard in `test/run-pulse.test.ts` still lists the same callers (or moves with a stated reason).
- **Status pill**: green, amber and red by sweep age and connection; the popover's `Sync now` posts once, disables while running, and shows the new age.
- **Sync routes** (jest, server): 409 when the poller is not armed; a concurrent second call joins the first sweep (one outbound call); a call inside the
  floor returns the cached result without calling out; an unknown `boardId` or `repo` is a 400.
- **Settings**: the info toggle has `aria-expanded` and reveals the long text; the theme cards set the theme; the merge-mode cards set
  `orchestrateDefaultMergeMode`; every card has its scope pill.
- **Dashboards**: ↑ on the first row and ↓ on the last are disabled; a move reorders the list and persists; a disallowed model renders struck through with
  its title.
- **Guards**: `daylight-contrast` `PINNED` gains every new tint site (state stripes are marks, not tints; pills and tiles are tints); `design-guards` stays
  green (one uppercase rule, 11 px floor, primitives declared once); `dialog-count-docs` moves to the final popover composer count.
- **Last task of each plan is `/ui-verify`**, comparing the live page at 1440 px against the mock it cites: List, Sessions (filled and empty), Setup (with
  worktrees open), launch sheet and deck, Runs History, Watchdog + Ticks, PRs Inbox, Matrix and Cards, the shell with a status popover open, and each
  Settings page.

## 9. DESIGN.md overrides (each plan carries the task for its sections)

- §8.0 Shell and rail: icon tiles, one count pill, current page as a white row, status pills replacing the meter chips, the popover head with Sync now.
- §8.4.1 History, §8.4.2 Watchdog: stacked breakdowns, live run cards, the detail timeline; the status band with policy below; the tick strip.
- §8.6 Settings: one column, scope pills, info toggle, picture and icon cards, steppers, the Dashboards two-pane page.
- §8.9.1 List and Sessions, §8.9.3 Setup, §8.9.5 Launch sheet: as §4.2–§4.5.
- §8.11 GitHub › PRs: the status tile, pills and split Merge in every layout.
- §8.7: the Popover composer count.

## 10. Order of work

Four plans, each ending in `/ui-verify` against its mocks, in this order: the Jira spec (it builds `SplitChip`, the marks and the glyph tile everything
else reuses); the rest of Jira (§4.1 shared pieces, §4.2–§4.5); Runs and GitHub (§4.6–§4.8); the shell and Settings (§4.9, §4.10, §5). Each plan cites the
mock file in every task that draws a view.

## 11. Rejected on the way

- A collapsible, icon-only rail with a hover fly-out (asked about on the canvas; the user kept the full rail).
- A whole-row pink fill for a failing tick project: a stripe or pill carries the tone without hiding the text.
- Four equal outlined chips on a PR row: the same "too default" problem as `Run ▾`.
- Meters inside the top-right chips: poll age and API budget are numbers to look up, not glance at; they live in the popover.
