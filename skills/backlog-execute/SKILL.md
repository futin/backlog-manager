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
verification proves it worked. It only ever works `bugs/` and `tasks/` — never `ideas/`
(nothing to execute, by definition) and never `out-of-scope/` (already closed). It never
files anything new (`backlog-capture`) and never writes a plan (`backlog-groom`) — if the
plan isn't there yet, it refuses and says so.

## Pick an item

If the trigger already named an id ("fix bug 7", "execute task 12"), use it. Otherwise
find the next thing to work:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" board --section bugs
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" board --section tasks
```

Never `--section ideas` — an idea has no plan to execute; that's what promoting it via
`backlog-groom` is for. "Do the next thing" means the oldest open bug or task whose plan
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

If that path resolves under `ideas/` or `out-of-scope/`, stop — wrong skill for this id
(see Hard limits below). If it's already under a `done/` directory, there's nothing left
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
lets `stop` (see below) know to bill the time this session runs into `execute-elapsed:`
rather than `groom-elapsed:` — leave off `--as` and there's nothing for `stop` to bill
against. The board app renders the marker as an amber bar across the top of the card,
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
2. Move it:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" move <id> done
   ```

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
at all — it's the board lying about where the work is. Archiving does not need this:
`move` never rewrites content, so a done item keeps its `started` timestamp as history.

## Hard limits

- **Never commits, never pushes.** Staging is the user's call — a targeted `git add` in a
  dirty tree can sweep in unrelated in-flight work that has nothing to do with this item.
  Leave the working tree as it is; tell the user what files changed and let them stage and
  commit it themselves.
- **Never touches `ideas/` or `out-of-scope/`.** An idea isn't executable by definition —
  promoting it into a task is `backlog-groom`'s job. A rejected item is closed. If `show`
  resolves the id into either directory, refuse immediately (see Pick an item above).
  Nothing but this rule enforces the idea half of it: `start` used to refuse an idea and
  no longer does, because grooming one is real work and `backlog-groom` now marks it in
  progress the same way this skill does. The tool will happily stamp an idea for you — so
  the id has to be checked here, before `start` is ever reached.
- **If verification fails, nothing moves.** Covered above — restated here because it's a
  hard limit, not a suggestion: no proof, no archive.

## Next

`/backlog` shows one fewer open item once this is done. Anything new the work surfaces —
a fresh bug, a follow-on idea — is a new `backlog-capture`, not an edit to this one.
