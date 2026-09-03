---
id: bug-14
title: runWallMs reports a forever-growing wall time for a crashed run
created: 2026-09-02
updated: 2026-09-03T13:07:29Z
groom-elapsed: 120
started: 2026-09-03T12:55:05Z
execute-elapsed: 744
---

## Symptom

A run whose orchestrator crashed keeps its `run.json` at `status: "running"`
forever — that is the documented invariant: `orchestrate.mjs init` refuses on
any `status: "running"` file, "fresh or stale — a stale one means a crashed
run, recoverable only via `--resume`/`--abort`". `GET /api/orchestrator/archive`
serves that file verbatim.

`runWallMs` forks on `status === 'running'` alone and answers `now − startedAt`
for it. So a crashed run's wall time in the Runs list grows by a second every
second, indefinitely, reported as "how long this run has taken". Three days
after the crash it reads three days.

## Repro

1. Start an orchestrator run and kill the process mid-item (or find an existing
   crashed run — `run.json` left at `status: "running"` with an `updatedAt`
   older than `RUN_STALE_MS`).
2. Open the Runs tab. The row's wall time keeps climbing on every render.

## Affects

- `client/src/lib/run-stats.ts` — `runWallMs`, the `status === 'running'`
  branch.
- `client/src/lib/run-time.ts:179` — `runElapsedMs` already solves the same
  problem correctly, forking on `status === 'running' && fresh` and freezing at
  `updatedAt` otherwise. Its comment states the reasoning: "nobody knows whether
  that process is still working, so freezing the total at its last confirmed
  heartbeat is the only honest reading".
- `shared/types.ts:511` — `RUN_STALE_MS`, the heartbeat window.

## Cause

`runWallMs` (`client/src/lib/run-stats.ts:185`) reads `status` but not the
heartbeat — `if (run.status === 'running') return Math.max(0, now - started)`,
with no `updatedAt` check in front of it. Its own doc comment used to assert
that an archived run "cannot go stale — it is either still running right now
or it is finished forever", which is false for exactly the crashed case above;
that sentence was corrected in the runs-view-redesign branch (2026-09-02) but
the behaviour was deliberately left alone as out of that branch's scope, and
the comment now documents the gap as *known* — so the fix has to rewrite that
paragraph, not merely the code under it.

`runStageTotals` in the same file had the identical defect and was fixed in
that branch (its own "FIX ROUND 2" paragraph): it derives `fresh` as
`RUN_STALE_MS` measured against `updatedAt` and ends an open span at `now`
only while fresh, else at `updatedAt`. That fix is the pattern to copy.

The reason `runStageTotals` was fixed and this was not: `runStageTotals` feeds
`sumStageTotals`, so one crashed run contaminated an aggregate across all of
history with no "this run is dead" cue anywhere on it. `runWallMs` is a single
per-run reading shown beside its own `running` status chip, which at least
hints at why the number is odd. That makes this lower severity, not correct.

Four things confirmed while grooming, each of which shapes the fix below:

- **Nothing upstream filters a crashed run out, so `runWallMs` is the only
  place that could notice.** Both readings resolve their run through
  `pickAuthority` (`lib/run-authority.ts`), and for a crashed run the live
  tier is `null` by construction: `mergeRuns` keeps a live entry only while
  its server-computed `fresh` flag is true (see `MergedRun.live`'s own doc
  comment). The authority is therefore the archive record — or `RunDetail`'s
  own `fetchArchivedRun` re-read of the same file — served verbatim at
  `status: "running"`.
