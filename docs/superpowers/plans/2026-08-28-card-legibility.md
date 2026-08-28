# Card legibility: status bar, real timer, short id, created date

**Plan convention override.** This plan specifies *behaviour and exact test
cases*, never literal implementation code. Signatures, expected values and edge
cases are authoritative; anything that looks like code is illustrating a shape,
not text to transcribe. Disagree with the plan if the code says otherwise.

The size targets below are soft.

## Why

Four complaints about the board card, in the user's words:

1. The active card is not obviously active — a 3px amber inset down the left
   edge is too quiet to answer "which of these twelve is anyone on".
2. The timer is not visible enough — `◍ 3d` in 10.5px mono at the card's
   bottom-right, competing with an ellipsizing meta line.
3. The identifier reads as cut — the meta line is
   `nowrap; overflow: hidden; text-overflow: ellipsis` in ~118px, and
   `bug-1 · 2026-08-20 · groomed` does not fit, so the id/date pair clips.
4. The created date should be legible on the card, not only in the drawer.

Plus one decision taken during brainstorming: **the timer should read in
minutes and hours, not only days**, which means `started` becomes a full
timestamp rather than a date.

Chosen design: **B — status bar.** An active card carries a solid amber strip
across the top of its face reading `in progress` on the left and the elapsed
time on the right; the card's own border turns amber. The foot keeps the
project pill and gains room for `idea-3 · aug 20` now that the marker has left
it.

## Scope

Five layers, in dependency order:

- **The store** (`skills/backlog/tools/backlog.mjs`) — `start` writes a UTC
  timestamp; `stop` unchanged; both keep their byte-for-byte round-trip.
- **The server** — no code change. `scan.util.ts` already surfaces `started`
  verbatim as a string. Only the JSDoc in `shared/types.ts` changes.
- **The client library** — a new elapsed formatter and a created-date
  formatter, both pure, both injected with `now`.
- **The card and drawer** — design B, plus the short created date.
- **The docs** — the `started: YYYY-MM-DD` invariant in `CLAUDE.md`,
  `docs/invariants.md`, and the two SKILL.md mentions.

Out of scope: any change to how items are fetched, to the dispatch tab, to the
four columns, or to `created` on disk (it stays `YYYY-MM-DD`).

## Layer 1 — `started` becomes a timestamp

### Behaviour

`startItem` stamps **second-precision UTC ISO-8601 with a `Z` suffix**:
`2026-08-28T14:03:07Z`. No milliseconds — they are noise in a file a human
reads, and nothing needs sub-second resolution.

Everything else about `start`/`stop` holds: `start` still refuses a done,
out-of-scope, or idea item; still refuses an already-started item and names the
existing value in the message; `stop` still deletes the key and restores the
file byte-for-byte; both still round-trip unknown frontmatter keys and the body
unchanged.

**Backward compatibility is required, not optional.** Files already on disk
carry `started: 2026-08-26`. Nothing rewrites them, so every reader must accept
both shapes forever. A date-only value is aged at **day granularity only** (see
Layer 3) — it genuinely does not carry an hour, and reading "14h" off a bare
date would be inventing one.

`parseFrontmatter` needs no change: it splits on the *first* colon, so
`started: 2026-08-28T14:03:07Z` parses to key `started`, value
`2026-08-28T14:03:07Z`. Confirm this with a test rather than by inspection.

### Injection

`startItem(backlog, id, today = todayISO())` currently takes an injectable
`today`. Rename the parameter to `stamp` and have the default come from a new
`nowISO()` helper; `todayISO()` stays as-is for `new`'s `created`. Tests pass a
fixed stamp.

### Test cases (`skills/backlog/tools/backlog.test.mjs`, node test runner)

