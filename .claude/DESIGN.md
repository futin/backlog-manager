# Design analysis — the board's visual language

Sections 1–7 below are copied verbatim from ../claude-agents-dashboard/.claude/DESIGN.md at commit c179ca4 (2026-09-12) on 2026-09-15; they describe the reference design framework and not this application. Section 8, to follow, documents how this app applies them.

## 1. Typography

### Typeface
A single geometric-grotesque sans is used for everything — UI, labels and numerals. Characteristics visible in the screenshots: tall x-height, closed apertures, straight-cut terminals, circular `o`/`e`, single-story `a`, flat-sided `$`, tabular-feeling lining numerals, slightly condensed caps in the wordmark.

A geometric grotesque in the vein of the Aeonik / Neue Montreal class. Suggested substitutes, in preference order:

```
font-family: "General Sans", "Hanken Grotesk", "Plus Jakarta Sans", Helvetica, sans-serif;
```

No secondary/display face, no serif, no monospace. Numerals are set in the same face as text (not a separate mono) — set `font-variant-numeric: tabular-nums` on all figures and table columns.

### Weights in use
| Weight | Where |
|---|---|
| 400 Regular | body copy, secondary labels, table cells, axis labels |
| 500 Medium | nav items, buttons, card titles, legend labels, tab/chip labels |
| 600–700 Semibold/Bold | big money figures, wordmark, percentages in lists |

Only three weights; nothing lighter than 400, nothing heavier than 700.

### Type scale
| Role | Size | Weight | Line height | Tracking |
|---|---|---|---|---|
| Hero metric (`$12,450`) | 44 px | 700 | 1.05 | −0.02em |
| Large metric (`$15,000`, `$8,450`, `$15,780`) | 30 px | 700 | 1.1 | −0.02em |
| Gauge value (`75%`) | 28 px | 700 | 1.1 | −0.02em |
| Card title (`Monthly spending limit`, `Cost analysis`, `My card`) | 19–20 px | 500 | 1.3 | −0.01em |
| Wordmark | 20 px | 700 | 1 | +0.01em |
| Nav item | 16 px | 500 | 1.4 | 0 |
| Promo heading (`Upgrade to Pro!`) | 20 px | 700 | 1.25 | −0.01em |
| Body / list row (`Housing`, transaction name) | 14–15 px | 400 | 1.45 | 0 |
| Card subtitle (`Balance overview`, `Spending overview`) | 13 px | 400 | 1.4 | 0 |
| Legend, chip label (`7d`, `January`), button label | 13 px | 500 | 1.3 | 0 |
| Meta / axis / tooltip body / date under transaction | 12 px | 400 | 1.35 | 0 |
| Status micro-label (`Completed`, `Declined`), sub-caption (`Left to save 4 months`) | 11 px | 400 | 1.3 | 0 |
| Badge count (`19`) | 11 px | 500 | 1 | 0 |

Pattern: every card uses a **title + one-line subtitle** pair (19/500 over 13/400 grey), then the metric, then the visual. Deltas (`5.1% from last month`) mix two colors in one 12 px line: the number colored, the trailing words grey.

---

## 2. Color

### Neutrals / backgrounds
| Token | Value | Use |
|---|---|---|
| `--bg-page` | `#D9D9D9` | outer canvas behind the app shell (screenshot backdrop) |
| `--bg-app` | `#F4F4F3` | main content area behind the cards (very slightly warm grey) |
| `--bg-surface` | `#FFFFFF` | cards, sidebar, header controls, tooltip |
| `--bg-subtle` | `#F2F2F1` | sidebar active row, icon-button fill, chart track / empty bar |
| `--bg-track` | `#EDEDEC` | progress-bar and gauge remainders, placeholder bars |
| `--border` | `#EAEAE8` | card borders (1 px), divider rules, input outline |
| `--border-strong` | `#DCDCDA` | button outlines (`7d`, `January`, quick-action tiles) |
| `--ink-inverse` | `#111111` | Upgrade-now button fill, avatar/logo dot |

### Text
| Token | Value | Use |
|---|---|---|
| `--text-primary` | `#131313` | headings, metrics, nav items, list labels |
| `--text-secondary` | `#6E6E6E` | subtitles, axis labels, "from last month", table headers |
| `--text-tertiary` | `#A0A0A0` | placeholder ("Quick search"), limit ceiling `$10,000`, `Other` |
| `--text-on-dark` | `#FFFFFF` | Upgrade button, card-face text |

### Accent / data colors
The palette is a three-step warm-to-green ramp; green = positive, orange = spend, yellow = savings.

| Token | Value | Meaning |
|---|---|---|
| `--green-600` | `#5FA92C` | positive delta text, darkest ramp step |
| `--green-500` | `#7DC242` | primary accent green — debit card, filled progress, income bars |
| `--green-400` | `#9BD25C` | gauge mid, ramp step |
| `--green-200` | `#CDE8A8` | light ramp / decorative tiles |
| `--yellow-400` | `#F2E635` | Savings series, Food category |
| `--orange-400` | `#F5A15C` | Expenses series, Housing / Debt / Car / Travel bars |
| `--orange-300` | `#F9C79A` | decorative tiles, negative delta arrow |

Filled bars, the debit card and the gauge all carry a **fine 45° diagonal hatch** (≈2 px stripe, ~8% white over the fill) — the signature texture of the design. Empty/placeholder bars are flat `--bg-track` with no hatch.

Third-party logos in the transaction list keep their own colors on small rounded tiles; everything else stays inside the palette above.

---

## 3. Spacing

Base unit **4 px**; the layout runs on an 8 px rhythm.

| Token | Value | Use |
|---|---|---|
| `space-1` | 4 px | icon-to-label in dense rows, legend dot gap |
| `space-2` | 8 px | label-to-value, list row gap, chip padding-y |
| `space-3` | 12 px | title-to-subtitle block, inner row padding |
| `space-4` | 16 px | gap between cards in a row/column, nav item padding-x |
| `space-5` | 20 px | card inner padding (small cards) |
| `space-6` | 24 px | card inner padding (standard), app-area padding |
| `space-8` | 32 px | sidebar padding, header-to-first-card |

Measured specifics
- App shell inset from canvas: **≈40 px** all round; shell corner radius 24 px.
- Sidebar width **≈300 px**; content gutter left of cards **24 px**.
- Card grid gutter: **16 px** horizontal and vertical, consistently.
- Card padding: **24 px** on the large ones (balance chart, card widget, transaction history), **20 px** on the short tip/limit cards.
- Header row height **≈56 px**; search field height 48 px; icon buttons 48 × 48 px.
- Nav row height **≈44 px**, 8 px between rows, icon-label gap 12 px. Sub-nav (`History`, `Integration`, `Reports`) indented 36 px with a 1 px L-shaped tree rule.
- Section divider above `Learning center`: 1 px rule with 24 px space above and below.
- Title → subtitle: 4 px. Subtitle → metric: 12–16 px. Metric → chart: 20–24 px.
- List rows (categories, transactions): 26–28 px tall, ~10 px between.
- Quick-action tiles: 48 × 48 px, 12 px gap, label 8 px below.
- Quick-payment avatars: 44 × 44 px, 8 px gap.
- Progress bars: 10 px tall; segmented cost bar 10 px tall with 4 px gaps between segments.

