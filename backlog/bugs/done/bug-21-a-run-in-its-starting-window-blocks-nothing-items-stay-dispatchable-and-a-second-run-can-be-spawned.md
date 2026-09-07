---
id: bug-21
title: A run in its starting window blocks nothing: items stay dispatchable and a second run can be spawned
created: 2026-09-05
updated: 2026-09-06T17:26:32Z
groom-elapsed: 138
groom-tokens: 18128
started: 2026-09-06T17:02:02Z
execute-elapsed: 1470
execute-tokens: 195572
---

## Symptom

task-14's `starting` placeholder makes a board-started run *visible* before its
`run.json` exists, but nothing else on the board treats that project as
occupied. For the whole 1–5 minute starting window (dashboard spawn → session
boot → 1360-line SKILL.md read → §1 `plan` turn → `init` writes the run file):

1. Every open bug and task in that project keeps a live execute/groom dispatch
   button, so a person can hand-dispatch an item the pending run is about to
   claim. The hand session works in the main tree while the run's own worktree
   executes the same item — the exact double-work bug-4 and bug-12 each closed
   for the run-file case, reopened for the window before the run file exists.
2. The toolbar Orchestrate control stays visible for the same project, and the
   server's own pre-spawn lock also passes, so a second headless run can be
   spawned. Both sessions boot; whichever reaches `init` second exits `4` (lock
   held) and dies, having burned a session and told the user "never retry, go
   to `--resume`" for a run that never crashed.

Both fall out of one cause: `starting` is read by exactly one surface. Every
run-aware gate in the app reads `payload.runs`, which is empty for a run that
has not written a run file yet.

## Repro

1. Board, one project selected, at least one groomed open bug or task.
2. Press Orchestrate, start a run. The starting strip appears.
3. Before the strip flips to a real run (up to ~5 min): the cards' dispatch
   buttons are enabled — click one and it opens the launch sheet and dispatches.
4. In the same window the Orchestrate control is still rendered; pressing it
   again returns 200 and spawns a second session.

## Affects

- `shared/agent.ts:386` — `runClaimBlock(item, runs)` scans `payload.runs`
  only; there is no starting-aware equivalent, and `runEntryAt` filters
  `run.fresh` on entries that do not exist yet.
- `client/src/components/board/BoardView.tsx:500` — `runBlockFor` passes only
  `runs`, though `starting` is already destructured at line 191 for the strip.
- `client/src/components/board/BoardView.tsx:475` — `orchestrateHasFreshRun`
  is `freshRuns.some(...)`; a starting entry does not hide the control.
- `server/src/agents/agents.service.ts:452` — the pre-spawn `activeRun` lock is
  `runs().runs.find((r) => r.project === req.project && r.fresh)`; no starting
  check, even though `AgentsController` (line 197) is the thing that marks
  them.
- `client/src/components/board/DispatchButton.tsx` — renders the three blocks
  in order; a fourth (or a widened `runClaimBlock`) would land here.

## Cause

Confirmed as captured, and the Symptom's own one-line diagnosis is right: there
is exactly one reader of `payload.starting` in the whole app, and it is
`BoardView`'s strip row. Every gate is a reader of `payload.runs`, which is
empty for a project whose `init` has not landed. The line anchors in Affects
have drifted a little since capture; the current ones are `shared/agent.ts:429`
(`runClaimBlock`), `BoardView.tsx:488/489` (`orchestrateHasFreshRun`,
`showOrchestrate`), `BoardView.tsx:513` (`runBlockFor`),
`agents.service.ts:455` (the pre-spawn lock) and `agents.controller.ts:198`
(`this.starting.mark`).

Two things the investigation turned up that the capture did not have, and both
change the shape of the fix rather than confirming it.

