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

- **A. A server boot stamp, kept in the lock (picked).** `/api/health` reports when this server process started; `decide` stores that stamp in the lock it
  takes, `record … failed` on a tracker project asks again, and an API that is down, or whose stamp changed, proves the stack went away under the tick.
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
- Per step, after the existing `step.skip` check and BEFORE the session id is minted (`plugin/lib/run-routine.mjs`, the `randomUUID()` line in the step
  loop): run the gate through the runner's existing `spawnStep('bash', ['-c', <when>], …)` in the step's cwd with the step's env (including
  `CLAUDE_DASHBOARD_ROUTINE`) and a 60 s timeout, not the job's. The session id is minted, and `step-start` carries `session`, only when the gate let the
  step through; a gated-out step's `step-start` has no `session`, exactly like a pin-skipped step's today. Outcome, by the shapes the shell launch already
  returns:
  - exit `0` → launch the claude step as today;
  - exit `10` → `{ exit: 10, outcome: 'skipped', why, tail }`: `why` is the `reason` field when stdout's last line is a JSON object carrying a string
    `reason`, else stdout's last line, either way cut by `short()` to `WHY_MAX_CHARS` (300); `tail` is the gate's combined output through `tailOf` (20 lines,
    8192 chars), so the full JSON line is kept there;
  - any other exit code → `{ exit, outcome: 'failed', why: 'when: exit <n>', tail }`;
  - death by signal → `{ exit: null, outcome: 'failed', why: 'when: signal <SIG>', tail }`;
  - the gate's own 60 s timeout → `{ exit: null, outcome: 'timeout', why: 'when: timeout', tail }`; a wrapper stop while the gate runs →
    `{ outcome: 'stopped', why: 'stopped' }`, the stop path the runner already has. Both count as failed in `end`, as they do for a launched step.
