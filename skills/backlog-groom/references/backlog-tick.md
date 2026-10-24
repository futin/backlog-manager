# backlog-groom — under a `[backlog-tick]` marker

Read this file **in full, once**, when the words that came with the trigger carry `[backlog-tick]` anywhere after the id — before `show`. A session without that
token never opens it. The token means `backlog-tick` dispatched this session on its own, with nobody watching: the prompt is exactly `<id>, plan the fix
[backlog-tick]` (a bug) or `<id>, promote it to a task [backlog-tick]` (a refactor), and that prompt IS the item-and-verdict confirmation "Mark it in progress"
asks for, so `start` runs as the very next command after `show`. Everything in SKILL.md still holds except where this file narrows it. A reference file is read
with the Read tool and never has `${CLAUDE_PLUGIN_ROOT}` filled in: replace it in any command copied from here with the absolute path SKILL.md's own commands
show.

## Two verdicts, and the ones that do not exist

- **Plan a bug's fix** (a `bug-N` / bare bug number) and **promote a refactor** (a `ref-N`) are the only two. An idea, a task, an item already in `done/` or
  `out-of-scope/` is not a tick's to groom: print `failed: <id> is not something a tick plans` and stop before `start`, so nothing is marked.
- **Never reject, never move an item to `out-of-scope/`, never promote an idea.** Those are decisions about whether work should exist at all, and a tick has
  nobody to make them with. An item that looks like it should be rejected ends as a failure, below.

## Never ask

Nobody is there to answer, and an unanswered question parks the whole tick.

- Do not invoke `superpowers:brainstorming` or `superpowers:writing-plans`, on either verdict. Where SKILL.md says to brainstorm "only if the fix needs design
  work" or to settle a promote's open questions with the user, settle each one inline instead: pick the most conservative answer the code supports, and write it
  down.
- **Every open question you settled is listed, with the answer you chose, under a `## Assumptions (unattended)` heading** — the last heading of the body, after
  `## Fix` (bug) or `## Done when` (task). It is what the person approving the plan reads first. The heading is always written: with no open questions it holds
  the single line `None.`, so a reviewer never has to wonder whether the section was forgotten.
- A promote's `## Plan` is written straight from what you settled — the "small change" route in Promote step 2, never the "project with a written design" one
  that writes a spec and invokes `superpowers:writing-plans`. It must still be real and substantive: `backlog-execute` refuses a placeholder, and under a
  tick that refusal is a wasted PR slot.

## The plan-review mark — written in the same write as the plan

A plan written here has not been read by a person, and `backlog-execute` refuses an item carrying the mark, so the mark is what keeps an unattended plan from
being executed unseen. It is written **in the same write as the plan, never in a later one**: between two writes the item would be groomed and unmarked, which
is exactly what an orchestrator run or an execute session treats as ready.

| Verdict | Files project | Tracker project |
| --- | --- | --- |
| Plan a bug's fix | add `plan-review: true` to the bug's own frontmatter in the same edit that fills `## Cause` and `## Fix` | `--plan-review` on the one `body` call that writes the plan |
| Promote a refactor | the new task's printed frontmatter block is kept exactly as printed **plus** one `plan-review: true` line, in the one write that adds the four headings — carved out the way `runner-fix: true` already is in Promote step 4 | `--plan-review` on the `new tasks … --from #<n>` call |

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog/tools/backlog.mjs" body <id> --body /tmp/item.md --if-updated-at <updatedAt> --plan-review
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog/tools/backlog.mjs" new tasks "<title>" --body /tmp/task.md --from #<n> --plan-review
```

The files mark is read by presence, the way `runner-fix:` is: any value but `false` counts, so write exactly `plan-review: true`. The `runner-fix` judgement
in both verdicts is untouched and independent — a plan can carry both marks; on a tracker, put both flags on the same call. Removing the mark is the person's
approval: `backlog.mjs plan-review <id> off` on a tracker, deleting the line in a files project. This skill never removes it.

## Stops — no verdict, one `failed:` line

Stop with **no verdict** and end the final message with one line that starts `failed:` and gives the reason, whenever:

- the bug's cause cannot be found with confidence — never write a guess into `## Cause` to have something to mark;
- the item should be rejected or is out of scope (it is not yours to reject);
- any refusal in SKILL.md fires: an unknown id, a `start` that exits `1` for anything but "already in progress", a tracker `body` that stays refused after the
  re-read-and-reapply the tracker section describes;
- `start` says "already in progress". On a **files** project never take over another session's `started:` marker — no `stop --abandon`, no `abort`, no asking —
  and print `failed: already in progress (started <stamp>)`. On a **tracker** project the protocol still retires a claim stale past 15 minutes for you when you
  `start`; a live claim, here or on another machine, is `failed: already claimed by <holder from the refusal>`, and `abort` is never reached for.

Run your own `stop <id>` first **only when this session took a marker of its own** ("If the session ends without a verdict" applies as written). A failed groom
writes nothing else: the item is left as it was, never half-planned.

A successful groom ends as it always does — the **Groomed on disk only** line for a files project, nothing extra for a tracker one. A tick never commits a
groom; what happens to the file afterwards is the person's.
