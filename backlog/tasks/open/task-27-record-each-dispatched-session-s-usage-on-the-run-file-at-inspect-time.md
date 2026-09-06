---
id: task-27
title: Record each dispatched session's usage on the run file at inspect time
created: 2026-09-06
tags: skills, orchestrate, server, client, stats
---

## Goal

Every headless session the orchestrator dispatches ends its `logs/<id>[-fix-n].jsonl`
with a `result` event that already carries `total_cost_usd`, `num_turns`, the four token
counts (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`), `duration_ms` and the model. Nothing copies them into
`run.json`, so "what did this run cost" is answerable only by parsing the log directory
(43MB for this project alone; the 2026-09-06 cross-run sweep needed a script and a
fitted-rate workaround), and the Runs view cannot print a dollar. Stamp the numbers onto
the queue item when the driver inspects the session, through the run file's one writer,
and show them where the run is shown.

## Plan

1. `orchestrate.mjs` gains one subcommand, `usage <id> --jsonl <file>`, run from the
   project root like every other mutating command and subject to the same driver-lease
   check (exit `7` on a foreign fresh lease). It reads the file, finds the last
   `type: "result"` event, and appends one entry to `queue[i].usage` (a new optional
   array on `RunQueueItem`, `shared/types.ts`):
   `{ sessionId, kind, loop, costUsd, turns, inputTokens, outputTokens, cacheReadTokens,
   cacheCreationTokens, durationMs, model, endedAt }`. `kind` is `execute` for
   `<id>.jsonl`, `retry` for `<id>-retry-<n>.jsonl`, `fix` for `<id>-fix-<n>.jsonl`, with
   `loop` = `<n>` for the last two and absent otherwise — derived from the file name the
   caller passed, never guessed from content. `endedAt` is the write's own clock reading.
   `model` is the key of `modelUsage` when there is exactly one, else the joined keys.
2. The write is idempotent by `sessionId`: a second call over the same file replaces
   that entry instead of appending a duplicate. An append never touches other entries,
   so a fix loop's entry sits beside the first session's rather than overwriting it.
3. A file with no `result` event (a killed session) writes nothing, prints one stderr
   line saying so, and exits `0` — absence of a `usage` entry is the honest record, and a
   zero would claim the session was free. A missing or unreadable file exits `1`. A
   malformed line before the result event is skipped, not fatal.
4. `SKILL.md` §5 "Inspect" adds the call on the same Bash invocation as
   `stage <id> inspecting`, once for the main session and once per retry or fix-loop
   transcript when §7 loops, so it costs no extra driver turn. `references/recovery.md`
   notes that a resumed driver re-runs it for any transcript whose entry is absent.
5. `client/src/lib/run-stats.ts` gains `runUsageTotals(run)` (sum of `costUsd` and
   `turns` across every item's entries, `null` when no item carries any) and
   `itemUsageTotals(item)`. `RunsView`'s detail pane prints cost and turns beside each
   item's `StageTrack` durations and a run total in the pane's head; the run list row
   shows the run total. Absent usage renders as nothing, never as `$0.00`. The archive
   endpoints need no change: they serve the run file verbatim and this is one more field.

## Test cases

`skills/backlog-orchestrate/tools/orchestrate.test.mjs`:

- result event present → `usage` has one entry with exactly the twelve fields above;
  `costUsd` equals the event's `total_cost_usd`; exit `0`; the entry is echoed as JSON.
- `<id>-fix-1.jsonl` after `<id>.jsonl` → two entries, kinds `execute` then `fix` with
  `loop: 1`, first entry byte-identical to before.
- same file twice → still one entry for that `sessionId`.
- jsonl without a `result` event → no `usage` key added, exit `0`, stderr names the file.
- unreadable path → exit `1`, run file byte-identical.
- a malformed line before the result → tolerated, entry written.
- foreign fresh lease → exit `7`, run file byte-identical (same table the other mutating
  commands use).

`test/run-stats.test.ts`: totals across two items with three entries; a run with no
usage anywhere → `null`; an item with usage beside one without → item totals `null`
only for the second. `test/runs-view.test.tsx`: cost rendered per item and per run;
nothing rendered for a run without usage.

## Done when

- A run started from the board after this lands shows `usage` on every dispatched item
  in its `run.json`, including a fix loop's second entry.
- The Runs view shows a dollar per item and per run for that run, and nothing for runs
  archived before it.
- `pnpm test` and `pnpm run test:skills` green; SKILL.md §5 and `recovery.md` carry the
  call; the run file still has exactly one writer.
