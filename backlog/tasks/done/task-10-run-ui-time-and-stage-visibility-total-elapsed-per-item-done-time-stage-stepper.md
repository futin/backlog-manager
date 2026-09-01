---
id: task-10
title: Run UI time and stage visibility: total elapsed, per-item done time, stage stepper
created: 2026-09-01
updated: 2026-09-01T14:51:44Z
started: 2026-09-01T14:35:37Z
execute-elapsed: 967
---

## Goal

The board's orchestrator surfaces answer three questions at a glance, with no
new backend fields: how long has this run been going (strip and drawer), when
did each finished item finish and how long did it take, and where in the
pipeline each item is / what is still ahead of it (a per-row stage stepper).
Design A plus the strip-elapsed readout from the 2026-09-01 design session.

## Plan

Note for the implementer: this plan specifies behaviour and exact test cases,
deliberately not literal code — the test cases are authoritative, any sketch
wording is not. Disagree with the shape freely as long as the cases pass.

Data already exists end to end: `run.startedAt` / `run.updatedAt` on
`OrchestratorRun`, and `RunQueueItem.stageAt` (first-arrival ISO timestamp per
visited stage). The `RunStage` union order gives the stepper its canonical
sequence (`dispatched → inspecting → reviewing → fixing → verifying → merging
→ merged`). Server, CLI and run-file schema are untouched.

1. New client lib (suggested `client/src/lib/run-time.ts`) with the derivations
   and formatting, mirroring `elapsedSince`'s contract of returning `null` for
   unparseable stamps rather than ever rendering NaN:
   - format a millisecond span as `42s` / `9m 12s` / `1h 04m`;
   - run total elapsed: `now − startedAt` while the run is `running` and
     `fresh` (the existing 5s poll re-render makes it tick), otherwise
     `updatedAt − startedAt`;
   - per-item pipeline duration: earliest `stageAt` arrival (normally
     `dispatched`) to the terminal stage's `stageAt` entry for a terminal item,
     to `now` for an active one; `null` when `stageAt` is empty;
   - done clock-time: the terminal stage's `stageAt` entry formatted as local
     `HH:MM`.
2. `RunStrip`: one new span beside the heartbeat reading showing the run's
   total elapsed (compact, minutes-level). Renders nothing when the derivation
   is `null`.
3. `RunDrawer` meta line: `started HH:MM · <total> elapsed` alongside the
   existing `status · N past runs`.
4. `RunDrawer` queue rows:
   - right-aligned time per row: terminal rows `<duration> · <HH:MM>`, active
     rows `<duration> elapsed`, `pending` an em dash, `ungroomed`/`skipped`
     nothing;
   - a 7-dot stepper under every row except `ungroomed` (it never entered the
     pipeline): filled dot = stage has a `stageAt` entry, ringed dot = the
     row's current stage, hollow = never entered — so a merged row with no
     `fixing` key honestly shows a hollow fixing dot ("no fix loop needed");
     every dot names its stage on hover via a native `title` (visited dots
     append the arrival time, e.g. `inspecting · 14:31`) and carries the same
     text as `aria-label` — hover is mouse-only, so the label keeps the name
     reachable for screen readers, and the row's chip still prints the current
     stage word for everyone else;
   - active rows get a caption `now <stage> · <span> in stage` derived from
     `stageAt[current stage]`;
   - `failed`/`needs-answers`/`parked` rows: stepper simply shows what was
     visited; duration runs to the terminal stage's stamp when present, else
     to the last visited stamp.
5. `styles.css` gains the stepper dot/segment classes; the existing stage chip
   classes and their literal names stay untouched (tests assert on them).

Known blur, to be documented in a comment: `stageAt` keeps first arrivals
only, so a fix loop re-entering `reviewing`/`fixing` does not re-stamp — the
in-stage caption can misattribute time across loops. Totals and done-times are
unaffected.

## Test cases

- run-time lib (jest, flat in `test/`):
  - span formatting: `42_000` → `42s`; `552_000` → `9m 12s`; `3_840_000` →
    `1h 04m`.
  - total elapsed: a `running` + `fresh` run measures from `startedAt` to now;
    a `done` run measures `startedAt → updatedAt`; malformed `startedAt` →
    `null`.
  - item duration: `stageAt.dispatched = T0`, `stageAt.merged = T0 + 552s` →
    552s; an active item measures `dispatched → now`; empty `stageAt` → `null`.
