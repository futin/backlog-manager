# Queued card strip — plan

**Goal.** A tracker card carrying `orchestrator:queued` shows it as a 24 px band across the card's top edge, where the live strip goes, instead of as a plain
`queued` word in the marker row. The band is neutral, not amber: amber-hatched means "somebody is on this right now", and `orchestrator:queued` is a plan,
never a claim (invariants.md, "`orchestrator:queued` is a plan, never a claim").

**Decided with the user (2026-09-29).**

- Look (REVISED after the first live check, same day): the `--strip-hi` fill below vanished on daylight (#f2f2f1 on a #ffffff card). The user picked an
  inverted ink band from four prototypes on the live page: fill `--ink2`, text `--strip`; stale steps back to `--hairline2` under `--ink2`, because white on
  daylight's `--ink3` is 2.6:1. Cases 13 and 15 follow. The original pick, kept for the record —
- Look: neutral band. Same geometry as `.board-card-live` (24 px, `0 var(--card-pad-x)` padding, 11/500), fill `--strip-hi` (the one-step-lighter surface
  every palette declares), ink `--ink2`, no `.hatch`.
- Stale: also a band, reading `queued · stale` in `--ink3`, carrying the existing title (no live run holds it — remove the label on GitHub, or stop the crashed
  run if it is this machine's).
- A claim wins. When someone claims the item the driver/claim removes the label, and the card's state becomes `grooming`/`executing` on the live strip. Until
  the tracker cache catches up both facts can be true at once for one poll; the live strip must win then.

**This plan gives behaviour and test cases, not literal code** — any snippet here is illustrative, and the implementer may disagree with it.

## Design

### The queued strip is a sibling of the live strip, not a row of `liveBarFor`

`liveRank` (`client/src/components/board/BoardView.tsx:104-134`) states that its `< 2` half is exactly the set of cards `liveBarFor` draws a bar for, and that
half has three readers: the column rank, the Status filter's "In progress", and the board clock (`hasLive`). Folding `queued` into `liveBarFor` would either
break that equivalence silently or drag queued cards to the top of their column and into "In progress" — both wrong, since nobody is on a queued item.

So:

- `liveBarFor` is untouched.
- A new pure, exported function in `ItemCard.tsx` — call it `queuedStripFor(queued, bar)` — returns the strip's word, state and optional title, or `null`.
  It returns `null` whenever `bar !== null` (the live strip outranks it: run stage, then a hand/claim session, then queued) and whenever `queued` is
  absent/`null`.
- `ItemCard` renders the live strip if there is one, else the queued strip if there is one — never both. The queued strip is its own element
  (`.board-card-queued`, with `data-state="live" | "stale"`), outside `.board-card-face` for the same reason the live strip is.
- The right half of the band is empty: the label carries no timestamp to age.
- `liveRank`, the "In progress" filter and `hasLive` do not change. Add one sentence to `liveRank`'s comment noting the queued strip is deliberately outside
  that set.

### The markers leave

- The two queued entries leave `ItemCard`'s `markers` list.
- `'queued'` and `'queued-stale'` leave `MarkerTone` (`client/src/components/ui/Marker.tsx`), and the `title` prop's comment there stops citing the queued
  marker as its reason. Check whether any other marker still passes `title`; if none does, keep the prop anyway (it is generic) but reword the comment.
- `.ui-marker-queued` / `.ui-marker-queued-stale` leave `styles.css`; the new `.board-card-queued` rule (plus its stale modifier on `data-state`) takes the
  comment block's reasoning with it.

## Files touched

| File | Change |
| --- | --- |
| `client/src/components/board/ItemCard.tsx` | `queuedStripFor`, the strip element, queued markers removed, `queued` prop comment updated |
| `client/src/components/board/BoardView.tsx` | comment only, on `liveRank` |
| `client/src/components/ui/Marker.tsx` | two tones out, comment reworded |
| `client/src/styles.css` | `.board-card-queued` in, `.ui-marker-queued*` out |
| `.claude/DESIGN.md` §8.3 | marker-row bullet loses queued; new bullet for the queued strip (fill, ink, stale variant, precedence) |
| `docs/subsystems/board.md` | Marker table row (tones); the "fourth card reading, `queued`" paragraph describes the strip |
| `docs/subsystems/invariants.md` §"plan, never a claim" | the `queued · stale` sentence: "draws a dimmed strip" instead of a badge (one clause) |
| `test/tracker-board.test.tsx` | cases below |
| `test/live-bar-style.test.ts` (or a sibling `queued-strip-style.test.ts`) | stylesheet cases below |

## Test cases

### `queuedStripFor` (pure, no render — put beside the other `liveBarFor` cases in `test/board-live-cards.test.tsx` or in `tracker-board.test.tsx`)

1. `('live', null)` → word `queued`, state `live`, no title.
2. `('stale', null)` → word `queued · stale`, state `stale`, title containing `no live run holds it` and `GitHub`.
3. `(null, null)` and `(undefined, null)` → `null`.
4. `('live', <any non-null LiveBar>)` and `('stale', <any non-null LiveBar>)` → `null`.

### Board render (`test/tracker-board.test.tsx`, the existing `the orchestrator:queued badge` describe, renamed to `… strip`)

5. Live run holds the project, item `queued: true` → the card has a `.board-card-queued` element with `data-state="live"` and text exactly `queued`; the card
   has no `.board-card-live`; the marker row (`data-testid="marker-row"`) does not contain the text `queued`.
6. Crashed run (`fresh: false`, `updatedAt` 20 min back) → `.board-card-queued` with `data-state="stale"`, text `queued · stale`, title as in case 2; no
   element with text exactly `queued`.
7. Remote-only live run → same as case 5 (keeps the BoardView wiring pin the current case has).
8. No label → no `.board-card-queued`.
9. **Claim beats the label (cache lag).** Item `queued: true` AND `started` set with `phase: 'execute'` (what the mapper yields for a claimed issue), live run
   on the project → `.board-card-live` reads `executing`; no `.board-card-queued`.
10. **Run stage beats the label.** Item `queued: true`, live run whose queue holds this item at stage `dispatched` → live strip reads `dispatched`; no queued
    strip.
11. **Pending is still queued.** Same, at stage `pending` → no live strip (pending draws none — existing rule), queued strip `data-state="live"`.
12. **Queued is not "in progress".** With the Status filter set to "In progress", a queued-only card (case 5's setup) is not rendered; and in the unfiltered
    column, a queued card does not sort above an idle card that the selected sort puts first (pin with two items whose sort order puts the unqueued one
    first).

### Stylesheet (`readStyles` / `ruleBlock` from `test/helpers/css-rule`)

13. `.board-card-queued` exists with `height: 24px`, `padding: 0 var(--card-pad-x)`, `background: var(--ink2)`, `color: var(--strip)` (revised; was `--strip-hi` / `--ink2`).
14. `.board-card-queued` contains neither `--fill-live` nor `gradient`.
15. The stale modifier (`.board-card-queued[data-state="stale"]`) sets `background: var(--hairline2)` and `color: var(--ink2)` (revised; was `color: var(--ink3)`).
16. `ruleBlocks(css, '.ui-marker-queued')` and `ruleBlocks(css, '.ui-marker-queued-stale')` are both `[]`.

Also check `test/design-guards.test.ts` and `test/claude-rules.test.ts` still pass after the DESIGN.md / docs edits (component header citation, rules
anchors).

## Verification

- `pnpm run typecheck` (catches any leftover `'queued'` MarkerTone use).
- `pnpm test` (both runners). The two WSL supertest-bind cases are a known environmental red on WSL only — this is macOS, so expect full green.
- Live check: the stack is up on this machine; screenshot a queued card in the daylight theme with the strip, and the same card once claimed.

## Out of scope

- Queue position on the band (`#2 of 5`) — the label says nothing about order, and a remote run's queue is not on this machine.
- Sorting queued cards above idle ones.
- The Runs page's `queued` figure and chips — unrelated reading of the same word.