| Case | Expectation |
|---|---|
| `startItem` with an injected stamp | the file gains exactly one line, `started: 2026-08-28T14:03:07Z` |
| default stamp, no injection | the written value matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/` |
| CLI `start bug-7` | stdout is the item path; the file's `started:` line matches that same regex |
| `start` on an item whose `started` is date-only (`2026-08-26`) | refused, exit 1, message names `2026-08-26` |
| `stop` on an item with a timestamp value | `started:` line gone, file byte-identical to before `start` |
| `stop` on an item with a legacy date-only value | same — removal does not care about the shape |
| `parseFrontmatter` on a block containing `started: 2026-08-28T14:03:07Z` | `data.started === '2026-08-28T14:03:07Z'` |
| `renderFrontmatter` round-trip of that value | identical string back out |
| `board --json` for a started item | `started` is the timestamp verbatim |

The existing test at line ~850 asserts `^started: ${TODAY}$`. It is asserting
the old contract and must be rewritten, not deleted — the replacement is the
first two rows above.

## Layer 2 — types and server

No server logic changes. Update the `BacklogItem.started` JSDoc in
`shared/types.ts` to say: UTC ISO-8601 second-precision timestamp written by
`backlog.mjs start`, `''` when nobody has picked the item up, and **legacy
`YYYY-MM-DD` values are still valid on disk and must stay renderable**. Keep
the existing point that the value outlives the work and that "in progress" is
`started !== '' && status === 'open'`, decided in the client.

`test/items.test.ts` already asserts `started` is surfaced verbatim with a
date-only fixture. Add one case with a timestamp fixture asserting the same
verbatim passthrough, and keep the date-only case as the legacy guard.

## Layer 3 — the two formatters

Both live in `client/src/lib/item-age.ts` beside `daysSince`. Both are pure and
take `now` as a second parameter, matching the existing convention (tests inject
it; nothing freezes a global clock).

### `elapsedSince(started: string, now?: number): string | null`

Returns the string the card prints, or `null` when the value cannot be aged at
all. Parsing rules:

- `/^\d{4}-\d{2}-\d{2}$/` → parsed as `T00:00:00Z`, **day granularity only**.
- anything else → `Date.parse` as given; a `Z`-suffixed ISO timestamp parses
  natively. Full granularity.
- `NaN` result → `null`.

Formatting ladder, for a non-negative elapsed:

| Elapsed | Output | Notes |
|---|---|---|
| < 60s | `now` | the word, not `0m` |
| 60s – 59m59s | `Nm` | floored minutes |
| 1h – 23h59m | `Nh` | floored hours |
| ≥ 24h | `Nd` | floored days |

Day-granularity (date-only) inputs skip the ladder: same UTC day → `today`,
otherwise `Nd`.

A future value clamps to the bottom of the ladder rather than going negative —
`now` for a timestamp, `today` for a date-only value. Same rationale as
`daysSince`: a negative age reads as a bug in the board, and a future date only
happens in a hand-edited file.

`daysSince` stays exactly as it is. It is still the right function for the
drawer's day-level reads and is covered by tests that should not churn.

#### Test cases (`test/item-age.test.ts`, added to the existing file)

Timestamp inputs, `started = '2026-08-28T12:00:00Z'`:

| `now` | Expected |
|---|---|
| `2026-08-28T12:00:00Z` | `'now'` |
| `2026-08-28T12:00:59Z` | `'now'` |
| `2026-08-28T12:01:00Z` | `'1m'` |
| `2026-08-28T12:59:59Z` | `'59m'` |
| `2026-08-28T13:00:00Z` | `'1h'` |
| `2026-08-29T11:59:59Z` | `'23h'` |
| `2026-08-29T12:00:00Z` | `'1d'` |
| `2026-09-04T12:00:00Z` | `'7d'` |
| `2026-08-28T11:00:00Z` (past-future) | `'now'` |

Date-only inputs, `started = '2026-08-26'`:

| `now` | Expected |
|---|---|
| `2026-08-26T09:00:00Z` | `'today'` |
| `2026-08-26T23:59:59Z` | `'today'` |
| `2026-08-27T00:00:00Z` | `'1d'` |
| `2026-09-02T12:00:00Z` | `'7d'` |
| `2026-09-01T00:00:00Z` with `started = '2026-09-05'` | `'today'` |

Unparseable: `''`, `'soon'`, `'2026-13-45'`, `'2026-08-28T99:00:00Z'` → all
`null`.

### `formatCreated(created: string, now?: number): string`

The card's short date. Never returns `NaN`-anything.

| Input | `now` | Output |
|---|---|---|
| `'2026-08-20'` | 2026 | `'aug 20'` |
| `'2026-01-05'` | 2026 | `'jan 5'` |
| `'2025-12-31'` | 2026 | `"dec 31 '25"` |
| `'2027-03-01'` | 2026 | `"mar 1 '27"` |
| `''` | any | `''` |
| `'whenever'` | any | `'whenever'` (verbatim fallback) |
| `'2026-13-45'` | any | `'2026-13-45'` (verbatim fallback) |

Lowercase month abbreviations, no leading zero on the day, and the two-digit
year only when it differs from `now`'s year — the board is overwhelmingly
current-year items and a repeated `'26` on every card is noise. Months come
from a hardcoded twelve-entry array, not `toLocaleString`: the output must not
depend on the browser's locale, or two machines render different boards.

