---
id: bug-15
title: An aborted run's stalled item still reads as live in the Runs pane
created: 2026-09-02
updated: 2026-09-03T13:49:00Z
groom-elapsed: 423
started: 2026-09-03T13:21:12Z
execute-elapsed: 1668
---

## Symptom

Open an aborted run in the Runs detail pane. Its in-flight item — the one the
run died on, frozen at a non-terminal stage — presents as if work were still
happening on it, in two places at once:

- **`RowTime`** prints `<work> elapsed` measured to `now`, so a run aborted a
  day ago shows something like `30h 05m elapsed` for that row.
- **`StageTrack`** renders that item's current stage as a `run-track-dot-current`
  — the cyan dot with the pulsing ring, the app's "this is happening right now"
  signal.

Observed live on `run-20260901-112035` (`aborted`, `bug-2` frozen at
`dispatched`).

## Repro

1. Runs tab → pick any run whose status chip reads `aborted` (or `failed`) and
   whose queue still holds an item at a non-terminal stage.
2. The item's right-margin time keeps counting up; its current node pulses.

## Affects

- `client/src/lib/run-time.ts` — `itemDurationMs` (falls back to `now` while an
  item has not reached a terminal stage) and `stepperDots` (derives dot state
  from the item alone, with no notion of run status).
- `client/src/components/board/RunRowTime.tsx` — `RowTime`, shared by the
  drawer and the pane.
- `client/src/components/runs/StageTrack.tsx` — renders `stepperDots`' output.

- `client/src/components/board/RunDrawer.tsx` — `RowStageCaption`, which
  prints the same `inStageMs` reading under the literal word "now"
  (found during grooming; not in the original capture).
- `client/src/lib/run-time.ts` — `runElapsedMs` (line 179) is the one reading
  in the family that already forks correctly, on `status === 'running' &&
  fresh`; it is the pattern, not a defect.

## Cause

**One clock, handed out twice with two different meanings.** Every derivation
involved already takes `now` as a parameter — that is the runs-view lib rule,
stated in both `run-time.ts` and `run-stats.ts` headers. The defect is not
that these functions call the wall clock behind the caller's back; it is that
the **callers hand them the wall clock for a run that cannot prove the wall
clock**. `RunDetail.tsx` computes one `now` per render (`useNow`, line 195)
and passes that same instant to the run-level reading, which forks on run
status, *and* to the item-level readings, which do not.

The result is a screen that contradicts itself. Verified against the real run
this bug was filed from, `~/.backlog-manager/orchestrator/<project>/runs/run-20260901-112035.json`:

| field | value |
|---|---|
| `status` | `aborted` |
| `startedAt` | `2026-09-01T11:20:35.499Z` |
| `updatedAt` | `2026-09-01T11:28:10.999Z` |
| bug-2 `stage` | `dispatched` |
| bug-2 `stageAt` | `pending` 11:20:35.499, `preflight` 11:20:46.414, `dispatched` 11:21:05.935 |

`runWallMs` (`run-stats.ts:185`) forks on `status === 'running'`, so this run
takes its other branch and correctly reports `updatedAt − startedAt` = **7m
35s** in the pane header. `RowTime` on the bug-2 row directly beneath it
reports `now − preflight`, which was **~32h** when this was groomed and grows
every time the pane renders. The header and the row on the same screen disagree
by a factor of ~250 and widening, and the row is the one that is wrong: **no item's reading can honestly exceed its own run's wall
time**, and nothing in the code enforces that.

Four surfaces, not the two the capture named — all four keyed on the same
missing fork:

1. **`RowTime`** (`RunRowTime.tsx:88`) — `itemDurationMs(item, now)` returns
   `now − startedAtMs(item)` for any non-terminal stage, unbounded.
2. **`stepperDots`** (`run-time.ts:364`) — `state: 'current'` is set from
   `stage === item.stage && !isTerminalStage(stage)`, so the death stage wears
   `run-track-dot-current`: cyan fill plus the `run-track-ring` pulse
   (`styles.css:1688`), the app's one "happening right now" signal.
3. **`trackValue`** (`StageTrack.tsx:123`) — the `current` branch prints
   `inStageMs(item, now)` under that node, so the same unbounded number renders
   a second time; and `segmentState` maps a `current` dot to `data-in="live"`,
   which animates the `run-track-sweep` gradient into it (`styles.css:1665`).
4. **`RowStageCaption`** (`RunDrawer.tsx:158`, drawer only) — prints
   `now dispatched · 32h 05m in stage`. The bluntest of the four: the word
   "now" is asserted in prose about an item nothing is touching.

