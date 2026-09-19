---
id: bug-39
title: No force stop for an orchestrator run
created: 2026-09-19
tags: watchdog, orchestrator
---

## Symptom

There is no way to force-stop a running orchestrator run. A user stopped the run's driver session (2026-09-19, run `run-20260919-135747`, task-47) and the
watchdog resumed it anyway: the watchdog log shows `spawned resume 1/3` at 14:41 and a `recovered — run fresh again` at 14:46. Killing the resumed session
by pid did not end the run either: `orchestrate.mjs abort` exits `7` with `run ... is alive (last heartbeat ...) and driven by session <id> — nothing to take
over`, because the run file still says `running`, its heartbeat is under `RUN_STALE_MS` (15 minutes) old, and its lease belongs to another session. Nothing was
actually alive at that point. The run stays un-abortable until the heartbeat ages out, and the watchdog will resume it before or around that moment unless it
is disabled globally.

The pause request (`POST /api/agents/pause`) did not help either: it is only read at the tool's two dispatch gates (`stage <id> preflight`/`dispatched`), so
it does not stop a session that is already mid-item, and a resumed session carries on the same work.

## Repro

1. Start a run from the board and let it dispatch an item.
2. Stop the driver `claude -p` session by hand (or send it a message that ends its turn).
3. Wait one watchdog tick: the run is resumed by a new `claude -p --resume ...` process.
4. Kill that process and run `orchestrate.mjs abort` from the project root: exit `7`, run still `running`.

## Affects

- `skills/backlog-orchestrate/tools/orchestrate.mjs:660-705` (`takeOverRun`: refuses a `running`, fresh run led by another session, with no check that the
  lease holder's process exists)
- `skills/backlog-orchestrate/tools/orchestrate.mjs:2290-2308` (`finish` asserts the driver lease, so it cannot end the run either)
- `server/src/agents/watchdog.service.ts` (`visit()` resumes on staleness; a stop request the user made is not something it can see)
- `server/src/agents/agents.controller.ts:298` (`pause` is the only stop-shaped route and only acts at the dispatch gates)
- `shared/agent.ts:676` (`watchdogStoodDown` has no input for "the user stopped this run")

## Cause

unknown

## Fix

unknown
