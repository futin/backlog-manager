---
paths: ["server/src/*.ts", "vite.config.ts", "docker-compose.yml"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **Both processes bind `127.0.0.1` by default; loopback is the access control** (nothing has auth). `BM_BIND` is the single knob; compose sets `0.0.0.0`. Both
  halves are pinned: `test/vite-proxy.test.ts` imports the dev config, `test/server-bind.test.ts` reads `server/src/main.ts`'s SOURCE — a bare
  `app.listen(PORT)` fails it. Why: [invariants.md](docs/subsystems/invariants.md#loopback-bind-is-the-access-control-except-where-noted)
- **Every route is gated by a Host allowlist, because a bind is no defence against DNS rebinding** (bug-22). `isAllowedHost` (`server/src/allowed-hosts.ts`) is
  the one implementation; loopback and every other IP literal, `localhost`, `.ts.net` and `BM_ALLOWED_HOSTS` are the only names this app answers to, and an
  absent or empty `Host` is refused, never defaulted. Hostname only, never the port; read from the environment per request, never cached. The gate is registered
  by the **same applier as the CSP** (`applySecurityMiddleware`, host gate first), so no app built here can carry one without the other, and it is global rather
  than scoped to the agents POSTs because the read routes are exposed to the same page. The origin guard is deliberately unchanged — it inherits the allowlist
  transitively. Why: [invariants.md](docs/subsystems/invariants.md#every-route-is-gated-by-a-host-allowlist)
