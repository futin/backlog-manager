# The tracker header strip — a shell-level chip for the connected tracker

Status: approved in brainstorming 2026-09-28, awaiting spec review. Ports the dashboard's `header-redesign` top strip (claude-agents-dashboard `0036d71`,
`docs/subsystems/account-header.md`) onto this board, and moves the tracker readings the band draws today (task-45, task-47, [the sync-interval
design](2026-09-22-tracker-sync-interval-design.md)) into it. Mocks and the approved direction: artifact `FEzyZXB5iH7orZL8P1NB3B` (v6).

## Why this exists

A connected tracker is a property of the machine, not of the section a person happens to be looking at: the token, the login, the hourly budget and the
poll clock are the same whether the Board, Runs, Archive or Settings is open. Today those readings live in one place, the Board band, as five plain
`polled 12s ago` spans — one per connected repo — that scroll away with the band, disappear on every other section, and say nothing about the budget or
about when the next sweep lands. The dashboard already solved the same problem for its account: what is true of the account wherever you stand moves
**out of the section and into the shell**, as one chip in a strip above every section. This design applies that rule to the tracker.

The strip also finishes a piece of §8.0 that never rendered: `.main` has carried a 24 px top margin and a 24 px top-left radius since the redesign, drawn so
the grey well would curve in where it meets the white rail — but `body` paints `--board` too, so the margin was grey on grey and the curve was invisible.
With a white strip above the well, the corner finally shows, and the rail and the strip form the one white L the mock draws.

## Non-goals

- **No ring, no spinner.** The poll clock is a line timer in the dashboard's own meter shape. A ring reads as "loading" and the board has no loading state
  to show here.
- **No per-section variant.** One chip, same readings on every section. The Board's project select does not filter it; the popover lists every connected
  repo.
- **No change to what the server polls or how often.** `TRACKER_POLL_MS` and the poller are untouched; the client learns the clock, it does not set it.
- **No change to `useBoard`'s own 15 s re-read.** The board's items poll stays a blind interval (task-45); aligning it to the poll clock is a separate item.
- **No item-level readings move.** The card badges (`untyped`, assignee, link-out, `queued`) and the item modal's body age stay where they are
  (`lib/tracker.ts` keeps `trackerLine`, `pollAge`, `accessReason`, `queuedReading`, `claimControl` unchanged).
- **No phone-width redesign.** Below 700 px the strip is not drawn; the chip takes the dashboard's phone answer and sits in the rail bar.

## 1. The strip

### 1.1 Layout

`App.tsx`'s shell becomes `.shell > .rail + .maincol`, where `.maincol` is a flex column (`flex: 1; min-width: 0`) painted `--strip` — the same paper the
rail is — holding two children:

- `.topstrip` — `height: var(--main-gap)`, `display: flex; align-items: center; justify-content: flex-end; padding: 0 var(--body-pad)`. Its only content is
  the tracker chip (§2), right-aligned. Empty when no tracker exists; it keeps its height either way so the well's top edge never moves.
- `.main` — unchanged in every way but one: `margin-top: 24px` becomes `margin-top: 0`. The `--board` well now begins exactly where the strip ends, and its
  existing 24 px top-left radius is drawn against the strip's white, which is what makes the curve visible.

`--main-gap` is a new token on `:root`, **50 px**, the same figure the dashboard uses, declared once and read in exactly three places: `.topstrip`'s height,
`.runs-board`'s height (`calc(100vh / var(--font-scale, 1) - var(--body-pad) * 2 - var(--main-gap))` — the Runs page fills the viewport and would
otherwise overflow by the strip's height), and the narrow override below. **The strip's height and the well's gap are one token** — the invariant this
design adds (§7).

`body` keeps `background: var(--board)`: below the fold and behind a short section the page is still the well's colour, which is what the rail's own
bottom edge expects.

### 1.2 Narrow (≤ 700 px)

