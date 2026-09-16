---
id: task-41
title: Cleanup: dead CSS after the redesign, docs/subsystems/board.md rewritten
created: 2026-09-15
tags: fe-redesign, cleanup, docs
updated: 2026-09-16T11:00:46Z
started: 2026-09-16T10:38:09Z
execute-elapsed: 1357
execute-tokens: 193929
---

## Goal

Sweep what tasks 1–5 left behind rather than deleted outright — dead CSS
selectors, a stale comment, and doc-comments whose numbers now describe a
geometry that no longer exists — and rewrite `docs/subsystems/board.md` so
it describes the app as this redesign leaves it, gaining a Primitives
section that keeps spec §12's component table current. This is the one
task with no new visual surface of its own: nothing it does should be
visible in a screenshot diff, which is also this task's own proof that it
went far enough and no further.

**Depends on `task-36`, `task-37`, `task-38`, `task-39` and `task-40`** —
all five other fe-redesign tasks merged to `main`. This task's whole job is
naming what they left behind, so it cannot start before they exist, and
running it earlier would mean sweeping code that has not landed yet.

## Plan

Authority: `docs/superpowers/specs/2026-09-15-fe-redesign-design.md` §7
(lines 620–627) and `.claude/DESIGN.md`'s own note in §8.2 assigning the
`theme.css` comment removal here. There is no DESIGN.md §8.9 — this task's
work is named in spec §7 and in the one parenthetical DESIGN.md carries for
it, not in a subsection of its own.

### 1. Dead CSS

Read `client/src/styles.css` fresh, in the state the five prior tasks leave
it — do not work from the version in this repo today, which predates all
of them. Named starting points, per spec §7 (verify each still exists and
is genuinely unreferenced before removing it — a task earlier in the queue
may already have cleaned up more than the spec anticipated, or less):

- `.rail-brand`'s old rules (superseded by `task-36`'s rail rewrite).
- `.run-strip*` (the class family `RunStrip.tsx`/`StartingStrip.tsx` owned,
  deleted in code by `task-37` — their CSS may still be sitting in
  `styles.css` unreferenced).
- `.drawer` panel geometry — the pinned-to-the-right-edge layout `task-40`'s
  `Modal` replaced. `.drawer-*` class names composing content (facts, body)
  may still be in active use if `task-40` kept them as `Modal`'s internal
  class names; remove only the **positioning/panel** rules that shaped the
  old right-edge layout, not classes still doing a job.
- Every remaining `--mono`/`--display` consumer in `styles.css` — `task-36`
  only guaranteed these two tokens gone from `theme.css` and guard 1 green;
  it explicitly left the bulk of `styles.css`'s own consumers for this
  task. Confirm none remain with a grep for both strings across
  `client/src/styles.css` after removal, not just a visual check.

### 2. The stale `theme.css` comment

Remove the header comment in `shared/theme.css` claiming a server
`wrapPage` links the file — DESIGN.md §8.2 names this removal as task 6's
explicitly, not `task-36`'s, and `task-36`'s own item deliberately left it
in place for that reason. No server code in this repo reads `theme.css`;
confirm that with a grep before removing the comment, not just trust the
design doc's claim.

### 3. `zoom` and `/ var(--font-scale)` comments

Spec §7: "the `zoom` and `/ var(--font-scale)` comments re-read against the
new geometry." **The arithmetic itself is a non-goal for this entire
redesign** (spec's own Non-goals: "Density (`compact`) and the text-scale
`zoom` stay exactly as they are, including every `/ var(--font-scale)`
division") — this step is **not** license to touch that arithmetic. It is
narrower: every comment in `styles.css` that explains a `/ var(--font-scale)`
division or a `zoom`-related rule by referencing a size, a selector, or a
layout fact from the pre-redesign geometry now needs to read correctly
against the sizes and selectors tasks 1–5 actually landed. Read each such
comment and correct only what it asserts about the surrounding code, not
the code itself, unless a comment's claim has become outright false (e.g.
citing a class name task 2 renamed) — in which case fix the citation, not
the rule it is citing.

### 4. `docs/subsystems/board.md`

