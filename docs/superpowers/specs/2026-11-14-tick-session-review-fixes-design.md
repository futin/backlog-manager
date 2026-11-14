# Tick session review — three fixes

Date: 2026-11-14. Status: draft for review. Spans two repos: backlog-manager (this one) and claude-agents-dashboard (the routine runner).

## Intent

A review of the last 100 `/backlog-manager:backlog-tick` sessions (2026-10-29 → 2026-11-14, five projects) found the tick doing its job — 28 of 30
executes ended in a PR, 16 of 16 grooms `ok`, the breaker, `recover` and the plan-review gate all behaving — but three avoidable costs:

1. **53 of 100 sessions did nothing** (43 `idle`, 38 of them `nothing to do`; 10 `busy`). Each is a full `claude -p` Opus session at effort high, ~55k
   context, two turns, ~14 s, a row in the run log and in the session list — spent to learn what `tick.mjs decide` alone already knows. ~6M tokens of the
   ~254M total: small in tokens, half of all sessions in count.
2. **An API restart in the middle of a tick burned the item.** #415 on claude-agents-dashboard, 2026-11-13 18:00: `decide` saw a healthy, polled tracker and
   took the lock; the server then restarted, `backlog.mjs show '#415'` found no item in the empty cache, the session recorded `failed`, and #415 was skipped
   until a person ran `tick.mjs forget '#415'`. The session even said "environment, not the item" — but by design the model's judgement cannot pick the
   outcome, so it had no way to say so.
3. **23 wasted tool calls on a zsh quirk.** Executes read their references as `cat a.md; echo ======; cat b.md`. zsh treats a word starting with `=` as
   `=cmd` expansion, `=====` is "not found", the line aborts after the first file, and `pr-mode.md` is read again. 14 + 9 occurrences across 30 executes.

A fourth candidate — launching ticks with a lean plugin set — was measured and dropped: turning six plugins off saved ~2.2k of a ~52k first-turn context
(the rest is the built-in prompt, tool schemas, CLAUDE.md and org-managed plugins). Recorded here so nobody re-proposes it from the raw 55k number.

## Goals

- A tick that would answer `idle` or `busy` costs a few seconds of `node`, not a Claude session — and the run log still says why it did nothing.
- A `failed` that the stack's restart caused is never counted against the item or the breaker, and the proof is mechanical, not the session's judgement.
- An execute reads its reference files without tripping zsh.

## Non-goals

- Reducing the execute's own token cost (89% of all tick tokens) — that is `backlog-execute`'s, shared with the orchestrator, and a separate review.
- A general "blocked" outcome the session may choose. The no-`blocked` rule in `skills/backlog-tick/SKILL.md` stands: the session still only says `ok` or
  `failed`; the TOOL downgrades a `failed` when it can prove the environment.
- Files projects for fix 3. A files project's items do not live behind the API, so a restart cannot make one vanish.
- Changing the hourly schedule or the job files beyond adding the gate line (their stale "10:00, 12:00…" comments may be fixed in passing).

## Anti-goals

- A skipped tick that leaves the board or the dashboard's `tick-capped` push looking at a stale `last-decide.json`. Both read it today; a gate that stops
  it being written is worse than no gate.
- A gate that ever takes, claims or releases a lock, or writes `state.json`. The lock stays the in-session `decide`'s, so a gate that dies mid-way leaves
  nothing behind.
- A silent skip. A halted project, `stack down`, `tracker not polled yet` — every skip carries the reason the session would have printed.

## Approaches considered

**Fix 1 — the gate.**

- **A. `decide --peek` + a routine `when:` gate (picked).** `peek` runs the whole decide ladder without the lock, writes `last-decide.json` exactly where a
  real decide would, and exits on the verdict; the dashboard runs it before spawning `claude -p` and records a skip. Two decides per working tick (a second
  or two of git, `gh` and API reads), and a window between them where the world can change — harmless, the in-session decide is still the authority.
- **B. Reuse `--dry-run` from the dashboard.** No change here, but dry-run deliberately writes nothing, so `last-decide.json` freezes while ticks are
  skipped — the anti-goal above. Rejected.
