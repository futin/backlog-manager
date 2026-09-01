---
id: bug-1
title: Full-suite supertest runs flake on connection teardown
created: 2026-08-31
tags: tests, flake
updated: 2026-09-01T10:22:47Z
groom-elapsed: 1030
---

## Symptom

`pnpm test` fails roughly 1 run in 4, on a *different* suite each time, always with a
connection-teardown error rather than a failed assertion. Two signatures, both from the
same family:

- `socket hang up`
- `Parse Error: Expected HTTP/, RTSP/ or ICE/`

No test has ever failed on what the code does — only on the HTTP connection underneath
it. The same suites pass reliably in isolation, and `pnpm run test:skills` (node's own
runner, no supertest) has never flaked.

## Repro

Run the full suite repeatedly; it is a race, so a single green run proves nothing:

```bash
for i in 1 2 3 4 5 6 7 8; do pnpm test 2>&1 | grep -E "^Tests:"; done
```

Observed tallies while investigating the `backlog-orchestrate` merge (2026-08-31):

| Tree | Runs | Failures |
|---|---|---|
| pre-merge main (`27eb5d1`) | 8 | 0 |
| post-merge, before the partial fix | 5 | 1 — `orchestrator-runs › never caches` (`socket hang up`) |
| post-merge, after the partial fix | 4 | 1 — `agents-dispatch › passes the dashboard error through verbatim` (`Parse Error`) |

An earlier sighting during the branch work hit `items.test.ts` with the `Parse Error`
signature, so three distinct suites have now been the victim.

## Affects

- `test/orchestrator-runs.test.ts:60-90` — already carries a partial fix (`532f901`): it
  now calls `app.listen(0)` once in `beforeEach` so supertest does not run a
  `listen(0)`/`close()` cycle per request. That suite has not flaked since.
- `test/agents-dispatch.test.ts:52-70` — `beforeEach` builds a full `AppModule` app,
  `afterEach` closes it; victim of the `Parse Error` signature.
- `test/items.test.ts:74-89` — earlier victim, same signature.
- `test/orchestrator-start.test.ts:79-106` — same per-test full-app lifecycle as
  `agents-dispatch`; a suspect rather than an observed victim.
- `jest.config.ts` — the suite runs `--runInBand`, so every suite shares one process and
  one event loop, which is what lets one suite's leftover socket or listener reach
  another.

## Cause

The failures are transport-level and no victim suite is wrong on its own. What every victim
shares is structural: **its app is never told to listen**, so supertest manages the listener
itself. `Test`'s constructor calls `app.listen(0)` whenever `app.address()` is null, and its
`end()` calls `server.close()` once the response lands (supertest 7.2.2,
`lib/test.js` — `serverAddress()` and `end()`). One fresh ephemeral listener is therefore
opened and closed *per request, inside the request*, and `afterEach`'s own `app.close()` then
closes that same server a second time.

Measured on the current tree by patching `http.Server.prototype.listen`/`close` and logging
the port plus the suite responsible, over one full `--runInBand` run:

| Suite | listeners opened | requests | redundant 2nd close |
|---|---|---|---|
| `items` | 17 | 17 | 2 |
| `agents-dispatch` | 16 | 16 | 16 |
| `agents-origin-guard` | 14 | 14 | 14 |
| `orchestrator-start` | 11 | 11 | 11 |
| `agents-status` | 9 | 9 | 7 |
| `agents-plan` | 8 | 8 | 8 |
| `csp` | 3 | 3 | 2 |
| `app` | 2 | 2 | 1 |
| **`orchestrator-runs`** | **6** | **7** | **0** |

86 listener open/close cycles per run, all on one event loop, and `listeners == requests` in
every suite but one. `orchestrator-runs` is the control: since `532f901` gave it a single
`app.listen(0)` per test, `app.address()` is never null, so supertest adds no listener of its
own and closes nothing — 6 listeners for 7 requests, the only zero in the last column. It is
also the only suite that stopped flaking. That correlation, not a defect in any one suite, is
the cause: the per-request churn is what is being raced, every suite still doing it is a
candidate, and that is why the victim moves between runs.

The shape `532f901` blamed — two cycles back to back inside one test — is not unique to the
case it fixed. `agents-origin-guard` (14 requests over 8 tests), `items` (17 over 12) and
`agents-status` (9 over 7) all have tests issuing two requests, i.e. two full
listen/close cycles within a single test body.

What the mechanism is **not**. Each of these was ruled out by measurement, not by reasoning:

- **Keep-alive sockets reused across suites.** superagent sets `agent: false`
  (`superagent/lib/node/index.js`: `this._agent = false`, passed through as
  `options.agent`), so Node builds a throwaway agent per request and sends
  `Connection: close`. Nothing is pooled — notable because Node 22's `http.globalAgent` *does*
  default to `keepAlive: true`, which would otherwise be the obvious suspect.
