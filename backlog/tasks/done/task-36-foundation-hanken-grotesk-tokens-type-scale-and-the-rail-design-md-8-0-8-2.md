---
id: task-36
title: Foundation: Hanken Grotesk, tokens, type scale and the rail (DESIGN.md 8.0-8.2)
created: 2026-09-15
tags: fe-redesign, foundation
updated: 2026-09-15T20:20:55Z
started: 2026-09-15T19:35:25Z
execute-elapsed: 2730
execute-tokens: 463350
---

## Goal

Land the front-end redesign's foundation: the one geometric-grotesque face
(Hanken Grotesk) everywhere, the rewritten daylight palette plus the two new
fill tokens, the 11 px type-scale floor, and the 280 px rail — and, riding
with them, every `client/src/components/ui/` primitive later tasks compose
except `Modal` and `FormSheet`. Nothing on the Board, Runs, Archive or
Settings pages changes shape in this task; only the face, the tokens, the
type sizes and the rail do. That is deliberate: this is the one task every
other task reads from, so it has to land — reviewed, verified, merged to
`main` — **before any of the other five fe-redesign tasks starts**, and each
of them names this task's id (`task-36`) as its dependency rather than
relying on numeric id order alone.

## Plan

Authority: `docs/superpowers/specs/2026-09-15-fe-redesign-design.md` §2
(lines 179–293, its own subsections 2.1–2.4) and `.claude/DESIGN.md` §8.0
(Shell and rail), §8.1 (Type) and §8.2 (Tokens and themes). Read those
sections in full before writing code; what follows names the files and the
non-obvious sequencing, not a restatement of their numbers.

### 1. Font — spec §2.1, DESIGN.md §8.1

- Add `@fontsource/hanken-grotesk` to `package.json`; import weights 400,
  500, 600, 700 in `client/src/main.tsx`. Remove `@fontsource/barlow`,
  `@fontsource/barlow-condensed`, `@fontsource/ibm-plex-mono` from
  `package.json` and their six weight imports from `main.tsx`.
- In `shared/theme.css`: `--font` becomes the Hanken Grotesk stack (spec
  §2.1's exact fallback list) in every theme block. Delete `--mono` and
  `--display` outright — **do not alias them to `--font`**; a stale
  `var(--mono))` left behind by this redesign must fall back to the
  inherited face and surface as a visible miss, not keep quietly resolving
  to Plex.
- In `client/src/styles.css`: add `code, kbd, samp, pre { font-family:
  inherit }` and `font-variant-numeric: tabular-nums` on `body`. This is
  also where the bulk of the 80 `--mono` / 14 `--display` / 31
  `text-transform: uppercase` consumers currently live — **do not chase
  every one down in this task**; task 6 (cleanup) is where dead rules left
  behind by this and the surface tasks are swept. This task only needs
  `--mono`/`--display` gone from `theme.css` and guard 1 below green, which
  is a narrower claim than "no rule anywhere still says `--mono`".
- `client/index.html`'s inline pre-paint script (the one CSP's
  `THEME_SCRIPT_SHA256` pins, `server/src/security.ts:20`) stamps only
  theme, density and `--font-scale` — it names no font and this task should
  have no reason to touch it. If any change here does end up editing that
  script's bytes, `THEME_SCRIPT_SHA256` must be recomputed and updated in
  the same change, or `test/csp.test.ts`'s
  `"covers the pre-paint theme script's exact bytes"` case goes red — say
  so in the PR description either way, since it is the one file in this
  task whose edit has a consequence outside `client/`.

### 2. Tokens — spec §2.2, DESIGN.md §8.2

In `shared/theme.css`:

- Rewrite the `daylight` block's `--board`/`--steel`/`--strip`/`--strip-hi`,
  `--edge`/`--hairline`/`--hairline2`, `--ink`/`--ink2`/`--ink3`,
  `--green`/`--amber`/`--mustard`/`--cyan`/`--red`/`--magenta`, and
  `--on-accent`/`--scrim`/`--shadow`/`--shadow2` to the exact values in
  spec §2.2's table (guard 5, below, pins these). The eight `--proj-N` sets
  are unchanged.
- Add `--fill-live` and `--fill-progress` to **every** theme block —
  daylight gets the literal colours (`#F5A15C`, `#7DC242`); each of the
  four dark blocks declares its own `var(--amber)` / `var(--green)` line,
  per-block rather than one shared rule, matching how every other ramp
  token in those blocks is themed.