Two facts that narrow the fix, both confirmed rather than assumed:

- **The affected set is exactly `RUN_CLAIMED_STAGES` minus `pending`** —
  `preflight`…`merging` for `RowTime` and the caption (7 stages), and
  `dispatched`…`merging` for the dots (6, since `STEPPER_STAGES` starts at
  `dispatched`). `pending` is short-circuited by `RowTime`'s em-dash branch and
  is not a stepper stage; `parked` and `needs-answers` are *terminal* to
  `isTerminalStage` (they are absent from `RUN_CLAIMED_STAGES`), so they never
  reach any of these branches. A `done` run's items are all terminal, so the
  clamp can only ever bite on the genuinely broken case.
- **`fresh` on the live payload is `status === 'running' && heartbeat recent`**
  (`orchestrator.service.ts:209`), so an aborted run is `fresh: false` the
  instant it aborts. `mergeRuns` filters `live` on that flag
  (`RunsView.tsx:174`), so an aborted run is never live-backed, `useNow(false)`
  installs no interval, and the numbers do **not** tick per second — they jump
  forward on every remount, poll re-render and window-focus refetch. Less
  visible than a ticking clock, equally wrong.

**Same defect class, one rung up: a crashed `running` run.** `orchestrate.mjs
init` refuses to overwrite a `status: "running"` file, so a dead orchestrator
leaves one forever (this repo's "One run per project, checked twice"
invariant), and `status` alone never says the process is gone. The
runs-view-redesign branch already fixed this for `runStageTotals` (commit
d7fd41a, its own "FIX ROUND 2" paragraph) by deriving freshness from
`updatedAt` against `RUN_STALE_MS` instead of trusting `status`; **bug-14** is
the same fix still owed to `runWallMs`.

**Boundary with bug-14, stated so neither fix reaches into the other.** bug-14
is `runWallMs` and `running`-only — it says so itself, and it is right: an
`aborted` or `failed` run already takes `runWallMs`' `updatedAt − startedAt`
branch, which is why the header in the table above is the honest half of this
screen. This bug is the *item*-level readings, and it is **not** status-only:
`aborted`, `failed`, and stale-`running` all produce it, because a
non-terminal item measured against `now` is wrong under every one of them.
Fixing this one therefore also covers the item rows of the crashed run bug-14
describes; fixing bug-14 does nothing for any row here. They share the
`RUN_STALE_MS` comparison and nothing else — see the note at the end of the
fix for how to keep that one comparison single.

Both surfaces were raised during the runs-view-redesign review (2026-09-02) and
parked because `itemDurationMs` is the single implementation the "queue wait is
not work" invariant rests on and `RunDrawer`'s rendered output was frozen by
that plan's Global Constraints. Neither reason survives: the fix below adds
**no** second implementation (it corrects the argument, not the arithmetic),
and that constraint belonged to a plan now merged — it existed to stop
incidental drawer churn during a redesign, not to make the drawer permanently
unfixable.

## Fix

**Clamp the clock at the call site; add one boolean where a clock cannot
help.** No forked implementation, no run object pushed into the shared lib
functions' signatures.

### 1. Two new pure exports in `client/src/lib/run-time.ts`

- `runIsLive(run: Pick<OrchestratorRun, 'status' | 'updatedAt'>, now: number): boolean`
  — `status === 'running'` **and** `now − Date.parse(updatedAt) < RUN_STALE_MS`.
  Strict `<`, matching `orchestrate.mjs`'s `isFresh` and the server's own
  comparison. Unparseable `updatedAt` ⇒ `false`.
- `runClockMs(run, now): number | null` — `now` when `runIsLive`, otherwise
  `Date.parse(updatedAt)`, otherwise `null`. The last instant the run can
  actually prove, or nothing.

Derive freshness here rather than reading a `fresh` flag, for bug-14's exact
reason: the pane's authority can be an `OrchestratorArchiveRun`, which has no
such field, and deriving is what makes the crashed-`running` case fall out for
free. `RUN_STALE_MS` imports from `shared/types.ts` (already the source for
`RUN_CLAIMED_STAGES` in this file) — no change to `shared/`.

### 2. Let the two measurements accept a null clock

`itemDurationMs` and `inStageMs` take `now: number | null`. `inStageMs` returns
`null` outright for a null clock. `itemDurationMs` returns `null` **only on its
non-terminal branch** — the terminal branch never reads `now`, and a null clock
must not blank a span the item's own stamps already prove.