---

## 4. Radii

| Token | Value | Applied to |
|---|---|---|
| `radius-xs` | 4 px | bar-chart column caps, cost-analysis segments, legend swatches |
| `radius-sm` | 8 px | progress bars (pill-ish at 10 px height), small logo tiles |
| `radius-md` | 12 px | chips (`7d`, `January`), quick-action tiles, avatars, tooltip, badges on avatars |
| `radius-lg` | 16 px | cards, sidebar promo card, debit/credit card faces, search field, header icon buttons, Upgrade button, nav active row |
| `radius-xl` | 24 px | outer app shell |
| `radius-full` | 999 px | notification badge `19`, legend dots, avatar in header |

Nothing is fully square; the smallest radius anywhere is 4 px. Rounding scales with element size — a consistent ratio of roughly 1:8 (radius : shortest side) at the card level.

---

## 5. Elevation & strokes

- Cards sit on `--bg-app` with a **1 px `--border` stroke and no shadow** (or an imperceptible `0 1px 2px rgba(0,0,0,.03)`).
- Only two things float: the chart **tooltip** (`0 8px 24px rgba(0,0,0,.10)`, white, 12 px radius) and the **app shell** against the grey canvas (`0 24px 64px rgba(0,0,0,.10)`).
- Chart gridlines: 1 px `#EFEFEE`, horizontal only, no vertical lines, no axis line.
- Active nav is marked by a 3 px black bar flush to the left edge of the row plus the `--bg-subtle` fill — not by a color change in the text.
- Drop targets for widgets use a 1 px dashed `--border-strong` outline with 16 px radius.

---

## 6. Iconography

Outline icons, ~1.5 px stroke, 20 px box in nav and 20–22 px in tiles, rounded joins, `--text-primary` color. Chevrons and the `>` in `Read more` are 12–14 px. Icons never take accent color.

---

## 7. Reusable patterns

- **Metric card**: title (19/500) → subtitle (13/400 grey) → figure (30/700) → delta line (12 px, colored number + grey words) → visual.
- **Filter chip**: 13/500 label + chevron, 12 px radius, 1 px `--border-strong`, white fill, sits top-right of the card it filters.
- **Progress row**: name + `current / target` (target in grey), 10 px hatched bar over `--bg-track`, 11 px grey caption under.
- **Two-tone amount**: spent value in `--text-primary`, ceiling in `--text-tertiary`, same size — used for limits and goals alike.
- **Ramp encoding**: category order follows the orange → yellow → green ramp, so the segmented bar and the legend read as one object.

---

## 8. Applying this to the board

§8 is written new, not copied, for the same reason the dashboard's own §8 is: that section applies §1–7 to sessions, usage, analytics and management — pages this board does not have — and nothing in it draws a kanban column, an item card, a run, a stage track or a watchdog console. What follows is this app's own reading of §§2–6, in the dashboard's register: a number, the rule it sets, then the reason it was set. Two lessons the dashboard's own §8 carries apply to every subsection below, so they are stated once here rather than per subsection: nothing on `--board` uses `--strip-hi` as its only separator — on daylight the two sit two points apart and the element vanishes — and a raised control marks a state, never a button.

### 8.0 Shell and rail

The rail takes §2.4's figures, three of which are themselves a departure from the spec/mock this board shares with the dashboard — recorded here so the next reader does not "correct" them back to the mock's numbers, or to the dashboard's own:

| | Spec / mock | This board | Why |
|---|---|---|---|
| Rail width | 300 px | **280 px** | the only figure the content column notices in a window this narrow — this board's own figure, sitting between the mock's 300 px and the dashboard's own shipped rail at 240 px (`.rail{flex:0 0 240px}`, `styles.css:158`) |
| Nav row height | 44 px | **36 px** (44 px on the phone menu) | the dashboard's own rail CSS ships 36 px rows at 14/500 — 8 px shorter than the mock, and lighter than its own DESIGN.md prose still records — and this spec copies the shipped rule rather than the drifted prose; the mock's full 44 px is kept for the phone menu, where the row is a thumb target rather than a pointer one |
| Sub-nav indent | 36 px (the icon's right edge) | **24 px** (the icon's centreline: 16 px row padding + half of a 16 px icon) | this board's icon is 16 px, and so — per its own CSS — is the dashboard's (`.rail-ic{width:16px;height:16px}`, `styles.css:183`); the two indents differ because this board hangs the rule off the icon's centreline (16 px row padding + half the 16 px icon) while the dashboard's shipped rule sits it flat at 20 px (`.rail-sublink{padding:7px 0 7px 20px}`, `styles.css:212`) |

Everything else is the spec's, unchanged: 32 px padding-y, and a wordmark 20/700 over an 11/500 uppercase `.rail-kicker`.

Rows are 14/500, 16 px padding-x, 16 px radius, a 16 px outline icon 12 px from the label. Active is a 3 px ink bar 16 px tall at the left edge plus a `--strip-hi` fill — never a colour change in the label (§5). Hover darkens the label and nothing else; the fill stays reserved for active, so a hovered row and a selected row read as two different things rather than one filled twice. Icons hold `--ink` at every row weight (§6) — they name the section, never its state.

The sub-nav tree is drawn only for the open section. Runs gets the first one this board has, History and Watchdog (§8.4) — the same choice `RUNS_MODE_KEY` (`client/src/lib/runs-mode.ts`) already persists and guards, whose segmented control is replaced by the tree at every width, not only above the phone breakpoint.

Settings sits under a 1 px rule with 24 px of air either side: it is about the board, the four rows above it are about the work. `.main` sits on `--board` with a 24 px top margin and a 24 px top-left radius — the one corner the rail meets.

Below 700 px the rail becomes a top bar, wordmark left and ☰ right, with every tree standing open so a sub-view is a tap away rather than behind an accordion. The bar hides on a downward scroll and returns on the first upward one, and stays pinned while the menu is open, because the menu hangs off it.

### 8.1 Type

