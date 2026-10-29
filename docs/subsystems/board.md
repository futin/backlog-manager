# The board (client)

A React SPA in five sections behind a side rail — Files, GitHub, Jira, Runs, Settings — each page its own lazy chunk, Files and GitHub drawn only while a
registered project has that source, Jira only on a machine whose server says it is configured ([jira.md](jira.md) has its client half). The server returns whole
corpora, so most of what appears on screen is decided here: whether an item is groomed, whether it belongs on the Board or in Archive, how long an item's work
took, what a run cost. Those derivations live in `client/src/lib/` as one implementation each, so two surfaces cannot disagree about the same item.

The look is not decided here. [`.claude/DESIGN.md`](../../.claude/DESIGN.md) is the visual language — §1–7 the system, §8 how this board applies it, one
subsection per surface — and every component cites its subsection in a header comment. This document is the mechanism: what each surface is made of, what it
reads, and which file owns each decision.

## Mechanism

### The rail

Files / GitHub / Jira / Runs / Settings, a plain section switch, with one rule drawn above Settings. `SECTIONS` in `client/src/lib/sections.ts` is the one
runtime list of them — it lived in `SideRail.tsx` until the rail gained a `useSettings` read and the two files closed an import cycle — and the rail keeps only
the LABELS, as a `Record<Section, string>`, so a section added to the list cannot ship without one. `resolveLegacySection` (`client/src/lib/source-page.ts`)
maps a stored value that names no section — the root `board` and `archive` from before the source rows, the older `'projects'`, a hand-edited value — onto a
PROVISIONAL GitHub, remembering the page a `board`/`archive` meant, and the shell settles it on the first projects answer (below), so an upgrade never opens on
a blank main area.

