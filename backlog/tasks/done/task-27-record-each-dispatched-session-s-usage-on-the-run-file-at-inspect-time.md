---
id: task-27
title: Record each dispatched session's usage on the run file at inspect time
created: 2026-09-06
tags: skills, orchestrate, server, client, stats
updated: 2026-09-07T04:21:40Z
started: 2026-09-07T03:59:52Z
execute-elapsed: 1308
execute-tokens: 198790
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

## Outcome

2026-09-07. Done, with one deliberate deviation from step 2 of the plan.

**What landed.** `orchestrate.mjs usage <id> --jsonl <file>` (new subcommand,
driver-lease-checked like every other mutating command, exit `7` on a foreign
fresh lease) copies the last `result` event's cost, turns, four token counts,
duration and model onto `RunQueueItem.usage` — a new optional array on the
queue item, `shared/types.ts`. `SKILL.md` §5 runs it on the same Bash
invocation as `stage <id> inspecting`; §7's fix loop runs it beside its own
`denials` check; `references/recovery.md` has a resumed driver pick up any
transcript whose entry is absent. `client/src/lib/run-stats.ts` gained
`runUsageTotals`/`itemUsageTotals`/`formatUsd`/`formatTurns`; the Runs list
row prints the run total on its foot line, the detail pane's head prints
cost · turns · sessions, and each item prints its own line under its
`StageTrack`. Server untouched — both archive endpoints already spread the
queue item through, so this rides along as one more field.

**Deviation: identity is the transcript slot, not `sessionId`.** Step 2 asked
for idempotency keyed on `sessionId`. That cannot work: `claude -p --resume`
keeps the session id it was handed, so an item's `<id>.jsonl` and its
`<id>-fix-1.jsonl` report the SAME session — verified against this machine's
real logs before deciding:

```
task-22:        result sid dc408929-82f2-43a3-9def-6ec2a45e7417  $2.641441  34 turns
task-22-fix-1:  result sid dc408929-82f2-43a3-9def-6ec2a45e7417  $1.612241  11 turns
```

Keying on that would have made the fix loop's entry overwrite the execute
session's, which is exactly what the plan's next sentence forbids. Identity is
`kind` + `loop`, both derived from the file name the caller passed (the plan
already made the file name authoritative for those two, and the content
genuinely cannot tell the three shapes apart). Both of the plan's test cases
hold under this rule; the same-file-twice case is now stated as "one entry for
that slot". A name matching none of the three shapes exits `1` rather than
defaulting to `execute`, because the realistic way to get one is handing the
command another item's transcript.

Two smaller judgements, both documented at the code: every numeric field is
nullable (a renamed field leaves a hole, never a `0` that would price the
session), and `usage` is passed through undefaulted from run file to view, so
a run archived before this lands renders nothing rather than `$0.00`.

**Smoke-tested against real transcripts**, not only fixtures — a throwaway
`BM_ORCH_HOME`, a seeded item, and this project's own 457K `task-22` logs:

```
{"id":"task-22","usage":{"sessionId":"dc408929-...","costUsd":2.641441,"turns":34,"inputTokens":68,"outputTokens":17511,"cacheReadTokens":2678972,"cacheCreationTokens":86384,"durationMs":1287496,"model":"claude-opus-5[1m]","kind":"execute","endedAt":"2026-09-07T04:16:11.195Z"}}
{"id":"task-22","usage":{"sessionId":"dc408929-...","costUsd":1.6122409999999998,"turns":11,"inputTokens":22,"outputTokens":4248,"cacheReadTokens":1051122,"cacheCreationTokens":98037,"durationMs":78657,"model":"claude-opus-5[1m]","kind":"fix","endedAt":"2026-09-07T04:16:11.264Z","loop":1}}
```

Both entries side by side, same session id — the shape that proves the
identity decision. 40ms on that file.

**Verification.** `pnpm test` (both runners), `pnpm run typecheck` and
`pnpm run build`:

```
# pass 431
# fail 0
...
PASS  jest
PASS  node --test (skills)

pnpm test: both runners passed.
=== typecheck ===
$ tsc --noEmit
=== build ===
dist/assets/RunsView-BOO0ZuYZ.js       75.52 kB | gzip:  10.82 kB
dist/assets/index-DS96jWrY.js         340.55 kB | gzip: 103.75 kB
[BUILT] built in 1.62s
```

New tests: 14 cases in `orchestrate.test.mjs` (the seven the plan names, plus
retry-kind, two-model/session-id-fallback, a bad file name, a missing `--jsonl`,
last-result-wins and the all-holes shape) and two structural ones pinning the
`usage` call in SKILL.md §5/§7 and in `recovery.md` — the same shape as the
existing denials-gate structural test, for the same reason. 12 in
`test/run-stats.test.ts`, 4 in `test/runs-view.test.tsx`. Six new transcript
fixtures under `skills/backlog-orchestrate/tools/fixtures/`.

**Not done, deliberately out of the plan's scope:** the board's own
`RunDrawer` prints no cost (the plan names the Runs view's row and pane only),
and there is no aggregate cost tile over a range — `aggregateRuns` is
untouched.

Nothing committed, pushed or merged. Files changed: `shared/types.ts`,
`skills/backlog-orchestrate/tools/orchestrate.mjs`,
`skills/backlog-orchestrate/tools/orchestrate.test.mjs`, six new files under
`skills/backlog-orchestrate/tools/fixtures/`,
`skills/backlog-orchestrate/SKILL.md`,
`skills/backlog-orchestrate/references/recovery.md`,
`client/src/lib/run-stats.ts`, `client/src/components/runs/RunsView.tsx`,
`client/src/components/runs/RunDetail.tsx`, `test/run-stats.test.ts`,
`test/runs-view.test.tsx`, `CLAUDE.md`, and this item file.
