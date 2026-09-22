---
id: bug-57
title: Another machine's remote run evicts this board's starting placeholder, so a slow local start looks like it never launched
created: 2026-09-22
tags: orchestrator, tracker, board
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

`expired` treats ANY run for the project whose `startedAt >= requestedAt` as the spawn having landed, and applies that to `remoteRuns` as well as `realRuns`. A
board-started spawn always lands on THIS machine, as a local run file, so a remote run can never be that landing — yet it evicts the placeholder. The comment
states the remote arm deliberately (bug-51 weighed widening the `running` arm and kept it local-only), so the question for groom is why the `landed` arm was
widened when the `running` one was not.

## Fix

unknown