- **C. The wrapper runs the real decide and hands the verdict to the session.** One decide instead of two, but the lock would be held before `claude` starts
  (a spawn failure leaks it until `--lock-ttl`), and the skill's step 1 changes shape. Rejected.

**Fix 2 — the environment proof.**

- **A. A server boot stamp against the lock time (picked).** `/api/health` reports when this server process started; `record … failed` on a tracker project
  asks for it, and an API that is down, or that booted after the lock was taken, proves the stack went away under the tick.
- **B. The cache's state at record time.** Weaker: the cache refills within about a minute of a restart, usually before the session gets to `record` — the
  #415 cache was very likely full again by then. Rejected.

## Design

### Fix 1a — `tick.mjs decide --peek` (backlog-manager)

- A new flag on `decide`, mutually exclusive with `--dry-run` (both given: exit 1, usage). All the other decide flags pass through and mean the same.
- Runs the same ladder as `decide`, with the same lock semantics as `--dry-run`: no lock written, a stale lock is NOT claimed (the verdict is `recover`, as
  dry-run reports it today), `state.json` untouched.
- Differs from `--dry-run` in exactly one write: on the final `idle` (step 7, "nothing to do") it writes `last-decide.json` as a real decide does
  (`recordCaps`). Every other verdict writes what a dry-run writes — nothing.
- Prints the same ONE JSON line `decide` prints (with `dryRun: true`, and a new `peek: true`), so a person reading the gate's output sees the familiar shape.
- Exit codes: `0` when the verdict would make the session do something — `execute`, `groom`, `recover`; `10` when it would not — `idle`, `busy`; `1` usage;
  `2` runtime (unchanged meanings). `10` is new and used by `peek` only; plain `decide` keeps exiting `0` for every verdict.
- Header comment and `SKILL.md` gain one line each: `--peek` is the scheduler's, never the session's. The skill passes the trigger's flags through
  unchanged and the trigger never carries `--peek`.

### Fix 1b — routine `when:` (claude-agents-dashboard)

- A new optional job key `when:` holding one shell command line, valid on `run: claude` only; on `run: shell` it is a validation error naming the key (a
  shell job can test for itself).
- Per step, before the launch: run `bash -c '<when>'` in the step's cwd with the step's env and a short timeout (60 s, not the job's). Outcome:
  - exit `0` → launch the claude step as today;
  - exit `10` → the step is `skipped`, `why` = the gate's stdout, cut to the existing tail size (for `peek`, that is the JSON line, whose `reason` names
    the cause); no session is created;
  - any other exit, or the timeout → the step is `failed`, `why` = `when: exit <n>` plus the stderr tail; no session is created.
- The parser, writer and validator are `shared/routine-file.ts` (with the generated `plugin/lib/routine-file.mjs` regenerated by `pnpm plugin:gen`); the
  runner is `plugin/lib/run-routine.mjs`; the Routines editor shows the key under Limits (or wherever the builder finds it reads best) as a plain text field.
  Skip counting, the `step-end` event and the run's `end.skipped` already exist and are reused as they are.
