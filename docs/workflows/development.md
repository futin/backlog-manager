# Running the app while you work on it

Run this when you want the board in front of you — either the whole stack in Docker or the two processes on the host. There is no database to start and no
fixture to load: the registry file and each registered project's `backlog/` directory _are_ the data, so a working checkout plus a registered project is the
whole setup.

Two processes, always. The Nest API serves `/api` and, once built, the client bundle; Vite serves the client in development and proxies `/api` through to the
API. In development you open **Vite**, not the API — that is the one with hot reload.

## Steps

### Once

pnpm only, pinned by [`packageManager`](../../package.json) and enforced through corepack in the image. Node ≥ 22.13, the floor `engines.node` declares in the
same file; the image is `node:24-slim` ([`Dockerfile`](../../Dockerfile)). That floor is this repo's, not the package manager's — pnpm 12, the pinned version,
asks only for Node ≥ 18, where the pnpm 11 this was pinned to before died on Node 20 during its own module init, before it ever read the lockfile.

```bash
pnpm install
cp .env.example .env
```

Everything in [`.env.example`](../../.env.example) is commented out and documents its own default; the file matters for three things — moving the host-side
ports, pointing the container at a project tree that isn't `~/Documents/custom-projects`, and turning dispatch on. `BM_AGENTS` is **off** by default, and
compose passes it through as `${BM_AGENTS:-off}` rather than setting a literal, so that documented default survives the documented quick start.

### The whole stack

```bash
pnpm run docker:up
```

Then open **http://localhost:5177**. `docker:sync` is down-then-up when you want the image rebuilt from scratch; `docker:down` stops it. Both services build
from the same dev image and receive the source through a bind mount, so a code change needs no rebuild — but [`vite.config.ts`](../../vite.config.ts) is read at
server start, so editing it needs `docker compose restart client`.

### Host only

```bash
pnpm run dev      # Nest API, watch mode
pnpm run dev:web  # Vite
```

Ports are API **4322** and Vite **5177** (guide-manager holds 4321/5175/5176 on this machine). Only the host side moves, through `BM_API_PORT` / `BM_WEB_PORT`
in `.env`; inside the compose stack both are fixed, and the published port is what changes.

### What binds where

Both processes bind `127.0.0.1` unless `BM_BIND` says otherwise ([`server/src/main.ts`](../../server/src/main.ts), and the same default and override in
`vite.config.ts`). Nothing here has auth in front of it and `/api/items/body` reads registered projects' files straight off disk, so the bind is the access
control. Compose sets `BM_BIND=0.0.0.0` in both services for the opposite reason: there the `127.0.0.1:<port>:<port>` publish is the boundary, and a
container-loopback bind would only make the published port unreachable.

Reaching the board from another device is a separate, deliberate step: `pnpm run tailnet` ([`scripts/tailnet.mjs`](../../scripts/tailnet.mjs)) puts a
`tailscale serve` in front of the loopback port, reading `BM_WEB_PORT` the way compose reads it so the two ports are always one number — a hand-typed
`tailscale serve` stores a second copy of the port inside tailscaled instead, which drifts. That serve is also the only thing that makes
`allowedHosts: ['.ts.net']` in the Vite config mean anything.

### What the container mounts

`~/.backlog-manager` and the project tree come in **read-only**, at their host paths, because the registry stores absolute host paths and they have to mean the
same thing inside. One nested mount is read-write: `~/.backlog-manager/settings`, the only place the server itself writes — the watchdog config, and the pause
request a live run reads back. The image also carries `git` and a system-config `safe.directory` — see Failure modes.

## Verification

```bash
pnpm test        # both runners: jest, then node --test over the skills
pnpm run typecheck
pnpm run build
```

`pnpm test` is [`scripts/test-all.mjs`](../../scripts/test-all.mjs), and it runs `test:jest` **and** `test:skills` every time, printing a two-line PASS/FAIL
summary to **stderr** and exiting `1` if either failed. Both halves are load-bearing:

- The two runners cover disjoint trees. Jest's `testMatch` ([`jest.config.ts`](../../jest.config.ts)) is `test/**/*.test.ts(x)` and can never reach
  `test:skills`'s own glob pair — `skills/*/tools/*.test.mjs`, where this repo's single-writer tooling is proved, plus `scripts/*.test.mjs` — so bare jest under
  the name `test` was a false green over `orchestrate.mjs` and `backlog.mjs`.
- Stderr, and last, because an orchestrated item's verification step records only a short tail of stdout-then-stderr, and jest writes its whole report to
  stderr. A summary on stdout would sort _above_ jest's output and never survive the tail.

An orchestrator run verifies an item with `test`, `typecheck` and `build` resolved off [`package.json`](../../package.json), so those three are the real gate —
the same three a human types.

`typecheck` passes `--tsBuildInfoFile node_modules/.cache/tsconfig.tsbuildinfo`, and that flag is load-bearing rather than tuning. `tsconfig.json` sets
`incremental: true` with `outDir: ./dist`, so even `tsc --noEmit` writes `dist/tsconfig.tsbuildinfo` — and `dist/` belongs to **root**, because the compose
stack's server container builds into the same bind-mounted tree as the user that runs inside it. A host `pnpm run typecheck` then dies on
`error TS5033: … EACCES`, with nothing wrong with the code. Redirecting the file to `node_modules/` puts it back under the host user's ownership (and inside an
already-ignored directory). Deleting `dist/` does not fix it: the next `docker compose up` recreates it as root. Nothing in the image runs `typecheck`, so the
flag only ever affects the host.