- Add the `.hatch` utility:
  `repeating-linear-gradient(45deg, rgba(255,255,255,.30) 0 1px, transparent
  1px 4px)` as a `background-image`.
- Column ramp: the four column-header dots move to refactors `--amber`,
  ideas `--mustard`, bugs `--red`, tasks `--green` (today: magenta/mustard/
  red/cyan). This task changes the ramp mapping; it lands in the column
  header markup in task 2 (Board), not here — this task's job is only that
  the four tokens above exist with the right values. **Do not touch
  `--magenta`'s other job**: the capture dispatch chip (`.dispatch-tab.capture`,
  `.dispatch-chip.capture`, `client/src/styles.css` — four uses) keeps
  reading `--magenta` untouched; `ref-4` (already filed, out of this task's
  scope) tracks the stale comment claiming magenta has no job on this
  screen.
- **Leave the stale `theme.css` header comment about a server `wrapPage`
  linking the file alone** — DESIGN.md §8.2 explicitly assigns removing it
  to task 6 (cleanup, `task-41`), not this task. Do not remove it here even
  though it is dead by the time this task's tokens land; matching the
  design doc's own task split matters more than tidying it one task early.

### 3. Type scale — spec §2.3, DESIGN.md §8.1

Apply spec §2.3's table (adopted whole from the dashboard's own §8.1) to
`client/src/styles.css`'s typography rules: page/card title 19/500, large
metric 30/700, row name 15/500, card title 14/500, subtitle/hint 13/400,
body/chip/button 13, meta/axis/caption 12/400, pill/badge/status 11/500. 11
px is the floor — nothing on the board goes smaller, which is guard 3
below. `text-transform: uppercase` survives on `.rail-kicker` alone (guard
4). **Density (`compact`) and the text-scale `zoom`, including every `/
var(--font-scale)` division, stay exactly as they are** — this task changes
base sizes, never the compact/zoom arithmetic layered on top of them.

### 4. Shell and rail — spec §2.4, DESIGN.md §8.0

Rewrite `client/src/components/SideRail.tsx` and its `styles.css` rules to
DESIGN.md §8.0's numbers exactly, including the three departures its own
table records from the spec/mock's figures — **these are deliberate, do
not "correct" them back to 300 px / 44 px / 36 px**:

