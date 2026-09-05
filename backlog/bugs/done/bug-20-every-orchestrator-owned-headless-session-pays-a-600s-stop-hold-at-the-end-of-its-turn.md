---
id: bug-20
title: Every orchestrator-owned headless session pays a 600s Stop hold at the end of its turn
created: 2026-09-05
tags: orchestrate, skills, server, hooks
updated: 2026-09-05T22:27:08Z
groom-elapsed: 18
groom-tokens: 6057
started: 2026-09-05T22:15:32Z
execute-elapsed: 696
execute-tokens: 65276
---

## Symptom

Every session an orchestrator run owns — the run's own session, and every
execute session it dispatches — finishes its work and then sits doing nothing
for up to ten minutes before its process exits.

The machinery is the dashboard's remote-message feature. A finished turn runs
the `Stop` hook, which registers at `POST /api/messages/wait` and holds until
either a reply arrives or the answer window elapses. For a session at a
terminal there is an idle gate in front of that hold — at the keyboard, no hold,
because you can just type. **Headless sessions skip that gate by design**, in
the hook's own words: *"there is no terminal to type into, so the dashboard
window is the only channel whether you are at the desk or not."*

An orchestrator-dispatched session is headless (`nohup … claude -p`, no
controlling tty), so it always takes the hold, and nobody is ever going to
reply to it. Live values on this machine at the time of filing:
`answerSecs: 600`, `idleSecs: 60`, `remoteAnswer: true`.

The cost is per item, not per run: a five-item queue can spend the better part
of an hour holding for messages nobody is sending. `watch`'s budget is
`540000` — nine minutes — so a held session also guarantees at least one extra
`watch` round-trip past the one that would otherwise have caught its exit.

Not a correctness failure. `watch` exit `3` means "the budget elapsed and the
child is still alive, call again", the child is genuinely fine, and the item
completes normally. It is wall-clock and turns, on the one feature whose entire
value proposition is draining a queue while nobody watches.

The second half of the symptom is that the hold is not merely wasted, it is
*contrary to what a dispatched session is supposed to do*. bug-18 concludes
that a dispatched session must never treat the user as its escalation channel
and must not act on a message that arrives through the dashboard. A session
that must ignore those messages has no reason to spend ten minutes waiting to
receive one.

## Repro

1. Have the dashboard up with remote answers on (`/api/health` → `remoteAnswer:
   true`, `answerSecs: 600`).
2. Start an orchestrator run from the board over a project with two or more
   queued items.
3. Watch an item reach `dispatched`, then watch its `claude -p` child after it
   has written its `## Outcome` and finished.
4. The process does not exit. `ps` shows it alive; the run's `watch` call burns
   its remaining budget and returns `3`; the orchestrator calls `watch` again.
5. Roughly ten minutes after the work finished, the child exits and the run
   moves on.

The same hold happens once more at the end of the run, on the orchestrator's
own session.

## Affects

- `skills/backlog-orchestrate/SKILL.md` §4 — the `nohup sh -c '… exec claude -p
  …'` dispatch line, which is the only place a run can mark the process it
  spawns
- `server/src/agents/agents.service.ts` — `orchestrate()`/`resume()`'s spawn,
  the equivalent seam for the run's own session
- `~/.claude/hooks/stop-notify.sh` — the half that actually decides whether to
  hold. Not in this repo, but not a loose machine-local file either: it is a
  symlink to `claude-agents-dashboard`'s `scripts/stop-notify-hook.sh`, i.e.
  tracked source in another repo (corrected while implementing half 1)
- `skills/backlog-orchestrate/tools/orchestrate.test.mjs` — where the dispatch
  line's guards already live

## Cause

**Nothing distinguishes an orchestrator-owned session from any other headless
one, so no hook can treat it differently.**

The hook already discriminates carefully on everything it *can* see. It reads
the controlling tty to tell headless from terminal, and it special-cases
`CLAUDE_CODE_ENTRYPOINT=claude-desktop` because the desktop app has no pty but
does have a composer. Both of those are properties of the *front end*. Whether
a run owns the session is a property of the *caller*, and the caller currently
says nothing.

