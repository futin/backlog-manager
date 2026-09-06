---
id: task-28
title: backlog-execute sweeps for contradicted prose and proves each new test can fail before it asks for review
created: 2026-09-06
tags: skills, execute, review
---

## Goal

Cut the orchestrator's fix-loop rate by having the executing session catch the two
finding classes that dominate it. The 2026-09-06 sweep read every fix-verdict review on
this machine (27 first passes, 2 second passes, four projects) and classified them:

| Finding class | Count | Examples |
|---|---|---|
| another statement of the old contract left standing | 14 | CLAUDE.md:227 and docs/invariants.md:408 (bug-4), CLAUDE.md:522 (task-20), a JSDoc on `RUN_IN_PROGRESS_CODE` (bug-21, twice), README:12 (task-4), docker-compose `MAX_SESSIONS=10` (dashboard bug-4), docs/overview.md (dashboard task-11) |
| a new test that still passes with the change reverted | 5 | styles.css rule invisible to the suite (bug-16), a conditional `TZ` pin (task-15), a dedupe test that cannot tell pre- from post-slice (dashboard bug-15), `bookingDate` never pinned (finance task-4) |
| a genuine defect | 8 | pause cleared on watchdog resume (task-17), a NUL byte in a source file (task-18), the lease bricking `--abort` (bug-19) |
| other | 2 | |

The first two rows are mechanical checks over the session's own diff. A fix loop costs
a median 22.6 minutes and about $5.60 all in (fix session, re-review, ten driver turns);
26 of them cost this corpus roughly $145 and 9.4 hours. Nineteen of 29 were in the two
rows above.

## Plan

1. `skills/backlog-execute/SKILL.md` gains a step immediately before the one that
   writes `## Outcome`, named "Before you call it done", with two checks the session
   runs over `git diff` of its own work (in a worktree that is the whole branch; in a
   hand session, the working tree):
   - **Contract sweep.** List every rule sentence, identifier, number, path, flag and
     command the diff changed or removed. For each, search the repository for its *old*
     form outside the diff — `CLAUDE.md`, `docs/`, `README*`, compose and env files,
     `skills/**/*.md`, `agents/*.md`, code comments and JSDoc, test names. Update each
     site the change makes false, or record in `## Outcome` why a site was left. The
     sweep is over the repository text, not the diff, because the finding is always in a
     file the diff did not touch.
   - **Red proof.** For each test the diff adds or changes, revert the production change
     it pins (stash the non-test hunks, or comment the change out), run that test file,
     confirm it fails, restore. A test that stays green does not pin the change: fix the
     test, not the note. Skip only for a test that pins a pure refactor with no
     behaviour to revert, and say so.
2. `## Outcome` gains two fixed lines, so the reviewer and a later reader can see the
   checks ran: `Contract sweep: <n> sites updated (<paths>)` or `Contract sweep: none
   found`, and `Red proof: <n> tests went red with the change reverted` or `Red proof:
   skipped — <why>`. `agents/backlog-reviewer.md` gets one sentence telling the reviewer
   to read those two lines and to treat a missing pair as an Important finding, so the
   step cannot be quietly skipped in a headless run.
3. The dispatch prompt in `skills/backlog-orchestrate/SKILL.md` §4 is unchanged: the
   step lives in the skill the session already runs, and loads only then.
4. `skills/backlog-orchestrate/references/rationale.md` gets a short section recording
   the table above as the measurement behind the step, dated, so the next sweep can
   report whether the rate moved.

## Test cases

This is prose in two skill files and an agent definition; there is no tool to unit-test.
The checks that stand in for tests:

- `skills/backlog-execute/SKILL.md` contains the new step between the verification step
  and the `## Outcome` write, and the two `## Outcome` line shapes verbatim.
- `agents/backlog-reviewer.md` names both lines and the Important verdict for their
  absence.
- A dry run against an archived item with a known drift finding (bug-21's
  `RUN_IN_PROGRESS_CODE` doc comment) — reading the step and applying it by hand to that
  diff — finds `shared/types.ts:318`, which the reviewer found in round two.
- `pnpm run test:skills` still green (no tool changed), `pnpm test` green.

## Done when

- The step and the two Outcome lines are in `backlog-execute`'s SKILL.md; the reviewer
  reads them; rationale.md carries the table.
- Published (`push` + `pnpm run plugin:sync`) so the next run's executors load it.
- The next cross-run sweep can compare the fix-verdict rate against 27/91.