**Remove the `= Date.now()` defaults from both.** Every existing caller already
passes `now` explicitly (`RunRowTime.tsx:88`, `RunDrawer.tsx:160`,
`StageTrack.tsx:124`, `run-stats.ts:592`), so this is mechanical — and it is the
`isStale`/`runs` lesson from this repo's own invariants: a default is what lets
the next caller reintroduce the bug silently, and here the default is
`Date.now()`, the one value that is always wrong for a stopped run.

No caller needs new null handling: `RowTime` already collapses a null span to
`''` and returns `null`, `trackValue` already prints `—`, `RowStageCaption`
already returns `null`.

### 3. A fourth dot state, `stalled`

A clock cannot fix `stepperDots` — `state: 'current'` is a boolean claim, not a
measurement. Add a **required** second parameter (`live: boolean`, no default,
same reason as above) and return `'stalled'` where it would have returned
`'current'` with `live === false`.

Not `'filled'`: filled means "visited and left behind", and `StageTrack`'s whole
hollow-between-filled design reads a filled node as "went through cleanly". The
item never left this stage — demoting to `filled` swaps one lie for a quieter
one.

Rendering:

- `.run-track-dot-stalled` and `.run-stepper-dot-stalled` — `--amber` (already
  in the closed palette; `warn` is the tone `parked`/`needs-answers` wear in
  `run-stage.ts`), `animation: none`.
- `segmentState` maps `'stalled'` to a new `data-in="stalled"`: a static amber
  lead-in, never the animated `run-track-sweep`.
- `trackValue`'s `current` branch must also fire for `'stalled'` — the frozen
  span under the node is the useful reading ("it died 7m 24s into dispatch"),
  and with the clamped clock it is now bounded.
- Each state must differ from the other three in **at least two channels**, per
  `run-stepper-style.test.ts`'s own stated rule (colour alone fails a monochrome
  reader). Amber-ring + static segment against green-fill / cyan-pulse /
  hairline-hollow satisfies it; a different pick is fine if it does too.

`lastVisited` in `StageTrack` needs no change — it already tests
`state !== 'hollow'`.

### 4. Thread it at the four call sites

`RunDetail.tsx` holds `source` (the whole winning run object, already passed to
`runStageTotals`); `RunDrawer.tsx` holds `run`. Both compute, once per render:

- `live = runIsLive(<run>, now)`
- `clock = runClockMs(<run>, now)`

Then: `RowTime item now={clock}`, `StageTrack item now={clock} live={live}`,
`RowStepper item live={live}`, and `RowStageCaption` **renders nothing when
`live` is false** — it is a caption about what is happening *now*, and nothing
is; a null return matches its two existing ones.

Leave `RowTime`'s wording at `<span> elapsed` and do not give it a run
parameter. Once the number is bounded it is an honest span, the status chip
beside it names the exit, and the stalled node below it carries the tense —
adding a parameter to change one word would re-fork the very function the
`RowTime` move existed to unify.

### 5. Keep the freshness comparison single — merge-order note

`runIsLive` is the fourth place in this repo that would spell out
"`updatedAt` within `RUN_STALE_MS`": `orchestrate.mjs`'s `isFresh`,
`orchestrator.service.ts:209`, `runStageTotals`' inline derivation, and now
this. The first two are across a process boundary and stay as they are. The
last two must not become two client-side copies:

- If **bug-14** lands first, it will have added a module-local helper in
  `run-stats.ts` answering the same question (its fix, step 1). Do not add a
  second derivation here — export `runIsLive`/`runClockMs` from `run-time.ts`
  as above and have that helper call `runIsLive`, keeping its own job as the
  part `run-time.ts` genuinely cannot do: handing back the freeze *instant*
  `runStageTotals` needs. `runClockMs` already returns exactly that instant,
  so the two collapse cleanly.
- If **this** lands first, bug-14's step 1 should be read as satisfied by
  these exports rather than executed as written, and its "not exported"
  reasoning — that `run-time.ts` has no use for the comparison — is simply no
  longer true once this ships.

Either way, **do not touch `runWallMs` from this bug.** It is bug-14's, its
`aborted` branch is already correct, and the pane header it feeds is the one
reading on this screen that is telling the truth today.

**Do not blanket-replace `now` with `clock` either.** `runStageTotals` must
keep receiving the real `now` — it derives its own freshness internally and
handing it a pre-clamped instant makes that check trivially true, taking the
live branch to reach the right number by accident rather than by rule.
`useNow`'s own `live !== null` gate also stays as it is: it governs whether an
interval is installed, not what any reading measures against.

