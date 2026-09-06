---
id: bug-26
title: A rejected spawn fetch escapes as an unmapped 500 with no error field on dispatch, orchestrate and resume
created: 2026-09-06
tags: audit-2026-09-06
runner-fix: true
updated: 2026-09-06T13:50:51Z
groom-elapsed: 347
groom-tokens: 72841
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

`spawn()` handles the two failure shapes that arrive as a *response* — `!res.ok` and a
missing `sessionId` — and none of the shapes that arrive as a *rejection*, and nothing
upstream compensates: all three callers `return`/`await` it bare, `AgentsController` has no
`try`/`catch`, and `server/src` registers no exception filter at all (`useGlobalFilters` and
`@Catch` appear nowhere in it). Nest's default handler then answers `{ statusCode: 500,
message: "Internal server error" }`, which carries no `error` key, so `unwrap`
(`client/src/lib/agents.ts:62`) falls back to `request failed (500)`.

Measured 2026-09-06 with four throwaway e2e cases against the real `AppModule`, `/api/health`
and `/api/management` both resolving and only the spawn fetch rejecting. Every one answered
`500 {"statusCode":500,"message":"Internal server error"}`:

- `POST /api/agents/dispatch`, spawn rejects `TypeError: fetch failed` (`cause.code:
  ECONNREFUSED`)
- `POST /api/agents/dispatch`, spawn rejects `DOMException [TimeoutError]`
- `POST /api/agents/orchestrate`, spawn rejects `TypeError: fetch failed`
- `POST /api/agents/orchestrate`, the post-gate `projectMap()` re-read rejects after the gate's
  own read succeeded (the TTL race below) — the stack ran
  `AgentsService.get → projectMap → orchestrate → AgentsController.orchestrate`, uncaught

Two things about the rejections themselves, measured on this machine's Node 22.23.1, because
they decide what a caught message may say:

- a connection failure is a `TypeError` whose message is the useless literal `fetch failed`;
  the detail lives only in `.cause` (`cause.code === 'ECONNREFUSED'`, `cause.message ===
  'connect ECONNREFUSED 127.0.0.1:…'`)
- the `AbortSignal.timeout` path is a `DOMException` with `name: 'TimeoutError'` and message
  `The operation was aborted due to timeout` — no `cause`, and nothing naming the 10s budget

So `message(e)` (`agents.service.ts`) alone is not the fix: catching and reporting it verbatim
would turn a bare 500 into a 502 reading `fetch failed`, which still names neither of the two
failures the Symptom asks to tell apart.

**Second site, wider than first written.** `projectMap()` also escapes uncaught from all three
post-gate re-reads (`:359`, `:490`, `:709`), and not only on a rejection: `get()` throws a
plain `Error(`${path} answered ${res.status}`)` for a *non-ok* management response too
(`:1147`), so a dashboard that answers `/api/management` with a 500 in the TTL window reaches
the same unmapped 500. `status()` (`:237`) is the one caller that guards it. Those four
sites — the `spawn` fetch and the three `projectMap` re-reads — are the closed set: `grep -n
'await fetch\|this.get<\|await this.projectMap\|this.spawn('` over the file lists eleven
lines, and every other one is inside `status()`'s two `try` blocks or is a definition.

## Fix

**Catch at the two outbound seams inside `AgentsService`; no global exception filter.** That
is the item's own open call, decided here rather than left open, and the reasoning matters
more than the choice:

1. **The watchdog reaches `resume()` in-process, never over HTTP.** `WatchdogService.spawn()`
   catches everything and records `resumeErrorMessage(e)` in its Activity feed; a Nest filter
   never runs on that path, so the sweeper's `failed` line would keep reading `fetch failed`
   for the exact outage a person is staring at the Watchdog console to understand. A seam
   catch serves both surfaces from one place; a filter serves one of them.
2. **A filter cannot tell an upstream fault from a bug in our own code.** Mapping every escape
   to 502 would blame the dashboard for our own `TypeError`; mapping it to 500-with-an-`error`
   leaves the status still wrong for the case this item is about. Only the call site knows
   which it was.
3. **It is the posture this file already takes** — `spawn()`'s own 400-499-versus-502 split
   (`:860`) and `status()`'s two `catch`es both map failures where the code knows what failed.

Steps:

1. A helper beside `message()` at the foot of `agents.service.ts`, exported so tests can hit
   it directly — `dashboardError(e: unknown, what: string, timeoutMs: number): string`:
   - `name === 'TimeoutError'` or `'AbortError'` → a sentence naming the timeout and its
     budget, e.g. `` `${what} timed out after ${timeoutMs}ms` ``. Duck-typed on `.name`, NOT
     `instanceof DOMException`, for the realm reason `resumeErrorMessage`
     (`watchdog.service.ts`) already records for its own `getResponse` probe.
   - a `.cause` carrying a string `code` or `message` → `` `${what} failed: ${code ?? message}` ``,
     since `fetch failed` on its own names nothing.
   - anything else → `message(e)` unchanged. That fall-through is load-bearing: it is what
     keeps `status()`'s plain `Error('connect ECONNREFUSED')` case reading as it does today
     (`test/agents-status.test.ts:82`).
2. `spawn()`: wrap **only** the `await fetch` (`:840-845`) in `try`/`catch`, not the
   `res.json()` or the two `throw`s below it — those already map, and pulling them inside
   would re-map their own `HttpException`s. The catch throws
   `new HttpException({ error: dashboardError(e, 'the dashboard spawn call', SPAWN_TIMEOUT_MS) }, 502)`.
   502 for the reason `:860` already gives: an upstream fault this app cannot vouch for.
3. `projectMap()`: the same wrap around its one `get()` call (`:875`), 502 with
   `dashboardError(e, 'the dashboard project list', MANAGEMENT_TIMEOUT_MS)`. In `projectMap`
   rather than at each of the three call sites: one seam, three callers, and `status()`'s
   existing bare `catch {}` swallows an `HttpException` exactly as it swallows today's raw
   one, so `GET /api/agents/status` is unchanged. **Not** the 409 written directly below each
   call site — we did not learn the project is invisible, we failed to ask — which is the same
   split `:337` and `:655` already make between "unreachable" and "answered and said no".
4. **No client change.** Once the body carries `{ error }`, `unwrap` renders the server's own
   wording; no `code` either, since nothing branches on this the way `RUN_IN_PROGRESS_CODE` is
   branched on.
5. **Leave `status()` on `message(e)`.** Its failure already reports a readable string and its
   wording is pinned by a test; swapping it is a separate, cosmetic change.
6. **Do not add a global exception filter afterwards as hygiene.** Recorded here so the next
   reader does not: an unexpected escape from this app's own code genuinely is a 500, and a
   filter dressing it as a 502 would send a reader off to restart a dashboard that is fine.

Frontmatter carries `runner-fix: true`: the change is inside `server/src/agents/`, the
dispatch route the grooming rule names by path.

### Test cases

The test gap is the reason this shipped, so it is part of the fix, not a follow-up.
`stubDashboard` only ever *resolves* the spawn fetch, and every existing 502 case rejects
`/api/health` too — which is answered by `dispatchBlock` long before `spawn()` is reached.

- Extend each suite's own `stubDashboard` with a spawn-rejects mode — a `reject?: unknown`
  field beside the existing `{ ok, status?, body? }`, answered with `Promise.reject` for the
  `/api/spawn` URL only, health and `/api/management` still resolving. In all three copies:
  `test/agents-dispatch.test.ts:31`, `test/agents-resume.test.ts:37`,
  `test/orchestrator-start.test.ts`. Kept per-suite rather than unified into `test/helpers/`:
  the three answer different `/api/management` payloads and already diverge on purpose, and a
  shared stub is its own refactor.
- Two cases per route — `POST /api/agents/dispatch`, `/orchestrate`, `/resume` — six in all:
  - spawn rejects `Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })`
    → **502**, `body.error` contains `ECONNREFUSED`, and `body.statusCode` is `undefined`
    (that last assertion is what actually pins "not the bare Nest 500 shape" — a status
    assertion alone would pass against a filter that merely relabelled the number).
  - spawn rejects `new DOMException('The operation was aborted due to timeout', 'TimeoutError')`
    → **502**, `body.error` names the timeout and `10000`, and does NOT contain
    `The operation was aborted`.
- One TTL-race case, on `/orchestrate` alone since the three call sites are line-for-line
  identical: the first `/api/management` resolves so the gate passes, the second rejects, with
  `Date.now` advanced past `PROJECT_TTL_MS` between the two reads → **502**, not 500 and not
  the 409 below it. Reachable in practice — it is the fourth measured case in `## Cause`.
- `test/watchdog-sweep.test.ts`: a sweep whose `resume()` fails this way pushes a `failed`
  activity entry whose detail contains `ECONNREFUSED` rather than `fetch failed`, and leaves
  `attempts` untouched. This is the case that proves the seam catch reaches the non-HTTP
  caller, which is the entire reason it lives there rather than in a filter — without it,
  point 1 above is an argument nothing enforces.

No browser check. The defect is only reachable by making the dashboard pass its health probe
and then fail the spawn request itself, which no action inside the board can stage; a
Playwright case would have to fake the failure at a layer the jest e2e cases above already
own.