- Files: the key is a field on `RoutineJob` in `shared/types.ts` first (`when: string | null`), then parsed and validated in `shared/routine-file.ts`
  (`parseJob`; the generated `plugin/lib/routine-file.mjs` regenerated by `pnpm plugin:gen`), written by the editor's serializer in
  `client/src/lib/routineForm.ts` in its key order, and run by `plugin/lib/run-routine.mjs`. The Routines editor shows it as a plain text field under
  Limits (placement the builder's). Skip counting, the `step-end` event and the run's `end.skipped` already exist and are reused as they are.
- The tick job files then gain one line. Locating `tick.mjs` from outside a Claude session, where `${CLAUDE_PLUGIN_ROOT}` is not set, uses the plugin's
  `installPath` from `~/.claude/plugins/installed_plugins.json` (my call; the job file is the user's own, so the one-liner lives there, not in either repo):

  ```yaml
  when: node "$(node -p "require(process.env.HOME+'/.claude/plugins/installed_plugins.json').plugins['backlog-manager@backlog-manager-marketplace'][0].installPath")/skills/backlog-tick/tools/tick.mjs" decide --peek
  ```

  **The gate repeats every `decide` flag the job's prompt carries** (`--max-prs`, `--max-plans`, `--base`, `--lock-ttl`), in the same values: a gate
  run with other caps than the session's would skip a tick the session would have worked, and write caps to `last-decide.json` the session never applied.
  Today's five tick jobs carry no flags (`/backlog-manager:backlog-tick` alone), so their gate carries none; a job prompted
  `/backlog-manager:backlog-tick --max-prs 2 --max-plans 3` gets `… decide --peek --max-prs 2 --max-plans 3`. The routine runner does not parse the prompt
  to enforce this — the job file is the one place both lines live, and `SKILL.md`'s `--peek` line says so.

### Fix 2 — `record … failed` releases instead of failing when the API restarted (backlog-manager)

- **Server:** `GET /api/health` answers `{ ok: true, bootedAt: <ISO> }`, `bootedAt` taken once when the process starts. Nothing else reads it today; the
  board does not need it.
- **Tool, at decide:** a tracker `decide` already calls `/api/health` (step 2) before it takes the lock. It keeps the answer's `bootedAt` string and writes
  it into the lock it takes (`lock.bootedAt`), absent when the server sent none. No clock is compared anywhere: `bootedAt` is the container's clock and
  `lock.at` the host's, and the repo already knows those two drift (`server/src/tick/tick.service.ts`, `reset`), so identity of the boot stamp, not
  ordering of two clocks, is the proof.
- **Tool, at record:** in `cmdRecord`, only when the outcome is `failed`, the project is a tracker project, and the lock is ours (`ours` as computed today):
  fetch `/api/health` with the existing `HEALTH_TIMEOUT_MS`.
  - unreachable, non-2xx, or a body that is not JSON → the stack is down now: **environment**, reason `api down`;
  - the lock carries a `bootedAt` string, the answer carries a `bootedAt` string, and the two differ → the server restarted under the tick:
    **environment**, reason `api restarted at <the answer's bootedAt>`;
  - anything else — the lock has no `bootedAt` (taken by an older tool, or from an older server), the answer has none, or they are equal → the outcome
    stays `failed`, exactly as today.
- **Bounded:** an item gets one `released` in a row, never two. When the item's current record (`state.items[id]`) is already `released` and the check says
  environment again, the outcome is `failed` as today (with its hash), reason prefixed `environment twice: `. Why: an execute can itself restart the API
  (a backlog-manager item whose work runs `docker:sync`, say), and an unbounded `released` would re-execute that item every hour forever, invisible to the
  breaker. One release covers the #415 case; a second in a row is the item's own doing until a person says otherwise.
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
  - A tracker `decide` that takes the lock with health answering `bootedAt: "2026-11-13T17:58:00.000Z"` writes that string as `lock.bootedAt`; with health
    answering no `bootedAt`, the lock has no such key.
  - `record` on a tracker project, lock ours, health stub down: outcome `released`, no hash, lock released, item not skipped by the next `decide`.
  - Same, lock `bootedAt: "2026-11-13T17:58:00.000Z"`, health `bootedAt: "2026-11-13T18:01:30.000Z"`: `released`, reason starts
    `environment: api restarted at 2026-11-13T18:01:30.000Z`.
  - Same, both `bootedAt` equal: `failed` with a hash, exactly as today.
  - Same, lock without `bootedAt`, health with one: `failed`. Lock with one, health without: `failed`.
  - Same as the restart case, but the item's current record is already `released`: `failed` with a hash, reason starts `environment twice: `.
  - `record … ok` on a tracker project never calls health (stub counts zero requests).
  - Files project `record … failed` with no API at all: `failed`, as today.
- `tick-breaker.test.mjs` and `test/tick/tick-breaker.test.ts`: one twin row each — a `released` entry between two `failed` ones neither counts nor stops.
- Server: `test/server/app.test.ts`'s `answers /api/health` case asserts the body EXACTLY as `{ ok: true }` today and goes red once `bootedAt` is added;
  it changes to assert `ok: true`, a `bootedAt` that `Date.parse`s, and the same `bootedAt` on a second call. No separate health test file is created.
- Dashboard: parser accepts `when:` on `run: claude`, refuses it on `run: shell` with an error naming the key; the editor's serializer round-trips it.
  Runner: exit `0` launches (one session id, in `step-start`); exit `10` with a JSON `reason` line records `skipped` with that reason as `why` and the
  line in `tail`; exit `10` with plain text uses the last line; exit `3` records `failed`, `why: when: exit 3`; a gate killed by its 60 s timeout records
  `timeout`, `why: when: timeout`; none of the last four launches claude or puts `session` in `step-start`.

## Left to the builder

- Where `when:` sits in the Routines editor, and the exact gate timeout (60 s proposed).
- Whether `peek`'s JSON also carries the would-be `skill`/`args` (harmless; dry-run already does).
- Rule and doc updates the repos require for these paths (`.claude/rules/tick.md`, `docs/subsystems/` tick and routines pages), written as each repo's
  conventions say.
- Order: backlog-manager first (peek, record, execute line — one PR), then the dashboard PR, then the job-file lines once both are installed.
