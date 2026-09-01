---
id: idea-5
title: Hoist a queue item that fixes the runner to the front of a run
created: 2026-09-01
tags: orchestrate, skill
---

## Idea

When `plan` previews a queue, notice items whose fix changes the machinery the run itself
depends on — the orchestrate skill, its CLI, the reviewer agent, the dispatch route — and
run them first, so every later item is executed by the fixed version.

Ordering today is bugs-then-tasks, oldest-first within each, overridden only by an
explicit `--ids` list. That ordering is blind to a property some items have and most do
not: *this item repairs the thing that is about to execute the rest of the queue*.

## Why

Observed, not hypothesised. Run run-20260901-112035 queued `bug-2, bug-3, bug-4, bug-6,
bug-7` in the default order. bug-3 was **"Orchestrate dispatches with a stronger permission
flag than it needs"** — and the very first dispatch of the run, on bug-2, was refused by
the auto-mode permission classifier for exactly the flag bug-3 exists to replace. The fix
was groomed, sitting three items away, in the same queue.

bug-3's own Symptom section had already recorded this happening once before: *"It stopped
the first real end-to-end run (run-20260831-211011) dead at step 4, and the run only
completed because a subagent was substituted for the headless session by hand."* So the
same item blocked two consecutive runs while queued inside one of them.

The recovery was cheap but entirely manual: abort the run, tear down the worktree already
created for bug-2, re-`init` with `--ids bug-3,bug-2,…`. Nothing in the skill suggested it,
and nothing in `plan`'s output hinted the queue had this shape. The alternative that was
seriously considered — work around the blocker for the whole run — would have left bug-3
open and the next run would have hit it again.

Second-order benefit, which is the stronger argument: after bug-3 merged, the remaining
four items were dispatched by the **fixed** skill, so the fix got four end-to-end
exercises inside the same run rather than waiting for the next one. A runner fix that
merges last is a fix nothing in that run ever used.

## Shape (unresolved — this is an idea, not a plan)

The detection is the hard part and the reason this is not filed as a bug. Some options,
none obviously right:

- **Path-based, mechanical.** An item whose `## Affects` or `## Fix` names `skills/`,
  `agents/`, or `server/src/agents/` is a runner-touching candidate. Cheap, needs no
  judgement, and wrong often enough to be annoying — most `skills/` edits do not affect the
  running orchestrator at all.
- **A frontmatter key**, written by `backlog-groom` when the groomer notices it. Honest
  about being a judgement call and it costs nothing at run time, but it only helps items
  groomed after the key exists, and a groomer with no run in mind is the person least
  likely to think of it.
- **`plan` flags candidates, the operator decides.** A fourth verdict column, or a line
  under the item the way `ungroomed` reasons are printed. Fits the existing shape: `plan`
  already exists to be read by a human before `init`, and the skill already says to get
  agreement on the queue unless ids were named explicitly.
- **Nothing automated; a paragraph in the skill.** Step 1 tells whoever reads the preview
  to check for this and hoist by hand with `--ids`. Zero code, and it binds only when a
  person is actually reading — which for an unattended run is exactly when it is not.

Worth settling during grooming:

- Does hoisting fight the "reviewed and verified between items" guarantee in any way? It
  should not — each item still merges alone — but a runner fix changes the *tooling* mid-
  run, and the run's own state file was written by the pre-fix version. bug-2's fix (a
  loud refusal in `resolveProjectRoot`) is a live example of a change that could in
  principle affect commands issued later in the same run.
- Should a hoisted item force a re-read of the skill, or is it accepted that the current
  session keeps following the body it was handed? In run-20260901-112815 the merged fix
  was applied by hand (the dispatch flag was swapped in the commands actually issued),
  which worked but was not something the skill asked for.
- Interaction with `--max N`: hoisting changes which items fall beyond the cap.

## Related

- bug-3 (merged) — the item that motivated this.
- bug-9 — a second skill-body defect found the same way, by running the skill rather than
  reading it.
