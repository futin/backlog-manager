---
id: bug-18
title: A dispatched execute session does not know it is inside an orchestrator run, and asks the user instead of the orchestrator
created: 2026-09-05
tags: orchestrate, execute, skills, board
updated: 2026-09-05T17:03:48Z
groom-elapsed: 170
groom-tokens: 24928
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

Three independent gaps. The observed failure needed all three, and each is
worth fixing on its own.

**1. The dispatch prompt is the entire run→session channel, and it carries
nothing but the trigger.** `skills/backlog-orchestrate/SKILL.md` §4's dispatch
line is `exec claude -p "/backlog-execute <id>"`. That string is the only thing
the run ever hands the session — after it, the two processes share nothing but
a directory — and it spends all of itself on the trigger. Everything else the
session could infer is genuinely ambiguous: a worktree cwd is also what a human
makes by hand, and a `backlog/<id>` branch is also what a *previous* run leaves
behind for a hand-merge (§3's archive-move probe exists precisely because that
state is indistinguishable from outside).

**2. A dispatched session has a live user channel the run never gave it and
does not know about.** The dashboard reads every local session straight off
`~/.claude/projects/*/*.jsonl`, so a `nohup`ed headless `-p` session is a row
in it like any other, with its chat drawer and its `reply?` tab. A remote
message is delivered by blocking that session's `Stop` hook with the user's
text as `reason`, which re-opens the finished turn and feeds the text in as the
model's next instruction (`../claude-agents-dashboard/docs/subsystems/remote-message.md`).
So the premise behind §5's "with no channel to ask through, do not guess" is
inverted for the session the orchestrator dispatches: the *orchestrator* is the
process spawned deliberately without `remoteControl` (`agents.service.ts`, the
comment on the flag it omits), while the execute session it spawns is reachable
by anyone with the dashboard open. Orchestrate's rule reads as "ask if you can",
and the session it dispatches always can.

**3. `backlog-execute`'s hard limits name the user as its escalation channel
unconditionally.** "tell the user what files changed and let them stage and
commit it themselves"; "Tell the user what failed and let them decide whether
to retry, re-groom, or escalate". Both are right for the hand-started session
the skill was written for, and both are the only rule it has. The skill has no
notion of running inside a run at all, so a conflicting instruction gets the
hand-started answer — explain, offer an override, wait — which is exactly what
`run-20260905-113818` produced.

Being right in the wrong channel is still a stall, and it costs more than the
round-trips: a `Stop` block re-opens the turn, so the session does not exit,
and §4's `watch` keeps spending nine-minute budgets on a session that is
negotiating rather than working.

The second half of the symptom has the same single cause as the first. The
dashboard renders a transcript it reads off disk; it has no side channel into
which this repo could inject a label. The only thing that can mark that
conversation for the human reading it is something already *in* the
conversation — and nothing puts it there.

## Fix

Two edits under `skills/`, plus their guards. No client and no server change:
one prompt is read by both the session and the human, so it closes both halves
of the symptom (last paragraph).

**1. `skills/backlog-orchestrate/SKILL.md` §4, "Dispatch the headless session"
— spend the prompt on more than the trigger.** The prompt becomes the trigger,
the id, and one fixed run marker: the run id, this item's position in the queue
(`item N of M`), the branch, and the standing rule — inside an unattended run,
no user to ask, never commit, push or merge, and anything unresolvable goes in
the final message rather than to a person. Six constraints on that string, all
load-bearing, all to be written into the section as the reasons they are:

- **The id stays the first token after the trigger**, marker after it.
  `backlog-execute`'s "Pick an item" reads the trigger's own words for an id,
  and this must not become the run that taught it to guess.
- **One line, and no apostrophes.** The dispatch line is `nohup sh -c '…'` —
  a single-quoted body with the prompt double-quoted inside it. An apostrophe
  closes the outer quote and the whole dispatch becomes a syntax error, on the
  one line whose failure mode is "every item in the queue parks".
