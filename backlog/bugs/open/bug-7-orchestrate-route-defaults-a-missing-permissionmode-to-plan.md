---
id: bug-7
title: Orchestrate route defaults a missing permissionMode to plan
created: 2026-09-01
tags: server, agents, orchestrator
---

## Symptom

`POST /api/agents/orchestrate` with a body carrying only `project` spawns an
orchestrator session in `plan` permission mode — a mode that cannot write a file, create
a worktree, commit, or merge. The route answers 201 with a session id, the run appears to
start, and then nothing happens. Nothing anywhere reports why.

Latent today: the only caller is `OrchestrateSheet`, which always sends a mode. It is
reachable by anything else that posts to the route — a curl, a script, a future client,
or a caller that drops the field while keeping the rest.

## Repro

```bash
curl -s -X POST http://127.0.0.1:4322/api/agents/orchestrate \
  -H 'content-type: application/json' \
  -d '{"project":"/abs/path/to/project"}'
```

The spawn goes through with `permissionMode: "plan"`.

## Affects

- server/src/agents/agents.service.ts — the `spawn` call at the end of `orchestrate()`:
  `permissionMode: clampMode(req.permissionMode ?? '', status.spawnMaxPermission)`.
- shared/agent.ts:126 — `clampMode`. Given `''`, `allowed.includes` is false and
  `PERMISSION_LADDER.indexOf('')` is `-1`, so it returns `allowed[0]` — the floor.
- shared/agent.ts:107 — `modesUpTo`, whose floor-on-unknown rule is correct and is not
  the thing to change.
- server/src/agents/agents.service.ts:195 — `plan()`, the route that gets this right:
  `defaultMode: clampMode('auto', status.spawnMaxPermission)`, with a comment spelling
  out why `auto` and not the ceiling.

## Cause

`clampMode`'s floor-on-unrecognised-input rule is doing exactly what it was written to
do. Its docstring is explicit: a junk or unknown string cannot be placed on the ladder, so
the safe reading is the floor. That rule was written for a *ceiling* the client could not
interpret, and for a caller asking for something nonsensical.

An absent field is neither. `req.permissionMode ?? ''` converts "the caller expressed no
preference" into "the caller asked for something unrecognised", and the two deserve
opposite answers: the first wants a sensible default, the second wants the floor.

The dispatch path never hits this because the server hands the client a `defaultMode`
computed from `clampMode('auto', ceiling)` and the sheet posts it back. The orchestrate
route has no equivalent — its body has no negotiated default behind it, and the sheet
computes `clampMode('auto', ceiling)` client-side instead. So the one route that runs an
entire unattended queue is the one with no server-side default at all.

## Fix

Default the field on the server before clamping, mirroring `plan()`'s own reasoning:

```ts
permissionMode: clampMode(
  typeof req.permissionMode === 'string' && req.permissionMode !== '' ? req.permissionMode : 'auto',
  status.spawnMaxPermission
)
```

`auto`, not the ceiling — same trade `plan()` documents: an unattended session that stops
on the first tool call it cannot self-approve does nothing, while asking for the most a
host allows is how a convenience becomes an incident. The ceiling still clamps this down
on a stricter dashboard, so the change can never widen what a host permits.

Leave `clampMode` and `modesUpTo` alone. The floor-on-unknown rule is right; the bug is
handing them an empty string in place of a default.

Test cases (test/ has server suites for the agents routes; put these with them):

- body with only `project` → the spawn is called with `permissionMode: 'auto'` on a host
  whose ceiling is `auto` or higher;
- same body against a ceiling of `acceptEdits` → `acceptEdits`, proving the ceiling still
  wins over the new default;
- body with `permissionMode: 'bypassPermissions'` against an `auto` ceiling → `auto`,
  unchanged clamping behaviour;
- body with `permissionMode: 'nonsense'` → still the floor, `plan`. This is the case the
  fix must NOT change: an unrecognised request is not a missing one.
