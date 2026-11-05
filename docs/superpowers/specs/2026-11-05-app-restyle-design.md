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

- No change to what any action does: Run, Merge, Auto-merge, Update branch, Reset, Pause, Cancel, Stop, Resume, Remove (still copies a command), Add skill, Map a
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

- **Popover composers.** The Jira spec moves the count from seven to eight. `FilterBar` is restyled, not replaced, so it adds none. `SplitChip` stays
  menu-less, as the Jira spec §4.1 defines it — each menu is its own `Popover` composer — so the PR split Merge's menu is the ninth and the deck card's split
  Open menu the tenth.
  The plan states the final number and moves it in the same three places the Jira spec names (`.claude/rules/board.md`, `useDialogEscape`'s comment,
  `test/dialog-count-docs.test.ts`). The DIALOG count does not move: nothing here adds a `Modal`, `FormSheet` or `Confirm`.
- **The server never writes git.** The worktree list's `Remove` keeps copying `removeCommand` and running nothing.
- **Source guards over shared hooks.** `test/run-pulse.test.ts` pins every `useOrchestratorRuns()` caller and bars `App` from calling it; the shell has
  only a boolean `working` today. Any reader §4.9's counts need moves that guard in the same commit with the reason. The same check
  (`grep -l <symbol> test/`) runs for every hook or poller a new view reads.
- **Two documented rules this spec overrides** (the user adopted both mocks; §9 lists them): DESIGN §8.6 / `board.md` "the rail is the only switch" (pinned by `test/settings-view.test.tsx`) — the
  Settings page gains an in-page `Local | Shared | Dashboards` switch; DESIGN §8.0 / §8.9.4 "a reading with no links and no buttons" — the status popover
  gains `Sync now`, per-row sync icons and the setup link (the user asked for the sync button on the canvas).
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
- **State stripe** — a 3 px left edge in the state's tone on a row or card: every state maps to one tone. Sessions (`JiraSessionState`,
  `shared/jira-sessions.ts`): `plan` / `permission` / `reply` / `answer` amber, `starting` and `working` green, `quiet` and `ended` grey, `lost` red (there is
  no `failed` session state). Runs (`status`): `running` green, `paused` amber, `done` and `aborted` grey, `failed` red. Used by the Sessions rows, the deck
  cards and the live run cards. The tone is never the only carrier: the state word sits in the row.
- **`FilterBar`, restyled in place** — it is already a `Filter` chip with a count and a popover (Files, Archive, the Jira band). Its popover
  becomes labelled chip groups with a `Showing N of M` line and `Clear`; every page that uses it gets the new look, which is the point. No new component
  and no new Popover composer. The Jira List keeps Type, Assignee, Sprint (options from the loaded issues). Sessions has no `FilterBar` today (two
  `Select`s, a window `Select` and an `All tickets` chip, `JiraSessionList.tsx`); it gains one, and its Repository and Run selects, the ended-row window
  (24 h / 7 d / 30 d / All) and the `All tickets` scope move into it as chip groups. A new `FilterBar` user is not a new composer.
- **Segmented with counts** — `Segmented` gains an optional count per option (Sessions' All / Needs you / Working / Ended; PR Inbox's triage tabs).
- **Stepper** — `NumberField`'s look becomes `−  value unit  +`; typing into the value still works, and min/max clamp as today.
- **Status pill** — a dot plus a word plus an age, in tone (green connected, amber late, red down); the shell chips (§4.9) and the Sources rows (§4.10).
- **Glyph tile** — the Jira spec's tinted tile, used by the rail rows, the PR status tile, the launch sheet's action tiles and Settings' picture cards.

### 4.2 Jira › List (`JiraIssueList`; mock `JiraList.dc.html`)

