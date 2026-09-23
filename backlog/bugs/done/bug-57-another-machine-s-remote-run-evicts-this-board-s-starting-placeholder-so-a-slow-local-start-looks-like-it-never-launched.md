---
id: bug-57
title: Another machine's remote run evicts this board's starting placeholder, so a slow local start looks like it never launched
created: 2026-09-22
tags: orchestrator, tracker, board
updated: 2026-09-23T08:40:14Z
groom-elapsed: 116
groom-tokens: 39616
started: 2026-09-23T08:28:16Z
execute-elapsed: 718
execute-tokens: 46429
---

## Symptom

On a tracker project drained from two machines, a board's "starting" placeholder for a run it just spawned disappears as soon as the OTHER machine's run shows
up as a remote run — before this machine's own run file exists. The board then shows no local run at all until the spawned session writes its run file, so a
slow start (2 min on the Linux machine, 2026-09-22 — see bug-56) reads as a launch that silently failed.

## Repro

1. Machine A and machine B both on the same tracker project.
2. Start a run on B's board; B marks a starting entry at `requestedAt`.
3. Start a run on A before B's spawned session has written its run file.
4. Once B's poller derives A's run as a remote run with `startedAt >= requestedAt`, B's `/api/orchestrator/runs` drops the starting entry.

Observed 2026-09-22 on the Linux board during the bug-55 race: Linux `run-20260922-213421` had no visible placeholder while the Mac's `run-20260922-213302`
was live.

## Affects

- `server/src/orchestrator/starting-runs.service.ts:198-209` (`expired`, the `remoteRuns.some(landed)` arm)
- the rule's own comment just above it ("A remote run that started AFTER the mark is rule 1's")

## Cause

`expired()` rule 1 (`server/src/orchestrator/starting-runs.service.ts:207-208`) asks "has a run for this project started at or after the mark?" of
`realRuns` AND `remoteRuns`. The remote half is a false positive every time it fires, because a board-started spawn can only ever land on THIS machine:

- `AgentsController.orchestrate` marks the project only after the local dashboard (`BM_AGENTS_URL`, default `http://127.0.0.1:4173`) accepted the spawn, and
  the dashboard spawns in the registry's absolute path — a path on this host (`/Users/...` on the Mac, `/home/futin_ubuntu/...` on Linux), so no other
  machine's dashboard could even see the project.
- The spawned session's first write is `init`, which writes a LOCAL run file before it claims anything. Claims happen per item, after `init`, so a busy
  tracker queue on another machine never stops a local spawn short of `init`.
- `deriveRemoteRuns` excludes every run id this machine holds a run file for (`localRunIds`, `remote-runs.util.ts:168`), so a remote run is, by construction,
  never this machine's run.

So a remote run can never be the landing a mark waits for, and any remote run for the project with `startedAt >= requestedAt` — another machine that happened
to start in the window between this board's spawn and its `init` — evicts the placeholder. That window is short on a healthy start and ~2 minutes on a start
that hits bug-56's empty `$CLAUDE_PLUGIN_ROOT`, which is exactly the race this bug was seen in.

Why the `landed` arm was widened when the `running` arm was not: bug-51 misread its own evidence. It saw a Mac mark at 14:14:36Z sitting beside a Linux run
(`run-20260922-141510`, host `futin_ubuntu@<host>`, started 14:15:10Z) and concluded that run WAS the mark's landing — "a board-started run whose driver
ran on another machine". Given the spawn path above, it cannot have been: the Mac's own spawn had never reached `init` (had it done so, the local arm of rule 1
would have evicted the mark), and the Linux run was an independent launch that coincided with it. bug-51's reasoning for keeping rule 3 local ("the spawn this
entry was marked for can still land, and its placeholder must survive a remote run already in flight") is correct, and applies equally to rule 1: a remote run
that started AFTER the mark is no more this spawn's landing than one that started before it. The comment's last sentence, "A remote run that started AFTER
the mark is rule 1's", is where the two rules stop agreeing.

What bug-51 actually observed — a mark outliving a spawn that never reached `init` — is rule 2's case: `RUN_STALE_MS` is the designed backstop for "a
session that spawned but never reached init is a broken session". bug-51's fix retired that case early only when a coincidental remote run existed, and
bug-57 is the same mechanism firing on a spawn that was alive.

## Fix

Make rule 1 local-only again, and take the remote plumbing out rather than leave an unused parameter behind.

- `StartingRunsService.expired()`, `list()` and `sweep()` lose the `remoteRuns` parameter; rule 1 reads `realRuns.some(landed)` alone. Keep the injectable
  `now` and the no-timers property.
- `OrchestratorController.runs()` calls `list(payload.runs, now)` / `sweep(payload.runs, now)`; it still reads `remoteRuns.list()` for `payload.remote`, and
  one shared `now` for both starting halves stays.
- Rewrite the comments that carry bug-51's premise, citing bug-57 for why: rule 1's paragraph in `starting-runs.service.ts:130-147` (a board spawn lands only
  here, a remote run is excluded from local ids by construction, so no remote run is a landing), rule 3's closing sentence at `:196`, and the controller's
  "Read BEFORE the starting pair, since bug-51" paragraph plus the "the one they do lean on it for is the remote-run case" sentence above it
  (`orchestrator.controller.ts`) — with no remote retirement, the direct `runs()` callers again need no sweep for any rule.
