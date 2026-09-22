---
id: task-51
title: Per-repo tracker sync interval (15s / 1m / 5m / off)
created: 2026-09-22
tags: tracker, settings
---

## Goal

Per tracker repo, a `15s` / `1m` / `5m` / `off` sync setting on Shared › `Trackers · this machine` (one `Segmented` pill per github row). `off` freezes that
repo's cache (one cold-boot sync per process, then nothing) and refuses every write path for it with `sync is off for <owner/name> — turn it on in Settings ›
Shared › Trackers`. Saves rate limit and tick time on repos nobody on this machine is working on.

Spec: [docs/superpowers/specs/2026-09-22-tracker-sync-interval-design.md](../../../docs/superpowers/specs/2026-09-22-tracker-sync-interval-design.md).
Plan: [docs/superpowers/plans/2026-09-22-tracker-sync-interval.md](../../../docs/superpowers/plans/2026-09-22-tracker-sync-interval.md) — the plan is the
source of truth for signatures, test cases and the three spec amendments; this item only summarises it.

## Plan

Follow the plan file task by task, one commit per task, `pnpm test` + `pnpm run typecheck` green after each:

1. **Vocabulary + file** — `SYNC_INTERVALS` / `SyncInterval` / `isSyncInterval` in `shared/types.ts`; `interval` on `ProjectSummary`, `TrackerProjectRow`,
   `SourceSummary`; `server/src/tracker/sync-config.util.ts` reading `~/.backlog-manager/settings/tracker-sync.json` (`BM_TRACKER_SYNC_FILE` override), every
   failure reading as `15s`, writes via temp + rename preserving unknown keys.
2. **Poller** — per-repo `lastSyncAt`; `sweep` syncs only due repos; `off` repo gets one cold attempt; `shouldPoll` narrowed; asleep repos stamp nothing;
   `summary()` carries `interval`; `syncOffBlock(projectPath)` is the server's one home of the refusal sentence; remote runs derive nothing for an `off` repo.
3. **Route** — `POST /api/trackers/sync {repo, interval}` in a new controller in `OrchestratorModule` (avoids a module cycle), `SameOriginPostGuard`;
   400 / 404 / 409 (off while a run is `running` or `paused`, or a starting entry) / 200 + `arm()`.
4. **Refusals** — 409 with the sentence on the seven `/api/items/*` write routes (inside the per-item serialisation, before any outbound call), dispatch,
   orchestrate and resume; `backlog.mjs` surfaces it verbatim, exit 1.
5. **Board** — `lib/tracker.ts` `syncOffReason` / `hasSyncingTracker`, `· sync off ·` wording, dispatch control DISABLED (not hidden) with the reason,
   Orchestrate sheet launch disabled, `useBoard` arms only while some tracker repo is on. Then the Trackers card picker (server's answer shown, 409 as hint).
6. **Docs** — spec amendments folded in, `invariants.md`, CLAUDE.md headline, `.claude/rules/tracker.md`, `api.md`, `board.md`, DESIGN.md §8.6; verify in the
   running stack.

## Test cases

Exact cases live in the plan, per task. Headline ones:

- config: missing / non-JSON / non-object file → every repo `15s`; bad value → `15s` for that repo only; wrong-case key does not match; write preserves
  unknown keys and leaves no `.tmp`.
- scheduling: `15s` vs `1m` over four ticks → 4 syncs vs 1; `off` with empty cache → exactly one attempt over three ticks (even if it fails); all `off` →
  `armed` false; `off` → `15s` re-arms; a failing `1m` repo is not retried before 60 s; a sleeping `5m` repo retries on the first tick after waking.
- route: every row of the 400/404/409/200 table, guard refusals, two projects on one repo share one key.
- refusals: all seven write routes, dispatch, orchestrate, resume → 409 with the exact sentence and zero outbound calls; a files project unaffected.
- client: `sync off` line, disabled dispatch, disabled launch, no board interval when all repos off, picker options equal `Object.keys(SYNC_INTERVALS)`.

## Done when

All six plan tasks committed, `pnpm test`, `pnpm run typecheck` and `pnpm run build` green, `test/claude-rules.test.ts` green, and on the running stack
setting `test-claude-issues` to `off` shows `sync off` on the band, disables that project's dispatch control with the sentence, and writes the key to
`~/.backlog-manager/settings/tracker-sync.json`.