The table keeps today's columns (Session, Key, Summary, Type, Status, Assignee, Sprint, Updated) and gains Priority after Status, as the mock draws. Each
cell uses the card's marks from the Jira spec §4.2: type tile in the Type cell, status dot + raw status word, the three-tone priority pill (`Not
prioritised` grey), the 22 px initials disc. The Session cell (filled today) takes the session's state word and tone: today's
`STATE_LABEL` words (`shared/jira-sessions.ts`, pinned by `test/jira-sessions-state.test.ts`) unchanged, plus the age (`Working · 12m`, `Waiting for plan
approval · 3m`, `Ended · 2h`, `—`). No label is renamed; `Needs you · plan` is mock wording. The split Run shows on row hover and on keyboard focus
within the row only, so a page of ink buttons never stacks up; it is always in the DOM and tabbable. The summary is one line with an ellipsis and the full
text as its title. The band's `FilterBar` takes the §4.1 restyle; the band's sub-line keeps `JiraBandSub`.

### 4.3 Jira › Sessions (`JiraSessionsView`, `JiraSessionList`; mock `JiraSessions.dc.html`)

The state filter is a `Segmented` with counts; the other filters, `All tickets` included, go into the restyled `FilterBar`. Rows carry the state stripe; the Ticket cell is key over summary;
State is today's `STATE_LABEL` word in its §4.1 tone (`Waiting for plan approval`, not the mock's `Needs you · plan`); Repository is mono; Started is time · age. Each row ends in the deck's action for that
state (§4.5). The Cost column is not built: the session row carries `contextPct` and no cost. The
empty state is a centred block: a title naming the board and window (`No sessions on Globals in the last 24 hours` / `… 7 days` / `… 30 days`, and
`No sessions on Globals` for All; with `All tickets` on, `No linked sessions` plus the same window phrase), one line on why, and two buttons — `Go to the
board` (through the `onOpenJiraPage` link the rail already threads down) and `Show 30 days` (sets the existing window filter to 30 d; hidden when the window is already 30 d or All).

### 4.4 Jira › Setup (`JiraSetupView` and its groups; mock `JiraSetup.dc.html`)

- **Connection banner** on top: an initials disc (no avatar is served: Jira gives `me.name` / `me.accountId`), `Connected as <name>`, site and the token kind (`tokenKind`; scopes are not served and are not drawn), then
  three figures (last sweep, every, sweep calls with the last 429's age when there is one — `calls.sweep`, `last429At`) and a `Healthy` status pill. A disconnected or failing connection turns the banner's pill amber or red with today's error text.
- **Boards** become rows: name, then facts as chips (`6 roots`, `6 issues`, `every 1m`), then the polled age and `Open`. `New board` is the group's action.
- **Repositories** become one row per mapping: project key pill, path (mono), a worktree-count toggle chip, then labelled fields `Base branch` and `Branch
  name` (the placeholder text becomes `(default)` after the value when it is the default). The toggle expands `Open worktrees beside this checkout`: one
  `JiraWorktreeRow` per tree with branch, path, state pill, ticket pill and `Remove` (copies the command, as today).
- **Skills** use the Run menu's rows (Jira spec §4.1): built-ins first, then `Skills on this machine · N`, each with tile, label, command sub-line, and
  `default` or `Make default`. `Make default` writes `jiraDefaultAction`, the same per-browser Local setting Settings › Local
  shows as its `Jira default action` row (that row's hint gains `Saved in this browser.`, a copy change); the page's server scope does not change that. What a user adds here is what the Run menu shows.

### 4.5 Launch sheet and deck (`JiraLaunchSheet`, `JiraAgentDeck`, `JiraSessionCard`; mock `JiraLaunch.dc.html`)

- **Two doors, one sheet.** The split Run's left half opens the sheet with the default action picked; a Run menu row opens the same sheet with that row
  picked; a skill row lands on the third tile with the skill named. Nothing starts from the menu; `Start session` in the sheet is always the last click.
- **The sheet**: the action as three picture tiles (`End to end`, `Ticket loaded`, `A skill` — the third shows the picked skill's name, or `N on this
  machine` before one is picked); Repository and `Open in` (today's surfaces, Dashboard / Desktop — the mock's
  `Terminal` is mock wording) as segmented controls; the prompt in a mono code box with `Copy`;
  `Assign to me` as a switch and the transition as today's select over every offered transition (the mock's `Move to In Progress` switch would lose
  the choice), both on one row; Model, Effort and Permissions on one row of selects; Remote control as a switch with its one-line
  description; the foot says where it starts (`Starts in microservice on a new worktree`) with `Copy prompt` and the ink `Start session`.
- **The deck card**: state stripe; state word with phase and age; key + root pill; summary; repository; a context meter (today's context percentage); the
  split Open — main half opens the session as today, the chevron holds the card's other actions today (Stop, Unlink), each with its existing confirm; with neither drawn (Unlink only on a `branch` link, Stop only with `stopState`), the split collapses to the one Open button. The main half is ink only when the
  session needs you; a working session's Open is outlined. Its label is today's action wording; `Review plan` on the mock is mock wording (§6).

### 4.6 Runs › History (`RunsView`, `StageBars`, `RunDetail`; mock `Runs.dc.html`)

- The five figure tiles stay, each gaining its own breakdown: Runs as a stacked bar of done / aborted / failed / paused / running
  (each `status`, tones per §4.1) with the counts under it; the other
  four keep their number and one-line context.
- Machine time by stage is one stacked bar with a legend (stage, hours) in place of seven one-hue bars. No stage tokens exist and none are added: the
  segments use the existing mark tokens in this order — dispatched `--green-solid`, reviewing `--cyan`, fixing `--amber-solid`, verifying `--magenta`,
  inspecting `--mustard`, preflight and merging `--ink3`, any other stage `--steel`; the legend carries the word, so hue is never the only carrier.
- Live runs are cards: project, state pill (`paused`, `running`), run id, machine and age, `N of M items` with a progress bar. A click opens the detail.
- The detail's head holds the run's controls (`RunControls`: Pause, Cancel, Stop, Resume, each where today draws it) and the `paused at a boundary` / `controls live on the machine that ran it` line; its facts are
  a glyph-labelled grid (Started, Machine, Base · mode, Cost); it opens on the timeline of its items, each with outcome pill, title, duration and its stage
  split; the run's outcome line (`PR opened · <branch> → main · #462`) closes it.

