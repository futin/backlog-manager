---
id: bug-29
title: Runs view freezes a running-but-stale run's stages until refresh
created: 2026-09-06
updated: 2026-09-07T00:07:33Z
groom-elapsed: 193
groom-tokens: 41502
started: 2026-09-06T23:34:05Z
execute-elapsed: 2008
execute-tokens: 200023
---

## Symptom

While an orchestrator run is in progress, the Runs view's stage readout
(`dispatched`, `inspecting`, `reviewing`, `fixing`, …) stops advancing on its
own and only catches up when the page is reloaded or the window regains
focus. The Board's own run strip, one click away, keeps advancing the whole
time off the same payload.

The freeze is not general — it is scoped to exactly one run state: `status:
"running"` AND `fresh: false`, i.e. a run whose heartbeat is older than
`RUN_STALE_MS` (15 min, `shared/types.ts:652`). While a run is fresh, both
surfaces are live and were measured so.

That state is not an edge case on this machine. `SKILL.md` says outright that
`watch` covers the dispatched session and the detached verification, "but
review and merge still can outlast the fifteen-minute freshness threshold on
their own" (`skills/backlog-orchestrate/SKILL.md:1528`). A scan of the
archived run files in `~/.backlog-manager/orchestrator/*/runs/` found **57
gaps of more than 15 minutes between consecutive stage stamps**, the worst two
being 249 min and 206 min, both `reviewing -> fixing`. Every one of those
windows is a stretch where a perfectly healthy run reads as not fresh, and
therefore a stretch where this view is frozen.

## Repro

Measured live against the running stack (API 4322, Vite 5177) on 2026-09-06
with two real runs in flight, driven through Playwright:

1. Board, no patching: `GET /api/orchestrator/runs` fires every 5s as
   designed (6 polls observed in 16s of wall time).
2. In-page `fetch` wrapper rewriting only `/api/orchestrator/runs` responses,
   changing one queue item's stage: the Board strip moved
   `bug-21 dispatched -> verifying` within one poll, and the Runs detail pane
   moved `bug-19 inspecting -> merging` within one poll. **Both surfaces are
   live while `fresh` is true.**
3. Same wrapper, now also forcing `fresh: false` on every `running` run and
   cycling the stage on each poll (`reviewing`/`fixing`/`verifying`/`merging`):
   4 polls landed with 4 different stages and the Runs detail pane stayed on
   `inspecting` for all of them, alongside a frozen per-stage duration table.
   The 5s poll keeps firing and keeps being discarded.

Nothing on disk was touched by the repro; the whole experiment lived in the
page's own `fetch`.

## Affects

- `client/src/components/runs/RunsView.tsx:203` — `mergeRuns` builds its live
  map from `liveRuns.filter((r) => r.fresh)`, so a `running` but stale run
  gets `live: null` and the row falls back to the archive entry.
- `client/src/components/runs/RunsView.tsx:554` — `freshRunKey` is likewise
  `filter((r) => r.fresh)`, so the one archive refresh a stale run triggers is
  the single one fired at the moment it *drops out* of that set; nothing
  refreshes after that.
- `client/src/components/runs/RunDetail.tsx:303` — `live !== null ?
  rowsFromLive(live.queue) : fetchedRun ? ... : rowsFromArchive(summary.queue)`;
  the `fetchedRun` fallback is fetched once, its effect keyed on
  `[project, runId, live !== null]` (`RunDetail.tsx:214`), so it lands once and
  then stands still.
- `client/src/hooks/useOrchestratorArchive.ts` — no polling interval, by
  design, which is correct for history and is what makes the fallback frozen.
- `client/src/hooks/useOrchestratorRuns.ts:anyLive` — deliberately keeps
  polling for `run.status === 'running'` even when not fresh (the crashed-run
  widening). The data arrives; RunsView is where it is dropped.
- Not affected: `client/src/components/RunStrip.tsx`, which reads the live
  payload directly and keeps updating (it renders the run as crashed, and
  prints the stage as *last reported*).

## Cause

