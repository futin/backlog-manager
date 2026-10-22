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
- **Touch backlog items only through the two skills and the two tools named here.** Never edit an item file by hand, never commit, never merge, never push.
- **A non-zero exit from `decide`, `record` or `forget` means stop:** report the stderr line as the final message. Never read it as "nothing to do". Exit `1`
  is usage and exit `2` is runtime. If `decide` itself failed there is no lock to release, so no `record` follows.
- **Tracker ids start with `#`, so single-quote the id in the shell** (`record '#12' ok …`) — unquoted, the shell reads `#12` as a comment. The `--reason`
  text is single-quoted too, and is one line.

## 1. Decide

Pass the trigger's flags through unchanged — `--max-prs M`, `--max-plans N`, `--base <ref>`, `--lock-ttl <minutes>`, `--dry-run` — and none it did not carry:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-tick/tools/tick.mjs" decide <the trigger's flags>
```

It prints ONE JSON line: `verdict`, `reason`, `caps`, `dryRun`, and for `execute` / `groom` also `id`, `skill` and `args`; for `recover` also `id` and `stop`.
On `execute` and `groom` it has taken the lock; from here to step 3 the lock is held, and only `record` releases it.

## 2. Act on the verdict

- **`idle` or `busy`** — nothing was taken. The final message is the `reason`. Done; do not `record`.
- **`recover`** — a killed tick's lock was cleared and its failure recorded. When `stop` is `true`, run
  `node "${CLAUDE_PLUGIN_ROOT}/skills/backlog/tools/backlog.mjs" stop '<id>' --abandon` to clear the dead groom's `started:` marker. The final message is the
  `reason` plus one line saying whether the marker was cleared. Done; do not `record`.
- **`execute` or `groom`** — invoke the skill named in `skill` through the Skill tool, with `args` EXACTLY as printed (the `[backlog-tick]` marker at its end is
  what tells that skill nobody is there). Run it to its end in this session, then go to step 3.
  - **`dryRun` is `true`** — invoke nothing and `record` nothing; no lock was taken. The final message is the `reason`, `id` and `skill`.

## 3. Judge the outcome, then always record

Decide `ok` or `failed` from what the skill left behind, never from how confident its last sentence sounded:

| Verdict | `ok` | `failed` |
| --- | --- | --- |
| `execute` | the skill's final message ends with a PR URL on a line of its own | anything else — reason: its `failed:` line, or a one-line summary |
| `groom` | the item is groomed afterwards (below) | anything else, a skill that wrote nothing included — same reason |

Groomed means: a **bug** has `## Cause` and `## Fix` filled and neither is "unknown"; a **refactor** was promoted to a task whose plan carries its `plan-review`
mark. A bug groom that ends with the bug still ungroomed is `failed` — recorded `ok`, that bug would be re-picked every tick.

Then run one of these in every case — after an error or a half-finished skill too, because the lock is released only here:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-tick/tools/tick.mjs" record '<id>' ok --kind <execute|groom>
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-tick/tools/tick.mjs" record '<id>' failed --kind <execute|groom> --reason '<one line>'
```

A `failed` outcome skips that item until its content changes, so one bad item cannot take every night's slot. There is no `blocked` outcome: a failure that was
the environment's fault — the stack down, `gh` signed out — is cleared with `tick.mjs forget '<id>'`, run by a person and never by this session.

## 4. Final message

One short paragraph: what was done, the PR URL (execute) or the item groomed and that its plan awaits review (groom), or why nothing was done. A `failed` tick
still ends as an ordinary result — the run log is the signal, and a push per failed night would be noise — so do not escalate it. A `record` that exited
non-zero replaces the paragraph with its stderr line (see Rules).
