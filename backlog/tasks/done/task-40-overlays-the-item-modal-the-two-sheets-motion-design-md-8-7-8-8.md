---
id: task-40
title: Overlays: the item modal, the two sheets, motion (DESIGN.md 8.7-8.8)
created: 2026-09-15
tags: fe-redesign, overlays, motion
updated: 2026-09-16T10:25:57Z
started: 2026-09-16T09:43:07Z
execute-elapsed: 2570
execute-tokens: 412248
---

## Goal

Turn `ItemDrawer` from a panel pinned to the right edge into a real modal
with air around it, give `LaunchSheet` and `OrchestrateSheet` the same
sheet shell, land the `Modal` and `FormSheet` primitives spec §12.4
deliberately withholds from `task-36` until this task (their only composers
are this task's own work), and decide — the one piece of new behaviour
here rather than restyling — how the board's three moving elements behave
under `prefers-reduced-motion`. This is also where the dialog count
`useDialogEscape` ranks drops from four to three, on disk in
`docs/subsystems/invariants.md` and `CLAUDE.md`, because `RunDrawer` — whose
deletion `task-37` already did in code — is the dialog that actually leaves
the stack, and this task is where that documentation catches up with the
code.

**Depends on `task-36`** (Foundation — type scale, tokens, and every other
`ui/` primitive `Modal`/`FormSheet` sit beside), **`task-37`** (Board — the
run chip's breathing `Dot` this task's motion section adds a
reduced-motion override for must already exist), and **`task-38`** (Runs —
the stage track's pulsing current node and the detail sheet's / Watchdog
page's `Resume run`/`Resume now` controls this task's motion section also
covers must already exist). Do not start this task before all three are
merged to `main`.

## Plan

Authority: `docs/superpowers/specs/2026-09-15-fe-redesign-design.md` §6
(lines 574–618, subsections 6.1–6.2) and `.claude/DESIGN.md` §8.7, §8.8, plus
§12.2/§12.4 for the two primitives' contracts.

### 1. The item modal — spec §6.1, DESIGN.md §8.7 "Sidecar modal"

Compose the new `Modal` primitive (`client/src/components/ui/`) around what
is today `ItemDrawer.tsx`'s panel (`client/src/components/board/
ItemDrawer.tsx` — `drawer-backdrop`/`drawer` today, panel pinned to the
right edge). `Modal`'s contract (spec §12.2): props `label`, `facts`,
`children`, `onClose`; it owns the scrim, calls `useNarrow` (landed inert by
`task-36`, which lists it among that task's primitives as "used by nothing
yet but the rail" — this task is its first real consumer, not its origin)
for the full-screen-under-700px behaviour, and calls
`useDialogEscape` itself internally — `ItemDrawer` stops binding that hook
directly and becomes `Modal`'s one caller for this content instead.

- `--scrim` covers everywhere the drawer used to reserve for desktop alone;
  the shell is `--strip` at 16 px radius carrying the one shell lift
  (`0 24px 64px` at `--shadow2`).
- A 290 px facts column sits left of a body with a clean top edge. Max
  width 1080 px, `calc(100vw / var(--font-scale) - 48px)` below that,
  full-screen under 700 px with the facts column folding above the body.
- Facts: project dot + name, id, section, created/updated/last commit,
  `groomed`, tags, `in progress since <started>` with its elapsed reading
  while a session holds it, elapsed/token counters when present, the file
  path, the dispatch control — the same set `ItemDrawer` already renders
  today (`drawer-meta`), unchanged in substance, moved into the `facts`
  slot.
- Body: rendered Markdown at the §2.3 type scale — 15/400 body, 19/500
  headings, code spans on `--steel`.

**This is the only modal anywhere in this app.** No run modal exists or is
added — everything a run modal would have drawn is `task-38`'s detail
sheet, always beside the list. State that explicitly in the component's own
header comment, the way `RunControls`' header comment already states its
own "why one component" reasoning — a future reader should not have to
re-derive it from the spec.

### 2. The sheets — spec §6.2, DESIGN.md §8.7 "Sheet"

New `FormSheet` primitive: props `title`, `steps?`, `footer`, `children`,
`onClose`; scrim, air on every side, 620 px wide, the same shell lift as
the modal, full-screen under 700 px, calling `useNarrow` and
`useDialogEscape` itself exactly as `Modal` does. `LaunchSheet.tsx` and
`OrchestrateSheet.tsx` both stop binding `useDialogEscape` directly and
become `FormSheet`'s callers, keeping **every step and field they already
have** — this task reshells them, it does not redesign their flow.

- Controls throughout both sheets are `task-36`'s 36 px control family
  (`Select`/`NumberField`/`Switch`/text field/button).
- `OrchestrateSheet`'s existing three-step header (`orchestrate-steps`,
  `client/src/components/board/OrchestrateSheet.tsx`) becomes a 13/500
  stepper on a hairline; Start stays on the last step alone, exactly as
  today.
- The `uncommitted` chip renders as an 11/500 `--amber` `Pill`; its two
  consequences — absent from `main` is skipped, present-but-edited is
  executed on `main`'s bytes — stay spelled out in words, not left to the
  pill's colour alone. This is a restyle of existing text, not new copy.

### 3. `useDialogEscape`'s count: four dialogs to three

`hooks/useDialogEscape.ts` itself is **untouched in mechanism** — one
owner, module-level LIFO stack, the topmost entry closes. What changes is
the count it ranks:

- The item modal (composing `Modal`), `LaunchSheet`, `OrchestrateSheet` —
  **three**, not four.
- `RunDrawer` does not hand its slot to a renamed surface. Its content is
  now `task-38`'s Runs detail sheet, sitting inline on the Runs page beside
  the list rather than opening and closing as a dialog at all — there is
  nothing left there for Escape to close. `task-37` already deleted the
  file; this task is where the **documentation** of the rule catches up.
- Update `docs/subsystems/invariants.md`'s "Escape has one owner, and the
  topmost dialog is the only one that closes" entry in place (never
  delete it — the rule survives every surface that has ever carried it,
  the same treatment `task-38`'s moved-rules table gives Runs' own
  entries): its dialog list must read three (the item modal, `LaunchSheet`,
  `OrchestrateSheet`), and it must say why `RunDrawer` left rather than
  simply dropping its name — because its content is now an inline sheet,
  never a dialog, not because a fourth caller was removed for its own
  sake.
- Update `CLAUDE.md`'s matching bullet under the same heading the same way
  — it currently reads "all four dialogs call it and none binds its own
  (bug-23)"; that becomes three, with the same one-line reason.

### 4. Motion — spec §8.8 (DESIGN.md), no numbered spec section of its own

Three places move on their own, one mechanism for all three — **this is
the one place in this task where behaviour, not just skin, is decided**:

1. The run chip's `Dot` (`task-37`) breathes a ring while any run is
   live — `Dot`'s own `breathe?` flag (landed inert by `task-36`), not an
   animation local to `RunChip`, so any other live `Dot` earns the same
   motion for free.
2. The stage track's current node (`task-38`) pulses the 3 px ring already
   part of its four node states — this task decides its reduced-motion
   behaviour, it does not redraw the pulse itself.
3. A needs-you control fades into a slot the layout already reserves,
   rather than snapping in or shoving the row beside it: the crashed run's
   `Resume run` (Runs detail sheet head, `task-38`) and the Watchdog page's
   `Resume now` (`task-38`) — both gated by `watchdogStoodDown`, meaning the
   same thing wherever they appear.

All three are silenced under `@media (prefers-reduced-motion: reduce)`
using the **existing pattern already in `client/src/styles.css`**, not a
new mechanism: the blanket reduced-motion rule (around line 631 today —
verify in the worktree) cuts every animation's duration near zero and runs
it once, freezing it on its **last** keyframe — wrong whenever that frame
is not the element's resting state. Three elements already carry the fix
for exactly this reason and are the worked examples to follow:
`.board-card-stage-glyph` (unconditional rule two classes deep, so an
explicit `animation: none !important` is needed in the nearest
reduced-motion block, around line 638 today), `.watchdog-lamp-armed` (its
own block, around line 1669), and `.run-track-dot-current` /
`.run-track-node[data-in="live"]` (need **no** `!important` — each shares
its selector with its own unconditional rule earlier in the same section,
so source order alone settles it, around lines 2497–2499). The run chip's
breathing ring, the stage track's redrawn pulse, and the needs-you fade
each want the same kind of override — `!important` only where the rule it
corrects outranks it on specificity, checked per selector rather than
applied uniformly.

## Test cases

Authority: spec §9.

1. **The item modal is the only modal.** No run-modal component exists
   anywhere in `client/src`; a grep-shaped assertion (or a source guard) is
   acceptable if a render test cannot easily prove a negative.
2. **`Modal` and `FormSheet` component suites** (`test/ui-modal.test.tsx`,
   `test/ui-form-sheet.test.tsx`) pin role, accessible name, the facts/body
   slot split (`Modal`) and the steps/footer slot split (`FormSheet`),
   matching the shape every other `ui/` primitive suite from `task-36`
   already has.
3. **Facts content is unchanged** — every fact `ItemDrawer` renders today
   (project dot+name, id, section, dates, `groomed`, tags, in-progress
   line, elapsed/token counters, file path, dispatch control) still renders
   inside the modal's facts slot; this is a like-for-like move, assert it
   as one.
4. **Both sheets keep every step and field.** `LaunchSheet`'s existing
   cases and `OrchestrateSheet`'s existing three-step cases all pass
   against the new `FormSheet` shell with no behavioural case removed.
5. **`useDialogEscape` ranks three, not four.** A test mounts the item
   modal, `LaunchSheet` and `OrchestrateSheet` together and asserts Escape
   closes only the topmost by mount order — the existing bug-23 regression
   shape, re-run against three callers instead of four. No test still
   references `RunDrawer` as an `useDialogEscape` caller.
6. **`docs/subsystems/invariants.md`'s entry reads three** and names why
   `RunDrawer` left (content moved to an inline Runs sheet, never a
   dialog) — check this by reading the file after the edit, the same way
   `test/claude-rules.test.ts` reads rule files as text elsewhere in this
   repo; a manual read is acceptable if no test targets prose files
   directly. **`CLAUDE.md`'s matching bullet is edited the same way.**
7. **Reduced motion freezes all three new/changed animations on a resting
   frame, not mid-motion.** One case per element (run chip breathe, stage
   track pulse, needs-you fade), each asserting the computed/declared
   `animation` is `none` under a `prefers-reduced-motion: reduce` matchMedia
   stub, following the existing pattern's own test shape if one exists for
   `.board-card-stage-glyph` or `.watchdog-lamp-armed`.
8. **No new derivation, and `watchdogStoodDown` is read, not re-implemented,**
   by the needs-you fade's gating logic.

## Done when

- `pnpm test` green on both runners, including every case above.
- `pnpm run typecheck` and `pnpm run build` pass.
- The item modal opens with air around it in all five themes; both sheets
  keep every existing step/field under the new shell; Escape closes exactly
  the topmost of the three remaining dialogs; the three moving elements are
  motionless under reduced motion.
- Screenshot an open item modal at 1400 px and 400 px, daylight and
  midnight (spec §9), through a pid-owned static server killed by pid.
- `git diff --stat` against `main` touches
  `client/src/components/board/ItemDrawer.tsx`,
  `client/src/components/board/LaunchSheet.tsx`,
  `client/src/components/board/OrchestrateSheet.tsx`, new
  `client/src/components/ui/Modal.tsx` and `FormSheet.tsx` (`useNarrow`
  itself is `task-36`'s file, not this task's — this task only becomes its
  first caller), `client/src/styles.css`,
  `docs/subsystems/invariants.md`, `CLAUDE.md`, and test files. No server
  route, no skill, no `shared/` change.

## Outcome

2026-09-16 — done. `ItemDrawer` is `board/ItemModal.tsx`, a composition of the new `ui/Modal` primitive: `--scrim` over everything, a `--strip` shell at 16 px
radius with the design's one lift, a 290 px facts column beside a body with a clean top edge, full-screen under 700 px with the facts folding above. Both sheets
wear the new `ui/FormSheet` shell — scrim, 620 px, the same lift, a stepper slot on a hairline, a footer pinned under the scrolling body — keeping every step and
field they already had. Both shells call `useDialogEscape` themselves, so the three surfaces no longer bind it at all. §8.8's third moving element, the needs-you
fade, is `.run-controls-needs-you` on the one Resume control `RunControls` draws for both surfaces, landing in a slot each host now reserves.

Five decisions worth naming, since each departs from the plan's letter:

1. **The facts column is a superset of what the drawer drew, not a like-for-like move.** The plan says the §6.1 list is "the same set `ItemDrawer` already
   renders today, unchanged in substance". It is not: the old one-line `drawer-meta` carried project, id, created, in-progress, done, tags and the two elapsed
   buckets, and had nowhere to put `section`, `updated`, `last commit`, `groomed` or the two token counters — all of which were in `BacklogItem` and all of
   which §6.1 and DESIGN.md §8.7 name. The modal draws all of them, one labelled row each. Nothing was dropped, so test case 3 reads as the one like-for-like
   case it asks for, with the three additions covered by the same case.
2. **`FormSheet` takes a `label` the spec's §12.2 table did not list**, and §12.2 is amended in this change to list it. On both sheets the dialog's accessible
   name and its visible title are different strings (`dispatch <id>`; `orchestrate <project>`), `title` is a node, and deriving a name from it would have
   silently renamed both dialogs. `Modal` already had the prop for the same reason.
3. **The facts block does not compose `Sheet`,** which §12.2's "composed by" column listed it under; that cell is amended too. The modal shell is already
   `--strip` at 16 px carrying the one lift, so a `Sheet` inside it is an invisible card whose 24 px padding doubles the slot's own.
4. **The fade rides every Resume, not only the crashed one.** `resumeControl()` is one function drawing the control for both the crashed and the paused branch,
   and a paused run's Resume is a needs-you control by the same reading — the sweeper is not coming, a person is the only path left. No gate was added: the
   crashed branch's existing `watchdogStoodDown` check is untouched and is still the only reader beside `watchdog.service.ts` (test case 8; the exact-set list in
   `test/watchdog-coupling.test.tsx` is unchanged).
5. **Plan §3 was already done in code and in prose.** task-37 dropped the count to three in `useDialogEscape.ts`, `invariants.md` and `CLAUDE.md`. What this task
   added is the naming (`ItemDrawer` → the item modal), the reason the shells now own the binding, and `test/dialog-count-docs.test.ts`, so the count cannot rot
   in either file again.

Two defects were found by screenshotting and fixed, both mine:

- **A percentage `max-height` inside a grid row sized `auto` is circular.** `.ui-modal-narrow .ui-modal-facts { max-height: 40% }` resolved against the row its
  own height had just decided: measured at 400 px it left a 161 px facts box inside a 403 px row, i.e. 242 px of blank paper between the facts and the body. Now
  `calc(38dvh / var(--font-scale, 1))`, with the row `minmax(0, auto)`.
- **A select in a sheet field was stretched and truncated.** Swapping the bare `<select>` for the 36 px `Select` lost the old `align-self: flex-start`, and a
  column flex container stretches its children: `Skip the item for me` was cut mid-word inside a field the wrapping row had narrowed. `.sheet-field` now sets
  `align-items: flex-start` and `.sheet-prompt` opts back into `stretch` — the one field that wants the full width.

Verification:

```
$ pnpm run typecheck
$ tsc --noEmit

$ pnpm test
Test Suites: 105 passed, 105 total
Tests:       1704 passed, 1704 total
# pass 538
# fail 0
PASS  jest
PASS  node --test (skills)
pnpm test: both runners passed.

$ pnpm run build
✓ built in 1.09s
```

Screenshots: the open item modal at 1400 px and 400 px, daylight and midnight, plus the launch sheet at 1400/400 and the orchestrate sheet's steps 1 and 3 —
eight files under the worktree's gitignored `.playwright-mcp/`, taken through the built server on a pid-owned loopback port (4399), killed by that recorded pid.
They caught both defects above. One observation they also surfaced, NOT fixed here because it is neither this task's nor a regression from it: the served build's
CSP (`default-src 'self'`, no `font-src`) blocks the `data:` font URIs Vite inlines from `@fontsource`, so the production server renders in a fallback face while
the dev server does not. It predates this task (task-36 added the font), `test/csp.test.ts` pins the policy, and changing it is a decision of its own — worth a
`backlog-capture`.

Contract sweep: 9 sites updated (`client/src/styles.css` — the item-drawer and dispatch section headers now say which half is dead and that spec §7 assigns the
removal to task 6, the run-drawer section's claim to reuse `.drawer-body`, and the verify-tail comment naming `.drawer-body` as its scroll parent;
`client/src/components/board/BoardView.tsx` and `archive/ArchiveView.tsx` — every prose reference to "the drawer" and `openItemDrawer`;
`client/src/components/board/OrchestrateSheet.tsx`'s header on what it shares with LaunchSheet; `.claude/DESIGN.md` §8.7's "both name four dialogs today" and
§8.8's five stale line numbers; `docs/superpowers/specs/2026-09-15-fe-redesign-design.md` §12.2's two cells plus an amendment note;
`docs/subsystems/invariants.md` and `CLAUDE.md`'s Escape entries; `test/settings-view.test.tsx`, `test/orchestrator-start-ui.test.tsx`,
`test/dispatch-button.test.tsx` and `test/dialog-escape.test.tsx`'s comments naming `ItemDrawer`). Left standing on purpose: the dead `.drawer*` / `.sheet*`
shell rules in `client/src/styles.css`, which spec §7 lists by name as task 6's cleanup and which are now annotated as dead rather than removed here;
`docs/subsystems/board.md`'s three drawer sentences, whose rewrite §7 assigns to the same task (they were already stale for the run drawer before this change);
`audits/2026-09-06-audit.md` and `backlog/*/done/*`, which are historical records of what was true when written; and `docs/superpowers/plans/` plus the older
specs, likewise.

Red proof: 18 tests went red with the change reverted — `ui-modal` (2, dropping `useDialogEscape`/`useNarrow` from `Modal`), its two source guards (2, adding a
`runs/RunModal.tsx` that composes `Modal`), `ui-form-sheet` plus the three-deep Escape cases (11, unconditional footer/steps slots, no `useDialogEscape`, no
`useNarrow`, `label` derived from `title`), `motion-style` (1, removing the fade's reduced-motion override), `dialog-count-docs` (1, putting `ItemDrawer` back in
`invariants.md`) and `item-modal` (1, dropping the `section` and `groom tokens` rows). Every file was copied aside and restored from the copy — never `git
stash`, which is shared with every other worktree of this repository.
