---
id: task-9
title: Pin orchestrator-active items to the top of their column with a run bar
created: 2026-09-01
from: idea-4
updated: 2026-09-01T17:39:30Z
started: 2026-09-01T17:19:18Z
execute-elapsed: 1212
---

## Goal

An item a *fresh* orchestrator run is currently working should read, at a
glance across a whole column, as live work — the same question
`.board-card-live-bar` already answers for hand-run items. Today it does not:
the board's only notion of "live" is `isInProgress`
(`client/src/lib/item-progress.ts:13`), derived from the item file's `started:`
key, and orchestrated work never stamps the file the board can see.

That blindness is confirmed, not assumed. `backlog-execute` runs inside the
per-item **git worktree** and stamps `started:`/`phase:` on the worktree's copy
of the item file; `orchestrate.mjs` reads it back from there too (`abort`'s own
attention message tells a human to run `backlog.mjs stop <id>` *in
`${item.worktree}`*, `skills/backlog-orchestrate/tools/orchestrate.mjs:1964`).
The main tree's copy — the one the registry points at, the server serves and
the board renders — stays unstamped for the whole run. After the merge lands
the item is in `done/`, so `isInProgress`'s `status === 'open'` half keeps it
inert; there is no false positive to clean up on the other side, only a blind
spot during.

The run payload the board already polls is the only source that knows, and
`BoardView` already reads it per card. So this is a client-only change: no
server route, no skill, no item-file key, and no new theme token.

Three outcomes:

1. An orchestrator-active card sorts to the top of its column, and a card the
   run is blocked on sorts above even that.
2. It carries a bar of its own, in the tone the board's colour legend already
   assigns to that meaning.
3. The Started status filter stops hiding exactly the items the orchestrator
   is working.

## Plan

**On literal code: there is deliberately none below, and none should be added
to this file.** The behaviour and the test cases are the authority here; the
implementer is expected to disagree with any shape suggested in prose if the
code reads better another way. Test *expectations* (exact strings, exact
orderings, exact fixture ids) are not in that category — those are pinned.

### 1. The tone is `--cyan`, and it already exists

idea-4 proposed a new palette entry across all five themes. That turned out to
be wrong, and the reason is worth stating because it is the whole design:
**the board's colour legend already has a token meaning "the orchestrator is
running without a human", and it is cyan.** `.board-card-stage`
(`client/src/styles.css:383`) carries the full argument in its own comment —
green is taken by `groomed`, amber means "a human is involved here", so the
six-stage chip was given cyan precisely because those stages are the
orchestrator working unattended.

So: **no `shared/theme.css` change at all.**

- Orchestrator running (`ACTIVE_RUN_STAGES`) → **cyan** bar, cyan card border.
- Orchestrator blocked on a person (`needs-answers`, `parked`) → **amber** bar,
  amber card border. Same legend, same reasoning `.board-card-stage-warn`
  (`styles.css:394`) already gives for the amber chip: a run waiting on an
  answer is a human's turn, not progress.
- Hand-run in-progress → **amber**, exactly as today. Unchanged.

Two tones of one bar, not two bars. The existing `.board-card-live-bar` rule
keeps every property it has; the cyan case is a modifier class that overrides
`background`/`color` only, so the padding, the `--card-pad-x` alignment, the
`--on-accent` ink pairing and the compact-density retune are inherited rather
than re-derived. Same for the card border: `.board-card-live` stays amber and a
sibling modifier recolours it.

### 2. Stage classification lives next to `ACTIVE_RUN_STAGES`

`ItemCard.tsx:25` already exports `ACTIVE_RUN_STAGES` and `RunDrawer` already
imports it from there, so that direction of dependency is established. Add a
second exported list beside it for the two attention stages
(`needs-answers`, `parked`), with the same "exported so a test asserts against
the list the component renders from" reasoning its neighbour carries. Both
`BoardView` (for the rank) and `ItemCard` (for the tone) read those two lists;
neither restates the strings.

