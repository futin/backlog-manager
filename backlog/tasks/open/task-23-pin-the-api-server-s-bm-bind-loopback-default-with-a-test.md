---
id: task-23
title: Pin the API server's BM_BIND loopback default with a test
created: 2026-09-06
tags: tests, security, audit-2026-09-06
---

## Goal

`const BIND = process.env.BM_BIND ?? '127.0.0.1'` (`server/src/main.ts:20`) is the project's
single documented access-control knob — CLAUDE.md's "Both processes bind `127.0.0.1` by
default; loopback is the access control (nothing has auth)" rests on it — and nothing
automated asserts it. A refactor to a bare `app.listen(PORT)` would bind `0.0.0.0` on the
host, exposing an unauthenticated API that can spawn Claude Code sessions, and every test
would stay green.

The asymmetry is what makes this a gap rather than a philosophy: the sibling invariant for
the **dev** server *is* pinned, at `test/vite-proxy.test.ts:48-51`. One half of the same rule
is guarded and the other is not.

Raised as an **Important** finding of the 2026-09-06 audit, upheld. The finding's one
overstatement was corrected there and matters to the plan: it said `main.ts` "cannot be
imported to test it". It can — that shapes the approach below rather than blocking it.

## Plan

The obstacle is real but small: `main.ts:32` calls `bootstrap()` unconditionally at top
level with no `require.main` guard, so a plain import starts a listening server. Two ways
past it, and the choice is the substance of this item:

**Preferred: assert against the source text, in the same style the sibling already uses.**
`test/vite-proxy.test.ts` is the established precedent here for pinning a config invariant,
and it keeps the test free of Nest bootstrapping entirely. Read `server/src/main.ts` and
assert the bind expression is present and defaults to loopback. Weak against a refactor that
*moves* the logic while keeping the string, which is why the assertion should be written to
fail on a bare `listen(PORT)` rather than merely to find `127.0.0.1` somewhere in the file.

**Alternative: make the module importable and assert the call.** Mock `@nestjs/core` so
`NestFactory.create` returns a stub whose `listen` records its arguments, then import the
module and assert `listen` was called with `(PORT, '127.0.0.1')` when `BM_BIND` is unset, and
with the override when it is set. Stronger — it tests behaviour, not text — but it either
needs a `require.main` guard added to `main.ts` or it accepts that importing runs
`bootstrap()` against the mock. Adding that guard is a production change to the entrypoint
for a test's benefit; weigh it, and if it is taken, say so in `main.ts`'s own comment.

Pick one, do not do both. Either way, do **not** open a real socket in the test — that would
make the suite port-dependent, and this repo already juggles ports against guide-manager on
this machine.

While there: the same file's `PORT` resolution is unpinned for the same reason. Adding it is
cheap and in scope if the chosen approach makes it a one-liner; skip it if it does not.

## Test cases

- With `BM_BIND` unset, the server binds `127.0.0.1` — not `0.0.0.0`, not undefined, not a
  bare single-argument `listen`.
- With `BM_BIND` set to `0.0.0.0`, that value is used — the knob still works, which is what
  the compose stack depends on.
- A hand-edited `main.ts` reduced to `app.listen(PORT)` fails the new test. Prove this by
  actually making the edit, running the suite, and reverting — a pinning test that has never
  been seen to fail is not yet known to pin anything.
- The test opens no listening socket (nothing in the suite becomes port-dependent).

## Done when

```
pnpm test
```

```
pnpm run typecheck
```

- The bare-`listen(PORT)` regression has been shown to fail the new test, with the failure
  output recorded in the outcome.
