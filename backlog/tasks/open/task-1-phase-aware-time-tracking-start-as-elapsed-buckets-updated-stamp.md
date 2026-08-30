---
id: task-1
title: Phase-aware time tracking: start --as, elapsed buckets, updated stamp
created: 2026-08-30
tags: skills, cli, board
---

## Goal

`stop` can bill groom time separately from execute time, and every skill-driven
touch of an item leaves a dated stamp the board can read. Chunk E of
docs/superpowers/specs/2026-08-30-board-growth-design.md — the gate for task-5
and task-6, both of which read `updated:`.

## Plan

`start <id> --as groom|execute` writes `phase:` alongside the existing
`started:`. The flag is optional so older callers keep working; when it is
absent no `phase:` key is written and `stop` bills nothing. Both skills'
prose is updated to always pass it.

`stop <id>` reads `phase:`. When present it computes whole seconds from
`started:` to now and adds them into `groom-elapsed:` or `execute-elapsed:` —
integer seconds, absent meaning zero, accumulating across sessions. It then
removes `started:` and `phase:` together and stamps `updated:`.

`phase:` is not a status and does not weaken the `status:` ban: a status says
where an item is in its lifecycle, which remains the directory and only the
directory. `phase:` says which activity currently holds the in-progress
marker, and it exists only as long as that marker does.

`updated:` is stamped inside `writeItemFile`, so `start` and `stop` both get
it from one place. `moveItem` is deliberately excluded — it is a `renameSync`
that never reads content, and every skill path calls `stop` immediately before
`move` anyway, so the stamp is already fresh by the time the rename happens.

A legacy bare `YYYY-MM-DD` in `started:` cannot be billed, because UTC midnight
is not the hour anyone began work. `stop` clears such a marker and stamps
`updated:` without adding to any bucket.

Client side: the in-progress bar reads `phase` and says "grooming" or
"executing" instead of the ambiguous "in progress". The drawer shows the
accumulated buckets on any item that has them, done items included.

## Test cases

- `start --as groom` writes `phase: groom`; `start` with no flag writes no
  `phase` key at all.
- A 90-second groom session leaves `groom-elapsed: 90`; a second 30-second
  groom session on the same item leaves `120`.
- Groom and execute time accumulate independently on one item.
- `stop` on a file carrying `started:` but no `phase:` clears the marker,
  stamps `updated:`, and bills nothing.
- `stop` on a legacy bare-date `started:` clears and stamps but does not bill.
- `stop` stamps `updated:` even when nothing was billed.
- Unknown frontmatter keys and the body survive `start` → `stop` byte for byte.
- `move` neither stamps `updated:` nor rewrites content.
- The live bar renders "grooming" for `phase: groom` and falls back to
  "in progress" when the key is absent.

## Done when

`pnpm run test:skills` and `pnpm test` are green, and a groomed item on the
board shows "grooming" in its live bar with the elapsed reading beside it.