- `RunStrip` (jsdom): a fresh run started 38 minutes ago renders an elapsed
  reading containing `38m`; a malformed `startedAt` renders no elapsed node at
  all (assert absence, not empty text).
- `RunDrawer` (jsdom):
  - meta line contains the formatted total and the word `elapsed`;
  - a merged row shows its duration and the local `HH:MM` of `stageAt.merged`;
  - an active `reviewing` row's stepper: filled `dispatched`/`inspecting`,
    current marker on `reviewing`, hollow after; caption names `reviewing`;
  - a merged row whose `stageAt` lacks `fixing` renders the fixing dot hollow
    while later dots are filled;
  - a `pending` row: all dots hollow, time column shows the em dash;
  - stepper dots expose their stage name: the `reviewing` dot of an active
    row has `title`/`aria-label` containing `reviewing`; a visited
    `inspecting` dot's title also contains its `HH:MM` arrival; a hollow
    (never-entered) dot still names its stage, with no time appended;
  - an `ungroomed` row renders no stepper element;
  - the existing strip/drawer suites stay green with zero edits — chip class
    literals and current DOM they assert on are unchanged.

## Done when

- `pnpm test` and `pnpm run typecheck` green, new suites included.
- A live run on the board shows the strip elapsed, drawer total, and per-row
  steppers/times matching the design A mockup.
- Zero diffs under `server/` and `skills/`; run.json schema untouched.

## Outcome

2026-09-01 — built and verified. New client lib `client/src/lib/run-time.ts`
holds every derivation and both formatters; `RunStrip` gained a total-elapsed
reading beside the heartbeat, `RunDrawer` gained a `started HH:MM · <total>
elapsed` meta line, a right-aligned per-row time, a seven-dot stepper and an
in-stage caption on active rows; `styles.css` gained the dot/time classes.
Zero diffs under `server/`, `skills/` and `shared/` — the run-file schema was
not touched, confirmed by `git diff --stat -- server/ skills/ shared/`
returning empty.

One deliberate divergence from the plan text, approved before implementation.
The plan said per-item duration runs from the "earliest `stageAt` arrival
(normally `dispatched`)", but `orchestrate.mjs` stamps `pending` for EVERY
queue item at `init` with the same run-start timestamp — so the literal
earliest key is always `pending`, and every merged row of a serially worked
queue would have reported time-since-the-run-began as its own duration (the
fixture's task-9: 51m instead of the 11m it took). The `pending` queue-wait
stamp is excluded; `preflight` is kept, which is also what gives the two
before-dispatch exits (`needs-answers`, `ungroomed`) a duration at all. Both
the lib suite and the drawer suite pin this case by name. Every authoritative
test case in the plan still passes as written.

Three new suites, 51 cases: `test/run-time.test.ts` (28, the derivations),
`test/run-time-ui.test.tsx` (18, jsdom render), `test/run-stepper-style.test.ts`
(5, stylesheet rules — jsdom performs no layout, so the house idiom of
`run-drawer-tail-style.test.ts` applies). The existing strip and drawer suites
are green with zero edits, as the plan required.

Visual check: the real `RunStrip` and `RunDrawer` rendered against the real
`styles.css` and `theme.css`, from the run fixture re-based onto today's clock
so the run reads as live. Strip showed `56m` elapsed; drawer meta showed
`started 15:51 · 56m elapsed`; rows showed `19m 45s · 16:11` (merged),
`4m 38s elapsed` with `now reviewing · 3s in stage` (active), and an em dash
(pending); task-16's stepper showed the hollow `fixing` dot between filled
neighbours, task-14's the cyan ring on `reviewing`, and the `ungroomed` row no
stepper at all. Not an actual orchestrator run — producing one would mean
committing and merging real work, which this skill does not do — but every
component, stylesheet and derivation in the path was the real one.

```
=== TYPECHECK ===
$ tsc --noEmit
exit=0

=== TESTS ===
Test Suites: 38 passed, 38 total
Tests:       566 passed, 566 total
Snapshots:   0 total
Time:        44.91 s, estimated 50 s
Ran all test suites.

=== BUILD ===
dist/assets/index-zvT6Rf_o.css                                      36.69 kB │ gzip:  7.05 kB
dist/assets/BoardView-0Vt9pOU1.js                                   71.53 kB │ gzip: 21.56 kB
dist/assets/index-BBF2Y-as.js                                      149.36 kB │ gzip: 48.88 kB
✓ built in 2.12s

=== git diff --stat -- server/ skills/ shared/ ===
(empty)
```