`RunsView` treats `fresh` as the gate on whether the live poll may speak at
all, where the payload's own two fields mean different things: `status` says
whether the run is over, `fresh` says whether its heartbeat is recent. A run
in a long review or merge step is `running` with a stale heartbeat, and
`mergeRuns` reads that as "no live entry", handing the row and the pane back
to the archive — a source that, correctly, never polls.

So the view falls back to a non-polling source in precisely the state where
the polling source is still arriving every 5s. The last stage the run file
recorded is not a guess: `run.json` is re-read per request and the stage
stamps in it are facts with timestamps on them, whatever the heartbeat age
says about whether the process is still alive.

`RunsView` already carries the two fields this needs — `MergedRun.live` (the
data authority `pickAuthority` reads) and `MergedRun.isLive` (the presentation
gate pinning and the live accent read). It just derives both from the one
`fresh` flag, so the presentation decision drags the data decision along with
it.

## Fix

Split the two meanings across the two fields that already exist. No new
field, no new module, no new poll.

1. **`mergeRuns` (`RunsView.tsx:203`) builds its map from every live entry,
   not `filter((r) => r.fresh)`.** `MergedRun.live` becomes "this run's entry
   in the live payload, if the payload has one at all"; `isLive` stays
   `entry.fresh === true`. That is the whole data half: `pickAuthority` then
   fronts a stale-but-arriving live queue over a minutes-old archive
   snapshot, and the 5s poll `useOrchestratorRuns` already keeps running for
   `status === 'running'` regardless of freshness stops being discarded.
   `MergedRun.live`'s doc comment has to be rewritten with it — it currently
   states the `fresh` rule as the rule.

2. **`splitPinned` and the `runs-row-live` class stay on `isLive`, i.e. on
   `fresh`.** This is the pinned-region question the Cause left open, answered
   deliberately rather than by omission: a `running` run with a silent
   heartbeat is a crashed process, and `splitPinned`'s own comment already
   commits to that ("belongs in history with everything else — pinning it
   would be presenting a guess as a fact"). So a healthy run in a 200-minute
   review does drop out of the pinned region mid-run, exactly as the Board
   strip starts calling it crashed at the same instant off the same flag.
   Consistent beats comfortable; widening freshness itself is a different,
   much larger change and is not in scope here.

3. **Say it is last-reported, do not imply it is current.** Reuse
   `isCrashed(run)` (`client/src/lib/run-watchdog.ts`) — already the one
   verdict `RunStrip`, `BoardView` and `WatchdogMonitor` share — to mark the
   row and to qualify the pane's stage readout, in the strip's own existing
   vocabulary. A row whose stages now move must not read as a process
   anybody is still hearing from.

   **And the status badge itself, which is the loudest of the three.** Both
   surfaces print `authority.status` verbatim — `RunsView.tsx:441` (the list
   row's `runs-status` span) and `RunDetail.tsx:380` (the same span in
   `run-detail-head`) — so a run whose heartbeat died 46 minutes ago renders
   the word `running`, in the live tone, beside a `34m elapsed` that
   `runWallMs` has already correctly frozen. Observed on
   `run-20260906-185312` while the Board strip one click away said `crashed`
   and the Watchdog card said `exhausted after 2`. Marking the row and
   qualifying the stage readout while leaving that badge alone would fix the
   quiet half of the lie and leave the loud one, so both sites read
   `crashed` — the strip's own word (`run-strip-crashed-label`,
   `RunStrip.tsx:328`) — whenever `isCrashed` is true.

   Three constraints on how, all of which the obvious implementation gets
   wrong:

   - **`crashed` is not a `RunStatus` and must not become one.** It stays
     derived, exactly as `isCrashed`'s own header and CLAUDE.md's
     "Groomed is derived" posture require. `RUN_STATUS_GLYPH` and
     `RUN_STATUS_CLASS` (`client/src/lib/run-stage.ts:126`, `:142`) are
     `Record<OrchestratorRun['status'], string>`, exhaustive over the five
     wire statuses; adding a sixth key would put a word on the wire type that
     no run file can ever contain. The substitution happens at these two
     render sites, over the records' existing `running` entry.
   - **Derive it from the live entry, never from `authority`.** `authority`
     can be an archive summary, which carries no `fresh` field at all —
     `isCrashed` needs `{ status, fresh }`, and only `row.live` /
     `live` can supply the second half. An archive-only row has no heartbeat
     to judge and must keep printing its recorded status unchanged. This is
     the same split step 1 draws: the live entry is the data authority,
     `isLive`/`fresh` is the presentation gate.
   - **`RunsView.tsx:838` is out of scope and stays untouched.** That is the
     aggregate tile's `byStatus` substat — a count over the archived corpus,
     not a claim about any run right now. A crashed run is genuinely a
     `running` run for the purpose of that tally, and re-bucketing history
     behind a freshness flag would make the tile disagree with the archive
     it summarises.