One URL beats both the stored section and `landing` (#328): `readDeepLink` (`client/src/lib/deep-link.ts`) reads `section`, `runs=history|watchdog` only beside
`section=runs`, and `settings=local|shared|dashboards` only beside `section=settings`, and ignores anything it does not recognise, so a bad link opens the app
as a plain load does — an old `?section=board` included, since it names no section. Lookout's Orchestrator tile opens `/?section=runs&runs=history`. `App` reads
it once, in a `useState` initializer for the no-flash reason — the Runs page through the same `setRunsMode` the tree calls, the Settings page through `update({ settingsScope
})` in a layout effect — then records the section as a rail click would and strips the parameters with `history.replaceState`, so a reload reopens
where the reader has gone since.

`jira` (Jira phase 2) is a member of the list unconditionally, because `resolveLegacySection` runs in a `useState` initializer before `GET /api/jira` has
answered; the conditional half is the shell's. The rail's `drawn` skips the Jira row unless the shell's one `useJira` says `configured: true`, or the status is
still unknown while `jira` is the section on screen; `App` falls a `jira` section to the first drawn source row (`firstDrawn`, Runs when there is none) on
`configured: false` and holds it on anything else, drawn in `JiraView`'s `loading…` or `Jira unavailable` line; and Settings' `Opens on` offers `Jira` only
while configured. Why each half is the way it is:
[invariants.md](invariants.md#the-jira-sections-two-pages-are-switched-by-the-rails-tree-and-the-section-is-drawn-only-when-configured).

`files` and `github` are members of the list unconditionally for the same reason, and their conditional half is the projects answer's. `ProjectsProvider`
(`client/src/hooks/ProjectsContext.tsx`) is the shell's one read of `GET /api/projects` — through `useRefreshing`, mount and focus, no poll — keeping its last
answer on a failure, and `drawnSources` (`client/src/lib/sources.ts`) turns it into `{ files, github }`, `null` while unknown. `sourceSectionOf` puts a `github`
project under GitHub and a `files`, `unsupported` or source-less one under Files, as display grouping only. The rail draws a source row while its flag is true,
or while the answer is unknown and that section is on screen and not provisional. `App` moves nothing while the answer is unknown; once it exists, a provisional
landing settles once (`settleSection` for a page-named one, `firstDrawn` — Files, then GitHub, else Runs — otherwise) and a legacy `Opens on` pin is rewritten
to where it settled; a source section whose row the answer no longer draws falls to `firstDrawn`. Until a provisional landing settles the well draws the
section's loading shape, so a files-only machine never flashes a GitHub board. Settings' `Opens on` offers Files and GitHub only while drawn (`landingOptions`),
keeping a stored pin's option. Why:
[invariants.md](invariants.md#a-source-row-is-drawn-only-while-a-registered-project-has-that-source-and-its-pages-are-switched-by-the-rails-tree).

A section that fails to render does not take the rail with it (#270). The lazy sections sit inside `SectionBoundary`
(`client/src/components/SectionBoundary.tsx`), keyed by view (`files:board`, `github:settings`, `runs`, …) so a crash on one source page does not follow the
reader to its sibling. It draws `this section failed to load` and a reload button in the well; switching views clears it. Its common cause — a rebuild
deleting the chunk an open tab asks for next — rarely gets that far: `installPreloadReload` (`client/src/lib/preload-reload.ts`, installed in `main.tsx`)
answers Vite's `vite:preloadError` with one page reload, and a second failure within `RELOAD_GUARD_MS` of it (a timestamp in `sessionStorage`) is left to the
boundary instead, so a chunk a reload cannot bring back never loops.

The wordmark is a prompt, `BACKLOG` over `› manager▌`, whose cursor blinks while a run on this machine is working (`.claude/DESIGN.md` §8.0). The answer is
`runsWorking` (`client/src/lib/run-pulse.ts`: a `starting` entry, or a local run `running` and not `isCrashed`), and `App` polls nothing to get it — each
source's Board and Archive, and Runs, already run a `useOrchestratorRuns()` and report it up through `useReportWorking`; `App` keeps the report tagged with the
view that made it (`files:board`, `github:archive`, `runs`, …) and drops it on a view change, so Settings, which reports nothing, always shows a solid cursor.

Every section has a sub-nav tree under its row: Files (Board, Archive), GitHub (Board, PRs, Archive, Settings), Jira (Board, Setup), Runs (History, Watchdog, Ticks)
and Settings (Local, Shared, Dashboards). All five are drawn by one component, `RailTree`, because the markup carries three details that must not drift — the
`rail-sub`/`rail-sublink` classes, `aria-current="true"` rather than `"page"`, and closing the phone menu on a pick. What each call site supplies is only what
legitimately differs: the item list, which of them is current, and what a pick writes. In every case the tree is the **only** control that switches between the
two views — there is no in-page switch at any width (`.claude/DESIGN.md` §8.0).

The two trees differ in where their value lives, and the difference is not arbitrary. Runs' mode goes through `useRunsMode` (`client/src/hooks/useRunsMode.ts`),
a module-level value every mounted reader subscribes to, because the rail is not its only writer — the Watchdog page's own rows jump back to History with a run
selected, and the Settings watchdog card's `Live view` link opens Watchdog — and a second copy would let the rail and the page look at different views;
`lib/runs-mode.ts` stays the one home of the key, the member list and the guard. Settings' scope is a field on the settings object instead, because both of its
readers already sit inside `SettingsProvider` and nothing outside Settings writes it. Jira's page takes Runs' road for Runs' reason: `useJiraPage`
(`client/src/hooks/useJiraPage.ts`) is a module store over `lib/jira-page.ts`'s `JIRA_PAGES`, key and guard, because the tree is not its only writer either —
Setup's `Open board` and the empty board's `Open Setup` land on a page too, through `onOpenJiraPage`, the tree's own pair (`setJiraPage`, then the shell's
`change`) built once in `App` and handed down, as the Settings watchdog card's `Live view` is `onOpenWatchdog`. The source rows' pages take the same road:
`useFilesPage` and `useGithubPage` (`client/src/hooks/useSourcePage.ts`) are module stores over `lib/source-page.ts`'s `FILES_PAGES`/`GITHUB_PAGES`, keys and
guards, written by the tree, by the shell's legacy-landing initializer and — GitHub's — by the Sources card's `GitHub › Settings ↗`, which is
`onOpenGithubPage`, the tree's pair built once in `App` the same way.

The rail's last element is the version chip, `v0.2.0` or `v0.2.0+3`, with a cyan dot while a release has landed since this browser last opened the
What's new drawer behind it; the shell owns the read, the dot and the drawer, and renders the drawer outside the rail. All of it is
[releases.md](releases.md).

Below 700 px the rail is a bar across the top with a menu, and every tree stands open inside it — the version chip is its last row. `useNarrow` (`client/src/hooks/useNarrow.ts`) is the one place
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
| `Chip`                 | `.ui-chip`        | `variant?: outline\|ink\|flat\|danger`, `size?: 32\|28`, `pressed?`, `as?: button\|label`, `icon?`, `onClick?`, `disabled?`, `title?`, `type?`; forwards a `ref` to the button, so a chip can be a `Popover`'s `anchor` | every band and control row, `RunControls`, `GatedChip`, both sheets, load-more |
| `GatedChip`            | none (draws `.ui-chip`) | `gateBlock`, `otherBlock`, `idleTitle`, `reverify?`, `recheck`, `onActivate`, `variant?`, `size?`, `children` (a node, or a function of `blocked`) — the disabled half is `gateView` (`lib/gate-view.ts`) | `DispatchButton` (card and modal), the Board band's Orchestrate chip |
| `Pill`                 | `.ui-pill`        | `tone?: neutral\|live\|warn\|bad\|done`, `title?`, `off?` (a state any tone can be in — `ui-pill-off` beside the tone class) | column counts, run mode, stage words, `crashed`, `paused`, `uncommitted`, `DashboardDetail`'s model and effort pills (`off` for one the machine may not run) |
| `Dot`                  | `.ui-dot`         | `size?: 8\|10`, `breathe?`, and either `tone?` or `hue` (1–8, through `project-hue.ts`)          | card foot, column header, run chip, Runs rows, modal facts                     |
| `RunOn`                | `.ui-run-on`      | `offers: ProjectOffers`, `value`, `onChange` (draws nothing below two machines)                  | `LaunchSheet`, `ModesStep` (Orchestrate step 3)                                 |
| `Marker`               | `.ui-marker`      | `tone: groomed\|kind\|done\|stale\|untyped\|match\|machine`, `children`, `title?`    | `ItemCard`'s marker row (Board and Archive draw the same card), `JiraCard`'s `match` marker |
| `SpreadBar`            | `.ui-spread`      | `done`, `doing`, `todo`, `caption?` — a 4 px track of up to three segments, nothing drawn when all three are zero | `JiraCard`'s fold block, `JiraIssueModal`'s Children head |
| `JiraTypeIcon`         | `.ui-type-icon`   | `type` (a `JiraIssue['type']`) — the glyph by what the type is: sub-task, epic or above, bug, story, else task | `JiraCard`, `JiraIssueModal`'s Children rows |
| `ProgressRow`          | `.ui-progress`    | `name?`, `value`, `max`, `caption?`, `valueText?`, `hatch?`, `height?: 10\|6`, `fill?: progress\|ink\|warn` | the Watchdog page's sweep meter and per-row heartbeat meter                      |
| `Meter`                | `.ui-meter`       | `label`, `value`, `fraction` (clamped; `null` draws empty), `tone?: green\|amber\|red`, `width?` (px, default 56, or `'fill'`) | `TrackerChip` — the chip's POLL and API meters, the popover's rows and API block; `JiraChip`'s POLL and CALLS; `RunOn`'s 5 h and week bars; the Dashboards list rows' and detail's usage meters |
| `Ledger`, `DayKicker`  | `.ui-ledger`      | `Ledger{columns?, children, label?}` owns the `overflow-x` box; `DayKicker{children}`            | Runs History's day groups, the Watchdog activity feed                           |
| `Modal`                | `.ui-modal`       | `label`, `facts`, `children`, `onClose`                                                          | `ItemModal`, `JiraIssueModal` — the app's two modals                            |
| `FormSheet`            | `.ui-form-sheet`  | `label`, `title`, `steps?`, `footer`, `children`, `onClose`                                      | `LaunchSheet`, `OrchestrateSheet`, `JiraBoardSheet`, `JiraLaunchSheet`, `DashboardSheet` |
| `Popover`              | `.ui-popover`     | `label`, `width` (px), `anchor`, `onClose`, `children`                                           | `FilterBar` (Filters, Sort), `TrackerChip`, `JiraChip`, the Jira board's picker, `JiraBoardSheet`'s roots search, `JiraRunMenu`'s `Run ▾` panel |
| `Segmented`            | `.ui-seg`         | `value`, `options`, `onChange`, `disabled?`, `label?`, `pill?`                                   | Settings (density, text size, staleness), the Runs range control (stroked, not `pill`), `JiraBoardSheet`'s sync interval, `JiraBranchSection`'s branch mode |
| `Select`               | `.ui-select`      | `value`, `options` (each with an optional `group`, drawn as a native `<optgroup>`), `onChange`, `disabled?`, `label?`, `title?` (a disabled select's sentence) | Settings rows, `WatchdogGroup`'s three ladders, `TickGroup`, both sheets' pickers, the Jira launch sheet, branch section, board sheet, Repositories card and the issue modal's `Move to…` |
| `NumberField`          | `.ui-number`      | `value`, `min`, `max`, `unit?`, `onCommit`, `label?`, `disabled?`                                | `SuggestCard`'s threshold (Settings › Dashboards) — see below                   |
| `Switch`               | `.ui-switch`      | `checked`, `onChange`, `label?`, `disabled?`, `onLabel?`, `offLabel?`, `title?`                  | `WatchdogGroup`'s Enabled row, `LaunchSheet`'s toggle, `JiraLaunchSheet`'s toggles, `JiraBranchSection`'s `Open MR when done` |
| `Chevron`              | `.chev`           | `dir?: down\|up\|right` (default `down`), `className?` — one 10×10 stroked path, the other two directions rotations of it | `TrackerChip`'s and `JiraChip`'s carets and the Jira board picker's (`up` while the popover is open), `DispatchButton`'s mark (`right`), `JiraRunMenu`'s `Run ▾` caret |
| `Fact`                 | `.item-fact*`     | `label`, `children` — one label over its value; the call site decides whether it is drawn at all | `ItemModal`, `JiraIssueModal` (the facts column)                                 |
| `SettingsRow`, `SettingsGroup` | `.set-row`, `.set-group` | `SettingsRow{name, hint?, children?}`; `SettingsGroup{title, scope, right?, children}` | every Settings card, the Jira Setup cards, `JiraBoardSheet`'s Name & sync rows |
| `LiveStrip`            | `.board-card-live` | `tone`, `label`, `mark` (`null` draws no right-hand reading), `title?` — `stale` is the one tone the stylesheet reads, and it drops `.hatch` | `ItemCard`, `JiraCard` (a live session) |

`label` and `title` are separate props on both overlay shells because a dialog's accessible name and its visible title are different strings on every surface
that draws one, and `title` is a node — a name cannot be derived from it.

Two entries differ from the design spec's §12.2 table on purpose, and both are code's reading rather than the spec's: `StageBars` draws its own bar rows rather
than composing `ProgressRow` (the spec listed it as a composer), and `NumberField` has **one composer, and a late one** — the watchdog's three numeric
policy values are `Select` ladders, and Settings' own numeric rows re-seed on commit with the same idiom rather than the component. It was kept unused because
the family is part of the 36 px control set guard 7 pins, and because a numeric row was the next Settings addition's obvious control — which is what the
Dashboards page's Suggest card threshold (1–100 %, #340) turned out to be, and why `disabled` joined its props: the card can show the stored figure on an
unreadable `dashboards.json` but cannot save one.

The last three rows are the exception to the table's opening rule, and on purpose. `Fact` (hoisted out of `ItemModal`) and `SettingsRow`/`SettingsGroup`
(promoted from `settings/`) moved into `ui/` in Jira phase 2 because a second surface now draws each — the Jira issue modal's facts column, the Jira Setup
page's cards — and a component only one directory can import is the drift the one-home rule exists to stop. Their CLASSES did not move: `.item-fact*` and
`.set-*` were never `.ui-*` families, they sit outside the ui primitives block, and guard 7 does not pin them, because the hoist moved the components and
left their CSS byte-for-byte where both surfaces already read it. `LiveStrip` followed for the same reason in Jira phase 5: it was `ItemCard`'s inline markup
until the Jira card needed the same band for a live session, and the component owns the markup while `.board-card-live` stays the stylesheet's, declared once.
Everything else page-shaped stays in its section's directory: `ItemCard`, `BoardColumn`,
`RunChip`, `ItemModal` (board); `RunsView`, `RunDetail`, `StageTrack`, `StageBars`, `WatchdogMonitor` (runs); `JiraView`, `JiraBoardView`, `JiraCard`,
`JiraIssueModal`, `JiraSetupView`, `JiraBoardSheet`, `JiraReposGroup`, `JiraConnectionGroup`, `JiraSkillsGroup`, `JiraWorktreeRow`, `JiraRunMenu`,
`JiraLaunchSheet`, `JiraBranchSection` (jira). `JiraChip` sits at the top level of `components/` beside
`TrackerChip`, because the shell draws it. `FilterBar` sits at the top level of `components/`, like `lib/view-keys.ts`, because more than one lazy chunk
reads it (Board, Archive and the Jira board); `RunControls` sits there too, though only the Runs chunk reads it (`RunDetail`, `WatchdogMonitor`), and
`RunRowTime` is in `board/`, where the run drawer that first read it lived — `RunDetail` is its one reader now. `FilterBar.tsx` is three components, not
one: the band's filter-and-sort track with its two popovers (`FilterBar`), one
section of the filter popover (`FilterSection`, whose `fill` flag lays a switch out full width) and the `Project` section both pages draw (`ProjectPicks`) — the
last two so that no page draws a section heading or a project chip of its own. Its family is `.filter-bar*`, never `.ui-*`.

### Board

Drawn once per source: Files › Board and GitHub › Board are one `BoardView` with a required `source` prop. The index is cut by `narrowToSource` and the project
list by `projectsIn` (`lib/sources.ts`), hues stay keyed on the whole registry so a project keeps its colour on either page, and the project filter is stored
per source (`projectKey(source)`, `lib/view-keys.ts`). The warnings strip shows only the index errors `errorSource` routes to this source. An empty cut reads
`nothing registered yet` only when this source has no registered project; with one, it reads `no items yet` — a freshly connected repo with no open issues,
or an empty files store — since the rail draws the row because that project is registered. Archive has the same pair.

A `Band` titled with the scope — `All projects`, or the picked project's name, since the picker is behind a popover — and no count line, then search, the
filter track (`FilterBar`: a `Filters` popover holding the Project picks, the Status switch and the `Awaiting review` toggle (#387), with `Clear all`; a `Sort by` popover holding the three
keys and an `Ascending`/`Descending` switch, each key arriving in its natural direction) and the Orchestrate chip, then four fixed columns
(refactors/ideas/bugs/tasks). Out-of-scope has no Board column at all; it belongs to Archive. A click on a card opens the **item modal** — `ItemModal`
composing `Modal`: a facts column (project dot and name, id, section, the created / updated / last-commit stamps, `groomed`, tags, the `in progress since`
reading while a session holds the item, the elapsed and token counters when present, the file path, the dispatch control) beside the item's rendered Markdown
body, folding above it under 700 px. The body goes through `renderMarkdown` (`client/src/lib/markdown.ts`), the sanitising `marked` configuration hoisted
out of `ItemModal` in Jira phase 2 so the Jira issue modal renders a ticket's description through the same function: raw HTML never renders as markup — a comment renders as nothing and any other tag as escaped literal text, so `Promise<void>` survives in prose, and text marked lexes inside an inline `<script>`/`<pre>` is escaped too (#350) — a link may name only
`http`, `https` or `mailto` (or no scheme), and an image may name no scheme at all, so the board makes no outbound fetch on a viewer's behalf.

Beside the band's title sits the **run chip** (`RunChip`), the Board's whole account of orchestrator runs since the run strip, the starting strip and the run
drawer left it: a `Dot` taking the worst state present and a count line naming every state in that same order — `2 runs · 1 live ›`, `1 run · crashed ›`,
`1 starting ›`. Precedence is exact: crashed over paused or starting over live. It renders the payload's `starting` array with no client-side filter, it is
absent entirely when there is no run and no starting entry, and clicking it switches the section to Runs, where the rest of the reading lives. A remote
orchestrate launch adds a segment per machine after the local ones, `Starting on Pro` or `2 starting on Pro`, read off the payload's `remoteStarting` array
(`orchestrateStarting` — a card dispatch is its card's alone). It is never folded into `starting`, which blocks local Orchestrate, and never reads `1 starting`,
which would claim the run is starting here; it holds the `starting` tone for the dot and never makes it breathe, and counts toward the chip's presence rule.

A dispatch control — on the card and again in the modal — opens a launch sheet onto `../claude-agents-dashboard`. An execute's sheet adds a **Finish**
picker (`In place` / `PR`, seeded on every open from the `executeDefaultFinish` setting, default `In place`, never from the last launch) and, under PR, a
**Base** select (the project's local branches, seeded to the literal `main` and never stored; a failed branch fetch leaves `main` alone) and two Switches,
`auto-merge` and `fix if it fails` (seeded from `prAutoMergeDefault` and `prFixDefault` each time the finish becomes PR, cleared on leaving it; Fix is disabled,
not hidden, while Auto-merge is off, and turning Auto-merge off takes Fix with it). A groom's sheet draws the same Finish/Base/toggle rows, seeded from
`groomDefaultFinish`, but only for a groom run on home: a remote groom has no finish (the server 400s one, and its clause is always the commit rule), so
the rows wait for `useRunOn`'s `loading` to clear — until the offers answer `runOn` reads home, and a suggested remote landing a moment later would take a
Finish the person had already touched away. Below the editable body a read-only line shows the closing clause exactly as the server will append it, tracking
every control; `finish` is sent on every execute launch (and a home groom's), `base`, `autoMerge` and `fix` only under PR, and `fix` only as `autoMerge &&
fix`. A capture sheet keeps its closing rule inside the editable text. The toolbar Orchestrate control opens
`OrchestrateSheet`, three steps inside a `FormSheet`, with Start on the last one alone so it never sits under a scroll region whose length is the project's
queue. The sheet itself holds only `step`: the run's state, its three reads and Start are `hooks/useOrchestrateDraft.ts`'s, the derivations
`lib/orchestrate-draft.ts`'s, and each step is a presentational view under `board/orchestrate/` — `ItemsStep`, `OrderStep`, `ModesStep` — over the one
`OrchestrateDraft` the hook returns (#306):

1. **Items.** Previews the queue and selects a subset of it, flagging with an `uncommitted` chip every row whose file on disk is not the file at `main`, and
   a note that states only the fates actually present, each with its own count — absent from `main` is skipped in the run's own words
   (`not committed on main`), present-but-stale is gated and run on `main`'s bytes — read per row from the endpoint's `absent`, and carried on each flagged
   row as the pill's `title` and a `data-fate` attribute, plus a `deselect uncommitted (N)` control. Fed once per sheet open, and again per base picked (#254 — every `main` here reads as the picked base, the note and the pill titles included), by
   `GET /api/items/uncommitted?base=`, rendering nothing at all on
   `known: false` or a failed/malformed answer, and deliberately changing no default: an untouched sheet still posts no `ids`.
2. **Order.** Hand-orders that selection with ↑/↓ and a reset (`order: string[] | null`, `null` meaning queue order, reconciled against the live queue every
   render, never stored resolved). The screen says a `runner-fix:` item may still hoist above the chosen order, and that it cannot tell which.
3. **Modes.** Six pickers — permission mode, model, effort, merge mode, question mode, base branch. Four of the six seed from Settings: model and effort off
   the same `dispatchDefaultModel` / `dispatchDefaultEffort` keys the launch sheet reads, merge and question mode off the two orchestrator defaults. The other
   two deliberately do not, for opposite reasons. Permission mode has no stored default and starts at `auto`, clamped down to whatever ceiling the dashboard
   reports. **Base branch seeds from the literal `'main'`, never from Settings** (task-44): its two neighbours have permanently sensible values, while a base
   names one experiment's branch, so a stored one would outlive that experiment and silently send a later run onto a stale feature branch. Its options come
   from `GET /api/agents/branches`, fetched once per sheet open, falling back to `['main']` alone on any failure and never blocking a launch. Plus, in merge
   and PR mode (a PR run asks the classifier for the same merge at every item), a setup hint fed by `GET /api/agents/merge-check`,
   and, for a non-`main` base, a note saying `main` will not be written. The merge-mode picker's own
   option words come from `mergeModeOptionLabels` (`lib/merge-mode.ts`) and are **derived from the picked base** — `Merge to <base>` — so the control and that
   note are one statement rather than two that can disagree (bug-36). Settings, picking a default before any run and so before any base exists, calls the same
   function with `null` and gets `Merge into the base branch`; `null` there means "no base is knowable", never `main`. The third option, `pr`, reads
   `Open a PR into <base>` (`Open a PR into the base branch` in Settings) and is **offered only for a `github`-source project**: the sheet takes a `source`
   prop that `BoardView` passes from the registered project's `ProjectSummary.source` — never off `items[0]`, which an empty queue does not have — and a `pr`
   Settings default (or a `pr` pick left over from another project) reads as `merge` on any project whose source is not `github` — `files`, `unsupported` or
   none. Settings is pre-project, so it lists `pr` for every project and leaves the refusal to the sheet and to the server's 400.

**Run on, when more than one machine can take the launch.** `components/ui/RunOn.tsx` draws one toggle card per machine at the top of both the launch sheet and
Orchestrate step 3 (`.ui-run-on`, declared once, because two surfaces draw it): the name, the account line, a 5 h and a weekly bar, and the 5 h reset time, with
`Suggested` and `home` tags, a line saying which strategy suggested it, and the age of the usage readings at the top right. A machine the server did not offer
is drawn disabled with its reason in the card. The group draws nothing below two machines, so a files project or a setup with no remote is the sheet it always
was. `useRunOn(project)` owns the state: one `GET /api/dashboards/offers?project=` per sheet open (`useOffers`), the pick held as `null` until a person clicks
and otherwise derived from the offers (`defaultMachine` — the suggestion, else the first offered, else home), so a sheet that opens before the answer lands is
on home and moves to the suggestion when it arrives, and a person who has already clicked is never moved. A remote pick LOCKS Finish and Merge mode to `pr` (the
controls read as PR with the reason beside them) and narrows model and effort to the machine's lists, each select keeping its "default" option first; a
narrowed-away model or effort shows the Settings default (or the first listed) and switching back to home restores the Settings default — not the person's
pre-lock pick — while Finish and Merge are derived and come back for free. `''`, the "default", is never narrowed: it goes out as no key on every machine,
and the server fills a remote's model from that machine's list and sends no effort at all (final-review I4). The button reads `Start on
<label>`, and the request carries `machine` only for a remote pick — a home pick sends today's body, byte for byte. A failed offers read with nothing to show is
home, with a warning note (`OFFERS_FAILED_TEXT`), because blocking a local launch on a fan-out to other machines would make the board's only launch path depend
on them. Jira's launch sheet has no picker: its Start stays home-only ([jira.md](jira.md)).

Both sheets and the item modal — and, since Jira phase 2, the Jira issue modal and board sheet, since the release chip the What's new drawer, and since Jira
phase 5 the Jira launch sheet, and since the Dashboards form stopped editing in place its add/edit sheet — are the eight dialogs on the escape stack, and neither the sheets, the modals nor the drawer binds a key of its own: `Modal` and `FormSheet` call `useDialogEscape` for
whatever they wrap, and `ReleasesDrawer` calls it itself, since its shell is ui-kit's (#298) and is handed `closeOnEscape={false}`. Two further entries join the same stack
while they are drawn and are not dialogs: `ui/Confirm` (bug-53), described with the detail sheet below, and `ui/Popover` — the tracker chip's panel, the band's
Filters and Sort, and Jira's chip, board picker, roots search and `Run ▾` panel — which closes only itself, and whose click-outside is its own `pointerdown`, since the stack
owns the key and not the pointer.

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
rejection is a verdict rather than a type. There is no Tasks column, because a task never leaves the Board to fill one. It carries a search box and the Board's
own `FilterBar` without its sort half — a `Filters` popover holding the Project picks alone, and a picked project named on the count line
(`4 archived in alpha`) — and nothing else: its contents are defined by staleness and rejection, not by status, so a status filter there would either do nothing
or contradict the surface. No card here ever paints a live strip — whatever put an item in Archive already took it off the Board a run could be holding — which
`ArchiveView` guarantees by handing `ItemCard` no run at all. A card opens the same item modal the Board opens.

Archive is drawn once per source as well — Files › Archive and GitHub › Archive are one `ArchiveView` taking the same `source` prop, the same `narrowToSource`
cut, and its source's Board project key.

Nothing in it is finished, and both halves come back by their own route — a stale item by dispatching a **groom**, which refreshes `updated:` and puts it back
on the Board at the next load; a rejected one by dispatching a **capture**, which files a _new_ item citing `from: <id>` and leaves the original rejected on the
record. (That id keeps whatever prefix it always had — a rejection moves a file, it never renames one.) As everywhere else, the board writes no item file; the
spawned session does.

### Runs

Three pages under one rail entry. History and Watchdog read the one `useOrchestratorRuns` payload, so moving between them adds no request and neither owns a
second copy of the run list; Ticks reads its own `/api/ticks` through `useTicks` and joins nothing.

**History** — the section's default, and named for what a reader arrives looking for rather than for its contents, which are three parts present and one part
past. Its band counts all three states at once (`3 live · 1 starting · 28 past`) and carries the project select and the four-step range control (`RUN_RANGES`,
`lib/run-range.ts`, calendar-aligned windows on a run's `startedAt`, read in the shared time zone since #241), which scopes the figures, both lists and the wide
cell together.

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
  and cannot be selected: there is no run file for the detail sheet to show. A remote orchestrate launch (`remoteStarting`) is a starting row of its own,
  `Starting on <machine>`, equally unselectable; the `remote` pill on a remote run's
  row gains a machine tag naming the dashboard the run is on, and the sheet's head and the page's count line say `N launching elsewhere`. A crashed run —
  `running`, heartbeat stale — is a two-line row carrying all three
  of its readings together (`no heartbeat for <age>`; `last reported <id> at <stage>` or `all items at rest`; the `watchdogClause` sentence), and it is always a
  Live row, never a History one: which sheet a row belongs to is `splitLive`'s call (`lib/runs-list.ts`) on `running`/`paused` presence, with freshness
  deliberately excluded.
  A **remote** run (task-48 — another machine's run on a tracker project, from the payload's `remote` array) follows the same rule and carries a neutral
  `remote` pill beside the project, in either sheet.
- **The History sheet** holds one row per finished run under day kickers, newest first: the dot and the status word from `runStatusChip`, the project, the
  two-tone count, wall time and the cost beside it when usage exists, behind a counted `load more` in pages of 25 — a render decision over a corpus the client
  already holds whole, exactly as the staleness window is. A row **selects**; nothing opens, and there is no run modal anywhere in the app.
- **The detail sheet** shows the selected run whole: a head with the project, the run id and `RunControls` (Pause, Cancel with its `Pausing after <id>` note,
  Stop beside both — and on a crashed run too, which is the run a person most needs to end — Resume for a paused run with Stop beside it (#305, drawn even
  when the environment ladder hides the Resume), and Resume for a crashed one exactly when `watchdogStoodDown` says the sweeper will not. Stop asks first
  (bug-53): the chip is replaced in place by `ui/Confirm` naming the item it abandons and saying the run cannot be resumed — or, with nothing in flight and
  items parked, that the parked items keep their worktree and branch — and only its `Stop run` sends the
  request — `Keep running` and Escape send nothing. A run with a stop on file drops to the
  `Stopping` reading and offers no control at all — no withdrawal, because the `--abort` session has already been spawned, and no Resume in any branch) — and,
  when the run file carries a `prUrl` that passes `isPrUrl`, a `PR #<n>` link-out in the head's sub line, opened with `rel="noopener noreferrer"`; then the
  facts strip, the mode and question notes (`mergeModeLabel`'s pill reads `PR mode` for an effective `pr` run and `branch mode (downgraded)` for a degraded
  one), the chip row, `git merge --no-ff <branch>` per branched item, the items in pipeline order — each with its stage chip, its `RowTime` reading, its
  seven-node `StageTrack`, its usage line, its assumptions under `decide`, and its last verification as a disclosure, open when failed. Machine time by stage
  for this run alone comes after the items, and the attention entries last of all — an empty attention list is the common case and the chip row already carries
  its count, so the section earns the screen only when it has something in it. Selection is one run across both sheets: the first live run is selected on
  arrival, and with nothing live the newest History row is, so the Board's run chip lands a reader on the current item's stage track with no second click.
  Every reading in the head, the facts strip, the notes and the chip row is `runDetailModel` (`lib/run-detail.ts`, #271) — a pure function of the three
  tiers and one `now`, unit-tested without a render; the component keeps the fetch, the clock, the rows' own JSX and the machine-time rollup.
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

**Ticks** — the tick breaker's page (`TickMonitor`, `RunsMode` `'ticks'`), the third Runs page, built as the Watchdog page is and reached only through the
rail's tree. It mounts `useTicks({ live: true })` — the one source, a 15 s poll while the page is open — and takes no props. Its band (`Runs · Ticks`) carries
`N halted · M with tick history` and the same flat `Policy in Settings ›` chip, since the threshold is edited in Settings and a Reset is the only write here.
Three figures: the breaker (the halted count in the `bad` tone, naming the projects, or `none` over `after N failures in a row`), the last 24 hours
(`ticksLast24h`, the one reading that moves with no new payload, so the page's clock ticks at a minute) and the policy (`halt after N failures`; `tick.json
cannot be read — showing the default` when the server answers `source: "unreadable"`). Then a Projects sheet, one row per project the server listed, halted
first (`sortTickProjects`) — the streak, the lock, the newest records and a `Reset` button — and an activity ledger of the newest records across projects
(`tickActivity`). `streak`, `halted` and `haltedSince` arrive derived by the server (the rule is `server/src/tick/tick-breaker.util.ts`, never recomputed in the
browser), so a row prints a verdict rather than computing one. Reset is guarded twice, both in the component: a ref-held in-flight set closes the button before
the first POST settles, and the refusal (`saveError`, hook-wide) is shown under the one row last asked. A failed first read draws a notice, not an empty list,
so a page that could not reach the server never says the breaker is quiet.

### Settings

THREE pages, picked from the rail's tree and from nothing else — `settingsScope` (`local | shared | dashboards`) is the setting, `local` the default. **The page
is the scope**: Local is everything in this browser's `localStorage`, Shared and Dashboards are what the API reads off the host. The band states which in a
`Pill` at `neutral` (`this browser` / `this machine`, the latter on both host pages) and its subtitle is the page's own one-line summary; there is no in-page
switch at any width.

| Page           | Column 1                            | Column 2                                       |
| -------------- | ----------------------------------- | ---------------------------------------------- |
| **Local**      | Display, Board                      | Orchestrator, Dispatch                         |
| **Shared**     | Sources                             | Orchestrator watchdog, Backlog tick, Time zone |

**Dashboards** is not a two-column page; it is described below the cards.

Each card on Local and Shared is still a title plus a scope (`this device`, `this machine`, `this server`) answering a different question from the name: whether
changing this affects anybody but the person changing it. Both draw the same two hand-placed columns, so a card does not move to the other side of the page when
its neighbour grows a row; one column under 1100 px. The balances differ — Local is two short cards against two taller ones; Shared is the `Sources` report
alone in its left column, against the watchdog's long card, the `Backlog tick` card and the `Time zone` card in its right (the three machine-wide controls).
Shared once held `Dashboards` in that column too (task-45 added `Trackers` under `Claude Agents`, multi-dashboard put `Dashboards` between them, and
`Dashboards` absorbed `Claude Agents`) until the machine list outgrew a card and became its own page; Shared draws no dispatch line now.

Local holds themes, density, text scale, content width, landing section, the staleness window, the two orchestrator run defaults, and `Dispatch` — the default
model and effort every launch sheet seeds from, the dashboard link base, and the `open dashboard ↗` link, which rides the `Dashboard link` row it reads its href
from. `Dispatch` also carries `Execute finish` (`executeDefaultFinish`, the execute sheet's Finish seed), `Groom finish` (`groomDefaultFinish`, a home groom's),
`Auto-merge PRs` (`prAutoMergeDefault`) and `Fix if it fails` (`prFixDefault`, disabled while the row above it is off, its stored value left alone) and, only
while Jira is configured, `Jira default action` — the action a Jira card's `Run ▾` lists first, read through `resolveJiraAction` so a deleted skill's id reads
as `Work it end to end` while the stored value is left alone. That card is what the old `Claude Agents` card's per-device half became: that card mixed backends,
and a page that promises a scope cannot carry one that does. `Sources · this machine` (`SourcesGroup`) is the Shared report and is read-only by design, not by
phase: one row per source — Files (its project count, any unsupported or missing project, and the connect commands), GitHub (`as <login> · N of M left · resets
HH:MM`, `token set` or the no-token sentence, its project count, and one `repo · state` line per repo, sync off included) and Jira (`configured · <site> · N
boards`, `not configured`, `checking…` or `unavailable`) — plus a `Last read` row when a read failed and an earlier answer is shown. A project is connected by
committing `backlog/source.json`, so what the card offers instead of a button is the `backlog.mjs connect github <owner>/<repo>` command as copyable text, with
the repo read off that project's `origin` per request. It never shows the token — only whether one is set, and whose login it is. Its two links, `GitHub ›
Settings ↗` and `Jira › Setup ↗`, are the shell's pairs (`onOpenGithubPage`, `onOpenJiraPage`) threaded down through `SettingsView` and `SharedPage`, and each
is drawn only while the section it opens is drawn — GitHub's while the rail's projects answer draws its row (`useProjectsContext().drawn`, not the tracker
counts, which call an invalid-repo marker `unsupported`), Jira's while configured. The sync interval the old `Trackers`
card carried (#17) is GitHub › Settings' now (below).

**Dashboards** is the one page that writes the machine list (`DashboardsPage`, drawn to `.claude/DESIGN.md` §8.6): the Suggest card (`SuggestCard` — the three
strategies as a radio group, the threshold beneath) on top, then `DashboardsList` (360 px) beside `DashboardDetail`, and a footer, folding to one column at
1100 px. The list is the machines in prefer order with home first until moved; each row is its place, a health dot, its name, its account and two usage meters.
The detail is the selected machine's URLs, the `BM_MACHINE_NAME` a claim's `host` must equal, the models and efforts it may run and one token fact. Home's
detail also carries the dispatch status line (`DispatchStatus.tsx`, read by `useAgents`, so it draws even while the list has not loaded) and the `Setting it up`
steps while it is unhealthy. **Two reads, and neither waits on the other.** `useDashboards` reads the file once on mount (no poll, no focus trigger: the file
changes only when a person edits it) and every write — `POST /api/dashboards/entries`, `/entries/delete`, `/home`, `/settings` — answers the whole fresh view,
which the page draws rather than an optimistic copy. `useMachines` reads `GET /api/dashboards/machines` — health and usage per machine, up to two outbound
budgets on the server — on mount, on focus, every minute through `useRefreshing`, and at once after each write; the dots stay quiet and the meters absent
(`checking…`) until it answers, so a slow or dead remote can never hold the config. Its answer is matched to the list by machine id and its own order ignored; a
failed read keeps the previous answer. Selection is page state, never stored: the picked id is drawn while it is listed and the first machine otherwise.
**A token is never on the page in any form**: the payload carries `tokenSet` and the env var's name, and the fact says `✓ set` or `not set — needed only if that
dashboard does not trust this machine` (a tailnet-trusting dashboard takes a call with no token, so unset is the common case, not a fault); there is no field to
type one into, because the env var is the only place the server reads it from. Add and Edit open `DashboardSheet` (a `FormSheet`, one at a time) rather than a
form in place; Remove stays an inline `Confirm`. A same-name Add is held at the sheet (the server treats it as an update), every box ticked is sent as no list,
and an unreadable `dashboards.json` answers 409 on every write with the file left byte-identical — the page then disables every control and says so in a banner
([invariants.md](invariants.md#dashboardsjson-has-exactly-one-writer-the-server-and-a-file-that-cannot-be-read-is-never-replaced)). The RunOn group's Settings
link and the deep link `/?section=settings&settings=dashboards` land on this page: `settings=local|shared|dashboards` is read only beside `section=settings`.

Daylight is the default theme and the first one listed (`THEMES` and `DEFAULT_SETTINGS.theme` in `lib/settings.ts`); Midnight, the default until 2026-10-14,
is second. The default only reaches a browser that has no valid stored theme: `clampSettings` keeps any theme it recognises, so anyone who had already picked
Midnight keeps it. `theme.css`'s `:root` block still holds Midnight's palette, which is why `index.html`'s pre-paint script stamps `data-theme="daylight"`
before its `try` — a fresh browser, a corrupt blob or blocked storage paints Daylight with no dark first frame.

Since #17 ([spec](../superpowers/specs/2026-09-22-tracker-sync-interval-design.md)) the sync interval is the one thing this board sets about a tracker, and
since the source-sections change it lives on **GitHub › Settings** (`GithubSettingsView`: a `Settings` band, `how often this machine asks GitHub about each
repo`, with a `this machine` pill): a `Sync` card (`GithubSyncGroup`) holding a `Segmented` pill per `github` repo (`15s`, `1m`, `5m`, `off` —
`SYNC_INTERVALS`' keys, never a second list) in the row's right slot, or `nothing registered yet`, with an `Access` card (`GithubAccessGroup`) beside it that
appears only when the token cannot read some repo. It is a host card on a page outside Settings, which the scope
rule allows: the control governs one source, so it lives in that source's section
([invariants.md](invariants.md#a-sources-own-settings-page-may-hold-a-host-card)). Connecting stays read-only; the interval is how often THIS machine asks
GitHub, so it is the machine's, in `settings/tracker-sync.json`. `useTrackers().saveInterval` posts `POST /api/trackers/sync` and refetches, so the pill shows
the server's value, never the one clicked; a refusal (turning a repo off under a live or paused run) keeps the old value selected and puts the server's sentence
in the row's hint until the next pick for that repo or a read in which its interval has moved — not any read, which would wipe it within a second. Two checkouts
of one repo are one key, so both rows move.

The `Backlog tick` card (`TickGroup`) sits under the watchdog in the same column, because both are machine-wide controls — a value written to a file on the host
— where the left column is the host report. It is three `Select`s of 1–10: the number of failed ticks in a row that halt a project (`haltAfter`, default 3), and
the two caps a tick job applies when its prompt carries no flag (#378) — **Plans awaiting review** (`maxPlans`, default 3) and **Open execute PRs** (`maxPrs`,
default 2), each hint naming the `--max-plans` / `--max-prs` flag that still wins. Each pick posts only its own key to `settings/tick.json` through `POST
/api/ticks/config`, and the card is drawn from the POST's own answer; it mounts `useTicks({ live: false })`, so it never polls. When the server reports `source:
"unreadable"` all three are disabled and the first hint names the file, because every write would be a 409; a refused save renders one red line under the
controls while every value shown stays the one the server holds.

The `Time zone` card (`TimeZoneGroup`, #241) sits under the tick breaker, the third host control in that column: one `Select` over the platform's zones
(`timeZoneOptions`, plus `UTC`, plus a stored zone this browser does not list), its first option `Each browser's own (<this browser's zone>)` — unset, `null` on
the wire. It writes `settings/timezone.json` through `POST /api/settings/timezone`, drawn from the POST's own canonical answer, and a refused save renders the
same one red line. The value is the zone EVERY reading on the board is drawn in — a run's clocks, the Runs list's day groups and headings, the range windows,
the tracker's and a machine's reset clocks, a card's created date for a full stamp, Archive's month groups — so a phone, a laptop and a tailnet browser read one
clock for one run. It is read once per page load by the shell's `TimeZoneProvider` and handed out by `useTimeZone()`; `lib/time-zone.ts` is the one home of the
zone math, and `test/time-zone-guard.test.ts` refuses a `Date`'s local getters and setters and the locale date/time formatters in every other client file.

The watchdog card is one of five places Settings writes to the server — GitHub › Settings' sync picker, since #17, the `Backlog tick` card's threshold and two
caps, the `Time zone` card's zone (#241), and the Dashboards page's four `POST /api/dashboards/*` writes — four knobs that live in `settings/watchdog.json`
beside the registry rather than in this browser, plus a `Live view` link that opens Runs › Watchdog through the same pair the rail's tree calls. Because it
writes, it can be refused, like the sync picker: a rejected `POST /api/agents/watchdog/config` renders one red line in its own row directly under the control it
was refused for, while every knob keeps showing the value the server actually holds. That is a separate hook field (`saveError`) from the failed-GET `error`
beside it, because a failed read replaces the whole group and a failed write must not.

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
- **Sync off** (#17). A repo this machine no longer syncs reads `futin/x · sync off · polled 3h ago` (or `· never polled`) in the modal and on the Sources
  card's GitHub row — one `trackerState`, an access reason still winning over it. Because the server refuses every write and spawn for it, the card's and modal's dispatch
  control is DISABLED with the server's sentence (`syncOffReason`, byte-equal to `syncOffBlock`, pinned on both sides) — carried on `DispatchButton`'s
  `runBlock` after the run block, never hidden, since it is a per-project block rather than an environment one — and so is the toolbar's Orchestrate chip,
  whose click re-asks nothing for this reason because no status refetch could clear it — alone, or beside a visibility block, since #272 put both controls
  on `GatedChip`'s one rule.
- **The PRs page** (GitHub › PRs, [spec](../superpowers/specs/2026-10-29-source-sections-design.md) Goal 2; DESIGN.md §8.11). `PullRequestsView` lists every
  open pull request of the registered GitHub repos — forks and other authors included — drawn as Inbox, Matrix or Cards (below). Its one read is
  `usePullRequests` (`GET /api/prs`, every 60 s after the last answer, plus mount and focus), mounted by this page and by GitHub › Settings' Access card: the
  server's PR cache has no timer, so with neither open there are no PR reads at all. A repo the token cannot read (`forbidden` or `not-found`, `splitReach` in
  `lib/pr-layouts.ts`) is handed to no layout and left out of `N open`: the toolbar says `N repos hidden — no access` and links `GitHub › Settings`
  (`onOpenSettings`, threaded from `App`), whose `Access` card (`GithubAccessGroup`, the hook's second mount) lists each with GitHub's `detail` and the token
  fix; a rate-limited or `error` repo is transient and stays. The layout is a `Segmented` in the toolbar, stored per device (`PR_LAYOUT_KEY`; an unknown word is
  Inbox; Matrix is wide-only — a narrow window draws a stored `matrix` as Inbox and keeps the word, `drawableLayout`). **Inbox** (default) ranks every shown PR
  across repos (`rankPrs`: level, severity, newest) under three filtering count tiles; a loud PR (Needs you, Worth a look) is an item with a verdict, steps and
  the compact keys `compactKeys` picks (`Merge…` swaps them for the full strip in place), a Quiet one a line with its own `Actions` toggle beside the `#n` link;
  failing repos add a `Can't read` line. **Matrix** is a table, a column per check with a failure count in its header, whose row toggles one expansion holding
  the full strip. **Cards** is the per-repo page described next. All three draw the same `PrActions` and `PrOutcomeLine`, and `PrRepoNotes` says the merged
  outcomes, `sync off` sentence and `showing n of total` once for Inbox and Matrix; a PR's keys stay disabled while its write runs in any layout, because the
  page owns an in-flight set keyed `<repo>#<number>`, and a folded or collapsed strip is unmounted so its Confirm leaves the Escape stack. In Cards a repo's
  heading carries `polled N s ago` (`pollAge`), a `sync off` pill beside the server's full sentence (`syncOff`, `syncOffBlock`'s one home) when its sync is
  off, the last read's `detail` when it was not `ok`, `showing 100 of N` when GitHub had more than one page, or `no open pull requests`; a token-less server
  reads `no token — set BM_GITHUB_TOKEN in .env and restart`. A row (`PrRow`) is `#<n>` (to github.com, a new tab), the title, the author, `head → base`, the
  `prChips` and — while a live or paused run, a remote launch or a live claim is still working the branch (`prRunWarning`, from what the Board already polls)
  — a warn-toned warning that leaves every action enabled. Its actions are a method `Select` (the repo's allowed methods, seeded by `defaultMethod`), `Merge`
  behind an inline `Confirm` (`Merge #<n> into <base> (<method>)?`), `Enable`/`Disable auto-merge` and `Update branch`; a blocked one is disabled with its
  reason (`mergeBlock`, `updateBlock`, `autoMergeBlock` — `sync off` on each for a sync-off repo) in text beside it and as its `aria-describedby`, never a
  tooltip alone. A write disables the row's actions until the page has re-read, after success and failure alike; its outcome is one line — `outcomeLine`, or
  the server's refusal verbatim — held by the page per `<repo>#<number>`, so a merged PR that left the list keeps a `#12 merged` line under its repo. An
  update-branch's 202 marks the PR at the head SHA it was asked from: the row reads `updating…` while `isUpdating`, until a read shows a new head or
  `UPDATING_MS` (30 s, `PR_UPDATING_MS` in `shared/types.ts`) pass, and at that moment the page re-reads once — a read the server answers from GitHub,
  because the update made the repo due at that same moment. `updateBlock` reads `no permission to update` for a PR that cannot be updated while behind. The page reports the rail cursor as Board and Archive do (`useReportWorking`).

**A claim control in the item modal (#225, #227).** `claimControl` (`lib/tracker.ts`) reads `BacklogItem.holder` and answers `'stop-release'` for a claim
whose session the board dispatched, live or stale (a `claude -p` waiting on a reply sends no heartbeat, so its age says nothing); `'release'` for any other live
claim that is not a run's; `'release-stale'` for one whose heartbeat is `CLAIM_STALE_MS` old or unparseable; and `null` for a files item, no holder, or a
run-held claim. `ClaimRelease` draws the chip under the dispatch control, asks through `ui/Confirm` (the Release claim wording says a board-dispatched session
waiting on a reply also looks stopped, the one thing the server cannot see; the stale wording names the heartbeat age and host, and says a session that is
somehow still running is refused at its next heartbeat), posts `POST /api/items/abort`, prints any refusal
verbatim, and on success shows `claim released` and calls `onReleased` so the Board re-reads its payload. It is drawn only where the modal is handed
`onReleased` — the Board — and the card carries no claim control, because it carries no claim reading to hang one on.

**Where a card's work is (multi-dashboard).** A card whose live claim names a remote host's `host`, or whose launch was sent to a remote and has not claimed
yet, carries a `Marker` of tone `machine` — `running on <machine>` or `Starting on <machine>` (`--ink3`: it names a place, not a problem). The label is the
configured dashboard's name through `machineLabelByHost` (`lib/dashboards.ts`), and `lib/remote-starting.ts` is the one home of the `Starting on` wording and of
`startingOnForItem` (keyed by project path and id together), so the card, the run chip and the Runs page cannot word one launch three ways. `claimControl`
treats a remote host's claim as a board-dispatched one: `ClaimRelease` offers Stop & release for it, and the server routes the stop to that dashboard
([api.md](api.md#launching-on-another-machine)).

**A stale claim reads stale (#227).** The mapper still fills `started`/`phase` from any unreleased claim, so every reader that means "is somebody on this"
asks `claimReading` (`lib/tracker.ts`) — `'live' | 'stale' | null` by the reader's clock — as its second question. A stale holder draws the card's live strip as
`stale · no heartbeat <age> · <host>` in the stale queued band's muted pair instead of the hatched `executing` one (`liveBarFor`, `lib/live-bar.ts`, reading `liveKind`'s `stale`); ranks 2 and drops out of the
Status filter's "In progress" (`liveRank`, reading `liveKind`'s `stale` with the board's clock — the same test `isLiveWork` in `lib/item-progress.ts` makes for the item modal); and reads `stale claim` in the item modal
in place of `in progress`. It does NOT leave the board — `leavesBoard` is unchanged, because the release control lives on the Board and Archive has none. The
clock's own gate, `hasLive`, reads the rank UNAGED: a claim that is live now has to keep the clock running to be seen going stale. `progressBlock` lets dispatch
through over a stale hand claim — the spawned session's `start` retires it — and the Launch sheet says so (`staleTakeover`); a stale claim a run holds, or one
the board's own session holds, still blocks.

**A fourth card reading, `queued` (task-52, [spec](../superpowers/specs/2026-09-23-orchestrator-queued-label-design.md) §4.2).** An issue carrying the
`orchestrator:queued` label maps to `BacklogItem.queued`, and `queuedReading` (`lib/tracker.ts`) turns it into `'live' | 'stale' | null`: `'live'` while the
item's project has a local run that is `paused`, or `running` and not crashed, or a live remote run for the same repo; `'stale'` when the label is there and no
live run holds the project — a crash, a run that died on another machine without its Stop, a label added by hand. The card draws it as a band across its
top edge, `.board-card-queued` (`queuedStripFor`, `lib/live-bar.ts`): the live strip's geometry as a neutral ink band (`--ink2` fill, `--strip` text), reading `queued` for the first and a
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

**An `in-review` issue keeps its control, disabled with `a PR is open for this item`** (execute `pr` mode). `inReviewBlock` (`shared/agent.ts`) reads the
mapped `inReview` flag after `progressBlock` and before `runClaimBlock`, and the server's `plan`/`dispatch` read the same helper. The label goes on once execute
has pushed a `pr`-mode branch — the moment its claim is released and the still-open issue would otherwise read ready — and comes off when the PR merges and
closes the issue, or by `backlog.mjs review <id> off`. A files item never carries it.

**A plan that awaits review keeps the control too, disabled with `this plan awaits review`** (backlog-tick, #330). `planReviewBlock` (`shared/agent.ts`) is the
next rung, after `inReviewBlock` and before the run claim, so an item carrying both says the PR. It reads `BacklogItem.planReview`, which — unlike `inReview` —
both sources carry: a tracker issue while its `plan-review` label is on, a files item while its frontmatter has a `plan-review:` line. The tick's groom adds the
mark in the write that wrote the plan, and a person removes it to approve the plan — the label through `backlog.mjs plan-review <id> off`, the files line by
deleting it. It reuses the in-review rendering — same disabled state, same reason as title — and, in the item modal, draws nothing of its own.

**An outsider's issue that no groom of ours has pinned keeps its control, disabled with `filed from outside the repo — groom it to vet the plan`** (#341).
`unvettedBlock` (`shared/agent.ts`) sits between the two rungs above — after `inReviewBlock`, before `planReviewBlock` — because approving the plan does not
vet it, so an item carrying both must say the reason the approval would not clear; the server's `plan`/`dispatch` read the same helper in the same order. It
reads `BacklogItem.unvetted`, which only a tracker bug or task carries: `mapIssue` sets it when the issue's author is not `OWNER`/`MEMBER`/`COLLABORATOR` and
the body does not hash to the pin a trusted groom's `body` write left in its claim. A files item never carries it. Same in-review rendering, and while it
speaks `Review plan` is NOT drawn — reviewing is not the way out, grooming is
([invariants.md](invariants.md#an-outsiders-tracker-issue-is-executable-only-while-its-body-matches-a-pin-a-groom-of-ours-wrote)).

**On the card, and in the modal, a plan that awaits review is now something to act on** (#367). Given `onReview` — which `ItemCard` passes as its own
`onOpen` — `DispatchButton` draws `Review plan` in place of the disabled chip when the plan-review rung speaks alone (no progress, in-review or unvetted
block above it), and a click opens the item instead of re-stating the reason; the modal's own dispatch chip stays the disabled one. Under it the modal draws
`PlanApprove`: on a tracker item a confirm-gated `Approve plan` that posts `planReview: false` to `POST /api/items/plan-review` (`approvePlan`,
`lib/agents.ts`) and then asks the board to re-read (`onApproved`, which BoardView passes as `refetch`, beside `onReleased`); on a files item no request, only
a `Copy prompt` for a Claude session, because the board never writes item files (`planApprovePrompt`, `lib/plan-review.ts`). So the modal reflects the
approval, BoardView hands it the FRESH item — found in the payload by project and id during render, the click's snapshot only when the payload no longer has
it — never an effect that calls `setOpen`; ArchiveView, the other host of `ItemModal`, derives its open item the same way (#350). The band adds `PlanReviewChip` after the run chip: `N plans awaiting review`, with the tick's `--max-plans` cap and
` · tick blocked` once a tick has recorded its caps (`TickProject.lastDecide`, read through `useTicks({ live: false })`); `planReviewTally` and
`planReviewReading` are the arithmetic, and `awaitsPlanReview` — open and carrying the mark — is the one rule they, `PlanApprove` and the Board's filter all
call. Since #387 the chip is also the way into that pile: a click flips the Board's `Awaiting review` filter, the third section of the Filters panel
(`Plan review`, one pick chip beside Project and Status, not a fifth Status pill), which narrows the board to `awaitsPlanReview` items and composes with the
project, the status and the search. Both hands flip one `useState` in `BoardView`, and the chip is `aria-pressed` while it is on. It counts in the Filters
badge and Clear all turns it off, but it is deliberately NOT persisted: the pile is transient, and a remembered toggle would reload into a board narrowed to
plans someone has since approved. With it on and nothing left, the empty state reads `no plans awaiting review`. `leavesBoard` still applies on top, so a
plan-review bug aged into Archive stays there and the chip can read one more than the filtered board shows. Runs › Ticks prints the same caps per project row: `plans awaiting review N/M · open PRs N/M · as of HH:MM`, and
` · grooming blocked` at the plan cap.

**The toolbar's Orchestrate control is drawn for a tracker project too, since task-47 (phase 4a).** Task-46 kept it off with a fifth condition,
`projectIsFiles` (`lib/tracker.ts`), because a tracker project could not then be orchestrated at all; phase 4a made it orchestratable, so that predicate is
DELETED — it had exactly one job and its own doc comment said so — and `showOrchestrate` is back to the four conditions it had before phase 3. The server's
matching refusal went at the same time; the two were always one rule stated twice.

The sheet needed no change to follow: its `uncommitted` column already renders nothing when the endpoint answers `known: false`, which is what
`GET /api/items/uncommitted` answers for a project whose items are issues.

## Interfaces

- `lib/agents.ts` — same-origin fetches against `/api`.
- `lib/board-sort.ts` (#258) — the Board's sort pipeline, pure: `SortKey`/`SortDir`, `NATURAL_DIR`, `COMPARATORS`, `resolveSortKey`, `liveRank` and
  `sortItems`, pinned directly by `test/board-sort.test.ts`; `BoardView` keeps the storage keys, the popover's labels and the stored state.
- `lib/orchestrate-draft.ts` and `hooks/useOrchestrateDraft.ts` (#306) — the Orchestrate sheet's derivations, pure (`orchestrateQueue`, `resolveSelection`,
  `arrangeOrder`, `moveRow`, `toggleSelected`, `withoutIds`, `uncommittedFates`, `branchOptions`, `effectiveMergeMode`, `buildStartRequest`), pinned by
  `test/orchestrate-draft.test.ts`; and the hook that holds the sheet's run state, its three `useFetched` reads and `start`, returning the one `OrchestrateDraft`
  the three step views render from (`test/orchestrate-steps.test.tsx` renders each alone).
- `lib/runs-list.ts` (#284) — the Runs page's run-list derivations, pure: `mergeRuns` (the archive listing, the live poll and other machines' runs folded into
  one row list), `splitLive`, `sortByStartedAtDesc`, `groupByDay`, `queueCounts`, and since #376 the composition RunsView strings them into — `freshRunKey`
  (the archive-refresh signal), `scopeRuns` (range before project, the starting placeholders filtered by project only, the split after filtering),
  `windowHistory` (task-16's window, History alone) and `pickSelected` — pinned directly by `test/runs-list.test.ts`; `RunsView` is the one consumer.
- `lib/time-zone.ts` (#241) — the one home of wall-clock and calendar math: `zonedParts`, `startOfZonedDay`, `zonedDayStart` (a calendar date's first
  instant, DST and midnight-skipping days included), `formatZonedClock`, `browserTimeZone` and `timeZoneOptions`, every one taking the zone as an argument.
  `run-time`, `run-stats`, `run-range`, `runs-list`, `run-detail`, `run-watchdog`, `tracker`, `dashboards`, `item-age`, `item-month` and `jira` read dates
  through it and take `zone` as a required parameter, never a default — so a caller cannot fall back to the browser's zone by forgetting it.
  `test/time-zone-guard.test.ts` reads every other client source for a `Date`'s local getters and setters and the locale date/time formatters.
- `hooks/TimeZoneContext.tsx` (#241) — `TimeZoneProvider`, the shell's one read of `GET /api/settings/timezone` (through `useRefreshing` with no `armed`: mount
  and window focus, never a poll — the value changes on a person's pick), and `useTimeZone()`: `{ zone, stored, browser, save, saveError }`, `zone` being
  `stored ?? browser`. A component mounted without the provider reads the browser's zone, which is what the jsdom suites rely on.
- `lib/coalesced-poll.ts` and `hooks/useCoalescedFetch.ts` (#277) — the one home of poll scheduling for `useAgents`, `useBoard`, `useOrchestratorRuns`,
  `useWatchdog`, `useTicks`, `useOrchestratorArchive` and `useMachines` (all through `useRefreshing`, below), and of `useJiraBoard` directly:
  one request in flight at a time, every trigger that lands during it folded into one follow-up, and the next timer armed when an answer settles
  rather than by the wall clock. Where a hook below says "poll", read a `setTimeout` chain re-armed `intervalMs` after each answer, never a `setInterval`.
- `hooks/useRefreshing.ts` (#285) — `useCoalescedFetch` plus the board's mount + window-focus triggers, the one entry those pollers go through, `useMachines`
  among them, and `TimeZoneProvider`'s read (#241) and `ProjectsProvider`'s, which like `useOrchestratorArchive` pass no `armed` and never poll.
- `hooks/useFetched.ts` (#285) — the keyed one-shot read: `idle | pending | ok | failed`, a key change reads `pending` on the render that carries it, and a
  superseded or post-unmount answer sets nothing. `useProjectSources`, the item modal's body, `LaunchSheet`'s plan and branch list, `useOrchestrateDraft`'s
  merge-check, uncommitted flag and branch list, `RunDetail`'s archived run, `JiraIssueModal`'s detail and worktrees, `JiraLaunchSheet`'s prompt preview and
  detail, `JiraBranchSection`'s and `JiraReposGroup`'s branch refs, and the Jira board's and Repositories card's worktree lists all read through it.
- `hooks/useAgents.ts` — status poll on mount and window focus, plus the one re-ask a click against a project-visibility block provokes.
- `hooks/useAction.ts` — the one home of a click-fired mutation's in-flight guard, `busy`, `error` and message mapping (#286, bug-19's layer 1): `RunControls`,
  `LaunchSheet`, `useOrchestrateDraft`, `ClaimRelease` and, since Jira phases 3 and 5, `JiraIssueModal`'s writes and `JiraLaunchSheet`'s Start keep only their own
  success and refusal branches.
- `hooks/useOrchestratorRuns.ts` — the same cadence, plus a 5s poll while any run is fresh or still `running`, any `remote` run is `running`, or any
  `starting` or `remoteStarting` entry is present, plus a grace window after a Resume click.
- `hooks/useOrchestratorArchive.ts` — mount and window focus only; history moves at run boundaries, not on a heartbeat. Coalesced since #285: a focus or
  `refresh()` mid-flight folds into one follow-up.
- `hooks/useWatchdog.ts` — mounted by the Watchdog page alone; the runs payload it annotates comes in as a prop. Mount and window focus, plus a 5s poll
  while the sweeper reads `armed` and a 15s one otherwise (#270 — armed-only left an idle page blind to a run starting); Settings' `live: false` polls at
  neither.
- `hooks/useTicks.ts` (`TICKS_POLL_MS`, 15 s) — the breaker's read: `{ data, error, saveError, save, reset }` over `lib/ticks.ts`. Mount and window focus, plus
  the 15 s poll only while `live` — the Runs › Ticks page passes `true`, Settings' card `false`. A save or a reset redraws from the POST's own answer, never a
  follow-up GET, and a refused write lands in `saveError`, beside the failed-GET `error`, so a refusal never blanks `data`.
- `hooks/useMachines.ts` (`MACHINES_POLL_MS`, 60 s) — `GET /api/dashboards/machines`, health and usage per machine, for Settings › Dashboards only: `{ machines,
  reload }`, entered through `useRefreshing` with `armed` constant `true` (the page's mount is the arming), and a failed read keeps the previous answer
  silently.
- `hooks/useDashboards.ts`, `hooks/useOffers.ts`, `hooks/useRunOn.ts` — the configured machines (one read on mount, `refresh` for a write's caller), one
  project's offers (asked when a sheet passes a project, dropped by sequence number and by project tag so no frame shows the previous project's cards), and the
  sheets' shared pick-lock-narrow state over both. `lib/dashboards.ts` is the one home of the wire calls, `machineLabelByHost` / `machineLabelById`,
  `lockedFor`, `narrowTo`, `defaultMachine` and the usage wording; `lib/remote-starting.ts` the `Starting on` readings.
- `hooks/useBoard.ts` — mount and window focus, plus a 15s poll while any registered project's `source` is a tracker whose sync is not `off`
  (`hasSyncingTracker`, #17): a tracker's items move on the server's poll clock, which this tab has no event for. No syncing tracker means no timer at all.
- `hooks/useTrackers.ts` — the shell's one instance, provided by `TrackersProvider` (`hooks/TrackersContext.tsx`) and read by the chip, by the Shared
  Settings Sources card and by GitHub › Settings' Sync card through `useTrackersContext`. Mount and window focus, plus a timer on the server's poll clock: `nextDelay` arms the next read
  `TRACKER_FETCH_SLACK_MS` after the newest stamp's cycle ends, drops to a 1 s floor while any `ok` repo of the same sweep is still due (the server stamps repos
  one after another, so the newest stamp lands before the sweep does), and waits one whole cycle — never the floor — once the newest deadline has passed with
  nothing due (overdue or failing stamps do not move) and after an error. No github row means no timer at all. Since #17 each row counts on its own
  `syncCycleMs`: the deadline is the EARLIEST next stamp still ahead, a row is due for one base cycle after its own cycle ends, `off` rows are skipped, and a
  payload whose every github row is off sets no timer — nothing on the server moves it, and the card's own save refetches. Reads that overlap (focus, timer,
  the save's refetch) are sequenced, not cancelled (#231): only the newest may set state or arm the timer, so an older answer that settles last does nothing.
- `hooks/useJira.ts` and `hooks/useJiraBoard.ts` (Jira phase 2) — the shell's one `GET /api/jira` instance, provided by `JiraProvider`
  (`hooks/JiraContext.tsx`) on `useTrackers`' shape, and the Jira Board page's issue list on `useCoalescedFetch`; both are described in
  [jira.md](jira.md#the-client-phase-2-the-modals-controls-phase-3).
- `hooks/ProjectsContext.tsx` — `ProjectsProvider`, the shell's one read of `GET /api/projects` for the source rows (through `useRefreshing` with no `armed`:
  mount and window focus, never a poll), keeping the last answer on a failure, and `useProjectsContext()`: `{ data, drawn, reload }`, `drawn` being
  `drawnSources(data)` or `null` while unknown. A component mounted without the provider reads the unknown state and never fetches.
- `lib/sources.ts` — the source split, pure: `sourceSectionOf` (display grouping: `github` under GitHub, everything else under Files), `drawnSources`,
  `projectsPerSource`, `firstDrawn`, `settleSection`, `inSource`, `projectsIn`, `errorSource` and `narrowToSource`, the one cut Board and Archive share,
  which sends each index error to the source it names — a `gh:` issue URN to GitHub, a registered project's path to that project's source, anything else to
  Files.
- `lib/source-page.ts` and `hooks/useSourcePage.ts` — `FILES_PAGES`/`GITHUB_PAGES` with their keys and guards, `FALLBACK_SECTION` and `resolveLegacySection`;
  and `useFilesPage`/`useGithubPage` with their setters, module stores on `useJiraPage`'s shape.
- `components/github/` — `GithubSettingsView` (GitHub › Settings), `GithubSyncGroup`, its `Sync` card, and `GithubAccessGroup`, its `Access` card;
  `PullRequestsView` (GitHub › PRs) and the three layouts it switches between — `PrInbox`, `PrMatrix`, `PrCards` — over the shared `PrActions` (merge,
  auto-merge, update branch), `PrOutcomeLine` and `PrRepoNotes`; `PrRow`, one open pull request; `components/settings/SourcesGroup.tsx` is the Shared report.
- `lib/prs.ts`, `lib/pr-run.ts`, `lib/prs-api.ts` and `hooks/usePullRequests.ts` — the PRs page's derivations (chips, the three blocks, the default method,
  `isUpdating`, `groupRepos`, `outcomeLine`), its run-in-progress warning, its four fetchers and its one 60 s read; `lib/pr-layouts.ts` is the layout key, its
  stored choice, `splitReach` (which hides the repos the token cannot read), and every Inbox and Matrix derivation: a PR's level, severity, verdict and rank,
  `compactKeys`, the Matrix cells, tones and column counts.
- `hooks/useProjectSources.ts` — one read of `/api/projects` on mount, failing soft to an empty map: the Runs page needs each project's `source` for one
  explanatory line, and a committed marker changes on a commit rather than on a poll.
- [`shared/`](../../shared/agent.ts) — the derivations the server needs too, beside the wire types. `shared/` never imports from `client/`.

## Invariants

The rules this surface is held to — one implementation per derivation, board-versus-archive being derived and never stored, the six per-item dispatch blocks
(the unvetted rung, `filed from outside the repo — groom it to vet the plan`, the newest, one above `this plan awaits review`) and which one lets a
click through, the dialog escape stack and its eight dialogs, a crashed run rendering as crashed, "queue wait is not work",
[Settings being three pages whose page IS the scope](invariants.md#settings-is-three-pages-the-page-is-the-scope),
[the Jira section's tree and its configured-only
row](invariants.md#the-jira-sections-two-pages-are-switched-by-the-rails-tree-and-the-section-is-drawn-only-when-configured), [the source rows' tree and
their registered-only rows](invariants.md#a-source-row-is-drawn-only-while-a-registered-project-has-that-source-and-its-pages-are-switched-by-the-rails-tree), and [the content-width stamp that
the CSP hash travels with](invariants.md#contentwidth-is-stamped-before-first-paint-and-the-csp-hash-travels-with-it) — are in [invariants.md](invariants.md),
with the failure each one encodes. Not restated here.

<!-- docs-sync:
  sources:
    - client/src
    - shared/types.ts
  kind: subsystem
  verified: 5a74ebf0f276cf9103c7a744f913c01f02e178f5
-->