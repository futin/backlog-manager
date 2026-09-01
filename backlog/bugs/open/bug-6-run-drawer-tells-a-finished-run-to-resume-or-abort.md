---
id: bug-6
title: Run drawer tells a finished run to resume or abort
created: 2026-09-01
tags: client, orchestrator
---

## Symptom

Every run that has finished — `done`, `aborted` or `failed` — renders the stale-heartbeat
banner at the top of the run drawer, above the pipeline chips and the queue:

```
no heartbeat for 0 minutes — resume or abort from the terminal
```

Observed on run-20260901-073202 seconds after `finish --status done`, with the drawer's
own header one line above reading `done · 1 past run`. Both statements are on screen at
once, and they contradict each other.

The advice is not merely redundant, it is wrong twice over. There is nothing to resume:
`orchestrate.mjs --resume` reconciles a run whose status is `running`. There is nothing
to abort either, and `abort` on a finished run is not the no-op the wording implies. And
the "0 minutes" reads as a fault detected instantly rather than what it is — a run that
stopped heartbeating because it ended on purpose.

## Repro

1. Run an orchestration to completion, or `finish --status done` on any run.
2. Open that run in the drawer from the run strip.
3. The banner is the first thing in the drawer, on a run the header says is `done`.

Any finished run reproduces it — `pastRuns` entries included, since those are finished by
definition.

## Affects

- client/src/components/board/RunDrawer.tsx:68 — `staleNote`, whose whole gate is
  `if (run.fresh) return null`.
- client/src/components/board/RunDrawer.tsx:131,161 — the call site and the render, which
  put the note first deliberately (see the function's own comment on why a stale
  heartbeat outranks everything else on the screen — that reasoning is sound and is not
  what is wrong here).
- server/src/orchestrator/orchestrator.service.ts:110 — `fresh` is
  `status === 'running' && Date.now() - Date.parse(updatedAt) < RUN_STALE_MS`. Correct as
  written; the client is the side reading too much into it.
- test/orchestrator-drawer.test.tsx:217 — the existing "shows the note for a stale run,
  hides it for a fresh one" case. It passes `fresh: false` over a fixture whose `status`
  is `running`, so it stays valid and green through the fix; the missing case is the
  finished one.

## Cause

`fresh` is false for two unrelated reasons and the drawer treats them as one.

The server folds a status check and a recency check into a single boolean: a run is fresh
only if it is `running` *and* its heartbeat is recent. So `fresh === false` means either
"a live run has gone silent" — the fault the banner exists to report — or "this run
ended", which is not a fault at all and is the normal end state of every run ever
started. `staleNote` branches on that one boolean and so cannot tell the two apart.

Nothing else on this screen makes the same mistake: the header prints `run.status`
directly, which is why the contradiction is visible in the first place.

## Fix

Gate the note on the run still claiming to be live, not merely on `fresh`:

```tsx
if (run.fresh || run.status !== 'running') return null;
```

`run.status` is already on the payload (`OrchestratorRun`, shared/types.ts:421) and the
header renders it two lines away, so nothing new has to be plumbed. A `running` run whose
heartbeat has genuinely gone quiet still gets the banner, unchanged — that is the one
case it was written for.

The function's doc comment should say why the second clause is there, since "not fresh"
reading as "stale" is exactly the trap this bug is.

Test cases, in test/orchestrator-drawer.test.tsx alongside the case at line 217:

- a `status: 'done'`, `fresh: false` run renders no `/no heartbeat/` text — the
  regression this fixes;
- the same for `aborted` and `failed`, since all three are finished and none of them can
  be resumed;
- the existing stale case (`status: 'running'`, `fresh: false`, an old `updatedAt`) still
  shows the banner with its minute count — proof the fix narrowed the gate rather than
  removing it.
