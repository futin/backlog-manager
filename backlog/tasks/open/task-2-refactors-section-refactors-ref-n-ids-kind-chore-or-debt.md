---
id: task-2
title: Refactors section: refactors/, ref-N ids, kind chore or debt
created: 2026-08-30
tags: skills, cli, board, api
---

## Goal

Refactoring becomes a first-class section rather than a flavour of idea: its
own directory, its own id space, its own board column. Chunk B of
docs/superpowers/specs/2026-08-30-board-growth-design.md.

The distinction being encoded: ideas are **new** (a feature, an optimisation);
refactors are **existing things that should be improved** — not new, not
broken, so neither an idea nor a bug.

## Plan

In backlog.mjs: `SECTIONS` gains `refactors: 'ref'`, `LEAF_DIRS` gains
`refactors/open` and `refactors/done`, and the README template's table gains
the row. `QUEUE_SECTIONS`, `PREFIX_TO_SECTION` and `nextId` all derive from
`SECTIONS`, so they follow without edits — that is the point of the map, and
the change should not add a second list anywhere.

The prefix is `ref`, not `refactor`, because the card's meta line is
nowrap-with-ellipsis in roughly 118px at real column width and `refactor-12`
does not fit beside a date there.

Frontmatter gains `kind: chore | debt`, written by capture and rendered as a
sub-badge on the card. An unrecognised kind is preserved verbatim like every
other unknown key and simply not badged — a third kind later is one enum
value in the client, not a new directory.

Lifecycle matches ideas exactly: `open/` → `done/`, promotable to a task with
`from:`, rejectable to out-of-scope. `groomed` derives to `null`, as it does
for ideas — groomed is not a state a refactor has; being promoted is.

Capture's heading set for the section is new: `## What exists today`,
`## Why it should change`, `## Rough shape`. Both skills' classification
tables gain the row, and groom learns it can promote a `ref-N`.

Server side, `section` comes from the directory and the body allowlist is
built from each registered `backlog/`, so both should pick the new directory
up unchanged — the tests below exist to prove that rather than assume it.

Client side, `COLUMNS` gains Refactoring. Ordering is task-4's job, not this
one's; appending it here is fine.

## Test cases

- `new refactors "..."` mints `ref-1`, and `nextId` scans both `refactors/open`
  and `refactors/done` when picking the next number.
- `PREFIX_TO_SECTION` resolves `ref` to `refactors`; `show ref-1` finds a file
  in either `open/` or `done/`.
- A bare `ref` is reported as "a section prefix, not an id", matching the
  existing message for `bug`.
- `kind: chore` round-trips through parse and render untouched; an unknown
  `kind: whatever` is preserved and not badged.
- A refactor's `groomed` is `null` in `/api/items`, never `false`.
- `/api/items/body` serves a file under `refactors/`; a path outside every
  registered `backlog/` still 404s.
- `init` on an already-initialised store creates the two new directories and
  leaves a hand-edited README alone.
- The board renders a Refactoring column with the right count.

## Done when

`pnpm test` and `pnpm run test:skills` are green, and a captured `ref-1`
appears on the board with its kind badge.
