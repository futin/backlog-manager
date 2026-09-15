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
| Page and card title | 19/500, −.01em, 1.3 | band titles, sheet titles, live run card project |
| Large metric | 30/700, −.02em, 1.1 | figure strip values |
| Row name | 15/500 | column header names |
| Card title | 14/500, 1.35 | item card title, history row project, stage track item title |
| Subtitle / hint | 13/400 | band subtitle, sheet subtitle, figure label, control label |
| Body, chip and button label | 13 (500 on buttons) | filter chips, controls |
| Meta / axis / caption | 12/400 | `id · date`, project name beside its dot, stage durations, table time column |
| Pill, badge, status | 11/500 | count pills, markers, mode pill, stage word on the live strip |

11 px is the floor beneath all of these; nothing on the board goes smaller.

Hanken Grotesk is the one face — self-hosted via `@fontsource/hanken-grotesk`, weights 400, 500, 600 and 700 imported in `client/src/main.tsx` — rather than linked the way the dashboard's own foundation links Google Fonts. That is the one place this section departs from the dashboard's: the served build's CSP is `default-src 'self'` with no `font-src`, `style-src` is pinned exactly by `test/csp.test.ts`, and the tailnet/phone use case this board is built for wants no third-party fetch at all.

`--mono` and `--display` are deleted from `theme.css`, not aliased to `--font` — an alias would let a stale `var(--mono)` left behind by the redesign keep quietly resolving to Plex. Deleting it means the same rule instead falls back to the inherited face, which is the failure this board wants to surface rather than hide. `code, kbd, samp, pre { font-family: inherit }` removes the UA's own monospace default for the same reason, so a code span is marked by its fill and ink alone, and `body` carries `font-variant-numeric: tabular-nums` so figures line up wherever they appear. `text-transform: uppercase` survives on `.rail-kicker` alone.

Three faces — Barlow, Barlow Condensed and IBM Plex Mono — leave behind 80 `--mono` uses, 14 `--display` uses and 31 `text-transform: uppercase` rules in `client/src/styles.css`; the same file has 124 of its 130 `font-size` declarations at 12.5 px or smaller, all of them now read off the scale above.

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

The four column dots read the design's category ramp left to right — refactors `--amber`, ideas `--mustard`, bugs `--red`, tasks `--green` — replacing today's magenta/mustard/red/cyan ticks. `--magenta` keeps no job on this screen once that tick is gone; it stays in the palette for the app that shares the same token vocabulary and still uses it.

The project-hue rule carries over unchanged: one 8 px dot, on the card and on the modal's facts column, never on text — the project name sits in `--ink2` beside it. The eight `--proj-N` sets are themselves untouched; the dot is applied by class, never a `style` attribute, so a theme swap recolours it for free.

The one-home rule for primitives (the design spec's §12.1) applies to every pattern this section draws that more than one surface uses: each is one component in `client/src/components/ui/`, owning one class family in `styles.css`, so two surfaces can never restate — or quietly disagree about — the same look. Until `docs/subsystems/board.md` carries this rule, as the spec's own §11 intends, the spec's §12 table is the pointer for which primitive owns which pattern.

### 8.3 Board

Cards in columns — `01-board-shape.html`, option A: today's kanban, redrawn at this scale, `BoardColumn` composing the column and `ItemCard` the card. Rejected: each column as one sheet with hairline rows (less height per item, but the header grows a subtitle and the card stops being a card), and one ledger grouped by type (the densest read, but it loses the four-column scan).

**The band.** `Band` carries the 19/500 title and a 13 px `--ink2` count line (`21 open across 3 projects`), then right-aligned a 36 px search field (12 px radius, `--hairline` stroke) and the filter chips — 32 px, 12 px radius, `--hairline2` stroke, 13/500 — as `Chip` (`variant: outline`). Orchestrate is the page's one ink chip (`variant: ink`, `--ink` fill, `--strip` text); its hide/disable rules are unchanged.

**The run chip.** `RunChip` replaces three things at once — the run strip that sat above the columns, `StartingStrip`, `RunDrawer` — because, in the user's own words when this was decided, "the board can show the issues, but the runs shows more info, no reason to keep it in both places." What stays on the Board is the card's own live strip and this one chip, which opens Runs.

Its `Dot` takes the worst state present: `--fill-progress` for live, `--fill-live` for paused or starting, `--red` for crashed. Beside it a 12/500 count line names every state present — `2 runs · 1 live ›`, `1 run · crashed ›`, `1 starting ›` are the three example readings. The precedence rule is exact: crashed over paused or starting over live. It renders the payload's `starting` array with no client-side filter, the same rule the strip it replaces followed. It is a `<button>` whose click calls the rail's own section setter, and it is absent entirely when the payload carries no run and no starting entry.

**Columns.** `repeat(4, minmax(0, 1fr))` at 16 px gaps: two columns under 1100 px, one under 700 px, the steps explicit rather than a fluid `auto-fit`. Each `BoardColumn` header is an 8 px ramp `Dot` (§8.2's four column hues), the name at 15/500, then a `Pill` (`tone: neutral`) sized 22×20 at 11/500 on `--strip-hi`, pushed right. No rule is drawn under the header — the cards' own ground gap is the only separation.

**The card.** `ItemCard` is `--strip`, 12 px radius, no stroke and no shadow. Hover changes only the cursor and nothing else — a card is a button by role (§5), and this design marks nothing by hover. Face padding is 14/16/12 with a 10 px internal gap.

- Title 14/500, 1.35, wraps.
- Foot row: an 8 px `Dot` in `--proj-N` plus the project name at 12/400 `--ink2`, ellipsised, then `id · date` at 12/400 `--ink3` pushed right, `flex: none`.
- Marker row, drawn whenever a marker applies or dispatch is available (below): `Marker` renders `groomed` in `--green`, `chore`/`debt` in `--ink3`, `done` in `--ink2`, `stale` in `--mustard`, all 11/500 — the same words, the same tokens, §7's size.
- The live strip: 24 px across the card's top edge, `--fill-live` with the `.hatch` utility (§8.2), 11/500 `--ink` text — the stage word left (`grooming`, `executing`, `in progress`, or an orchestrator stage through `needs-answers`/`parked`), the elapsed reading right. One fill covers both a hand session and an orchestrator stage; the word alone carries the distinction, and the second tone the strip used to switch between is gone, because this design marks state by ink, never by accent (§5).
- The dispatch chip: the same dispatch control, composing `Chip` at 28 px, sits at the right end of the marker row. It is **always drawn** whenever the environment allows dispatch at all — **never hover-revealed** — because a disabled control a user can click to re-ask its status (bug-13) has to be visible to be clicked, and this design marks nothing by hover. The marker row therefore renders whenever dispatch is available, markers or not; its three disabled blocks and the re-ask click are unchanged.

**What leaves.** `RunStrip.tsx`, `StartingStrip.tsx`, `RunDrawer.tsx` and their CSS. What stays: `useOrchestratorRuns` keeps polling while any run is `running`, fresh or not, and `runClaimBlock` / `runHoldsItem` keep the inputs they already take — the Board still needs both to draw the card's live strip and to block dispatch on a claimed item. The rules the departing components carried move to Runs; §8.4 is where they land.
