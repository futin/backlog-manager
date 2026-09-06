---
id: bug-28
title: The per-item execute session is the one session this system spawns without a name, so its dashboard row reads as hand-started
created: 2026-09-06
tags: orchestrator, dashboard
---

## Symptom

Open the dashboard during a run and you cannot tell which session is the orchestrator's
per-item `backlog-execute` — the one actually doing the work. Its row carries the bare
project name, exactly like a session someone started in a terminal. The only way to
identify it is to open the transcript, where the first message gives it away instantly.

Every *other* session this system spawns is named:

| session | name | set by |
|---|---|---|
| orchestrator run | `orchestrate <project>` | `orchestrateSessionName`, `agents.service.ts:1175` |
| hand dispatch | `bl <project> <id>` | `sessionName`, `prompt.util.ts:158` |
| board resume | `resume <project>` | `resumeSessionName`, `agents.service.ts:1208` |
| watchdog resume | `watchdog resume <project>` | same |
| **per-item execute** | **none** | — |

## Repro

Start a run from the board. Once an item reaches `dispatched`, open the dashboard session
list. The execute session appears under the worktree's own project row with no distinguishing
label. Observed on `run-20260906-115323`, item task-25, session
`1171248d-cad1-403d-bf52-5193f5df8792`.

## Affects

- `skills/backlog-orchestrate/SKILL.md:704` — the dispatch spawn line.
- `skills/backlog-orchestrate/SKILL.md:887` — the retry (`--resume`) spawn line.
- Nothing in `server/` or `client/`; this is entirely a skill-side omission.

## Cause

The three named spawns all go through this app's server, which composes a name and sends it
to the dashboard's `POST /api/spawn`; `parseSpawnRequest` validates it and
`spawn.ts:223` pushes `-n <name>` onto the CLI argv.

The per-item execute session does not take that route at all. It is spawned by the running
orchestrator session itself, as a raw `nohup sh -c '… exec claude -p …'` line written into
SKILL.md, and that line passes no `-n`. So the session has no name, and the dashboard falls
back to the project name — the identical end state `sessionName`'s own doc comment describes
for a name the dashboard *drops*, arrived at by omission instead of by an invalid charset.

Not a dashboard bug: it renders what it was given. Not a naming-helper bug either — the
seam simply has no helper, because it is the one spawn seam that never touches this repo's
server code.

Two things that DO distinguish it exist and are not enough:

- `cd "$PWD/.worktrees/<id>"` puts the session in the worktree, so the dashboard files it
  under a distinct project row (`…backlog-manager--worktrees-task-25`). Reliable — only the
  orchestrator makes worktrees — but it is an inference from a directory name, and it does
  not name the RUN or the item.
- `BM_ORCH_RUN=<runId>` is set on the spawn (bug-20). The dashboard surfaces no environment,
  so this is invisible in the UI.

## Fix

Add `-n` to both spawn lines in `skills/backlog-orchestrate/SKILL.md`. Nothing else changes:
no server, no client, no tool, no run-file field.

Constraints the name must satisfy, all of them already documented on the dashboard side and
worth restating here because a violation is SILENT — `parseSpawnRequest` drops an invalid
name to `undefined` and the row falls back to the project name, with no failed request
anywhere to notice:

- charset `NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/` (`../claude-agents-dashboard/server/lib/spawn.ts`).
  No `:`, no `/`, no middle dot. Space is the separator, exactly as the three existing
  helpers concluded.
- `NAME_CAP` 60 characters, sliced not rejected.

Suggested spellings, deliberately parallel to the existing three rather than novel:

- dispatch: `orch <id>` — e.g. `orch task-25`.
- retry: `orch <id> retry <n>` — e.g. `orch task-25 retry 1`.

Include the item id, not just the project: the worktree row already carries the project, and
the id is the thing a reader is looking for. Whether the runId is worth including is the one
open judgement — it is long, it eats the 60-char cap, and `run.json` already maps session id
to run; decide it in the outcome rather than by default.

Note for the retry line: it spawns with `--resume <sessionId>`, and `-n` on a resume
renames the existing entry (`spawn.ts:188`). That is the desired behaviour — the row should
read as the retry it now is — but it means the two lines are not independent and the retry
name must stay recognisable as the same item.

Skills-only change: inert until committed, pushed, and `pnpm run plugin:sync` has run.
A run already in flight keeps the SKILL.md its install had.

## Test cases

- `skills/*/tools/*.test.mjs` are node-runner tests over the tools, and this change is in
  SKILL.md prose, so the pinning has to be a text assertion: both spawn lines carry `-n`,
  and the name each composes matches a copy of `NAME_RE` and is ≤ 60 chars. Copy the regex
  rather than importing across repos — `test/agents-prompt.test.ts` already sets that
  precedent and states the reason.
- A long project name plus a long id stays under the cap (slice, not overflow).
- The retry name differs from the dispatch name for the same item, and both remain valid.
- Manual, once: run the orchestrator on a mock item and confirm the dashboard row reads
  `orch <id>` rather than the bare project name. This is the only check that proves the
  flag actually reached the CLI, which is exactly the failure mode this bug is about.

## Done when

```
pnpm test
```

```
pnpm run test:skills
```

- A real run's dashboard row has been seen carrying the name, with the runId decision
  recorded in the outcome.
