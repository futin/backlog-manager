---
id: bug-43
title: A stop that lands between the two stage dispatched calls leaves pid null on the run file, so abort from a dead driver cannot signal the child
created: 2026-09-21
tags: orchestrator, stop, abort, pid
runner-fix: true
updated: 2026-09-21T12:00:37Z
groom-elapsed: 279
groom-tokens: 64415
started: 2026-09-21T11:35:39Z
execute-elapsed: 1498
execute-tokens: 105963
---

## Symptom

SKILL.md's dispatch step is two `stage <id> dispatched` calls: one with `--worktree`/`--branch`/`--permission-mode` BEFORE the child is spawned, then, once
`logs/<id>.pid` exists, a second with `--pid`. A stop request that lands in that window makes the second call exit `10` (`stage` refuses every transition
under a stop), so `RunQueueItem.pid` stays `null` while a `claude -p` child is running. `cmdAbort` signals only the pids the run file carries — both abort
sessions on 2026-09-21 printed `abort: signalled 0 live session(s)` — so with the driver dead the child is orphaned: it keeps working in a worktree the abort
has just removed.

Observed 2026-09-21, run `run-20260921-091645` on `futin/test-claude-issues` (verification doc, Test 3): the stop was posted at 09:18:30, between the first
`stage 6 dispatched` (09:18:15) and the `--pid` call (09:18:44, refused). The child was killed only because the live driver ran `kill -TERM $(cat logs/6.pid)`
from `recovery.md` before its own `abort`.

## Repro

1. Start a run for one issue; watch `run.json` for `stage: dispatched` with `pid: null`.
2. `POST /api/agents/stop { project }` inside that window (seconds), then kill the driver.
3. The spawned abort session prints `signalled 0 live session(s)`; `ps -p $(cat <dir>/logs/<id>.pid)` still shows the `claude -p /backlog-execute` child.

## Affects

- `skills/backlog-orchestrate/SKILL.md` — the dispatch step (two `stage dispatched` calls around the spawn).
- `skills/backlog-orchestrate/tools/orchestrate.mjs` — `cmdStage`'s stop gate (exit `10` on every transition, including the same-stage `--pid` update) and
  `cmdAbort`'s pid source (the run file only; nothing reads `logs/<id>.pid`).

## Cause

Two decisions that are each right on their own, and a window in which they compose into a hole.

**The pid reaches the run file through a call the stop gate refuses.** `cmdStage`'s stop gate is deliberately wider than the pause gate beside it — every
stage, and every call rather than only a transition — so the `--pid` line, which is by construction a re-stamp of the stage the item already occupies, is
refused with exit `10` like anything else. The comment justifying that width states the reason the pause gate's re-stamp exemption does not carry over: under
a stop "that child is about to be killed by `watch` (or is already gone)". That premise is what this bug falsifies. `watch` kills the child only while a live
driver is polling it, and a force stop exists precisely for the case where the driver is not — `POST /api/agents/stop` accepts a run that is `running` fresh
**or stale**, and then spawns an abort session whose whole job is to reach what the dead driver left behind.

**`cmdAbort` has exactly one pid source, and it is the run file.** Its signal loop reads `item.pid`, and an item carrying `null` is skipped by the
`Number.isInteger` guard before the three real guards are ever reached — silently, with no warning and no second look. That is what produced
`abort: signalled 0 live session(s)` twice on 2026-09-21 while a `claude -p` child was still working inside a worktree the same abort then removed.

