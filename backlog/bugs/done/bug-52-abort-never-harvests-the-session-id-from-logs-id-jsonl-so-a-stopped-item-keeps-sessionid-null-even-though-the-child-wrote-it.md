---
id: bug-52
title: abort never harvests the session id from logs/<id>.jsonl, so a stopped item keeps sessionId null even though the child wrote it
created: 2026-09-22
updated: 2026-09-22T19:14:48Z
started: 2026-09-22T19:05:28Z
execute-elapsed: 560
execute-tokens: 68145
---

## Symptom

An item stopped at `dispatched` ends the run with `sessionId: null` on the run file and on the claim, even though the dispatched child started
normally, wrote its `system`/`init` event into `<dir>/logs/<id>.jsonl`, and left a transcript under `~/.claude/projects/`. Nothing afterwards ever
reads that id, so the run's own record of which session did the work is lost the moment the run ends. `retro.mjs`, which resolves a run's cost and
transcript by recorded lease id, has nothing to resolve; the board's run detail shows a dispatched item with no session to open.

`pid` does NOT have this problem, and the asymmetry is the whole bug: bug-43 taught `--abort` to recover the pid from `<dir>/logs/<id>.pid` when the
run file's own field is null. The session id sits in the sibling file in the same directory, written by the same dispatch, and is left there.

Observed on guide-manager issue #5 three times in one afternoon — run-20260922-141510 (Linux), run-20260922-143525 (Linux), run-20260922-144041
(Mac). All three end `stage: dispatched`, `sessionId: null`. Only the Mac one was reconstructible end to end, and it is the evidence below.

## Repro

Run `run-20260922-144041`, guide-manager issue #5, stopped from the board:

| time (Z)    | event                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| 14:41:22.3  | driver adds worktree `.worktrees/5`, branch `backlog/5`                                                        |
| 14:41:24.7  | first `stage 5 dispatched` (no pid) succeeds — `stageAt.dispatched` recorded                                   |
| 14:41:45.8  | dispatch block launches `claude -p`, records pid 68898 into `logs/5.pid`                                       |
| ~14:42:01.3 | stop requested → second `stage 5 dispatched --pid` refused, `stage_exit=10`, driver goes to recovery           |
| 14:42:05    | child transcript `6924d9fa-4f8b-4d9e-b644-2b36b55efa54.jsonl` appears under the worktree's project dir          |
| 14:42:12    | `logs/5.jsonl` last write — line 4 is `{"type":"system","subtype":"init","session_id":"6924d9fa-…"}`            |
| 14:42:13.5  | claim released, `reason: aborted`                                                                              |
| 14:42:19.0  | driver runs `--abort`                                                                                          |
| 14:42:28.1  | final run file write: `stage: dispatched`, `pid: 68898`, `sessionId: null`                                      |

The abort ran seven seconds after the last write to `logs/5.jsonl`. The id was on disk, in the file the tool already knows the path of, in the event
shape `findSessionIdInJsonl` already matches. `--abort` wrote the run file once more and did not look.

Note what this repro is NOT. `watch` never ran on this item: the stop landed inside the dispatch block, so the second `stage --pid` refused with `10`
and the driver skipped straight to recovery. `findSessionIdInJsonl` is called from `cmdWatch` and nowhere else, so on this path the discovery code is
never reached at all — see bug-50, whose narrower race sits inside the tick that this run never took.

## Affects

