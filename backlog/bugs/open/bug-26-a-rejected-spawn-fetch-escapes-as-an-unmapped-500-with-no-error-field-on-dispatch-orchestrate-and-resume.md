---
id: bug-26
title: A rejected spawn fetch escapes as an unmapped 500 with no error field on dispatch, orchestrate and resume
created: 2026-09-06
tags: audit-2026-09-06
---

## Symptom

`spawn()` awaits its `fetch` with no `try`/`catch`, and its `signal:
AbortSignal.timeout(SPAWN_TIMEOUT_MS)` guarantees a rejection path exists. Only the
`!res.ok` and missing-`sessionId` cases below it are handled. So a connection reset, or the
10s timeout, escapes uncaught — past `spawn()`, past all three callers, past the controller
(zero `try`/`catch` in it), and there is no global exception filter in `server/src` at all.

Nest answers a bare `{ statusCode: 500, message: "Internal server error" }` with no `error`
key, which `client/src/lib/agents.ts:62` degrades to `request failed (500)`. Every other
dashboard failure on these three routes maps to a 502 carrying the dashboard's own message,
so this is the one failure the user is told nothing about.

## Repro

Make the dashboard pass its health check and then fail the spawn request itself — kill it
between the two calls, or hold `/api/spawn` open past `SPAWN_TIMEOUT_MS` (10s). Any of
`POST /api/agents/dispatch`, `/orchestrate` or `/resume` then answers 500 rather than 502.

Untested today because every existing 502 test rejects `/api/health` too
(`test/agents-dispatch.test.ts:210`, `test/orchestrator-start.test.ts:246`), and
`stubDashboard` only ever *resolves* the spawn fetch with `ok: false` or a malformed body —
so the health-ok / spawn-rejects path has no case.

## Affects

- `server/src/agents/agents.service.ts:839-866` — `spawn()`; `fetch` awaited at `:840`,
  timeout signal at `:844`
- `server/src/agents/agents.service.ts:368` — `dispatch`, `return this.spawn(...)` uncaught
- `server/src/agents/agents.service.ts:522` — `orchestrate`, same
- `server/src/agents/agents.service.ts:719` — `resume`, same
- `server/src/agents/agents.controller.ts` — no `try`/`catch` anywhere
- `client/src/lib/agents.ts:62` — degrades the bare 500 to `request failed (500)`
- `test/agents-dispatch.test.ts:210`, `test/orchestrator-start.test.ts:246` — the tests that
  cannot reach it

## Cause

`spawn()` handles the two failure shapes that arrive as a *response* and none of the shapes
that arrive as a *rejection*, and nothing upstream compensates.

Related, and worth fixing in the same pass rather than separately: the post-gate
`projectMap()` re-read is likewise awaited outside any `try` in the same three routes, so a
TTL expiry followed by a failing 15s `/api/management` call answers 500 instead of the 409
written directly below it (`server/src/agents/agents.service.ts:359`). Same class, same three
call sites.

## Fix

unknown — the shape is catching the rejection where every other dashboard failure is already
mapped, so a reset or a timeout reads as a 502 carrying a message that names which of the two
it was. Open call: whether that lives inside `spawn()` (one site, keeps the three callers
untouched) or as a Nest exception filter (also covers `projectMap()` and anything added
later). Whichever is chosen, the test gap is the actual reason this shipped — `stubDashboard`
needs a mode where health resolves and the spawn fetch rejects.
