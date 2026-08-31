---
id: task-3
title: Nav: rename Projects to Board and add the Archive slot
created: 2026-08-30
tags: client, nav
updated: 2026-08-31T21:34:16Z
started: 2026-08-31T21:21:02Z
execute-elapsed: 794
---

## Goal

The side rail reads Board · Archive · Settings. Chunk A of
docs/superpowers/specs/2026-08-30-board-growth-design.md — independent of
every other chunk, and the smallest visible step.

"Board" rather than "Tasks" because a nav entry names a place, not a type,
and the board holds bugs and refactors too.

## Plan

`SideRail`'s exported `Section` union becomes `'board' | 'archive' |
'settings'` with matching labels, and `TABS` grows the third entry.

`App.tsx` needs more care than it looks. Its stored key
`backlog-manager.section` holds `'projects'` on every existing install, and
its current guard collapses anything that is not `'settings'` to `'projects'`
— a two-way clamp that cannot express three sections. Replace it with a
validated three-way resolve that maps the legacy `'projects'` and any
unrecognised value onto `'board'`.

`settings.landing` gains Archive as an option and `clampSettings` clamps to
the same three values, so a hand-edited localStorage cannot land the app on a
section that does not exist.

The board's own `board-title` changes from "Projects" to "Board".

Archive renders a placeholder until task-6 lands. The placeholder should say
what will live there, not just "coming soon" — an empty section with no
explanation reads as a bug.

## Test cases

- A stored section of `'projects'` (the legacy value) resolves to Board, not
  to a blank main area.
- A hand-edited garbage section value resolves to Board.
- `landing: 'archive'` opens on Archive with no flash of a different section.
- Switching sections updates the stored value, and switching `landing` back to
  `'last'` finds the genuinely last section rather than a frozen one.
- Exactly one rail tab carries `aria-current="page"`.
- No rail tab carries `aria-expanded` — every tab is a plain section switch.

## Done when

`pnpm test` is green and all three tabs are reachable, with Archive showing
its placeholder.

## Outcome

2026-08-31 — done, as planned. The rail reads Board · Archive · Settings.

`TABS` in `SideRail.tsx` became the single definition: `Section` is derived
from it (`(typeof TABS)[number]['id']`) and a new `SECTIONS` export gives the
list runtime members. That removed the two hand-copied duplicates of the
section names — `lib/settings.ts`'s `LANDINGS` is now `['last', ...SECTIONS]`,
which retires the comment there warning that a section added to the rail had
to be added by hand or it stayed unpickable.

`App.tsx`'s two-way clamp is gone, replaced by an exported `resolveSection`
run once in the `useState` initializer over whichever value wins (stored
section, or the `landing` pin). Legacy `'projects'` and anything unrecognised
land on Board. No second clamp on the render path: the only post-mount writer
is `change`, which the rail calls with its own tab ids.

Two decisions worth flagging to whoever reads this next:

- **A `landing` of `'projects'` is *not* aliased onto `'board'`** — it falls
  back to `'last'`, the default. The stored *section* has to be mapped or
  `main` renders nothing; a landing pin this build cannot honour has an honest
  answer already, and "open where I left off" is it. Pinned by a test.
- **Archive is its own lazy-loaded file** (`components/archive/ArchiveView.tsx`),
  not JSX inlined into the shell, so task-6 fills that file in rather than
  rewiring `App`. Its placeholder names the two populations Archive will hold
  and both routes back out, because a blank section reached from a rail tab
  reads as a bug. It needed one new CSS class, `.board-note` — `.board-empty`
  is a centred flex row built to hang an icon beside a word, and a paragraph
  in `.wrap.wide` needs a measure.

All six planned test cases are covered in the new `test/nav.test.tsx`, which
stubs Board and Settings (the subject is the shell; `board.test.tsx` already
covers the real component) and leaves Archive real. The suite was checked
against two mutants rather than trusted for passing once:

- `resolveSection` returning `raw` unvalidated → 3 failures (the two legacy /
  garbage cases and the direct mapping test).
- `resolveSection` restored to the old `raw === 'settings' ? 'settings' :
  'board'` two-way clamp → 3 failures (the Archive landing case, the
  last-section case, and the section round-trip).

One extra assertion went into `board.test.tsx` pinning the `board-title` as
"Board", since the plan required that rename and nothing tested it.

Verification:

```
$ pnpm test
Test Suites: 32 passed, 32 total
Tests:       438 passed, 438 total
Snapshots:   0 total
Time:        22.573 s, estimated 39 s
Ran all test suites.

$ pnpm run test:skills
# tests 233
# suites 0
# pass 233
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 24044.359959

$ pnpm run typecheck
$ tsc --noEmit
(exit 0, no output)

$ pnpm run build
dist/assets/ArchiveView-BH2SOkTA.js    0.68 kB │ gzip:  0.41 kB
dist/assets/SettingsView-DdkQcNfU.js   6.24 kB │ gzip:  2.28 kB
dist/assets/BoardView-CBvOQqot.js     66.51 kB │ gzip: 20.08 kB
dist/assets/index-Cb3-t3Hk.js        148.98 kB │ gzip: 48.70 kB
✓ built in 1.36s
(exit 0 — Archive splits into its own chunk, so the lazy import resolves)
```

The full-suite run hit no instance of bug-1's supertest teardown flake.