| Role | Size / weight | Where |
|---|---|---|
| Page and card title | 19/500, −.01em, 1.3 | band titles, sheet titles, the Runs detail sheet's project |
| Large metric | 30/700, −.02em, 1.1 | figure strip values |
| Row name | 15/500 | column header names |
| Card title | 14/500, 1.35 | item card title, Runs list row project (Live and History), stage track item title |
| Subtitle / hint | 13/400 | band subtitle, sheet subtitle, figure label, control label |
| Body, chip and button label | 13 (500 on buttons) | filter chips, controls |
| Meta / axis / caption | 12/400 | `id · date`, project name beside its dot, stage durations, table time column |
| Pill, badge, status | 11/500 | count pills, markers, mode pill, stage word on the live strip |

11 px is the floor beneath all of these; nothing on the board goes smaller.

Hanken Grotesk is the one face — self-hosted via `@fontsource/hanken-grotesk`, weights 400, 500, 600 and 700 imported in `client/src/main.tsx` — rather than linked the way the dashboard's own foundation links Google Fonts. That is the one place this section departs from the dashboard's: the served build's CSP is `default-src 'self'` with no `font-src`, `style-src` is pinned exactly by `test/csp.test.ts`, and the tailnet/phone use case this board is built for wants no third-party fetch at all.

`--mono` and `--display` are deleted from `theme.css`, not aliased to `--font` — an alias would let a stale `var(--mono)` left behind by the redesign keep quietly resolving to Plex. Deleting it means the same rule instead falls back to the inherited face, which is the failure this board wants to surface rather than hide. `code, kbd, samp, pre { font-family: inherit }` removes the UA's own monospace default for the same reason, so a code span is marked by its fill and ink alone, and `body` carries `font-variant-numeric: tabular-nums` so figures line up wherever they appear. `text-transform: uppercase` survives on `.rail-kicker` alone.

Three faces — Barlow, Barlow Condensed and IBM Plex Mono — left behind 80 `--mono` uses, 14 `--display` uses and 31 `text-transform: uppercase` rules in `client/src/styles.css`, and 124 of that file's 130 `font-size` declarations sat at 12.5 px or smaller. `task-36` cleared all of them: the two tokens and the uppercasing are gone outright (`test/design-guards.test.ts`'s guards 1 and 4 hold them there), and every size below the 11 px floor was raised to the role this table gives it. The sizes at or above 11 px that the table does not name by element were left where they were, because each sits on a surface tasks 2–5 redraw and the primitives those tasks compose carry the full table already.

### 8.2 Tokens and themes

`shared/theme.css` keeps its vocabulary; daylight's values are rewritten to the reference palette, the same values the dashboard's own daylight block already carries:

| Token(s) | Daylight |
|---|---|
| `--board` / `--steel` / `--strip` / `--strip-hi` | `#f4f4f3` / `#ededec` / `#ffffff` / `#f2f2f1` |
| `--edge` / `--hairline` / `--hairline2` | `rgba(0,0,0,.03)` / `#eaeae8` / `#dcdcda` |
| `--ink` / `--ink2` / `--ink3` | `#131313` / `#6e6e6e` / `#a0a0a0` |
| `--green` / `--amber` / `--mustard` / `--cyan` / `--red` / `--magenta` | `#5fa92c` / `#c4761f` / `#9a8712` / `#3f8f14` / `#b03b28` / `#6b52a8` |
| `--on-accent` / `--scrim` / `--shadow` / `--shadow2` | `#ffffff` / `rgba(19,19,19,.28)` / `rgba(0,0,0,.06)` / `rgba(0,0,0,.1)` |

Two of these are mapped rather than lifted straight from the reference palette, and this board keeps the same two mappings the dashboard's own daylight comment records: `--green` resolves to a darkened `--green-600`, the palette's own positive-delta shade (§2); and because the ramp's brightest fills read as fills rather than as running text in that same palette, `--amber` and `--mustard` take darkened cousins here too, so both still hold contrast as text.

Two tokens are new, added to every theme block, because the design draws two things in the ramp's bright fills and the palette otherwise has no fill that is not also a text colour:

| Token | Meaning | Daylight | Dark themes |
|---|---|---|---|
| `--fill-live` | the card's live strip, the current stage node, the "you are here" bar | `#F5A15C` (`--orange-400`, §2) | `var(--amber)` |
| `--fill-progress` | filled progress, a reached stage node | `#7DC242` (`--green-500`, §2) | `var(--green)` |

Each dark theme block declares its own `var(--amber)` / `var(--green)` line for these rather than sharing one rule across all four, the same way every other ramp token is themed per block. Beyond these two lines, the four dark theme blocks are otherwise unchanged as overrides — no other dark-theme rule in this section is touched.

`.hatch` is one utility rule over any fill: `repeating-linear-gradient(45deg, rgba(255,255,255,.30) 0 1px, transparent 1px 4px)`.

The four column dots read the design's category ramp left to right — refactors `--amber`, ideas `--mustard`, bugs `--red`, tasks `--green` — replacing today's magenta/mustard/red/cyan ticks. The refactors tick is `--magenta`'s last *column* job, but not its last job: the capture dispatch control still reads it — `.dispatch-tab.capture` and `.dispatch-chip.capture`, base and hover (`client/src/styles.css:1490`, `:1493`, `:1497`, `:1503`) — four of the token's five uses in that file against the tick's one. The dispatch chip keeps its three action tones exactly as coded, unchanged by this redesign: groom `--mustard`, execute `--cyan`, capture `--magenta`. Ideas now sharing mustard with the groom chip costs nothing — a column dot and a card's own control are never read as the same object.

The project-hue rule carries over unchanged: one 8 px dot, on the card and on the modal's facts column, never on text — the project name sits in `--ink2` beside it. The eight `--proj-N` sets are themselves untouched; the dot is applied by class, never a `style` attribute, so a theme swap recolours it for free.

