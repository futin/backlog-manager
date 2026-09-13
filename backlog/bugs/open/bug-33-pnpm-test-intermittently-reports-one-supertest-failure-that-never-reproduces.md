---
id: bug-33
title: pnpm test intermittently reports one supertest failure that never reproduces
created: 2026-09-07
tags: tests, ci, orchestrator
updated: 2026-09-13T05:44:48Z
groom-elapsed: 742
groom-tokens: 131850
---

## Symptom

A full `pnpm test` occasionally reports **exactly one** failed test out of ~1500, always a
supertest request assertion, and the same suite passes on the very next run of the same
command against the same tree. Nothing in the diffs that triggered it touches server code,
`shared/`, or the guard under test.

This is a merge-gate problem, not a cosmetic one. `backlog-orchestrate` §8 makes the exit
code of `pnpm test` the only thing that green-lights a merge, and "never merges red" is a
Hard limit with no unrelated-looking-failure escape hatch. So a one-in-N false red parks a
green, reviewed item — or, worse, trains whoever is driving the run to re-run the gate
until it passes, which is exactly the habit that would let a *real* regression through.

Four occurrences observed on 2026-09-06/07, all in run `run-20260906-214634`:

1. **bug-30, verify attempt 1** — `test/agents-resume.test.ts:305` › `502s naming the
   timeout budget when the resume spawn fetch times out`, failing with
   `Parse Error: Expected HTTP/, RTSP/ or ICE/` (a client-side HTTP parse error, not an
   assertion mismatch). `1 failed, 1498 passed`.
2. **task-23, verify attempt 1** — a supertest `_assertStatus` failure, `1 failed, 1515
   passed`. The test name fell outside the captured tail; the stack was
   `Test._assertStatus → Test.assert → localAssert → Server.<anonymous>`, identical in
   shape to 3 below.
3. **task-28, verify attempt 1** — same `_assertStatus` stack, `1 failed, 1531 passed`.
4. **The task-21 execute session, independently** — `test/agents-origin-guard.test.ts:102`
   › `403s a urlencoded POST to dispatch without any outbound call`, `expected 403, got
   400`, twice in roughly 9 full runs.

In every one of the four, re-running the identical command against the identical tree came
back green.

Two observations that belong with it, both from sessions that were not looking for this:

- The **task-21** session chased occurrence 4 deliberately: 11 consecutive green runs with
  its branch reverted, then 12 more green with the branch restored and the failing
  assertion instrumented to dump the response body — never reproduced once, so no body was
  ever captured. Its reading: `OriginGuard.canActivate` is a pure function of the
  `content-type` header, so a `400` means the body parser rejected the request *before* the
  guard ran, which points at process state shared across suites rather than at the guard.
- The **task-28** session saw a variant worth telling apart from the rest: one `pnpm test`
  printed `FAIL jest` while jest's own summary in the same output reported zero failures.
  If that is the same defect it is not merely a flaky test — it is `scripts/test-all.mjs`
  reading a jest exit code that disagrees with jest's own report.

## Repro

No reliable repro. 23 targeted runs by the task-21 session produced none; the four sightings
above all came from `pnpm test` invoked incidentally, three of them by
`orchestrate.mjs verify` inside a fresh per-item worktree.

What is known about the conditions:

- Always the full suite via `pnpm test` (`scripts/test-all.mjs` → `pnpm run test:jest` →
  `jest --runInBand`), never a single-suite run.
- Always exactly one failure, always a supertest request against a Nest test app.
- Two distinct surface errors (a client-side `Parse Error`, and a status mismatch where the
  body parser appears to have rejected first) which may or may not be one root cause — the
  shared factor is a socket or a shared Nest/supertest process resource under
  `--runInBand`, not any assertion's own logic.
- Frequency is roughly 3 in 12 full-suite runs during that window; the machine was loaded
  (an orchestrator run with a headless session, a verify suite and a dashboard dev server
  all live).

A grooming pass should start by trying to reproduce under deliberate load rather than on an
idle machine, and by running the suite in a loop rather than a fixed count.

## Affects

