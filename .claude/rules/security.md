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
- **The server never writes git: every git call it makes is a read, and fetch, worktree add/remove and checkout are the session's.** `runGit`
  (`git-run.util.ts`) is the one way the server runs git, and every verb it is handed is a read: `rev-parse`, `for-each-ref`, `rev-list`, `symbolic-ref`,
  `show-ref`, `check-ref-format`, `log`, `diff`, `ls-files`, `remote get-url`, `describe`, `worktree list`. Nothing under `server/src` fetches, adds or removes
  a worktree, checks out, commits, merges or pushes — `jira.mjs worktree` does that on a Jira Run, in the session, and the modal's Remove only COPIES
  `git -C <repo> worktree remove <path>`. The foreign repos `jira/refs.util.ts` reads are listed as of their last fetch, and say so. Under compose both
  project roots are mounted `:ro`; a host-run API has no such net, so a new git call under `server/src` is a read or it belongs to a session. Why:
  [invariants.md](docs/subsystems/invariants.md#the-server-never-writes-git)
