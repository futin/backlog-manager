---
id: task-48
title: Tracker-backed phase 4b: runs visible from every machine - runs derived from claim comments, read-only remote runs, attention comments, reconcile from claims
created: 2026-09-19
from: idea-12
tags: architecture, multi-machine, tracker, github, orchestrator, runs
---

## Goal

The second half of phase 4 of the tracker-backed direction ([spec §7.3, §7.6](../../../docs/superpowers/specs/2026-09-17-tracker-backed-backlog-design.md)).
Phase 4 was split on 2026-09-19. task-47 (4a) lets one machine orchestrate a tracker project and writes each item's machine state into its claim comment.
This item makes that state **visible from every machine**, which is the spec's §13 visible result for phase 4: "Runs visible from every machine".

Scope, from spec §7.3 and §7.6:

- **Runs are built from claims.** The server assembles `OrchestratorRun` from cached claim comments grouped by `state.run.runId`. `status` is `running`
  while any claim in the group has a live heartbeat and none carries `finished`; otherwise it is the last-touched claim's recorded outcome.
  `orchestrate.mjs finish` stamps `finished: { at, status }` on the run's last-touched claim. Decide here how a derived run and a local `run.json` for the
  same `runId` merge. The local journal is the richer record; the derived one is what another machine sees.
- **A remote run is read-only.** Controls render only on the machine whose run-state directory holds the run's `run.json`. Pause, resume, abort and the
  watchdog are local mechanisms. The Runs page says a run is remote instead of drawing controls that would do nothing.
- **Attention becomes a comment.** `<!-- bm:attention kind=… -->` plus an `@mention` of the token's user, so a phone notification replaces the strip
  badge. In 4a attention stays in `run.json` only.
- **`reconcile` reads claims** for a tracker project where it reads `run.json` for a files one.
- A run whose queue never claimed an item has no comment and is invisible from other machines. The local journal still has it; state this on the page
  rather than hiding it.

**Plan against the code as it stands once task-47 has merged**, per spec §13. task-47's `## Outcome` records the claim `state` shape it shipped and every
deviation it took. Read that first.

## Plan

unknown — planned after task-47 merges.