The one-home rule for primitives (the design spec's §12.1) applies to every pattern this section draws that more than one surface uses: each is one component in `client/src/components/ui/`, owning one class family in `styles.css`, so two surfaces can never restate — or quietly disagree about — the same look. Until `docs/subsystems/board.md` carries this rule, as the spec's own §11 intends, the spec's §12 table is the pointer for which primitive owns which pattern.

### 8.3 Board

Cards in columns — `01-board-shape.html`, option A: today's kanban, redrawn at this scale, `BoardColumn` composing the column and `ItemCard` the card. Rejected: each column as one sheet with hairline rows (~35 % less height, but the header grows a subtitle and the card stops being a card), and one ledger grouped by type (the densest read, but it loses the four-column scan).

**The band.** `Band` carries the 19/500 title and a 13 px `--ink2` count line (`21 open across 3 projects`), then right-aligned a 36 px search field (12 px radius, `--hairline` stroke) and the filter chips — 32 px, 12 px radius, `--hairline2` stroke, 13/500 — as `Chip` (`variant: outline`). Orchestrate is the page's one ink chip (`variant: ink`, `--ink` fill, `--strip` text); its hide/disable rules are unchanged.

**The run chip.** `RunChip` replaces three things at once — the run strip that sat above the columns, `StartingStrip`, `RunDrawer` — because, in the user's own words when this was decided, "the board can show the issues, but the runs shows more info, no reason to keep it in both places." What stays on the Board is the card's own live strip and this one chip, which opens Runs.

Its `Dot` takes the worst state present: `--fill-progress` for live, `--fill-live` for paused or starting, `--red` for crashed. Beside it a 12/500 count line names every state present — `2 runs · 1 live ›`, `1 run · crashed ›`, `1 starting ›` are the three example readings. The precedence rule is exact: crashed over paused or starting over live. It renders the payload's `starting` array with no client-side filter, the same rule the strip it replaces followed. It is a `<button>` whose click calls the rail's own section setter, and it is absent entirely when the payload carries no run and no starting entry.

**Columns.** `repeat(4, minmax(0, 1fr))` at 16 px gaps: two columns under 1100 px, one under 700 px, the steps explicit rather than a fluid `auto-fit`. Each `BoardColumn` header is an 8 px ramp `Dot` (§8.2's four column hues), the name at 15/500, then a `Pill` (`tone: neutral`) sized 22×20 at 11/500 on `--strip-hi`, pushed right. No rule is drawn under the header — the cards' own ground gap is the only separation.

**The card.** `ItemCard` is `--strip`, 12 px radius, no stroke and no shadow. Hover changes only the cursor and nothing else — a card is a button by role (§5), and this design marks nothing by hover. Face padding is 14/16/12 with a 10 px internal gap.

- Title 14/500, 1.35, wraps.
- Foot row: an 8 px `Dot` in `--proj-N` plus the project name at 12/400 `--ink2`, ellipsised, then `id · date` at 12/400 `--ink3` pushed right, `flex: none`.
- Marker row, drawn whenever a marker applies or dispatch is available (below): `Marker` renders `groomed` in `--green`, `chore`/`debt` in `--ink3`, `done` in `--ink2`, `stale` in `--mustard`, all 11/500 — the same words, the same tokens, §7's size.
- The live strip: 24 px across the card's top edge, `--fill-live` with the `.hatch` utility (§8.2), 11/500 `--ink` text — the stage word left (`grooming`, `executing`, `in progress`, or an orchestrator stage through `needs-answers`/`parked`), the elapsed reading right. The hand-session set is `progressLabel`'s own three words (`client/src/lib/item-progress.ts:39-43`), not spec §3.4's example list, which names `reviewing` beside them — that word is a `RunStage` (`shared/types.ts`), not a `phase` one, so this section keeps the two axes apart rather than repeat the spec's mixed list. One fill covers both a hand session and an orchestrator stage; the word alone carries the distinction, and the second tone the strip used to switch between is gone, because this design marks state by ink, never by accent (§5).
- The dispatch chip: the control `CLAUDE.md`'s invariants name `DispatchButton`, composing `Chip` at 28 px, sits at the right end of the marker row. It is **always drawn** whenever the environment allows dispatch at all — **never hover-revealed** — because a disabled control a user can click to re-ask its status (bug-13) has to be visible to be clicked, and this design marks nothing by hover. The marker row therefore renders whenever dispatch is available, markers or not; its three disabled blocks and the re-ask click are unchanged.

**What leaves.** `RunStrip.tsx`, `StartingStrip.tsx`, `RunDrawer.tsx` and their CSS. What stays: `useOrchestratorRuns` keeps polling while any run is `running`, fresh or not, and `runClaimBlock` / `runHoldsItem` keep the inputs they already take — the Board still needs both to draw the card's live strip and to block dispatch on a claimed item. The rules the departing components carried move to Runs; §8.4 is where they land.

### 8.4 Runs

Runs is two pages under one rail entry — `History`, the section's default, and `Watchdog` — reached through §8.0's sub-nav tree. Both open on a `Band` and read the same `useOrchestratorRuns` payload (`client/src/hooks/useOrchestratorRuns.ts:97`); Watchdog additionally mounts `useWatchdog` (`client/src/hooks/useWatchdog.ts:90`), exactly as `WatchdogMonitor` does today, so moving between the two adds no request and neither page owns a second copy of the run list.

The shape is `03-runs-shape.html`, **option D** — the figures lead, then a split. Three shapes were drawn against it and rejected: the split alone (A — a list sheet and a detail sheet, the closest of the three to today's Runs; D *is* that arrangement, carrying D's content, so what A lacks is not its shape but everything the rows, the detail body and the sixth figure cell were redrawn to hold); one ledger whose selected row expands underneath (B — one layout at every width, at the price of a long detail shoving every row beneath it down the page); and live runs first as cards with history under them (C, picked and audited earlier on 2026-09-15 and superseded by D the same afternoon — it sat the figure strip between live and history, and its History detail opened in a modal). D takes A's arrangement and C's content: it keeps C's band, range control, figure cells, status words, load-more and empty states verbatim, and changes only where the strip sits, that a live run is a row rather than a card, and that the run's detail is a sheet rather than a modal. Watchdog is `04-watchdog.html`, option A — its own page; rejected: folding the sweeper's per-run facts onto the runs themselves (B) and hanging the console off Runs as an aside (C).

#### 8.4.1 History

**Why the name.** `History` names the rail destination — Runs › History — not the contents of the page under it. That page carries four things and only one of them is past: the figures, the live runs, the past runs, and the selected run whole. It is named for what a person is looking for when they arrive with nothing running, and because a tree whose first leaf repeats its own parent teaches nothing.

**The band.** `Runs` at 19/500 over a 13 px `--ink2` line that counts all three states at once — `3 live · 1 starting · 28 past` — then, right, the project select and the range control as chips. The range control is `RUN_RANGES`' four steps (`client/src/lib/run-range.ts:41`) as one segmented chip, and the sheet subtitles below name whichever is in force.

**The figure strip, directly under the band — the statistics lead.** One sheet the ground divides: five figures on a 2 px `--board` gap grid, wrapping five → three → two under 1100 and under 700 with the seam drawn in both directions, so the gap reads as one grid at every width rather than as five cards that happen to touch. Each cell is a label at 13 `--ink2`, a value at 30/700, and a 12 px line under it. All five carry that line where today only `runs` and `avg item work` do (`client/src/components/runs/RunsView.tsx:999`, `:1041`), and the three new ones say what the figure above them *means* — which is the only thing a line here is allowed to be. The five read what `aggregateRuns` returns (`client/src/lib/run-stats.ts:653`) and nothing else, and that is what rules out the three lines the mock had drawn instead: `+4 vs prior 30 days` compares against a prior period nothing computes, `3 parked` counts something the aggregate does not keep, and `1 red of 41` was invented and in the wrong unit besides.

- **runs** — its line the five-status breakdown, glyph and count each, in `STATUS_ORDER`'s order (`client/src/components/runs/RunsView.tsx:348`).
- **completed / queued** — line `merged or branched`, which is the definition of completed rather than a gloss on it.
- **avg item work** — line `queue wait excluded`, the same rule `itemDurationMs` already enforces (`client/src/lib/run-time.ts:369`).
- **rework / completed** — the one-decimal ratio `RunAggregates.fixLoopsPerMerged` (`run-stats.ts:588`) over the line `fix loops per completed item`, with today's long sentence kept as the cell's `title`. The mock's `6 / 41` fraction needs two numbers the aggregate does not return.
- **verify pass** — a rate over verification *runs*, not items, and its line `of every verification run` says which, because the unit is the whole claim.

The wide machine-time tile becomes the strip's **sixth cell, full width**, holding `StageBars` (`client/src/components/runs/StageBars.tsx:42`) redrawn at a 10 px bar height — up from the 6 px `.run-bars-track` ships today (`client/src/styles.css:2272`), because at full width the bar is now the cell's subject rather than a sparkline beside a number. Always seven rows, in pipeline order, `—` for a stage never recorded: the seven are `MACHINE_STAGES` (`run-stats.ts:276`), and a stage that drops out when it has no total turns the chart into a different chart per range. Its line is `<range> · queue wait excluded`. The whole strip hides with the list when the range or project filter empties it, as today.

**The split**, under the strip: a **420 px** list column on the left carrying the Live sheet and then the History sheet, and one detail sheet on the right showing the selected run. Under **1100** px the two columns stack, list first, the detail a scroll away; under **700** px the sheets are full width. 420 px is the figure the row designs below answer to — every reading that does not survive that width is in the detail sheet instead, and the list is what has to stay legible when the detail is a scroll away.

**The Live sheet.** Title and a subtitle counting its own contents (`3 runs · 1 starting`), then one **row, not a card**, per run whose status is `running` or `paused`, or that is `starting`: a `Dot`, the project at 14/500, `⚠ N` in `--amber` when the run carries attention entries (today's `N needs attention`, `client/src/components/board/RunStrip.tsx:615`, compressed to the count and its glyph), the two-tone `1 / 5`, elapsed at 12 `--ink3`, and a status pill only where one is earned — `‖ paused`, `⚠ crashed`, and nothing at all on a running, fresh run, whose state the dot and the elapsed reading already carry.

- A **starting** entry is a row reading `starting… · <age>` with no controls, and cannot be selected: there is no run file yet, so there is nothing for the detail sheet to show.
- A **crashed** run — running, heartbeat stale — is a two-line row: a `--red` dot, a `crashed` pill, and a second line in `--amber` at 12 px carrying `no heartbeat for <age>`, then `last reported <id> at <stage>` or `all items at rest` (`RunStrip.tsx:329-331`), then the clause `watchdogClause` composes (`client/src/lib/run-watchdog.ts:109`). All three readings travel together or the row says less than the strip it replaces did.

Everything C's live card carried that no longer fits a 420 px row — the run id and start clock, the heartbeat word, `$ · N turns · N sessions`, the mode pill, `paused after <id>`, and the current item's stage track — is in the detail sheet, which is beside the list rather than behind a click.

**The History sheet.** Title and subtitle (`28 runs · all`), day kickers at 13/500 `--ink2` in `dayLabel`'s own form (`run-stats.ts:899`), and one **44 px** row per past run: the dot **and** the status word from `runStatusChip` (`client/src/lib/run-stage.ts:229`) — `done` / `aborted` / `failed` / `paused`, toned `--ink3`, `--amber`, `--red` and `--fill-live` — then the project at 14/500, the two-tone count, wall time at 12 `--ink3` and the cost beside it when usage exists. The word is not decoration: a dot alone cannot tell the first three apart, and three colours of the same dot is the encoding §5 rules out. Load-more stays a flat chip at the sheet's foot, in pages of 25. A row **selects** the run into the detail sheet — nothing opens. There is no run modal on this page, and none anywhere in this redesign. Live runs are never in this list, and a crashed run is a Live row rather than a History one; a run reaches History when it has finished, not when it has stopped reporting.

**The detail sheet.** One run, whole, beside the list.

Its **head** is the project (a `Dot` plus 19/500), the run id at 12 `--ink3`, the item count when the run is finished, and `RunControls` (`client/src/components/RunControls.tsx:70`) right as 28 px chips — unchanged in what it offers: running and fresh gets **Pause**; a run with a pause requested gets the note `Pausing after <id>` (`RunControls.tsx:116`) beside **Cancel**, which withdraws the request and takes no accent, because nothing here stops a run and a control that is not destructive must not read as one; `paused` gets **Resume run**, hidden when the environment cannot spawn, `aria-disabled` with the reason as its title when the project is not visible, `Resuming…` in flight — behind that word `RunControls` now carries the synchronous in-flight guard `RunStrip`'s own Resume used to (bug-19's first layer, the table below): the board's `resuming` mark is set only once the request has already answered, so for the whole gap before that nothing else stands watch, and without this guard a click repeated into that gap fires a second request the first has not yet answered; a crashed run gets **Resume run** exactly when `watchdogStoodDown` (`shared/agent.ts:695`) says the sweeper will not — and `test/watchdog-coupling.test.tsx`, which drives that coupling from one table of hand-checked verdicts, drives this head from now on rather than the strip that is leaving. A finished run has no controls. There is no `Open ›`: the detail needs no opening.

Its **body** is the whole of `RunDetail` (`client/src/components/runs/RunDetail.tsx:170`) re-flowed to one column, in this order:

1. A **facts strip** — label over value on a wrapping grid: `started` (and `finished`) with the wall reading from `runWallMs` (`run-stats.ts:237`) or the elapsed one; `status`, the chip from `runStatusChip` plus `heartbeat live` or its age, `pausing · finishes <id>` while a pause is requested, `paused after <id>` when paused, and for a crashed run `last heartbeat HH:MM · every stage below is last reported, not current`; `mode`, the pill `mergeModeLabel` returns (`run-stage.ts:184`) — `branch mode` or `branch mode (downgraded)`, and nothing for a merge-mode run, which draws no badge today; `questions`; and `$ · N turns · N sessions` from `runUsageTotals` (`run-stats.ts:813`) when usage exists.
2. The mode and question notes — `mergeModeNote` when the effective mode differs from the requested one (`RunDetail.tsx:406`), and the headless note under `decide` — as one 12 px line under the strip.
3. Today's chips in a row: merged, branched when above zero, skipped, attention, fix loops, plus **active** and **queued** while the run is live. An earlier draft named "fifteen stage chips"; they do not exist today and are not added here.
4. The attention entries, each with its questions.
5. **Machine time by stage** — `StageBars` over `runStageTotals` (`run-stats.ts:433`), the strip's sixth cell scoped to one run, the same seven rows, its line `this run · queue wait excluded`.
6. **Branches to merge** when any — one `git merge --no-ff <branch>` per branched item, because a branch-mode run's output is a list of commands a person still has to run.
7. **Items**, in pipeline order: a head carrying the id at 12 `--ink3`, the title at 14/500, the stage chip (glyph plus the real stage word, toned by `STAGE_TONE`, `run-stage.ts:21`) and its `RowTime` reading right (`client/src/components/board/RunRowTime.tsx:92`) — `span · finish clock` for a terminal stage, `span elapsed` otherwise, nothing at all for a skipped or ungroomed item, `—` for a pending one; then the `queue … · preflight …` lead at 12 `--ink3`; then the stage track (§8.4.3) with its `×N` fix-loop pill and a terminal node reading the finish clock in `--ink2`; then the per-item usage line from `itemUsageTotals` (`run-stats.ts:795`), its session count drawn only above one; then the `assumed` list under `decide`; then the last verification as a disclosure — command, `ok` / `failed`, tail — open when failed. The track's terminal node answers the item first and the run's mode second (`stepperTerminal`, `run-time.ts:504`), so a run the classifier downgraded mid-queue still reads `merged` on the item that merged before the downgrade and `branched` on the rest. A crashed run's current node renders stalled — the current tone, no ring, no pulse — against a clock clamped at the last heartbeat, because a pulsing node on a dead run is an animation asserting something false.

Verification tails arrive with `fetchArchivedRun` (`client/src/lib/agents.ts:261`) when a finished run is selected, and `couldn't load verification output` reads under the facts strip when that fetch fails. Task-27's rule that a session's cost is recorded per transcript is unchanged in what it shows; only its surfaces move, to the History row (`wall · $`), this facts strip and each item's usage line.

**Selection** is one run across both sheets. The first live run is selected on arrival — so the Board's run chip (§8.3) lands a reader on the current item's stage track with no second click — and with nothing live, the newest History row is. **Empty states** are unchanged: `no runs yet` when there is nothing anywhere, `no runs in this range` when the range or project filter empties the list, with the figure strip hidden alongside it.

**Rules that moved here.** Each of these is stated in `CLAUDE.md` and reasoned in `docs/subsystems/invariants.md` against a surface this redesign deletes. The rule stands; only its home moves, and the invariants entry is edited in place to name the new surface rather than removed.

| Rule | Today | After |
|---|---|---|
| A crashed run renders as crashed, never as nothing | the `RunStrip` crashed strip, plus a badge in the Runs list | the **Live row** (`--red` dot, `crashed` pill, the three readings and the clause on its second line) and its detail sheet; a History row once the run has finished; the Board's chip counts it (`1 crashed ›`) |
| Resume for a crashed run stays on the strip alone | `RunStrip` | the **detail sheet's head** alone. Resume for `paused` — today on the strip *and* the Runs detail — collapses to that same single surface, so neither state has two Resumes to keep in agreement |
| A resume is serialized at three layers (bug-19), layer 1 | the board's Resume control in `RunStrip` — a synchronous `busy` guard, the only half that can catch a second click before the first answer lands, because the board's own `resuming` mark is set from `onResumed`, i.e. after the request settles; its window ends on `running` **and** `fresh`, not on `running` alone | the detail sheet's head; `RunControls` gains that same synchronous guard, for the same reason — a click and its answer are not simultaneous, and nothing else stands watch for the gap between them |
| The board offers a hand resume exactly when the watchdog will not | `RunStrip` + `watchdog.service.ts`, pinned by `test/watchdog-coupling.test.tsx` | the detail sheet's head and the Watchdog page's `Resume now` (§8.4.2), both reading `watchdogStoodDown`; the coupling test drives the detail head |
| A board-started run is visible before its run file exists | `StartingStrip` | the Board's chip (`1 starting ›`) and a **Live row** reading `starting… · <age>`, with no controls and no selection |
| The toolbar Orchestrate control hides on a starting entry | unchanged | unchanged — the control and its `runClaimBlock` input are untouched by this redesign |
| `useOrchestratorRuns` polls while any run is `running`, fresh or not | Board and Runs | Board (chip, card strips) and Runs — unchanged |

#### 8.4.2 Watchdog

**The band.** `Runs · Watchdog`, the `section · destination` convention the tree sets, with `stateLine`'s own sentence (`run-watchdog.ts:154`) as its 13 px subtitle — `armed — watching <ids>, next check in Ns`, `idle — no running run`, `off — <reason>`, each gaining `· resume disabled` when the switch is off. Right, one flat `Policy in Settings ›` chip: the policy is read here and edited there, and a second editor for the same three numbers is a second thing to keep in agreement.

**Three figures.** **Sweeper** — the phase as a 24/700 word rather than a number, since there is no quantity here, with a 6 px sweep meter under it in `--fill-progress` carrying `.hatch` (§8.2) and the line `next sweep in 4m 12s · every 10m`; the meter draws only while armed. **Watching** — the count of running runs over the app's own three counts, `⚠ 1 crashed · 2 fresh · 1 not yet watched`, the last of them drawn only when the runs payload is a tick ahead of the sweeper (`WatchdogMonitor.tsx:193-208`). Those three words are the tile's own and not a paraphrase of them: what a reader needs here is how many runs the sweeper holds an opinion about and how many it does not yet, and a count this tile cannot name is the one thing it must never print. **Policy** — `check every` / `leave alone for` / `give up after` as three label-over-value pairs, 12 over 14/500, with the enabled switch's state as the 12 px line. Both the sweeper line's cadence and all three policy values are the saved config's, not constants; their bounds are `WATCHDOG_LIMITS` (`shared/types.ts:1029`), and the Settings ladders and the server's clamp already read that one triple.

Two switches reach this page and they are not interchangeable, which is why the Policy line names its own — in the mock's words, `resume spawns on · your switch, not the phase`. `WatchdogConfig.enabled` is the user's Settings toggle and withholds the **spawn** alone: a watchdog disabled there still arms, still ticks, and still reports the crashed run it would have resumed. The phase reads `off` only when the environment says so — `offReason()` returns `BM_WATCHDOG off` or `BM_AGENTS off` and nothing else (`server/src/agents/watchdog.service.ts:228-232`, whose own comment records that `enabled` is deliberately not folded in) — and it is that state, an operator's rather than a user's, which hides the Watching sheet below and puts `nothing is watched while off` in this tile.

**The Watching sheet.** One row per run in the runs payload whose status is `running`, annotated from `watching` exactly as today — skew rendered, not hidden. Each row carries a `Dot`, the project at 14/500, the run id at 12 `--ink3`, `· not yet watched` when the payload is a tick ahead of the sweeper (`client/src/components/runs/WatchdogMonitor.tsx:271`), the verdict as glyph plus word (`● ok` / `⚠ crashed`), `last reported <id> · <stage>` or `between items`, and the heartbeat meter — the age against `RUN_STALE_MS` (`shared/types.ts:767`), amber once past it — under its two labels. A crashed row adds the attempts dots, the `watchdogClause` sentence, `→ session <id>`, and `leave alone Nm more` while the grace clock runs. A `Resume now` chip is drawn **only** when `watchdogStoodDown` allows — never while the sweeper still has attempts, whatever the grace clock says, because that is the one function both this chip and §8.4.1's detail head read. A watched id with no run in the payload renders as a placeholder line rather than as nothing: a set the console cannot explain is the failure this page exists to show.

The meter's first label is `heartbeat Ns ago` (`{beat}`, `WatchdogMonitor.tsx:311`) — a numeral every time. Its second label carries none: `stale at <RUN_STALE_MS>` and `past the <RUN_STALE_MS> stale line` are both formatted from the constant at render time (`WatchdogMonitor.tsx:316-318`), and the comment standing beside them gives the reason (`:312-314`): a meter labelled with a typed literal keeps naming the old window the day `RUN_STALE_MS` moves, and on that day the label lies while the meter behind it is still right. The same rule is why this section names the constant instead of its value.

The row is a button, and it **jumps to History and selects the run in its detail sheet** — which is what `WatchdogMonitor` does today (`onSelectRun`, `WatchdogMonitor.tsx:79`), and under option D is the only place it could send anyone: the run's detail *is* that sheet.

**The Activity sheet.** The event ledger keeps today's five columns and full run ids — `time · kind · project · run · what the sweeper did` — with `th` at 12/400 `--ink2`, `td` at 13, and the time column at 12 `--ink3`. Its subtitle keeps the caveat rather than burying it: the last `WATCHDOG_EVENT_CAP` events only (`shared/types.ts:1111`), held in the API process's memory, emptied by a restart. The kind cell is `WATCHDOG_KIND_GLYPH` plus the word, coloured by `WATCHDOG_KIND_TONE` (both `run-watchdog.ts:251` and `:271`) — `live` and `done` in `--green`, `bad` in `--red`, `warn` in `--amber`, `muted` in `--ink3`; seven kinds share those five tones, and the word beside the glyph is always the readable answer. The sheet scrolls inside itself under 700 px rather than letting five columns set the page's width.

**Why it stays a page.** Folding the console into the run rows was drawn twice and picked against both times, and the reason is what the console is for: it is read *during* a run, while the reader is already looking at that run, and its Watching set is the **sweeper's** set — one poll tick of skew away from the runs payload by design. Rendered as annotations on the run rows, that skew would read as the list being wrong; rendered as its own set, with `· not yet watched` on the rows that differ, it reads as the one true fact it is.

#### 8.4.3 The stage track

`StageTrack` (`client/src/components/runs/StageTrack.tsx:206`) keeps its seven equal columns and its data; only the drawing changes. Nodes are 12 px dots on a 2 px `--steel` rail, and the four states are told apart by fill and ring together rather than by four shades of one colour: reached is `--fill-progress`; current is `--fill-live` under a 3 px ring at 30 % that pulses; not reached is `--steel` with a `--hairline2` ring; and skipped — `fixing` on a run that ran no fix loop — is a dashed `--hairline2` ring, so "never needed" and "not there yet" are told apart by the stroke rather than left to the duration underneath.

Stage names sit under the dot at 11 `--ink2`, durations under those at 12/500. A `×N` fix-loop badge is an 11/500 pill on the `fixing` node — on the node it counts, because the number is a property of that stage and nowhere else. Under the track, the verification line: a `✓` or `✕` glyph, the command in an inline code span (`--ink` on `--steel`, 4 px corner, inheriting the face — §8.1 deletes the monospace default and this span is the reason the fill has to carry the distinction), and the summary at 12 `--ink2`.

### 8.5 Archive

Archive reuses the Board's own card and column language (§8.3) rather than drawing a second one — the same `ItemCard`, the same column shape — under the four columns `ArchiveView.tsx`'s own list already names: Refactoring, Ideas, Bugs, Out of scope (`ArchiveView.tsx:71-76`). There is no fifth Tasks column: `leavesBoard` (`client/src/lib/item-stale.ts`) never lets a task leave the Board at all, so a Tasks column here could only ever stand empty. Three of the four keep the ramp hue §8.2 and §8.3 already set for the type they name — refactors `--amber`, ideas `--mustard`, bugs `--red` — because the tick names a type, and a type does not change once an item goes quiet; out of scope carries none of that ramp, a plain `--ink3` dot, because a rejection is a verdict rather than a type, and giving it an accent would put it in the same vocabulary as the three columns that are still live work.

Inside each column, cards group by month exactly as `groupByMonth` (`client/src/lib/item-month.ts`) already orders them; only the kicker's face changes, to 13/500 `--ink2` riding the `--board` ground rather than a card of its own, so the month reads as a rule about the list rather than one more card competing with the ones under it.

The band carries the project select and search and nothing else — no status filter and no sort control, deliberately: Archive's contents are defined by staleness and rejection rather than by status, so a status select here would either do nothing or contradict the surface it sits on, and the month grouping is already the ordering a sort control would otherwise offer (`ArchiveView.tsx:167-171`). No live strip ever paints here either: whatever put a card in Archive already took it off the board a run could be holding. The one action an Archive card can still derive is `capture` (`shared/agent.ts:102`): reviving a rejection by filing a new item that cites it, the only `AgentAction` an out-of-scope item derives at all (`deriveAction`), and the one dispatch chip standing among cards that are otherwise finished.

### 8.6 Settings

Settings restates the dashboard's own §8.2 rather than deriving a second version of the same card language (`../claude-agents-dashboard/.claude/DESIGN.md:225-246`): a band header — the 19/500 title over a 13 px line, the same band every other page on this board opens with (§8.3) — sits above borderless `--strip` cards at 16 px radius and 24 px padding, each a title plus a one-line subtitle. Four of the five cards keep the grouping `SettingsView.tsx` already ships — `Board · this device`, `Display · this device`, `Orchestrator · this device`, `Claude Agents · this machine` — and the fifth is `WatchdogGroup.tsx`'s own card, `Orchestrator watchdog · this server`: a distinct card from `Orchestrator · this device` beside it, not a second rendering of it, rendered from its own file rather than `SettingsView.tsx`'s. The redesign restyles the cards, not what they group.

Rows inside stay boxless: 16 px of vertical padding and a hairline between them, name at 15/500 over a 13 px hint on the left, the control on the right. One 36 px control family carries every row's control at 12 px radius with a `--hairline2` stroke — `Select`, `NumberField` (`task-36` moved it, with `Segmented`, out of `SettingsRow.tsx` into `client/src/components/ui/`), a text field and a button — and the on/off rows plus the theme and density pickers take `Switch`'s pill shape instead: a recessed `--steel` track under a raised `--strip` option. Density and text size already draw through `Segmented` (`SettingsView.tsx:138-154`) and gain nothing here but this skin; the theme picker's own swatch buttons (`.set-theme`, `.set-swatch`, `SettingsView.tsx:116-132`) move onto the same track-and-option ground rather than today's bordered tile. The swatches themselves keep their job at 24 px and 8 px radius — this design's own figure, not today's 34 px strip at a 2 px corner (`client/src/styles.css:613`).

Two hand-balanced columns place the cards, the tall one anchoring a side rather than a masonry reflow, folding to one column under 1100 px — above the 700 px phone break every other split on this board uses.

The watchdog group keeps its four rows exactly as `WatchdogGroup.tsx` already writes them — Enabled, Check every, Leave a resumed run alone for, Give up after. What changes is the orientation row above them: today's `Live view` line is prose with no control (`WatchdogGroup.tsx:217`); here it becomes a real link, opening Runs › Watchdog through the same section setter the rail's sub-nav tree calls (§8.0) — a destination the rail can now actually name.

### 8.7 Overlays

Both shapes are the dashboard's own, chosen there after five drawings each (`../claude-agents-dashboard/.claude/DESIGN.md:355-444`) — this board adopts them rather than re-running the comparison.

**Sidecar modal.** `Modal` composes what was `ItemDrawer`'s panel into a modal with air around it — the item modal, and the only modal anywhere in this app: there is no run modal, and none is added here. `--scrim` covers everywhere the drawer used to reserve for desktop alone; the shell is `--strip` at 16 px radius carrying the design's one shell lift, `0 24px 64px` at `--shadow2`; inside it a 290 px facts column sits left of a body with a clean top edge. Max width 1080 px, `calc(100vw / var(--font-scale) - 48px)` below that, full-screen under 700 px with the facts column folding above the body instead of beside it — the dashboard's own sidecar geometry, untouched here because it was never sized for a run in the first place.

Facts: project dot plus name, id, section, created / updated / last commit, `groomed`, tags, `in progress since <started>` with its elapsed reading while a session holds the item, elapsed and token counters when present, the file path, the dispatch control. Body: the rendered Markdown at §8.1's scale — 15/400 body, 19/500 headings, code spans on `--steel`.

There is no second modal, and the reason is where the run's own reading already lives. Everything a run modal would have drawn is §8.4.1's detail sheet, always beside the list rather than behind a click — which is also why that sheet, and not a modal, is the one surface able to carry `RunControls` at all: a modal a reader opens and closes has no standing place to hold a Pause or a Resume across the length of a run the way an always-visible sheet does. Its contents stay §8.4.1's alone; this section names it only to say why `Modal` is composed by the one surface that needs opening and closing, the item, and not by two.

**Sheet.** `FormSheet` is `LaunchSheet` and `OrchestrateSheet`'s shell, both keeping every step and field they already have: scrim, air on every side, 620 px wide, the same shell lift as the sidecar modal, full-screen under 700 px. Controls are §8.6's 36 px family; the orchestrate sheet's three-step header is a 13/500 stepper on a hairline, and Start stays on the last step alone. The `uncommitted` chip renders as an 11/500 `--amber` pill, its two consequences — absent from `main` is skipped, present-but-edited is executed on `main`'s bytes — still spelled out in words rather than left to the pill's colour alone.

`useDialogEscape` (`client/src/hooks/useDialogEscape.ts`) is untouched in mechanism: one owner, a module-level LIFO stack, the topmost entry closes and nothing else. What changes is the count it ranks. Its own comment and the `invariants.md` entry it backs both name four dialogs today — `ItemDrawer`, `LaunchSheet`, `RunDrawer`, `OrchestrateSheet` — and under this redesign that drops to **three**: the item modal and these two sheets. `RunDrawer` does not hand its slot to a renamed surface; it leaves the stack outright, because its content is now §8.4.1's detail sheet, sitting inline on the Runs page beside the list rather than opening and closing as a dialog at all — there is nothing left there for Escape to close. The `invariants.md` entry for this rule is edited in place to name three, the same treatment §8.4.1 gives the other entries a deleted surface used to carry, rather than deleted itself: the rule survives every surface that has ever carried it.

### 8.8 Motion

Three places on this board move on their own, and one mechanism covers all three rather than three separate ones:

- The **run chip**'s `Dot` (§8.3) breathes a ring while any run is live — `Dot`'s own `breathe?` flag (the design spec's §12.2, per §8.2's one-home rule) rather than an animation local to `RunChip`, so any other live `Dot` on the board earns the same motion for free.
- The **stage track**'s current node (§8.4.3) pulses the 3 px ring already stated there as one of its four node states; this section is where its behaviour under reduced motion is decided, not where its look is drawn a second time.
- A **needs-you control** fades into place rather than snapping in: the crashed run's `Resume run` (§8.4.1's detail sheet head) and the Watchdog page's `Resume now` (§8.4.2) are gated by the one function, `watchdogStoodDown`, and mean the same thing wherever they appear — the sweeper has given up and a person is the only path left — so both arrive by fading into a slot the layout already reserves rather than shoving the row beside them.

All three are silenced under `prefers-reduced-motion: reduce` through the same pattern this codebase already uses, not a mechanism written new for this redesign: a blanket `@media (prefers-reduced-motion: reduce)` rule (`client/src/styles.css:631`) cuts every animation's duration to near zero and runs it once, which freezes it on its LAST keyframe rather than cancelling it — wrong whenever that last frame is not the element's resting state. Three elements already need the fix for exactly that reason: an explicit `animation: none` after the unconditional rule, in whichever reduced-motion block sits nearest it, carrying `!important` whenever that unconditional rule outranks it on specificity. `.board-card-stage-glyph` is the worked example (`:638`): its unconditional rule is `.board-card-stage .board-card-stage-glyph` (`:436`), two classes deep, so plain source order cannot win and the override needs the flag. `.watchdog-lamp-armed` needs it too, in its own block (`:1669`). `.run-track-dot-current` / `.run-track-node[data-in="live"]` need neither: each shares its selector with its own unconditional rule earlier in the same section, so source order alone settles it (`:2497-2499`). The run chip's breathing ring, the stage track's redrawn pulse and the needs-you fade will each want the same kind of explicit override, `!important` included only where the rule it corrects outranks it on specificity.
