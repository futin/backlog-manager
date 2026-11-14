# Routine `when:` gate (claude-agents-dashboard half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `run: claude` routine job may carry `when: <shell line>`; the runner runs it before minting a session and skips the step (with the gate's reason)
when it exits `10`, so a tick that would answer `idle`/`busy` costs a `node` call, not a Claude session.

**Architecture:** One optional job key, parsed in `shared/routine-file.ts` (and its generated plugin copy), serialized by the editor's form, and run by
`plugin/lib/run-routine.mjs` in the step loop, through the runner's existing `spawnStep`. Skip counting, `step-end` and `end.skipped` are reused as they are.

**Tech Stack:** TypeScript + tsx test scripts (`test/run-all.ts`), the plugin's plain ESM runner.

**Spec:** `/Users/andrejajevtic/Documents/custom-projects/backlog-manager/docs/superpowers/specs/2026-11-14-tick-session-review-fixes-design.md`, §Fix 1b
(on backlog-manager's `main` once its PR merges; until then in that repo's `.worktrees/tick-review-fixes`).

**Repo:** `/Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard`. Make a worktree off `origin/main` on branch `feat/routine-when-gate`
before the first edit; the main checkout is never edited. Read that repo's `CLAUDE.md` first — its rules win over this plan where they conflict.

**Prerequisite:** none to build and test. To be USEFUL, backlog-manager's `tick.mjs decide --peek` must be installed (that repo's plan, pushed and
`plugin:sync`ed) before any job file carries the gate line.

**This plan gives behaviour, signatures, exact values and exact test cases — never literal code** (the user's standing rule; it overrides the writing-plans
template's code blocks). Disagree with the plan when the code says otherwise, and record the deviation in the task's report.

## Global Constraints

- `when:` is valid on `run: claude` only. On `run: shell` it is a validation error on the `when` line; the message names the key — exact text:
  `when is only for run: claude`.
- Gate timeout: 60 000 ms, from a constant, overridable by the env var `RUN_ROUTINE_WHEN_TIMEOUT_MS` (the precedent is `RUN_ROUTINE_GRACE_MS`,
  `run-routine.mjs:35`) so tests need not wait a minute. Never the job's `timeout:`.
- Gate results, exact shapes:
  - exit `0` → launch claude as today;
  - exit `10` → `{ exit: 10, outcome: 'skipped', why, tail }`;
  - other exit `n` → `{ exit: n, outcome: 'failed', why: 'when: exit <n>', tail }`;
  - signal → `{ exit: null, outcome: 'failed', why: 'when: signal <SIG>', tail }`;
  - gate timeout → `{ exit: null, outcome: 'timeout', why: 'when: timeout', tail }`;
  - wrapper stop during the gate → the runner's existing `stopped` result.
- `why` on exit `10`: when stdout's last non-empty line parses as a JSON object with a string `reason`, that `reason`; else that last line; either way through
  `short()` (`WHY_MAX_CHARS` 300). `tail` is `tailOf(combined)` (20 lines, 8 192 chars).
- The session id is minted, and `step-start` carries `session`, only when the gate exits `0` (or there is no gate). The gate runs AFTER the `step.skip`
  check: a pin-skipped step never runs its gate.
- The gate runs `bash -c <when>` in the step's cwd with the step's env (`CLAUDE_DASHBOARD_ROUTINE` included). A missing cwd stays the existing
  `no such cwd` failure, checked before the gate.

## Review Focus

1. **`step-start` is appended before `launch` today (`run-routine.mjs:279-282`).** The gate must run between the skip check and the `step-start` append —
   or `step-start` must be written without `session` and the gate's verdict decide the launch — so a gated-out step never logs a session that never
   existed. Pinned by Task 2 cases G2–G5 (`'session' in stepStart === false`).
2. **A gate printing nothing and exiting `10`.** `why` must be a non-empty fallback, not `''` — use `when: exit 10`. Pinned by Task 2 case G6.
3. **A gate whose stdout ends with a trailing newline or blank lines.** The last NON-EMPTY line is the one parsed. Pinned by Task 2 case G2 (fixture
   prints the JSON line followed by `\n\n`).
4. **The routine is stopped while the gate runs.** The gate's process group must be killed by the same path a launched step's is, and the run ends
   `stopped`, not `failed`. Pinned by Task 2 case G7.
5. **The editor round-trips a file with `when:` it did not touch.** Editing another field must leave `when:` byte-identical and in key order. Pinned by
   Task 1's serializer case.

---

### Task 1: `when:` in the job type, parser and editor

**Files:**
- Modify: `shared/types.ts:2282-2300` (`RoutineJob` gains `when: string | null`, with a doc comment: claude-only pre-spawn gate; exit 10 skips).
- Modify: `shared/routine-file.ts` — `KNOWN` keys (`:26`), `parseJob` (`:52`), next to the existing claude/shell checks (`:211-214`).
- Regenerate: `plugin/lib/routine-file.mjs` via `pnpm plugin:gen` (never hand-edited).
- Modify: `client/src/lib/routineForm.ts` — `KEY_ORDER` (`:52`, `when` after `timeout`) and the Limits field (`:328-345`), or a field of its own under
  Limits (placement your call; the spec leaves it to the builder).
- Modify: `client/src/components/routines/JobRows.tsx` — `LimitsControl` (`:131`), one plain text input, shown for `kind === 'claude'` only.
- Test: `test/routines/routine-file.test.ts`, `test/routines/routine-form.test.ts`, and `test/guards/plugin-manifest.test.ts` if it pins the generated
  file.

**Interfaces:**
- Produces: `RoutineJob.when: string | null` — the trimmed value, `null` when absent. Task 2 reads it from the generated `routine-file.mjs`.

- [ ] **Step 1: Failing tests.**
  - F1 a `run: claude` job with `when: node x.mjs decide --peek` parses with no errors and `job.when === 'node x.mjs decide --peek'`.
  - F2 the same without `when:` → `job.when === null`.
  - F3 a `run: shell` job with `when: true` → one error on the `when` line, text `when is only for run: claude`.
  - F4 `when:` with an empty value → the parser's existing empty-value error on that line, text `when is empty` (`routine-file.ts:109`).
  - F5 serializer: setting `when` on a claude job writes `when: <value>` after `timeout` in key order; clearing it removes the line; editing `timeout` on
    a file that carries `when:` leaves the `when:` line byte-identical.
- [ ] **Step 2: Run, expect FAIL** — the repo's per-file command (`pnpm exec tsx test/routines/routine-file.test.ts` and the form suite; confirm the
  command from `test/run-all.ts`).
