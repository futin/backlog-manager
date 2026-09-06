---
id: bug-25
title: docker-compose hardcodes BM_AGENTS on, contradicting three docs and unturnoffable from .env
created: 2026-09-06
tags: docker, security, audit-2026-09-06
updated: 2026-09-06T23:16:38Z
groom-elapsed: 114
groom-tokens: 16811
started: 2026-09-06T23:09:06Z
execute-elapsed: 452
execute-tokens: 37156
---

## Symptom

The documented Quick start silently enables outbound agent dispatch. `docker-compose.yml`
sets `BM_AGENTS: 'on'` as a literal, four lines under its own comment saying "Dispatch is
off unless you turn it on", while README, `.env.example` and CLAUDE.md all promise
off-by-default.

Because the value is a literal rather than `${BM_AGENTS:-off}`, and because
`ConfigModule.forRoot({ isGlobal: true })` never lets dotenv override `process.env`,
**editing `.env` cannot turn it back off**. There is no supported way to get the documented
default out of the documented Quick start.

Consequence is not only the dispatch buttons: `config.util.ts:35`'s `enabled: true` is the
sole environment gate for both those buttons *and* for arming the watchdog sweeper. So a
crashed run in that stack can be auto-resumed with an outbound spawn and no click from
anyone. The loopback publish and `origin.guard.ts` bound the blast radius; they do not
restore the documented default.

## Repro

```
cp .env.example .env
pnpm run docker:up
```

Board comes up with dispatch controls rendered. Setting `BM_AGENTS=off` in `.env` and
restarting changes nothing.

## Affects

- `docker-compose.yml:61` — the comment "Dispatch is off unless you turn it on"
- `docker-compose.yml:65` — `BM_AGENTS: 'on'`, directly beneath it
- `README.md:86` — tables `BM_AGENTS` default `off`
- `README.md:107` — "Off until you set `BM_AGENTS=on`"
- `README.md:48-49` — the Quick start that turns it on
- `.env.example:30-32` — "Off unless BM_AGENTS is on/1/true"
- `CLAUDE.md:628` — same promise
- `server/src/agents/config.util.ts:35` — `enabled: true`, the one gate for dispatch buttons
  and for arming the watchdog sweeper
- the design spec, which says the compose value is "Documented in docker-compose.yml as a
  comment, not defaulted"

## Cause

Two independent facts, and the bug needs both — either alone would be harmless.

**The literal.** `git log -L 61,66:docker-compose.yml` shows the pair landing commented out
in `9c7127f` ("docs: agent dispatch env, setup and invariants") and being uncommented
together in `f7b343b5` ("fix(compose): point the container at host.docker.internal"). Only
`BM_AGENTS_URL` needed uncommenting there — inside the stack the dashboard is on the host,
so the loopback default is wrong and the line has to be set. `BM_AGENTS: 'on'` came along
as collateral in the same hunk, and nobody noticed because the comment above the pair still
reads correctly: its first sentence describes the BM_AGENTS line, its remaining three
describe the URL line, so the sentence that went false is the one furthest from the line it
belongs to.

**The precedence.** `@nestjs/config`'s `ConfigModule.forRoot({ isGlobal: true })`
(`server/src/app.module.ts:14`) loads `.env` through dotenv, which never overwrites a key
already present in `process.env`. The compose `environment:` block IS `process.env` in the
container, so `.env` is read and then loses. `.env` is genuinely there to lose, too: it is
in `.dockerignore`, but that only governs the build context, and the `.:/app` bind mount —
which is what actually supplies `/app` at runtime — carries the host's `.env` in regardless.
So the file is present, is read, and is silently outranked. That is why the Symptom's
"editing `.env` cannot turn it back off" holds: it is not that the value is unreachable,
it is that it is shadowed.

One correction to `## Affects`, so nobody goes looking for a hardcoded `true`:
`server/src/agents/config.util.ts:35` is `enabled: flag === 'on' || flag === '1' || flag ===
'true'`, not a literal. It reads `true` in the stack purely because `BM_AGENTS=on` is handed
to it. `config.util.ts` is correct as written and is not part of the fix — its strictness
(a typo means off) is the very posture the compose literal defeats one layer up.

## Fix

One line of behaviour change in `docker-compose.yml`, plus the comment that describes it,
plus a test so the line cannot be uncommented into a literal again.

