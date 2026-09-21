---
id: bug-42
title: A board-spawned or hand --abort from a session other than the driver cannot release a live claim, so the force stop leaves bug-40's symptom for a dead driver
created: 2026-09-21
tags: tracker, github, orchestrator, claims, abort, stop
runner-fix: true
---

## Symptom

`POST /api/agents/stop` (bug-39) records the stop and spawns a fresh `/backlog-orchestrate --abort` session. That session runs `orchestrate.mjs abort`, which
(since bug-40) releases every claim the run still holds — but the server refuses each release while the claim is LIVE: `release of 6 was refused: #6 is held
by session 7e91416e-…`. The abort session still removes the worktree and writes `status: aborted`, so the run ends with the issue keeping an unreleased claim,
the `in-progress` label and `started`/`phase` on every machine's board — bug-40's symptom, on the exact path bug-39 built for a driver that is dead or hung.

Observed 2026-09-21 on `futin/test-claude-issues` issue #6, run `run-20260921-091645` (see
`docs/superpowers/specs/2026-09-21-tracker-phase4-live-verification.md`, Test 3). The claim WAS released in that run, but only because the still-live driver
`7e91416e` got exit `10` from its next `stage`, read `recovery.md` and ran `abort` itself ten seconds after the spawned session's refused one. With the driver
dead — the case a force stop exists for — nothing releases the claim: it goes stale after `CLAIM_STALE_MS` but stays unreleased, and the mapper fills
`started` from any unreleased claim, fresh or stale, so the item's dispatch control stays disabled until a person edits the comment by hand.

The same refusal hits a hand `/backlog-orchestrate --abort` typed in a new session after a crash, for the same reason.

## Repro

1. Register and connect a tracker project; start a run from the board for one open groomed issue `<n>`.
2. Wait for `stage <n> dispatched`; kill the driver session (`kill <driver pid>`) so no live driver remains.
3. `POST /api/agents/stop { project }` → 200, `abortSession` set. The spawned session runs `orchestrate.mjs abort`.
4. Its stderr: `release of <n> was refused: #<n> is held by session <driver session id>`. `run.json` says `aborted`; the claim comment has no `released`;
   the issue keeps `in-progress`; `GET /api/items` keeps `started`/`phase: execute` for `#<n>`. Waiting past 15 minutes changes none of the three.

## Affects

- `server/src/items/sources/github.source.ts` — `release()`, the `isLive(existing, now) && existing.session !== req.session` refusal ("the holder always; ANYONE
  once the claim is dead").
- `skills/backlog-orchestrate/tools/orchestrate.mjs` — `cmdAbort`, which takes the run's driver lease through `takeOverRun` and then releases each held claim
  as ITS OWN session, and treats a refused release as one stderr line.
- `server/src/agents/agents.service.ts` — `stop()`, which spawns the abort as a new session by design.

## Cause

`release` authorises by claim-holder session only. `claim` already knows a second authority — a live claim carrying the same `run.runId` is a takeover by the
resumed driver (task-47, §7.6) — but `release` never learned it, so a session that legitimately holds the RUN (the abort took the lease) is a stranger to the
CLAIM. bug-40 was verified with the driver releasing its own claims, which is the one caller the check admits.

## Fix

unknown