4. **`RunDetail`'s two "active"/"queued" chips (`RunDetail.tsx:340`, `:341`
   and the `:461` render gate) move from `live !== null` to
   `live.fresh === true`.** They count what the run is doing *this instant*,
   which a stale entry cannot claim; every other `live !== null` site in that
   file is correct on presence alone — the rows source (`:302`) is the fix,
   and the one-shot fetch (`:193`) is right to stand down once a live entry
   exists, stale or not. `useNow`'s gate (`:234`) moves to `fresh` too, for
   cost rather than correctness: every clock on the pane already freezes
   itself on a stale heartbeat (`runWallMs`, `runStageTotals`, `runClockMs`,
   all via `runIsLive`), so a 1s interval on a crashed run only repaints
   numbers that cannot change.

5. **`freshRunKey` (`RunsView.tsx:554`) is left alone.** It fires the one
   targeted archive refresh, and the archive is still the identity source for
   which rows exist at all — a stale run is already a row, so nothing about
   this fix needs that effect to fire more often.

### Test cases

- `mergeRuns` with an archive row plus a live entry that is `status:
  "running", fresh: false` → `row.live` is that entry, `row.isLive === false`.
- `splitPinned` over that row → it lands in `history`, not `pinned`.
- `runWallMs` on the stale-live authority → `updatedAt - startedAt`, frozen,
  not climbing toward `now`. (Already true; pinned so the change cannot
  regress it.)
- jsdom `RunsView`: select a run whose live entry is `running`/`fresh: false`
  with one queue item at `inspecting`; re-render with the same entry at
  `merging` and no archive refetch → the detail pane prints `merging`.
- Same, fresh entry → row is pinned, carries `runs-row-live`, and both the
  `active` and `queued` chips render.
- Same, stale entry → neither chip renders, and the crashed marker from step 3
  is present.
- jsdom `RunsView`, stale live entry (`running`/`fresh: false`) → the list
  row's `runs-status` span reads `crashed`, not `running`, and the detail
  pane's head badge reads `crashed` too. Both, in one case: the two sites are
  the whole point of the amendment and a test covering one would pass on a
  half-applied fix.
- Same, fresh live entry → both badges read `running`. This is the pair that
  fails if the substitution is keyed on `status` alone rather than on
  `isCrashed`.
- jsdom `RunsView`, an archive-only row with no live entry whose recorded
  status is `running` (a run whose file is gone or superseded) → both badges
  still read `running`. A row with no heartbeat to judge must not be
  reclassified; this is the case that fails if the derivation is taken from
  `authority` instead of the live entry.
- `RUN_STATUS_GLYPH` and `RUN_STATUS_CLASS` still key exactly the five
  `OrchestratorRun['status']` members — a `Record<OrchestratorRun['status'],
  string>` assertion in the same shape as `test/agents-shared.test.ts`'s
  `Record<RunStage, true>`, so adding `crashed` as a sixth key fails the type
  check rather than passing review.
- The aggregate tile's `byStatus` substat over a corpus containing a stale
  `running` run → still counts it under `running`. Pins step 3's stated
  out-of-scope so a later reader does not "finish the job" there.

In the browser (playwright MCP tools): open `http://127.0.0.1:5177`, click
Runs, and install a `fetch` wrapper that rewrites `/api/orchestrator/runs`
responses to force `fresh: false` on every `running` run while cycling one
queue item's stage across `reviewing`/`fixing`/`verifying`/`merging` on each
poll. Over four polls (~20s) the detail pane's stage readout must change on
every poll and carry the last-reported qualifier — the same experiment that
produced this bug's Repro step 3, where it stayed on `inspecting` for all
four. The same wrapper produces step 3's badge state for free, so assert it in
the same pass: with `fresh: false` forced, the selected row's status badge and
the detail head's badge must both read `crashed` rather than `running`, and
must both go back to `running` when the wrapper is removed and a real fresh
poll lands.