Parse as UTC (`T00:00:00Z`) for the same reason `daysSince` does.

## Layer 4 — the card

### Structure

The card is currently `.board-card` (flex row) → `.board-card-main` (flex
column, owns all padding) + the dispatch tab. The amber strip has to reach the
face's left and right edges, so the padding moves one level inward:

```
.board-card                     row, border, overflow hidden   (unchanged)
  .board-card-main              column, flex:1, min-width:0, NO padding
    .board-card-live-bar        only when in progress; full width of the face
      "in progress"             left
      .board-card-live-mark     right — the elapsed string
    .board-card-face            owns var(--card-pad) and var(--card-inner-gap)
      .board-card-title
      .board-card-foot
        .pill                   project
        .board-card-meta        `idea-3 · aug 20`
        markers                 groomed / done
  .dispatch-tab                 (unchanged)
```

The density block in `styles.css` needs **no** edit: it sets `--card-pad` and
`--card-inner-gap` as variables, and only the selector consuming them moves
from `.board-card-main` to `.board-card-face`. Update the comment on
`.board-card-main` that claims all padding and gap live in that one rule — it
will no longer be true, and the reason it was written (one place for the
density override) now points at `.board-card-face`.

The strip stops at the dispatch tab's seam rather than crossing it. That is
correct: the tab is the item's next step and keeps its own cyan/mustard
identity, which amber must not overwrite.

### Content

- **Live bar** renders only when `item.status === 'open' && item.started !== ''`
  — the existing two-condition rule, unchanged, and still decided in the client.
  Left label is the words `in progress`; right is `elapsedSince(item.started)`.
  When that returns `null` the bar still renders, with no elapsed text — a
  hand-edited `started` must not blank out the whole marker.
  `title` on the bar stays `in progress since ${item.started}` (verbatim value).
- **Foot meta** becomes `${item.id} · ${formatCreated(item.created)}`. When
  `created` is `''` the separator goes too — no dangling `bug-1 ·`.
- **Groomed / done markers** keep their current rules verbatim: groomed only on
  bugs and only when true, in green; done in dim ink. They stay inside the meta
  line, but the meta line must no longer be the only thing that can shrink —
  see below.
- The card no longer prints the elapsed time in the foot at all.

### CSS

- `.board-card-live` changes from `inset 3px 0 0 var(--amber)` to an amber
  **border colour** on the card, keeping the `inset 0 1px 0 var(--edge)` top
  highlight. The class name stays so existing "is this card live" assertions
  keep working.
- `.board-card-live-bar`: solid `var(--amber)` background, dark ink from the
  theme for the text on it (whatever the theme already uses on amber fills —
  do not invent a hex), mono, ~10px, uppercase-ish letterspacing consistent
  with `.pill`, `display: flex; justify-content: space-between`, small
  horizontal padding matching the face's inline padding so the label lines up
  with the title below it.
- `.board-card-live-mark` keeps its name but is now the bar's right-hand child:
  inherits the bar's colour rather than painting amber ink, `flex: none`,
  `white-space: nowrap`.
- `.board-card-meta` keeps `nowrap` + ellipsis (it is still the yielding
  element), but with the marker gone from the foot it now has the full width
  the pill leaves, which is what fixes the "id is cut" complaint. Verify at the
  real column width that `idea-3 · aug 20` plus ` · groomed` fits; if it does
  not, the groomed marker becomes an unshrinkable sibling of the meta line the
  same way the live mark used to be — do not let it re-introduce clipping.

Every colour is a theme variable. No new palette entries; if a theme lacks an
"ink on amber" token, add one to all five palettes in `shared/theme.css` rather
than hardcoding.

### The clock has to tick

Elapsed in minutes is stale the moment it renders. Items are fetched on mount
and on window focus (`useBoard`), which is not enough for a minute-granularity
label.

Add `client/src/hooks/useNow.ts`: `useNow(enabled: boolean, periodMs = 60_000)`
returns a `number` that updates on that period and **only while `enabled`**,
clearing its interval otherwise. `BoardView` passes `enabled` = "at least one
rendered item is in progress", so a board with nothing live installs no timer.
Thread the value into the cards as an explicit `now` prop rather than letting
each card call `Date.now()` — cards must stay pure functions of their props so
the tests can pin the clock without faking timers.

#### Test cases

