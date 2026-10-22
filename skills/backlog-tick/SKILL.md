---
name: backlog-tick
description: >
  Run one unattended unit of backlog work per scheduled tick, started by a dashboard job and never by hand: only when the project's pipeline is idle, it
  executes a ready bug or task to a PR, or else grooms an ungroomed bug or a refactor into a plan marked `plan-review` for a person to approve. It never
  merges, never commits a groom, never asks a question and never runs anything in the background. Use it for /backlog-tick, run a backlog tick, or when a
  scheduled job names it. Trigger: /backlog-tick
trigger: /backlog-tick
---

# /backlog-tick — one unattended unit of work

A tick does at most ONE unit: an execute of a ready bug or task, or — when nothing is ready — a groom of an ungroomed bug or a refactor. `tick.mjs` decides
which, and keeps the lock and the memory of what failed; this session only carries the verdict out. The design is
`docs/superpowers/specs/2026-10-22-backlog-tick-design.md`.

## Rules

- **Never ask the user anything.** Nobody is there; an unanswered question parks the whole tick.
- **Never run anything in the background, and never end a turn with something still running.** This is `claude -p`: the process exits when the turn ends.
- **Touch backlog items only through the two skills and the two tools named here, plus one read:** `backlog.mjs show` (step 3). Never edit an item file by hand,
  never commit, never merge, and never push yourself — an execute's own `--finish pr` pushes its own branch, and that is the skill's, not yours.
- **A non-zero exit from `decide`, `record` or `forget` means stop:** report the stderr line as the final message. Never read it as "nothing to do". Exit `1`
  is usage and exit `2` is runtime. Exit `3` is `record` finding the lock held under ANOTHER id: the outcome was written, the lock was left, and the usual cause
  is recording an id other than the verdict's (step 3) — stop all the same, so the stall reaches the run log. If `decide` itself failed — or printed anything
  but one JSON line — there is no lock to release, so no `record` follows.
- **Tracker ids start with `#`, so single-quote the id in the shell** (`record '#12' ok …`) — unquoted, the shell reads `#12` as a comment. The `--reason`
  text is single-quoted too, and is one line.

## 1. Decide

Pass the trigger's flags through unchanged — `--max-prs M`, `--max-plans N`, `--base <ref>`, `--lock-ttl <minutes>`, `--dry-run` — and none it did not carry:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-tick/tools/tick.mjs" decide <the trigger's flags>
```

It prints ONE JSON line: `verdict`, `reason`, `root`, `caps`, `dryRun`, and for `execute` / `groom` also `id`, `skill` and `args`; for `recover` also `stop`,
and `id` when a lock was readable. `root` is the project's main checkout (`null` when the cwd is not one); step 3 runs from it.
On `execute` and `groom` it has taken the lock; from here to step 3 the lock is held, and only `record` releases it.

**`dryRun` is `true` — whatever the verdict, run nothing and record nothing:** no lock was taken and no `stop` is safe. The final message is the `verdict` and
`reason` (plus `id` and `skill` when present). Done.

## 2. Act on the verdict

- **`idle` or `busy`** — nothing was taken. The final message is the `reason`. Done; do not `record`. `idle` covers `halted` — the breaker has stopped this
  project after N failures in a row — and an unreadable `tick.json`; both are the `reason` as printed, with nothing to run. On a tracker project it also
  covers a cache the server has not filled yet — `tracker not polled yet: <repo>`, `tracker <access>: <detail>`, or
  `tracker cache holds no items for <repo> (polled <time>)` — which is what a server restart looks like for a minute or so; the next scheduled tick is the
  retry, and nothing here waits for it.
- **`recover`** — a killed tick's lock was cleared and its failure recorded. When `stop` is `true`, run
  `node "${CLAUDE_PLUGIN_ROOT}/skills/backlog/tools/backlog.mjs" stop '<id>' --abandon` to clear the dead groom's `started:` marker. The final message is the
  `reason` plus one line saying whether the marker was cleared. Done; do not `record`.
- **`execute` or `groom`** — invoke the skill named in `skill` through the Skill tool as `backlog-manager:<skill>` (plugin skills need the `plugin:skill` form;
  prefix it unless `skill` already carries one), with `args` EXACTLY as printed — the `[backlog-tick]` marker at its end is what tells that skill nobody is
  there. Run it to its end in this session, then go to step 3. If the Skill tool itself errors, that is a `failed` outcome with the error as the reason.

## 3. Judge the outcome, then always record

Decide `ok` or `failed` from what the skill left behind, never from how confident its last sentence sounded:

| Verdict | `ok` | `failed` |
| --- | --- | --- |
| `execute` | the skill's final message ends with a PR URL on a line of its own | anything else — reason: its `failed:` line, or a one-line summary |
| `groom` | the item is groomed afterwards (below) | anything else, a skill that wrote nothing included — same reason |

A groom is `ok` only when the item is groomed AND carries the `plan-review` mark: a **bug** has `## Cause` and `## Fix` filled, neither "unknown", and the
mark; a **refactor** was promoted to a task that has a plan and the mark. Anything else is `failed` — a bug groom that ends still ungroomed, recorded `ok`,
would be re-picked every tick, and an unmarked plan would be executed unseen. Read it back, read-only, on the bug's id, or on the new task id the groom printed
— that new id is for this read-back ONLY:

```bash
cd '<root>' && node "${CLAUDE_PLUGIN_ROOT}/skills/backlog/tools/backlog.mjs" show '<id or new task id>' --json
```

Every step-3 command starts `cd '<root>' &&`, with `root` from step 1's JSON: an execute's `--finish pr` leaves this session's cwd inside its own worktree.

In a tracker project the JSON carries `item.groomed` (`true` when Cause and Fix are filled and not "unknown", or the task has a plan) and `item.planReview`
(`true`, or absent). In a files project `show` prints the path and frontmatter only — the `plan-review: true` line is in that block (any value but `false`
counts) — so Read the file at the printed path for the `## Cause` / `## Fix` or `## Plan` text.

Then run one of these in every case — after an error or a half-finished skill too, because the lock is released only here. **`record` always takes the
verdict's `id` from step 1** — for a promote the refactor's, never the new task's; any other id leaves the lock held and exits `3`. Make the reason ONE line
and write every apostrophe in it as `’` (or drop it), so the single quotes can never break and leave the lock held:

```bash
cd '<root>' && node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-tick/tools/tick.mjs" record '<verdict id>' ok --kind <execute|groom>
cd '<root>' && node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-tick/tools/tick.mjs" record '<verdict id>' failed --kind <execute|groom> --reason '<one line>'
```

A `failed` outcome skips that item until its content changes, so one bad item cannot take every night's slot. There is no `blocked` outcome: a failure that was
the environment's fault — the stack down, `gh` signed out — is cleared with `tick.mjs forget '<id>'`, run by a person and never by this session.
A `failed` groom also keeps that item off the execute queue until its content changes, since its plan may be one nobody reviewed; once a person has reviewed
it, `tick.mjs forget '<id>'` makes the item eligible again.
A halted project is reset on the board (Runs › Ticks), not by `forget`, which only clears one item.

## 4. Final message

One short paragraph: what was done, the PR URL (execute) or the item groomed and that its plan awaits review (groom), or why nothing was done. A `failed` tick
still ends as an ordinary result — the run log is the signal, and a push per failed night would be noise — so do not escalate it. A `record` that exited
non-zero replaces the paragraph with its stderr line (see Rules).
