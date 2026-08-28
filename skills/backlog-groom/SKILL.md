---
name: backlog-groom
description: >
  Turn an open bug, idea, or task into something the next skill can act on: promote an idea
  into a task with a real plan, fill in a bug's cause and fix without moving it, or close
  anything out as decided against. Use it to groom the backlog, plan idea 3, reject task 5,
  say this is out of scope, or make this executable. It only ever edits and moves existing
  items — filing a new one is backlog-capture's job, and doing the actual work once it's
  groomed is backlog-execute's. Trigger: /backlog-groom
trigger: /backlog-groom
---

# /backlog-groom — turn an item into something executable

Groom gives one open item a verdict: **promote** it, **plan its fix** in place, or
**reject** it. It never files anything new — that's `backlog-capture` — and it never does
the actual work — that's `backlog-execute`. Every verdict below ends with a file that's
either fully rewritten or left fully alone; there's no half-done state this skill leaves
behind on purpose.

## Pick an item

If the trigger already named one ("plan idea 3", "reject task 5"), use that id directly.
Otherwise show what's open first — run `/backlog`, or:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" board
```

— and ask the user which item, and which verdict.

This skill never runs `init`. If a command below exits `3`, there's no `backlog/` store in
this repo yet — that's `backlog-capture`'s job, not this one; send the user there instead
of creating it yourself. If a command exits `2`, you're not inside a git repository at all.

Every verdict starts the same way:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" show <id>
```

This prints the item's absolute path on line 1, then its frontmatter block —
**never the body**. Read the file at that printed path yourself to see the actual headings
and content; there's no tool command that prints the body, and none is needed.

## Refusals — rule these out before picking a verdict

- **Unknown id.** `show` and `move` both exit `1` naming it. Relay that message; don't
  guess a path yourself.
- **Already in `out-of-scope/`.** Rejection is terminal, and the tool itself enforces this
  one — a second `move <id> out-of-scope` on the same id exits `1` with a message saying
  so. Tell the user to capture a fresh item instead of trying to resurrect this one.

Reject has one more refusal of its own — see its section below. It doesn't apply to
Promote or Plan the fix, so it isn't listed here with the two above.

## Three verdicts — choose one with the user

| The item is... | Verdict |
|---|---|
| an idea whose shape is now settled enough to plan | **Promote** — becomes a new task |
| a bug whose cause and fix are now known (or worth chasing now) | **Plan the fix** — filled in place |
| an open bug, idea, or task that shouldn't happen | **Reject** — moved to `out-of-scope/` |

Say which verdict you think applies and why, then wait for the user to confirm or pick a
different one. Don't infer a verdict silently and act on it — grooming is a decision made
*with* the user, not a classification you run on their behalf.

### Mark it in progress

Only once both are confirmed — the item and the verdict — say so on disk, before any of
the three verdicts below touches the file:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" start <id>
```

Not any earlier: an item nobody has agreed to work on yet isn't "in progress," and
stamping it ahead of the confirmation above would tell the board a session is running
when the conversation might still end in "let's not." This is the same `started:` marker
`backlog-execute` writes when it picks up a groomed item — grooming is active work on the
item too, and the board's `»` column (see `skills/backlog/SKILL.md`) now means "someone
is on this right now" for either skill, not execute alone.

Exit `1` here is one of two very different things:

- **"already in progress."** Not a refusal — some other session (most likely a resumed
  `backlog-execute`, or another groom already working this same id) holds the marker
  already. Give the verdict below as normal, but skip every `stop` it ends with: the
  marker isn't yours to clear, and clearing it would tell the board that other session
  had finished when it hasn't. Groom only ever releases a marker it set itself.
- **anything else** (done, out of scope). A real refusal — relay it the way the Refusals
  section above relays refusals, and stop; there's no verdict to give an item that can't
  be started.

### Promote — idea becomes a task

1. Invoke `superpowers:brainstorming` to settle the idea's `## Open questions` — but
   only if those questions are real. An idea like "mention the license in the README"
   has none worth a full interactive process; settle it inline and move to step 2. Keep
   brainstorming mandatory whenever the open questions actually need working through —
   that's the whole reason the section exists. The idea's own `## Problem` /
   `## Rough shape` / `## Open questions` can stay exactly as captured either way —
   that's the record of how the idea started; only its frontmatter changes, in step 5.
2. Turn whatever came out of step 1 into a plan, written directly into the new task's
   `## Plan` section — **that section is the plan artifact; there is no separate plan
   document to produce.** Which route you take follows brainstorming's own
   classification, not a separate decision:
   - **Architectural** → invoke `superpowers:writing-plans`, and put its plan's content
     into `## Plan`. That heading is where the plan lives; writing-plans is never asked
     to produce a standalone file for this.
   - **Bounded** → don't invoke `superpowers:writing-plans` at all — brainstorming's own
     rule for this path is "implementation proceeds directly through the normal
     development workflow; no plan document," and writing-plans is only ever invoked
     after an Architectural brainstorm. Write `## Plan` straight from the short design
     brainstorming already settled in chat. This is not a workaround or a shortcut: it's
     the correct reading of both files together, not a contradiction between them.

   Either route ends the same way: `## Plan` must come out real and substantive.
   `backlog-execute` refuses a task whose `## Plan` is absent, empty, or a placeholder —
   an under-planned promote doesn't fail here, it fails later, in execute, and the user
   won't know why. That's what keeps this requirement non-negotiable even after the
   shortest brainstorm.
