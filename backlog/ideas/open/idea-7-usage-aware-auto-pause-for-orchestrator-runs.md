---
id: idea-7
title: Usage-aware auto-pause for orchestrator runs
created: 2026-09-05
---

## Problem

An orchestrator run spends the account's rolling usage window (the 5-hour
and weekly limits `/usage` shows) across several execute sessions, reviews
and merges. When the window runs out mid-run the expected shape is a crash
cascade: the execute child dies with an API error, the item parks or fails,
the orchestrator's own calls fail and its process exits, `run.json` freezes
at `running`, and the watchdog spawns `--resume` sessions into the same
exhausted window until its cap is hit. The pause designed in
`docs/superpowers/specs/2026-09-05-orchestrator-pause-design.md` lets a
person stop the run before the next dispatch — but only if they are
watching. The run should stop itself when the headroom is gone.

## Rough shape

A server-only trigger over the pause primitive, no tool or skill change:
the pause request is a file the server writes
(`server/src/orchestrator/pause-control.util.ts`, once the pause task
lands), so a sweeper — `watchdog.service.ts` is the template: armed only
while a run is `running`, one tick at a time — reads the account's current
utilization, compares it to a configurable floor, and writes the request
for every running run when headroom is below it. The strip then reads
"pausing", the run finishes `paused` at its next boundary, and a person
resumes it once the window has reset.

Usage source: `../claude-agents-dashboard` already fetches the 5-hour and
weekly utilization live — `server/lib/usage.ts`, over the CLI's OAuth token
read from the Keychain, cached, exposed in its API payload (`data.usage`,
`data.usageStatus`) — and keeps a history at its repo root
(`.usage-history.jsonl`, `.usage-profile.json`, `usage-history.ts`). This
server already talks to the dashboard for `status`/`spawn`, so the natural
read is one more dashboard call over `BM_AGENTS_URL`, never the Keychain
from this process. The dashboard's own header on that file warns the
endpoint is private and may change between CLI versions; every failure must
fail open — no usage answer means no auto-pause, never a spurious one.

Two extensions worth designing together, both cheap once the trigger exists:
a reactive pause when an execute child dies with a usage-limit error (the
orchestrator inspects the child's exit anyway in SKILL.md §5), so the run
pauses instead of failing and burning watchdog attempts; and an auto-resume
at the window's `resets_at`, which the watchdog could spawn since it already
owns the resume path.

## Open questions

- Where the floor lives: a `settings/` file the server owns (like
  `watchdog.json`, editable in Settings mid-run) or a per-run flag on the
  launch sheet riding the spawn prompt like `--merge-mode`.
- Whether to read utilization through the dashboard's API or its history
  files, and what to do when the dashboard is unreachable (fail open is the
  default; is a "usage unknown" note on the strip wanted).
- Which window drives the decision — the 5-hour bar, the weekly bar, or the
  lower headroom of the two — and whether the floor is a percentage or an
  estimated number of items.
- Auto-resume at `resets_at`: a watchdog job, or left to the person.