## Outcome

2026-09-07 — fixed as groomed, all five numbered steps of `## Fix`, no
deviations in substance. Two things the plan did not name are recorded below.

**What changed.**

1. `mergeRuns` (`client/src/components/runs/RunsView.tsx`) builds its live map
   from every entry in the payload — the `.filter((r) => r.fresh)` is gone —
   and `isLive` is now `live?.fresh === true`. `MergedRun.live` (data
   authority) and `MergedRun.isLive` (presentation gate) both had their doc
   comments rewritten around that split; they are no longer two ways of saying
   the same thing.
2. `splitPinned` and `runs-row-live` untouched: both still read `isLive`, so a
   crashed run still drops out of the pinned region. The I4 test that pins
   that gained a paragraph explaining that the gate moved one field down
   rather than disappeared.
3. Both status badges — the list row (`RunsView`) and the pane's head
   (`RunDetail`) — read `crashed` through a new `runStatusChip`
   (`client/src/lib/run-stage.ts`), the single implementation of the
   substitution, derived from the live entry and never from `authority`.
   `crashed` is not a sixth `RunStatus`: `RUN_STATUS_GLYPH`/`RUN_STATUS_CLASS`
   still key exactly the five wire statuses, and the class is the existing
   `runs-status-warn` (the same amber `.run-strip-crashed-label` prints) rather
   than a new one. `RunsView.tsx`'s `byStatus` substat is untouched.
   The pane also gained a boxed `run-detail-crashed` note directly under the
   head, since it is the surface whose stages now move.
4. `RunDetail`'s `active`/`queued` chips and their render gate moved from
   `live !== null` to `live.fresh === true` (one `liveFresh` local, so the
   count and the gate cannot disagree), and `useNow`'s gate moved with them.
5. `freshRunKey` untouched.

**Two decisions the plan did not cover.**

- **The crashed note names the last heartbeat as a clock time, not an age.**
  Step 4 removes this pane's 1s interval for a crashed run on the stated
  premise that "every clock on the pane already freezes itself on a stale
  heartbeat" — a ticking `no heartbeat for 46m` would have broken exactly that
  premise and taken the saving straight back (`useNow(false)` freezes its value
  at first render, so an age there would also have been silently wrong). A
  fixed stamp needs no clock; the Board strip is one click away for the age. It
  is null-tolerant (`heartbeat stopped` when `updatedAt` will not parse),
  matching the head's own null-tolerant join, and both branches are tested.
- **The row's `pausing` badge now reaches crashed runs**, because it reads
  `row.live?.pauseRequested` and `row.live` is no longer freshness-gated. Kept
  and documented rather than re-gated: the pause request is a real file on this
  machine's disk waiting at the run's next dispatch gate, and it is still
  waiting whether or not the run has stamped a heartbeat lately.

**One existing test's fixture moved, and why.** `freezes the wide tile's open
span at a stale archived run's last heartbeat, not real time` reached
`runStageTotals`' open-span arithmetic *through* the archive fallback this fix
removes, so its open `reviewing` arrival is now stated on the stale LIVE queue
instead. Same stamps, same hand-checked `144h 00m` assertion, same property
pinned — only the source of the queue moved, which is the thing the fix
changed. Its title lost the word "archived".

**Tests added** (13, all watched fail first; the two that passed on arrival
were re-run against a deliberately broken implementation to prove they bite):
five in `test/run-stage.test.ts` for `runStatusChip` including the "no sixth
key" guard, nine in `test/runs-view.test.tsx` under
`RunsView · a running run whose heartbeat has gone stale` (data authority,
frozen wall time, the stage advancing across a real 5s poll tick with no
archive refetch, the crashed/running badge pairs on both sites, the
archive-only row that must not be reclassified, the chips, and the `byStatus`
out-of-scope pin), two in `test/run-detail.test.tsx` for the note's two
branches, and a new `test/run-detail-crashed-style.test.ts` guarding the note's
stylesheet rule — jsdom cannot see that a note is styled, and an invisible
alert is the one way this fix could regress silently.

