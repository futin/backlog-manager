---
id: bug-34
title: question-mode prompt-composition test flakes with a 400 under the full suite
created: 2026-09-07
tags: tests, flaky, agents, question-mode
updated: 2026-09-13T06:06:59Z
groom-elapsed: 2072
groom-tokens: 309433
---

## Symptom

`test/question-mode.test.ts`'s case `composes ids, then the merge-mode flag,
then the question-mode flag` fails intermittently under a full `pnpm test`
run, with:

```
expected 201 "Created", got 400 "Bad Request"
```

The 400 is the shape `POST /api/agents/orchestrate` returns for a malformed
`ids` list or a malformed mode — so the request the test built was rejected as
invalid rather than spawning. Which of the three 400 paths it took is not
recorded; the assertion fires on the status code before anything reads the
body.

## Repro

Intermittent, not deterministic. Observed during task-30's execute session:
**1 failure in 4 consecutive full `pnpm test` runs** on the task-30 worktree.
The suite passes **3 of 3 in isolation** (`pnpm run test:jest -- question-mode`),
which is what makes a full-suite-only interaction the first thing to look at
rather than the case itself.

Nothing in task-30's diff is read by jest — it touched `skills/`, `CLAUDE.md`,
`README.md`, `docs/` and `.claude-plugin/plugin.json`, none of which any jest
test opens — so this is pre-existing and not that branch's doing.

Note `jest --runInBand` is already the configured runner (`pnpm run
test:jest`), so plain cross-file parallelism is not the explanation; shared
mutable module state, a leaked env var, or a per-suite mock left installed by
an earlier file are the shapes that survive `--runInBand`.

## Affects

- `test/question-mode.test.ts:230` — the failing case.
- `server/src/agents/agents.controller.ts` — the 400s on the orchestrate
  route: a malformed `ids` list, an invalid `mergeMode`, an invalid
  `questionMode`. CLAUDE.md's invariant is that a present-but-invalid mode is
  a 400 and never a clamp, so the 400 itself is correct behaviour — the
  question is why the request arrived invalid.
- `server/src/agents/agents.service.ts` — `ORCHESTRATE_PROMPT` and the
  `orchestrate()` composition the case is pinning.

## Cause

Nothing to do with question mode, prompt composition, or any of the three 400
paths the Symptom guessed at. **The request never reached this app.** It was
answered by an unrelated program already listening on the loopback port
supertest had just been handed, and the 400 is that program's answer, not this
one's.

The chain, in order:

1. `request(app.getHttpServer())` runs supertest's `Test#serverAddress`
   (`node_modules/supertest/lib/test.js:60`), which calls `app.listen(0)` —
   **with no host** — whenever the server is not already listening, then builds
   the URL `http://127.0.0.1:<port>`. A host-less listen binds the WILDCARD
   address (`0.0.0.0`/`[::]`), and Node sets `SO_REUSEADDR` on it.
2. On macOS/BSD a wildcard bind does **not** conflict with another process's
   loopback-*specific* bind on the same port. So the kernel is free to hand
   `listen(0)` a port that some other program already holds on `127.0.0.1`, and
   the bind succeeds — no `EADDRINUSE`, no warning.
3. A connection to `127.0.0.1:<port>` is delivered to the **most specific**
   listening socket, which is the other program's, not ours. supertest's
   request is answered by that program, and the assertion sees whatever status
   it returns.

Measured on this machine while grooming (2026-09-13, Node v22.23.1, darwin
25.5.0):

- Loopback-specific listeners inside the ephemeral range (49152-65535) at the
  time: `53518 (java)`, `57254 (Postman)`, `63342 (webstorm)`, `64120 (java)`.
- A wildcard `listen(0)` loop landed on one of them **3 times in 9,893 binds**,
  and each time a request to that port was answered by the holder.
- Probed directly with the very requests that flake: `127.0.0.1:64120` answers
  **400** to every path and method tried; `57254` and `63342` answer **404**;
  `53518` answers bytes Node's own parser rejects (`HPE_INVALID_CONSTANT`).
  That is the whole observed symptom set, reproduced without jest.
- One full `pnpm run test:jest` performs **3,536 `listen()` calls, every one of
  them wildcard**. At ~1 collision per 3,300 binds that is ~1 expected
  collision per run.
- Binding loopback-specifically instead removes it: a second `127.0.0.1` bind
  on a held port is refused with `EADDRINUSE`, and **12,000**
  `listen(0, '127.0.0.1')` calls collided **0** times.