**The gap is four gates, not two, because `runClaimBlock` has four callers.**
Affects names the board's `runBlockFor`; the same function is also called by
`ArchiveView.tsx:192`, by `agents.service.ts:283` (the `plan` payload's
`blocked` field) and by `agents.service.ts:344` (dispatch's own server-side
re-check, the 409). All four are blind in the same window and for the same
reason. Archive is not a theoretical fourth: a long-untouched *groomed* open bug
sits in Archive precisely while no run holds it (`leavesBoard` pulls it back to
the Board the moment one does — bug-11), so during the starting window it is
both in Archive and about to be queued, and its card there is dispatchable. The
server pair matter for the same reason the client ones do: `POST
/api/agents/dispatch` is the layer that actually stops a double-execution, and
`plan` is what the launch sheet renders its refusal from.

**The starting entry a crashed project carries is a lie, and all four gates
plus the strip want it gone.** `BoardView.tsx:336` already subtracts it — the
`startingRuns` filter, whose comment works through the case in full: the server's
pre-spawn lock refuses only a *fresh* run, so pressing Orchestrate on a project
whose last run crashed is allowed and marks the project, but the spawned
session's own `init` refuses any run file still reading `running`, so the run
never lands, eviction rule 1 never matches, and the entry survives the full
`RUN_STALE_MS`. That subtraction is currently a render-time filter in one
component. Every consumer this fix adds needs the identical rule — a dispatch
block, an Orchestrate hide and a server lock all built on that entry would each
be wrong for fifteen minutes in exactly the same way — which makes "one
expression the strip happens to own" the wrong home for it. It belongs in
`StartingRunsService`, as a third eviction rule beside the two already there,
which is also the only place the *server's* lock can read it from.

Two supporting facts the fix leans on, both already true:

- `OrchestratorService.runs()` already returns `{ runs, starting }` from one
  call (orchestrator.service.ts:343), and `AgentsService` already holds that
  service. The server side of this needs no new wiring, no new injection and no
  second read — only `.runs` stops being destructured away at three call sites.
- `useOrchestratorRuns` already ORs `starting.length > 0` into its own live-poll
  predicate (useOrchestratorRuns.ts:222), so every block this adds clears on the
  5s poll that lands the run file, not on a window focus.

**Ruling 1 — the block is project-wide; task-14's `ids` deferral stays
closed.** A `StartingRun` is `{ project, requestedAt }` and nothing else, so no
block derived from it can be per-item. Carrying the sheet's `ids` would buy
per-item precision for subset runs only: the default launch sends no `ids` at
all, and even then the server cannot name the item set, because which open bugs
and tasks a run actually queues is `buildGatedQueue`'s verdict inside the
spawned session, over `<base>`, minutes later. So the precise answer is
unavailable for the common case no matter what is stored, and storing the list
would add a second run-identity to keep in step with the run file that is about
to supersede it. Conservative and project-wide it is. The asymmetry justifies
it: a wrong *allow* costs a hand session working the same item in the main tree
while the run's worktree works it — the double-execution bug-4 and bug-12 each
closed — and a wrong *block* costs a wait bounded by the run file landing, or
by `RUN_STALE_MS` at the very worst. It does over-block, and the over-blocking
is deliberate rather than unnoticed: an out-of-scope item's `capture` dispatch
in Archive cannot collide with any run and is blocked anyway, because splitting
that case out would put a second per-item rule inside a block whose whole
premise is that it has no per-item information.

**Ruling 2 — the server lock is in scope.** CLAUDE.md's "One run per project,
checked twice" is the reason: `init`'s on-disk lock is the check that matters,
and `POST /api/agents/orchestrate` is the second one precisely because the board
path never goes through `init` before spawning. Right now that second check is
blind for the whole window while *the same process* holds the record proving a
run is on its way, and the client-side hide alone would leave the API's own
promise unkept for any caller that is not this board. It also costs nothing:
`this.orchestrator.runs()` already returns the array.

The two-rapid-POSTs race `StartingRunsService`'s own comment names is narrowed
by this, not closed, and that is deliberate. `mark()` runs after the awaited
spawn so a failed spawn leaves no ghost, so two POSTs that both clear the lock
before either spawn resolves still both proceed. The window shrinks from the
full 1–5 minutes to the duration of one `POST /api/spawn`, and closing it
properly would mean marking before the spawn plus a compensating delete on
throw — the `catch`-free invariant task-14 chose on purpose. Left alone.