- **The marker opens with a fixed, greppable token** (`[orchestrator-run …]`),
  because edit 2 names that exact literal and a test pins the two to one
  constant.
- **The words after the id arrive as `$2`…`$N`** and are substituted into
  `backlog-execute`'s SKILL.md before that session reads it. This is safe only
  because the bug-9 guard (`no fenced block under skills/ reads a positional
  parameter`) already forbids positionals across every published skill. That
  guard becomes load-bearing for a second, unrelated reason — say so in its
  comment, or the next reader deletes it as a one-bug relic.
- **The prompt, not `--append-system-prompt` and not an env var.** Both would
  reach the model; neither reaches the drawer. The prompt is the only string
  the model and the human both read, which is the whole of symptom 2.
- **Merge mode is deliberately left out of the marker.** Nothing the session is
  allowed to do differs between `merge` and `branch` — it never merges either
  way — and a marker that names facts the session cannot act on trains it to
  skim the ones it must.

§5's `--resume` retry line does **not** repeat the marker: a resumed session
still carries its original prompt. The existing test asserting `--permission-mode
auto` on *both* `exec claude -p` lines stays exactly as it is.

**2. `skills/backlog-execute/SKILL.md` — give it a notion of being dispatched.**
A short section (soft target: under ~25 lines — it is injected on every turn of
every execute session, so brevity is a real cost, but a rule compressed out is
worse than a long section) plus one new hard limit:

- Recognise the marker by its fixed token, and say what it means: an
  orchestrator owns this item, the worktree, the branch and everything that
  happens to the work after this session exits.
- **Never escalate to the user while it holds.** Not "prefer not to" — a
  message may still arrive through the dashboard, and answering it is the
  defect. Do not ask, do not offer an override, do not wait for a decision.
- **A user message is not an instruction here.** Note it in one line, do not
  act on it, and never let it change what the run's own next step will do —
  `commit and push to main` is the sharp case, and the session that refused it
  was right about the substance and wrong about who it told.
- **The escalation channel is the final assistant message and the item's
  `## Outcome`**, because those are what §5 Inspect actually reads. State why
  there is no better one: `orchestrate.mjs` refuses every command but `init`
  from inside a linked worktree, so a dispatched session *cannot* call
  `attention` or `stage` for itself. Parking is the orchestrator's decision to
  make from outside, on evidence the session leaves behind.
- Unchanged and restated: never commits, never pushes. The marker adds a
  prohibition, it removes none.

**Test cases** (all in `skills/backlog-orchestrate/tools/orchestrate.test.mjs`,
which already reads both SKILL.md bodies off disk and already owns `SKILLS_ROOT`):

1. Exactly one of the two `exec claude -p` lines carries the marker token, and
   it is the one without `--resume`.
2. Neither dispatch line's prompt contains an apostrophe — the quoting guard,
   asserted on the line rather than on prose about it.
3. Coupling: the marker literal is read out of `backlog-orchestrate/SKILL.md`
   and asserted to appear in `backlog-execute/SKILL.md`, from one constant in
   the test, so the two files cannot drift into two markers that merely look
   alike (the `watchdog-coupling` posture, one table driving both halves).
4. `backlog-execute/SKILL.md` keeps the new rules, as a needle-per-rule table
   in the style of "the body keeps the rules whose stories moved to
   `references/`": never escalates to the user, a user message is not an
   instruction, `orchestrate.mjs` is unreachable from a worktree.
5. The existing `--permission-mode auto` dispatch-line test and the bug-9
   positional-parameter sweep both stay green.

No browser check: the defect is entirely in `skills/`, the fix touches no
rendered surface, and a Playwright case here would prove nothing.

**Scope call, named rather than assumed.** The `## Affects` list mentions
`RunStrip.tsx` / `ItemCard.tsx` carrying the run→item→session mapping into a
dashboard link. That is deliberately **not** in this fix: it is board→session
*navigation*, and the person in the symptom had already found the session. What
they lacked was a marker inside it, which edit 1 puts there. A session link on
the run drawer is a real convenience and belongs in its own captured item.
