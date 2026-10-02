# The board (client)

A React SPA in four sections behind a side rail — Board, Runs, Archive, Settings — each its own lazy chunk. The server returns whole corpora, so most of what
appears on screen is decided here: whether an item is groomed, whether it belongs on the Board or in Archive, how long an item's work took, what a run cost.
Those derivations live in `client/src/lib/` as one implementation each, so two surfaces cannot disagree about the same item.

The look is not decided here. [`.claude/DESIGN.md`](../../.claude/DESIGN.md) is the visual language — §1–7 the system, §8 how this board applies it, one
subsection per surface — and every component cites its subsection in a header comment. This document is the mechanism: what each surface is made of, what it
reads, and which file owns each decision.

## Mechanism

### The rail

Board / Runs / Archive / Settings, a plain section switch. `SECTIONS` in `client/src/lib/sections.ts` is the one runtime list of them — it lived in
`SideRail.tsx` until the rail gained a `useSettings` read and the two files closed an import cycle — and the rail keeps only the LABELS, as a
`Record<Section, string>`, so a section added to the list cannot ship without one. `resolveSection` in `App.tsx` maps a stored value that names no tab — the
legacy `'projects'` included — onto Board, so an upgrade never opens on a blank main area.

TWO sections have a sub-nav tree under their row: Runs (History, Watchdog) and Settings (Local, Shared). Both are drawn by one component, `RailTree`, because
the markup carries three details that must not drift — the `rail-sub`/`rail-sublink` classes, `aria-current="true"` rather than `"page"`, and closing the phone
menu on a pick. What each call site supplies is only what legitimately differs: the item list, which of them is current, and what a pick writes. In both cases
the tree is the **only** control that switches between the two views — there is no in-page switch at any width (`.claude/DESIGN.md` §8.0).

The two trees differ in where their value lives, and the difference is not arbitrary. Runs' mode goes through `useRunsMode` (`client/src/hooks/useRunsMode.ts`),
a module-level value every mounted reader subscribes to, because the rail is not its only writer — the Watchdog page's own rows jump back to History with a run
selected, and the Settings watchdog card's `Live view` link opens Watchdog — and a second copy would let the rail and the page look at different views;
`lib/runs-mode.ts` stays the one home of the key, the member list and the guard. Settings' scope is a field on the settings object instead, because both of its
readers already sit inside `SettingsProvider` and nothing outside Settings writes it.

Below 700 px the rail is a bar across the top with a menu, and every tree stands open inside it. `useNarrow` (`client/src/hooks/useNarrow.ts`) is the one place
JavaScript knows that breakpoint; everything else reads it from there or from a media query.

### Primitives

`client/src/components/ui/` holds the patterns more than one surface draws. Each is one component owning one class family, declared once inside `styles.css`'s
`/* ── ui primitives` block: page CSS lays a primitive out — grid, gap, width — and never restates its look, which is the same rule `lib/` follows for
derivations and for the same reason. A surface that needs a variant adds a prop, never a second family. `test/design-guards.test.ts`'s guard 7 is the
enforcement half of that rule — it pins the family list, the block's two delimiters, and that no selector outside the block starts with a family name — and this
table is the documentation half. The two are meant to agree; a primitive added to one belongs in the other in the same change.

