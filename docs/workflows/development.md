# Running the app while you work on it

Run this when you want the board in front of you — either the whole stack in Docker or
the two processes on the host. There is no database to start and no fixture to load: the
registry file and each registered project's `backlog/` directory *are* the data, so a
working checkout plus a registered project is the whole setup.

Two processes, always. The Nest API serves `/api` and, once built, the client bundle;
Vite serves the client in development and proxies `/api` through to the API. In
development you open **Vite**, not the API — that is the one with hot reload.

## Steps

### Once

pnpm only, pinned by [`packageManager`](../../package.json) and enforced through corepack
in the image. Node ≥ 22.13, because pnpm 11 declares that engine and means it — on Node
20 it dies during its own module init before it reads the lockfile
([`Dockerfile`](../../Dockerfile)).

```bash
pnpm install
cp .env.example .env
```

Everything in [`.env.example`](../../.env.example) is commented out and documents its own
default; the file matters for three things — moving the host-side ports, pointing the
container at a project tree that isn't `~/Documents/custom-projects`, and turning
dispatch on. `BM_AGENTS` is **off** by default, and compose passes it through as
`${BM_AGENTS:-off}` rather than setting a literal, so that documented default survives
the documented quick start.

### The whole stack

```bash
pnpm run docker:up
```

Then open **http://localhost:5177**. `docker:sync` is down-then-up when you want the
image rebuilt from scratch; `docker:down` stops it. Both services build from the same
dev image and receive the source through a bind mount, so a code change needs no rebuild
— but [`vite.config.ts`](../../vite.config.ts) is read at server start, so editing it
needs `docker compose restart client`.

### Host only

```bash
pnpm run dev      # Nest API, watch mode
pnpm run dev:web  # Vite
```

Ports are API **4322** and Vite **5177** (guide-manager holds 4321/5175/5176 on this
machine). Only the host side moves, through `BM_API_PORT` / `BM_WEB_PORT` in `.env`;
inside the compose stack both are fixed, and the published port is what changes.

### What binds where

Both processes bind `127.0.0.1` unless `BM_BIND` says otherwise
([`server/src/main.ts`](../../server/src/main.ts), and the same default and override in
`vite.config.ts`). Nothing here has auth in front of it and `/api/items/body` reads
registered projects' files straight off disk, so the bind is the access control. Compose
sets `BM_BIND=0.0.0.0` in both services for the opposite reason: there the
`127.0.0.1:<port>:<port>` publish is the boundary, and a container-loopback bind would
only make the published port unreachable.

Reaching the board from another device is a separate, deliberate step — put your own
`tailscale serve` in front of the loopback port. That is also the only thing that makes
`allowedHosts: ['.ts.net']` in the Vite config mean anything.

### What the container mounts

`~/.backlog-manager` and the project tree come in **read-only**, at their host paths,
because the registry stores absolute host paths and they have to mean the same thing
inside. One nested mount is read-write: `~/.backlog-manager/settings`, the only place the
server itself writes (the watchdog config). The image also carries `git` and a
system-config `safe.directory` — see Failure modes.

## Verification

```bash
pnpm test        # both runners: jest, then node --test over the skills
pnpm run typecheck
pnpm run build
```

`pnpm test` is [`scripts/test-all.mjs`](../../scripts/test-all.mjs), and it runs
`test:jest` **and** `test:skills` every time, printing a two-line PASS/FAIL summary to
**stderr** and exiting `1` if either failed. Both halves are load-bearing:

- The two runners cover disjoint trees. Jest's `testMatch`
  ([`jest.config.ts`](../../jest.config.ts)) is `test/**/*.test.ts(x)` and can never
  reach `skills/*/tools/*.test.mjs`, which is where this repo's single-writer tooling is
  proved — so bare jest under the name `test` was a false green over
  `orchestrate.mjs` and `backlog.mjs`.
- Stderr, and last, because an orchestrated item's verification step records only a short
  tail of stdout-then-stderr, and jest writes its whole report to stderr. A summary on
  stdout would sort *above* jest's output and never survive the tail.

An orchestrator run verifies an item with `test`, `typecheck` and `build` resolved off
[`package.json`](../../package.json), so those three are the real gate — the same three a
human types.

Suites run in band, on a pinned timezone, with `BM_WATCHDOG=off` defaulted for every
suite (`test/helpers/env.ts`, wired through `setupFiles`). That default is not tidiness:
any suite that builds `AppModule` arms the watchdog's bootstrap scan, which reads the
developer's real orchestrator state directory unless the suite overrode `BM_ORCH_HOME` —
and with `BM_AGENTS` genuinely on in that shell, a crashed run sitting there would have
`pnpm test` start a real agent session against the developer's own repo.

## Failure modes

**Vite won't start.** `esbuild`'s install script was skipped: it has to be named in
`allowBuilds` in [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml), and pnpm 11 runs no
dependency install script otherwise. The symptom arrives much later than the cause — as a
dev server that dies at startup, not as an install error.

**Every container start reinstalls the whole dependency tree.** `PNPM_CONFIG_STORE_DIR`
disagreed with the path baked into `node_modules/.modules.yaml`, so pnpm judged
`node_modules` stale. It is pinned to `/pnpm/store` on both sides — the `Dockerfile` and
both compose services — and the two must stay equal. Note the prefix: pnpm 11 reads
`PNPM_CONFIG_*` and silently ignores the npm-compatible `npm_config_*` form, which looks
exactly like the bug being unfixed.

**`EADDRINUSE` after a watch restart.** The Nest CLI restarts by walking the process tree
with `ps`, and swallows a missing `ps` by returning no children — so on an image without
`procps` the real server survived as an orphan holding the port and every later rebuild
died. Fixed twice over: `procps` in the image, and `--no-shell` in the `dev` script so the
server is the CLI's direct child.

**Every item's date looks like its `created:` date.** `git` is missing from the
container, or git refuses the read-only host mounts as dubiously owned. The scan derives
each item's `lastCommit` through `git log` and **degrades silently** to `created` on any
failure, which is the exact staleness bug that rung exists to fix. The image installs
`git` and adds `safe.directory` to *system* config — `safe.directory` is honoured only
from protected configuration, so neither `-c` nor `GIT_CONFIG_*` would work.

**A new route 404s in dev — or worse, doesn't.** The Vite proxy has exactly one entry,
`/api`, asserted by `test/vite-proxy.test.ts`. A route outside that prefix is answered by
Vite's SPA fallback with `index.html` rather than a 404, which reads as a broken response
body instead of a missing route.

**`test/csp.test.ts` goes red after a theme change.** The served build carries a CSP
whose `script-src` pins the pre-paint theme script's sha256
([`server/src/security.ts`](../../server/src/security.ts)). Editing that script means
updating `THEME_SCRIPT_SHA256`; dev serves no CSP, so this only ever shows up in the
build path.

**A `.env` edit doesn't reach the container.** `environment:` in
[`docker-compose.yml`](../../docker-compose.yml) *is* `process.env` in the container, and
dotenv never overwrites a key already there — so a literal in that block outranks `.env`
outright. That is why `BM_AGENTS` is a passthrough, and why `BM_AGENTS_URL` is
deliberately still a literal: it is stack topology (`host.docker.internal`), not a policy
default.

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
  verified: 9af3c42862f28594255816111b350f39890170c4
-->
