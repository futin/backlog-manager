---
id: bug-1
title: Full-suite supertest runs flake on connection teardown
created: 2026-08-31
tags: tests, flake
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

unknown.

What the evidence narrows it to: pre-merge main is clean across 8 runs, so the
`backlog-orchestrate` branch is what tips the run into flaking — but the failures land on
pre-existing suites, so the new suites are almost certainly not themselves buggy. They
roughly double the number of full-`AppModule` Nest apps created and destroyed per run,
and the plausible mechanism is that a socket or listener outliving its `app.close()`
gets picked up by a later suite's client — which is exactly what `Parse Error: Expected
HTTP/` means: something read a response that was not HTTP.

Worth checking first: whether every suite's `afterEach`/`afterAll` actually awaits full
teardown, whether any outbound-fetch stub (the fake dashboard in the agents suites) leaves
a server listening, and whether a keep-alive agent is being reused across apps.

## Fix

unknown.

The partial fix in `532f901` removed one source (supertest cycling `listen`/`close` on a
suite making two sequential requests) and is worth keeping regardless of what the root
cause turns out to be. It did not stop the family — the failure simply moved to another
suite — so it is a mitigation, not the fix.