- Rail 280 px (not the mock's 300 px), 32 px padding-y.
- Nav rows 36 px, 14/500, 16 px padding-x, 16 px radius, a 16 px icon 12 px
  from the label (the mock's full 44 px row is kept for the phone menu
  only, where the row is a thumb target). Active: a 3 px ink bar 16 px tall
  at the left edge plus `--strip-hi` fill, never a colour change on the
  label; hover darkens the label alone. Icons hold `--ink` at every row
  weight.
- Sub-nav indent 24 px (the icon's centreline: 16 px row padding + half a
  16 px icon), not the mock's 36 px. Drawn only for the open section; Runs
  is the first (and today, only) section with a tree — **History** and
  **Watchdog**.
- `.main` sits on `--board`, `margin-top: 24px`, a 24 px top-left radius —
  the one corner the rail meets.
- Settings sits under a 1 px rule, 24 px either side.
- Below 700 px the rail becomes a top bar (wordmark left, ☰ right), every
  tree standing open; it hides on a downward scroll, returns on the first
  upward one, and stays pinned while the menu is open.

`resolveSection` and `SECTIONS` are unchanged. **The sub-nav tree's Runs
entries must write the same `RUNS_MODE_KEY` the segmented control inside
`RunsView.tsx` reads and writes today** (`client/src/lib/runs-mode.ts`) —
call the same setter rather than inventing a second one, so the persisted
key and its guard (`isRunsMode`) stay the one implementation. This is a
genuine sequencing seam between this task and task 3 (Runs), worth stating
precisely rather than leaving implicit: this task adds the rail tree as a
**second writer of the same key** the in-page segmented control
(`RunsView.tsx` ~line 631, 937–945) already owns; it does not remove that
control. Task 3 is where the in-page segmented control is deleted — DESIGN.md
§8.0 says the tree replaces it "at every width," and task 3 is the one
redrawing `RunsView` into the two-page History/Watchdog shape that control
lived inside. Leaving the old control in place after this task is correct,
not a leftover to clean up here.

### 5. The `ui/` primitives — spec §12.2, §12.4

Land every primitive in spec §12.2's table **except `Modal` and
`FormSheet`**, which are task 5's (§12.4 says so explicitly: task 5 lands
those two together because their only composers — the item modal, and
`LaunchSheet`/`OrchestrateSheet` — are task 5's own work). What lands here:

`Band`, `Sheet` + `SheetHead`, `FigureStrip` + `Figure`, `Chip`, `Pill`,
`Dot`, `Marker`, `ProgressRow`, `Ledger` + `DayKicker`, `Segmented`,
`Select`, `NumberField`, `Switch`, and the `useNarrow` hook — each under
`client/src/components/ui/`, each owning one CSS class family declared
exactly once inside a new `styles.css` block headed `/* ── ui primitives`
(guard 7 pins the block and the "exactly once" rule). Props are spec
§12.2's column for each; do not invent a prop the table doesn't list without
first checking whether the composing task (2–5) actually needs it — the
table is the contract every later task composes against.

Two of these already exist under `client/src/components/settings/` and
move rather than get rewritten: `Segmented` and `NumberField` are currently
defined in `SettingsRow.tsx` — move them to `ui/`, keep their behaviour
identical, and update every current importer (`SettingsView.tsx`,
`WatchdogGroup.tsx`, and any other caller) to import from the new location.
`Select` and `Switch` are new — DESIGN.md §8.2/§8.6 and spec §5.2 describe
`Switch` as a recessed `--steel` track under a raised `--strip` option (a
raised control marks a state, never a button — the rule both documents
state once and expect every subsection to honour). `SettingsRow` and
`SettingsGroup` stay under `settings/` — they compose `Sheet` and rows, they
are not a primitive themselves (spec §12.2, closing paragraph).

`Dot`'s `hue` prop resolves through the existing `project-hue.ts` exactly as
`.pill-proj-N` does today — the class stays in the stylesheet, never a
`style` attribute, so a theme swap recolours it for free. `Dot`'s `breathe?`
flag (used later by the run chip, task 2) is part of this task's contract
even though nothing calls it with `breathe` yet — land the prop and its CSS
now so task 2 composes rather than invents (spec §12.1's "landing them
first means tasks 2–5 compose and never invent").

None of these primitives is wired into the Board, Runs, Archive or Settings
pages by this task — they exist, tested, unused except by the rail (which
itself may use `Chip`/`Dot` if convenient). That wiring is each later task's
own job.

## Test cases

Authority: spec §9 (testing), read in full — this task lands most of its
mechanical guards. Cases below name what must be asserted; exact assertions
are the executor's to write against the primitives as actually built.

1. **`test/design-guards.test.ts` is new and green**, reading
   `client/src/styles.css`, `shared/theme.css` and `client/src/main.tsx` as
   text. Spec §9 numbers these 1–7 under the heading "six source guards" —
   that mismatch is the spec's own text, not a transcription error here;
   implement all seven it actually lists:
   1. neither stylesheet declares or reads `--mono` or `--display`;
   2. `theme.css` declares exactly one `--font` stack per theme block, and
      `styles.css` declares no `font-family` but `inherit`;
   3. every px-literal `font-size` in `styles.css` is ≥ 11 px, with a
      literal allowlist inside the test for any legal non-px value (`em`,
      `calc(...)`), each entry carrying a one-line reason;
   4. `text-transform: uppercase` appears in exactly one rule,
      `.rail-kicker`;
   5. the daylight block's tokens equal spec §2.2's table, and every theme
      block declares both `--fill-live` and `--fill-progress`;
   6. `main.tsx` imports `@fontsource/hanken-grotesk` at weights
      400/500/600/700 and no other `@fontsource` package; `package.json`
      lists none other;
   7. **one home per primitive** — each `ui/` class family from spec
      §12.2's table is declared in `styles.css` exactly once, as a bare base
      selector, inside the `/* ── ui primitives` block, and no selector
      outside that block starts with one of those class names.
2. **Every new `ui/` primitive has its own `test/ui-<name>.test.tsx`**,
   pinning its role, its accessible name, and that each variant prop lands
   as its documented class — the same shape `SettingsRow`'s existing suite
   already has. One suite per primitive in §12.2's table minus `Modal` and
   `FormSheet`.
3. **`Segmented` and `NumberField` keep every existing caller working.**
   `SettingsView.tsx` and `WatchdogGroup.tsx` (and any other current
   importer) render unchanged after the move; no existing settings test
   regresses.
4. **`test/csp.test.ts` is untouched and green**, including the byte-hash
   case over `client/index.html`'s inline script.
5. **Rail behaviour**: the sub-nav tree renders only while Runs is the open
   section; selecting a tree entry writes `RUNS_MODE_KEY` through the same
   setter/guard `runs-mode.ts` exports (`isRunsMode`); the existing in-page
   segmented control in `RunsView.tsx` still renders and still works after
   this task (it is task 3's to remove, not this one's).
6. **Existing `*-style.test.ts` suites** (8 in `test/` today via
   `helpers/css-rule` — check the current count in the worktree rather than
   trust this number or spec §9's "ten", since concurrent work may have
   added one) **stay green**, moved to their replacement selector rather
   than deleted if this task renames or removes a selector one of them
   pins. None of the eight visible today reads rail or settings-control
   selectors, so none is expected to need moving — verify this rather than
   assume it.
7. **No new derivation.** Nothing in `client/src/lib/` changes; this task
   touches only presentation.
8. **Density and zoom are untouched.** Every `/ var(--font-scale)` division
   and the `compact` density rules still compute exactly as before — assert
   at least one existing compact/zoom test still passes unchanged.

## Done when

- `pnpm test` is green on both runners (`pnpm run test:jest` and
  `pnpm run test:skills`), including every case above.
- `pnpm run typecheck` and `pnpm run build` both pass.
- `pnpm run test:jest -- design-guards` passes all seven guards in
  isolation.
- The app renders in Hanken Grotesk everywhere, at the new daylight
  palette, with the 280 px rail and its sub-nav tree under Runs, in all
  five themes, with no layout change to the Board/Runs/Archive/Settings
  page bodies themselves.
- Screenshot the shell (rail plus an unchanged page body) at 1400 px and
  400 px wide, in daylight and midnight, through a pid-owned static server
  killed by pid when done (spec §9) — the later tasks own screenshotting
  their own surfaces once this task's shell is in place.
- `git diff --stat` against `main` touches `package.json`,
  `client/src/main.tsx`, `shared/theme.css`, `client/src/styles.css`,
  `client/src/components/SideRail.tsx`, new files under
  `client/src/components/ui/`, a new `client/src/hooks/useNarrow.ts`,
  `client/src/components/settings/SettingsRow.tsx` and its callers, and
  test files. No server route, no skill, no `shared/types.ts` change.
- This task is reviewed, verified and **merged to `main` before any of the
  other five fe-redesign tasks starts** — it is the one every later task's
  `## Plan` names as its dependency by id (`task-36`).

## Outcome

2026-09-15 — landed. Hanken Grotesk is the app's one face, `shared/theme.css`
carries the rewritten daylight palette plus `--fill-live`/`--fill-progress` in
all five theme blocks, `client/src/styles.css` has no type under 11 px and no
second face, the rail is DESIGN.md §8.0's 280 px rail with its sub-nav tree
under Runs, and `client/src/components/ui/` holds every primitive spec §12.2
lists except `Modal` and `FormSheet`. All seven source guards are green in
`test/design-guards.test.ts`; every primitive has its own suite. No server
route, no skill, no `shared/types.ts` change, and nothing in `client/src/lib/`
moved.

### What was built

- **Font.** `@fontsource/hanken-grotesk` in, Barlow / Barlow Condensed / IBM
  Plex Mono out of `package.json` and `main.tsx`; four weights (400/500/600/700).
  `--font` is the Hanken stack in every theme block; `--mono` and `--display`
  are deleted, not aliased. `body` gained `font-variant-numeric: tabular-nums`
  and the sheet gained `code, kbd, samp, pre { font-family: inherit }`.
  `client/index.html` was never touched, so `test/csp.test.ts`'s byte-hash case
  needed nothing.
- **Tokens.** Daylight rewritten to spec §2.2's table exactly (guard 5 pins
  every value); the two fill tokens added per theme block — literals on
  daylight, a `var(--amber)`/`var(--green)` line of its own in each of the four
  dark blocks; `.hatch` added as one utility rule. The eight `--proj-N` sets and
  `--magenta`'s dispatch-chip job are untouched, and the stale `wrapPage`
  header comment is deliberately left for `task-41`.
- **Type scale.** Of `styles.css`'s 130 px-literal `font-size` declarations, the
  87 below 11 px were raised to the role §2.3's table gives them — from
  8/9/9.5/10/10.5 px up to 11 px (pills, markers, badges, counts, kickers),
  12 px (meta, captions, times) or 13 px (body, controls, buttons) — and the
  elements the table names outright took their stated size and weight:
  `.board-title` and `.drawer-title`/`.sheet-title` 19/500, `.board-col-name`
  15/500, `.board-card-title` 14/500, the card's marker row 11/500. All 94
  `var(--mono)`/`var(--display)` reads are gone, and so are all 31
  `text-transform: uppercase` rules — the one in the sheet now is the new
  `.rail-kicker`, which did not carry it before.
- **Rail.** `SideRail.tsx` rewritten: 280 px, 32 px padding-y, 36 px rows at
  14/500 with a 16 px inline-SVG icon 12 px from the label, active marked by a
  3 px ink bar 16 px tall plus `--strip-hi` and never by a label colour, hover
  on the label alone, a 20/700 wordmark over the 11/500 kicker with one
  decorative green `Dot`, Settings under a 1 px rule with 24 px either side,
  and `.main` on `--board` with a 24 px top margin and a 24 px top-left radius.
  The Runs tree (History / Watchdog) is drawn only for the open section, hung
  24 px in with its stem and tick as two background layers so the last row's
  stem stops at its own centre. Below 700 px the rail is a top bar with a ☰
  menu, every tree open, hiding on a downward scroll and pinned while the menu
  is open. `resolveSection` and `SECTIONS` are unchanged.
- **Primitives.** `Band`, `Sheet`+`SheetHead`, `FigureStrip`+`Figure`, `Chip`,
  `Pill`, `Dot`, `Marker`, `ProgressRow`, `Ledger`+`DayKicker`, `Segmented`,
  `Select`, `NumberField`, `Switch` and `useNarrow`. `Segmented` and
  `NumberField` moved out of `settings/SettingsRow.tsx` with their behaviour
  identical; `SettingsView.tsx` is the one importer and was updated.

### Verification

```
$ pnpm run typecheck
$ tsc --noEmit

$ pnpm run build
dist/assets/index-UhgBK15Y.js                                    347.65 kB │ gzip: 104.94 kB
✓ built in 1.20s

$ pnpm run test:jest -- design-guards

Test Suites: 1 passed, 1 total
Tests:       13 passed, 13 total
Snapshots:   0 total
Time:        2.696 s, estimated 3 s
Ran all test suites matching /design-guards/i.

$ pnpm test
  ...
1..538
# tests 538
# suites 0
# pass 538
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 80591.575667

────────────────────────────────────────────────────────────
PASS  jest
PASS  node --test (skills)

pnpm test: both runners passed.
```

The `pnpm test` tail above is the node runner's; jest's own totals scrolled
past it, and `PASS jest` is the line that gates the union (`scripts/test-all.mjs`
exits 1 if either runner failed). Screenshots of the shell were
taken at 1400 px and 400 px in daylight and midnight (Board and Runs, plus the
phone menu with its tree open) against the production build served by
`node dist/server/src/main.js` on port 4399, a process started by this session
and killed by its recorded pid; `.playwright-mcp/` is gitignored, so they are
not in the diff.

### Decisions worth a reviewer's eye

1. **`ui-` prefix on every primitive class family.** Spec §12.2 names components
   and props, never class names. Three of these patterns already exist under
   board-section names other sections read (`.pill` is the project pill,
   `.set-seg` was the Settings segmented control) and tasks 2–6 retire those call
   sites one surface at a time. A prefix lets the new family and the dying one
   stand side by side for the length of that migration, and makes guard 7's "no
   selector outside this block" a string comparison rather than a judgement about
   which `.pill` was meant.
2. **Guard 2 is stated as "one `font-family: var(--font)`, on `body`, and
   `inherit` everywhere else."** §9's words are "styles.css declares no other
   font-family but `inherit`", but one declaration necessarily names the face.
   Six rules that re-declared `var(--font)` on form controls and buttons (which
   do not inherit the document face) became `inherit`.
3. **Sizes already at or above 11 px were left alone unless §2.3's table names
   that element.** The floor is the guard; the surfaces carrying the table's
   larger roles are each redrawn by tasks 2–5, and the primitives landed here
   carry the full table. `.runs-tile-value` is the clearest case: it is today's
   figure-strip value at 18 px, and the table's 30/700 lives on `Figure`, which
   task 3 wires in — raising it here would have reflowed a page body this task
   promises not to re-shape.
4. **`useRunsMode` is new (`client/src/hooks/useRunsMode.ts`), and `RunsView`
   now reads it.** The plan says the tree must write the same key through the
   same guard, and be a second writer beside the in-page control. With
   `usePersistedState` that is a `useState` per caller: the rail's write would
   reach localStorage and never reach the mounted `RunsView`, so clicking
   Watchdog in the tree would persist a mode the page beside it went on
   ignoring. The hook holds no cached value — it re-reads storage per mount and
   only adds a listener set — so nothing about the key, its JSON shape or its
   guard changed, and `lib/runs-mode.ts` is untouched. This is the one file the
   plan's file list did not name.
5. **The rail's padding-y is the literal `32px`, so it no longer reads
   `--body-pad`.** §2.4/§8.0 state it as a figure, so the rail's padding stops
   tightening under compact density. No density token changed and every other
   consumer of `--body-pad` is untouched, but it is a density behaviour this
   task does alter.
6. **`Dot`'s `hue` is the index, not the class.** `project-hue.ts`'s
   `pillClass` returns `pill-proj-N`, which is the wrong family for a filled
   dot, so `Dot` takes `1–8` and emits `ui-dot-proj-N` — still a class, never a
   `style` attribute, so a theme swap recolours it for free. `lib/` is
   unchanged, as the plan requires; task 2 will want an index rather than
   `ProjectHues.classFor`'s string.
7. **Guard 7's second case was vacuous until the red proof caught it.** The
   block sits last in the sheet, so "after the header" meant "anywhere below",
   and a rule appended to the file — the likeliest way a page comes to restate a
   primitive — read as inside the block and passed. The block now carries a
   closing `/* ── end ui primitives` marker and the guard prefix-matches class
   tokens; an offender on either side of the block is now caught, proved both
   ways.

### Test cases, against the item's list

1. `test/design-guards.test.ts`, all seven guards, green in isolation.
2. One `test/ui-<name>.test.tsx` per primitive — 13 suites, plus
   `ui-use-narrow` for the hook and `use-runs-mode` for its React binding.
3. `Segmented`/`NumberField` callers unchanged: `SettingsView.tsx` is the only
   importer (`WatchdogGroup.tsx` imports neither; `NumberField` had no caller at
   all), and `settings-view`/`settings-watchdog` pass untouched.
4. `test/csp.test.ts` untouched and green — `client/index.html` never changed.
5. Rail behaviour: `test/rail.test.tsx`. The in-page segmented control still
   renders and still works — `runs-view.test.tsx`'s three mode cases pass
   unmodified.
6. Eight `*-style.test.ts` suites in `test/` today (not the spec's "ten"); none
   reads a rail or settings-control selector, none needed moving, all green.
7. No new derivation: `git status client/src/lib` is empty.
8. Density and zoom: the diff moves no `--font-scale` division and no
   `[data-density]` token — see decision 5 for the one consumer that changed.

### Left for the tasks that own them

- `task-41` will find no `--mono`/`--display` consumers left in `styles.css`.
  Its plan expects "the bulk" of them to survive this task, but guard 1 as §9
  specifies it reads BOTH stylesheets, so making it green required removing
  them all. Its own step is a grep confirming none remain, which still passes.
- The stale `theme.css` `wrapPage` header comment is still there, deliberately.
- `.magenta`'s dispatch-chip job and the stale comment about it are `ref-4`'s.

Contract sweep: 17 sites updated (.claude/DESIGN.md §8.1 and §8.6, CLAUDE.md's
`client/src/` Layout line, docs/subsystems/board.md's rail paragraph plus a new
Primitives section, client/src/components/settings/SettingsView.tsx's
`NumberField` path, nine now-false comments in client/src/styles.css and three
in shared/theme.css). Left standing on purpose: shared/theme.css's `wrapPage`
header comment (the plan assigns it to `task-41`), and
docs/superpowers/plans/*.md, which quote the old CSS verbatim as a record of
what was built then rather than as a live contract.
Red proof: 18 tests went red with the change reverted — all 13 design-guards
cases (across reverts of theme.css, styles.css, main.tsx and package.json, plus
two injected offenders for the two guards no revert could reach) and 5 of
rail.test.tsx's 7. The other 15 new suites fail to load at all without the
components they pin, which is the same proof at file granularity. rail.test's
two remaining cases (no `aria-expanded` on a section row, no ☰ at desktop
width) are absence-invariants that were already true of the old rail and are
kept as regression guards. The proof found a real defect: guard 7's
"no selector outside the block" case was vacuous, and the fix is decision 7
above.