That arithmetic is the Repro section's two numbers. A full run draws 3,536
ports, so it usually hits one — "1 failure in 4" is this machine on a quieter
day. `question-mode.test.ts` alone draws about a dozen, so in isolation it is
~0.4% and passes "3 of 3". `--runInBand` cannot help because nothing is shared
between suites: the only variable is how many ports the run draws.

It is therefore not this suite's bug, and not this suite's alone. Eight full
baseline runs while grooming caught **four** different suites, each with a
status its own route cannot return:

- `POST /api/agents/plan` → **401** (no 401 exists anywhere in `server/src`)
- `POST /api/agents/resume` → **404**
- `GET /api/agents/status` → **400** (that route has no 400 path at all)
- and this item's own case.

The bare `socket hang up` that `test/orchestrator-runs.test.ts`'s own beforeEach
comment already documents at the same 1-in-4 rate is the same defect meeting a
neighbour that resets instead of replying; that suite's `await app.listen(0)`
narrowed the window (one bind per test instead of one per request) without
closing it, because it still passes no host.

## Fix

Bind every test server to loopback explicitly, and make a wildcard bind
impossible to reach for by accident.

1. **Pre-listen on loopback, per suite.** In each of the 15 suites that drive a
   Nest app through supertest, replace the `await app.init()` in `beforeEach`
   with:

       await app.listen(0, '127.0.0.1');

   Nest's `listen()` initialises the app itself, so this replaces `init()`
   rather than joining it. Once the server is already listening, supertest's
   `serverAddress` takes the `if (!addr)` branch no further and never binds
   anything of its own — which is what both fixes this bug and removes the
   per-request listen/close churn `orchestrator-runs.test.ts` describes.

   The 15: `app`, `orchestrator-start`, `allowed-hosts`, `items`,
   `uncommitted`, `merge-mode`, `orchestrator-runs`, `agents-dispatch`,
   `merge-check`, `agents-origin-guard`, `question-mode`, `agents-plan`,
   `agents-status`, `agents-resume`, `agents-pause` (`.test.ts` each).
   `orchestrator-runs` and `agents-pause` already pre-listen — they need the
   `'127.0.0.1'` argument added, nothing else. Check `allowed-hosts.test.ts`
   by hand: it asserts on the `Host` header, and the bind address does not
   change what supertest sends (`127.0.0.1:<port>`), but that suite is the one
   where that assumption is load-bearing.

2. **Do NOT fix this by wrapping `listen()` to supply the host.** Measured, and
   it fails: once a host is passed, `net.Server.listen` resolves it before
   binding, so `server.address()` is still `null` on the next line — which is
   exactly where supertest reads it. A forcing wrapper turned the suite into
   202 failures of `TypeError: Cannot read properties of null (reading 'port')`
   at `Test#serverAddress`. The host has to be supplied by an **awaited** call,
   which is why it belongs in `beforeEach` and nowhere else.

3. **Guard it, so suite 16 cannot regress silently.** In `test/helpers/env.ts`
   — the file that already exists to make "a suite forgot to override X" a
   harmless oversight — wrap `http.Server.prototype.listen` to THROW on any
   host-less call (skipping the `listen(path)` pipe form and the
   `listen({ host })` options form). A suite that forgets to pre-listen then
   fails immediately, naming itself, instead of flaking at 1-in-2 six months
   later. Verified while grooming: with the guard installed, the converted
   suites pass untouched and an unconverted one fails on its first request with
   the guard's own message.

Verification for whoever executes this:

- `pnpm run test:jest -- question-mode agents-plan uncommitted` — passes with
  the pre-listen applied and the guard armed (already confirmed here: 4 suites,
  56 tests).
- Instrument `http.Server.prototype.listen` to record its host argument for one
  full run: **3,536/3,536 binds must report `127.0.0.1`**, none `WILDCARD`.
  That count is the direct before/after measurement, and it is deterministic —
  unlike the flake itself.
- `pnpm test` (both runners) green. Repeat the full run at least 10 times: the
  baseline failed 4 of 8, so 10 consecutive green runs is the statistical
  claim this fix is allowed to make.
- Red proof: with the guard in `env.ts` but the pre-listen removed from one
  suite, that suite must fail on its first request with the guard's message.
  That is a deterministic red, which the flake itself can never be.

No browser check: this is a test-harness defect with no user-visible surface.
