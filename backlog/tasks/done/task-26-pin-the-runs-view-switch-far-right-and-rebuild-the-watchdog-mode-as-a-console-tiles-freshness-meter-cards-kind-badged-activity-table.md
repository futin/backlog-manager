---
id: task-26
title: Pin the Runs view switch far right and rebuild the Watchdog mode as a console: tiles, freshness-meter cards, kind-badged activity table
created: 2026-09-06
updated: 2026-09-06T13:09:46Z
started: 2026-09-06T12:49:40Z
execute-elapsed: 1206
execute-tokens: 204244
---

## Goal

Two presentation changes to the Runs section, no server or wire change. The
`Runs | Watchdog` switch is the first child of a right-anchored tools cluster, so
choosing Watchdog unmounts the range and project controls beside it and the switch
slides right under the pointer by their width; choosing Runs slides it back. And
Runs › Watchdog is three blocks of prose — a state sentence, a config sentence, five-
field rows, a `<ul>` of sentences — that encodes no state in form and never shows
the one fact a person watching a live run wants: how close its heartbeat is to the
15-minute stale line, even though `updatedAt`, `RUN_STALE_MS` and a clock are all on
the client already. The feed prints `detail` and drops `kind`.

Design: `docs/superpowers/specs/2026-09-06-watchdog-console-design.md` (adopted
treatment B of `2026-09-06-watchdog-console-mockup.html` beside it).

## Plan

Execute `docs/superpowers/plans/2026-09-06-watchdog-console.md` task by task. It
specifies behaviour and exact test values, not code, and carries no commit steps —
`backlog-execute` never commits. Read the spec first; the plan's §-numbers refer to it.

1. **Bar** — `RunsView.tsx`: the `runs-mode` group becomes the last child of
   `.board-tools`; a `board-tools-divider` span (test id `runs-tools-divider`)
   renders inside the filters' fragment only. CLAUDE.md's switch sentence follows.
2. **Library** — `freshnessFraction` beside `runIsLive` (`lib/run-time.ts`);
   `sweepFraction`, `graceRemainingMs`, `WATCHDOG_KIND_GLYPH`, `WATCHDOG_KIND_TONE`
   beside `stateLine` (`lib/run-watchdog.ts`). Every one derived against an explicit
   `now`, `null` for unreadable input, never stored.
3. **Monitor head and cards** — three `.runs-tile`s (sweeper with `stateLine`
   verbatim and a depleting `role="meter"` sweep bar; watching count with crashed /
   fresh / not-yet-watched; policy from `config`), then one card per running run with
   a `role="meter"` heartbeat meter against `RUN_STALE_MS`, and on a crashed card the
   attempt pips, `watchdogClause` verbatim, the session id and the grace remaining.
4. **Activity table and bounding** — a five-column `<table>` with glyph+word kind
   badges toned by `WATCHDOG_KIND_TONE`, sticky header, taking the section's remaining
   viewport height inside `.runs-board`. CLAUDE.md's monitor sentence and the
   superseded notes on the 2026-09-05 spec's §2 and §3.
5. **Whole-suite verification** — `pnpm test`, `pnpm run typecheck`, `pnpm run build`;
   the diff touches nothing under `server/`, `shared/` or `hooks/`.

## Test cases

Listed per task in the plan with exact values; the headline ones: `sweepFraction`
with 42s left of a 60s tick → `0.7`; `graceRemainingMs` spawned 2m ago under a 10m
grace → `480_000`; a fresh card 4s old → meter `aria-valuenow="4"`,
`aria-valuemax="900"`, `stale at 15m`; a crashed card 17m old with one spawn 2m ago →
`aria-valuenow="1020"`, verdict `crashed`, `watchdog-clause` equal to
`watchdogClause(annotation, NOW)`, `attempt 1 of 2`, `leave alone 8m more`; the
sweep meter counts `42` → `37` across a 5s fake-clock advance; the mode switch is
the last child of `.board-tools` in both modes and the divider exists only beside
the filters; every `WatchdogEventKind` has a glyph and a tone, pinned by a
`Record<WatchdogEventKind, true>` literal.

## Done when

- `pnpm test`, `pnpm run typecheck` and `pnpm run build` are green in the worktree.
- In runs mode the bar reads range · project · divider · switch, and clicking
  Watchdog leaves the switch exactly where it was, with no divider.