- Docs, same edit: `.claude/rules/dispatch-watchdog.md` (the three-rules bullet, "or, since bug-51, a remote one ..."), and `docs/subsystems/invariants.md`
  around lines 1427 and 1442 (rule 1's "`runs` OR `remote`" and the sweep paragraph's "one exception is bug-51's remote" case). Keep the headline in CLAUDE.md
  byte-equal with the rules file (`test/claude-rules.test.ts`).
- State the accepted cost in rule 2's comment: a board spawn that dies before `init` keeps its placeholder for up to `RUN_STALE_MS` whether or not another
  machine is running — which is what bug-51 saw. Retiring such a mark early needs a signal about THIS spawn (for example the dashboard reporting the spawned
  session ended), not any other machine's run; that is a separate item, not part of this fix.

Tests:

- `test/orchestrator-starting.test.ts`: flip "drops the entry once a REMOTE run for that project started after it was marked" (line ~246) to KEEPS — a remote
  run started after the mark, `status: 'running'` and `'aborted'` both, leaves the entry listed. Flip the sweep case (line ~285) to "sweep keeps an entry
  whose only later run is remote". The before-the-mark, different-project and remote-running cases become redundant with those; fold them in or drop the
  remote argument from them. Existing local-run boundary cases pass unchanged.
- `test/orchestrator-runs.test.ts:492` ("a run that ran remotely retires the mark on one GET ... (bug-51)"): invert to the bug-57 repro — a mark, then a GET
  whose tracker cache yields a remote run for the same project with `startedAt` after `requestedAt`: `payload.starting` still lists the project, `payload.remote`
  still carries the remote run, and `OrchestratorService.runs().starting` is still non-empty after the GET. Then a local run file with `startedAt` after the
  mark evicts it on the next GET.
- Red proof: restore `|| remoteRuns.some(landed)` and both inverted cases fail.

Not a runner fix: nothing here touches the orchestrate skill, its CLI, the reviewer or `server/src/agents/`.

In the browser (playwright MCP tools): only runnable with a second machine draining the same tracker project, so the controller test above is the proof for a
headless session. By hand: open `http://127.0.0.1:5177/`, press Orchestrate on the tracker project, start a run on the other machine within the next minute,
and confirm the board's run chip and Runs → Live keep showing this machine's `starting` row after the other machine's run appears as remote, until this
machine's own run file lands.

## Outcome

2026-09-23 — cause confirmed live: `expired()` rule 1 read `realRuns.some(landed) || remoteRuns.some(landed)`, so any other machine's run started after the
mark evicted a live local spawn's placeholder. Fixed per `## Fix`: `list()`/`sweep()`/`expired()` lost the `remoteRuns` parameter and rule 1 reads local runs
alone; `OrchestratorController.runs()` calls `list(payload.runs, now)` / `sweep(payload.runs, now)` and still fills `payload.remote` from `remoteRuns.list()`.
Rule 1/2/3 comments, the class comment's bug-51 "one exception" paragraph and the controller comment were rewritten citing bug-57, and rule 2 now states the
accepted cost (a spawn dying before `init` keeps its placeholder up to `RUN_STALE_MS`; early retirement needs a signal about THIS spawn — a separate item).

Tests: `test/orchestrator-runs.test.ts`'s bug-51 case inverted into the bug-57 repro, `it.each` over a `running` and an `aborted` remote run started after the
mark — `payload.starting` still lists the project, `payload.remote` carries the run, `OrchestratorService.runs().starting` is still non-empty after the GET,
and a later local run file evicts it on the next GET. Deviation from the Fix's test list: `test/orchestrator-starting.test.ts`'s five remote cases were
DROPPED rather than flipped, because with the parameter removed there is no way to hand the service a remote run (a third argument no longer type-checks);
a block comment in their place points at the controller cases, which are the proof.

Verification — `pnpm run typecheck` exit 0; `pnpm test`:

```
Test Suites: 130 passed, 130 total
Tests:       2204 passed, 2204 total
# tests 799
# pass 797
# fail 1
```

The one node failure is pre-existing and environmental, not this diff: `orchestrate.test.mjs:7036` ("the preflight claim carries the machine it was taken on
…") asserts `/^[^@\s]+@\S+$/` but this machine exports `BM_MACHINE_NAME=aj_macbook` (see ~/.zshenv), which the test does not unset. With it unset:

```
$ env -u BM_MACHINE_NAME node --test skills/backlog-orchestrate/tools/orchestrate.test.mjs
# tests 343
# pass 343
# fail 0
```

Browser check skipped: it needs a second machine draining the same tracker project; the controller test is the headless proof, as the Fix says.

Contract sweep: 2 sites updated (.claude/rules/dispatch-watchdog.md, docs/subsystems/invariants.md) — CLAUDE.md headline unchanged, so `test/claude-rules.test.ts` stays byte-equal and green; no other `bug-51`/remote-retirement phrasing remains outside the diff (`docs/subsystems/api.md` only describes `remote` as a separate array, still true).
Red proof: 2 tests went red with the change reverted (restored `|| remoteRuns.some(landed)` plus the controller passing `remoteRuns.list()` — both bug-57 `it.each` cases failed; restored from file copies, no stash)