`parked` earns a marker it does not have today — currently only
`needs-answers` chips. That is intentional: both mean the run stopped and is
waiting on a person, which is the one thing on this board worth surfacing
above running work.

### 3. The rank goes from two values to three

`inProgressRank` (`BoardView.tsx:84`) becomes a three-value rank, and
`sortItems` needs the run lookup passed in — it can no longer be a pure
function of the item alone. The composition stays exactly as it is today
(`rank(a) - rank(b) || compare(a, b)`), so the chosen sort still breaks every
tie and nothing else about ordering moves.

| Rank | Condition |
|---|---|
| 0 | fresh-run stage is an attention stage (`needs-answers`, `parked`) |
| 1 | fresh-run stage is in `ACTIVE_RUN_STAGES`, **or** `isInProgress(item)` |
| 2 | everything else |

Hand-run and orchestrator-run live work deliberately **tie** at rank 1: both
are "somebody is on this", and there is no reason to rank one above the other.
The active sort then orders them against each other as it always has.

### 4. Stale runs need no code — but do need a test

`runStageFor` is already built from `freshRuns`
(`BoardView.tsx:240,289-294`), which is `runs.filter((run) => run.fresh)`. A
run whose heartbeat has gone quiet therefore already contributes no stage to
any card, so the "unpin on stale" behaviour falls out for free and the pin
cannot outlive the run that justified it. **Do not add a second `fresh` check** —
add the regression test in §7 that pins the existing one in place, since
nothing today would catch a future refactor sourcing these from `runs`.

### 5. The elapsed reading, and its anchor

