---
id: bug-7
title: Orchestrate route defaults a missing permissionMode to plan
created: 2026-09-01
tags: server, agents, orchestrator
updated: 2026-09-01T13:52:08Z
started: 2026-09-01T13:45:15Z
execute-elapsed: 413
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

## Outcome

2026-09-01 — Fixed. `AgentsService.orchestrate()` now defaults an absent
`permissionMode` to `auto` *before* `clampMode` sees it, instead of handing
`clampMode` an empty string and taking its floor-on-unknown answer. `clampMode`
and `modesUpTo` are untouched, as the Fix required.

One deliberate deviation from the Fix's literal snippet: it used
`typeof req.permissionMode === 'string' && req.permissionMode !== ''`, which
also defaults a NON-string (a JSON `7`, which the controller's `Partial` type
cannot rule out) to `auto` — today such a value floors. That conflicts with
this bug's own Cause, which turns entirely on "expressed no preference" and
"asked for something unrecognised" deserving opposite answers: a number is
present and unrecognised, not absent. The condition shipped is
`req.permissionMode === undefined || req.permissionMode === '' ? 'auto' : req.permissionMode`,
so `''` (the "no pick" a select submits, per `pickFrom`'s own convention) and a
missing field default, while a non-string, a `null` and a junk string all reach
`clampMode` unchanged and floor there. A test pins that case alongside the four
the Fix listed.

`test/orchestrator-start.test.ts` gained a permission-mode block (five cases:
absent → `auto`; absent under an `acceptEdits` ceiling → `acceptEdits`;
`bypassPermissions` under an `auto` ceiling → `auto`; `nonsense` → `plan`;
non-string `7` → `plan`) and its `stubDashboard` helper took a `ceiling`
parameter — with the ceiling hard-coded at `acceptEdits`, "the default applied"
and "the ceiling clamped it" are indistinguishable. The existing whole-spawn-body
assertion had pinned the bug itself (`permissionMode: 'plan'` for a body with no
mode) and now expects `acceptEdits`.

Red-green verified: the three affected cases failed against the unfixed service
(`Expected: "auto" / Received: "plan"`) before the change.

```
$ pnpm run typecheck
$ tsc --noEmit
(exit 0, no output)

$ pnpm test
Test Suites: 35 passed, 35 total
Tests:       515 passed, 515 total
Snapshots:   0 total
Time:        38.539 s, estimated 51 s
Ran all test suites.
```

(The first full run had one failure in `test/agents-dispatch.test.ts`
— `Parse Error: Expected HTTP/, RTSP/ or ICE/`, a supertest connection flake in
a suite this change does not touch. It passed alone and on the full rerun above.)
