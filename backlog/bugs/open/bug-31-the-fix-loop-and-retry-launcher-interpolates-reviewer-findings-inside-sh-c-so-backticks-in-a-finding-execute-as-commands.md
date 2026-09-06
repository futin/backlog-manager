---
id: bug-31
title: The fix-loop and retry launcher interpolates reviewer findings inside sh -c, so backticks in a finding execute as commands
created: 2026-09-06
tags: skills, orchestrate, security
---

## Symptom

A fix-loop session (`<dir>/logs/<id>-fix-<n>.jsonl`) or a retry session starts with a
prompt from which every backtick-quoted identifier has been removed, and its `.err`
file shows the shell trying to run those identifiers as commands:

```
sh: rowId: command not found
sh: command substitution: line 1: syntax error: unexpected end of file
sh: Infinity: command not found
sh: DELETE: command not found
sh: docs/subsystems/api-reference.md:57: No such file or directory
```

Seen in 3 of the 26 fix sessions on this machine: backlog-manager `bug-15-fix-1.err`,
claude-agents-dashboard `bug-4-fix-1.err`, ixray `bug-14-fix-1.err`. All three sessions
recovered because the executor read `reviews/<id>-1.md` itself, so no item was merged on
a mangled prompt — but the prompt the driver meant to send never arrived intact, and
what did run was chosen by the reviewer's prose.

## Repro

1. Have a reviewer report whose Important finding quotes an identifier in backticks,
   e.g. `` `rowId` `` (any review of code does).
2. Follow SKILL.md §7 `verdict: fix`: "resume the item's own executor session with the
   findings pasted in — step 5's retry line unchanged". Step 5's line (SKILL.md ~931) is
   `nohup sh -c 'cd … && BM_ORCH_RUN=<runId> exec claude -p --resume <sessionId> "<what to do differently>" …'`.
3. The findings land inside the double quotes inside the single-quoted `sh -c` script,
   where `sh` performs command substitution: every `` `x` `` and `$(x)` is executed and
   replaced by its output. `.err` fills with `command not found`; the session's first
   user message has the identifiers blanked.

The dashboard project's driver worked around it unprompted by writing the findings to
`<dir>/prompts/<id>-fix-<n>.txt` first (9 files exist there, none in the other three
projects, and SKILL.md never names a `prompts/` directory) — every one of those sessions
has an empty `.err`. The backlog-manager and ixray drivers pasted inline, as the skill
says to.

## Affects

- `skills/backlog-orchestrate/SKILL.md` §4 "Dispatch the headless session" retry line (~931): `"<what to do differently>"` inside `sh -c '…'`
- `skills/backlog-orchestrate/SKILL.md` §7 "Review", the `verdict: fix` branch (~1002–1016): "Paste the findings as the reviewer wrote them"
- `skills/backlog-orchestrate/references/recovery.md` wherever a resume re-uses the same line

Reviewer text is derived from repository content (file names, comments, test names), so
a repository can steer what the driver's shell executes. Low likelihood today; zero cost
to close.

## Cause

unknown

## Fix

unknown