1. **`docker-compose.yml:65` becomes an env-file passthrough with the documented default:**

   ```yaml
   BM_AGENTS: '${BM_AGENTS:-off}'
   ```

   `:-` rather than `-`, so an empty `BM_AGENTS=` reads as off like an absent one. Quoted
   for consistency with the neighbouring values, and because the ports below
   (`'127.0.0.1:${BM_API_PORT:-4322}:4322'`) already prove compose interpolates inside
   single quotes in this exact file. Compose interpolates from the host environment and
   from the `.env` beside `docker-compose.yml` — the same file the container's own
   ConfigModule reads — so after this change both layers resolve the value from one
   source instead of one shadowing the other, and a user who already has `BM_AGENTS=on`
   in `.env` (the machine this was filed on does) keeps the stack they have today.

2. **`BM_AGENTS_URL:66` deliberately stays a literal** — this is the "worth confirming
   while there" question from the capture, and the answer is no. That value is stack
   topology, not a policy default: inside the container the dashboard is reachable only
   at `host.docker.internal`, while `.env.example:38` documents the loopback form because
   that is the correct one for `pnpm run dev` on the host. Making it a passthrough would
   let a host-oriented `.env` line flow in and silently break dispatch in the stack —
   turning a line that is right today into one whose correctness depends on a file it
   does not control. Add that reason to the comment; without it, the next reader sees one
   passthrough beside one literal and "fixes" the asymmetry.

3. **Split the comment at `docker-compose.yml:61-64`** so each sentence sits on the line it
   describes: "Dispatch is off unless you turn it on" above `BM_AGENTS` (true again once
   step 1 lands), the `host.docker.internal` explanation plus step 2's reason above
   `BM_AGENTS_URL`.

4. **Audit result for the rest of the file — no other entry changes.** Every other literal
   in either `environment:` block is fixed-inside-the-stack by design, exactly as the
   file's own header says ("Only the host side of each published port is configurable"):
   `CI`, `PORT`, `WEB_PORT`, `API_HOST`, `BM_BIND` (`0.0.0.0` on purpose — the publish is
   the boundary), `CHOKIDAR_USEPOLLING`, `PNPM_CONFIG_STORE_DIR` (must match the
   Dockerfile exactly), and `HOME`, which is already `${HOME}`. `BM_AGENTS` was the only
   literal that encoded a *policy default* rather than container topology, which is
   precisely why it was the only one that could contradict the docs.

5. **The variables compose does not set stay unset** — `BM_AGENTS_TOKEN`, `BM_WATCHDOG`,
   `BM_REGISTRY_FILE`, `BM_WATCHDOG_FILE`. Nothing shadows them, so `/app/.env` reaches
   them through ConfigModule and they already work; adding passthroughs would be churn.

6. **Documentation needs no edit.** README's env table, `.env.example:30-32` and CLAUDE.md
   all already state the off default — they were never wrong, the compose file was. The
   fix is what makes them true; changing them would ratify the bug. README's Quick start
   (`cp .env.example .env && pnpm run docker:up`) then brings the stack up with dispatch
   off, which is what it has always claimed.

7. **Add one CLAUDE.md clause** to the existing invariant "**The browser never talks to the
   dashboard** … `BM_AGENTS` defaults to off": say that compose passes it through as
   `${BM_AGENTS:-off}` and never sets it as a literal, naming bug-25. One clause on the
   invariant that already owns this default — not a new invariant.

8. **Pin it with a test**, since prose above a line is exactly what failed here. There is
   no compose test in `test/` yet and no YAML parser in the dependency tree, so assert
   against the raw file text, the way `test/vite-proxy.test.ts` and `test/csp.test.ts`
   already assert config files:

   - the file contains the passthrough line for `BM_AGENTS` with an `off` default;
   - no uncommented line in the file assigns `BM_AGENTS` any of the values
     `readAgentsConfig` treats as enabling (`on`, `1`, `true`, quoted or bare) — i.e. the
     test fails on the exact edit `f7b343b5` made, not merely on the absence of the new
     line;
   - `BM_AGENTS_URL` is still the `host.docker.internal` literal, so step 2's ruling is
     enforced rather than remembered.

### Verification

- `pnpm test` — the new compose test is red against the current `BM_AGENTS: 'on'` and green
  after step 1. Write it first and watch it fail; a test that never saw the bug proves
  nothing here.
- `pnpm run typecheck`.
- Render the compose file as a fresh checkout would see it, without starting anything and
  without reading this machine's `.env`:

  ```bash
  env -u BM_AGENTS docker compose --env-file /dev/null config | grep BM_AGENTS
  ```

  Must print `BM_AGENTS: "off"` and the unchanged `host.docker.internal` URL. Then confirm
  the opt-in path still works:

  ```bash
  BM_AGENTS=on docker compose --env-file /dev/null config | grep BM_AGENTS:
  ```

  Must print `BM_AGENTS: "on"`. `docker compose config` only renders and validates — it
  creates no container and touches no running stack.

