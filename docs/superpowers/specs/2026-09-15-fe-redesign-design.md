# Front-end redesign — `.claude/DESIGN.md` and the surface-by-surface refactor — design

Date: 2026-09-15
Status: approved (user-reviewed via remote decision session: seven option
picks, four interactive companion screens on real board and run data —
the screens are kept beside this file in `2026-09-15-fe-redesign-mockups/`)

## Problem

The board's client is the odd one out of the three apps that share
`shared/theme.css`'s token vocabulary. `../claude-agents-dashboard` moved to a
reference design on 2026-09-11/12 and wrote it down as `.claude/DESIGN.md` —
one geometric grotesque face, an 11 px floor, borderless white sheets on a
warm-grey ground, a 280 px rail. This client still draws the strip-board it
was ported from:

- **Three faces.** Barlow, Barlow Condensed and IBM Plex Mono; 80 `--mono`
  uses, 14 `--display`, 31 `text-transform: uppercase` rules.
- **Type under the floor.** 129 of 130 `font-size` declarations in
  `client/src/styles.css` are 12.5 px or smaller; 21 are 8–9.5 px.
- **A 150 px rail** of uppercase condensed labels with a cyan accent bar.
- **Manila daylight.** `[data-theme="daylight"]` is `#e8e3d7` paper, not the
  design's `#F4F4F3` ground and white sheets the dashboard already uses.
- **Runs in two places.** A run strip above the Board's columns and the Runs
  section both render the live run, with Pause/Resume on both.

The token names are already the dashboard's (`theme.css` was ported from it
verbatim), the shell is the same rail-plus-lazy-sections shape, and the
dashboard has already solved "a light reference design under five themes":
daylight takes the design's palette, the four dark themes stay as token
overrides, `--cyan` resolves to a dark green on daylight, and the nav bar
is ink rather than accent. §1–7 of its DESIGN.md therefore apply here
unchanged. Its §8 does not — it is about sessions, usage and management
pages this app does not have — and nothing in it or in its mock draws a
kanban column, an item card, a run strip, a stage track or a watchdog
console. Those are this document's job.

## Decisions taken (with the user, in order)

1. **Composition: §1–7 verbatim, §8 our own.** Copy the reference analysis
   unchanged; carry the dashboard's rail, type-scale and Settings-card
   rules (its §8.0–8.2) reconciled to what its CSS actually ships where the
   prose drifted (its prose says nav rows at 16/500 and a 300 px sidebar,
   its stylesheet draws 14/500 rows at 36 px in a 280 px rail — we copy the
   CSS). Rejected: re-deriving the rail and Settings from scratch (slower,
   no gain), and pointing at the dashboard's file across repos (breaks
   when a path moves).
2. **Project hues stay, confined to one mark.** The reference design has no
   identity-colour concept ("everything else stays inside the palette").
   Eight hues per theme survive as one 8 px dot per card and per drawer
   head, never on text; the project name reads in `--ink2` beside it.
   Rejected: dropping hues (loses the one thing worth scanning for on a
   cross-project board), and keeping the coloured outline pill (colour on
   9 px text, eight hues fighting the five status colours).
3. **Board shape: cards in columns** (`01-board-shape.html`, option A).
   Today's kanban redrawn at the design's scale. Rejected: each column as
   one sheet with hairline rows (~35 % less height, but the column header
   grows a subtitle and the card stops being a card), and one ledger
   grouped by type (densest; loses the four-column scan).
4. **Runs leave the Board** (`02-runs-on-board.html`, option C). The user's
   words: "the board can show the issues, but the runs shows more info,
   no reason to keep it in both places." The Board keeps the card's own
   live strip and gains one chip in the band that opens Runs. Rejected: the
   strip redrawn as a band under the toolbar, and an aside card.
5. **Runs shape: live first, history under** (`03-runs-shape.html`,
   option C). Each live run is its own card with its controls and the
   current item's stage track, because the Board now sends you here for
   exactly those; then the figure strip; then history as a ledger whose
   row opens the run in a modal. Rejected: the split (list sheet, detail
   sheet — closest to today) and a ledger with the picked row expanding
   underneath.
6. **The refactor lands surface by surface, in a worktree, through the
   orchestrator.** Six code tasks groomed on `main`, executed one at a time
   by `backlog-orchestrate` against a long-lived `fe-redesign` branch
   checked out in a linked worktree, merged to `main` by hand at the end.
   That needs the orchestrator to take a base branch other than `main` —
   a **separate sub-project with its own spec** (§10). Rejected: a
   big-bang branch (one review, tests red until the end, no orchestrator),
   and a parallel `client-v2` behind a flag (two clients to keep in sync).
