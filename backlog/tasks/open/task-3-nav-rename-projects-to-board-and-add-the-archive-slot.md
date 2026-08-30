---
id: task-3
title: Nav: rename Projects to Board and add the Archive slot
created: 2026-08-30
tags: client, nav
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
