---
id: bug-3
title: Orchestrate dispatches with a stronger permission flag than it needs
created: 2026-08-31
tags: orchestrate, permissions
---

## Symptom

`backlog-orchestrate` cannot dispatch at all from a session running under the auto-mode
permission classifier. The dispatch line is refused before it runs:

```
Permission for this action was denied by the Claude Code auto mode classifier.
```

The refusal is entirely about `--dangerously-skip-permissions`, which
`skills/backlog-orchestrate/SKILL.md:415` hard-codes into the dispatch. It stopped the
first real end-to-end run (run-20260831-211011) dead at step 4, and the run only
completed because a subagent was substituted for the headless session by hand.

The flag is also stronger than the job needs, and the paragraph justifying it rests on a
premise that is not true of the current CLI.

## Repro

Two probes, run on this machine 2026-08-31 against the installed CLI, both headless and
both with `--permission-mode auto` rather than the flag:

```bash
claude -p "Run the shell command 'sw_vers -productVersion' using Bash …" \
  --permission-mode auto --output-format stream-json --verbose
# TOOL_USE: Bash {"command":"sw_vers -productVersion"} → RESULT: "26.5.1" → FINAL: success

claude -p "Run the shell command 'sudo -n true' using Bash …" \
  --permission-mode auto --output-format stream-json --verbose
# TOOL_USE: Bash {"command":"sudo -n true; echo \"exit=$?\""} → ran; sudo itself refused
# FINAL: success
```

Arbitrary `Bash` ran unprompted under `auto` in both. Neither probe found a call the
classifier actually gated, so `auto`'s refusal boundary is **not** established — see
`## Fix`, this is the gap that has to close before the fix is safe.

`claude --help` lists six modes, not the two the skill's prose implies:

```
--permission-mode <mode>  (choices: "acceptEdits", "auto", "bypassPermissions",
                           "manual", "dontAsk", "plan")
```

## Affects

- `skills/backlog-orchestrate/SKILL.md:415` — the step 4 dispatch line.
- `skills/backlog-orchestrate/SKILL.md:521` — the step 5 retry/resume line, same flag.
- `skills/backlog-orchestrate/SKILL.md:449` — "Why `--dangerously-skip-permissions` is
  acceptable here, and only here", the paragraph whose premise is wrong.
- Section 10's `--resume` path, which instructs both lines be reused "unchanged".
- `shared/agent.ts:62` — `PERMISSION_LADDER` is `plan, acceptEdits, auto,
  bypassPermissions`. It mirrors the dashboard's list and knows nothing of `manual` or
  `dontAsk`. Not wrong, but worth a look if the fix wants to name a mode the ladder
  cannot currently express.

## Cause

Known, and it is one false premise rather than a coding mistake. SKILL.md:449 argues:

> a headless session cannot answer a permission prompt, so a prompt inside one is a
> hang — an unattended run that stops forever with nobody to unstick it

Claude Code's permission-modes documentation says the opposite for a `-p` run with no
`--permission-prompt-tool`: the uncovered action does not run, and Claude keeps
working — *"Claude Code doesn't stop the run in either case."* Uncovered calls are
auto-denied and the session continues. There is no hang to prevent.

With the hang gone, the argument for reaching the top of the ladder goes with it. The
four walls the same paragraph describes — disposable worktree, independent review,
verification gate, merge only by the orchestrator — are all still true and still good;
they just no longer require `bypassPermissions` specifically, because the rung below it
already runs the commands an execute session issues.

`acceptEdits` is genuinely not enough, so this is not an argument for the bottom of the
ladder either: per the same docs it auto-approves file edits plus a fixed list
(`mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed`), and arbitrary `pnpm test` or `git`
still prompt. `auto` is the lowest rung that clears an execute session's real workload.

## Fix

unknown — the direction is clear but one fact is missing and it is the one that matters.

Candidate: replace `--dangerously-skip-permissions` with `--permission-mode auto` on
both dispatch lines, and rewrite SKILL.md:449 to justify the mode actually chosen —
dropping the hang claim, keeping the four walls, and stating what happens instead
(uncovered calls are denied silently and the session carries on).

**What has to be established first:** what headless `auto` actually refuses. Neither
probe above found the boundary. If some command a real execute session needs — a write
under `.git`, an install, a network call — is silently denied, the failure mode is worse
than the one the flag was avoiding: the session does not stop, it improvises, and the
orchestrator receives a plausible-looking diff built on a command that never ran. A hang
is at least loud. Probe the boundary, then decide.

Two things worth settling in the same pass:

- Whether `dontAsk` plus an explicit `--allowedTools` allowlist is the better shape.
  Tighter, and it fails the same silent-denial way — which for a session doing
  work nobody enumerated in advance is probably the wrong trade, but it deserves the
  comparison rather than an assumption.
- Whether the run should record which mode it dispatched under. Right now nothing in
  `run.json` says, so a run whose item came back subtly wrong gives no way to tell
  afterwards whether a denial was involved.