| component              | class family      | props                                                                                            | composed by                                                                     |
| ---------------------- | ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `Band`                 | `.ui-band`        | `title`, `sub?`, `children` (right slot), `className?` (the page's layout class)                 | every page: Board, Runs History, Runs Watchdog, Archive, Settings               |
| `Sheet`, `SheetHead`   | `.ui-sheet`       | `Sheet{children, as?, className?}`; `SheetHead{title, sub?, right?}`                             | Runs (Live, History, detail), Watchdog (Watching, Activity), `SettingsRow`'s card |
| `FigureStrip`, `Figure`| `.ui-figure`      | `FigureStrip{children, cols?: 3\|5, testId?, className?}`; `Figure{label, value?, unit?, line?, tone?, wide?, title?, testId?, children?}` | Runs History (six cells, the sixth `wide`), Watchdog (three)                     |
| `Chip`                 | `.ui-chip`        | `variant?: outline\|ink\|flat\|danger`, `size?: 32\|28`, `pressed?`, `as?: button\|label`, `icon?`, `onClick?`, `disabled?`, `title?`, `type?` | every band and control row, `RunControls`, `DispatchButton`, both sheets, load-more |
| `Pill`                 | `.ui-pill`        | `tone?: neutral\|live\|warn\|bad\|done`, `title?`                                                | column counts, run mode, stage words, `crashed`, `paused`, `uncommitted`        |
| `Dot`                  | `.ui-dot`         | `size?: 8\|10`, `breathe?`, and either `tone?` or `hue` (1–8, through `project-hue.ts`)          | rail wordmark, card foot, column header, run chip, Runs rows, modal facts       |
| `Marker`               | `.ui-marker`      | `tone: groomed\|kind\|done\|stale\|untyped`, `children`, `title?`            | `ItemCard`'s marker row (Board and Archive draw the same card)                  |
| `ProgressRow`          | `.ui-progress`    | `name?`, `value`, `max`, `caption?`, `valueText?`, `hatch?`, `height?: 10\|6`, `fill?: progress\|ink\|warn` | the Watchdog page's sweep meter and per-row heartbeat meter                      |
| `Meter`                | `.ui-meter`       | `label`, `value`, `fraction` (clamped; `null` draws empty), `tone?: green\|amber\|red`, `width?` (px, default 56, or `'fill'`) | `TrackerChip` — the chip's POLL and API meters, the popover's rows and API block |
| `Ledger`, `DayKicker`  | `.ui-ledger`      | `Ledger{columns?, children, label?}` owns the `overflow-x` box; `DayKicker{children}`            | Runs History's day groups, the Watchdog activity feed                           |
| `Modal`                | `.ui-modal`       | `label`, `facts`, `children`, `onClose`                                                          | `ItemModal` — the only modal in the app                                         |
| `FormSheet`            | `.ui-form-sheet`  | `label`, `title`, `steps?`, `footer`, `children`, `onClose`                                      | `LaunchSheet`, `OrchestrateSheet`                                               |
| `Popover`              | `.ui-popover`     | `label`, `width` (px), `anchor`, `onClose`, `children`                                           | `FilterBar`, `TrackerChip`                                                      |
| `Segmented`            | `.ui-seg`         | `value`, `options`, `onChange`, `disabled?`, `label?`, `pill?`                                   | Settings (density, text size, staleness), the Runs range control (stroked, not `pill`) |
| `Select`               | `.ui-select`      | `value`, `options`, `onChange`, `disabled?`, `label?`                                            | Settings rows, `WatchdogGroup`'s three ladders, both sheets' pickers            |
| `NumberField`          | `.ui-number`      | `value`, `min`, `max`, `unit?`, `onCommit`, `label?`                                             | nothing today — see below                                                       |
| `Switch`               | `.ui-switch`      | `checked`, `onChange`, `label?`, `disabled?`, `onLabel?`, `offLabel?`                            | `WatchdogGroup`'s Enabled row, `LaunchSheet`'s toggle                           |

`label` and `title` are separate props on both overlay shells because a dialog's accessible name and its visible title are different strings on every surface
that draws one, and `title` is a node — a name cannot be derived from it.

Two entries differ from the design spec's §12.2 table on purpose, and both are code's reading rather than the spec's: `StageBars` draws its own bar rows rather
than composing `ProgressRow` (the spec listed it as a composer), and `NumberField` has **no composer at all** — the watchdog's three numeric policy values are
`Select` ladders, and Settings' own numeric rows re-seed on commit with the same idiom rather than the component. It is kept because the family is part of the
36 px control set guard 7 pins, and because a numeric row is the next Settings addition's obvious control; if a reader finds it still unused, deleting it means
deleting the family and the guard entry together, in one change.

`SettingsRow` and `SettingsGroup` are not primitives — they are the Settings card's own composition of `Sheet` plus rows, and stay under `settings/`. Everything
else page-shaped stays in its section's directory: `ItemCard`, `BoardColumn`, `RunChip`, `ItemModal` (board); `RunsView`, `RunDetail`, `StageTrack`,
`StageBars`, `WatchdogMonitor` (runs). `RunControls`, `RunRowTime` and `FilterBar` sit at the top level of `components/`, like `lib/view-keys.ts`, because two
lazy chunks read each of them. `FilterBar.tsx` is three exports, not one: the band's filter-and-sort track with its two popovers (`FilterBar`), one section of
the filter popover (`FilterSection`, whose `fill` flag lays a switch out full width) and the `Project` section both pages draw (`ProjectPicks`) — the last two
so that no page draws a section heading or a project chip of its own. Its family is `.filter-bar*`, never `.ui-*`.

### Board

A `Band` carrying the count line, then search plus project/status/sort selects and the Orchestrate control as chips, then four fixed columns
(refactors/ideas/bugs/tasks). Out-of-scope has no Board column at all; it belongs to Archive. A click on a card opens the **item modal** — `ItemModal`
composing `Modal`: a facts column (project dot and name, id, section, the created / updated / last-commit stamps, `groomed`, tags, the `in progress since`
reading while a session holds the item, the elapsed and token counters when present, the file path, the dispatch control) beside the item's rendered Markdown
body, folding above it under 700 px.

Beside the band's title sits the **run chip** (`RunChip`), the Board's whole account of orchestrator runs since the run strip, the starting strip and the run
drawer left it: a `Dot` taking the worst state present and a count line naming every state in that same order — `2 runs · 1 live ›`, `1 run · crashed ›`,
`1 starting ›`. Precedence is exact: crashed over paused or starting over live. It renders the payload's `starting` array with no client-side filter, it is
absent entirely when there is no run and no starting entry, and clicking it switches the section to Runs, where the rest of the reading lives.

A dispatch control — on the card and again in the modal — opens a launch sheet onto `../claude-agents-dashboard`. The toolbar Orchestrate control opens
`OrchestrateSheet`, three steps inside a `FormSheet`, with Start on the last one alone so it never sits under a scroll region whose length is the project's
queue:

1. **Items.** Previews the queue and selects a subset of it, flagging with an `uncommitted` chip every row whose file on disk is not the file at `main`, and
   splitting the two fates that has — absent from `main` is skipped in the run's own words (`not committed on main`), present-but-stale is gated and run on
   `main`'s bytes — plus a `deselect uncommitted (N)` control. Fed once per sheet open by `GET /api/items/uncommitted`, rendering nothing at all on
   `known: false` or a failed/malformed answer, and deliberately changing no default: an untouched sheet still posts no `ids`.
2. **Order.** Hand-orders that selection with ↑/↓ and a reset (`order: string[] | null`, `null` meaning queue order, reconciled against the live queue every
   render, never stored resolved). The screen says a `runner-fix:` item may still hoist above the chosen order, and that it cannot tell which.
3. **Modes.** Six pickers — permission mode, model, effort, merge mode, question mode, base branch. Four of the six seed from Settings: model and effort off
   the same `dispatchDefaultModel` / `dispatchDefaultEffort` keys the launch sheet reads, merge and question mode off the two orchestrator defaults. The other
   two deliberately do not, for opposite reasons. Permission mode has no stored default and starts at `auto`, clamped down to whatever ceiling the dashboard
   reports. **Base branch seeds from the literal `'main'`, never from Settings** (task-44): its two neighbours have permanently sensible values, while a base
   names one experiment's branch, so a stored one would outlive that experiment and silently send a later run onto a stale feature branch. Its options come
   from `GET /api/agents/branches`, fetched once per sheet open, falling back to `['main']` alone on any failure and never blocking a launch. Plus, in merge
   mode, a setup hint fed by `GET /api/agents/merge-check`, and, for a non-`main` base, a note saying `main` will not be written. The merge-mode picker's own
   option words come from `mergeModeOptionLabels` (`lib/merge-mode.ts`) and are **derived from the picked base** — `Merge to <base>` — so the control and that
   note are one statement rather than two that can disagree (bug-36). Settings, picking a default before any run and so before any base exists, calls the same
   function with `null` and gets `Merge into the base branch`; `null` there means "no base is knowable", never `main`.

Both sheets and the item modal are the three dialogs on the escape stack, and neither the sheets nor the modal binds a key of its own: `Modal` and `FormSheet`
call `useDialogEscape` for whatever they wrap. `ui/Confirm` (bug-53) joins the same stack while it is drawn and is not a dialog — see the detail sheet below.

### What leaves the Board

An open refactor, idea or bug nobody has touched inside the staleness window (30 days by default, `Settings → Local → Board → Archive after`) leaves it for Archive on
its own. "Touched" is the `updated:` stamp every `start`/`stop` writes, falling back to the last commit that touched the item file, and to `created` only when
git can answer neither — that middle rung is there because a groom session which edits an item through the editor rather than through the CLI leaves the
frontmatter silent.

So the first load after upgrading moves genuinely old, never-touched items off the Board. Nothing is lost: grooming one refreshes the stamp and it is back at
the next load. Two things outrank the arithmetic outright — an item a skill session is working right now, and an item a live orchestrator run has claimed —
because neither is neglected, whatever its own stamps say: a run writes `started:` inside its own worktree, so the copy the board renders stays silent for the
whole run. Tasks are the exception and never leave — a task rotting for six weeks is a fact to look at, so it keeps its column and gains a `stale` marker
instead.

### Archive

Where those land, in four columns — refactoring, ideas, bugs, out of scope — grouped under sticky month subheaders, newest month first. The column is the
Board's own `BoardColumn` and the card its own `ItemCard`, not a second set: what differs is the fourth column, whose dot carries no type hue at all, because a
rejection is a verdict rather than a type. There is no Tasks column, because a task never leaves the Board to fill one. It carries a project filter and a search
box and nothing else: its contents are defined by staleness and rejection, not by status, so a status filter there would either do nothing or contradict the
surface. No card here ever paints a live strip — whatever put an item in Archive already took it off the Board a run could be holding — which `ArchiveView`
guarantees by handing `ItemCard` no run at all. A card opens the same item modal the Board opens.

Nothing in it is finished, and both halves come back by their own route — a stale item by dispatching a **groom**, which refreshes `updated:` and puts it back
on the Board at the next load; a rejected one by dispatching a **capture**, which files a _new_ item citing `from: <id>` and leaves the original rejected on the
record. (That id keeps whatever prefix it always had — a rejection moves a file, it never renames one.) As everywhere else, the board writes no item file; the
spawned session does.

### Runs

Two pages under one rail entry, both reading the one `useOrchestratorRuns` payload, so moving between them adds no request and neither owns a second copy of the
run list.

**History** — the section's default, and named for what a reader arrives looking for rather than for its contents, which are three parts present and one part
past. Its band counts all three states at once (`3 live · 1 starting · 28 past`) and carries the project select and the four-step range control (`RUN_RANGES`,
`lib/run-range.ts`, calendar-aligned local-time windows on a run's `startedAt`), which scopes the figures, both lists and the wide cell together.

Directly under the band, the **figure strip**: five cells — runs, completed / queued, avg item work, rework / completed, verify pass — each a label, a value and
a line saying what the figure above it means, all read from what `aggregateRuns` (`lib/run-stats.ts`) returns and nothing else. The sixth cell is full width and
holds `StageBars`: machine time by stage, always the seven `MACHINE_STAGES` rows in pipeline order, `—` for a stage never recorded, queue wait excluded. The
strip hides with the list when the range or project filter empties it.

Under the strip, the **split**: a 420 px list column carrying the Live sheet over the History sheet, and one always-visible detail sheet beside it. The two
columns stack under 1100 px, list first; under 700 px the sheets are full width.

Once the **board** is 1400 px or wider the strip leaves the top of the page and stands as a 320 px rail on the right, one figure wide, the split keeping the
first column unchanged and the band spanning both. The switch is a container query on `.runs-frame`, the measuring wrapper History renders around itself —
a media query cannot see the rail, the measure cap, the padding or `.shell`'s `zoom`, and the container cannot sit on `.wrap` or `.main` because layout
containment would make either the containing block for the fixed overlays rendered inside them. The 1280 px measure cap sits under the threshold, so the
rail appears only with content width set to full. Watchdog renders no wrapper.

- **The Live sheet** holds one row per run that is `running` or `paused`, plus one per `starting` entry — a dot, the project, `⚠ N` when the run carries
  attention entries, the two-tone `1 / 5`, elapsed, and a status pill only where one is earned. A starting row reads `starting… · <age>`, carries no controls
  and cannot be selected: there is no run file for the detail sheet to show. A crashed run — `running`, heartbeat stale — is a two-line row carrying all three
  of its readings together (`no heartbeat for <age>`; `last reported <id> at <stage>` or `all items at rest`; the `watchdogClause` sentence), and it is always a
  Live row, never a History one: which sheet a row belongs to is `splitLive`'s call on `running`/`paused` presence, with freshness deliberately excluded.
  A **remote** run (task-48 — another machine's run on a tracker project, from the payload's `remote` array) follows the same rule and carries a neutral
  `remote` pill beside the project, in either sheet.
- **The History sheet** holds one row per finished run under day kickers, newest first: the dot and the status word from `runStatusChip`, the project, the
  two-tone count, wall time and the cost beside it when usage exists, behind a counted `load more` in pages of 25 — a render decision over a corpus the client
  already holds whole, exactly as the staleness window is. A row **selects**; nothing opens, and there is no run modal anywhere in the app.
- **The detail sheet** shows the selected run whole: a head with the project, the run id and `RunControls` (Pause, Cancel with its `Pausing after <id>` note,
  Stop beside both — and on a crashed run too, which is the run a person most needs to end — Resume for a paused run, and Resume for a crashed one exactly
  when `watchdogStoodDown` says the sweeper will not. Stop asks first (bug-53): the chip is replaced in place by `ui/Confirm` naming the item it abandons and
  saying the run cannot be resumed, and only its `Stop run` sends the request — `Keep running` and Escape send nothing. A run with a stop on file drops to the
  `Stopping` reading and offers no control at all — no withdrawal, because the `--abort` session has already been spawned, and no Resume in any branch); then the facts strip, the mode and question
  notes, the chip row, `git merge --no-ff <branch>` per branched item, the items in pipeline order — each with its stage chip, its `RowTime` reading, its
  seven-node `StageTrack`, its usage line, its assumptions under `decide`, and its last verification as a disclosure, open when failed. Machine time by stage
  for this run alone comes after the items, and the attention entries last of all — an empty attention list is the common case and the chip row already carries
  its count, so the section earns the screen only when it has something in it. Selection is one run across both sheets: the first live run is selected on
  arrival, and with nothing live the newest History row is, so the Board's run chip lands a reader on the current item's stage track with no second click.
  For a remote run the sheet is read-only: `Remote run: its controls are on the machine that ran it.` stands where `RunControls` would, nothing fetches
  `archive/run`, and a line under the items says the ones the run has not claimed yet are not visible from here. A LOCAL run of a tracker project that has
  claimed nothing yet says `Not visible from other machines: this run has not claimed an issue yet.` — `lib/remote-run.ts` holds all three derivations, and
  `hooks/useProjectSources.ts` reads the project sources once on mount.


Cost rides all three surfaces — the History row's foot line, the detail head's `$ · N turns · N sessions`, and each item's own line under its track — absent
rather than zeroed for a run that predates the recording. Empty states are `no runs yet` and `no runs in this range`, the figure strip hidden alongside the
second.

**Watchdog** — the sweeper's own page (`WatchdogMonitor`), the only surface that additionally mounts `useWatchdog()`. Its band carries `stateLine`'s own
sentence as its subtitle and a flat `Policy in Settings ›` chip, because the policy is read here and edited there. Three figures: the sweeper's phase as a word
with a sweep meter under it while armed, the watched count over `⚠ 1 crashed · 2 fresh · 1 not yet watched`, and the three policy values with the enabled
switch's state as their line. Then the Watching sheet — one row per `running` run, annotated from the sweeper's own set with the skew rendered rather than
hidden, each with a heartbeat meter against `RUN_STALE_MS`, and on a crashed row the attempt pips, the clause, the session id, the grace remaining and a
`Resume now` chip drawn only when `watchdogStoodDown` allows. A row jumps to History with that run selected. Last, the activity ledger: the last
`WATCHDOG_EVENT_CAP` events, held in the API process's memory and emptied by a restart, which its subtitle says rather than buries.

### Settings

TWO pages, picked from the rail's tree and from nothing else — `settingsScope` is the setting, `local` the default. **The page is the scope**: Local is
everything in this browser's `localStorage`, Shared is what the API reads off the host. The band states which in a `Pill` at `neutral` (`this browser` /
`this machine`) and its subtitle is the page's own one-line summary; there is no in-page switch at any width.

| Page       | Column 1              | Column 2      |
| ---------- | --------------------- | ------------- |
| **Local**  | Display, Board        | Orchestrator, Dispatch |
| **Shared** | Orchestrator watchdog | Claude Agents, Trackers |

Each card is still a title plus a scope (`this device`, `this machine`, `this server`) answering a different question from the name: whether changing this
affects anybody but the person changing it. Both pages draw the same two hand-placed columns, so a card does not move to the other side of the page when its
neighbour grows a row; one column under 1100 px. The balances differ — Local is two short cards against two taller ones, Shared is the watchdog's long card
against two shorter reports stacked in one column (task-45 added `Trackers` under `Claude Agents`; both report on the host, and the one thing either sets is
the Trackers card's per-repo sync interval since #17 — a row control, not a section of settings — which is what makes them one column rather than two halves of
the page).

Local holds themes, density, text scale, content width, landing section, the staleness window, the two orchestrator run defaults, and `Dispatch` — the default
model and effort every launch sheet seeds from, the dashboard link base, and the `open dashboard ↗` link, which rides the `Dashboard link` row it reads its href
from. That card is what the old `Claude Agents` card's per-device half became: that card mixed backends, and a page that promises a scope cannot carry one that
does. What stayed on Shared is genuinely the host's — the dispatch status lines and the conditional `Setting it up` block — on a status row with no control in
its right slot at all. `Trackers · this machine` is the other Shared report and is read-only by design, not by phase: a project is connected by committing
`backlog/source.json`, so what the card offers instead of a button is the `backlog.mjs connect github <owner>/<repo>` command as copyable text, with the repo
read off that project's `origin` per request. It never shows the token — only whether one is set, and whose login it is.

Since #17 ([spec](../superpowers/specs/2026-09-22-tracker-sync-interval-design.md)) the Trackers card sets exactly one thing: each `github` row's sync interval,
a `Segmented` pill (`15s`, `1m`, `5m`, `off` — `SYNC_INTERVALS`' keys, never a second list) in the row's right slot. Connecting stays read-only; the interval is
how often THIS machine asks GitHub, so it is the machine's, in `settings/tracker-sync.json`. `useTrackers().saveInterval` posts `POST /api/trackers/sync` and
refetches, so the pill shows the server's value, never the one clicked; a refusal (turning a repo off under a live or paused run) keeps the old value selected
and puts the server's sentence in the row's hint until the next pick for that repo or a read in which its interval has moved — not any read, which would
wipe it within a second. Two checkouts of one repo are one key, so both rows move.

The watchdog card is one of the two places Settings writes to the server — the Trackers card's sync picker above is the other, since #17 — four knobs that
live in `settings/watchdog.json` beside the registry rather than in this browser, plus a `Live view` link that opens Runs › Watchdog through the same pair the
rail's tree calls. Because it writes, it can be refused, like the sync picker: a rejected `POST /api/agents/watchdog/config` renders one red line in its own row directly under the control it was refused for, while
every knob keeps showing the value the server actually holds. That is a separate hook field (`saveError`) from the failed-GET `error` beside it, because a
failed read replaces the whole group and a failed write must not.

`contentWidth` is the one setting here whose effect is not drawn by a component at all: `fixed | full`, stamped on `<html>` as `data-width` pre-paint and by
`useSettings`, releasing `.wrap` and `.wrap.wide` through one CSS block. Every section renders in `wrap wide` — Settings included since the split, which took
the shell's narrow-Settings exception away.

### A connected tracker

One shell-level chip and two item readings (task-45, [spec](../superpowers/specs/2026-09-17-tracker-backed-backlog-design.md) §5.5; the chip since #228,
[spec](../superpowers/specs/2026-09-28-tracker-header-strip-design.md)), all derived in `lib/tracker.ts` and merely rendered by the components:

- **The tracker chip** (`TrackerChip`) is the connection's one freshness reading, and it belongs to the shell rather than to any page: a poll is a fact about
  the whole tracker, so it is drawn once, in the strip above the well (`.topstrip`, `var(--main-gap)` tall) — or, below 700 px, where the strip does not exist,
  in the rail's phone bar beside ☰, through `SideRail`'s `chipSlot` — where CSS alone drops the login whenever meters follow it and pins ☰ at 36 px, since
  the bar has no slack for a reading whose width tracks the account (#229). `App` builds the one element and hands it to exactly one of those two homes. The chip is
  drawn only while `hasTracker` finds a github row in the `/api/trackers` payload, and shows a status pip, the platform, and two `Meter`s: POLL (the sweep's
  countdown, `sweepProgress` — the newest github stamp against `TRACKER_CYCLE_MS`, reading `overdue` past two cycles and the access reason when a row is not
  `ok`) and API (`apiUsage` — the rate limit's used share, amber from 60 %, red from 90 %). Clicking it opens `TrackerPopover`, a read-only panel with one row
  per connected repo (its own `pollProgress` countdown) and the API block (`N of M left · resets HH:MM`, `resetClock`), or the `BM_GITHUB_TOKEN` note when no
  token is set. It has no buttons and no links. The panel is `ui/Popover`'s at 420 px, and its dismissals are `Popover`'s too — Escape through
  `useDialogEscape`, and a pointerdown outside it and off the chip — beside the section change, the one close the chip keeps for itself.
  Since #17 each repo runs on its own clock, `syncCycleMs(interval)` — one `TRACKER_CYCLE_MS` per server tick the interval spans (`1m` is four, `5m`
  twenty), because the server restamps a slow repo on its n-th tick and every tick carries a sweep's length; `15s` is that constant exactly. POLL follows the newest stamp among the repos on the FASTEST interval present and skips `off` ones; it reads amber `sync off` when every
  repo is off, and `failing` only when every repo still syncing is failing. A popover row reads `sync off` for an off repo, never `overdue`.
- **The band** carries no tracker reading any more — it used to print one `polled 12 s ago` line per project, and the chip is that reading's home now.
- **The card** gains three things: an `untyped` marker (amber, like `stale` — both mark something a person must do before the board can be trusted), the
  assignee's login on the foot line (NOT on the live strip — it records who owns the issue, not who is working it right now; that is the claim's job), and a
  link-out to the issue that stops its click, and its Enter and Space, from opening the modal behind it — the same two-half guard `DispatchButton` uses.
- **The item modal** prints its project's `polled 12 s ago` line under the title, because the body it shows came out of the poller's cache rather than from
  GitHub on open — the one place a per-project poll age is still drawn, since it qualifies that one body.
- **Sync off** (#17). A repo this machine no longer syncs reads `futin/x · sync off · polled 3h ago` (or `· never polled`) in the modal and on the Trackers
  row — one `trackerState`, an access reason still winning over it. Because the server refuses every write and spawn for it, the card's and modal's dispatch
  control is DISABLED with the server's sentence (`syncOffReason`, byte-equal to `syncOffBlock`, pinned on both sides) — carried on `DispatchButton`'s
  `runBlock` after the run block, never hidden, since it is a per-project block rather than an environment one — and so is the toolbar's Orchestrate chip,
  whose click re-asks nothing for this reason because no status refetch could clear it.

**A claim control in the item modal (#225, #227).** `claimControl` (`lib/tracker.ts`) reads `BacklogItem.holder` and answers `'stop-release'` for a claim
whose session the board dispatched, live or stale (a `claude -p` waiting on a reply sends no heartbeat, so its age says nothing); `'release'` for any other live
claim that is not a run's; `'release-stale'` for one whose heartbeat is `CLAIM_STALE_MS` old or unparseable; and `null` for a files item, no holder, or a
run-held claim. `ClaimRelease` draws the chip under the dispatch control, asks through `ui/Confirm` (the Release claim wording says a board-dispatched session
waiting on a reply also looks stopped, the one thing the server cannot see; the stale wording names the heartbeat age and host, and says a session that is
somehow still running is refused at its next heartbeat), posts `POST /api/items/abort`, prints any refusal
verbatim, and on success shows `claim released` and calls `onReleased` so the Board re-reads its payload. It is drawn only where the modal is handed
`onReleased` — the Board — and the card carries no claim control, because it carries no claim reading to hang one on.

**A stale claim reads stale (#227).** The mapper still fills `started`/`phase` from any unreleased claim, so every reader that means "is somebody on this"
asks `claimReading` (`lib/tracker.ts`) — `'live' | 'stale' | null` by the reader's clock — as its second question. A stale holder draws the card's live strip as
`stale · no heartbeat <age> · <host>` in the stale queued band's muted pair instead of the hatched `executing` one (`liveBarFor`); ranks 2 and drops out of the
Status filter's "In progress" (`isLiveWork` in `lib/item-progress.ts`, which `liveRank` reads with the board's clock); and reads `stale claim` in the item modal
in place of `in progress`. It does NOT leave the board — `leavesBoard` is unchanged, because the release control lives on the Board and Archive has none. The
clock's own gate, `hasLive`, reads the rank UNAGED: a claim that is live now has to keep the clock running to be seen going stale. `progressBlock` lets dispatch
through over a stale hand claim — the spawned session's `start` retires it — and the Launch sheet says so (`staleTakeover`); a stale claim a run holds, or one
the board's own session holds, still blocks.

**A fourth card reading, `queued` (task-52, [spec](../superpowers/specs/2026-09-23-orchestrator-queued-label-design.md) §4.2).** An issue carrying the
`orchestrator:queued` label maps to `BacklogItem.queued`, and `queuedReading` (`lib/tracker.ts`) turns it into `'live' | 'stale' | null`: `'live'` while the
item's project has a local run that is `paused`, or `running` and not crashed, or a live remote run for the same repo; `'stale'` when the label is there and no
live run holds the project — a crash, a run that died on another machine without its Stop, a label added by hand. The card draws it as a band across its
top edge, `.board-card-queued` (`queuedStripFor`, `ItemCard.tsx`): the live strip's geometry as a neutral ink band (`--ink2` fill, `--strip` text), reading `queued` for the first and a
lighter `queued · stale` on `--hairline2` (its title saying no live run holds it and where to remove it) for the second. Any live strip wins over it — a run stage past `pending`,
or the claim's `grooming`/`executing` during the poll the label takes to clear — and it is outside `liveRank`'s live set, so a queued card neither floats up its
column nor counts as In progress. It is a reading, never
a block: dispatch, the Orchestrate sheet and every gate ignore it, because the label is a plan and the claim is the only exclusion.

**Dispatch is drawn exactly as it is for a files item (task-46).** Task-45 hid the control here, because a spawned session would have run the file-writing
skills against a project with no files; phase 3 made that false — the skills write through the API — so `deriveAction` asks nothing about an item's `source`
and a tracker card gets the same chip on the same rules. The per-item block that stops a CLAIMED item is the ordinary one: `progressBlock` reads the `started`
the mapper fills from an unreleased claim and disables the control with its usual sentence. Its one tracker-specific branch is #227's, described above under
"A stale claim reads stale": a stale hand claim lets dispatch through, a stale run-held or board-dispatched one still blocks, and the server re-checks a tracker
item's claim at dispatch (`itemClaimBlock`) where it never re-checks a files item's stamp.

**The toolbar's Orchestrate control is drawn for a tracker project too, since task-47 (phase 4a).** Task-46 kept it off with a fifth condition,
`projectIsFiles` (`lib/tracker.ts`), because a tracker project could not then be orchestrated at all; phase 4a made it orchestratable, so that predicate is
DELETED — it had exactly one job and its own doc comment said so — and `showOrchestrate` is back to the four conditions it had before phase 3. The server's
matching refusal went at the same time; the two were always one rule stated twice.

The sheet needed no change to follow: its `uncommitted` column already renders nothing when the endpoint answers `known: false`, which is what
`GET /api/items/uncommitted` answers for a project whose items are issues.

## Interfaces

- `lib/agents.ts` — same-origin fetches against `/api`.
- `hooks/useAgents.ts` — status poll on mount and window focus, plus the one re-ask a click against a project-visibility block provokes.
- `hooks/useOrchestratorRuns.ts` — the same cadence, plus a 5s poll while any run is fresh or still `running`, any `remote` run is `running`, or any
  `starting` entry is present, plus a grace window after a Resume click.
- `hooks/useOrchestratorArchive.ts` — mount and window focus only; history moves at run boundaries, not on a heartbeat.
- `hooks/useWatchdog.ts` — mounted by the Watchdog page alone; the runs payload it annotates comes in as a prop.
- `hooks/useBoard.ts` — mount and window focus, plus a 15s poll while any registered project's `source` is a tracker whose sync is not `off`
  (`hasSyncingTracker`, #17): a tracker's items move on the server's poll clock, which this tab has no event for. No syncing tracker means no interval at all.
- `hooks/useTrackers.ts` — the shell's one instance, provided by `TrackersProvider` (`hooks/TrackersContext.tsx`) and read by the chip and by the Shared
  Settings Trackers card through `useTrackersContext`. Mount and window focus, plus a timer on the server's poll clock: `nextDelay` arms the next read
  `TRACKER_FETCH_SLACK_MS` after the newest stamp's cycle ends, drops to a 1 s floor while any `ok` repo of the same sweep is still due (the server stamps repos
  one after another, so the newest stamp lands before the sweep does), and waits one whole cycle — never the floor — once the newest deadline has passed with
  nothing due (overdue or failing stamps do not move) and after an error. No github row means no timer at all. Since #17 each row counts on its own
  `syncCycleMs`: the deadline is the EARLIEST next stamp still ahead, a row is due for one base cycle after its own cycle ends, `off` rows are skipped, and a
  payload whose every github row is off sets no timer — nothing on the server moves it, and the card's own save refetches. Reads that overlap (focus, timer,
  the save's refetch) are sequenced, not cancelled (#231): only the newest may set state or arm the timer, so an older answer that settles last does nothing.
- `hooks/useProjectSources.ts` — one read of `/api/projects` on mount, failing soft to an empty map: the Runs page needs each project's `source` for one
  explanatory line, and a committed marker changes on a commit rather than on a poll.
- [`shared/`](../../shared/agent.ts) — the derivations the server needs too, beside the wire types. `shared/` never imports from `client/`.

## Invariants

The rules this surface is held to — one implementation per derivation, board-versus-archive being derived and never stored, the three per-item dispatch blocks
and which one lets a click through, the dialog escape stack and its three entries, a crashed run rendering as crashed, "queue wait is not work",
[Settings being two pages whose page IS the scope](invariants.md#settings-is-two-pages-the-page-is-the-scope), and
[the content-width stamp that the CSP hash travels with](invariants.md#contentwidth-is-stamped-before-first-paint-and-the-csp-hash-travels-with-it) — are in
[invariants.md](invariants.md), with the failure each one encodes. Not restated here.

<!-- docs-sync:
  sources:
    - client/src
    - shared/types.ts
  kind: subsystem
  verified: 5034d2de2916b416fcb5d654aa12b07a73507cdd
-->