`useNarrow`'s single tier already collapses the rail into `.rail-bar` (brand + ☰) and zeroes `.main`'s margin and radius. In the same media block:
`--main-gap: 0px` (so `.runs-board`'s calc is unchanged there), `.topstrip { display: none }`, and the chip renders in the rail bar instead — `SideRail`
gains an optional `chipSlot?: ReactNode` prop drawn between the brand and the ☰ button, and `App` passes the chip there when `narrow` is true, into
`.topstrip` when it is not. The chip is one element with one home at a time, chosen in JS from the same `useNarrow` reading the rail uses, never drawn
twice and hidden by CSS.

### 1.3 Theme

No new palette values. The strip is `--strip`, the chip's pill is transparent at rest and `--strip-hi` on hover/open, the meters use the three tones every
theme already declares (`--green`, `--amber`, `--red`), the popover is `--strip` with the dialogs' shadow. The daylight palette (design guard 5) is
untouched.

## 2. The chip

`components/TrackerChip.tsx`, header comment citing DESIGN §8.0. Rendered by `App` (not by any section), from the one `useTrackers` instance (§4).

### 2.1 Visibility

The chip is drawn iff `hasTracker(projects)` — at least one registered project resolves to a `github` source, **whatever its access state**. It renders
nothing (`null`) otherwise: no tracker, no chip, and the strip stays an empty 50 px band. A person with no tracker projects sees the layout change (the
strip, the curve) and nothing else.

### 2.2 Anatomy, left to right

A 36 px bare pill (`button`, `aria-haspopup="dialog"`, `aria-expanded`), the dashboard's `.acct` shape:

1. **Avatar** — 26 px circle, `--strip-hi` fill, the login's first letter uppercased. No image (the payload carries no avatar URL and this design does not
   add one). A 7 px **pip** overlaps its bottom-right corner in two states only: amber for `no-token`, red when any connected project's `access` is not
   `ok`. No pip is the reading for "all healthy".
2. **Login** — `platform.login`, 12.5 px / 600. Reads `no token` in the no-token state.
3. **`POLL` meter** — a `Meter` (§3) labelled `POLL`, value = seconds until the next sweep (`12s`), bar = fraction of the cycle elapsed since the newest
   `polledAt` across connected projects (`sweepProgress`, §5). Tones: green while filling; **full amber bar and the value `overdue`** once two cycles have
   passed with no poll; **full red bar** when *every* connected project is failing (no poll can succeed, so a countdown would be a lie); an empty bar and
   the value `…` before the first successful poll.
4. **`API` meter** — labelled `API`, value = used share of the hourly limit (`1.4%`, floored to `<1%` below one percent so the meter never claims zero use),
   bar = the same fraction, tone by the dashboard's ramp: green under 60 %, amber from 60 %, red from 90 %. Hidden while `limit` is `null` (the platform has
   not answered yet).
5. **Caret** — 11 px, rotates 180° while the popover is open.

In the **no-token** state (`platform.hasToken === false`) the chip keeps the avatar (drawn as `—`, amber pip) and the login slot (`no token`), and draws
neither meter — there is nothing to count down to and no budget to read.

### 2.3 Sizes that differ from the dashboard

The dashboard's meter labels are 9.5 px and its caret 9 px. This board's design guard 3 sets an **11 px floor** on every px font-size, so here the meter
label and the caret are 11 px and the meter widens from 52 px to 56 px to keep the value from wrapping. Everything else is the dashboard's figure: 36 px
pill, 26 px avatar, 12.5/600 name, 3.5 px bar.

### 2.4 Popover

Opens on click, anchored under the chip's right edge, **420 px** wide (the dashboard's 372 px cannot hold a repo name, a 120 px timer and a seconds column
without wrapping), `role="dialog"`, `aria-label="Tracker"`. Content, top to bottom:

- **Identity** — avatar, login, and one line `GitHub · N repos connected`, where N counts projects whose `source` is `github`.
- **One row per connected project**, in registry order: project name, its `repo` (`owner/name`) muted, then a 120 px line timer and the seconds left —
  `pollProgress(project.polledAt, now)`, the same reading the chip aggregates but per repo. A project whose `access` is not `ok` draws a **full red bar**
  and, in place of the seconds, `accessReason(project)` — the existing sentence, unchanged. A project with no `polledAt` yet draws an empty bar and
  `connecting…`. A row that is overdue draws the full amber bar and `overdue`, like the chip.
- **API** — a full-width bar and the line `N of M left · resets HH:MM` (`remaining` of `limit`, `reset` rendered in local time, `HH:MM`, 24-hour).
- **No footer, no links.** The mock's `Trackers / Settings` footer is dropped: the rail's sub-nav tree is the only thing that switches Settings' two pages
  (invariant), and a popover link would be exactly the in-page switch that rule forbids. The popover is read-only; the Settings card is one rail click away.

