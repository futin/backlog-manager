---
id: idea-1
title: seed the board
created: 2026-08-26
---

## Problem

This repo's own `backlog/` store was created back in Task 4 but never had a
real item in it — every later task exercised the store through fixtures under
`test/`, never the live one at the repo root. That leaves the actual running
board with nothing to show: `/api/items` returns an empty list, the board
renders its "nothing registered yet" / "no matches" empty states instead of a
real column of cards, and the drawer's fetch-and-render-Markdown path
(`GET /api/items/body`) has nothing genuine to serve. A first-time visitor —
or a reviewer doing the Task 14 manual smoke pass — would see an empty shell
and have no way to tell the difference between "board works, nothing filed
yet" and "board is broken."

## Rough shape

Use `backlog-capture` (or the `backlog.mjs` CLI directly, as done here) to
file this item as the store's first entry, so the board has one real card in
the Ideas column, and the drawer/body route have one real file to render.
Past that, keep dogfooding: as work on backlog-manager itself turns up bugs,
follow-on ideas, or planned tasks, capture them here with the same skills
this repo publishes, instead of tracking them ad hoc in chat or a scratch
file. The four skills exist to be used on *some* repo — there is no reason
this one should be the exception.

## Open questions

- Once organic items accumulate from real development, does this seed item
  get moved to `done/` (its "job" — seeding — is arguably finished the moment
  a second item exists), or does it stay open indefinitely as a standing
  reminder to keep using the skills on this repo? Leaning toward: move it to
  `done/` once there are a few real items in every section, but that's a
  judgment call for whoever grooms it, not decided here.
- Is one seeded item enough to exercise the UI meaningfully, or should there
  be one per section (bug/idea/task) so the board's four columns are never
  simultaneously empty during a demo? Left as `unknown` for now — easy to
  capture more later if the single-item board turns out to look sparse.
