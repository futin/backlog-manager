---
id: bug-34
title: question-mode prompt-composition test flakes with a 400 under the full suite
created: 2026-09-07
tags: tests, flaky, agents, question-mode
updated: 2026-09-15T19:53:02Z
groom-elapsed: 2124
groom-tokens: 319713
rejected: 2026-09-15
---

## What was proposed

`test/question-mode.test.ts`'s case `composes ids, then the merge-mode flag, then the question-mode flag` failed intermittently under a full `pnpm test`
with `expected 201 "Created", got 400 "Bad Request"` — roughly 1 failure in 4 full runs, and 3 of 3 green in isolation. Grooming traced it to a defect
with nothing to do with question mode: supertest dials `http://127.0.0.1:<port>` unconditionally, but a bare `listen(0)` binds the wildcard address, so
the kernel hands out an ephemeral port another process may already hold on `127.0.0.1` and routes the dial to that stranger's socket. The 400 was some
other program's answer. The proposed fix had three steps — pre-listen every supertest suite on `127.0.0.1`, explicitly *not* by wrapping `listen()` to
supply the host, and a runtime guard in `test/helpers/env.ts` that throws on any host-less `listen()` call so a future suite cannot regress silently.

## Why rejected

Superseded by [bug-33](../done/bug-33-pnpm-test-intermittently-reports-one-supertest-failure-that-never-reproduces.md), which reached the same root
cause from four other sightings and shipped the fix on 2026-09-13 — after this item was groomed. bug-33's own Outcome names this item and says it
"is superseded by this fix and must be re-groomed, not executed as written". What landed there covers steps 1 and 2 outright:

- `listenLoopback` (`test/helpers/app.ts`) is the one place the host argument is written, and all 18 supertest suites call it — `question-mode.test.ts`
  included (`test/question-mode.test.ts:125`). Step 1's 15 suites are a subset of those 18; step 2's "do not wrap `listen()`" is the finding that made
  the awaited helper the only workable shape.
- `test/supertest-bind.test.ts` pins it with 8 cases: the IPv4 bind assertion, listen/close spies proving supertest re-binds nothing per request, three
  deterministic platform-characterisation cases, and a two-half source guard (every supertest suite calls the helper; no bare `.listen(0)` anywhere
  under `test/`).
- The rule and its rationale are recorded in `CLAUDE.md` `## Conventions` and `docs/subsystems/invariants.md`.

The symptom this item was filed for is therefore gone by construction, and nothing here can be executed as written. Step 3 is the only part not already
covered, and it is rejected on its own merits rather than as collateral:

- **As written it turns bug-33's proof red.** `test/supertest-bind.test.ts:151` and `:161` make host-less `listen(port)` calls deliberately — that IS
  the bug being reproduced, and the only deterministic evidence the mechanism exists on this platform. A process-wide throwing wrapper in `env.ts`
  (a `setupFiles` entry, so it loads for every test file) would fire inside those cases. Shipping it means inventing an escape hatch whose only user is
  the file proving the defect, and an exemption a future suite can claim too — which is precisely what bug-33's source guard was built to avoid
  (it assembles its own needle from two string pieces so the rule can stay exemption-free).
- **The gap it would close is one documented case, not a class.** The source guard's own comment states what it cannot catch: a suite that builds a
  SECOND app and listens only the first still contains `listenLoopback(` and passes. Two such pairs exist today (`csp.test.ts`, `allowed-hosts.test.ts`)
  and both call the helper for every app they hand to `request(...)`. That is a reader's check on a third, not a standing hole.
- The remaining verification value — a bind census proving 3,536/3,536 calls report `127.0.0.1`, and 10 consecutive green full runs — is a measurement,
  not a defect. bug-33 declined the statistical half on purpose and said why: a single passing run cannot distinguish a fixed lottery from an unlucky
  draw that did not happen, so the evidence it rests on is the deterministic characterisation block instead. Re-litigating that choice under this item's
  id would attach it to a symptom that no longer exists.

## What would change the answer

- A supertest suite ships that builds a second app and hands it to `request(...)` without listening it — the source guard's one blind spot becoming
  real rather than hypothetical. That is the case a runtime guard is worth its exemption for, and it wants a fresh item citing `from: bug-34`.
- The flake recurs after bug-33: any full `pnpm test` producing a status, parse error or hang that the route under test cannot produce, on a tree where
  every supertest suite goes through `listenLoopback`. That would mean the mechanism has a second path and the diagnosis above is incomplete.
- Someone wants the bind census as a standing check rather than a one-off — instrumenting `http.Server.prototype.listen` to *record* rather than throw,
  and asserting every bind in a run reports `127.0.0.1`. That is a new test with no exemption problem and no conflict with the characterisation cases,
  and it is a task, not a bug.
