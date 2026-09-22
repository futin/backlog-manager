---
id: bug-49
title: A session killed mid-item holds its claim for the full stale window, though the machine knows the process is gone
created: 2026-09-22
tags: tracker, claim
---

## Symptom

A session that is stopped by hand while it holds a tracker item's claim releases nothing. The claim comment keeps no `released` block, the issue keeps its
`in-progress` label, and every machine reads the item as in progress for a full `CLAIM_STALE_MS` (15 minutes) after the process is already dead. Nothing on
any surface says the holder is gone, and nothing clears it on its own.

This is the state bug-48 described and half-solved: it added the host clause AND `backlog.mjs abort <id>`, the one-word command that invokes it, so a person
at the holding machine can clear the claim in a second. What is still missing is anybody to run it WITHOUT a person: nothing notices the process died, so an
unattended run on another machine waits out the full window, and a person who walked away leaves the item locked until they come back.

The machine already has the evidence. On the run below the dashboard reported `runningClaudeProcs: 0` within seconds of the stop, while the same session still
rendered as `working` from its last transcript line and the claim on the issue stayed live for another eight minutes until it was released by hand.

## Repro

Observed 2026-09-22 on `futin/guide-manager#5`, with two machines racing the claim (Mac `facc726a`, Linux `77a705a3`):

1. Start `/backlog-execute` on a tracker project's item from machine A; let it win the claim. Here: Linux `77a705a3` took comment `5776031009` at 11:56:39Z,
   host `futin_ubuntu@JevticPC`.
2. Stop that session from the dashboard (or kill the process) while the item is mid-execute — before any terminal stage.
3. Read the claim from any machine: `GET /api/items/claim?project=<path>&id=gh:<owner>/<repo>#<n>`.

Observed: the record still carries `heartbeat: 2026-09-22T11:56:39.324Z` and no `released` key at 11:59:21Z, nearly three minutes after the process exited.
The issue still carries `in-progress`. `GET /api/sessions` on that machine's dashboard reports `runningClaudeProcs: 0` for the same period, and the session
row is still labelled `working`.

Expected: within one dashboard poll of the process disappearing, the claim carries `released: { reason: "aborted", ... }`, the `in-progress` label comes off,
and the item is claimable again — without the 15-minute wait and without a person composing a release by hand.

Cleared by hand with `POST /api/items/release` against the HOLDING machine's own API (`host: futin_ubuntu@JevticPC`), which is bug-48's clause working as
designed; the claim then showed `released: { at: 2026-09-22T12:00:23.536Z, reason: "aborted: session 77a705a3 stopped by the user mid-item" }`.

## Affects

- `shared/types.ts:2004` — `ItemReleaseRequest.host`, whose own doc states this case: a hand-run session killed mid-item "passes through no terminal stage, so
  it releases nothing", and "the item reads as in progress on every machine for a full `CLAIM_STALE_MS` with no command anywhere to clear it".
- `server/src/items/sources/github.source.ts:569` — `GithubSource.release`, and its four-clause rule (holder / run / host / anyone-once-dead). The host clause
  is the one a fix would call.
- `server/src/items/items-write.controller.ts:153` — `POST /api/items/release`, the route such a caller would use.
- `shared/types.ts` — `CLAIM_STALE_MS`, the 15-minute window this bug is the cost of.
- `server/src/tracker/claim.ts:183` — `isLive`, which is heartbeat-only by design and cannot itself know a process died.

## Cause

unknown

Two candidate shapes, not yet investigated:

- A `SessionEnd`/`Stop` hook on the executing session that releases whatever it holds. Cheap, but it does not fire for a `kill -9` or a machine that loses
  power, so it narrows the window rather than closing it.
- A sweeper on the machine that owns the claim: the dashboard already knows the session's process is gone (`runningClaudeProcs`, and per-session liveness), so
  the holding machine can satisfy the host clause itself and release with reason `aborted`. This is the one that matches the clause bug-48 added, and it is
  the direction to investigate first — including who owns the sweeper (this server or the dashboard), how it proves the session is gone rather than merely
  idle, and what it must NOT do to a session that is alive but quiet between long tool calls.

## Fix

unknown