- The tick job files then gain one line. Locating `tick.mjs` from outside a Claude session, where `${CLAUDE_PLUGIN_ROOT}` is not set, uses the plugin's
  `installPath` from `~/.claude/plugins/installed_plugins.json` (my call; the job file is the user's own, so the one-liner lives there, not in either repo):

  ```yaml
  when: node "$(node -p "require(process.env.HOME+'/.claude/plugins/installed_plugins.json').plugins['backlog-manager@backlog-manager-marketplace'][0].installPath")/skills/backlog-tick/tools/tick.mjs" decide --peek
  ```

### Fix 2 — `record … failed` releases instead of failing when the API restarted (backlog-manager)

- **Server:** `GET /api/health` answers `{ ok: true, bootedAt: <ISO> }`, `bootedAt` taken once when the process starts. Nothing else reads it today; the
  board does not need it.
- **Tool:** in `cmdRecord`, only when the outcome is `failed`, the project is a tracker project, and the lock is ours (`ours` as computed today, so
  `lock.at` is the time `decide` took it): fetch `/api/health` with the existing `HEALTH_TIMEOUT_MS`.
  - unreachable, non-2xx, or unparseable → the stack is down now: **environment**;
  - `bootedAt` parses and is later than `lock.at` → the stack restarted during the tick: **environment**;
  - `bootedAt` absent (an older server) or not later → the outcome stays `failed`, exactly as today.
- An **environment** result writes outcome `released` (new value) with no `hash`, reason `environment: <api down | api restarted at <bootedAt>> —
  <the session's reason>`, releases the lock as usual, and prints `recorded <id> released (<kind>); lock released` plus one stderr line saying why it was
  not recorded `failed`. Exit `0`.
- Effects, all from existing rules and needing no change: `isSkipped` only skips `failed` with a hash, so the item is eligible at the next tick;
  `streakOf` (both copies) counts only `failed` and stops only on `ok`, so `released` neither counts toward the breaker nor resets it; the board renders an
  unknown outcome as a neutral pill (`TickMonitor.tsx`) and the strip tone as `other` (`client/src/lib/ticks.ts`).
- The `ItemRecord` type comment in `tick-state.mjs` grows `'released'`. `SKILL.md` step 3 gains one sentence: on a tracker project the tool may record a
  `failed` as `released` when the API was down or restarted; the session records `failed` all the same and does not try to choose.
- An `ok` is never touched, and a files project never asks the API.

### Fix 3 — backlog-execute reads references with Read (backlog-manager)

- One imperative sentence in `skills/backlog-execute/SKILL.md`, near the first `references/` pointer (line ~70): read every `references/*.md` file with the
  Read tool, never with `cat` chained in Bash — a `=====` separator is zsh `=cmd` expansion and aborts the line. Its story goes nowhere else; the measurement
  is in this spec.

## Tests (the builder writes them; these are the cases)

- `tick.test.mjs`:
  - `--peek` on a project with nothing to do: exit `10`, JSON `verdict: idle`, `peek: true`, and `last-decide.json` written with the counted caps.
  - `--peek` when a ready task exists: exit `0`, `verdict: execute`, and NO lock file afterwards.
  - `--peek` with a stale lock: exit `0`, `verdict: recover`, the lock still on disk byte-identical, `state.json` unchanged.
  - `--peek` while another tick holds a fresh lock: exit `10`, `verdict: busy`.
  - `--peek --dry-run`: exit `1`.
  - Plain `decide` with nothing to do still exits `0`.
  - `record` on a tracker project, lock ours, health stub down: outcome `released`, no hash, lock released, item not skipped by the next `decide`.
  - Same, health stub `bootedAt` after `lock.at`: `released`, reason names the boot time.
  - Same, `bootedAt` before `lock.at`: `failed` with a hash, exactly as today.
  - Same, health without `bootedAt`: `failed`.
  - `record … ok` on a tracker project never calls health (stub counts zero requests).
  - Files project `record … failed` with no API at all: `failed`, as today.
- `tick-breaker.test.mjs` and `test/tick/tick-breaker.test.ts`: one twin row each — a `released` entry between two `failed` ones neither counts nor stops.
- Server: the health controller test asserts `bootedAt` is an ISO string and stable across two calls.
- Dashboard: parser accepts `when:` on `run: claude`, refuses it on `run: shell`; runner launches on `0`, records `skipped` with the stdout as `why` on `10`,
  `failed` on any other exit and on timeout, and creates no session in the last two.

## Left to the builder

- Where `when:` sits in the Routines editor, and the exact gate timeout (60 s proposed).
- Whether `peek`'s JSON also carries the would-be `skill`/`args` (harmless; dry-run already does).
- Rule and doc updates the repos require for these paths (`.claude/rules/tick.md`, `docs/subsystems/` tick and routines pages), written as each repo's
  conventions say.
- Order: backlog-manager first (peek, record, execute line — one PR), then the dashboard PR, then the job-file lines once both are installed.
