---
id: task-28
title: backlog-execute sweeps for contradicted prose and proves each new test can fail before it asks for review
created: 2026-09-06
tags: skills, execute, review
updated: 2026-09-07T05:03:09Z
started: 2026-09-07T04:42:27Z
execute-elapsed: 1242
execute-tokens: 74004
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

## Outcome

2026-09-07 — done. `backlog-execute` now runs a contract sweep and a red proof over its
own diff before it writes `## Outcome`, records both in two fixed lines, and
`backlog-reviewer` reads those lines and calls a missing pair Important. The measurement
behind the step is recorded, dated, in `backlog-orchestrate`'s `references/rationale.md`.

What changed, against the plan:

1. `skills/backlog-execute/SKILL.md` — new `## Before you call it done` section carrying
   both checks, placed between the `superpowers:verification-before-completion`
   invocation and the `## Outcome` write. That invocation moved into the new section's
   opening (it used to open the archive section), which is what puts the two checks
   literally between verification and the write rather than merely nearby; the archive
   section now opens "Only once verification passed and both checks above have actually
   been run".
2. Same file — the archive step's `## Outcome` instruction gained the two fixed line
   shapes verbatim, both branches of each.
3. `agents/backlog-reviewer.md` — a fourth numbered check in "What you check, in this
   order", naming both lines, calling a missing or half-present pair an Important
   finding, and telling the reviewer the lines are a claim to spot-check rather than
   proof (a false `Contract sweep: none found` is reported as the site it missed, at that
   site's own severity, not as a bad line).
4. `skills/backlog-orchestrate/references/rationale.md` — new dated section carrying the
   sweep table, the fix-loop cost, why the step lives in `backlog-execute` rather than in
   §4's dispatch prompt, and the shape both finding classes share (the evidence is never
   in the diff).
5. `skills/backlog-orchestrate/SKILL.md` §4 — unchanged, as the plan specified.

**Departure from the plan, deliberate.** `## Test cases` said "there is no tool to
unit-test," so the plan proposed no tests. That is not true of this repo: this file
already pins `backlog-groom`'s prose (`skills/backlog/tools/backlog.test.mjs`, the
`markInProgressSection` cases), for the same reason — prose a headless session obeys, in
a file no compiler reads. Four cases were added there, and they are what makes the
Red proof below real:

- ordering: the new section sits after the verification invocation and before the archive
  section, asserted by document position, so a section that drifts below the archive
  steps fails rather than being "still in the file";
- both checks present, plus the two load-bearing "why" halves (the sweep is over the
  repository text and not the diff; the red proof actually reverts and re-runs) and the
  `Never `git stash`` rule;
- both `## Outcome` line shapes and both of their empty-case branches;
- `backlog-reviewer.md` names both lines and calls a missing pair Important.

The line shapes are iterated from one `OUTCOME_LINES` table shared by the skill half and
the reviewer half, so neither side can be re-worded alone — which is this mechanism's own
failure mode applied to itself.

Two smaller judgement calls, both recorded rather than silent:

- The plan's red-proof recipe said "stash the non-test hunks". The written step says
  **never** `git stash` and prescribes a file copy instead: the stash stack is shared
  across every worktree and checkout of a repository, including concurrent sessions, so
  a stash taken by an orchestrated item can be popped by something else. A file copy is
  undoable by the session that made it.
- The reviewer's `description:` frontmatter enumerated its checks ("correctness first,
  the repo's CLAUDE.md invariants second, test adequacy third"). It now names the fourth.
  That line is also the agent's one-line summary in the Agent-tool listing, so leaving it
  at three would have advertised a reviewer that does not do what it does.

Contract sweep: 2 sites updated (agents/backlog-reviewer.md:5, CLAUDE.md:1103)

- `agents/backlog-reviewer.md:5` — the frontmatter description's three-check list, now
  four. Found by `grep -rn "test adequacy third"`; the file the diff was already editing,
  in a part of it the edit did not go near.
- `CLAUDE.md:1103` — Conventions said skill tests "live next to the tool they cover".
  The four new cases cover a skill's prose and an agent definition, not a tool. The
  clause now says so and says why there is nowhere else to put them: `test:skills`'s glob
  is `skills/*/tools/*.test.mjs` and `backlog-execute` has no `tools/` directory. (That
  sentence was already half-false before this diff — the `backlog-groom` prose cases have
  the same shape — so the sweep found pre-existing drift as well as its own.)

One site left standing on purpose:

- `docs/superpowers/specs/2026-08-31-backlog-orchestrate-design.md:114` (execute's step
  sequence) and `:215` (the reviewer's three checks). Dated design specs under
  `docs/superpowers/` are the record of what was designed on that date, not a live
  statement of current behaviour; editing them would destroy the record without making
  anything truer. Nothing reads them as a contract.

Red proof: 4 tests went red with the change reverted

Method: both prose files copied aside, replaced with `git show HEAD:<path>`, the one test
file re-run, then restored from the copies. No `git stash`, per the rule the same diff
adds.

```
$ git show HEAD:skills/backlog-execute/SKILL.md > skills/backlog-execute/SKILL.md
$ git show HEAD:agents/backlog-reviewer.md > agents/backlog-reviewer.md
$ node --test skills/backlog/tools/backlog.test.mjs
not ok 202 - backlog-execute runs the two checks after verification and before it writes ## Outcome
not ok 203 - backlog-execute states both checks, and why each one cannot be done by reading the diff
not ok 204 - backlog-execute writes the two fixed ## Outcome lines
not ok 205 - backlog-reviewer reads both lines and calls a missing pair Important
# pass 201
# fail 4
```

Restored, and green again:

```
$ node --test skills/backlog/tools/backlog.test.mjs
# tests 205
# pass 205
# fail 0
```

### Verification

```
$ pnpm test
Test Suites: 80 passed, 80 total
Tests:       1532 passed, 1532 total

1..435
# tests 435
# pass 435
# fail 0

────────────────────────────────────────────────────────────
PASS  jest
PASS  node --test (skills)

pnpm test: both runners passed.
$ echo $?
0
```

One earlier `pnpm test` in this session printed `FAIL jest` while jest's own summary in
the same output showed no failing test. It did not reproduce: `pnpm run test:jest` alone
and three subsequent full `pnpm test` runs were all green, the last captured to a file
and confirmed exit `0`. Recorded rather than dropped, since it is unexplained; nothing in
this diff runs under jest, whose `testMatch` is `test/**/*.test.ts(x)`.

### Not done here

"Published (`push` + `pnpm run plugin:sync`)" from `## Done when` is outside this
session: `backlog-execute` never commits or pushes, and this ran inside an orchestrator
worktree. The step is inert in installed plugins until someone runs the sync against the
pushed HEAD. Until then the next run's executors load the old `backlog-execute`.