- **Exactly two call sites, both single per-run displays.** `RunRow`
  (`RunsView.tsx:365`, rendered into `.runs-row-wall`) and `RunDetail`'s
  header (`RunDetail.tsx:256`, `data-testid="run-detail-time"`, printed as
  `<span> elapsed`). It is folded into no aggregate: `aggregateRuns`
  deliberately omits it (see that function's own closing comment), so no stat
  tile can move when this changes — the blast radius is those two strings.
- **How fast it grows differs by call site**, which refines the symptom's "on
  every render". `RunsView` takes `const now = Date.now()` once per render, so
  the row climbs on every re-render — and the 5s live poll re-renders the whole
  view whenever *any* project has a fresh run. `RunDetail` takes
  `useNow(live !== null, 1_000)`, and `live` is `null` for a crashed run, so
  its reading installs no interval and is frozen at that pane's mount instant:
  still `now - startedAt`, still days, just re-frozen higher on each remount
  instead of ticking.
- **`aborted` and `failed` runs are already correct here** — they take the
  `updatedAt - startedAt` branch. This is a `running`-only defect, which is
  what keeps it disjoint from bug-15 (an aborted run's *item*-level readings,
  `itemDurationMs` and `stepperDots`): the two share a theme and no code.

## Fix

Give `runWallMs` the same heartbeat gate `runStageTotals` already has, and
factor that gate out so the file holds one implementation of it rather than
two copies.

1. **Add a module-local helper** to `client/src/lib/run-stats.ts`, beside
   `parseStamp`: given a run's `updatedAt` and `now`, it answers the parsed
   heartbeat instant (`null` when the stamp will not parse) together with
   whether that heartbeat is fresh — `updated !== null && now - updated <
   RUN_STALE_MS`, strictly `<`, the same comparison
   `orchestrator.service.ts:209` performs server-side to compute the live
   payload's `fresh` flag. Both values, not just the boolean: `runStageTotals`
   needs the instant itself as the freeze point for an open span. Not
   exported — `run-time.ts`'s `runElapsedMs` reads the server's flag off the
   live payload and has no use for it, and that shape difference is the whole
   reason these are separate functions in the first place.

2. **Rewrite `runWallMs`' fork** to `status === 'running' && fresh`, mirroring
   `runElapsedMs`. The stale-`running` case then falls through to the existing
   `updatedAt - startedAt` tail with that tail unchanged — freezing the run at
   its own last confirmed heartbeat, which is the reading `runElapsedMs`' own
   comment already argues for: "nobody knows whether that process is still
   working, so freezing the total at its last confirmed heartbeat is the only
   honest reading." Point `runStageTotals` at the same helper in place of its
   inline derivation; its behaviour must not change, and its existing cases in
   `test/run-stats.test.ts` are what proves that.

3. **One deliberate behaviour change beyond the crashed case**: a `running`
   run whose `updatedAt` will not parse now answers `null` where it used to
   answer `now - startedAt`. An unparseable heartbeat is not evidence a
   process is alive, so it cannot earn the `now`-ticking branch, and it leaves
   no honest instant to freeze at either — the same "skip rather than
   fabricate" call `runStageTotals` already makes for its own open span, and
   the same one this function's `null` paragraph already makes for an
   unparseable `startedAt`. Both callers degrade correctly with no edit:
   `RunRow` renders the wall span only when it is non-null, and `RunDetail`'s
   header prints `started HH:MM` alone — which is precisely the case its own
   comment there already describes ("a run with a readable `startedAt` and a
   corrupt `updatedAt` can still say when it began even with no honest wall
   time to report"), a comment that today covers only finished runs and simply
   becomes true of `running` ones too.

4. **Rewrite the doc comment.** The "KNOWN, DELIBERATE gap" paragraph
   (`run-stats.ts:160`–`178`) is false once the code lands and has to go; the
   replacement states the fork (`status === 'running' && fresh`, freshness
   derived here rather than read off a flag this shape does not carry) and
   keeps the surrounding explanation of why this is not just a call to
   `runElapsedMs`. Leave `aggregateRuns`' closing comment alone: "`runWallMs`
   drifts" stays true of a genuinely fresh running run, which is still the
   only reason not to average it.

### Test cases

`test/run-stats.test.ts`, in the existing `runWallMs` describe. Cases 6a–6c
stay green exactly as written — 6b's fixture sits 29s past its heartbeat, well
inside `RUN_STALE_MS`, so it still takes the live branch:

- A crashed run — `status: 'running'`, `startedAt: at(0)`, `updatedAt:
  at(1_000_000)`, read at `now = T0 + 1_000_000 + 24 * 60 * 60 * 1000` —
  answers `1_000_000`, not the day-plus span to `now`. The direct analogue of
  `runStageTotals`' own "freezes a crashed run's open span at its own last
  heartbeat" case, and the one test that fails today.
- The boundary reads stale, matching the server's strict `<`: `startedAt:
  at(0)`, `updatedAt: at(1_000)`, `now = T0 + 1_000 + RUN_STALE_MS` answers
  `1_000`, not `RUN_STALE_MS + 1_000`.
- A `running` run with `startedAt: at(0)` and `updatedAt: 'garbage'` answers
  `null` (item 3 above).
- A still-genuinely-live run keeps ticking: `startedAt: at(0)`, `updatedAt:
  at(60_000)`, `now = T0 + 65_000` answers `65_000`.

`test/runs-view.test.tsx` — one component case, because no unit test can prove
the *row* stopped growing:

- An archive-only run (no live entry at all) at `status: 'running'`,
  `startedAt: '2026-09-01T09:00:00.000Z'`, `updatedAt:
  '2026-09-01T09:42:00.000Z'` renders `.runs-row-wall` as exactly `42m`. No
  fake timers needed: the real `Date.now()` this view calls is months past
  that heartbeat, so the fixture is stale by construction, and without the fix
  the row prints the whole span since September 1st instead.

In the browser (playwright MCP tools): stage a crashed run in a **throwaway**
orchestrator home so nothing real is touched. From this repo root, `D=/tmp/bm-bug14-orch/$(node -p 'encodeURIComponent(process.cwd())')`,
`mkdir -p "$D"`, then write `$D/run.json` as a copy of any archived run file
under `~/.backlog-manager/orchestrator/*/runs/` with four fields overwritten:
`status` to `"running"`, `startedAt` to `"2026-09-01T09:00:00.000Z"`,
`updatedAt` to `"2026-09-01T09:42:00.000Z"`, and `project` to this repo's own
absolute path (so the row's label reads `backlog-manager`); leave `runId` and
the queue as they are — a queue item at a non-terminal stage is what makes it
read as a genuine crash. **Never write that file into the real
`~/.backlog-manager/orchestrator/`**: `orchestrate.mjs init` refuses on any
`status: "running"` run file, fresh or stale, so a fabricated one left there
would block every future orchestrator run for the project it sits under. Then
run `BM_ORCH_HOME=/tmp/bm-bug14-orch pnpm run dev` alongside `pnpm run dev:web`,
open `http://127.0.0.1:5177`, click **Runs**, and find that run's row: its wall
time must read exactly `42m`, and clicking the row must put `42m elapsed` in
the detail header. Reload the page and confirm both still read `42m` — the
reload is the actual assertion, since the pre-fix reading is larger on every
one. Remove `/tmp/bm-bug14-orch` when done.

## Outcome

2026-09-03 — fixed as planned. `runWallMs` now forks on `status === 'running'
&& fresh`, with freshness derived by a new module-local `heartbeat` helper
(`RUN_STALE_MS` measured against `updatedAt`, strictly `<`, matching
`orchestrator.service.ts:209`); `runStageTotals` was pointed at that same
helper in place of its inline derivation, so the file holds one implementation
of the gate rather than two. The `KNOWN, DELIBERATE gap` paragraph in
`runWallMs`' doc comment was replaced — it asserted the behaviour this fix
removes. `aggregateRuns`' closing comment was left alone as the plan directed.
Behaviour change beyond the crashed case, exactly as item 3 of the Fix
specified: a `running` run whose `updatedAt` will not parse now answers `null`.

Four unit cases were added to `test/run-stats.test.ts` and one component case
to `test/runs-view.test.tsx`. Three of the four unit cases and the component
case were watched failing before the fix (the fourth, "still ticks against now
for a genuinely live run", is a regression guard on the branch that must not
move):

```
  ● runWallMs › freezes a crashed running run at its own last heartbeat
    Expected: 1000000
    Received: 87400000
  ● runWallMs › treats a heartbeat exactly RUN_STALE_MS old as stale
    Expected: 1000
    Received: 901000
  ● runWallMs › is null for a running run whose updatedAt does not parse
    Received: 30000
Tests:       3 failed, 27 passed, 30 total

  ✕ freezes a crashed archived run at its own last heartbeat rather than growing
    Expected: "42m"
    Received: "51h 57m"
Tests:       1 failed, 20 passed, 21 total
```

`51h 57m` is itself the symptom: that fixture is dated 2026-09-01 and the
number is measured against the real clock, so it is larger on every day the
suite runs — nobody could have pinned the pre-fix formula to a fixed string.

After the fix, the whole suite and the typechecker:

```
$ pnpm run typecheck
$ tsc --noEmit
TYPECHECK_EXIT=0

$ pnpm test
Test Suites: 55 passed, 55 total
Tests:       850 passed, 850 total
Snapshots:   0 total
Time:        132.392 s
```

Confirmed in the browser as the Fix's own verification section describes, with
a crashed run staged in a throwaway `BM_ORCH_HOME=/tmp/bm-bug14-orch` (the real
`~/.backlog-manager/orchestrator/` was read for a template only, never written
— a fabricated `status: "running"` file there would block every future run for
that project). API on `PORT=4399`, Vite on `WEB_PORT=5199`, since the user's
docker stack holds the default 4322. The Runs row read
`running backlog-manager 0/1 42m` and the detail header
`started 11:00 · 42m elapsed`; after a full page reload both still read `42m` —
the reload being the actual assertion, since every pre-fix reading is larger
than the last. The throwaway directory and both dev processes were removed
afterwards.

Observed but deliberately not touched: that same run's *item* row reads
`63h 52m elapsed` for its stranded `fixing` item, which is the item-level
version of this defect and belongs to bug-15's `itemDurationMs`/`stepperDots`
scope, not this one.