## Fix

One rule per surface, each in exactly one place. Nothing here writes a run file,
adds a persisted field, or changes what `orchestrate.mjs` sees.

**1. Third eviction rule in `StartingRunsService.expired()`** — an entry is
dead while any run for that project reads `status: 'running'`, fresh or crashed:

    if (realRuns.some((r) => r.project === project && r.status === 'running')) return true;

Keyed on `status === 'running'` exactly, never on `!fresh` and never on "a run
file exists": `done`, `aborted`, `failed` and `paused` are all archived by
`cmdInit`, so a project whose last run is any of those can legitimately start a
new one and must keep its placeholder — the reason `BoardView`'s `stripRuns`
and `runningRuns` are two separate lists today. It goes in `expired()`, the
shared predicate, and therefore `sweep()` deletes rather than merely hiding:
list and sweep agreeing by construction is the property that service is built
around, and the cost is that a crashed run aborted seconds after a mark loses a
placeholder for a session that had already hit `init` and died. Rule 1 is
untouched — a legitimately landed run still evicts on `startedAt >=
requestedAt`, and both rules firing on the same entry is fine.

Migrate `BoardView.tsx:336`'s comment onto this rule; it already explains the
case better than a fresh comment would.

**2. Delete `BoardView`'s `startingRuns` filter**, mapping the strip over
`starting` directly. The payload now guarantees what the filter was asserting,
and keeping both would be the two-agreeing-expressions shape this repo pins
tests against everywhere else (`watchdogStoodDown`, `isStale`).

**3. Widen `runClaimBlock` to `(item, runs, starting)`, third parameter
required** — no default, for the reason `isStale`/`leavesBoard` take `runs`
with no `[]` default: the compile error at every call site is the mechanism
that makes the next caller decide instead of silently reinheriting this bug.
Body keeps `runEntryAt` untouched and appends the coarse clause after it:

    const claimed = runEntryAt(item, runs, RUN_CLAIMED_STAGES);
    if (claimed !== null) return `an orchestrator run is working this item (${claimed.stage})`;
    return starting.some((s) => s.project === item.projectPath)
      ? 'an orchestrator run is starting for this project'
      : null;

Per-item first: the two are mutually exclusive once rule 1 lands, but the
specific wording must win if they ever are not. The project match is the same
absolute-registry-path compare `runEntryAt` documents — never a display name,
never anything derived from `item.path`. Name unchanged: a starting run is a
run, and the question the function answers ("why does a run forbid dispatching
this item") has not moved.

`runHoldsItem` deliberately does NOT gain the parameter. Its caller is
`isStale`/`leavesBoard`, asking "is a run holding this item", which a
placeholder naming no items cannot answer; and the window it would affect is
≤15 minutes against a 30-day staleness threshold, so an item it would newly
protect was already in Archive a minute earlier. Pinned by a test rather than
left as prose.

**4. Feed all four callers.** `BoardView.tsx:513` and `ArchiveView.tsx:192`
pass the hook's `starting` (Archive's line 108 destructure grows to `{ runs,
starting }`); `agents.service.ts:283` and `:344` destructure once —
`const { runs, starting } = this.orchestrator.runs();` — instead of
`.runs`. The dispatch 409 at :344 keeps its uncoded 409 and its existing
comment's reasoning verbatim; only the reason string it relays can now be the
new one.

**5. Hide the toolbar Orchestrate control on a starting entry.** Extend the
fourth condition at `BoardView.tsx:488/489`:

    const orchestrateBusy =
      freshRuns.some((run) => run.project === projectValue) ||
      starting.some((s) => s.project === projectValue);

Hide, never disable — that is what preserves bug-16's `showOrchestrate`
reasoning, which relies on a *rendered* toolbar button being blocked on project
visibility alone, so `useReverify`'s single-question click stays correct
untouched.

**6. Lock the endpoint.** In `AgentsService.orchestrate`, at the existing
`activeRun` check (`agents.service.ts:455`), read both halves of the one
`runs()` call and refuse a starting project with the SAME
`code: RUN_IN_PROGRESS_CODE`:

    { error: 'a run is already starting for this project', code: RUN_IN_PROGRESS_CODE }

