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
| `Marker`               | `.ui-marker`      | `tone: groomed\|kind\|done\|stale`, `children`                                                    | `ItemCard`'s marker row (Board and Archive draw the same card)                  |
| `ProgressRow`          | `.ui-progress`    | `name?`, `value`, `max`, `caption?`, `valueText?`, `hatch?`, `height?: 10\|6`, `fill?: progress\|ink\|warn` | the Watchdog page's sweep meter and per-row heartbeat meter                      |
| `Ledger`, `DayKicker`  | `.ui-ledger`      | `Ledger{columns?, children, label?}` owns the `overflow-x` box; `DayKicker{children}`            | Runs History's day groups, the Watchdog activity feed                           |
| `Modal`                | `.ui-modal`       | `label`, `facts`, `children`, `onClose`                                                          | `ItemModal` — the only modal in the app                                         |
| `FormSheet`            | `.ui-form-sheet`  | `label`, `title`, `steps?`, `footer`, `children`, `onClose`                                      | `LaunchSheet`, `OrchestrateSheet`                                               |
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
`StageBars`, `WatchdogMonitor` (runs). `RunControls` and `RunRowTime` sit at the top level of `components/`, like `lib/view-keys.ts`, because two lazy chunks
read each of them.

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
3. **Modes.** All five pickers — permission mode, model, effort, merge mode, question mode. Every one but permission mode seeds from Settings: model and effort
   off the same `dispatchDefaultModel` / `dispatchDefaultEffort` keys the launch sheet reads, merge and question mode off the two orchestrator defaults.
   Permission mode has no stored default and starts at `auto`, clamped down to whatever ceiling the dashboard reports. Plus, in merge mode, a setup hint fed by
   `GET /api/agents/merge-check`.

Both sheets and the item modal are the three dialogs on the escape stack, and neither the sheets nor the modal binds a key of its own: `Modal` and `FormSheet`
call `useDialogEscape` for whatever they wrap.

### What leaves the Board

An open refactor, idea or bug nobody has touched inside the staleness window (30 days by default, `Settings → Board → Archive after`) leaves it for Archive on
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
- **The History sheet** holds one row per finished run under day kickers, newest first: the dot and the status word from `runStatusChip`, the project, the
  two-tone count, wall time and the cost beside it when usage exists, behind a counted `load more` in pages of 25 — a render decision over a corpus the client
  already holds whole, exactly as the staleness window is. A row **selects**; nothing opens, and there is no run modal anywhere in the app.
- **The detail sheet** shows the selected run whole: a head with the project, the run id and `RunControls` (Pause, Cancel with its `Pausing after <id>` note,
  Resume for a paused run, and Resume for a crashed one exactly when `watchdogStoodDown` says the sweeper will not); then the facts strip, the mode and question
  notes, the chip row, `git merge --no-ff <branch>` per branched item, the items in pipeline order — each with its stage chip, its `RowTime` reading, its
  seven-node `StageTrack`, its usage line, its assumptions under `decide`, and its last verification as a disclosure, open when failed. Machine time by stage
  for this run alone comes after the items, and the attention entries last of all — an empty attention list is the common case and the chip row already carries
  its count, so the section earns the screen only when it has something in it. Selection is one run across both sheets: the first live run is selected on
  arrival, and with nothing live the newest History row is, so the Board's run chip lands a reader on the current item's stage track with no second click.


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
| **Shared** | Orchestrator watchdog | Claude Agents |

Each card is still a title plus a scope (`this device`, `this machine`, `this server`) answering a different question from the name: whether changing this
affects anybody but the person changing it. Both pages draw the same two hand-placed columns, so a card does not move to the other side of the page when its
neighbour grows a row; one column under 1100 px. The balances differ — Local is two short cards against two taller ones, Shared is the watchdog's long card
against the agents report.

Local holds themes, density, text scale, content width, landing section, the staleness window, the two orchestrator run defaults, and `Dispatch` — the default
model and effort every launch sheet seeds from, the dashboard link base, and the `open dashboard ↗` link, which rides the `Dashboard link` row it reads its href
from. That card is what the old `Claude Agents` card's per-device half became: that card mixed backends, and a page that promises a scope cannot carry one that
does. What stayed on Shared is genuinely the host's — the dispatch status lines and the conditional `Setting it up` block — on a status row with no control in
its right slot at all.

The watchdog card is the one place Settings writes to the server — four knobs that live in `settings/watchdog.json` beside the registry rather than in this
browser, plus a `Live view` link that opens Runs › Watchdog through the same pair the rail's tree calls. Because it is the one write, it is also the one card
that can be refused: a rejected `POST /api/agents/watchdog/config` renders one red line in its own row directly under the control it was refused for, while
every knob keeps showing the value the server actually holds. That is a separate hook field (`saveError`) from the failed-GET `error` beside it, because a
failed read replaces the whole group and a failed write must not.

`contentWidth` is the one setting here whose effect is not drawn by a component at all: `fixed | full`, stamped on `<html>` as `data-width` pre-paint and by
`useSettings`, releasing `.wrap` and `.wrap.wide` through one CSS block. Every section renders in `wrap wide` — Settings included since the split, which took
the shell's narrow-Settings exception away.

## Interfaces

- `lib/agents.ts` — same-origin fetches against `/api`.
- `hooks/useAgents.ts` — status poll on mount and window focus, plus the one re-ask a click against a project-visibility block provokes.
- `hooks/useOrchestratorRuns.ts` — the same cadence, plus a 5s poll while any run is fresh or still `running`, or any `starting` entry is present, plus a grace
  window after a Resume click.
- `hooks/useOrchestratorArchive.ts` — mount and window focus only; history moves at run boundaries, not on a heartbeat.
- `hooks/useWatchdog.ts` — mounted by the Watchdog page alone; the runs payload it annotates comes in as a prop.
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
  verified: 5b6b41947305a51632bdfbb64c217a6e232e6f51
-->