- `test/agents-origin-guard.test.ts:102` — the parametrized `403s a urlencoded POST to
  <route>` case, the only failure whose name was captured directly.
- `test/agents-resume.test.ts:305` — `502s naming the timeout budget when the resume spawn
  fetch times out`.
- `package.json:17` — `"test:jest": "jest --runInBand"`, the shared-process mode both
  suspicions point at.
- `scripts/test-all.mjs` — for the task-28 variant only: `FAIL jest` printed over a
  zero-failure jest summary would be this file's exit-code handling, not a flaky test.
- Consumers of the gate: `skills/backlog-orchestrate/SKILL.md` §8 and
  `resolveVerifyCommands` in `skills/backlog-orchestrate/tools/orchestrate.mjs`.

## Cause

Every supertest request in this repo is answered by whatever is listening on
`127.0.0.1:<port>` at that instant, and that is not always this app's server.

`serverAddress()` in `node_modules/supertest/lib/test.js` (7.2.2) does two things that do
not agree with each other:

```js
if (!addr) this._server = app.listen(0);         // binds `::` — no host argument
const port = app.address().port;
return protocol + '://127.0.0.1:' + port + path; // dials IPv4 loopback — hardcoded
```

`listen(0)` with no host binds the **IPv6 wildcard** `::` (dual-stack), and the kernel
picks the ephemeral port against that address alone — a socket another process already
holds on `127.0.0.1:P` does not make `::P` unavailable. Measured on this machine
(2026-09-13, darwin 25.5.0, node v22.23.1): a non-HTTP `net` server on `127.0.0.1:58834`,
then `http.createServer().listen(58834)` with no host **succeeds** and reports
`{"address":"::","family":"IPv6","port":58834}`; the same bind written
`listen(58834, '127.0.0.1')` fails with `EADDRINUSE`.

The dial then goes to `127.0.0.1:P`, IPv4, and the kernel routes it to the **most
specific** match — the stranger's `127.0.0.1` socket, not our `::` wildcard. The request
never reaches the app under test, and the response the assertion runs against is whatever
that other program answered. In the probe above, that one request came back
`HPE_INVALID_CONSTANT Parse Error: Expected HTTP/, RTSP/ or ICE/` — the non-HTTP squatter
answering a supertest call.

That single mechanism produces every surface error in `## Symptom`, and produces no
others:

- a **non-HTTP** listener answers bytes llhttp cannot read as a status line →
  `Parse Error: Expected HTTP/, RTSP/ or ICE/` (occurrence 1);
- an **HTTP** listener answers its own status → `_assertStatus` fails on a number this app
  never returns for that request (occurrences 2–4, `expected 403, got 400`);
- a listener that accepts nothing → `connect ETIMEDOUT`.

Reproduced deliberately, with a 20,000-iteration probe replaying supertest's pattern
exactly — one `listen(0)`/`close()` per request, `agent: false` as superagent sets it, a
server that only ever answers 403 — against this machine as it stood (40 loopback
listeners, 4 of them on `127.0.0.1` inside the ephemeral range: two `java`, `Postman`,
`webstorm`):

```
13 anomalies in 20,000 requests (~1 in 1,540)
  8 x wrong status — 404 x5, 400 x2, 401 x1   (the probe's own server answers 403 only)
  2 x HPE_INVALID_CONSTANT Parse Error: Expected HTTP/, RTSP/ or ICE/
  3 x connect ETIMEDOUT 127.0.0.1:56191
```

The identical probe with the single change `listen(0, '127.0.0.1')` produced **zero**
wrong statuses and zero parse errors over 20,000 requests. (It did reach `EADDRNOTAVAIL`
after ~16,300 iterations — ephemeral *source* port exhaustion from opening 16k client
sockets in 15 seconds, an artefact of the probe's rate. A full `pnpm test` opens a few
hundred.)

Every observation in `## Symptom` and `## Repro` follows from this and needs nothing
else:

- **Always exactly one failure.** Roughly 1 request in 1,500 crosses over and a full run
  makes a few hundred; two in one run is rare.