### Test cases

`test/run-time.test.ts`

- `runIsLive({status:'running', updatedAt: at(0)}, T0 + RUN_STALE_MS - 1)` ⇒
  `true`; at `T0 + RUN_STALE_MS` ⇒ `false`.
- `runIsLive` ⇒ `false` for each of `aborted` / `failed` / `done` even with an
  `updatedAt` seconds old, and for `running` with `updatedAt: 'nope'`.
- `runClockMs` live ⇒ returns the exact `now` it was handed; `aborted` ⇒
  `Date.parse(updatedAt)`; stale `running` ⇒ `Date.parse(updatedAt)`, **not**
  `now`; non-live with `updatedAt: 'nope'` ⇒ `null`.
- `itemDurationMs(<dispatched item>, null)` ⇒ `null`;
  `itemDurationMs(<merged item with its own stamp>, null)` ⇒ the real span,
  unchanged.
- `inStageMs(<any item>, null)` ⇒ `null`.
- `stepperDots(<item at reviewing>, false)` ⇒ `reviewing` is `'stalled'`,
  stages behind it still `'filled'`, ahead still `'hollow'`.
- `stepperDots(<merged item>, false)` ⇒ no `'stalled'` anywhere (nothing was
  `current` to demote).
- Every existing `stepperDots` case, with `true` threaded in ⇒ output identical.
- **Regression case, real data.** Run
  `{status:'aborted', startedAt:'2026-09-01T11:20:35.499Z', updatedAt:'2026-09-01T11:28:10.999Z'}`,
  item `{stage:'dispatched', stageAt:{pending:'…11:20:35.499Z', preflight:'…11:20:46.414Z', dispatched:'…11:21:05.935Z'}}`:
  `itemDurationMs(item, runClockMs(run, now))` ⇒ exactly `444585` (7m 24s), for
  `now` a day later **and** a week later — the same number both times. And
  assert the invariant, not just the value: that reading is `<=`
  `runWallMs(run, now)` (`455500`, 7m 35s — already correct today for an
  `aborted` run, so this assertion needs nothing from bug-14 and pins the
  cross-surface rule the pre-fix code violates by a factor that grows without
  bound).

`test/stage-track.test.tsx`

- `live={false}`, item at `dispatched`: `run-track-<id>-dispatched` carries
  `run-track-dot-stalled` and not `run-track-dot-current`; its `data-in` is not
  `"live"`; `run-track-<id>-dispatched-val` prints the exact frozen span for a
  fixed clock.
- `live={true}`: every existing assertion passes unchanged.

`test/run-track-style.test.ts`

- `.run-track-dot-stalled` and `.run-track-node[data-in="stalled"]::before`
  exist and are non-empty; neither declares an `animation` other than `none`;
  `-stalled` differs from `-filled` and `-current` in two or more declarations.

`test/run-detail.test.tsx`

- Archived `aborted` run holding a `dispatched` item, clock a day on:
  `run-detail-item-time-<id>` reads the frozen span; that stage's node is
  stalled; and the header's own wall reading is `>=` the row's.

`test/run-time-ui.test.tsx`, `test/orchestrator-drawer.test.tsx`

- `status:'running', fresh:true` payload ⇒ unchanged; these suites' existing
  assertions are the guard that the live path did not move.
- `status:'aborted'` payload with a non-terminal item ⇒ no
  `run-drawer-stage-note-<id>` node at all; that stage's stepper dot is
  `run-stepper-dot-stalled`; `run-drawer-time-<id>` prints the frozen span.
  Expect churn in the fixtures at `orchestrator-drawer.test.tsx:274`/`:302` and
  `run-time-ui.test.tsx:126` — they already carry non-fresh runs. That churn is
  the point of this bug, not a regression.

`test/run-stats.test.ts` needs nothing: `avgItemWorkMs` reads merged items only,
so `itemDurationMs` there never touched the clock it was handed.

In the browser (playwright MCP tools): start the stack (`pnpm run docker:up`, or
`pnpm run dev` and `pnpm run dev:web` on the host), open
`http://localhost:5177`, click **Runs** in the side rail, set the range control
to **All**, and select the run whose id is `run-20260901-112035` (status chip
`aborted`). In its detail pane, the `bug-2` row must read `7m 24s elapsed` — a
value no larger than the `7m 35s` the pane header prints for the run itself, and
identical on a page reload — and the `dispatched` node of its stage track must
render the amber stalled dot with no pulsing ring, not the cyan
`run-track-dot-current`.