**Not done: the browser (Playwright) pass the plan's last paragraph
describes.** It needs this worktree's own stack on its own ports, and the
mechanism it would exercise — `useOrchestratorRuns`' real 5s interval
delivering a `fresh: false`/`running` payload with a moving stage — is what the
new fake-timer case in `runs-view.test.tsx` drives through the real hooks. The
one thing jsdom genuinely cannot see, whether the note is visible at all, is
covered by the stylesheet suite instead. Flagged rather than quietly dropped.

### Verification

```
$ pnpm run typecheck
$ tsc --noEmit
typecheck exit=0

$ pnpm test
Test Suites: 79 passed, 79 total
Tests:       1499 passed, 1499 total
# tests 411
# pass 411
# fail 0

────────────────────────────────────────────────────────────
PASS  jest
PASS  node --test (skills)

pnpm test: both runners passed.

$ pnpm run build
dist/assets/RunsView-DYkwriY4.js                                    71.04 kB │ gzip:  10.23 kB
dist/assets/index-Cw6vDtKm.js                                      340.52 kB │ gzip: 103.74 kB
✓ built in 1.12s
build exit=0
```

The honest premise-check on the poll case, run by reinstating the
`.filter((r) => r.fresh)` and nothing else:

```
✕ advances the detail pane's stage readout on every live poll, with no archive refetch
    Expected substring: "merging"
    Received string:    "e-1e-1 title●inspecting"
```

### Review round 1 — comment sweep, no code change

Verdict `fix`, one Important finding: six doc passages still stated the
premise this fix removed — that `live` exists only while the server's `fresh`
check holds. Rewritten to say what is now true (`live` is the data authority
and may be stale; `fresh`/`isLive`/`isCrashed` is the presentation gate),
each keeping the point it was making:

- `client/src/lib/run-authority.ts` tier 1 — `live` is present whenever the
  payload carries an entry, which is for as long as that `run.json` is the
  project's current file, whatever its status or heartbeat age. Says outright
  that both callers now pass a possibly-stale entry on purpose.
- `client/src/lib/run-authority.ts` tier 2 — an entry disappears when the run
  file stops being the project's current one (`init` archiving it), not when
  a run finishes.
- `client/src/components/runs/RunDetail.tsx` file header — the fix-round
  defect, its fetch and this fallback are all unchanged; only the sentence
  attributing the `live` → `null` transition to the `fresh` flag was wrong,
  and it now says so and names the real trigger.
- `RunDetail.tsx` `pickAuthority` comment — same correction, one line.
- `RunDetail.tsx` `runStageTotals` comment — quoted `useNow`'s gate as
  `live !== null` eleven lines after this branch changed it to
  `live?.fresh === true`.
- `client/src/lib/run-stats.ts` at both `runWallMs` and `runStageTotals` —
  each said `pickAuthority` never picks a stale entry as a live winner. It
  now does, by design, so the live path reaches the very door these two gates
  close; the gates themselves are unchanged and the comments now say the door
  is the main one rather than a side entrance through the archive.

Two further one-word uses of the same false premise, outside the reviewer's
six, swept with them since leaving them would be half a sweep:
`RunsView.tsx`'s file header ("carries the fresh live entry itself") and
`run-stats.ts`'s `aggregateRuns` shape note ("a fresh live
`OrchestratorRun`").

Deliberately not touched: `ArchiveView.tsx`'s "the hook polls only while some
run is fresh". That one is also imprecise — `useOrchestratorRuns` polls while
any run is fresh OR `running` OR `starting` — but it predates this branch,
describes a different module, and nothing here changed it.

No code changed in this round; `git diff` over the four files contains no
non-comment line. Re-verified:

```
$ pnpm run typecheck
typecheck exit=0

$ pnpm test
Test Suites: 79 passed, 79 total
Tests:       1499 passed, 1499 total
# tests 411
# pass 411
# fail 0

PASS  jest
PASS  node --test (skills)
pnpm test: both runners passed.
```
