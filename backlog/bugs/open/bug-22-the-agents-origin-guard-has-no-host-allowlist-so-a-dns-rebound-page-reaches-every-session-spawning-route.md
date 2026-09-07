---
id: bug-22
title: The agents origin guard has no Host allowlist, so a DNS-rebound page reaches every session-spawning route
created: 2026-09-06
tags: security, audit-2026-09-06
---

## Symptom

`SameOriginPostGuard` compares `new URL(origin).host` against `req.headers.host` and
nothing else. Both headers are controlled by the same attacking page, so a DNS-rebinding
page satisfies the equality check while its own `fetch` is genuinely same-origin — which
means no preflight, and `content-type: application/json` passes the guard's other check
for free. Both of the guard's checks clear, and the request lands on every POST the guard
protects, `dispatch` / `orchestrate` / `resume` included.

Raised as the sole **Critical** of the 2026-09-06 audit (`audits/2026-09-06-audit.md`),
upheld by its skeptic pass.

## Repro

Not reproduced end to end — the rebinding half needs an attacker-controlled domain and a
short-TTL DNS record. The guard-clearing half is reproducible directly:

```
curl -X POST http://127.0.0.1:4322/api/agents/dispatch \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://evil.test:4322' \
  -H 'Host: evil.test:4322' \
  -d '{"project":"...","id":"...","prompt":"..."}'
```

The guard accepts it: the two headers agree, and the content-type is the one it wants.

Full chain, as the attack would run it: a victim on this machine loads a page from a
domain the attacker controls, served on port 4322. After load, DNS for that domain
re-resolves to 127.0.0.1. The page `fetch`es `/api/agents/dispatch`. The browser treats it
as same-origin — no preflight, `application/json` sent freely — and both `Origin` and
`Host` read `evil.test:4322`, so the equality holds. The local API forwards the attacker's
`prompt` verbatim to the dashboard's `POST /api/spawn` at the dashboard's permission
ceiling: a Claude Code session with file-write permission in another repo on this machine.

## Affects

- `server/src/agents/origin.guard.ts:97` — `sameOrigin` is the bare host equality
- `server/src/main.ts:24` — `await app.listen(PORT, BIND)`, no Host validation, no helmet,
  no host middleware
- `server/src/app.module.ts`, `server/src/security.ts` — no host check either; the CSP's
  `connect-src 'self'` binds the board's own pages, not an attacker's
- `server/src/agents/agents.controller.ts:82` — forwards `body.prompt` verbatim into
  `AgentsService.dispatch` → `POST /api/spawn`, `permissionMode` clamped only to the
  dashboard ceiling
- `docs/subsystems/invariants.md:1185-1206` and the guard's own header comment — the documented
  threat model, which names hidden cross-origin form POSTs and `Origin: null` only

## Cause

The guard is not broken; its threat model simply never names rebinding. Loopback binding
is not the failure either — `BM_BIND` does what it claims. The gap is that nothing in the
stack validates `Host` against an allowlist, so the one identity a rebound page cannot
forge is never checked.

Stated narrowly on purpose: the origin guard is not useless, and this is not an argument
that loopback is the wrong access control. It is one unclosed case in a defence the repo
deliberately built.

## Fix

unknown — the standard mitigation is a `Host` allowlist (`localhost`, `127.0.0.1`, `[::1]`,
plus whatever tailnet name is deliberately served, presumably an env knob alongside
`BM_BIND`), rejecting anything else before the origin comparison runs. Whether that lives
in `SameOriginPostGuard` (agents routes only, matching today's blast radius) or as global
middleware (every route, including the item-body allowlist and the orchestrator reader) is
the open design call, and it decides whether `docs/subsystems/invariants.md`'s "loopback is the access
control" invariant needs restating.
