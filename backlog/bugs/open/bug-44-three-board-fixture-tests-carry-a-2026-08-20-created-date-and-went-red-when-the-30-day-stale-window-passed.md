---
id: bug-44
title: Three board fixture tests carry a 2026-08-20 created date and went red when the 30-day stale window passed
created: 2026-09-21
tags: tests, fixtures, board, stale
---

## Symptom

`pnpm test` is red on `main` with nothing changed: `Test Suites: 2 failed, 126 passed`, `Tests: 3 failed, 2108 passed` (2026-09-21, `cb02cc2`). The three
are `board-live-cards.test.tsx` ("gives a needs-answers card its own strip…") and `dispatch-button.test.tsx`'s two "board wiring" cases. Each renders a
fixture item created `2026-08-20` with no `updated`, so `lastTouched` is 2026-08-20 and `leavesBoard` moves it to the Archive once the real clock passes
2026-09-19; the card the case looks for is then not rendered. task-48's outcome noticed them expiring on 2026-09-20 and named them "a date-bomb in the
fixtures, worth its own bug"; nothing was filed. Every orchestrator run on this repo now parks at `verify`.

## Repro

`pnpm run test:jest -- board-live-cards dispatch-button` on any day after 2026-09-19.

## Affects

- `test/board-live-cards.test.tsx` — the needs-answers strip case's fixture.
- `test/dispatch-button.test.tsx` — the two board-wiring cases' fixtures.
- Ten other suites also use `2026-08-20` literals (`item-age`, `item-progress`, `board-column`, `item-modal`, `board-run-chip`, `orchestrator-start-ui`,
  `dialog-escape`, `agents-shared`, …) and are green only because they pass `runs`/`now` explicitly or never render through `leavesBoard`; whichever fix lands
  should say which of those are one refactor away from the same bomb.

## Cause

Fixture `created` dates are absolute while the staleness predicate reads the real clock through the component tree; no test injects `now`.

## Fix

unknown