- `skills/backlog-orchestrate/tools/orchestrate.mjs:4756` — `cmdAbort`, the writer that finalises a stopped run and the one place positioned to do this
- `skills/backlog-orchestrate/tools/orchestrate.mjs:3805` — the pid-recovery comment: `logs/<id>.pid` FIRST, `item.pid` second (bug-43's fix), the exact
  shape this bug wants for the session id
- `skills/backlog-orchestrate/tools/orchestrate.mjs:3857` — `findSessionIdInJsonl`, already written, already correct, currently reachable only from
  `cmdWatch`
- `skills/backlog-orchestrate/tools/orchestrate.mjs:2190` — the `logs/<id>.pid` path helper; `logs/<id>.jsonl` is its sibling and is passed to `watch`
  as `--jsonl`

## Cause

`--abort` finalises the run from the run file plus one sidecar, `logs/<id>.pid`. The session id has no equivalent recovery step, so it is only ever
written by a `watch` tick that completed after the child's init event landed. Every stop that lands before that tick — which is every stop in the first
minute of an item, the window a person actually stops in — ends with the field null, while the value sits unread in `logs/<id>.jsonl`.

The reason it looks like a race but is not: the id is not lost to timing, it is never read. The dispatch and the abort are the two ends of the same
call sequence, in the same process, against the same directory. The file is closed and complete by the time abort runs.

## Fix

Give `--abort` the same two-rung recovery for the session id that it already has for the pid: prefer the run file's own `sessionId` when it is set,
otherwise read `<dir>/logs/<id>.jsonl` with `findSessionIdInJsonl` and persist what it returns before the final write. A missing or unreadable jsonl
leaves the field null exactly as today — this adds a recovery, never a failure. The same harvest should run for whichever item is at `dispatched`,
not only the one named on the command line, so a multi-item queue does not lose ids for items already finished.

Decide, and say so in the item rather than leaving it to the implementer: whether `finish --status paused` should harvest too. The same window exists
for a park, and the argument for sharing the code is that the id is equally lost; the argument against is that a parked item's `watch` usually did tick
and the field is usually already set. Pick one; do not add a second half-answer.

## Done when

- `--abort` on an item at `dispatched` with `sessionId: null` and a `logs/<id>.jsonl` holding an init event ends with that id on the run file
- `--abort` with no `logs/<id>.jsonl`, an empty one, or one with no init event still ends `aborted` with `sessionId: null` and no thrown error
- a run file that already carries a `sessionId` is not overwritten by a different id read from the log
- test cases live in `skills/backlog-orchestrate/tools/orchestrate.test.mjs` beside the tool, per the node-runner convention, and cover the three above
  plus a two-item queue where an earlier item's id must survive the abort of a later one

## Outcome

2026-09-22 — Cause confirmed live: `cmdAbort` recovered the pid from `logs/<id>.pid` (bug-43) but nothing on the abort path read `logs/<id>.jsonl`, and
`findSessionIdInJsonl` was reachable only from `cmdWatch`. Fixed by adding `dispatchJsonlPath` (beside `dispatchPidPath`) and `resolveItemSessionId` (beside
`resolveItemPid`) in `orchestrate.mjs`, and a harvest loop at the top of `cmdAbort` — before the signal loop, the teardown and the tracker claim releases —
that sets every queue item's `sessionId` to the recorded value if one is set, otherwise to what `findSessionIdInJsonl` finds in `<dir>/logs/<id>.jsonl`,
otherwise `null`. Any read failure (missing, a directory, empty, no init event, an unterminated init line) is caught and reads as no answer. It runs over the
whole queue, not only non-terminal items: an id is a record, not an address, and a recorded one is never replaced.

Decision on `finish --status paused`: it does NOT harvest, and `cmdFinish` stays a pure status write. A park is decided from `watch`'s own exits, so the parked
item's tick has normally already read the id; abort is the exit that ends a run on the path where `watch` never ran. Recorded in the code comment,
`docs/subsystems/invariants.md` and here.

Scope left on purpose: only the first dispatch's `logs/<id>.jsonl` is read, not `<id>-retry-<n>.jsonl` — a retry's id reaches the run file through that
retry's own `watch`, and bug-50's stop-tick write still covers a `watch` pointed at any other file (its comment now says so).

Tests (`skills/backlog-orchestrate/tools/orchestrate.test.mjs`, the `bug-52` block after the bug-43 cases): harvest from the log; missing / directory / empty /
non-JSON / init-less / unterminated-init log leaves `null` and still ends `aborted`; a recorded id is not overwritten; two-item queue where a merged item's
recorded id survives while the stopped later item's id is harvested; SKILL.md seam test that the §4 launch line still redirects to `"<dir>/logs/<id>.jsonl"`.

```
$ node --test --test-name-pattern="bug-52" skills/backlog-orchestrate/tools/orchestrate.test.mjs
# pass 5
# fail 0

$ pnpm test
Test Suites: 129 passed, 129 total
Tests:       2188 passed, 2188 total
# tests 784
# pass 784
# fail 0
PASS  jest
PASS  node --test (skills)
pnpm test: both runners passed.

$ pnpm run typecheck
typecheck exit 0
```

Contract sweep: 7 sites updated (skills/backlog-orchestrate/tools/orchestrate.mjs bug-50 comment "`stage --session` (the only other writer of the field)", docs/subsystems/invariants.md bug-50 bullet same claim + new bug-52 paragraph, .claude/rules/orchestrator.md abort mechanism, skills/backlog-orchestrate/SKILL.md abort section "Three things" → "Four" + bullet, skills/backlog-orchestrate/references/recovery.md abort walk, shared/types.ts `RunQueueItem.sessionId` doc)
Red proof: 4 tests went red with the change reverted — harvest loop removed: "abort harvests the session id…" and "aborting a later item…" red; recorded-id early return removed: "a session id the run file already carries…" and "aborting a later item…" red; try/catch removed: "a missing, empty or init-less log…" red. The SKILL.md seam test pins existing launcher text, not a production change, so it has nothing to revert.
