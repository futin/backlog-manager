---
id: bug-18
title: A dispatched execute session does not know it is inside an orchestrator run, and asks the user instead of the orchestrator
created: 2026-09-05
tags: orchestrate, execute, skills, board
---

## Symptom

An execute session dispatched by `backlog-orchestrate` has nothing in its
context saying so. Its prompt is the plain `/backlog-execute <id>` trigger, its
cwd is a worktree, and both read exactly like a session a human started by
hand. Two things follow, and both were observed in one run:

1. **The session treats the user as its escalation channel.** During
   `run-20260905-113818` (bug-16), the user messaged the session from the
   dashboard with "commit and push to main". The session correctly declined —
   the run's own §6 commit would then find nothing staged, exit `1`, and park
   the item, stalling `task-13`/`task-14`/`task-15` behind it — but it declined
   *by explaining and offering an override to the user*, which is the wrong
   channel. Anything a dispatched session cannot resolve belongs to the
   orchestrator (`attention <id> --kind parked`, `stage <id> parked`), which is
   already what the orchestrate SKILL.md prescribes for a session with "no
   channel to ask through". The rule is stated only for the case where no
   channel exists; a session that *has* one uses it.
2. **The user cannot tell either.** The board shows a run strip and a card's
   run bar, but the dashboard conversation with a dispatched session carries no
   marker at all, so the person answering it has no cue that a run owns this
   work. In the user's own words: "I keep forgetting that this is part of
   orchestration."

The cost is not hypothetical: the queue sat idle across three message
round-trips while a human and a headless session negotiated something the run
was already going to do by itself.

## Repro

1. Start an orchestrator run from the board over a project with a queued item.
2. Once the item reaches stage `dispatched`, open that session in the
   claude-agents-dashboard.
3. Nothing in the session's prompt, transcript header or dashboard row says it
   belongs to `run-<id>`, or that its item is one of N in a queue.
4. Send it any instruction that conflicts with the run's own next step
   (`commit and push to main` is the sharp case). It answers the user.

## Affects

- `skills/backlog-orchestrate/SKILL.md` §5 — the dispatch prompt is the plain
  trigger; it is the one place a run could tell the session what it is
- `skills/backlog-orchestrate/SKILL.md` §5's parked/attention lines — the "no
  channel to ask through" rule that should be unconditional for a dispatched
  session, not conditional on the channel's absence
- `skills/backlog-execute/SKILL.md` — has no notion of running inside a run at
  all; its hard limits say "never commits, never pushes" but not "never
  escalates to the user"
- `client/src/components/board/RunStrip.tsx` / `ItemCard.tsx` — where the board
  already knows the run→item→session mapping, and the dashboard link does not
  carry it

## Cause

unknown

## Fix

unknown