Rewrite for the surfaces as they now are: the run chip (`task-37`), the two
Runs pages with History's detail sheet (`task-38`), the item modal and the
two sheets (`task-40`). Read the current file in full before rewriting —
it already documents the rail, the board, the toolbar Orchestrate control
and the launch/orchestrate sheets in prose; update what changed rather than
starting from a blank page, since most of its non-visual claims (what the
server returns, which derivations live in `client/src/lib/`, the
`runner-fix:` hoisting, the `uncommitted` chip's two consequences) are
unaffected by a visual redesign and should carry over verbatim.

Gain a **Primitives** section — spec §11's own instruction — that is spec
§12's component table (§12.2) kept current: which `ui/` primitive draws
which DESIGN.md pattern, its props, and what composes it. This is the
"one home per primitive" rule's documentation half; `test/design-guards.test.ts`
guard 7 (from `task-36`) is its enforcement half — the two are meant to
agree, and this section is where a future reader checks that they still
do.

`CLAUDE.md`'s Layout line and `docs/overview.md`'s map row for
`.claude/DESIGN.md` are **already in place** (landed in the docs-only
commits that preceded this whole sequence — verify with `git log
--oneline -- CLAUDE.md docs/overview.md` before assuming otherwise) — this
task does not need to add either.

## Test cases

This task is documentation and dead-code removal; its cases are mostly
structural rather than behavioural, and none of them should change what
any existing suite renders.

1. **No `.run-strip`, `.drawer` panel-geometry, `--mono` or `--display`
   selector remains** in `client/src/styles.css` — a grep-shaped assertion,
   or extend `test/design-guards.test.ts`'s existing guard 1 (already
   checking `--mono`/`--display` are gone from both stylesheets as of
   `task-36`) to also cover the three CSS-family names above, if it does
   not already.
2. **Every existing test suite that passed before this task still passes
   after it**, unmodified in its assertions — this task removes CSS and
   comments, never behaviour, so a suite needing a code change here is a
   sign the sweep went too far.
3. **No visual regression.** Re-run the screenshot set from `task-36`
   through `task-40` (Board, Runs › History, Runs › Watchdog, Archive,
   Settings, an open item modal, at 1400 px and 400 px, daylight and
   midnight) and diff by eye against each task's own screenshots — pixel-
   identical is the expectation, since this task touches no rendered
   layout.
4. **`docs/subsystems/board.md` names the run chip, both Runs pages with
   History's detail sheet, and the item modal/two-sheet overlay set** —
   read the rewritten file and check each is actually described, not just
   that the file changed.
5. **The Primitives section lists every `ui/` primitive from spec §12.2's
   table**, cross-checked one for one against
   `client/src/components/ui/`'s actual file list — a primitive present in
   code but missing from the doc, or named in the doc but absent from
   `ui/`, is this task's own drift to catch before it ships.
6. **The `theme.css` `wrapPage` comment is gone**, and a grep for
   `wrapPage` across `server/src` confirms the comment's own claim (no
   server code reads `theme.css`) before it is deleted, not after.

## Done when

- `pnpm test` green on both runners.
- `pnpm run typecheck` and `pnpm run build` pass.
- `pnpm run test:jest -- design-guards` still passes all seven guards,
  extended if this task added CSS-family checks to guard 1.
- No `--mono`, `--display`, `.run-strip*`, or old `.drawer` panel-geometry
  selector remains in `client/src/styles.css`; the `theme.css` `wrapPage`
  comment is gone.
- `docs/subsystems/board.md` describes the app's five surfaces as tasks
  1–5 actually built them, with a Primitives section matching
  `client/src/components/ui/`'s real contents.
- No screenshot from any of the five prior tasks changes as a result of
  this task's diff.
- `git diff --stat` against `main` touches `client/src/styles.css`,
  `shared/theme.css`, `docs/subsystems/board.md`, and — only if guard 1 is
  extended — `test/design-guards.test.ts`. No component file, no server
  route, no skill, no `shared/types.ts` or `shared/agent.ts` change.

## Outcome

2026-09-16 — done. The sweep removed 15 dead rules from `client/src/styles.css`, corrected seven comments the removals (or tasks 1–5) left
asserting something false, deleted the `theme.css` `wrapPage` claim, rewrote `docs/subsystems/board.md` with a Primitives section, and extended
`test/design-guards.test.ts`'s guard 1 with a second case pinning the removal. No component, server, skill or shared type file changed.

**What was actually dead, versus what the plan expected.** Three of the four "dead CSS" starting points needed no work at all, which the plan
anticipated ("a task earlier in the queue may already have cleaned up more than the spec anticipated"):

- `.rail-brand` — **live**, not dead. `SideRail.tsx:76` draws it and both its rules (the base rule and the narrow override) are `task-36`'s
  rewrite, written in §8.0/§8.1's voice. Nothing removed.
- `.run-strip*` — **already gone**: `task-37` deleted the rules with the components. What remained were prose references, two of which are
  deliberately historical and one of which (`.run-strip-attention`, cited as a live sibling tone) was false and is now dropped.
- `--mono` / `--display` — **already zero** in both stylesheets before this task; guard 1's existing case had held them there since `task-36`.
- `.drawer` panel geometry — **dead as described**, and removed: `.drawer-backdrop`, `.drawer`, `.drawer-head`, `.drawer-head .pill`,
  `.drawer-title`, `.drawer-close`, `.drawer-close:hover`, `.drawer-meta`, `.drawer-meta .drawer-path`. `.drawer-empty` stays — five components
  draw it (`ItemModal`, `LaunchSheet`, `OrchestrateSheet`, `RunsView`, `RunDetail`), which is exactly the "classes still doing a job" the plan
  carved out.

