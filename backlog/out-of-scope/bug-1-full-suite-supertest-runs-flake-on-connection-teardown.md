---
id: bug-1
title: Full-suite supertest runs flake on connection teardown
created: 2026-08-31
tags: tests, flake
updated: 2026-09-01T10:31:04Z
groom-elapsed: 1074
rejected: 2026-09-01
---

## What was proposed

Chase down the intermittent connection-teardown failures in the full `pnpm test` run: roughly
1 run in 4 failing on a *different* supertest suite each time, never on an assertion, always
on the HTTP connection underneath one — two signatures from one family, `socket hang up` and
`Parse Error: Expected HTTP/, RTSP/ or ICE/`. Filed 2026-08-31 while merging
`backlog-orchestrate`, on the observation that pre-merge main was clean across 8 runs and the
post-merge tree was not.

Groomed 2026-09-01 to a diagnosed exposure and a concrete fix plan, both recorded below so a
recurrence does not start from zero.

## Why rejected

**It stopped reproducing, so the fix cannot be verified.** 20 consecutive full runs on the
groom machine — 10 instrumented, 10 bare, at load average 12+ throughout — produced zero
occurrences of either signature. The fix that follows from the diagnosis touches nine
app-creating hooks across eight suites plus a new shared helper and a meta-test; shipping that
much test-infrastructure churn against a failure nobody can summon means no green run would
prove anything, and "the suite passed" was already true 20 times before the change. Better to
hold the diagnosis and spend it when there is a live instance to measure against.

What the groom *did* establish, and what makes this cheap to resume:

The failures are transport-level and no victim suite is wrong on its own. Every victim shares
one structural trait: **its app is never told to listen**, so supertest manages the listener
itself — `Test`'s constructor calls `app.listen(0)` whenever `app.address()` is null, and its
`end()` calls `server.close()` once the response lands (supertest 7.2.2, `lib/test.js`:
`serverAddress()` and `end()`). One fresh ephemeral listener is opened and closed *per request,
inside the request*, and `afterEach`'s own `app.close()` then closes that same server again.
Measured by patching `http.Server.prototype.listen`/`close` over one full `--runInBand` run:

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

86 listener open/close cycles per run on a single event loop, and `listeners == requests` in
every suite but one. `orchestrator-runs` is the control: since `532f901` gave it one
`app.listen(0)` per test, `app.address()` is never null, so supertest adds no listener of its
own and closes nothing — the only zero in the last column, and the only suite that stopped
flaking. That correlation, not a defect in any one suite, is why the victim moves between runs.

Ruled out by measurement, not by reasoning — do not re-spend this:

- **Keep-alive sockets reused across suites.** superagent sets `agent: false`, so Node builds a
  throwaway agent per request and sends `Connection: close`. Nothing is pooled, despite Node
  22's `http.globalAgent` defaulting to `keepAlive: true`.
- **Port collision or TIME_WAIT reincarnation.** 860 listeners across 9 full runs took 860
  distinct ports — no reuse, not even across runs.
- **A listener leaked by an un-awaited request.** 86 opens, 86 clean closes, none outstanding.
- **A request arriving after its port closed.** Reproduced directly, 400/400: that is
  `ECONNREFUSED`, neither observed signature.
- **File-descriptor exhaustion.** `ulimit -n` is 1048576 here.
- **Fake-timer or `global.fetch` leakage between suites.** Both per-file and restored.
- **`app.close()` fighting supertest's close.** Nest destroys sockets only under
  `forceCloseConnections`, which no suite sets, and its `close()` resolves rather than rejects
  on `ERR_SERVER_NOT_RUNNING` — the 61 double-closes per run are noise, not the kill.

Never established: **which step of the churn actually loses the socket.** The losing
interleaving was never captured, so the churn is an established exposure and the specific race
remains unproven. `532f901` stays in place regardless — it is a strict subset of the fix below
and is not something to revert.

The fix, if this is ever resumed: give every suite ownership of its listener so supertest never
opens or closes one. A `test/helpers/http.ts` helper that awaits `app.listen(0)` and asserts
`app.getHttpServer().listening`, called from all nine app-creating hooks (`items` ×2, `csp` ×2,
`app`, `agents-dispatch`, `agents-plan`, `agents-status`, `agents-origin-guard`,
`orchestrator-start`), with `orchestrator-runs` converted to the same helper so the bespoke
case stops inviting copies; plus a static meta-test — the idiom `test/vite-proxy.test.ts` and
`test/csp.test.ts` already use — asserting every `test/` file importing `supertest` also
imports the helper. Acceptance would have to be structural rather than "N green runs":
listeners opened per run equal to apps created, not requests issued, and zero
`ERR_SERVER_NOT_RUNNING` closes (86 → one per app, 61 → 0). Not retries, not
`jest.retryTimes`, not a raised timeout — each of those hides this class outright.

## What would change the answer

**A fresh occurrence.** One is enough to reopen this as a new bug citing `from: bug-1`, but it
is only worth reopening if the occurrence is captured rather than remembered — the reason this
groom ended here is that the 2026-08-31 sightings were tallies without a captured failure.
Record, at minimum: which suite and test failed, which of the two signatures, the full stack,
and what else was running on the machine (both original sightings happened around a
`backlog-orchestrate` run, so load is a live suspect that 20 idle-machine runs could not test).
Instrumenting `http.Server.prototype.listen`/`close` for the failing run — port plus owning
suite per event — is what would finally tie a failing request to the listener that died under
it, and turn the unproven race into a named one.

Two other things would also change the answer, without needing a failure at all: someone
touching these suites for an unrelated reason (the listener change is then nearly free and
worth folding in), or the churn growing again — a new supertest suite pushes the 86 cycles per
run higher, and the exposure scales with it.
