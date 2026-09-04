---
name: backlog-execute
description: >
  Do the actual work on a groomed bug or task — debug and fix, or build out a planned
  task — then archive it once verification proves it worked. Refuses anything ungroomed: a
  task with no real plan, or a bug whose fix is still unknown. Use it to execute task 12,
  fix bug 7, work the backlog, or do the next thing. Never touches ideas or already-rejected
  items, and never commits or pushes on its own. Trigger: /backlog-execute
trigger: /backlog-execute
---

# /backlog-execute — do the groomed work

Execute does the actual work a groomed bug or task describes, then archives it once
verification proves it worked. It only ever works `bugs/` and `tasks/` — never `ideas/` or
`refactors/` (neither has anything to execute: what each is waiting for is to be *promoted*
into a task, which is `backlog-groom`'s job) and never `out-of-scope/` (already closed). It never
files anything new (`backlog-capture`) and never writes a plan (`backlog-groom`) — if the
plan isn't there yet, it refuses and says so.

## Pick an item

If the trigger already named an id ("fix bug 7", "execute task 12"), use it. Otherwise
find the next thing to work:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" board --section bugs
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" board --section tasks
```

Never `--section ideas` or `--section refactors` — neither has a plan to execute; that's
what promoting one via `backlog-groom` is for. "Do the next thing" means the oldest open bug or task whose plan
actually reads as real once you check it against the refusal gate below — not just the
first one listed.

This skill never runs `init`. If a command exits `3`, there's no `backlog/` store yet —
send the user to `backlog-capture`. If it exits `2`, you're not inside a git repository.

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" show <id>
```

prints the item's absolute path on line 1, then its frontmatter — **never the body**.
Read the file at that path yourself to see the actual headings; there's no tool command
that prints the body, and none is needed.

**That command is the only way to locate an item file, and an exit `1` from it is a stop
condition, not a lookup problem.** `show` resolves the store by walking up from this
session's own cwd to the nearest `.git`, so what it answers is "does *this tree* have this
item" — and a worktree is a tree of its own. If it exits `1`, say the item is not in this
tree and stop. Never `grep`, `find` or glob for the file; never work an absolute path
belonging to another tree, even when one plainly exists and plainly holds the item you
were asked for.

That last sentence is not hypothetical. An orchestrator run created a worktree from
`main`'s commit, dispatched a session for an item that had been groomed but never
committed, and the item was simply absent from that worktree. `show` exited `1`, the
session searched, found the only copy that existed — the main tree's — appended
`## Outcome` to it and moved it to `done/` there. The code changes landed correctly on the
branch; the item's whole lifecycle landed in a tree the branch would never carry, as a
loose uncommitted change with no commit of its own, and every stage of the run reported
success. Refusing takes one sentence and loses nothing: the item is still there, still
open, and whoever committed it can re-run.

If that path resolves under `ideas/`, `refactors/` or `out-of-scope/`, stop — wrong skill
for this id (see Hard limits below). If it's already under a `done/` directory, there's nothing left
to execute — say so instead of proceeding.

## The refusal gate

This is the load-bearing rule of the whole system: **refuse any item whose plan isn't real
yet, and name the groom command to run instead.** Without it, `tasks/` and `ideas/` are one
directory with two names — anyone could drop a title-only stub in `tasks/` and call it
ready. Don't soften this for a task that "looks obvious" or a bug where the fix "seems
clear from the symptom" — if it isn't written down, it wasn't groomed, and this skill does
not touch it. This is enforced by nothing but this rule: the tool itself has no notion of
`## Plan` or `## Fix` content, and will move an entirely ungroomed item to `done` without
complaint if asked to. This skill is the only thing standing between an empty plan and a
false "done."

After reading the file at the path `show` printed:

This gate has a shape worth stating outright: it lists the two sections this skill works,
and **an id from any other section never reaches it at all** — the directory check in Pick
an item above turns those away first. That ordering is load-bearing, not incidental. A
`ref-N` reaching this gate would match neither bullet below and so pass through ungated,
because "no rule applied" reads the same as "the rule was satisfied" — which is exactly
how an unplanned item gets a whole execute session spent on it. The section check is what
makes the gate total.

- **Task:** look at `## Plan`. Refuse if the heading is missing entirely, if there is
  nothing under it before the next `##` heading (or the end of the file), or if all that's
  there is a placeholder like `unknown`. Tell the user: run `/backlog-groom` on `<id>`
  first.
- **Bug:** look at `## Fix`. Refuse if its content is still exactly `unknown` — the
  placeholder `backlog-capture` writes for a bug nobody has diagnosed yet. Tell the user:
  run `/backlog-groom` on `<id>` first.

`## Cause` isn't part of this gate on its own — but `superpowers:systematic-debugging`
re-confirms it live before any change is made anyway (see Dispatch below), so an
unreliable cause doesn't slip through even though the gate itself doesn't inspect it.

## Mark it in progress

The gate passed, so this item is about to be worked. Say so on disk, before any of the
work starts:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" start <id> --as execute
```

That writes a `started: <UTC timestamp>` line and a `phase: execute` line into the
item's frontmatter, and nothing else — the body is untouched. `phase: execute` is what
lets `stop` (see below) know to bill this session into `execute-elapsed:` and
`execute-tokens:` rather than their `groom-` counterparts — the seconds it ran and the
tokens it spent over that same interval, read out of this session's own transcript.
Leave off `--as` and there's nothing for `stop` to bill either of them against. The board app renders the marker as an amber bar across the top of the card,
reading how long the work has been going, so anyone looking at the board can see what's
being worked without asking. It is not a status: the item is still open, still in
`<section>/open/`.

Exit `1` here means the item can't be started, and the message says which: already in
progress (someone is on it — say so and stop rather than working it twice), already done,
or out of scope. Don't work around it.

Clear it if you walk away without archiving — see below.

## Dispatch

**Bug** → invoke `superpowers:systematic-debugging` first, to confirm the diagnosis in
`## Cause` still holds against the code as it actually is right now — grooming may have
happened a while ago, and code drifts. Only once that's confirmed, invoke
`superpowers:test-driven-development` for the fix: a failing test first, then the change
that makes it pass.

**Task** → invoke `superpowers:executing-plans` to work through `## Plan` as written. If
the plan's own steps are independent of each other — no shared state, order doesn't
matter — invoke `superpowers:subagent-driven-development` instead and dispatch them in
parallel rather than one at a time.

## Write before you move

Write the file first, call `move` only once that write is on disk — same rule
`backlog-groom` follows, for the same reason: a failed write leaves the item where it was;
a moved file with a half-written `## Outcome` is the one state re-running this skill
cannot repair.

## Archive when verification proves it

Once the fix or the plan's steps are actually done, run
`superpowers:verification-before-completion` — that's what turns "should work" into proof.
Then, and only then:

1. Append `## Outcome` to the item's file, after its existing headings — never replacing
   them. Write the date, a sentence on what actually happened, and **the verification
   command's actual output**, pasted in. Not "tests pass" — the output that shows tests
   passing.
2. Bill the session and clear the phase marker, but keep the record of when it started:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" stop <id> --keep-started
   ```

3. Move it:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" move <id> done
   ```

Between steps 2 and 3 the item sits open with `started:` but no `phase:` — the board
reads that as in progress under its generic label rather than "executing," since the
phase that named the activity is already gone. If step 3 then fails (for example, a
same-named file already sitting in `done/`), run a plain `stop <id>` to clear the
leftover marker; the item stays exactly where the failed move left it, ready to retry.

## If verification fails, nothing moves

Stop. The item stays exactly where it is, open — `move` is never called on this path.
Still append `## Outcome`: the date, what was attempted, what failed, and the real output
showing the failure. That record is what keeps the next attempt — yours or someone
else's — from repeating the same dead end. Tell the user what failed and let them decide
whether to retry, re-groom, or escalate.

Leave the in-progress marker alone if they're retrying now. Clear it if the item is being
parked or handed back:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" stop <id>
```

An item nobody is actually working that still shows an amber bar is worse than no marker
at all — it's the board lying about where the work is. The two paths call different stops
for exactly that reason: parking here is clearing a marker on work that isn't happening
anymore, so a plain `stop` is right — it bills whatever time was spent and drops `started`
along with it, because there's nothing left to date. Archiving above is recording finished
work instead, so it calls `stop --keep-started`: that bills the session the same way, but
leaves `started` in place as the historical record of when the work began, since a
`move ... done` is about to follow it into permanence.

## Hard limits

- **Never commits, never pushes.** Staging is the user's call — a targeted `git add` in a
  dirty tree can sweep in unrelated in-flight work that has nothing to do with this item.
  Leave the working tree as it is; tell the user what files changed and let them stage and
  commit it themselves.
- **Never touches `ideas/`, `refactors/` or `out-of-scope/`.** An idea isn't executable by
  definition, and neither is a refactor — promoting either into a task is
  `backlog-groom`'s job. A rejected item is closed. If `show` resolves the id into any of
  those three directories, refuse immediately (see Pick an item above). Nothing but this
  rule enforces the idea and refactor halves of it: `start` used to refuse an idea and no
  longer does, because grooming one is real work and `backlog-groom` now marks it in
  progress the same way this skill does — and `start` never had any notion of a refactor
  to refuse. The tool will happily stamp either one for you, and the refusal gate below
  inspects only a task's `## Plan` and a bug's `## Fix`, so a refactor that got past this
  check would find no rule to fail. The id has to be checked here, before `start` is ever
  reached.
- **Writes only under the repo root `show` resolved.** Every write this skill makes — the
  `start`/`stop` markers, the `## Outcome` append, the `move` to `done/` — lands inside the
  one tree `backlog.mjs` resolved from this session's own cwd. Another checkout of the same
  repository is another tree: writing into it from here produces changes on nobody's branch,
  attributable to no commit, in a working copy this session was never given.
- **If verification fails, nothing moves.** Covered above — restated here because it's a
  hard limit, not a suggestion: no proof, no archive.

## Next

`/backlog` shows one fewer open item once this is done. Anything new the work surfaces —
a fresh bug, a follow-on idea — is a new `backlog-capture`, not an edit to this one.