`test/item-age.test.ts` covers the formatters (above). Card tests go in
`test/board.test.tsx`, which already has jsdom set up and fixtures at the top.
Two existing cases assert the old design and must be rewritten:

- "marks an in-progress card with the live class and an aged marker in the foot"
  → the marker is no longer in the foot. Replacement: the live card keeps
  `.board-card-live`; it contains a `.board-card-live-bar`; the bar contains the
  text `in progress` and a `.board-card-live-mark` whose text is the expected
  elapsed for the injected `now`; and `.board-card-foot` contains no
  `.board-card-live-mark`.
- The idle-card counterpart keeps asserting no `.board-card-live` and adds: no
  `.board-card-live-bar` anywhere in the card.

New cases:

| Case | Expectation |
|---|---|
| live card with `started` 3 hours before the injected `now` | mark reads `3h` |
| live card with `started` 20 minutes before `now` | mark reads `20m` |
| live card with a legacy date-only `started`, yesterday | mark reads `1d` |
| live card with `started: 'soon'` | the bar renders, `in progress` present, mark empty or absent — never `NaN` |
| any card | meta line reads `<id> · <short created>`, e.g. `bug-1 · aug 20` |
| card whose `created` is `''` | meta line is just the id, no trailing separator |
| done item that still carries `started` | no `.board-card-live`, no live bar |
| board with no in-progress item | no live bar rendered anywhere |

Fixtures currently use `created: '2026-08-20'` and `started: '2026-08-24'`;
extend `fakeItem` where needed rather than rewriting the fixture block.

`useNow` gets its own suite (`test/use-now.test.ts`) asserting: disabled →
no interval installed and the value never changes; enabled → the value advances
after the period; unmount → interval cleared. Jest's fake timers are appropriate
here and only here — this hook *is* the clock.

## Layer 5 — the drawer

The drawer has room for the truth, so it prints both: the elapsed and the raw
stored value. Current text is
`· ◍ in progress since ${item.started}`; it becomes
`· ◍ in progress ${elapsed} (since ${item.started})`, with the parenthetical
dropped and only `in progress` shown when `elapsedSince` returns `null`. Same
gate as today (`status === 'open' && started !== ''`), so an archived item still
reads as done.

`test/drawer.test.tsx` already renders an item with `started: '2026-08-24'` and
asserts the "in progress since" text; update it to the new string and add one
timestamp case.

## Layer 6 — the docs

- `CLAUDE.md`: the invariant currently reads "`started: YYYY-MM-DD` is the one
  lifecycle key allowed in frontmatter, and it is not a status". Rewrite the
  shape (UTC ISO-8601 timestamp, second precision, legacy date-only values
  still valid on disk) and keep every other clause word-for-word — the
  `status:` ban, the round-trip requirement, and "in progress is decided in the
  client" are all untouched by this change.
- `docs/invariants.md`: the same edit in the long-form entry, plus a sentence on
  why the timestamp: minutes and hours are the useful resolution for a session
  someone started this morning, and a date cannot carry them.
- `skills/backlog/SKILL.md` line ~50 and `skills/backlog-execute/SKILL.md`
  line ~149 both call `started` "the date" — reword to "the timestamp".
- **`skills/` changes ship only through git.** Editing the tool changes nothing
  installed until the work is committed, pushed, and `pnpm run plugin:sync`
  runs. The plan does not run that — it is the user's call after review.

## Order of work

Each step is red → green before the next starts.

1. `elapsedSince` + `formatCreated` with the full table above. Pure, no
   dependencies, and everything downstream reads more clearly once they exist.
2. `backlog.mjs` `nowISO` + `startItem` stamp, with the store test cases.
3. `useNow`.
4. The card: CSS restructure and `ItemCard`, with the rewritten board tests.
5. The drawer.
6. Types JSDoc, `items.test.ts` timestamp case, and the four doc edits.

## Verification

- `pnpm test` — full jest run, all green, output pristine.
- `pnpm run test:skills` — node runner over `skills/*/tools/*.test.mjs`.
- `pnpm run typecheck`.
- `pnpm run dev` + `pnpm run dev:web`, then look at the real board: an active
  card in each of the five themes, at both densities, and at the narrow
  breakpoint where columns stack. The complaint being fixed is a visual one, so
  a green test suite is necessary and not sufficient.
- Confirm a legacy date-only `started` still renders (the repo's own backlog or
  a hand-written fixture file).

No commit, no push, no `plugin:sync` without the user asking.