7. **Watchdog is its own page under Runs** (`04-watchdog.html`, option A).
   The rail gains its first sub-nav tree, Runs › History / Watchdog.
   Rejected: folding the sweeper's facts onto the live run cards, and a
   300 px aside on Runs.
8. **The language is built as reusable components with one home** (§12),
   at the user's ask. The dashboard built its language as components too,
   but by area — `usage/Sheet.tsx`, `settings/SettingsRow.tsx`,
   `sessions/atoms.tsx` — and already carries two Bands (`Band`,
   `SettingsBand`) over two class families. Here every shared pattern is
   one component under `client/src/components/ui/`, the same rule `lib/`
   has for derivations.

## Non-goals

- **No new derivations.** Every predicate in `client/src/lib/` — staleness,
  groomed, `runClaimBlock`, `runHoldsItem`, `itemDurationMs`,
  `watchdogStoodDown` — is untouched. This is a redraw; the data authority
  of every surface stays where it is.
- **No server change in this spec.** The orchestrator base branch (§10) is
  a second spec; the CSP, the pre-paint theme script and its pinned hash
  do not move.
- **No dark-theme redesign.** The four dark palettes stay as the token
  overrides they are. Where a new rule needs a colour the palette lacks,
  the spec adds a token to every theme (§2.2), never a literal.
- **No second Board shape.** The ledger stays an idea for later; the Board
  is the kanban.
- **No change to the skills**, the item bodies' Markdown, or the
  `backlog/` store.
- Density (`compact`) and the text-scale `zoom` stay exactly as they are,
  including every `/ var(--font-scale)` division.

## 1. `.claude/DESIGN.md`

### 1.1 Where, and how it is reached

`.claude/DESIGN.md`, mirroring the dashboard. It is **not** a
`.claude/rules/` file: those are pinned by `test/claude-rules.test.ts` to
be one-line pointers into `docs/subsystems/invariants.md` and nothing
else, so a design pointer there would fail the suite. It is reached the
way the dashboard reaches its own: a line in `CLAUDE.md`'s Layout under
`client/src/` and a row in `docs/overview.md`'s map, plus a `DESIGN.md §n`
citation in the header comment of every component drawn from it.

### 1.2 §1–7 — verbatim

Copied byte-for-byte from
`../claude-agents-dashboard/.claude/DESIGN.md` §1 Typography through §7
Reusable patterns, with one line added under the title naming the source
and the date copied. The section is a description of a reference design,
not of this app, so it has no reason to differ between the two repos; the
day it does, that line says which copy moved.

### 1.3 §8 — "Applying this to the board"

Written new. Each subsection carries the numbers, the rule, and the
reason, in the register the dashboard's §8 uses; the concrete values are
in §§2–6 of this spec so the implementer and DESIGN.md read the same ones.

- **§8.0 Shell and rail** — §2.4 below.
- **§8.1 Type** — §2.3.
- **§8.2 Tokens and themes** — §2.2, plus the project-hue rule (decision 2)
  and the column ramp.
- **§8.3 Board** — §3.
- **§8.4 Runs** — §4, both pages.
- **§8.5 Archive** — §5.1.
- **§8.6 Settings** — §5.2; the dashboard's §8.2 restated, not re-derived.
- **§8.7 Overlays** — §6.
- **§8.8 Motion** — the live dot breathes a ring, the current stage node
  pulses, a needs-you control fades in place; all off under
  `prefers-reduced-motion`, as today's reduced-motion block already does.

Two rules the dashboard learned the hard way are carried into every
subsection that draws on the ground rather than re-learned here: nothing
on `--board` uses `--strip-hi` as its only separator (on daylight the two
are two points apart), and a raised control means a state, not a button.

## 2. Foundation (task 1)

The whole app reads in the new face after this task; no layout changes.
This task also lands the `ui/` primitives every later task composes
(§12) — Band, Sheet, SheetHead, FigureStrip, Chip, Pill, Dot, Marker,
ProgressRow, Ledger, the control family moved out of `settings/`, and
`useNarrow` — each with its CSS family and its component test, used by
nothing yet but the rail. Landing them first means tasks 2–5 compose and
never invent.

### 2.1 Font

- Add `@fontsource/hanken-grotesk`; import weights 400, 500, 600, 700 in
  `client/src/main.tsx`. Remove `@fontsource/barlow`,
  `@fontsource/barlow-condensed`, `@fontsource/ibm-plex-mono` from
  `package.json` and their six imports.
- Self-hosted, not Google Fonts: the served build's CSP is
  `default-src 'self'` with no `font-src`, `style-src` is pinned exactly by
  `test/csp.test.ts`, and the tailnet/phone use case wants the board to
  render with no third-party fetch. The dashboard links Google Fonts; that
  is the one thing in its foundation this app does not copy.