In the no-token state the rows and the API block are replaced by one paragraph: *No token on this machine. Put `BM_GITHUB_TOKEN` in `.env` and restart the
stack.* — the same fix `accessReason` already names, so the operator reads it once in the chip and once on the Settings card, never a third wording.

Dismissal: **click-outside** is the chip's own `pointerdown` listener on `document` (the dashboard's `useDismiss` bundles Escape with it and must not be
copied); **Escape** goes through `useDialogEscape(close)`, joined while the popover is open — exactly as `Confirm` does — so the one-owner LIFO stack
stays the only Escape listener in the client and a popover under an open sheet is never the thing that closes. Section changes close it too (the chip
outlives the section, the popover does not need to).

## 3. The `Meter` primitive

`components/ui/Meter.tsx`, base selector `.ui-meter`, declared once inside the delimited ui-primitives block of `styles.css` (design guard 7). The
dashboard's `.m`/`.mtop`/`.mini` triple, named for this board:

- Props: `label: string`, `value: string`, `fraction: number | null` (0–1, clamped; `null` draws the empty track), `tone?: 'green' | 'amber' | 'red'`
  (default green), `width?: number` (px, default 56). `aria-hidden` on the bar; the label and value are the accessible text.
- Draws: label (11 px, muted) over value (11 px, bold), and beneath them a 3.5 px track with a fill `width: fraction * 100%`. No transition on the fill —
  it advances once a second and a 1 s tween would smear the reading.

Two readers: the chip (two meters) and the popover (one per row, plus the API bar at full width). Nothing on the Board draws one.

## 4. One `useTrackers`, at the shell

`useTrackers` today fetches once and on window focus, and is called only by the Settings Trackers card. Two callers would mean two clocks, so:

- `App` calls it once and provides the result through a `TrackersContext`; the chip and `TrackersGroup` both read the context. `TrackersGroup` keeps its
  loading / error / empty branches unchanged — it only stops owning the fetch.
- The hook gains a **schedule**: after each successful response it sets one timer for `newest polledAt + TRACKER_CYCLE_MS + 500 ms` (the half-second
  covers the server's own two-request tick), falling back to `TRACKER_CYCLE_MS` from now when no project has a `polledAt`, and to `TRACKER_CYCLE_MS` after
  an error. One timer at a time, cleared on unmount and re-armed on every response; focus still refetches immediately. This is what makes the chip's bar
  reach the end and snap back rather than drift: the client asks right after the server has answered itself.
- The hook is armed only while `hasTracker(projects)` is true — `App` already has `projects` from `useBoard`; with no tracker project the hook fetches
  once (so Settings can say "none") and sets no timer.

`TRACKER_CYCLE_MS = 17_000` lives in `lib/tracker.ts` beside the derivations, with the comment that it is the server's `TRACKER_POLL_MS` (15 s) plus the
measured length of a tick, and matches `TRACKER_POLL_WINDOW_MS` in `orchestrate.mjs`. It is the one client-side home of the cycle; the bar's fraction, the
overdue threshold and the fetch schedule all read it.

The chip's clock is `useNow(true, 1_000)` inside `TrackerChip` — a 1 s tick is what a seconds readout needs, and it runs only while the chip is mounted,
which is only while a tracker exists. The Board's own `useNow(hasLive || tracked, tracked ? 5_000 : 60_000)` stays for the readings it still feeds; the
plan checks whether `tracked` still has a reader there once `trackerLines` is gone and drops it if not.

## 5. Derivations — `lib/tracker.ts`

Pure, `now` always passed in, beside `pollAge` and `accessReason`:

- `pollProgress(polledAt: string | null, now: number): { fraction: number; leftS: number; overdue: boolean } | null` — `null` for no stamp or an unparseable
  one; otherwise `elapsed = now - polledAt` (clamped at 0 for a future stamp, as `pollAge` does), `fraction = min(elapsed / TRACKER_CYCLE_MS, 1)`,
  `leftS = max(ceil((TRACKER_CYCLE_MS - elapsed) / 1000), 0)`, `overdue = elapsed >= 2 * TRACKER_CYCLE_MS`.
- `sweepProgress(projects: ProjectSummary[], now: number)` — `pollProgress` of the **newest** `polledAt` among `github` projects; `null` when none has one.
  The chip's tone is decided by the caller from `overdue` and from whether every `github` project's `access` is non-`ok`.
- `apiUsage(platform: TrackersPayload['platforms'][number]): { fraction: number; label: string; left: number; resetsAt: string } | null` — `null` while
  `limit` is `null`; `used = limit - remaining`, `fraction = used / limit`, `label` = `used / limit` as a percentage to one decimal, `<1%` under one percent,
  `resetsAt` = `reset` as local `HH:MM`. Tone is the caller's (`≥ 0.9` red, `≥ 0.6` amber).

`trackerLine` stays exported for the item modal and any future reader; the band was its only board caller and that call goes.

## 6. The Board band

`BoardView` stops computing `trackerLines` and drops the five `board-band-tracker` spans; `.board-band-tracker` and the dot/spacing rules that served it
leave `styles.css`. The band keeps its title, count, run chip and controls exactly as before. `test/tracker-board.test.tsx`'s "shows the poll age while
access is ok" flips to asserting the band draws **no** `tracker-line` for a connected project — the reading has one home now and it is not the band.

## 7. Docs, rules and guards

- **DESIGN.md §8.0** gains a "Shell strip" paragraph: the token, the L the rail and strip form, the curve it makes visible, the chip's anatomy and the
  11 px adjustments of §2.3. **§8.3**'s band list loses the tracker lines.
- **`docs/subsystems/board.md`** "A connected tracker" is rewritten around the chip: what it reads, from where, and the two homes (strip / rail bar); the
  band is no longer a surface a tracker adds readings to. The doc map's line for it follows.
- **New invariant**, headline in CLAUDE.md under `Invariants`, mechanism in `.claude/rules/board.md`, reasoning in `docs/subsystems/invariants.md`:
  **The strip's height and the well's gap are one token, `--main-gap`, read by the strip, the Runs page and the narrow override — never a px literal.**
  The mechanism bullet also records the Escape rule's new count: four dialogs on the stack plus `Confirm` and the tracker popover joining while drawn.
- **Design guard 9** in `test/design-guards.test.ts`: `--main-gap` is declared exactly once on `:root` and once in the narrow media block, nothing else
  declares it; `.main` carries no px `margin-top`; `.runs-board`'s height reads `var(--main-gap)`.
- **CLAUDE.md** `client/src/` line: "A connected tracker adds three readings and no new surface" becomes "adds one shell-level chip (strip, or rail bar
  below 700 px) and three item readings".