**One family removed that the plan did not name.** `styles.css`'s own comment above `.sheet*`, written by `task-40`, assigned the sheet shell's
removal to this task by name ("The dead half is spec §7's cleanup, task 6's, not this section's to delete"). Six rules were unreferenced and are
gone — `.sheet-backdrop`, `.sheet`, `.sheet-head`, `.sheet-body`, `.sheet-actions`, `.sheet-launch`, `.sheet-launch:disabled` — while the twelve
`.sheet-*` classes both sheets still draw inside `FormSheet` stay. Every one was proven unreferenced by a class-token grep over `client/src` and
`test/` before removal, and the new guard case now pins all three families at once.

**One rename the file asked for and this task refused.** The `run drawer` section header claimed renaming the live `.run-drawer-*` family was
"task 6's cleanup". It is not: the rename would edit `RunDetail`, `RunRowTime` and `OrchestrateSheet` plus a test-id prefix for no behaviour
change, and this item's own "Done when" rules out touching any component file. The comment now says the names stay and why, rather than pointing
at a task that will never do it.

**One correction to this item's own Plan.** §2 cites "DESIGN.md §8.2" as naming the `wrapPage` removal as task 6's. DESIGN.md does not mention
`wrapPage` anywhere; the spec does, twice (§2.2's tokens line and §7). The rewritten `theme.css` header cites spec §7. The claim the comment made was
verified false before removal, as §2 asked: there is no `server/src/render/` directory and no file under `server/src` mentions `theme.css`.

**Drift the Primitives section caught (test case 5).** All 15 files in `client/src/components/ui/` are in the table and the table names no
component that is not there (`FigureStrip`, `SheetHead` and `DayKicker` are secondary exports of `Figure.tsx`, `Sheet.tsx` and `Ledger.tsx`). Two
entries disagree with spec §12.2 and the doc records both as code's reading: `StageBars` draws its own bars rather than composing `ProgressRow`,
and `NumberField` has **no composer at all** — the watchdog's numeric policy rows are `Select` ladders. `NumberField` was kept, not deleted:
deleting it means deleting its class family and guard 7's entry in the same change, which is a decision with a rendered surface behind it and not
part of a sweep whose proof is that nothing moved.

**Test case 3 (no visual regression) could not be run as written and was proven another way.** No screenshots from `task-36`–`task-40` are stored
in this repo, so there was nothing to diff by eye against. What is proven instead: every removed selector was shown unreferenced by a class-token
grep over `client/src` and `test/` before deletion, `.drawer-empty` and the twelve live `.sheet-*` classes were kept, no component file changed at
all (`git diff --stat` below), and the 105 jest suites — including every component suite — pass unmodified. A rule nothing renders cannot move a
pixel.

Verification, run fresh after the last edit:

```
$ pnpm run typecheck
$ tsc --noEmit

$ pnpm run test:jest
Test Suites: 105 passed, 105 total
Tests:       1705 passed, 1705 total
Snapshots:   0 total
Time:        61.657 s, estimated 62 s
Ran all test suites.

$ pnpm test
# tests 538
# pass 538
# fail 0
PASS  jest
PASS  node --test (skills)
pnpm test: both runners passed.

$ pnpm run build
dist/assets/index-C7CBKQCo.js      347.71 kB │ gzip: 104.98 kB
✓ built in 1.04s

$ pnpm run test:jest -- design-guards
Tests:       14 passed, 14 total

$ grep -c -- "--mono\|--display" client/src/styles.css shared/theme.css
client/src/styles.css:0
shared/theme.css:0

$ git diff --stat
 backlog/tasks/open/task-41-....md                  |   3 +
 client/src/styles.css                              | 167 +++++++-------------
 docs/subsystems/board.md                           | 170 +++++++++++++++------
 shared/theme.css                                   |  18 ++-
 test/design-guards.test.ts                         |  50 ++++++
 5 files changed, 249 insertions(+), 159 deletions(-)
```

Contract sweep: 9 sites updated (client/src/styles.css — the file header's "item drawer", the `run drawer` section header, `.orchestrate-step-body`'s `.sheet-body` citation, `.orchestrate-steps`' "monospace" claim, the uncommitted flag's `.run-strip-attention` citation, `.run-detail-mode-note`'s `.run-mode-badge` citation, `.ui-modal`'s "the old drawer's were"; shared/theme.css's header; docs/subsystems/board.md). Two sites left standing on purpose: `client/src/components/board/BoardView.tsx:531,557` cite `.drawer` in explicitly past-tense prose about a hazard that is already recorded as gone, and `backlog/tasks/done/*` items are historical records of finished work.
Red proof: 1 test went red with the change reverted (two deleted rules appended back to `client/src/styles.css` from a `/tmp` copy, never `git stash`; guard 1's new case failed with 4 offenders, file restored byte-identical and re-run green).