- `--font: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI',
  sans-serif` in every theme block. `--mono` and `--display` are
  **deleted from `theme.css`, not aliased**, so a stale `var(--mono)`
  falls back to the inherited face rather than silently keeping Plex. Add
  `code, kbd, samp, pre { font-family: inherit }` and
  `font-variant-numeric: tabular-nums` on `body`.

### 2.2 Tokens

`shared/theme.css` keeps its vocabulary. Daylight is rewritten to the
dashboard's values — the design's palette with the two mappings its
comment records (accent is a darkened `--green-600`; the bright ramp
values are fills, so `--amber`/`--mustard` take darkened cousins for text):

| token | daylight |
|---|---|
| `--board` / `--steel` / `--strip` / `--strip-hi` | `#f4f4f3` / `#ededec` / `#ffffff` / `#f2f2f1` |
| `--edge` / `--hairline` / `--hairline2` | `rgba(0,0,0,.03)` / `#eaeae8` / `#dcdcda` |
| `--ink` / `--ink2` / `--ink3` | `#131313` / `#6e6e6e` / `#a0a0a0` |
| `--green` / `--amber` / `--mustard` / `--cyan` / `--red` / `--magenta` | `#5fa92c` / `#c4761f` / `#9a8712` / `#3f8f14` / `#b03b28` / `#6b52a8` |
| `--on-accent` / `--scrim` / `--shadow` / `--shadow2` | `#ffffff` / `rgba(19,19,19,.28)` / `rgba(0,0,0,.06)` / `rgba(0,0,0,.1)` |

Two tokens are **added to every theme block**, because the design draws
two things in the ramp's bright fills and the palette has no fill that is
not also a text colour:

| token | meaning | daylight | dark themes |
|---|---|---|---|
| `--fill-live` | the card's live strip, the current stage node, the "you are here" bar | `#F5A15C` (`--orange-400`) | `var(--amber)`, declared in each dark block |
| `--fill-progress` | filled progress, a reached stage node | `#7DC242` (`--green-500`) | `var(--green)`, declared in each dark block |

The hatch is one utility rule, `.hatch`, over any fill:
`repeating-linear-gradient(45deg, rgba(255,255,255,.30) 0 1px, transparent 1px 4px)`.

The eight `--proj-N` sets stay as they are; on daylight they are dark inks,
which an 8 px filled dot on white wants anyway.

**Column ramp.** The four column dots are the design's category ramp read
left to right — refactors `--amber`, ideas `--mustard`, bugs `--red`, tasks
`--green` — replacing today's magenta/mustard/red/cyan ticks. `--magenta`
loses its only job on this screen and stays in the palette for the app
that shares it.

The stale comment at the head of `theme.css` about a server `wrapPage`
linking the file is removed (task 6): no server code in this repo reads
`theme.css`.

### 2.3 Type scale

The dashboard's §8.1 table, adopted whole:

| role | size / weight | where |
|---|---|---|
| Page and card title | 19/500, −.01em, 1.3 | band titles, sheet titles, live run card project |
| Large metric | 30/700, −.02em, 1.1 | figure strip values |
| Row name | 15/500 | column header names |
| Card title | 14/500, 1.35 | item card title, history row project, stage track item title |
| Subtitle / hint | 13/400 | band subtitle, sheet subtitle, figure label, control label |
| Body, chip and button label | 13 (500 on buttons) | filter chips, controls |
| Meta / axis / caption | 12/400 | `id · date`, project name beside its dot, stage durations, table time column |
| Pill, badge, status | 11/500 | count pills, markers, mode pill, stage word on the live strip |

11 px is the floor. `text-transform: uppercase` survives on `.rail-kicker`
alone.

### 2.4 Shell and rail

The dashboard's rail as shipped, copied into `styles.css` and
`SideRail.tsx`:

- Rail 280 px, 32 px padding-y, `--strip` ground, `.main` on `--board` with
  `margin-top: 24px` and a 24 px top-left radius — the design's app-shell
  inset drawn on the one corner the rail meets.
- Wordmark 20/700 over the 11/500 uppercase kicker; the one green dot is
  decoration, not status.
- Rows 36 px, 14/500, 16 px padding-x, 16 px radius, a 16 px outline icon
  12 px from the label. Active: 3 px ink bar 16 px tall at the left edge
  plus `--strip-hi` fill, never a colour change in the label. Hover darkens
  the label and nothing else. Icons hold `--ink` at every row weight.