Same code because it is the same lock one window earlier, and because
`OrchestrateSheet` branches on that code to `refresh()` + `onClose()` — which is
exactly the right behaviour here: the sheet closes and hands the screen to the
`StartingStrip` that is already rendering. `RUN_IN_PROGRESS_CODE` stays the
app's only coded 409; this is a second occasion for it, not a second code.
Position it beside the `activeRun` throw and therefore still *before*
`resolveIds`, for the reason that ordering comment already gives: a stale tab
whose selection has since been archived must be told a run is in progress, not
that `task-3` is not open.

### Test cases

Jest, `pnpm test`. No new suite files needed — each lands in the suite that
already owns its surface.

`test/orchestrator-starting.test.ts` (`StartingRunsService`):
- a marked project whose only run is `status: 'running'` with `startedAt`
  BEFORE `requestedAt` (the crashed case rule 1 misses) is absent from `list()`.
- the same entry is deleted by `sweep()` — list and sweep agree.
- a marked project whose only run is `paused` IS listed; likewise `done`,
  `aborted`, `failed`, each with `startedAt` before `requestedAt`.
- a `running` run belonging to a DIFFERENT project leaves the entry listed.

`test/agents-shared.test.ts` (`runClaimBlock`):
- `runs: []`, `starting: [{ project: <item.projectPath> }]` →
  `'an orchestrator run is starting for this project'`.
- starting entry naming another project → `null`.
- a fresh run holding the item at `dispatched` AND a starting entry for the
  same project → the per-item wording with `(dispatched)`, not the coarse one.
- every existing case re-passes with `starting: []` and its answer unchanged.
- `runHoldsItem(item, runs)` with a starting entry present in the payload is
  still `false` — the deferral, pinned.

`test/orchestrator-start.test.ts` (`POST /api/agents/orchestrate`):
- with a starting entry marked for the project and no run file at all: 409,
  body carries `code: RUN_IN_PROGRESS_CODE`, and the dashboard spawn is never
  called.
- starting entry for a different project → 200 and one spawn.
- with a starting entry AND an `ids` list naming an id that is not open: the
  409 is the coded lock one, not the id 409 (ordering).

`test/agents-dispatch.test.ts` / `test/agents-plan.test.ts`:
- dispatch of an open bug whose project has a starting entry → 409 carrying the
  starting reason, uncoded.
- `plan` for that item returns `blocked` set to the starting reason.

`test/starting-strip.test.tsx` / `test/board.test.tsx`:
- payload `{ runs: [], starting: [<filtered project>] }`: every card's dispatch
  control is `aria-disabled="true"` with the starting reason, and the toolbar
  Orchestrate control is not in the document.
- the existing "renders the crashed strip and NOT the placeholder" case moves
  to the service suite as rule 3's test; the BoardView case it leaves behind is
  that a payload carrying both still renders one strip — now because the server
  never sends that pair, so the fixture drops the starting entry.
- next poll lands a run file whose queue holds the item at `dispatched`: the
  card's reason becomes the per-item wording and the toolbar stays hidden.

`test/archive.test.tsx`:
- a stale groomed open bug rendered in Archive, project has a starting entry →
  its dispatch control is disabled with the starting reason.

In the browser (playwright MCP tools): with the stack up (`pnpm run dev` +
`pnpm run dev:web`, or `pnpm run docker:up`) and `BM_AGENTS` on with the
dashboard reachable — if it is off there are no dispatch controls at all and
this check cannot run, so say so and fall back to the jest suite above — open
`http://localhost:5177`, pick this project in the Board toolbar's Project
filter, and confirm the Orchestrate button is present and the bug/task cards'
dispatch controls are enabled. Then `browser_evaluate` a patch over
`window.fetch` that answers any `/api/orchestrator/runs` URL with
`{ runs: [], starting: [{ project: '<this project's absolute registry path>',
requestedAt: new Date().toISOString() }] }` and dispatch `new Event('focus')` on
`window` to force one refetch through it. A `starting <name>` strip must appear
above the columns, the toolbar Orchestrate button must be gone from the
document, and every card's dispatch control must read `aria-disabled="true"`
with the title `an orchestrator run is starting for this project`. Restore the
original `window.fetch` and fire one more focus event: the strip disappears and
both controls come back. Before this fix the strip appears and nothing else
changes at all.