The bar's second half is the reading that cannot be guessed from its colour
(`styles.css:435`'s own comment). `RunQueueItem.stageAt`
(`shared/types.ts:373`) is a first-arrival timestamp per visited stage, which
gives the anchor:

- `stageAt.dispatched` when present — "how long the orchestrator has held this
  item", the direct analogue of `started:`.
- else `stageAt[<current stage>]` — which is what a `needs-answers` item needs,
  since its route (pending → preflight → needs-answers) never visits
  `dispatched` at all. Reads as "how long it has been waiting on you".
- neither present → render the words and drop the reading, exactly the rule the
  existing bar already applies to an unageable `started` (`ItemCard.tsx:78`).
  Never print `NaN`.

`stageAt` keeps only first arrivals, so a `fixing` → `reviewing` loop does not
reset it. That is precisely why `dispatched` is the preferred anchor rather
than the current stage's own arrival, and it is worth a comment at the
derivation.

Reuse `elapsedSince` and the existing `now` prop — `ItemCard` stays a pure
function of its props, and the board keeps owning the one clock. `hasLive`
(`BoardView.tsx:226`), which gates `useNow`, must widen to include
orchestrator-active cards, or their reading freezes at first paint.

To reach `stageAt` the per-project map (`BoardView.tsx:289`) has to carry more
than the bare stage — the queue item, or a narrow `{ stage, stageAt }` record.
`runStageFor`'s callers change with it.

### 6. The bar replaces the footer chip that would repeat it

A card showing a cyan bar reading `reviewing` must not also show a cyan footer
chip reading `reviewing` two lines below. When the bar renders for a run stage,
the footer chip for that same stage does not. Every other footer marker (kind,
groomed, done) is untouched — those are facts the file holds, not the volatile
run fact this bar now carries.

Precedence when more than one thing is true, top wins:

1. attention stage → amber bar, label is the stage
2. active stage → cyan bar, label is the stage
3. `isInProgress(item)` → amber bar, `progressLabel(item)`, unchanged
4. none → no bar

Run facts outrank the file marker (rows 1–2 over row 3) because the run payload
is re-polled every 5s while a file stamp can be arbitrarily stale — a leftover
hand-run `started:` must not mask a live run's own stage. In practice §Goal's
finding means the two rarely co-occur.

### 7. The Started filter

`matches` (`BoardView.tsx:212`) resolves the `started` status filter through
`isInProgress` alone, so today "Started" hides every item the orchestrator is
working — the opposite of what that view is for. It must match rank 0 and rank
1 items alike, i.e. the same predicate the rank uses.

Leave the out-of-scope ordering in that expression exactly as it is; its
comment explains why the `started` branch is tested before the out-of-scope
bypass, and that reasoning is unaffected.

### 8. Pre-flight note: three anchors above have moved since this was written

Added by backlog-orchestrate on 2026-09-01, immediately before dispatching
this item. Nothing about §Goal or the three outcomes changes; what changed is
the code some of the instructions above point at. task-4, task-5 and task-6
merged earlier in **this same run**, so the plan was written against a `main`
that no longer exists. Verified against the worktree you are working in, not
assumed:

- **§7's premise is gone.** The out-of-scope *bypass* in `matches`, and the
  ordering rule that put the `'started'` branch in front of it, were both
  deleted by task-4 — out-of-scope no longer renders on the Board at all, so
  the predicate now reads `i.section !== 'out-of-scope' && (status ===
  'started' ? isInProgress(i) : …)`, with a comment explaining the removal.
  §7's actual requirement is unchanged and still the point: the `started`
  filter must match rank 0 and rank 1 items, not `isInProgress` alone. Its
  closing sentence about leaving the out-of-scope ordering alone is simply
  moot — there is no ordering left to disturb. Do not try to restore it.
- **Test case 11 survives in a different shape.** task-4 rewrote that guard to
  sweep all four status values rather than assert one, so "the existing
  assertion, re-run" means whatever that guard is now. Keep it green; do not
  reintroduce the older single-value version to match the words above.
- **Every line number above is stale**, in `BoardView.tsx`, `ItemCard.tsx` and
  `styles.css` alike — those three files were edited by all three merged
  items. The named symbols are all still there and still correct
  (`inProgressRank`, `sortItems`, `matches`, `hasLive`, `ACTIVE_RUN_STAGES`,
  `.board-card-live-bar`, `.board-card-stage`); find them by name.

Two things the plan asserts that are still exactly true, checked rather than
taken on trust: `shared/theme.css` still needs no change (cyan is already
there), and `test/fixtures/orchestrator-run.json` still carries `task-14`,
`task-21`, `bug-27` and `bug-14` with the `stageAt` values cited in the test
cases.

One consequence of task-5 worth knowing: `ItemCard` now also takes a `stale`
prop and renders a `stale` footer chip. It is unrelated to this work and §6's
"every other footer marker is untouched" covers it — leave it alone.

## Test cases

`test/fixtures/orchestrator-run.json` already has everything needed and should
not be edited: `task-14` is `reviewing` (active, `stageAt.dispatched`
`2026-08-31T09:32:40Z`), `task-21` is `needs-answers` (attention, **no**
`dispatched` key — `stageAt['needs-answers']` is `2026-08-31T09:00:42Z`),
`bug-27` is `pending`, `bug-14` is `merged`.

Run-driven cases go in `test/orchestrator-strip.test.tsx`, which already owns
the `runPayload()` helper and the runs-fetch mock; file-derived sorting cases
stay in `test/board.test.tsx` beside the existing `.board-card-live` assertions
(`board.test.tsx:216-236`). Extract the mock to `test/helpers/` only if both
files genuinely need it — do not move it pre-emptively.

Pure-function cases (rank, tone/label/anchor derivation) should be unit tests
against the exported helpers, not render tests, wherever the implementation
leaves something exported to test.

1. **Active card gets a cyan bar.** `task-14` in a fresh run renders a
   `.board-card-live-bar` whose text contains `reviewing`, carrying the cyan
   modifier class; the card carries the cyan border modifier.
2. **Active card's elapsed anchors on `dispatched`.** With `now` pinned to a
   fixed instant, `task-14`'s `.board-card-live-mark` reads the elapsed since
   `2026-08-31T09:32:40Z`, **not** since its `reviewing` arrival
   (`09:36:40Z`). Assert the exact rendered string.
3. **Attention card gets an amber bar.** `task-21` renders a bar reading
   `needs-answers` with the amber (default) tone and no cyan modifier, and its
   elapsed anchors on `2026-08-31T09:00:42Z` — proving the fallback anchor
   fires when `stageAt.dispatched` is absent.
4. **`parked` is treated as attention.** Override a queue entry to `parked`:
   amber bar, and it sorts to rank 0 (case 7).
5. **Neither stage type renders a bar.** `bug-27` (`pending`) and `bug-14`
   (`merged`) render no `.board-card-live-bar` and no cyan border, and keep
   whatever footer markers they have today.
6. **The chip does not repeat the bar.** A card showing the run bar for
   `reviewing` contains exactly one occurrence of that stage string. The
   `groomed`/`done`/`kind` footer markers on the same card still render.
7. **Ordering.** In one column containing an attention item, an active item, a
   hand-run `isInProgress` item and two idle items, the rendered card order is:
   attention, then the active and hand-run pair (ordered between themselves by
   the active sort), then the idle two by the active sort. Assert against the
   `.board-col-cards` children in order, under the default `created` sort.
8. **A stale run pins nothing.** The same payload with `fresh: false` renders
   no bar on any card and leaves the column in pure sort order — the §4
   regression test.
9. **`fresh: false` still leaves the drawer intact.** Existing behaviour; the
   stale run must remain openable from the strip. Guards against "fix" that
   filters stale runs out of `runs` itself rather than at `freshRuns`.
10. **Started filter shows orchestrated work.** With the status filter on
    `started` and no item file carrying `started:`, `task-14` and `task-21` are
    visible; `bug-27` and `bug-14` are not.
11. **Started filter still hides out-of-scope.** The existing assertion, re-run
    — the reordering in §7 must not disturb the branch ordering in `matches`.
12. **Hand-run cards are untouched.** Every existing `.board-card-live`
    assertion in `board.test.tsx` (216-236, 295-365) passes unchanged, with no
    edits to those tests. If one needs editing, the change went too far.
13. **No theme regression.** `shared/theme.css` is not modified;
    `test/csp.test.ts` and the existing style tests stay green.

## Done when

- `pnpm test` passes, including all 13 cases above.
- `pnpm run typecheck` passes.
- `pnpm run build` passes.
- A card in a fresh run reads as live from across the column, in all five
  themes, without a new palette token being added to `shared/theme.css`.
- `git diff --stat` touches only `client/src/components/board/BoardView.tsx`,
  `client/src/components/board/ItemCard.tsx`, `client/src/styles.css` and test
  files. Anything outside that set — a server route, a skill, `shared/types.ts`,
  `shared/theme.css` — means the design drifted and should be re-read against
  §1 before going further.

## Outcome

2026-09-01 — done, client-only, exactly as §1 required: no new palette token,
no server route, no skill, no item-file key, and `shared/theme.css` untouched.

What landed:

- **`ItemCard.tsx`** — `ATTENTION_RUN_STAGES` (`needs-answers`, `parked`) beside
  `ACTIVE_RUN_STAGES`, plus `RunCardState` (`Pick<RunQueueItem, 'stage' |
  'stageAt'>`) and an exported pure `liveBarFor(item, run)` returning
  `{ label, tone: 'run' | 'human', anchor, title }` or null. That function is the
  one place §6's precedence lives (attention → active → `isInProgress` → none),
  so the card class and the bar class cannot disagree. The `runStage` prop became
  `run` — one prop, not two, because the stage and its stamps are two halves of
  one volatile fact.
- **The footer chip is gone, not re-toned.** Its condition was the six active
  stages plus `needs-answers`; every one of those seven now renders the bar
  instead, so a "unless the bar already said it" guard would have been a branch
  that provably cannot fire. `lib/run-stage.ts` and every `.board-card-stage*`
  rule stayed exactly as they were — RunDrawer chips all fourteen stages and is
  now their only caller.
- **`BoardView.tsx`** — `inProgressRank` → `liveRank(item, stage)`, three values;
  `sortItems` takes the stage lookup. The `< 2` half of that same rank is now the
  Status filter's `started` predicate AND the `hasLive` clock gate, so the order,
  the filter and the ticking cannot drift apart. `freshRuns` and the per-project
  map were hoisted above `matches` (the filter needs them), and the map now
  carries `{ stage, stageAt }` rather than the bare stage.
- **`styles.css`** — `.board-card-live-run { border-color: var(--cyan) }` and
  `.board-card-live-bar-run { background: var(--cyan) }`. Two declarations, both
  colours: the base rule keeps the padding, the `--card-pad-x` alignment, the
  `--on-accent` pairing and the compact-density retune.

Two deviations from the plan, both deliberate:

1. **Test case 2's literal stamps are pinned in a UNIT case, not a render.** An
   elapsed computed off the fixture's literal `2026-08-31T09:32:40Z` reads `1d`
   today and `2d` tomorrow — board.test.tsx's own header comment forbids exactly
   that. So `liveBarFor` is asserted directly against both fixture stamps
   (`anchor: '2026-08-31T09:32:40Z'` for task-14, `'2026-08-31T09:00:42Z'` for
   task-21), and the *rendered* string is pinned in a second case with relative
   stamps: `dispatched` 3h ago and `reviewing` 5m ago, asserting `3h` present and
   `5m` absent. Same claim, stronger, and it cannot rot.
2. **`RunStrip.tsx` is in the diff** — two comment lines, no code. It named
   `ItemCard`'s `runStage` prop, which this task renamed; leaving the stale
   pointer was worse than the extra file in `git diff --stat`. Nothing outside
   the plan's four-file set changed in any executable way.

Case 13 got a test rather than only a manual check: `test/live-bar-style.test.ts`
pins the cyan modifier, pins that it declares *nothing but* `background` (so the
tuned base values stay inherited), pins that the base bar and border are still
amber, and reads `shared/theme.css` to assert `--cyan` is declared in all five
palettes with no run/orch/live token added. The one claim from "Done when" that
is verified structurally rather than visually: no screenshot of the five themes
was taken — the proof is that the tone spends `var(--cyan)`, which every palette
defines, paired with `--on-accent` exactly as `.dispatch-chip.execute:hover`
already does.

Red-green, run rather than assumed: with `liveRank` reverted to its two-value
form and the anchor changed to `stageAt[stage]`, five of the new cases failed
(`anchors the bar on stageAt.dispatched`, `reads the elapsed since dispatch`,
`treats parked as attention`, `orders a column attention-first`, `shows
orchestrated work under the In progress filter`); restoring both brought all 24
back green.

### Verification

```
$ pnpm test
Test Suites: 42 passed, 42 total
Tests:       650 passed, 650 total
Snapshots:   0 total
Time:        24.881 s, estimated 34 s
Ran all test suites.

$ pnpm run typecheck
typecheck exit: 0

$ pnpm run build
build exit: 0
```

board.test.tsx was not edited at all — cases 11 and 12 are its existing
assertions, still green.

```
$ git status --short
 M backlog/tasks/open/task-9-....md
 M client/src/components/board/BoardView.tsx
 M client/src/components/board/ItemCard.tsx
 M client/src/components/board/RunStrip.tsx
 M client/src/styles.css
 M test/orchestrator-strip.test.tsx
?? test/live-bar-style.test.ts
```

One thing worth knowing for later, found and left alone on purpose: `isStale`
reads the item FILE, so a long-untouched open **bug** an orchestrator has just
picked up still leaves the Board for Archive while the run works it. Fixing that
would put a third reader on these stage lists and change what ArchiveView shows —
a different decision from this one, and out of §Done-when's file set. It is
recorded in `hasLive`'s own comment in BoardView.tsx.
