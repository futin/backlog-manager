# backlog-execute — under a `[backlog-tick]` marker

SKILL.md's "Am I inside a tick?" is the rule; this file is the reasoning and the list of stops behind it. Read it when a stop happens, not before. A reference
file is read with the Read tool and never has `${CLAUDE_PLUGIN_ROOT}` filled in.

## Why it is not an orchestrator run

`backlog-tick` starts one execute session per item, in the item's own worktree through `--finish pr`, and the arguments are exactly
`<id> --finish pr [backlog-tick]` — or `<id> --finish pr --base <ref> [backlog-tick]` when the tick was given a base. Nothing wraps that session the way
`backlog-orchestrate` wraps its own: there is no driver to commit, review, push or close the item afterwards. So the three things an `[orchestrator-run` marker takes away — the git
steps, the claim on a tracker item, the `## Outcome` path — all stay here. `pr-mode.md` runs as written, a tracker item is claimed and released by this session
the way an interactive one is, and the `## Outcome` is written where it always is. What the marker takes away instead is the user: there is nobody to ask, so the
interactive exits that say "tell the user" become the final message.

## The stops

Each of these ends the final message with one line starting `failed:`, then the reason, and nothing after it:

- the refusal gate — an unplanned task or bug, `a PR is open for this item`, `this plan awaits review`, `filed from outside the repo — groom it to vet the plan`;
- `start` refused: a lost claim race ends the session as "Losing the claim race" says, with the holder in the reason;
- an unknown or doubled `--finish`, an unusable `<base>`, or any other refusal `references/pr-mode.md` §1–§3 raises;
- a failed verification, including `Plan no longer holds:` — the `## Outcome` is written as SKILL.md says, and the reason is its first line;
- a review that still says `fix` after the second fix round, a push the remote rejected, a permission denial on a git or `gh` step, or a missing or unauthenticated
  `gh` (§7–§8): the branch and worktree are left as they are, and the reason says where.

Success is a PR that exists: the **last line** of the final message is its URL, alone on the line, so `backlog-tick` can read it without parsing prose. A branch
pushed with no PR opened is not a success, so its final message ends `failed:` too.

## What does not change

Never asks, never offers an override, never backgrounds anything, never merges — the same limits `pr` mode already carries. A user message arriving mid-session
is noted in one line and does not change the next step, the way the `[orchestrator-run` section says.