## Outcome

2026-09-03 — Fixed as the `## Fix` above describes, at the four call sites plus
the two new pure exports; no forked implementation and no run object pushed
into a shared derivation's arithmetic.

What landed:

- `client/src/lib/run-time.ts` — `runIsLive` (status `running` AND `updatedAt`
  within `RUN_STALE_MS`, strict `<`, unparseable ⇒ `false`) and `runClockMs`
  (`now` when live, else the parsed `updatedAt`, else `null`).
  `itemDurationMs`/`inStageMs` now take `now: number | null` with the
  `= Date.now()` defaults REMOVED; `stepperDots` takes a required
  `live: boolean` and returns a fourth state, `stalled`.
- `client/src/lib/run-stats.ts` — `heartbeat` no longer derives the boolean
  itself; it delegates to `runIsLive` and keeps only the job `run-time.ts`
  cannot do (handing back the parsed freeze instant). That is step 5 of the
  fix, taken on the "bug-14 landed first" branch: one client-side spelling of
  the freshness comparison, not two. `runWallMs`' own branching is unchanged —
  its `if` now reads the whole question instead of restating half of it.
- `RunRowTime.tsx` / `StageTrack.tsx` / `RunDrawer.tsx` / `RunDetail.tsx` —
  `RowTime now={clock}`, `StageTrack now={clock} live={live}`,
  `RowStepper live={live}`, and `RowStageCaption` renders nothing when the run
  is not live. `runStageTotals` still receives the real `now`, deliberately.
- `styles.css` — `.run-track-dot-stalled`, `.run-stepper-dot-stalled`,
  `.run-track-node[data-in="stalled"]::before`, `.run-track-name-stalled`:
  amber, hollow-centred, `animation: none`. Three channels apart from
  `filled`/`current`, not one.

`itemDurationMs` was measured against the real filed run BEFORE the fix, as
the red half of the cycle:

```
    Expected: <= 455500
    Received:    86844585
```

86,844,585ms (24.1h, and growing) for bug-2 against its own run's 455,500ms
(7m 35s) wall time. Both component suites were also re-run with the clamp
reverted in place, to prove the new cases actually catch it rather than merely
passing: `test/run-detail.test.tsx` 1 failed / 12 passed,
`test/run-time-ui.test.tsx` 5 failed / 18 passed. Restored, both green.

Verification — `pnpm run typecheck`, `pnpm test`, `pnpm run test:skills`:

```
$ tsc --noEmit
TYPECHECK_EXIT=0

Test Suites: 55 passed, 55 total
Tests:       875 passed, 875 total
Snapshots:   0 total
Time:        56.369 s

--- skills ---
ℹ tests 277
ℹ pass 277
ℹ fail 0
```

`test/orchestrator-drawer.test.tsx` needed no edits after all — the churn the
fix predicted at `:274`/`:302` never materialised, because those two cases
assert only the heartbeat note. `test/run-time-ui.test.tsx`'s `runPayload`
helper DID change: it now states `updatedAt: ago(0)` alongside `fresh: true`,
because a payload claiming a fresh flag while carrying a weeks-old heartbeat
is a run the drawer now (correctly) reads as crashed — and the server can
never emit that combination, since it computes `fresh` from that very field.

Confirmed in the browser as well, on the run this bug was filed from
(`run-20260901-112035`, host dev servers on 4332/5187 so the running compose
stack was left alone): the `bug-2` row reads `7m 24s elapsed` under a header
reading `started 13:20 · 7m elapsed`, its `dispatched` node carries
`run-track-dot-stalled` with computed `animation-name: none`, and the page
holds zero `[data-in="live"]` segments and zero `.run-track-dot-current` dots.
Identical after a full reload — `7m 24s`, still stalled — which is the part
that could not be true before, since the number used to jump forward on every
remount.

One consequence worth stating, not a defect: a genuinely live run whose
heartbeat gap exceeds `RUN_STALE_MS` now reads stalled on these four surfaces
until its next stamp. That is the same threshold `RunStrip`, `runWallMs` and
`runStageTotals` already act on, and `orchestrate.mjs watch` re-stamps every
30s while a child session runs, so the case needs an actually quiet
orchestrator to arise.

`CLAUDE.md` was deliberately not touched, matching bug-14's own commit (same
defect class, same files, no docs change) — the invariant this adds is worth
recording, but recording it is a decision for the user, not this fix.