- `docs/subsystems/account-header.md` in the dashboard is the reference; this board's copy of that reasoning lives in board.md, not in a new file.

## 8. Testing

All jsdom / node, in `test/` (flat), under jest:

- `test/tracker-lib.test.ts` — `pollProgress`: mid-cycle fraction and seconds; `null` for no stamp and for garbage; future stamp reads `fraction 0`,
  `leftS 17`; exactly `2 × cycle` is overdue and `2 × cycle − 1 ms` is not; fraction clamps at 1 past the cycle. `sweepProgress`: picks the newest of three
  stamps, ignores `files` projects, `null` when no github project has polled. `apiUsage`: `null` for `limit: null`; `<1%` for 14 of 5000; `1.0%` for 50 of
  5000 (the floor's boundary); `1.4%` for 70 of 5000; `resetsAt` renders local `HH:MM`.
- `test/meter.test.tsx` — draws label and value as text; fill width is `fraction × 100 %`, clamped at both ends; `null` draws an empty track; tone class
  follows the prop.
- `test/tracker-chip.test.tsx` — renders nothing without a github project; draws login, `POLL` and `API` for a healthy payload; `overdue` at two cycles;
  red bar when every project fails, pip only when some fail; no-token draws `no token`, the amber pip and no meters; click opens the popover with one row
  per github project, a failing row carrying `accessReason`'s sentence, and no link or button inside it; pointerdown outside closes it; a section change
  closes it; **Escape closes the popover and not a sheet beneath it** (the stack test, mirroring the existing one for `Confirm`).
- `test/use-trackers.test.tsx` — one fetch on mount; the next is scheduled at `newest polledAt + cycle + 500 ms` (fake timers); an error re-arms at one
  cycle; no timer without a github project; unmount clears the timer; focus fetches immediately.
- `test/shell.test.tsx` (new, or the existing App smoke test) — the chip is in `.topstrip` at desktop width and in `.rail-bar` under `useNarrow`, never both.
- `test/tracker-board.test.tsx` — the band draws no tracker line (§6).
- `test/design-guards.test.ts` — guard 9 (§7); `test/claude-rules.test.ts` goes red until the new bullet, headline and anchor agree.
