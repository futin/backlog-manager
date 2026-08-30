---
id: idea-2
title: Prune done items, rolling each into a statistics record first
created: 2026-08-30
tags: skills, cli, stats
---

## Problem

Done items accumulate forever. A year of active use could leave a thousand
files under `*/done/` that nothing ever reads — they appear in no board view
after the Board/Archive split, and there is no action to take on them.

But deleting them plainly would destroy the only record of what was worked on
and how long it took, which is exactly what a future statistics view needs.

Deferred from docs/superpowers/specs/2026-08-30-board-growth-design.md.

## Rough shape

Roll up, then delete. A `prune` command walks `*/done/`, appends one line per
item to a statistics file — id, section, created, finished, groom-elapsed,
execute-elapsed, whatever tokens exist by then — and only then removes the
file. Ordering matters: the roll-up must be on disk before the delete, so an
interrupted prune loses nothing.

This is the first thing in the system that would need `finished:`, which was
deliberately deferred from the Board/Archive design. `moveItem` today is a
`renameSync` that never reads content, and stamping a completion date turns it
into a read-modify-write — that trade should be made here, where something
actually needs the date, rather than speculatively.

Deletion is destructive, so: never automatic, never triggered by the server
(which must never write), and only ever run by a person or a skill they
invoked. These backlogs live inside git repos, so a mistaken prune is
recoverable from history — that lowers the stakes but does not remove them.

## Open questions

- Where does the statistics file live — inside `backlog/`, or outside it so
  the store stays purely items?
- What is the retention rule: an age, a count, or entirely manual?
- Should prune be its own skill, or a command the existing skills can call?
- Does `finished:` belong on the item, or only in the rolled-up record?