- [ ] **Step 3: Implement**, then `pnpm plugin:gen`.
- [ ] **Step 4: Run, expect PASS**, plus `test/guards/plugin-manifest.test.ts` and the repo's typecheck.
- [ ] **Step 5: Commit** — `feat(routines): a when: gate key for claude jobs`.

### Task 2: the runner runs the gate

**Files:**
- Modify: `plugin/lib/run-routine.mjs` — constants near `:34-35`, the step loop (`:277-288`), and a new method beside `launch` (`:294`), e.g.
  `async gate(job, cwd) → null | StepResult` (`null` = launch).
- Test: `test/routines/run-routine.test.ts` (its own `test()`/`tally` harness and fake `claude` at `:24-30`; reuse `setup`, `log`, `ofKind`, `argvOf`).

**Interfaces:**
- Consumes: Task 1's `job.when`; the existing `spawnStep(cmd, args, opts, input, timeoutMs, combine)`, `short`, `tailOf`, `lastLine`.

- [ ] **Step 1: Failing tests.** Each builds a claude job with a `when:` line; the fake claude records argv, so "launched" = `argv` file exists.
  - G1 `when: true` → claude launched once; `step-start` carries a `session`; argv carries `--session-id` with that same value.
  - G2 `when: printf '%s\n\n' '{"verdict":"idle","reason":"nothing to do: x"}'; exit 10` → not launched; `step-end` `outcome: 'skipped'`,
    `exit: 10`, `why: 'nothing to do: x'`, `tail` contains the JSON line; `end.skipped === 1`, `end.failed === 0`.
  - G3 `when: echo first; echo stack down; exit 10` → `why: 'stack down'`.
  - G4 `when: exit 3` → not launched; `outcome: 'failed'`, `why: 'when: exit 3'`, `exit: 3`; run exit code `1`.
  - G5 `when: sleep 30` with `RUN_ROUTINE_WHEN_TIMEOUT_MS=500` → not launched; `outcome: 'timeout'`, `why: 'when: timeout'`; the sleep's process group
    is gone (reuse the existing `gone(pid)` helper and the `sleep.pid` pattern of the `timeout: 1s` case at `:557`).
  - G6 `when: exit 10` (no output) → `outcome: 'skipped'`, `why: 'when: exit 10'`.
  - G7 `when: sleep 30` and the wrapper gets SIGTERM (the mechanism of the existing `SIGTERM mid-step` case, `:569`) → run ends `stopped: true`, claude not launched, the sleep gone.
  - G8 a pin-skipped step (existing `step.skip` path) with a `when:` that would write a marker file → marker absent (the gate never ran).
  - In G2–G7: `'session' in stepStart === false`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The gate result decides whether a session is minted; `step-start` is appended after the gate with `session` only on launch,
  so ordering in the log is unchanged (`step-start` then `step-end`). A comment says why the gate runs before the session id: a gated-out step must leave no
  session id anywhere, exactly like a pin-skipped one, or the Sessions board and kaizen look for a transcript that never existed.
- [ ] **Step 4: Run the whole runner suite, expect PASS.**
- [ ] **Step 5: Commit** — `feat(routines): run a claude job's when: gate before spawning`.

### Task 3: docs and whole-branch check

**Files:**
- Modify: `docs/subsystems/routines.md` — the job-key table (`:105`) gains a `when` row (claude only, exit codes, 60 s), the Test seams section gains
  `RUN_ROUTINE_WHEN_TIMEOUT_MS`, and one example: the
  backlog-tick gate line from the spec, with the rule that the gate repeats the job's decide flags.

- [ ] **Step 1: Docs**, as listed.
- [ ] **Step 2:** the repo's typecheck, then the touched suites together. Do not push; push, PR and the job-file edits in `~/.claude/routines/jobs/` are the
  user's (held).
- [ ] **Step 3: Commit** — `docs(routines): document the when: gate`.

## After both plans ship (held for the user, not a task)

Each tick job file in `~/.claude/routines/jobs/` gains, in its frontmatter:

```yaml
when: node "$(node -p "require(process.env.HOME+'/.claude/plugins/installed_plugins.json').plugins['backlog-manager@backlog-manager-marketplace'][0].installPath")/skills/backlog-tick/tools/tick.mjs" decide --peek
```

plus every decide flag the job's prompt carries (today none). Their stale "10:00, 12:00…" comments may be fixed in the same edit.