- Sub-nav tree: `.rail-sub` hung 24 px in (the icon's centreline), 14 px
  labels, stem and tick drawn as two background layers per row so the
  last row's stem stops at its own centre. Drawn only while its section is
  open. Runs gets the first tree: History / Watchdog (§4).
- Settings sits under a 1 px rule with 24 px either side.
- Below 700 px the rail becomes a top bar (wordmark left, ☰ right) with the
  menu dropping out of it full width; every tree stands open there. The bar
  slides away on a downward scroll and returns on the first upward one,
  pinned while the menu is open.

`resolveSection` and `SECTIONS` are unchanged; the sub-view key for Runs
is `RUNS_MODE_KEY` (`lib/runs-mode.ts`), already persisted and guarded —
the segmented control that reads it today is replaced by the tree at
every width.

## 3. Board (task 2)

Shape A of `01-board-shape.html`.

### 3.1 The band

A band on the ground, not a card: title 19/500, a 13 px `--ink2` line
(`21 open across 3 projects`), then right-aligned the 36 px search field
(12 px radius, `--hairline` stroke) and the filter chips (32 px, 12 px
radius, `--hairline2` stroke, 13/500). **Orchestrate is the one ink
chip** on the page (`--ink` fill, `--strip` text). Its hide/disable rules
are unchanged.

### 3.2 The run chip

Left of the controls, one chip carries every fact the strip used to and
opens the Runs section: a dot in `--fill-progress` (live), `--fill-live`
(paused or starting), `--red` (crashed), and a 12/500 count line —
`2 runs · 1 live ›`, `1 run · crashed ›`, `1 starting ›`. With runs in
more than one state the dot takes the worst: crashed over paused or
starting over live, and the count line names each state present. It
renders the payload's `starting` array with no client-side filter, as the
strip did.
It is a `<button>`; its click calls the same section setter the rail
uses. Absent when the payload has no run and no starting entry.

### 3.3 Columns

`repeat(4, minmax(0, 1fr))` at 16 px gaps, two columns under 1100, one
under 700 — the steps stay explicit. Column header: an 8 px ramp dot
(§2.2), the name at 15/500, a 22×20 count pill (`--strip-hi`, 11/500)
pushed right. No rule under the header; the cards' own ground gap
separates it.

### 3.4 The card

White `--strip`, 12 px radius, no stroke and no shadow; hover raises
nothing and changes nothing but the cursor — a card is a button by role,
and the design marks nothing with hover. Face padding 14/16/12, 10 px
internal gap.

- Title 14/500, 1.35, wraps.
- Foot row: an 8 px project dot in `--proj-N` + the project name 12/400
  `--ink2` (ellipsised), then `id · date` at 12/400 `--ink3` pushed right,
  `flex: none`.
- Marker row, only when any marker applies: `groomed` in `--green`,
  `chore`/`debt` in `--ink3`, `done` in `--ink2`, `stale` in `--mustard`,
  all 11/500. Same words, same tokens, the design's size.
- **Live strip.** A 24 px bar across the top edge of the card, `--fill-live`
  with the hatch, 11/500 `--ink` text: the stage word left (`executing`,
  `grooming`, `reviewing`, `needs-answers`), the elapsed reading right. One
  fill for both a hand session and an orchestrator stage — the word
  carries the distinction, as the rule already says it must; the second
  tone the strip used to switch between goes, because the design marks
  state by ink, never by accent (§5).
- Dispatch control: the same `DispatchButton` states, drawn as a 28 px
  chip at the right end of the marker row, **always drawn** when the
  environment allows dispatch at all — never hover-revealed, because a
  disabled control that can be clicked to re-ask (bug-13) has to be
  visible to be clicked, and because the design marks nothing with
  hover. The marker row therefore renders whenever dispatch is available,
  markers or not. Its three blocks and the re-ask click are unchanged.

### 3.5 What leaves the Board

`RunStrip.tsx`, `StartingStrip.tsx`, `RunDrawer.tsx` and their CSS. The
data they read stays in `BoardView` for the chip and the card strips:
`useOrchestratorRuns` keeps polling while any run is `running`, fresh or
not, and `runClaimBlock` / `runHoldsItem` keep their inputs. The rules
they carried move to Runs — §8 lists them.

## 4. Runs (task 3)

Two pages under one rail entry: **History** (the section's default) and
**Watchdog**. Both open on a band and read off the same `useOrchestratorRuns`
payload; Watchdog additionally mounts `useWatchdog`, exactly as
`WatchdogMonitor` does today, so switching adds no request.

### 4.1 History — shape C of `03-runs-shape.html`

Top to bottom:

1. **Band.** `Runs`, `2 live · 29 past`, then the project select and the
   range control as chips.
2. **One live card per run** whose status is `running` or `paused`, or
   that is `starting`. A `--strip` sheet at 16 px radius and 24 px
   padding, two columns: the run on the left, its controls stacked on the
   right (`RunControls` — Pause / Cancel / Resume, plus Open — unchanged
   in what it offers, drawn as 28 px chips, Cancel in `--red` text).
   Left column: dot + project 19/500 + run id and start time at 12 `--ink3`
   + mode pill; a §7 progress row (10 px `--fill-progress` hatched over
   `--steel`, `2 / 5` two-tone beside it, elapsed and heartbeat reading at
   12); a hairline; the current item's head (id 12 `--ink3`, title 14/500,
   stage pill right) and its **stage track** (§4.3). A `paused` run shows
   `paused after <id>` in place of the item. A `starting` entry shows the
   dot in `--fill-live`, `starting…`, its age, and no controls. A
   **crashed** run (running, heartbeat stale) shows a `--red` dot, a
   `crashed` pill, the watchdog clause from `run-watchdog.ts` as a 13 px
   sentence under the progress row, and Resume exactly when
   `watchdogStoodDown` says the sweeper will not — the coupling test
   drives this card from now on.
3. **Figure strip.** One sheet the ground divides: five figures on a 2 px
   `--board` gap grid, wrapping to three under 1100 and two under 700 with
   the seam drawn in both directions. Each: label 13 `--ink2`, value 30/700,
   a 12 px line under. The five are today's tiles — runs, completed /
   queued, avg item work (queue wait excluded), rework / completed, verify
   pass. The wide "machine time by stage" tile becomes the sixth cell,
   full width, holding `StageBars` redrawn at 10 px bar height.
4. **History sheet.** Title + subtitle (`29 runs · last 30 days · a row
   opens the run`), day kickers at 13/500 `--ink2`, one 44 px row per run:
   dot (`--ink3` done, `--red` crashed, `--fill-live` paused), project
   14/500, the items it touched at 13 `--ink2`, `2 / 2` two-tone, wall
   time at 12 `--ink3`, mode pill, a `›`. Load-more stays as a flat chip
   at the sheet's foot. A row opens the **run modal** (§6.1) — which is why
   the `Modal` primitive lands in this task, not in task 5. Live runs are
   not in this list — they are the cards above.

### 4.2 Watchdog — option A of `04-watchdog.html`

Today's `WatchdogMonitor`, redrawn:

1. **Band.** `Runs · Watchdog` (the `section · destination` convention),
   the state line as its 13 px subtitle, a flat `Policy in Settings ›` chip
   right — the policy is edited there and nowhere else.
2. **Three-figure strip.** Sweeper (phase as a 24/700 word, a 6 px sweep
   meter under it in `--fill-progress` hatched, `next sweep in … · every
   10m`); Watching (count of running runs, `1 crashed · 1 heartbeating`);
   Policy (`check every / leave alone for / give up after` as three
   label-over-value pairs, 12 over 14/500, and the enabled switch's state
   as the 12 px line).
3. **Watching sheet.** One row per run in the runs payload with status
   `running`, annotated from `watching` exactly as today (skew rendered,
   not hidden): dot, project 14/500, run id 12 `--ink3`, `heartbeat live`
   / `heartbeat 38m`, `1 / 3 attempts`, the verdict as glyph + words in the
   kind's tone, and a `Resume now` chip when `watchdogStoodDown` allows.
4. **Activity sheet.** The event ledger: `time · kind · run · detail`,
   th 12/400 `--ink2`, td 13, time 12 `--ink3`; the kind cell is
   `WATCHDOG_KIND_GLYPH` + the word, coloured by `WATCHDOG_KIND_TONE`:
   `live` `--green`, `done` `--green`, `bad` `--red`, `warn` `--amber`,
   `muted` `--ink3`. Scrolls inside its own sheet under 700 px.

### 4.3 The stage track

`StageTrack` keeps its seven equal columns and its data; the drawing
changes. Nodes are 12 px dots on a 2 px `--steel` rail: reached =
`--fill-progress`, current = `--fill-live` with a 3 px 30 % ring that
pulses, not reached = `--steel` with a `--hairline2` ring, skipped
(`fixing` on a run with no fix loop) = dashed `--hairline2` ring. Stage
names 11 `--ink2` under the dot, durations 12/500 under those; a `×N`
fix-loop badge is an 11/500 pill on the `fixing` node. Verification line
under the track: `✓` / `✕` glyph, the command in an inline code span
(`--ink` on `--steel`, 4 px corner — inherits the face), the summary at
12 `--ink2`.

## 5. Archive and Settings (task 4)

### 5.1 Archive

The Board's card and columns (§3.3–3.4) under the four Archive columns
(refactoring, ideas, bugs, out of scope), grouped by month with a sticky
13/500 `--ink2` kicker per month on the `--board` ground. Band carries the
project select and search and nothing else. Out-of-scope column's dot is
`--ink3`. No live strips ever appear here; `capture` is the only dispatch
action a card can derive.

### 5.2 Settings

The dashboard's §8.2, restated: page header as a band (title 19/500, a
13 px line), then borderless `--strip` cards at 16 px radius and 24 px
padding, each a title + one-line subtitle pair — `Board · this device`,
`Display · this device`, `Orchestrator · this device`, `Claude Agents ·
this machine`, the existing four. Rows inside are boxless: 16 px vertical
padding, a hairline between, name 15/500 over a 13 px hint left, the
control right. One 36 px control family: select / number / text / button
at 12 px radius with a `--hairline2` stroke; the on/off rows and the
theme/density pickers use the pill switch — a recessed `--steel` track,
a raised `--strip` option. Theme swatches stay, as 24 px tiles at 8 px
radius. Two hand-balanced columns, folding to one under 1100. The
watchdog group keeps its four rows; its `Live view` link opens
Runs › Watchdog through the same section setter the rail uses.

