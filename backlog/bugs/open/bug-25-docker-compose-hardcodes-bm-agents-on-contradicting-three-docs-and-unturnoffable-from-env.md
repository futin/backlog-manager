---
id: bug-25
title: docker-compose hardcodes BM_AGENTS on, contradicting three docs and unturnoffable from .env
created: 2026-09-06
tags: docker, security, audit-2026-09-06
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

`git blame`: commit `f7b343b5` ("fix(compose): point the container at host.docker.internal")
uncommented **both** lines when only `BM_AGENTS_URL` needed it. `BM_AGENTS: 'on'` came along
as collateral and nobody noticed, because the comment above it still reads correctly.

## Fix

unknown — the obvious repair is `BM_AGENTS: ${BM_AGENTS:-off}` so the literal becomes an
env-file passthrough with the documented default, which also makes the neighbouring comment
true again. Worth confirming while there whether `BM_AGENTS_URL` (the line that actually
needed uncommenting) should get the same treatment, and whether any other `environment:`
entry in that file is a literal where a passthrough was intended.
