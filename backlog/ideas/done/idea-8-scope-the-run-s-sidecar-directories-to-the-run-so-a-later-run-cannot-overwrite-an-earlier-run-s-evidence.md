---
id: idea-8
title: Scope the run's sidecar directories to the run, so a later run cannot overwrite an earlier run's evidence
created: 2026-09-06
tags: skills, orchestrate, stats
updated: 2026-09-07T05:26:59Z
promoted-to: task-31
groom-elapsed: 206
groom-tokens: 34247
---

## Problem

Under `~/.backlog-manager/orchestrator/<project>/`, the run file is the only thing that
is archived per run: `cmdInit` moves the previous `run.json` to `runs/<runId>.json` and
writes a new one. Everything else the run produced stays keyed by item id in flat,
shared directories — `logs/<id>.jsonl` and `<id>-fix-<n>.jsonl`, `reviews/<id>-<n>.md`,
`verify/<id>.{out,status,pid,branch-paths,dirty-paths}`, `questions/<id>.json`, and the
`prompts/<id>-fix-<n>.txt` one driver invented. An item dispatched again in a later run
overwrites the transcript, the review and the verify output of its first attempt with no
warning.

It has already happened: bug-2 in this repo was dispatched in three runs
(`run-20260901-111359`, `-112035`, `-112815`) and task-9 in claude-agents-dashboard in
two; only the last log of each survives. The 2026-09-06 sweep had to join costs by item
id and note the loss. Once task-27 stamps usage onto the run file the *numbers* survive,
but the evidence behind a verdict — what the reviewer wrote, what verify printed — does
not, and `references/recovery.md`'s promise that `--resume` "starts from what is on
disk" is weaker than it reads when the disk holds another run's files under the same
names.

## Rough shape

- At `cmdInit`, when the superseded `run.json` is archived to `runs/<runId>.json`, move
  that run's sidecar directories with it, into `runs/<runId>/` (`logs/`, `reviews/`,
  `verify/`, `questions/`, and `prompts/` if present). A live run keeps writing to the
  flat paths SKILL.md already names, so no prose changes for the current run.
- `GET /api/orchestrator/archive/run` already serves one archived run file verbatim; a
  sibling read-only endpoint could serve a named sidecar file behind the same runId regex
  and directory-listing allowlist, so the Runs view can show a review report next to a
  verdict. Optional; the move alone fixes the loss.
- `SKILL.md` §7 should name the `prompts/<id>-fix-<n>.txt` file as the way findings reach
  a fix session (bug-31 is the reason); this idea then archives it with the rest.

## Open questions

- The archived `run.json` and its `attention` details record absolute sidecar paths
  (`reviews/bug-10-1.md`, worktree paths). Do those get rewritten on archive, or does the
  reader resolve them relative to `runs/<runId>/`? Rewriting touches a file whose only
  writer is `orchestrate.mjs` — allowed, since init is that writer — but every consumer
  of those strings needs a look first.
- `--resume` of a crashed run happens before any `init`, so nothing is moved under it;
  but a `--resume` that arrives *after* a new run was started for the same project would
  find its files moved. `init` refuses while a `running` run exists, which should make
  that unreachable — confirm it, and pin it.
- `verify/<id>.pid` and `logs/<id>.pid` for a live child: moving a pid file of a
  process that is still running is only safe because `init` refuses a running run.
  Same confirmation.