3. Create the new task:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" new tasks "<title>" --from idea-N
   ```

   This prints the new task's path and frontmatter, already carrying `from: idea-N`. The
   title doesn't have to match the idea's own — use whatever fits the plan from step 2,
   whether or not writing-plans was the one that produced it.
4. Write that file: keep the printed frontmatter block exactly as printed, then add all
   four task headings — `## Goal`, `## Plan`, `## Test cases`, `## Done when` — filled in
   for real. `## Plan` is the one heading `backlog-execute` gates on, but a task that's
   actually executable needs all four answered, not just that one.
5. Only now edit the idea: add a `promoted-to: task-N` line inside its existing
   frontmatter block, before the closing `---`, leaving every other line untouched.
6. Release the marker on the idea — not on the task step 3 just created; nobody has
   started working that yet:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" stop idea-N
   ```

   `stop` doesn't check location, so running it here rather than after the move below is
   a style choice, not a requirement — a session resuming after an interruption that
   already moved the idea to `done/` can still run this and clear the stamp there. Skip
   this line entirely if `start` refused above with "already in progress" — see "Mark it
   in progress" above; that marker belongs to another session, not this one.
7. Move the idea:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" move idea-N done
   ```

If you're resuming this after an interruption, `show` the idea first and check whether a
task carrying `from: idea-N` already exists before creating a second one.

### Plan the fix — bug stays a bug

1. Invoke `superpowers:brainstorming` only if the fix actually needs design work — a
   diagnosed one-line fix doesn't.
2. Edit `## Cause` and `## Fix` **in the bug's own file**, replacing `unknown` with the
   real answer. No new file, no promotion, no id churn — a bug stays a bug from capture
   through to done, so the whole story of one defect lives in one place.
3. Release the marker:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" stop <id>
   ```

   Skip this if `start` refused above with "already in progress" — see "Mark it in
   progress" above; that marker belongs to another session, not this one.

That's the entire verdict. It's the one that never calls `move`, so `stop` is simply its
last step rather than something to place before a move — the bug stays in `bugs/open/`,
now groomed, until `backlog-execute` finishes it and archives it to `bugs/done/`.

### Reject — out of scope, open items only

Check the global Refusals above first (unknown id, already-terminal). Then this refusal,
which belongs to Reject alone: **refuse anything already in `done/`, in any section.**

Reject replaces the item's *entire* body (step 2 below) — and a done item's body is a
record, not a draft. An idea's record is `promoted-to:`, naming the task it became. A
bug's or task's record is `## Outcome`, naming what was done and the command output that
proved it. Rejecting a done item would silently destroy whichever of those it holds, and
nothing stops that but this paragraph: the tool has no notion of "done" blocking a move
to `out-of-scope/` — `move <done-id> out-of-scope` succeeds whether the id is a bug, a
task, or an idea — and nothing else in this file checks it either. If `show` puts the id
under a `done/` directory, stop here and say so.

If finished work turns out to have been a mistake, that's a **new item** citing the old
one — that's what `from:` exists for — not a rewrite of the record proving what was
actually done.

Otherwise, for an open bug, idea, or task:

1. If the user hasn't already given a rejection reason and a condition that would change
   the answer, ask for both — same as `backlog-capture` requires at filing time. Don't
   invent either one — that rule is about the skill not answering for the user, not
   about needing someone else in the room, so a solo user answering their own question
   satisfies it fine.
2. Replace the **entire** body with the three out-of-scope headings, verbatim:
   `## What was proposed`, `## Why rejected`, `## What would change the answer`. Whatever
   headings were there before — a bug's `## Symptom` / `## Repro` / ..., a task's
   `## Goal` / ... — are gone. This is a full rewrite, not an addition.
3. Add a `rejected: <today>` line to the frontmatter, in the same `YYYY-MM-DD` format as
   `created`.
4. Release the marker, before the move below:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" stop <id>
   ```

   Same reasoning as Promote's release: `stop` doesn't check location, so this could run
   after the move too — a session resuming here after an interruption that already moved
   the item into `out-of-scope/` can still clear the stamp there. Skip this line if
   `start` refused above with "already in progress" — see "Mark it in progress" above;
   that marker belongs to another session, not this one.
5. Move it:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" move <id> out-of-scope
   ```

   The id and filename never change — `move` only relocates the file; it never renames it
   and never touches its bytes. A rejected `bug-7` is still `bug-7-<slug>.md`, now living
   under `out-of-scope/`.

## Write before you move

Write the file first. Call `move` only once that write is on disk. A failed write leaves
the item exactly where it was; a moved file with a half-written body is the one state
re-running this skill cannot repair. This applies to promote's idea and to every
rejection — plan-the-fix never calls `move` at all, so it doesn't arise there.

## If the session ends without a verdict

If the user walks away mid-groom — no verdict given yet, or one chosen but the steps
above never finished — clear the marker before the turn ends:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" stop <id>
```

A stamp left on the file reads on the board as a session still actively working it, long
after this one is gone. Worse, the next `backlog-execute start <id>` on the same item
refuses with "already in progress" — for a session that no longer exists to finish
anything. Skip this only if `start` itself refused with "already in progress" earlier in
this same conversation — see "Mark it in progress" above; there was never a marker of
this session's own to leave behind.

## Next

A promoted idea or a fixed-in-place bug is ready for **`backlog-execute`**. A rejected
item is closed — nothing further happens to it. Either way, `/backlog` shows the updated
board.