### 4.7 Runs › Watchdog and Ticks (`WatchdogMonitor`, `TickMonitor`; mock `RunsOps.dc.html`)

- **Watchdog** opens on a status band: the state (`Idle · nothing to watch`), `next check in 18 s` (from `nextTickAt`; `checked N s ago` is not served and is not drawn), and `Policy in
  Settings`; the policy sits
  in a row BELOW the status as three figures (Check every, Leave a resumed run alone, Give up after) — the user found them hard to read inline. Then
  `Watching N` (empty state as one line), then Activity (last 50, in memory) with the time, the event as an outcome pill and the detail.
- **Ticks** gives each project one row: name, a strip of its last 12 ticks (oldest left; `ok` green, `failed` red, anything else grey; hovering a cell titles
  it with time, kind, id and outcome), the last tick's line, and `Reset` on a halted project. A halted project carries a red `N failures in a row` pill and
  its reason; the pink row fill goes. The band and 24 h figure stay as today.

### 4.8 GitHub › Pull requests (`PrInbox`, `PrMatrix`, `PrCards`, `PrActions`; mocks `PRs.dc.html`, `PRsLayouts.dc.html`)

- **Inbox**: triage tabs as `Segmented` with counts (Needs you / Worth a look / Quiet). Each row leads with a status tile in the `checks` tone (`failure` red, `pending` amber, `success` green, `none` and `unknown`
  grey; conflicts, changes requested and behind are carried by the pills, not the tile), then title, then checks and mergeability as pills, then author · branch → base · age. The four outlined chips become one split Merge: the main
  half merges, or enables auto-merge while checks are still running; the menu holds Merge, Enable auto-merge and Update branch, each with one line on what it
  does; `Open on GitHub` becomes an icon button. A PR that cannot merge shows the dashed `Blocked` main half, `aria-disabled` and focusable with the
  reason via `aria-describedby` as today; the chevron stays enabled while any menu action is allowed (Update branch, auto-merge). With auto-merge already
  armed the main half reads `Auto-merge on`, stays enabled and disarms on click (today's toggle, `enable: false`), and the menu's row is `Disable
  auto-merge`. Merge still opens today's Confirm with its
  method select (default `defaultMethod`).
- **Matrix**: one row per PR, one column per fact (`MATRIX_COLUMNS`: checks, review, mergeable, base, auto-merge, plus Updated). Colour marks a problem only;
  each header counts its bad rows. The leading dot is the triage tone. One row expands at a time and shows the failing check names plus the Inbox row's
  actions; a blocked PR's Merge is the dashed half with the reason written in it.
- **Cards**: one card per repository with open PRs (none for a repo with nothing open), head `repo · N open · polled age`, then compact PR rows with the
  same status tile, pills and split Merge. A PR merged from this page stays as one quiet line until the next poll, as today; a repository that could not be
  read is one line under the cards, not a red card, as today.

### 4.9 The shell (`SideRail`, `TrackerChip`, `JiraChip`; mock `Shell.dc.html`)

- **Rail header**: a glyph tile, `backlog manager`, and the `.rail-kicker` sub-line (§3); the wordmark's blinking cursor while a run is working
  stays. **Rows**: icon tile, label, count. The open section's pages are a
  quiet sub-list; the current page is a white (`--strip`) row, not a dot. The rail stays always open.
- **Counts** share one shape, the plain `.pill` with a number: amber when the number is things waiting on the user, grey otherwise. Jira keeps today's
  badge: the needs-you count, amber, and its click still opens Sessions filtered to needs-you; `rail-badge` becomes this pill and stays a button. GitHub
  (PRs that need you) and Runs (live runs): see §4.9a.
- **Footer**: version with a status dot, `API connected` beside it, keeping today's version click (the releases drawer) and its unseen-release dot. The
  client talks to its own origin through the proxy and never sees 4322, so the mock's port is not drawn. The dot reads whether the client's existing reads are answering — red with `API unreachable` when they fail; no new poller is added
  for it, and the builder picks which existing read it follows.
- **Top right**: one status pill per service (`GitHub ● 2m ago`, `Jira ● 9s ago`) replacing the meter chips. Green when the last sweep is on time, amber when
  it is late, red when the service is down. The popover keeps today's detail and gains a head: initials disc (no avatar is served: Jira `me.name`, GitHub `login`), name, `● connected · <site>`, and `Sync now`; then
  two figures (last sweep with its interval; for Jira the sweep calls and last 429, for GitHub the rate-limit remaining of limit — what is served); then the per-board (Jira) or per-repo (GitHub) rows with their polled age and
  a per-row sync icon; then the setup link.

### 4.9a The GitHub and Runs rail counts (the user's answer: always on)

Nothing in the shell knows either number today: the PR poll (60 s) runs only while the PRs page or GitHub Settings is mounted, and the shell has only
the boolean `working` for runs. The user chose counts on every page, so the shell gains an always-on reader for each:

- **GitHub**: the server's PR cache has no timer and stays that way (on demand, `PullRequestsService`); the shell's client gains the 60 s
  `GET /api/prs` read the PRs page runs today, mounted whenever a board tab is open and GitHub is connected (never while nothing is connected), shared with
  the PRs page so one tab makes one read a minute. This overturns the stated reason "nothing reads pull requests except the PRs page"
  (`server/src/tracker/pulls.service.ts`'s header comment, `.claude/rules/tracker.md`'s PR-cache bullet); both move in the same commit, with this section
  as the reason. The count is the Inbox's `Needs you` number, amber; 0 hides the pill.
- **Runs**: one `useOrchestratorRuns()` poll per tab moves up into a shell-level context, and every view that calls the hook today (Board,
  Archive, PRs, Runs — `test/run-pulse.test.ts`'s `VIEWS`) reads the context instead, so the shell's count and every view share one 5 s request, never
  two. That keeps the guard's purpose (no second poller for the shell) and changes its shape: the caller list becomes the one provider, and the `App` bar
  becomes "only the provider calls the hook". The provider also derives `working` for the wordmark cursor, so the four views' `useReportWorking`
  calls and the guard's "each view reports" case (`run-pulse.test.ts`) leave in the same commit. Both move in the same commit, with this section as the reason. The count is
  grey; 0 hides the pill.
- Both readers pause with the page's existing visibility handling, if the poll they reuse has it.

### 4.10 Settings (`SettingsView`, `SourcesGroup`, `TimeZoneGroup`, `WatchdogGroup`, `TickGroup`, `Dashboards*`; mocks `Settings.dc.html`, `SettingsMore.dc.html`)

- **All pages**: a `Local | Shared | Dashboards` segmented head with a sub-line saying where the page saves (`saves in this browser only` / `saved on this
  machine`). One readable column of cards; each card has a title and a scope pill (`this browser`, `this machine` — today's two words,
  `SettingsView.tsx`; `this machine` is the server's host everywhere, as on Jira Setup); each row is a label, a one-line
  description and a control; text longer than a line moves behind an `ⓘ more` toggle (a button with `aria-expanded`).
- **Local**: Theme as picture cards, each a mini board drawn from that theme's own tokens (the preview element carries the theme's `data-theme`, so no
  colour is hard-coded); Density, Text size, Content width, Opens on as `Segmented`; Default merge mode as three icon cards (Merge into base, Leave branches,
  Open a PR) with one line each; the question-mode default and the dispatch defaults (Model, Effort, Permissions) as today's controls in the new rows.
- **Shared**: Sources — Files, GitHub, Jira as rows with a status pill and a link button (`Open`, `GitHub page`, `Jira setup`), and a foot `Last read
  <age> · Read again` (§5). Time zone as a select with the current offset. Orchestrator watchdog — an `Enabled` switch and three steppers, then its live
  status line and `Live view in Runs`. Backlog tick — three steppers (Halt after, Plans awaiting review, Open execute PRs).
- **Dashboards**: a two-pane page. The list: one row per machine with the prefer-order number, status dot, name, `this machine` tag, account pill and two
  meters (5 h, week) that turn amber then red near the limit, plus `Add a dashboard`. The detail: name with ↑ ↓ (prefer order), Edit, Remove; a status line
  (connected · spawn; sessions in use is not served and is not drawn); two usage tiles (5-hour window, week) with reset times; Models and Efforts as pills, disallowed ones struck through
  with a title saying so; then the facts (dashboard URL, board URL, machine name, account). ↑ ↓ write the existing `order` through `POST /api/dashboards/settings`, the
  order Dispatch already reads. `SuggestCard` (strategy and threshold) and Home's setup
  steps stay, restyled into the same card and row language.

## 5. Server additions

- **Sync now.** Both routes sit behind `SameOriginPostGuard`, as every POST here does. `POST /api/jira/sweep` (site-wide, no body — shipped without the optional `{ boardId } ` below; the per-board `now` stays #472's `POST /api/jira/boards/sweep`, see `docs/subsystems/jira.md`) and `POST /api/github/sweep` (optional `{ repo }`) — named `sweep`, not `sync`, because
  `POST /api/trackers/sync` already exists and writes a repo's sync interval — ask the already-armed poller for one
  sweep now and return when it has finished, with the new cache ages. A poller that is not armed answers 409 and the button is disabled with that reason; a
  second call while a sweep runs joins it rather than starting another (a joined sweep may have started before the click, which is accepted); calls closer than the poller's own interval floor (the builder sets it, at least
  5 s) return the last result without calling out. Both are reads of the outside service, so they respect the existing budget and 429 handling. A repo
  whose sync is `off` is skipped (it refuses every write path and is not polled; the row's sync icon is disabled). The GitHub sweep also re-reads the PR
  cache for the swept repos once, past its TTL, through the same one-in-flight-read-per-repo path. Failures: (no `boardId` 404 — see the deviation above)
  an unknown `repo` a 404 with the existing text `<repo> is not the repo of a registered GitHub project` (`pulls.service.ts`); a malformed body is a
  400. Jira: inside a stored 429 window the sweep makes no call and answers 429 with the stored `retryAt` (the existing up-front refusal); Sync now shows
  `Jira asked to wait until <time>`. GitHub has no `retryAt`: its sleeps are per repo, in two pools (`sleepUntil`, `secondaryUntil`). With `repo` and that
  repo asleep, the answer is 429 carrying the later of the two ends and no call is made (Sync now shows `GitHub asked to wait until <time>`); without `repo`,
  200, skipping asleep repos as the timed sweep does. A 401, 5xx
  or transport failure answers 200 with the cache unchanged and `access` / `detail` saying why, as a timed sweep leaves it; the pill turns amber or red from
  those, and Sync now shows the detail. A status pill is late against each row's own interval, not the 15 s tick.
- **Read again** on the Sources card calls both and re-reads the registry; it shows the newest age when all three answer.
- Nothing else is added server-side. Numbers a mock drew that are not served (Jira calls since start, GitHub call and 429 counts, token scopes, avatars,
  Dashboards sessions in use, Watchdog last-check age, the API port) are replaced by what is served or left out, as each section says.

## 6. Drawn on a mock, built differently or not at all

- Stage colours `#5c9a2e` and `#e9a24f` (Runs) and the theme-preview colours (Settings) are mock hex: the build uses the mark tokens §4.6 lists and each theme's own
  tokens.
- `Review plan` on the deck and Sessions rows is mock wording: the label is today's action wording for that state.
- The mock's 10.5 px and 11.5 px text, its uppercase micro headers and any lowercase kicker follow the Jira spec's rules (11 px floor, sentence case,
  `.rail-kicker` uppercase).
- The Cost column on Sessions is not built: no cost is served (§4.3).
- The `2 need you` sub-line under PRs in the rail is not built: the count pill already says it.
- `Squash and merge` wording: the menu row reads `Merge`; the method stays in today's Confirm select.
- The icon rail drawn on the first boards was a drawing shortcut; the rail is always open (§4.9).

## 7. Left to the builder

- Glyph paths for the new tiles (runs, PR status, settings icon cards), on the Jira spec's 14 px grid.
- The late threshold for a status pill (the sensible default: more than twice the sweep interval since the last sweep) and the meter thresholds for
  Dashboards (if Dispatch already has a skip threshold, use it; otherwise amber at 80 %, red at 95 %).
- Whether the restyled `FilterBar` and the Run menu share a popover row rule; the primitives-block guard decides (declare once, in the block).
- The narrow-width behaviour of the rail, the PR Matrix (horizontal scroll inside the table, never the page) and the two-pane Dashboards (stacks).
- Focus order in every new popover: first enabled control on open, as the Run menu does.

## 8. Tests this changes or adds (behaviour and cases, not code — the plan states this override of writing-plans' literal-code rule)

- **`SplitChip` reuse**: the PR row has a button named `Merge #<n>` and `Merge options for #<n>`; the main half posts merge when checks pass and auto-merge
  while they run; the menu lists Merge, Enable auto-merge, Update branch; a blocked PR's main half is disabled with its reason as the title. Existing
  `/api/prs/*` call assertions keep their payloads.
- **`FilterBar` restyle**: existing FilterBar tests keep passing (Files, Archive, Jira band); the popover shows chip groups, `Showing N of M`
  and `Clear`, which resets every group; Escape closes and returns focus to the chip. Sessions: the window, Repository, Run and `All tickets` groups drive
  the existing state, and `Show 30 days` in the empty state sets the window; the Sessions cases in `test/jira-list.test.tsx` that click the `All tickets` chip (:271, :361, :420) now open the Filter popover and pick the chip
  (no existing case picks from the selects; the window is set programmatically).
  The Session cell and State column assert today's `STATE_LABEL` words with the age; `test/jira-sessions-state.test.ts` is unchanged.
- **Segmented counts**: the count renders beside each label and is part of the option's accessible name.
- **Stepper**: − and + change the value by one step, clamp at min and max (the button at a bound is disabled), typing still works, and the existing
  NumberField tests keep passing against the new look.
- **Ticks strip**: a project with 15 `recent` entries draws 12 cells, newest right; outcomes map ok→green, failed→red, other→grey; each cell's title
  names time, kind, id and outcome; a halted project draws the red pill and Reset; no row carries the old fill class.
- **Watchdog**: the three policy figures render in their own row under the status line.
- **Rail**: every count is the same pill class; the Jira pill is a button that opens Sessions filtered to needs-you, as today; the current page row carries `aria-current="page"`;
  the guard in `test/run-pulse.test.ts` still lists the same callers (or moves with a stated reason).
- **Status pill**: green, amber and red by sweep age and connection; the popover's `Sync now` posts once, disables while running, and shows the new age.
- **Sweep routes** (jest, server): an `off` repo is skipped; 409 when the poller is not armed; a concurrent second call joins the first sweep (one outbound call); a call inside the
  floor returns the cached result without calling out; an unknown `repo` is a 404, a malformed body a 400 (the Jira route reads no body, so no `boardId` case); Jira inside a 429 window answers 429 with the
  stored `retryAt` and makes no call; GitHub with an asleep `repo` answers 429 with the later of `sleepUntil` / `secondaryUntil`, and without `repo` skips
  asleep repos with a 200; a 401 answers 200 with the cache unchanged; a cross-origin POST is refused by the guard.
- **Settings**: `test/settings-view.test.tsx`'s "no in-page switch" assertions (and the comment that states that rule) invert to the
  `Local | Shared | Dashboards` switch, with §3's override as the reason. The info toggle has `aria-expanded` and reveals the long text; the theme cards set the theme; the merge-mode cards set
  `orchestrateDefaultMergeMode`; every card has its scope pill.
- **Dashboards**: ↑ on the first row and ↓ on the last are disabled; a move reorders the list and persists; a disallowed model renders struck through with
  its title.
- **Guards**: `daylight-contrast` `PINNED` gains every new tint site (state stripes are marks, not tints; pills and tiles are tints); `design-guards` stays
  green (one uppercase rule, 11 px floor, primitives declared once); `dialog-count-docs` moves to ten popover composers (Jira spec eight, plus the Merge and Open menus).
- **Last task of each plan is `/ui-verify`**, comparing the live page at 1440 px against the mock it cites: List, Sessions (filled and empty), Setup (with
  worktrees open), launch sheet and deck, Runs History, Watchdog + Ticks, PRs Inbox, Matrix and Cards, the shell with a status popover open, and each
  Settings page.

## 9. DESIGN.md overrides (each plan carries the task for its sections)

- §8.0 Shell and rail, §8.9.4 Chip: icon tiles, one count pill, current page as a white row, status pills replacing the meter chips; the popover is no
  longer "a reading with no links and no buttons" — it gains the head with Sync now, per-row sync icons and the setup link.
- §8.4.1 History, §8.4.2 Watchdog: stacked breakdowns, live run cards, the detail timeline; the status band with policy below; the tick strip.
- §8.6 Settings (and `board.md`'s "the rail is the only switch"): the in-page `Local | Shared | Dashboards` switch, one column, scope pills, info toggle, picture and icon cards, steppers, the Dashboards two-pane page.
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