No `In the browser (playwright MCP tools):` check on this one, and that is a decision
rather than an omission. The browser-visible consequence is the dispatch buttons, and
reaching it means `docker compose up --build` on `:4322`/`:5177` — ports the user's own
stack normally holds — then tearing it down again, so a headless session proving this in a
browser would be fighting the operator for the ports rather than testing the defect. The
`docker compose config` render above asserts the same fact directly, deterministically, and
without starting a container.

## Outcome

2026-09-07 — Fixed as planned, all eight steps, no deviations.

`docker-compose.yml:65` is now `BM_AGENTS: '${BM_AGENTS:-off}'`. The comment above it was
split in two (Fix step 3): the "dispatch is off unless you turn it on" sentence sits over
`BM_AGENTS` and now says *why* it is a passthrough — the `environment:` block is
`process.env` in the container and dotenv never overwrites a key already there, so a
literal wins outright — while the `host.docker.internal` explanation moved down over
`BM_AGENTS_URL`, carrying step 2's ruling (it stays a literal because it is stack topology,
not a policy default, and a passthrough would let a host-oriented `.env` break dispatch in
the stack). No other compose entry changed (step 4), nothing was added for the variables
compose does not set (step 5), and no documentation was edited (step 6) — README,
`.env.example` and CLAUDE.md were already right, and this is what makes them true.

Step 7: one clause added to CLAUDE.md's existing "**The browser never talks to the
dashboard**" invariant, naming bug-25, the passthrough form and the test that pins it, plus
the asymmetry with `BM_AGENTS_URL` so the next reader does not "fix" it.

Step 8: `test/compose-env.test.ts`, new, three cases asserting the raw file text the way
`test/vite-proxy.test.ts` and `test/csp.test.ts` already assert config files. Written
first and watched fail against the unfixed file — two of the three red, on the exact edit
`f7b343b5` made rather than merely on the absence of the new line:

```
 ● docker-compose BM_AGENTS › passes the host value through with the documented off default

    - Array [
    -   "${BM_AGENTS:-off}",
    +   "on",
      ]

      41 |     expect(assignments('BM_AGENTS')).toEqual(['${BM_AGENTS:-off}']);

 ● docker-compose BM_AGENTS › never assigns a value the server would read as enabled

    Expected: false
    Received: true

      52 |       expect(readAgentsConfig({ BM_AGENTS: value }).enabled).toBe(false);

Test Suites: 1 failed, 1 total
Tests:       2 failed, 1 passed, 3 total
```

The enabling-value case is driven through `readAgentsConfig` itself rather than a
hand-copied `on`/`1`/`true` list, so that vocabulary keeps exactly one copy. Green after
the compose edit:

```
 PASS  test/compose-env.test.ts
  docker-compose BM_AGENTS
    ✓ passes the host value through with the documented off default (2 ms)
    ✓ never assigns a value the server would read as enabled (1 ms)
    ✓ keeps BM_AGENTS_URL a literal, because it is topology and not policy

Tests:       3 passed, 3 total
```

### Verification

`pnpm test` — both runners, as `scripts/test-all.mjs` requires:

```
1..411
# tests 411
# pass 411
# fail 0
# duration_ms 57133.121584

────────────────────────────────────────────────────────────
PASS  jest
PASS  node --test (skills)

pnpm test: both runners passed.
```

jest's own half, run again for the counts the summary above elides:

```
Test Suites: 78 passed, 78 total
Tests:       1480 passed, 1480 total
Snapshots:   0 total
Time:        61.675 s
```

`pnpm run typecheck`:

```
$ tsc --noEmit
typecheck exit: 0
```

The compose render, as a fresh checkout would see it — no container started, this machine's
`.env` deliberately not read:

```
$ env -u BM_AGENTS docker compose --env-file /dev/null config | grep -i BM_AGENTS
      BM_AGENTS: 'off'
      BM_AGENTS_URL: http://host.docker.internal:4173

$ BM_AGENTS=on docker compose --env-file /dev/null config | grep -i 'BM_AGENTS:'
      BM_AGENTS: 'on'
```

Documented default restored, opt-in path intact, `BM_AGENTS_URL` unchanged. No browser
check, for the reason the plan gives: reaching the browser-visible consequence means
holding `:4322`/`:5177` against the operator's own stack, and the render above asserts the
same fact directly.