The two spawn seams are the two places that knowledge exists and is thrown
away:

1. `SKILL.md` §4 spawns each item's session with `nohup sh -c 'cd … && exec
   claude -p "<trigger>" …'`. The run knows its own run id and the item's id at
   that moment.
2. `agents.service.ts` spawns the run's own session through the dashboard, and
   already passes a `name` for it (`orchestrateSessionName`). It knows the
   project.

A blanket "never hold for headless sessions" would be the wrong fix and would
remove a feature that is used: messaging a hand-started headless session
through the dashboard is exactly how the bug-16 conversation in bug-18
happened. The discriminator has to be run-ownership, not headlessness.

## Fix

Two halves, and only the first is in this repo.

**1. Mark orchestrator-owned sessions in the environment (this repo).** Export
one variable, `BM_ORCH_RUN=<runId>`, on both spawn seams:

- `SKILL.md` §4's dispatch line, as an assignment in front of `exec claude`
  inside the existing `sh -c '…'` body. It must obey the same quoting rule
  bug-18's marker obeys — the body is single-quoted, so no apostrophes, and a
  run id is `run-YYYYMMDD-HHMMSS`, which is safe by construction.
- `agents.service.ts`'s orchestrate and resume spawns, through whatever env
  channel the dashboard's spawn request already offers. If it offers none, this
  half is skill-only and the run's own session keeps its single hold — a
  once-per-run cost, unlike the per-item one.

The environment is the right channel here for the same reason bug-18's marker
belongs in the prompt and not the environment, read the other way round: a hook
can read an env var and cannot read a prompt, while a human reads the prompt
and never sees the environment. The two markers answer different questions for
different readers and neither replaces the other. **Do not** collapse them into
one — and note that bug-18's own fix is the second edit to the same dispatch
line, so whichever of the two lands first, the other rebases onto its wording.

**2. Skip the hold when the marker is present — ALREADY DONE, 2026-09-05.** A
set, non-empty `BM_ORCH_RUN` takes the `notify_fallback` path: report the
finished turn, exit `0`, do not hold. Not an early `exit 0` — the "task
finished" push is worth keeping, and `notify_fallback` is the existing function
that sends it. Placed after the `remoteAnswer` gate and immediately before the
idle gate, since both answer the same question ("should this session hold?").

**Do not implement this half again.** `~/.claude/hooks/stop-notify.sh` turned
out to be a **symlink into the `claude-agents-dashboard` repo**
(`scripts/stop-notify-hook.sh`) rather than a loose machine-local file, so it
is tracked source and the change went in there as a normal commit: `65a2ccc` on
branch `fix/hooks-orchestrator-aware`, alongside the unrelated
`remote-decision-hook.sh` fix. Verified both ways with `bash -x`: with the
variable set the trace reaches `notify_fallback` and never touches the idle
gate or `/api/messages/wait`; without it the pre-change path runs unchanged.
Correct the `## Affects` line above when implementing half 1 — "machine-local,
not in this repo" was right about ownership and wrong about the file.