## Notes

Two things grooming has to rule on rather than assume, both consequences of
task-14's own declared scope ("carries no ids and no merge mode, declined as
scope"):

- **A starting entry names no items.** It has `project` and `requestedAt` and
  nothing else, so a block derived from it cannot be per-item the way
  `runClaimBlock` is. Either the block is project-wide and conservative (every
  dispatchable item in that project, for at most `RUN_STALE_MS`), or task-14's
  `ids` deferral is reopened so the placeholder carries the selection the sheet
  already sent. The first is a smaller change and over-blocks a subset run; the
  second puts the run's item list in server memory before the run exists.
- **Whether the server lock is part of this.** The client-side hide alone stops
  the board from double-spawning, but `POST /api/agents/orchestrate` is the
  layer that actually enforces one-run-per-project (CLAUDE.md: "One run per
  project, checked twice"), and right now its half of that check has a window
  in which it is blind — while the same process is holding the entry that
  proves a run is on its way.

Both symptoms are the gating half of the `starting` gap. The Runs view not
showing a starting run at all is the visibility half, filed separately.

## Outcome

2026-09-06 — fixed as planned, all six steps, no deviation from the approved
shape and no scope added. `starting` is now read by every gate that reads
`runs`, and the crashed-project subtraction moved off the board into the
service where all of them inherit it.

What landed:

1. **`StartingRunsService.expired()` gained rule 3** — an entry is dead while
   any run for that project reads `status: 'running'`, fresh or crashed. Keyed
   on that status exactly, so `paused`/`done`/`aborted`/`failed` (all archived
   by `cmdInit`) still keep their placeholder. In `expired()`, so `sweep()`
   deletes rather than merely hiding.
2. **`BoardView`'s `startingRuns` filter deleted**, the strip mapping
   `starting` directly. That orphaned `runningRuns`, whose only reader it was,
   so that binding went too and its reasoning was folded into `stripRuns`'
   comment — the `running`-versus-`paused` distinction it drew is exactly what
   rule 3 is keyed on, and is recorded there.
3. **`runClaimBlock(item, runs, starting)`** — third parameter required, no
   default. Per-item wording first, the coarse project-wide clause second.
4. **All four callers fed**: `BoardView`, `ArchiveView`, `plan`'s `blocked`,
   dispatch's 409. The two server sites now destructure
   `const { runs, starting } = this.orchestrator.runs()` instead of `.runs`.
5. **Toolbar Orchestrate hides** on a starting entry (`orchestrateBusy`),
   never disables — bug-16's `showOrchestrate` reasoning intact.
6. **`POST /api/agents/orchestrate` refuses** a starting project with the same
   `RUN_IN_PROGRESS_CODE`, beside the `activeRun` throw and so still before
   `resolveIds`.

`runHoldsItem` deliberately unchanged; the deferral is pinned by a test
(`runHoldsItem.length === 2`) rather than left as prose.

Two things the plan did not foresee, both handled without changing its shape:

- Three existing `orchestrator-starting` cases and one `question-mode` case
  broke on the new behaviour rather than on a defect. The three read rule 1
  through the shared fixture, whose `status` is `running`, so rule 3 answered
  before rule 1 could — each was re-scoped to a `done` run so it still
  isolates rule 1. The `question-mode` case made three successive successful
  spawns for one project inside one `it`, which is precisely what the new lock
  forbids; split into three cases, each with its own app from `beforeEach`, all
  assertions unchanged.
- CLAUDE.md's `starting` invariant said the board renders the strip "only when
  the project has no `running` run at all" and listed two eviction rules. Both
  sentences were made false by this fix, so that invariant was rewritten (three
  rules, no client filter) and a new one added for the gating contract.

The browser check in Test cases was NOT run, deliberately. The stack on this
machine is up in Docker on 4322/5177 serving `main`, not this worktree, so it
would have exercised the unfixed code; and standing up a second API instance
during a live orchestrator run arms a second watchdog, which spawns `--resume`
sessions. The jsdom suites assert the same things that check does (strip
present, every dispatch control `aria-disabled="true"` with the starting
reason, toolbar Orchestrate absent from the document, and the per-item wording
once the run file lands).

Verification — every new test proven load-bearing first by neutering all four
production changes and re-running the suite (8 suites, 15 tests red), then
restored:

    $ pnpm run typecheck
    $ tsc --noEmit
    (no output — clean)

    $ pnpm test
    Test Suites: 76 passed, 76 total
    Tests:       1469 passed, 1469 total
    Snapshots:   0 total
    Time:        76.141 s

    $ pnpm run test:skills
    # tests 406
    # pass 406
    # fail 0

    $ pnpm run build
    dist/assets/index-BhbhSkiK.js   340.53 kB │ gzip: 103.73 kB
    ✓ built in 1.29s

### Review round 1 — prose corrected

`backlog-reviewer` returned `fix` on one Important finding, and it was right.
No behaviour changed in this round; four prose sites did.

The finding: the fix reused `RUN_IN_PROGRESS_CODE` for a second occasion —
argued in the new block's own comment and in the new invariant — while two
OLDER statements went on saying that a second coded 409 on this route would be
a mistake. Both sat where a reader looks first.

- **`server/src/agents/agents.service.ts`** — the `activeRun` throw's `code`
  comment enumerated "FOUR distinct 409 reasons" and said the code was "sent
  ONLY on this one 409 — every other throw in this method … deliberately left
  without one". Four lines below it, the new starting lock sends the same
  code. Rewritten: the tally is **removed rather than incremented** (it is the
  same hand-maintained-count drift the origin-guard invariant already records
  going stale once inside a single branch), and the load-bearing claim is
  restated correctly — the code means "a run for this project is alive right
  now" and rides exactly the two throws that mean that, the `activeRun` lock
  and the starting lock beside it. The starting block's own comment now points
  back at its neighbour, so neither side can drift alone.
- **`CLAUDE.md`, "One run per project, checked twice"** — still said the
  endpoint re-checks "only against a *fresh* run" and codes "that lock case
  alone". Both false since this fix. Rewritten so the re-check is two
  conditions (fresh run file, or a starting entry), a stale run file is still
  explicitly not a refusal here, and the coded 409 names both occasions with
  the reason one code covers both.

Three Minor drifts from the same change, fixed in the same pass because each
is a sentence made false by rule 3:

- `starting-runs.service.ts` (class comment and `expired()`'s "when either
  holds"), `orchestrator.service.ts` and `orchestrator.controller.ts` all said
  `list` re-applies "both eviction rules". There are three.
- `test/orchestrator-start.test.ts`'s case name ended "and only there", which
  the sibling case added four cases below contradicts. Name trimmed; no
  assertion touched.
- `BoardView`'s strip comment claimed the payload guarantees the two maps can
  never both draw a row for one project. Rule 3 is keyed on `running` while
  `stripRuns` is `running || paused`, so a stale-`paused` run plus a live
  starting entry renders both — reachable, and correct (two different runs).
  The claim is now narrowed to the collision rule 3 actually covers, which is
  the one the deleted client filter existed for.

Re-verified after the prose round:

    $ pnpm run typecheck
    $ tsc --noEmit
    (no output — clean)

    $ pnpm test
    Test Suites: 76 passed, 76 total
    Tests:       1469 passed, 1469 total
    Snapshots:   0 total
    Time:        68.566 s

    $ pnpm run build
    dist/assets/index-B3AaWIr7.js   340.53 kB │ gzip: 103.74 kB
    ✓ built in 1.47s

### Review round 2 — the claim removed everywhere, not corrected site by site

`backlog-reviewer` returned `fix` again: the same stale claim at a third site,
`shared/types.ts`'s `RUN_IN_PROGRESS_CODE` doc comment — which round 1's own
rewrite names as the authority a reader should follow. It said the code is
"present ONLY on the activeRun-lock refusal … never on that endpoint's other
409s", so a reader following that pointer landed on the one statement saying
this branch's decision was a bug, and removing the starting lock's `code` would
have cost `OrchestrateSheet`'s close-and-hand-to-the-strip behaviour.

Round 1 corrected two sites and a third was still wrong. That is the diagnosis:
correcting occurrences of a tally is not a fix, because a tally kept in N places
goes stale N times. So this round removes the class rather than patching the
instance.

**One rule, stated in one place.** `shared/types.ts`'s doc comment was rewritten
to say what the code MEANS — "a run for this project is alive right now" — and
that this is **one code, not one occasion**: three refusals send it today
(orchestrate's `activeRun` lock, orchestrate's starting lock, `resume()`'s
fresh-run refusal, the last of which has sent it since bug-19 and which the
comment also mis-stated, pre-existing debt fixed in the same pass). It now says
outright that no other site enumerates where the code appears or counts a
route's 409 reasons, and why: that tally had gone stale in five files across two
branches, which is the failure CLAUDE.md's origin-guard invariant already
records for its own route list.

Every other site was then rewritten to assert the MEANING and stop counting —
found by grepping the whole repo for both patterns, per the review's
instruction, and re-grepped afterwards to prove none survives:

- `shared/types.ts` — the authority, rewritten (above).
- `server/src/agents/agents.service.ts` — four sites: dispatch's uncoded-409
  comment ("one and only coded 409 in this app"), `resume()`'s reuse rationale
  (enumerated "both" refusals), `resolveIds` ("the one coded 409 this endpoint
  has"), `resolveMergeMode` (pointed at the activeRun throw as the sole
  sender), plus the ordering comment at the `resolveIds` call ("the activeRun
  lock is the only 409 this endpoint codes") — and round 1's own replacement
  text, which had itself counted ("bug-21 added a fifth reason").
- `client/src/lib/agents.ts` — "answers 409 for four genuinely different
  reasons", "every response except that one endpoint's activeRun-lock 409".
- `client/src/components/board/OrchestrateSheet.tsx` — "on the lock 409 ONLY";
  now says both of that endpoint's locks answer with it and that closing into
  the strip world is right for both (Minor 2, which the review listed as
  defensible and not required — corrected anyway, since this pass exists to
  leave no site that could become the fourth).
- `docs/subsystems/invariants.md` — two sites: the `ids` 409 rationale, and the "One run
  per project" long form's "the only one `orchestrate()` throws that carries a
  `code`".
- Five test suites — `orchestrator-start`, `orchestrator-start-ui`,
  `merge-mode`, `question-mode`, `agents-dispatch` — all comment text; no
  assertion, name or fixture touched.
- `CLAUDE.md` — Minor 1: "rule 3 is what guarantees one row per project"
  narrowed to the collision rule 3 actually covers, with the `paused` case
  spelled out and an explicit warning against widening rule 3 to include it
  (which would strip the placeholder from a project that can legitimately
  start a run). `BoardView`'s comment already said this after round 1; the
  invariants file now agrees.

Round 2's Minor 3 needed no action and got none: three pre-existing
`orchestrator-starting` cases now have both rule 1 and rule 3 answering, but
the properties they pin (project scoping, purity, sweep-deletes) still hold,
and the three cases where the ambiguity would have lost rule-1 coverage were
already re-scoped to `done` in the first round.

Comment-only round. No expression, statement, assertion or test name changed.

    $ pnpm run typecheck
    $ tsc --noEmit
    (no output — clean)

    $ pnpm test
    Test Suites: 76 passed, 76 total
    Tests:       1469 passed, 1469 total
    Snapshots:   0 total
    Time:        78.915 s

    $ pnpm run build
    dist/assets/index--XYYGF4N.js   340.53 kB │ gzip: 103.74 kB
    ✓ built in 1.42s