## 6. Overlays (task 5)

Both shapes are the dashboard's, chosen there after five drawings each;
this app adopts them rather than re-litigating.

### 6.1 The sidecar modal — item and run

`ItemDrawer` and the former `RunDrawer`'s content stop being panels pinned
to the right edge and become a modal with air around it (dashboard §8.6):
`--scrim` everywhere and a real exit; a `--strip` shell at 16 px radius
with the design's one shell lift (`0 24px 64px` at `--shadow2`); a 290 px
left column of facts and the body on the right with a clean top edge.
Max width 1080 px, `calc(100vw / var(--font-scale) - 48px)` below that;
full-screen under 700 px, the facts column folding above the body.

- **Item.** Facts: project dot + name, id, section, created / updated /
  last commit, `groomed`, elapsed and token counters when present, the
  file path, the dispatch control. Body: the rendered Markdown at the
  §2.3 scale — 15/400 body, 19/500 headings, code spans on `--steel`.
- **Run.** Facts: project, run id, started / finished, mode and its note,
  question mode, the fifteen stage chips as a 2-column list of
  `stage · n`, attention entries. Body: the items, each with its head,
  stage track (§4.3), verification and assumptions; `Branches to merge`
  under them for a branch-mode run.

### 6.2 The sheet — launch and orchestrate

