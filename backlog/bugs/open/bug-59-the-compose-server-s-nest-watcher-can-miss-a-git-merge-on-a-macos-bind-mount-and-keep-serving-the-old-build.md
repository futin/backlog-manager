---
id: bug-59
title: The compose server's nest watcher can miss a git merge on a macOS bind mount and keep serving the old build
created: 2026-09-22
tags: docker, dev
---

## Symptom

After a `git merge` on the Mac host, the compose `server` container kept serving the pre-merge build: bug-55's `reconcileClaimedIssues` was absent from
`/app/dist/server/src/tracker/poller.service.js`, so the first bug-55 live attempt on 2026-09-22 ran the old code. `docker compose restart server` fixed it.
Nothing on the board says which build is running, so the stale state is invisible until behaviour disagrees with the code.

## Repro

1. Stack up via `pnpm run docker:up` on macOS.
2. Merge a branch that changes `server/src/**` on the host.
3. `docker compose exec server grep -c <new symbol> /app/dist/server/src/<file>.js` prints `0`.

Not confirmed deterministic — happened once, after an orchestrator merge.

## Affects

- `docker-compose.yml:39` (`command: pnpm run dev` → `package.json:14`, `nest start --watch --no-shell`)
- the host bind mount of the repo into `/app` in `docker-compose.yml`

## Cause

unknown — likely the watcher on a macOS bind mount missing some of git's writes (rename-into-place, or a burst of file events during the merge), but not
proven.

## Fix

unknown — options to weigh: polling watch for the container (`CHOKIDAR_USEPOLLING` / `watchOptions`), or having the orchestrator's merge step (or the
`docker:sync` docs) restart the server; at minimum surface the running build's commit on `/api/health` so a stale server is visible.
