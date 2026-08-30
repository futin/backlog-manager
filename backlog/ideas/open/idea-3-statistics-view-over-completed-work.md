---
id: idea-3
title: Statistics view over completed work
created: 2026-08-30
tags: client, stats
---

## Problem

Once items carry elapsed time per phase, and possibly tokens, there is a
dataset worth looking at: how long grooming actually takes versus execution,
which sections eat the most time, whether estimates drift, which projects are
active. None of it is visible today, and done items are about to disappear
from every default view.

## Rough shape

A fourth nav section beside Board, Archive and Settings, reading the same
`/api/items` index the board already fetches — the data is a few hundred rows
and the client already does all its narrowing locally.

Depends on data that does not exist yet: task-1 supplies `groom-elapsed` and
`execute-elapsed`, the tokens idea would supply the second axis, and the
prune idea supplies both `finished:` and the rolled-up record that keeps
history alive after done items are deleted.

Worth deciding early: whether statistics read live item files, the rolled-up
record, or both. Both is probably right and is also the awkward one — the
same item must not be counted twice when it exists in both places.

## Open questions

- Which questions is this actually answering? A dashboard with no question
  behind it becomes four charts nobody reads.
- Per-project, per-section, or per-time-period as the primary axis?
- Does it need history beyond what the item files hold, i.e. is the prune
  roll-up a hard dependency or an optimisation?