`LaunchSheet` and `OrchestrateSheet` keep every step and field and take
the dashboard's §8.7 shell: scrim, air on every side, 620 px wide, the
shell lift, full-screen under 700. Controls are §5.2's 36 px family; the
three-step header of the orchestrate sheet is a 13/500 stepper on a
hairline; Start stays on the last step alone. The `uncommitted` chip
renders as an 11/500 `--amber` pill, its two consequences still spelled
out in words.

`useDialogEscape` is untouched: one owner, LIFO, the topmost closes.

## 7. Cleanup (task 6)

Dead CSS after tasks 1–5 (`.rail-brand`'s old rules, `.run-strip*`,
`.drawer` panel geometry, the `--mono`/`--display` consumers), the
`theme.css` `wrapPage` comment, the `zoom` and `/ var(--font-scale)`
comments re-read against the new geometry, and `docs/subsystems/board.md`
rewritten for the surfaces as they now are — the run chip, the two Runs
pages, the modals.

## 8. Rules that move

Each is stated in `CLAUDE.md` and reasoned in `invariants.md` against a
surface that changes here. The rule stands; its home moves. The
invariants entry is edited in place to name the new surface, never
deleted.

| rule | today | after |
|---|---|---|
| A crashed run renders as crashed, never as nothing | `RunStrip` crashed strip; Runs list badge | Runs live card (`--red` dot, `crashed` pill, clause); History row when finished; the Board chip counts it (`1 crashed ›`) |
| Resume for a crashed run stays on the strip alone | `RunStrip` | the Runs live card alone. Resume for `paused` — today on strip and Runs detail — collapses to the same single surface |
| The board offers a hand resume exactly when the watchdog will not | `RunStrip` + `watchdog.service.ts`, pinned by `watchdog-coupling.test.tsx` | Runs live card + the Watchdog page's `Resume now`; the coupling test drives the live card |
| A board-started run is visible before its run file exists | `StartingStrip` | the Board chip (`1 starting ›`) and a Runs live card with no controls |
| The toolbar Orchestrate control hides on a starting entry | unchanged | unchanged |
| `useOrchestratorRuns` polls while any run is `running`, fresh or not | Board + Runs | Board (chip, card strips) + Runs — unchanged |
| Escape has one owner | four dialogs | the same four, now two modals and two sheets |