- **Port collision or TIME_WAIT reincarnation.** 860 listeners across 9 full runs took 860
  distinct ports — no reuse, not even across runs.
- **A listener leaked by an un-awaited request.** 86 opens, 86 clean closes, none outstanding.
  (The three `request(...)` calls that look un-awaited are arrow-function helper bodies.)
- **A request arriving after its port closed.** Reproduced directly, 400/400: that is
  `ECONNREFUSED`, neither observed signature.
- **File-descriptor exhaustion.** `ulimit -n` here is 1048576.
- **Fake-timer or `global.fetch` leakage between suites.** Both are per-file and restored, and
  jest gives each test file its own environment.
- **`app.close()` fighting supertest's close.** Nest destroys sockets only when
  `forceCloseConnections` is set, which no suite sets, and its `close()` resolves rather than
  rejects on `ERR_SERVER_NOT_RUNNING`. The 61 double-closes per run are noise, not the kill.

**Not established: which step of the churn actually loses the socket.** The failure did not
reproduce once in 20 consecutive full runs on this machine — 10 instrumented, 10 bare, at load
average 12+ throughout — so the original ~1-in-4 rate is not reproducible on demand here and
the losing interleaving was never captured. Read the churn as the established exposure and the
specific race as unproven; the fix below is chosen to delete the whole mechanism class rather
than to target a guess.

## Fix

Generalize `532f901` from one suite to all of them: **every suite owns its listener explicitly,
so supertest never opens or closes one.** That deletes the raced churn outright instead of
betting on which interleaving loses the socket, and it is the change that demonstrably ended
the one instance that *was* reproducible.

1. Add `test/helpers/http.ts` with a single helper that takes a built Nest app, awaits
   `app.listen(0)`, and throws a named error if `app.getHttpServer().listening` is not `true`
   before returning. One place carries the reasoning, and the assertion turns "this suite
   forgot to listen" into a diagnosable failure instead of a transport mystery one run in four.
2. Call it from every hook that creates an app — nine call sites across eight files:
   `items` (×2, both `beforeAll`s), `csp` (×2 — `api` and `page`), `app`, `agents-dispatch`,
   `agents-plan`, `agents-status`, `agents-origin-guard`, `orchestrator-start`. Each app is
   still closed exactly once, by the `app.close()` already in its teardown hook.
3. Convert `orchestrator-runs` to the same helper, keeping its existing explanatory comment —
   it already does this by hand, and leaving it as the one bespoke case invites the next
   suite to copy the wrong pattern.
4. Keep `532f901`. It is a strict subset of this change, not something to revert.
5. Add a meta-test in the idiom the repo already uses for cross-cutting invariants
   (`test/vite-proxy.test.ts` asserting one proxy entry, `test/csp.test.ts` recomputing the
   theme-script hash): assert that every file under `test/` importing `supertest` also imports
   the helper. Static, cheap, and it is what stops a new suite from silently reintroducing
   per-request churn.

**Optional second stage, not required for the fix.** Steps 1–3 leave the *count* of cycles
unchanged for the suites that build an app per test (16 for `agents-dispatch`); they only make
each cycle a hook-owned open/close pair rather than one nested inside a request. The count
itself can drop to roughly one per suite by hoisting those apps to `beforeAll`, which is
possible because config is read per request, not at construction:
`readAgentsConfig(env = process.env)` (`server/src/agents/config.util.ts:31`) evaluates its
default at call time, and the orchestrator resolves `BM_ORCH_HOME` per request
(`server/src/orchestrator/orchestrator.service.ts:20`). Only the `REGISTRY_FILE` override is
compile-time, and those suites rebuild it per test only because they recreate an identical
temp project fixture each time. Worth doing per suite on its own merits; judge each one, and
do not fold it into the same change as steps 1–5.

**Verification.** Green runs prove nothing here — the bug never reproduced across 20 of them,
so "the suite passed" is not evidence. Acceptance is structural:

- `pnpm test` and `pnpm run typecheck` both clean.
- Re-instrument `http.Server.prototype.listen`/`close` for one full run and require:
  listeners opened equals apps created (**not** requests issued), and zero
  `ERR_SERVER_NOT_RUNNING` closes. Expected movement: 86 → one per app, and 61 → 0.
- Do not add retries, `jest.retryTimes`, or a raised timeout. Any of those hides the class of
  failure this item exists to remove.

No browser check applies: this is test infrastructure only — no client code, nothing rendered,
so there is no user-visible surface for a Playwright MCP check to open.