- Runs › Watchdog renders three tiles, one card per running run with a heartbeat
  meter (amber and full on a crashed run, with pips, clause, session and grace), and
  the activity feed as a kind-badged table that scrolls inside the viewport bound.
- `stateLine`, `watchdogClause`, `useWatchdog`, every file under `server/`,
  `shared/` and `hooks/` are byte-identical to `main`.
- CLAUDE.md's Runs entry and the 2026-09-05 spec carry the edits the plan's Task 1
  Step 6 and Task 4 Steps 6–7 spell out.

## Outcome

2026-09-06 — done. The plan's five tasks landed as written, presentation only:
nothing under `server/`, `shared/` or `hooks/` changed, `stateLine`,
`watchdogClause` and `useWatchdog` are byte-identical to `main` (the only
removed line in the whole diff outside test and doc files is one `import type`
in `run-watchdog.ts`).

- **Task 1** — `RunsView.tsx`: the `runs-mode` group is now the last child of
  `.board-tools`, with a `board-tools-divider` span drawn inside the filters'
  own fragment so watchdog mode never shows a rule beside a lone switch.
  Three cases in `runs-view.test.tsx` pin the order in both modes and the
  divider's condition; CLAUDE.md's switch sentence follows.
- **Task 2** — `freshnessFraction` (`lib/run-time.ts`); `sweepFraction`,
  `graceRemainingMs`, `WATCHDOG_KIND_GLYPH`, `WATCHDOG_KIND_TONE`,
  `WatchdogKindTone` (`lib/run-watchdog.ts`). All derived against an explicit
  `now`, `null` for unreadable input, never stored. Seventeen new cases,
  including a `Record<WatchdogEventKind, true>` literal that fails to compile
  the day an eighth kind is added unclassified.
- **Task 3** — the monitor's head is three `.runs-tile`s (sweeper with a
  phase lamp, `stateLine` verbatim and a depleting `role="meter"` sweep bar;
  watching count with crashed / fresh / not-yet-watched; policy as three
  label/value rows), and each running run is a card with a `role="meter"`
  heartbeat meter against `RUN_STALE_MS` — amber and full on a crashed card,
  with attempt pips, `watchdogClause` verbatim, the session id and the grace
  remaining.
- **Task 4** — the activity `<ul>` is a five-column `<table>` with
  glyph+word kind badges toned by `WATCHDOG_KIND_TONE` and a sticky header,
  taking the section's remaining viewport height inside `.runs-board`
  (`.watchdog-monitor` → `.watchdog-activity` → `.watchdog-table-wrap`, the
  chain `.runs-split` already models). The old `max-height: 220px` and every
  `.watchdog-state*`/`.watchdog-row-*`/`.watchdog-events*` rule with no
  element left are gone rather than kept beside the new ones. CLAUDE.md's
  monitor sentence and the two superseded notes on the 2026-09-05 spec
  followed.
- Beyond the plan: one spacing fix found by looking at the running app — the
  watching tile's unit read `0running runs`, since `.runs-tile-value` is a
  plain block rather than the flex row the sweeper tile's value is.

Verified in the real app as well as in jsdom: the Vite container mounts this
working tree, so both modes were driven at 1400×900 and read as specified —
the bar as range · project · divider · switch with the switch pinned to the
same x in both modes, and the console rendering a fresh card (cyan meter,
`heartbeat 4s ago`, `stale at 15m`, `● ok`) beside a crashed one (amber
border and full amber meter, `⚠ crashed`, `· not yet watched`, pips, the
strip's own clause, the session id, `leave alone 7m more`) over a
kind-badged feed.

```
$ pnpm test
Test Suites: 76 passed, 76 total
Tests:       1423 passed, 1423 total
Snapshots:   0 total
Time:        66.742 s

$ pnpm run typecheck
$ tsc --noEmit

$ pnpm run build
dist/assets/RunsView-jWTVozQ2.js       66.44 kB │ gzip:  10.04 kB
dist/assets/index-DFEqQNGo.js         340.00 kB │ gzip: 103.69 kB
✓ built in 1.28s

$ git diff --name-only | grep -E '^(server|shared)/|hooks/'
(no output)
```