The number was never actually lost. `<dir>/logs/<id>.pid` is written by `echo $! > …` in the same Bash invocation that backgrounds the child (SKILL.md §4, and
§5's retry line — reused by every fix loop — writes the same name), so it is on disk **before** the refused call, it is refreshed by every relaunch of that
item's child, and it survives the driver entirely. Nothing reads it, and that is a stated design decision rather than an oversight: SKILL.md §4 and
`invariants.md`'s `RunQueueItem.pid` paragraph both say "nothing scans `logs/`, which is why the number has to reach the run file". Bug-39 built the run-file
copy on the assumption that the driver would always be able to write it; the stop gate is the one thing in the system that stops it, and bug-39 added both.

So the window is wider than the two-call gap the Symptom describes. It is **any** stop landing after the first `stage <id> dispatched` succeeds and before the
`--pid` call completes — including the driver simply being killed in that gap and never making the call at all, which leaves no exit `10` anywhere to explain
the `null` afterwards. It reopens on every retry and fix-loop relaunch, since each one re-spawns a child and re-runs the same refusable `--pid` line.

## Fix

Give `cmdAbort` the second pid source the fact on disk already offers, and leave the stop gate exactly as wide as it is.

**Read `<dir>/logs/<id>.pid`, and prefer it to the run file's copy.** That file is written by the same invocation that spawns the child, so it is always the
freshest address for that item's live child and the run-file copy is only ever a copy of it. The two can only disagree when a `stage --pid` was refused after
a relaunch rewrote the file, and in that case the run file names a child that has already exited (a retry line runs only once `watch` has returned on the
previous one). It cannot be a *previous run's* file: `archiveSidecars` moves the whole of `logs/` into `runs/<stem>/` at the next `init`, and `init` refuses
any run still reading `running` with exit `4` — so `<dir>/logs/` always belongs to the run being aborted (`invariants.md`, "Why moving a live child's pid file
is safe").

1. **`orchestrate.mjs` — a path helper**, beside `outcomeFilePath`/`snapshotFilePath` and in the same shape: `dispatchPidPath(dir, itemId)` →
   `<dir>/logs/<itemId>.pid`. One place names the file the tool now depends on.
2. **`orchestrate.mjs` — a resolver**, `resolveItemPid(dir, item)`: read and trim `dispatchPidPath`, `Number(...)` it, and return it when it is a positive
   integer; otherwise fall back to `item.pid` when *that* is a positive integer; otherwise `null`. Unreadable, empty, whitespace-only and non-numeric contents
   are all "no answer from the file", never a throw — the same posture the rest of `abort` takes toward sidecar evidence. The fallback is kept for the run
   whose `logs/` a person has cleared by hand.
3. **`orchestrate.mjs` — `cmdAbort`'s signal loop** takes its pid from `resolveItemPid(dir, item)` instead of `item.pid`. **The three guards are unchanged, in
   the same order and with the same bias** (non-terminal by `RECONCILE_TERMINAL_STAGES`, `pidAlive`, then `ps -o args= -p <pid>` naming a `claude` process) —
   a number that came out of a file deserves them at least as much as one that came out of the run file, and the `ps` guard is what keeps a stale file from
   ever signalling a stranger.
4. **`orchestrate.mjs` — record what was signalled.** When the signalled pid came from the file, set `item.pid` to it before the `writeRunAtomic(dir, run)`
   that `cmdAbort` already makes, so the journal of record holds the address that was actually used and `signalledIds` stays reconcilable from `run.json`
   alone. Only on a pid that passed all three guards and was signalled: a number that failed them is exactly what `--pid`'s own validation comment calls worse
   than no pid at all, and writing it would put a wrong address in the field on purpose.
5. **`orchestrate.mjs` — correct the two comments that state the falsified premise**, or the next reader re-derives the wrong reason from them. The stop gate's
   comment must say the gate stays wide *because* abort no longer depends on a driver call for the address (rather than because `watch` will handle the
   child), and `cmdStage`'s `--pid` comment must stop claiming `logs/` is a place nothing can read.
6. **`skills/backlog-orchestrate/SKILL.md` §4** — the paragraph under the `--pid` line currently reads "nothing scans `logs/`, so without this the run file
   holds no address for the child at all and a force stop cannot reach an orphaned executor". That is no longer true and is the sentence a future edit would
   trust. Rewrite it: the call still runs and is still wanted (it is what `status --json` and a person reading the run show), but it is now the *second* copy —
   a stop landing in this window refuses it with exit `10` and the child is still reachable, because `abort` reads the pid file the line above already wrote.
   The dispatch and retry lines themselves do not change.
7. **`docs/subsystems/invariants.md`** — the `RunQueueItem.pid` paragraph under the stop anchor gains the second source, the precedence (file first), and the
   reason the gate was *not* narrowed instead. **`CLAUDE.md`**'s stop invariant gains the same clause in one sentence: the pid is written by
   `stage <id> dispatched --pid <p>` and, when the stop gate refused that call, resolved by `cmdAbort` from `<dir>/logs/<id>.pid`.

### Test cases

All in `skills/backlog-orchestrate/tools/orchestrate.test.mjs`, beside the existing bug-39 abort cases, reusing `orchFixture`, `seedReadyTask`, `run`,
`runFile`, `seedSidecar` and `spawnFakeClaude` (the fake is what makes the `ps … claude` guard pass without a real session).

- **A pid that reached only the file is signalled.** Stage an item `dispatched --worktree /w --branch b` with **no** `--pid`, seed `logs/<id>.pid` with a live
  fake-claude pid. `abort` exits `0`, stdout matches `signalled 1 live session(s)` and names `<id> (pid <n>)`, and the child exits on `SIGTERM`.
- **The whole bug, end to end, through the real gate.** Same setup, but write the stop control file after the first `stage <id> dispatched` and then assert
  `stage <id> dispatched --pid <n>` exits `10` with `queue[].pid` still `null` — and that `abort` signals the child anyway. The gate and the fallback have to
  be proved to compose; either half alone is green on the shipped code for the wrong reason.
- **The file wins over a stale run-file pid.** Record fake-claude A with `--pid`, kill it and await its exit, put live fake-claude B's pid in `logs/<id>.pid`.
  Stdout names B's number, B takes the `SIGTERM`, and the run file's `pid` reads B afterwards (case 4).
- **The three guards still bind a file-sourced pid.** Terminal stage (`merged`) with a live pid in the file → `signalled 0`, child still alive. A live
  **non-claude** process's pid in the file (a plain `sleep 30`, as the existing pid-reuse case does) → `signalled 0`, `killed === false`.
- **Garbage in the file is not an error.** `nope`, empty, whitespace-only, `0` and `-1` each give `signalled 0` and exit `0`; with a valid `item.pid` also
  recorded, the recorded one is still signalled — the fallback of case 2.
- **The existing bug-39 cases stay green unmodified** — a recorded pid with no file present is still signalled, and a terminal item's recorded pid is still
  left alone.
- **A source guard on the seam.** SKILL.md must still write the pid to the name the tool now reads: assert `echo $! > "<dir>/logs/<id>.pid"` appears on both
  headless launch lines (§4's dispatch and §5's retry — two occurrences, the same count the existing `dispatchNames()` guard asserts for `exec claude -p`). A
  prose edit that renames that file would otherwise blind `abort` silently, and no behavioural test in this suite reads SKILL.md's launcher.

### Non-goals, each considered and declined

- **Narrowing the stop gate** so a same-stage `--pid` re-stamp is let through. It fixes only the shape where the driver survives long enough to make the call,
  which is the *less* dangerous half — the driver that is killed in the same window never makes it at all, and that is the case a force stop is for. It buys
  nothing the file fallback does not already buy, and costs a hole in a rule currently stated in one sentence ("`stage` refuses EVERY transition with exit
  `10`"). The gate stays as written.
- **`verify/<id>.pid` as a third source.** That pid is deliberately the wrapper `sh`, not a `claude` process (SKILL.md §8 omits `exec` so the wrapper survives
  to write `.status`), so the `ps -o args=` guard would refuse it by construction — reaching it needs a different guard *and* a separate decision about killing
  a project's own test suite mid-run. A real gap, and its own item.
- **Teaching `reconcile` the pid file.** It is a read-only report and signals nothing; the address matters only where a signal is sent.

## Outcome

2026-09-21 — fixed as planned: `cmdAbort` gained the second pid source and the stop gate was left exactly as wide as it was.

`orchestrate.mjs` now carries `dispatchPidPath(dir, itemId)` beside `outcomeFilePath`/`snapshotFilePath`, and `resolveItemPid(dir, item)` beside `pidAlive` —
the log file first, `item.pid` second, every failure of the file (missing, unreadable, empty, whitespace-only, non-numeric, `0`, negative, fractional)
falling through rather than throwing. `cmdAbort`'s signal loop takes its pid from the resolver with the three guards unchanged in the same order, and writes
back to `item.pid` only a pid that passed all three and was signalled, picked up by the single `writeRunAtomic` the command already made. The two comments
stating the falsified premise (`cmdStage`'s `--pid` flag comment and the stop gate's "about to be killed by `watch`") were rewritten to state the reason that
actually holds now, and the declined narrowing of the gate is recorded at the gate itself.

Verification, fresh, after every edit:

```
$ pnpm run typecheck
$ tsc --noEmit --tsBuildInfoFile node_modules/.cache/tsconfig.tsbuildinfo
(exit 0, no diagnostics)

$ pnpm test
Test Suites: 2 failed, 126 passed, 128 total
Tests:       3 failed, 2113 passed, 2116 total
# tests 691
# pass 691
# fail 0
FAIL  jest
PASS  node --test (skills)
```

The skills runner — which is where every case in this item lives — is 691/691. The three jest failures are **pre-existing and unrelated**: they are
`test/dispatch-button.test.tsx` (2) and `test/board-live-cards.test.tsx` (1), all failing on `Unable to find an element with the text: an idea` because the
fixture dates have aged past the 30-day stale threshold and the cards have left the Board for the Archive. That is bug-44, item 2 of this same run. Proved
not mine rather than assumed: `shared/types.ts` is the only file this diff touches that jest loads at all, and with it restored to `HEAD` (copy aside,
`git checkout HEAD --`, run, copy back) the same two suites fail the same three cases —

```
Test Suites: 2 failed, 2 total
Tests:       3 failed, 54 passed, 57 total
```

Contract sweep: 4 sites updated (`skills/backlog-orchestrate/SKILL.md` §4's paragraph under the `--pid` line;
`docs/subsystems/invariants.md`'s `RunQueueItem.pid` paragraph under the stop anchor; `CLAUDE.md`'s stop invariant; `shared/types.ts`'s `pid` doc comment,
which the plan did not list and which claimed `Number.isInteger` in `cmdAbort` makes an absent pid mean "nothing to kill" — no longer true, and it is the
comment a future reader of the type would trust). Swept for and deliberately left standing: the `logs/<id>.pid` mentions in `docs/subsystems/invariants.md`
§"Why moving a live child's pid file is safe" and `references/recovery.md` (both are about `init`'s exit-`4` lock making the archive move safe, which this
change does not touch — and that lock is exactly what the resolver relies on to know `<dir>/logs/` belongs to the run being aborted), SKILL.md §797's exit-`10`
note (about `watch` signalling by the pid it was given, still true), and the `done/` items bug-39, task-31 and idea-8 plus
`docs/superpowers/specs/2026-09-21-tracker-phase4-live-verification.md`, which are dated records of what was true when written.

Red proof: 3 tests went red with the change reverted — observed before the production code was written, which is stronger than a revert after the fact:

```
not ok 222 - abort signals a pid that reached only the log file, never the run file
not ok 223 - the whole of bug-43: the stop gate refuses the --pid call and abort reaches the child anyway
not ok 224 - the log file wins over a stale recorded pid, and the run file records what was signalled
# pass 321
# fail 4
```

The fourth red was the SKILL.md source guard, failing for a test-side reason (its filter also matched §8's `verify/<id>.pid` launcher, which this item's own
non-goals exclude); the filter was narrowed to `logs/` and it is green. Four of the nine new cases pass on the shipped code by construction and are recorded
here rather than claimed as red: the terminal-stage, pid-reuse and garbage-contents cases assert that the *existing* guards still refuse a file-sourced pid
(there is no behaviour to revert — before the change the file was never read, so they were green for the wrong reason, which is precisely why the end-to-end
case above exists), and the source guard pins an existing SKILL.md line the tool now depends on rather than a change this diff made.