- **Never reproduces on the next run.** The colliding port is a fresh draw each time —
  re-running proves nothing about the tree.
- **Always the full suite, never a single suite.** The draw count is the number of
  supertest requests in the process.
- **Worse on a loaded machine.** The hit rate is (foreign `127.0.0.1` listeners in the
  ephemeral range) / (size of that range). All four sightings came from `pnpm test`
  running inside an orchestrator run — a headless session, a verify suite and a dashboard
  dev server all live, each holding its own loopback ports.
- **Nothing in the triggering diffs touched server code** because the defect is in the
  test harness's socket setup, not in anything under test.
- **The task-21 session's 23 targeted runs found nothing** because they ran on a quiet
  machine and instrumented the guard. Its reading — `OriginGuard.canActivate` is a pure
  function of the `content-type` header, so a 400 means something rejected the request
  before the guard ran — is correct as far as it goes. The missing step is that the 400
  was not this app's at all, so no instrumentation *inside* this app could ever have
  captured that body; that is why the dump it added never fired.

Ruled out along the way, so nobody pays for them twice:

- **Client-side connection pooling.** superagent sets `options.agent = this._agent`, which
  is `false` by default, and Node turns `agent: false` into a fresh `new Agent()` whose
  `keepAlive` is `false` (checked: `new http.Agent().keepAlive === false`, while
  `http.globalAgent.keepAlive === true`). No socket is reused between requests.
- **A leaked timer or a leaked app.** `WatchdogService` disarms in
  `onApplicationShutdown`, which `app.close()` calls, and its timer is `unref()`'d;
  `app.init()` does not listen at all, so within this process at most one listener exists
  at a time.
- **The per-request `listen`/`close` churn on its own.** `orchestrator-runs.test.ts:96`
  already blames that churn for a `socket hang up` at ~1 run in 4 and works around it with
  `await app.listen(0)`. Half right: the churn is what buys one ticket in the port lottery
  per *request* instead of per *suite*. But that fix left the wildcard bind in place,
  which is the half that lets a stranger answer — so both suites that already listen once
  (that one and `agents-pause.test.ts:60`) are still exposed, just far less often.

**The `FAIL jest` printed over a zero-failure jest summary (the task-28 sighting) is not
proven to be this bug.** It is consistent with it — a crossed-over connection can fail
*after* the test that made it has settled (each `ETIMEDOUT` above burned the full connect
timeout), and an error surfacing once a test file's environment is torn down makes jest
exit non-zero while attributing no failed test, which `scripts/test-all.mjs` then prints
as `FAIL  jest`. It is left unproven deliberately: the fix below removes the only
demonstrated source, and if that variant recurs afterwards it is a separate defect in that
script's exit-code handling and earns its own bug rather than a guess recorded here as
fact.

## Fix

Bind the test listener to the address supertest dials — IPv4 loopback — once per suite,
through one helper. Not `jest.retryTimes`: the merge gate's whole value is that red means
red, and a retry would hide a real regression exactly as well as it hides this.

1. **New `test/helpers/app.ts`**, exporting one function:
   `listenLoopback(app: INestApplication): Promise<void>`, whose body is
   `await app.listen(0, '127.0.0.1')`. One implementation, in `helpers/` beside `store.ts`
   and `env.ts`, because the host argument is the entire fix and an inline copy in 18 files
   is 18 chances to drop it. Its comment must say what the argument buys — supertest dials
   `http://127.0.0.1:<port>` unconditionally, a `::` bind can be shadowed by any process
   holding that port on `127.0.0.1`, and a `127.0.0.1` bind cannot — and that the second
   effect matters too: with the server already listening, supertest's
   `if (!addr) this._server = app.listen(0)` branch never runs, so it opens and closes
   nothing per request. Verified against the real supertest 7.2.2: a server pre-listening
   on `127.0.0.1` gave `supertest url: http://127.0.0.1:58972/...` with **0** `listen()`
   and **0** `close()` calls across three requests.