## 9. Testing

- **Style suites move with their selectors.** The ten `*-style.test.ts`
  suites read `styles.css` through `helpers/css-rule`; a task that renames
  or removes a selector moves the case to its replacement in the same
  change. No case is deleted without one — `dispatch-busy-style` in
  particular keeps all three re-asking controls.
- **Six source guards land with task 1**, one file `test/design-guards.test.ts`
  reading `client/src/styles.css`, `shared/theme.css` and
  `client/src/main.tsx` as text:
  1. neither stylesheet declares or reads `--mono` or `--display`;
  2. `theme.css` declares exactly one `--font` stack per theme block and
     `styles.css` declares no other `font-family` but `inherit`;
  3. every `font-size` in `styles.css` written as a px literal is ≥ 11 px;
     a non-px value (`em`, `calc(...)`) is legal only for a selector named
     in a literal allowlist inside the test, each entry with a one-line
     reason — the test fails on any non-px value outside that list;
  4. `text-transform: uppercase` appears in exactly one rule, `.rail-kicker`;
  5. the daylight block's tokens equal the §2.2 table and every theme
     block declares `--fill-live` and `--fill-progress`;
  6. `main.tsx` imports `@fontsource/hanken-grotesk` weights 400/500/600/700
     and no other `@fontsource` package; `package.json` lists none other.
  7. **one home per primitive**: each `ui/` class family (§12's table) is
     declared in `styles.css` exactly once as a bare base selector, inside
     the block headed `/* ── ui primitives`, and no selector outside that
     block starts with one of those names — a page may lay a `.chip` out,
     never restyle it.
- **Every `ui/` primitive has a component suite**, `test/ui-<name>.test.tsx`,
  pinning its role, its accessible name, and that each variant prop lands
  as its documented class — the shape `SettingsRow`'s suite already has.
- **`test/csp.test.ts` is untouched** and must stay green: the pre-paint
  script does not change.
- **Component suites** keep their assertions where the DOM keeps its role
  and text; Board and Runs suites (`runs-view`, `run-strip`, `starting-strip`,
  `watchdog-coupling`, `settings-view`) are rewritten with their task, the
  moved rules of §8 each keeping a named case.
- **Screenshots per task**, before merge: Board, Runs › History,
  Runs › Watchdog, Settings, an open item modal, at 1400 and 400 px wide,
  daylight and midnight — through a pid-owned static server, killed by
  pid.

## 10. Sequencing, and the orchestrator base branch

Order agreed with the user:

1. **This spec and `.claude/DESIGN.md`** land on `main` now — docs only.
2. **Orchestrator base branch** — its own brainstorm and spec, executed
   on `main` by the normal flow. What exists already: `orchestrate.mjs
   init` and `plan` take `--base <ref>` (default `main`) and the queue gate
   reads every item and the `runner-fix:` marker at `<base>`. What does
   not: the run file has no `base` field; `SKILL.md` hardcodes `main` in
   `worktree add`, the merge verification of `refs/heads/main`, `log` and
   `diff`; `POST /api/agents/orchestrate` composes no `--base`; the
   Orchestrate sheet has no picker; `UNCOMMITTED_BASE_REF` is `'main'`.
   The feature makes `base` run-scoped like `mergeMode`, makes the merge
   target "the tree where `<base>` is checked out" (`git worktree list`),
   verified before merge and parked if none, and keeps the tool invoked
   from the project root — the "never from a linked worktree" invariant
   stands. Two costs it must state: the item file has to exist at
   `<base>`, so FE tasks are captured on `main` and `main` merged into
   `fe-redesign` before a run; and the merge lands in the feature
   worktree while it may be dirty, under today's overlapping-dirty-paths
   park rule.
3. **Tasks 1–6** (§§2–7) are captured and groomed on `main` as
   `task-<n>` items, each citing this spec's section; `git worktree add
   .worktrees/fe-redesign -b fe-redesign main`; runs started from the
   Board with base `fe-redesign`; `main` merged into `fe-redesign` before
   each run.
4. **`fe-redesign` merged to `main` by hand**, `--no-ff`, after the last
   task's screenshots.

## 11. Documentation

- `CLAUDE.md` Layout, under `client/src/`: one line naming
  `.claude/DESIGN.md` as the visual language and where §8 applies it.
- `docs/overview.md` map: one row for `.claude/DESIGN.md`.
- `docs/subsystems/board.md`: rewritten in task 6 (§7), gaining a
  "Primitives" section that is §12's table kept current.
- `docs/subsystems/invariants.md`: the §8 rows edited in place, in the
  task that moves each surface.
- A memory note recording the four companion picks, so the next session
  does not redraw them.

## 12. Components — one home per pattern

### 12.1 The rule

Every DESIGN.md §7 pattern, and every §8 shape drawn by more than one
surface, is **one React component in `client/src/components/ui/`**, which
owns its CSS class family in one block of `styles.css` headed
`/* ── ui primitives`. Page CSS lays primitives out — grid, gap, width —
and never restates their look; a surface that needs a variant adds a
prop, never a second class family. Same rule, same reason as `lib/`:
"every derivation has one home" so two surfaces cannot disagree about the
same thing. Pinned by guard 7 (§9).

What this repo has today is the drift in embryo: `SettingsGroup`,
`Segmented`, `NumberField` under `settings/`, `RunControls` and
`RunRowTime` at the top level, `.pill` and `.run-mode-badge` declared as
board classes and read by Runs. Task 1 moves the first three and gives
the rest a home.

### 12.2 The primitives

| component | DESIGN.md | props | composed by |
|---|---|---|---|
| `Band` | §8.2 "the page header is a band, not a card" | `title`, `sub`, `children` (right slot) | Board, Runs History, Runs Watchdog, Archive, Settings |
| `Sheet`, `SheetHead` | §8.2 card; §7 title + one-line subtitle, right slot for one control | `Sheet{children, as?}`; `SheetHead{title, sub?, right?}` | live run card, History, Watching, Activity, Settings groups, the modals' facts blocks |
| `FigureStrip`, `Figure` | §8.4 "one card the ground divides" | `Figure{label, value, unit?, line?, tone?}`; strip wraps 5→3→2 | Runs History (six, the sixth wide), Watchdog (three) |
| `Chip` | §7 filter chip; the 32 px control | `variant: outline \| ink \| flat \| danger`, `size: 32 \| 28`, `pressed?`, `as: button \| label`, `icon?` | every band and control row, `RunControls`, `DispatchButton`, load-more |
| `Pill` | §1 status micro-label at 11/500, 999 px | `tone: neutral \| live \| warn \| bad \| done` | count, mode, stage, `crashed`, `paused`, `uncommitted` |
| `Dot` | §7 legend dot | `tone: live \| paused \| crashed \| done \| ramp-<col>`, or `hue: 1–8`; `size: 8 \| 10`; `breathe?` | card foot, column header, rows, the run chip, the rail wordmark |
| `Marker` | §8.3 marker row word | `tone: groomed \| kind \| done \| stale` | card, Archive card |
| `ProgressRow` | §7 progress row | `value`, `max`, `caption?`, `hatch?`, `height: 10 \| 6`, `fill: progress \| ink` | live run card, sweep meter, `StageBars` rows |
| `Ledger`, `DayKicker` | §8.4 "every table scrolls inside its own sheet" | `Ledger{columns, children}` owns the `overflow-x` box | History, Activity |
| `Modal` | dashboard §8.6 sidecar | `label`, `facts`, `children`, `onClose`; scrim, `useDialogEscape`, full-screen under `useNarrow` | item modal, run modal |
| `FormSheet` | dashboard §8.7 sheet | `title`, `steps?`, `footer`, `children`, `onClose` | `LaunchSheet`, `OrchestrateSheet` |
| `Segmented`, `Select`, `NumberField`, `Switch` | §8.2 36 px control family, pill switch | as today, moved from `settings/SettingsRow.tsx` | Settings rows, the sheets' pickers |
| `useNarrow` (hook) | the one place JS knows the 700 px breakpoint | — | `Modal`, `FormSheet`, `SideRail` |

`SettingsRow` and `SettingsGroup` stay under `settings/`: they are the
Settings card's composition of `Sheet` + rows, not a primitive. `Dot`'s
`hue` prop resolves through `project-hue.ts` exactly as `.pill-proj-N`
does today — the class stays in the stylesheet, never a `style` attribute.

### 12.3 Compositions

Everything else is a page-level composition of the table above and stays
in its section's directory: `ItemCard`, `BoardColumn`, `RunChip` (board);
`LiveRunCard`, `HistoryRow`, `RunModal`, `StageTrack`, `StageBars`,
`WatchingRow`, `ActivityLedger` (runs); `SettingsRow`, `SettingsGroup`,
`WatchdogGroup` (settings); `ItemModal` (board). `RunControls` stays
top-level, composing `Chip`, for the reason its header gives — two lazy
chunks read it.

### 12.4 When each lands

Task 1: everything in the table but `Modal` and `FormSheet`. Task 3:
`Modal` (History needs it). Task 5: `FormSheet`. A task never adds a
primitive the table does not list without amending this section first.