That half is inert until half 1 exists, because nothing sets the variable yet —
which is exactly what makes half 1 the whole of the remaining work. A machine
without the hook has no bug to fix at all (the hold is the hook's behaviour,
not Claude Code's), so half 1 is not merely worth doing on its own: it is what
makes the fix reachable for anyone who has the hook, and it costs one
assignment on a line bug-18 is rewriting anyway.

**Test cases** (in `skills/backlog-orchestrate/tools/orchestrate.test.mjs`,
which already reads `SKILL.md` off disk and already guards this line):

1. The dispatch line assigns `BM_ORCH_RUN` before `exec claude`, and the
   `--resume` retry line does too — a resumed session is owned by the run just
   as much as the original was, and it is a separate `exec claude -p` line that
   the existing `--permission-mode auto` test already treats as its own case.
2. Neither line's `sh -c` body contains an apostrophe. The existing guard, now
   covering one more substitution.
3. The variable name appears in `SKILL.md` exactly as one constant in the test,
   so the skill and any future consumer cannot drift into two spellings.
4. The existing `--permission-mode auto` assertion on both dispatch lines and
   the bug-9 positional-parameter sweep both stay green.

**Not in this fix:** changing `answerSecs`, changing the idle gate, or
exempting headless sessions generally. Each would trade this bug for a worse
one — a hand-started headless session must stay reachable.

## Outcome

2026-09-05 — Half 1 implemented, skill-only, as the Fix anticipated. Both of
`skills/backlog-orchestrate/SKILL.md`'s headless dispatch lines now assign
`BM_ORCH_RUN=<runId>` immediately before `exec claude` inside the existing
single-quoted `sh -c` body — §4's fresh dispatch and §5's `--resume` retry
alike, the retry included because a resumed session keeps its original prompt
but gets a brand-new environment. A paragraph in §4 records why the variable is
not the prompt marker by another spelling, why it sits inside the body rather
than in front of `nohup`, and why the retry carries it where the prompt marker
deliberately does not.

**The server half was checked and is genuinely unavailable, not skipped.** The
dashboard's spawn contract (`claude-agents-dashboard`, `shared/types.ts`
`SpawnRequest`) has no env field at all — `project`, `prompt`, `name`, `model`,
`effort`, `permissionMode`, `remoteControl`, `resume` and nothing else — and
`server/lib/spawn.ts` builds the child's environment as `{...process.env}` minus
`CLAUDE_CODE_ENTRYPOINT`. There is no channel for `agents.service.ts` to pass
the variable through, so the run's own session keeps its single once-per-run
hold, exactly as the Fix said it would in that case. Adding an env field to
another repo's public spawn API is not this item.

Half 2 was already in place and was not touched: the hook reads the variable at
`stop-notify-hook.sh:122` (`if [ -n "$BM_ORCH_RUN" ]; then`).

### Verification

The two new guards were red before the edit and green after (TDD, red observed
first):

```
$ node --test skills/backlog-orchestrate/tools/orchestrate.test.mjs   # before the SKILL.md edit
not ok 150 - both dispatch lines export the run id to the session they spawn
not ok 151 - the run id assignment sits inside the sh -c body, not in front of nohup
not ok 152 - SKILL.md names no environment variable but the three it owns
# tests 152
# pass 149
# fail 3
```

```
$ pnpm run test:skills
1..365
# tests 365
# pass 365
# fail 0
# duration_ms 56427.356792
```

```
$ pnpm run typecheck
$ tsc --noEmit
(no output, exit 0)

$ pnpm test
Test Suites: 69 passed, 69 total
Tests:       1179 passed, 1179 total
Time:        129.53 s
```

End-to-end proof that the real line — read out of SKILL.md, placeholders
substituted, only the `claude` binary swapped for a stub that prints its
environment and argv — still parses, still lands in the worktree, still hands
the prompt over as one argv element, and now exports the run id:

```
$ PATH=/tmp/bm20/bin:$PATH sh /tmp/bm20/run.sh   # §4 dispatch line
BM_ORCH_RUN=run-20260905-213627
cwd=/tmp/bm20/.worktrees/bug-20
argc=7
arg2=/backlog-execute bug-20 [orchestrator-run run-20260905-213627 item 2 of 7 branch backlog/bug-20: you are dispatched by backlog-orchestrate inside an unattended run. There is no user to ask. Never commit, push or merge. Anything you cannot resolve goes in your final message, not to a person.]

$ PATH=/tmp/bm20r/bin:$PATH sh /tmp/bm20r/run.sh # §5 --resume retry line
BM_ORCH_RUN=run-20260905-213627
argv=-p --resume sess-abc redo the failing verification step --output-format stream-json --verbose --permission-mode auto
```

And the POSIX semantics the placement relies on, checked on this machine rather
than assumed — an assignment prefixing `exec` reaches the exec'd program:

```
$ /bin/sh -c 'cd /tmp && BM_ORCH_RUN=run-20260905-213627 exec env' | grep BM_ORCH_RUN
BM_ORCH_RUN=run-20260905-213627
```

**Inert until published.** Editing `skills/` changes nothing until the merge is
pushed and `pnpm run plugin:sync` runs; until then every dispatched session,
including the one that wrote this, still pays the hold.