2. **Call it in all 18 suites that hand an app to `request(...)`**, after `app.init()`,
   once per app object — `agents-dispatch`, `agents-origin-guard`, `agents-pause`,
   `agents-plan`, `agents-resume`, `agents-status`, `allowed-hosts`, `app`, `csp`,
   `items` (two apps, two `describe`s at `:89` and `:325`), `merge-check`, `merge-mode`,
   `orchestrator-runs`, `orchestrator-start`, `question-mode`, `uncommitted`,
   `watchdog-routes`, `watchdog-sweep`. The second apps count: `page` in `csp.test.ts` and
   in `allowed-hosts.test.ts` (both built with `NestFactory.create`, both handed to
   `request`) and `api` in `csp.test.ts`. Replace — do not keep — the two existing bare
   `await app.listen(0)` calls (`orchestrator-runs.test.ts:117`, `agents-pause.test.ts:60`)
   with the helper: same bug, smaller window, same fix.

3. **`watchdog-sweep.test.ts` is the one exception, and it must stay one.** Its
   `createApp()` (`:155`) is called from inside each case, and five cases
   (`:876`, `:893`, `:914`, `:950`, `:978`) call `jest.useFakeTimers()` *before* it, so a
   real `listen()` awaited in there could never settle. Give `createApp` an opt-in
   parameter (e.g. `createApp({ listen: true })`) and pass it only from the cases that
   actually call `request(...)` — around `:552`, `:570`, `:736`, `:747`, `:832`, all of
   which run under real timers. Do **not** move `jest.useFakeTimers()` after `createApp()`
   to avoid the parameter: the watchdog arms its chain during `init()`, and those cases
   exist to drive that chain from the fake clock.

4. **Leave every `await app.close()` exactly where it is.** It now tears down a real
   listener rather than an already-closed one, and it is the only thing that does, since
   supertest no longer closes anything.

5. **Tests** — `test/supertest-bind.test.ts`, new, node environment:
   - `listenLoopback` leaves `app.getHttpServer().address()` equal to
     `{ address: '127.0.0.1', family: 'IPv4', port: <any number > 0> }`. Red before the
     helper exists; red again if anyone drops the host argument.
   - With the helper applied, supertest re-binds nothing: spy on `listen` and `close` of
     the server object, make two `request(server)` calls, assert both spies have 0 calls.
     Red before — with `app.init()` alone each request calls each once.
   - Platform characterisation, deterministic, no timing: start a non-HTTP `net` server on
     `127.0.0.1:0`; assert `http.createServer().listen(P)` (no host) **resolves**, and that
     a request to `http://127.0.0.1:P` rejects with code `HPE_INVALID_CONSTANT`; assert
     `http.createServer().listen(P, '127.0.0.1')` rejects with `EADDRINUSE`. This is the
     bug itself, reproduced in one file and in milliseconds — it is what stops the next
     reader concluding the host argument is decoration. Close both servers in `afterEach`.
   - Source guard, in the shape `test/server-bind.test.ts` and `test/compose-env.test.ts`
     already use — read the files, assert on their text: every file under `test/` whose
     source contains `from 'supertest'` also contains `listenLoopback(`, and no file under
     `test/` except `helpers/app.ts` contains `.listen(0)`. Red before on 16 files and 2
     files respectively. State in the test's own comment what it cannot catch: a suite that
     builds a *second* app and listens only the first.

6. **Write the rule down where it will be read.** Add a bullet to `## Conventions` in
   `CLAUDE.md` — a suite that hands an app to supertest listens once, on `127.0.0.1`, via
   `listenLoopback`, never on the wildcard and never per request — and put the reasoning
   (the shadowing mechanism, the measured rate, why this is a merge-gate bug and not a
   cosmetic one) in a section of `docs/subsystems/invariants.md` for that bullet to link
   to. Without it the next person adding a Nest suite copies `await app.init()` from a
   neighbour and reopens this.

Verification: `pnpm test` green (both runners). The statistical half cannot be proved by a
single green run and should not be claimed — the useful evidence is the deterministic
characterisation test above plus, optionally, `pnpm run test:jest` in a loop on a
deliberately loaded machine, which is the only thing that would have caught this before
and costs roughly a minute a run.
