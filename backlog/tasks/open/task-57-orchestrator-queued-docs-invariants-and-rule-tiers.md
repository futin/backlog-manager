---
id: task-57
title: orchestrator:queued — docs, invariants and rule tiers
created: 2026-09-23
---

## Goal

CLAUDE.md, the invariants, the path-scoped rules and the tracker spec all describe the ninth label and the eighth write route, and the rules guard stays
green. Spec: [docs/superpowers/specs/2026-09-23-orchestrator-queued-label-design.md](docs/superpowers/specs/2026-09-23-orchestrator-queued-label-design.md) §6. Plan: [docs/superpowers/plans/2026-09-23-orchestrator-queued-label.md](docs/superpowers/plans/2026-09-23-orchestrator-queued-label.md) Task 6.

## Plan

Depends on task-52 … task-56 (documents what they built — do it last).

1. `CLAUDE.md`: write-routes headline "seven" → "eight"; the Layout bullet's "the seven guarded write routes"; one new Invariants headline —
   **`orchestrator:queued` is a plan, never a claim: the driver adds it, the claim and the Stop remove it, and no reader treats it as exclusion.** — with its
   `Why:` link.
2. `docs/subsystems/invariants.md`: the new entry's reasoning (why advisory, why the server sweeps at Stop, why stale is drawn not hidden); the write-routes
   entry gains `queue`.
3. The `.claude/rules/*.md` files whose `paths:` cover `server/src/items/**` and `skills/backlog-orchestrate/**`: the mechanism bullet, anchored exactly
   once, headline byte-equal with CLAUDE.md.
4. `docs/superpowers/specs/2026-09-17-tracker-backed-backlog-design.md`: §5.2 nine labels, §5.3 a `queued` row, §6.2 the route, §7 a pointer to the new spec
   — only the lines that change.
5. `docs/subsystems/api.md`, `board.md`, `skills.md`: one paragraph each beside the neighbouring tracker text.

## Test cases

- `pnpm run test:jest -- claude-rules` passes (bullets only, each anchored once, one home per anchor, headlines byte-equal).
- `pnpm test` green.

## Done when

The guard and the full suite are green and every doc named above mentions the label or the route where it applies.
