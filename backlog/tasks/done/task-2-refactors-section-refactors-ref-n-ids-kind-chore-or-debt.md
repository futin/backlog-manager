---
id: task-2
title: Refactors section: refactors/, ref-N ids, kind chore or debt
created: 2026-08-30
tags: skills, cli, board, api
updated: 2026-08-31T09:34:21Z
started: 2026-08-31T08:57:59Z
execute-elapsed: 2182
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

## Outcome

2026-08-31 — done. `refactors/` is a section end to end: CLI, skills, API,
board.

Where the plan held: `SECTIONS` gaining one entry was genuinely enough for
`QUEUE_SECTIONS`, `PREFIX_TO_SECTION` and `nextId`, exactly as written — no
second list appeared in backlog.mjs. `allow.util.ts` needed nothing, so
`/api/items/body` served a `refactors/` file unchanged. `deriveGroomed`'s
fall-through gave refactors `null` without a branch, and `deriveAction`
therefore routes them to groom without one either.

Where it did not, and what was done instead:

- **"Server side… should pick the new directory up unchanged" was half wrong.**
  `scan.util.ts` has a hand-written `LEAVES` table mirroring `LEAF_DIRS`, so
  `section` comes from *that* table rather than from whatever is on disk; it
  needed the two rows. `Section` in shared/types.ts is a closed union, and
  `SectionCounts` is a total `Record`, so `items.service.ts` needed
  `refactors: 0`. The scanner's comment now says so rather than leaving the
  next reader to rediscover it.
- **`composePrompt` sent refactors the task fallback.** A dispatched refactor
  groom was told "give it a plan concrete enough to execute" — an instruction
  to edit the item in place, which is the one thing a promote must not do. It
  now shares the ideas branch.
- **`backlog-execute`'s refusal gate had a hole.** The gate inspects only a
  task's `## Plan` and a bug's `## Fix`, so a `ref-N` matched no rule and
  passed through ungated — "no rule applied" reading identically to "the rule
  was satisfied". The section check in Pick an item is what makes the gate
  total, and both places now say that explicitly.
- **The board grid was hardcoded to four columns.** Five columns while
  Refactoring and Out of scope share the surface; the eventual four-per-surface
  layout is task-4's chunk, so Refactoring is appended and the column-order
  assertion pins where it is today, not where it is going.
- **`kind` is passed through verbatim, not clamped** the way `phase` is. The
  client's badge simply does not render for a value it does not know, so there
  is nothing on the read side to collapse an unknown value into — which keeps
  the frontmatter round trip honest and makes a third kind one entry in
  `REFACTOR_KINDS`.

Scope line held deliberately: the drawer's meta line does not show `kind`. The
plan asked for a card sub-badge and that is what was built.

All eight of the plan's `## Test cases` have a covering test. Fresh run:

```
$ pnpm run typecheck
$ tsc --noEmit
(exit code 0)

$ pnpm run test:skills
1..156
# tests 156
# suites 0
# pass 156
# fail 0
# cancelled 0
# skipped 0
# todo 0

$ pnpm test
Test Suites: 24 passed, 24 total
Tests:       330 passed, 330 total
Snapshots:   0 total
Ran all test suites.

$ pnpm run build
✓ built in 2m 45s
(exit code 0)
```

`## Done when` also asked that a captured `ref-1` reach the board with its kind
badge. Verified against the real CLI, a real store and the real API rather than
a fixture — a throwaway git repo and registry under the scratchpad, the built
server on port 4471:

```
$ node backlog.mjs board
bugs (0 open)
ideas (0 open)
tasks (0 open)
refactors (1 open)
  ref-1  0d  Split the item scanner

$ curl -s $B/api/items   # refactor rows only
{'id': 'ref-1', 'section': 'refactors', 'status': 'open', 'kind': 'debt', 'groomed': None}
errors: []

$ curl -s $B/api/projects
e2e {'bugs': 0, 'ideas': 0, 'tasks': 0, 'refactors': 1, 'out-of-scope': 0}

$ curl -s "$B/api/items/body?path=.../refactors/open/ref-1-split-the-item-scanner.md"
## What exists today
scan.util.ts owns the leaf table, the parse call and the field mapping.

$ curl -s -o /dev/null -w "%{http_code}" "$B/api/items/body?path=/etc/hosts"
404
```

The board itself rendered a REFACTORING column with count 1 and the card
reading `ref-1 · aug 31 debt`. `groomed` came back `None` (JSON `null`), not
`false` — the distinction this task existed to get right.

Not committed or pushed: the work sits uncommitted on branch
`task-2-refactors-section`. The skills change nothing for installed plugins
until that branch is merged, pushed, and `pnpm run plugin:sync` runs — git is
the publishing boundary.