Suites run in band, on a pinned timezone, with `BM_WATCHDOG=off` defaulted for every suite (`test/helpers/env.ts`, wired through `setupFiles`). That default is
not tidiness: any suite that builds `AppModule` arms the watchdog's bootstrap scan, which reads the developer's real orchestrator state directory unless the
suite overrode `BM_ORCH_HOME` — and with `BM_AGENTS` genuinely on in that shell, a crashed run sitting there would have `pnpm test` start a real agent session
against the developer's own repo.

A suite that hands a Nest app to supertest listens once through `listenLoopback` (`test/helpers/app.ts`), never with a bare `app.listen(0)` and never by leaving
the bind to supertest. A host-less bind lands on the IPv6 wildcard while supertest dials `127.0.0.1`, so another process holding that port on loopback answers
instead — about one request in 1,500 on a loaded machine, which is one unreproducible failure per full run and therefore a false red at the merge gate (bug-33;
the reasoning is in [invariants.md](../subsystems/invariants.md#a-supertest-suite-listens-once-on-127001-through-listenloopback)). `test/supertest-bind.test.ts`
fails the suite if a new one forgets.

A jsdom suite's fixture dates are relative, never literal: `daysAgoDate(2)` / `daysAgoStamp(0)` from `test/helpers/dates.ts`, both read at call time. An
absolute `created` is an expiry date rather than a constant — the card renders until the real clock passes `created + staleDays`, then `leavesBoard` moves the
item to the Archive and the query that wanted it throws, on a tree nobody touched (bug-44; the reasoning is in
[invariants.md](../subsystems/invariants.md#a-fixture-date-is-relative-to-the-clock-the-assertion-runs-under)). `test/fixture-clock.test.ts` reads every
`test/*.test.tsx` and fails on a literal, because a new one is green for thirty days and no behavioural test can be the guard.

## Failure modes

**Vite won't start.** `esbuild`'s install script was skipped: it has to be named in `allowBuilds` in [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml), and
pnpm runs no dependency install script otherwise. The symptom arrives much later than the cause — as a dev server that dies at startup, not as an install error.

**Every container start reinstalls the whole dependency tree.** `PNPM_CONFIG_STORE_DIR` disagreed with the path baked into `node_modules/.modules.yaml`, so pnpm
judged `node_modules` stale. It is pinned to `/pnpm/store` on both sides — the `Dockerfile` and both compose services — and the two must stay equal. Note the
prefix: pnpm reads `PNPM_CONFIG_*` and silently ignores the npm-compatible `npm_config_*` form, which looks exactly like the bug being unfixed.

**`EADDRINUSE` after a watch restart.** The Nest CLI restarts by walking the process tree with `ps`, and swallows a missing `ps` by returning no children — so
on an image without `procps` the real server survived as an orphan holding the port and every later rebuild died. Fixed twice over: `procps` in the image, and
`--no-shell` in the `dev` script so the server is the CLI's direct child.

**Every item's date looks like its `created:` date.** `git` is missing from the container, or git refuses the read-only host mounts as dubiously owned. The scan
derives each item's `lastCommit` through `git log` and **degrades silently** to `created` on any failure, which is the exact staleness bug that rung exists to
fix. The image installs `git` and adds `safe.directory` to _system_ config — `safe.directory` is honoured only from protected configuration, so neither `-c` nor
`GIT_CONFIG_*` would work.

**A new route 404s in dev — or worse, doesn't.** The Vite proxy has exactly one entry, `/api`, asserted by `test/vite-proxy.test.ts`. A route outside that
prefix is answered by Vite's SPA fallback with `index.html` rather than a 404, which reads as a broken response body instead of a missing route.

**`test/csp.test.ts` goes red after a theme change.** The served build carries a CSP whose `script-src` pins the pre-paint theme script's sha256
([`server/src/security.ts`](../../server/src/security.ts)). Editing that script means updating `THEME_SCRIPT_SHA256`; dev serves no CSP, so this only ever shows
up in the build path.

**A `.env` edit doesn't reach the container.** `environment:` in [`docker-compose.yml`](../../docker-compose.yml) _is_ `process.env` in the container, and
dotenv never overwrites a key already there — so a literal in that block outranks `.env` outright. That is why `BM_AGENTS` is a passthrough. `BM_AGENTS_URL` is
stack topology (`host.docker.internal`), not a policy default, so it is overridable under a **second** key instead: compose reads
`${BM_AGENTS_DOCKER_URL:-http://host.docker.internal:4173}` and never interpolates `BM_AGENTS_URL`, whose loopback value means the container itself in here. Set
`BM_AGENTS_DOCKER_URL` when that default cannot reach your host — under WSL2 it resolves and then refuses, and so do the bridge gateways, which is why
`extra_hosts: host-gateway` is no fix; use one of the host's own interface IPs, a tailnet address for preference. The symptom is a
`reachable: false, "error": "fetch failed"` from `/api/agents/status` while `curl 127.0.0.1:4173/api/health` on the host answers `200`.

<!-- docs-sync:
  sources:
    - package.json
    - jest.config.ts
    - vite.config.ts
    - pnpm-workspace.yaml
    - docker-compose.yml
    - Dockerfile
    - .env.example
    - scripts/test-all.mjs
    - server/src/main.ts
  kind: workflow
  verified: d3dbf8855e78b4ae70c792eeb7696167a44ce8a4
-->
