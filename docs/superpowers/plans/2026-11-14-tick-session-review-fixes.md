# Tick session review fixes (backlog-manager half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tick.mjs decide --peek` (a lock-free pre-spawn gate), a `record … failed` that becomes `released` when the API went away under the tick, and one
line that stops `backlog-execute` reading references through a zsh-breaking `cat` chain.

**Architecture:** All tool changes live in `skills/backlog-tick/tools/tick.mjs` (self-contained — imports nothing from `server/`, `shared/` or another skill's
`tools/`). The server's only change is a boot stamp on `/api/health`. The dashboard's `when:` key, which consumes `--peek`, is a separate plan in a separate
repo: [2026-11-14-tick-session-review-fixes-dashboard.md](2026-11-14-tick-session-review-fixes-dashboard.md), executed after this one ships.

**Tech Stack:** Node ESM CLI under `node --test`; NestJS controller under jest + supertest.

**Spec:** [docs/superpowers/specs/2026-11-14-tick-session-review-fixes-design.md](../specs/2026-11-14-tick-session-review-fixes-design.md)

**This plan gives behaviour, signatures, exact values and exact test cases — never literal code** (the user's standing rule; it overrides the writing-plans
template's code blocks). Where a step names a value, use that value; where it leaves a choice, make it and say so in the commit body. Disagree with the plan
when the code says otherwise, and record the deviation in the task's report.

## Global Constraints

- Branch `feat/tick-review-fixes`, worktree `.worktrees/tick-review-fixes`. Never commit on `main`.
- Tracker item [#565](https://github.com/futin/backlog-manager/issues/565), claimed with `backlog.mjs start #565 --as execute`. A claim reads stale after 15 min
  without a heartbeat, so run `backlog.mjs heartbeat #565` between tasks. The PR body says `Closes #565`. The branch's upstream is `origin/main` from its
  creation, so push with `git push -u origin feat/tick-review-fixes`, never a bare `git push`.
- `tick.mjs` stays self-contained, and `~/.backlog-manager/tick/` keeps exactly one writer, `tick.mjs`.
- `--peek` is mutually exclusive with `--dry-run`: both → exit `1` (usage).
- Exit codes: `0`, `1` usage, `2` runtime, `3` record-under-another-id are unchanged; `10` is new, and only `decide --peek` returns it, for `idle` and `busy`.
- `HEALTH_TIMEOUT_MS` (2 000 ms, `tick.mjs:62`) is the timeout of every health call, old and new.
- New outcome value: `released`, with no `hash`. Reason prefixes, exact: `environment: api down — `, `environment: api restarted at <bootedAt> — `,
  `environment twice: `.
- stdout of an environment record, exact: `recorded <id> released (<kind>); lock released`.
- Comments explain *why*, at length, matching the file's existing density. New prose wraps at 160 columns; commit bodies at 72.
- Editing `skills/` changes nothing installed until commit → push → `pnpm run plugin:sync` (held for the user — do not push).
- Locally run only the suites a task touches (`node --test skills/backlog-tick/tools/<file>.test.mjs`, `pnpm exec jest test/<dir>/<file>`); CI runs all.

## Review Focus

1. **A peek must never leave a lock or touch `state.json`, even on `recover`.** A peek that cleared a stale lock (as a real decide does) would hide a killed
   tick's failure from the session that follows. Pinned by Task 2's stale-lock case (lock byte-identical, `state.json` byte-identical or still absent).
2. **A tracker project whose API sends a non-JSON 200 at record time.** Must read as `api down` (environment), not crash with exit 2 and leave the lock
   held. Pinned by Task 3 case R8.
3. **`record … failed` for an id the lock does NOT name** (`ours` false) on a tracker project with the API down. Must stay `failed`, untouched by the new
   check, and still exit `3`. Pinned by Task 3 case R9.
4. **`released` must not reset the breaker.** A breaker that treated any non-`failed` as a reset would let an item that restarts the API keep the project
   unhalted forever. Pinned by Task 3's twin breaker rows.
5. **A lock written by today's tool (no `bootedAt`) under the new tool.** Must stay `failed` on a restart — the upgrade night must not release anything.
   Pinned by Task 3 case R5.

---

### Task 1: `/api/health` carries a boot stamp

**Files:**
- Modify: `server/src/health/health.controller.ts` (whole file, 9 lines)
- Test: `test/server/app.test.ts:28-30` (the `answers /api/health` case)

**Interfaces:**
- Produces: `GET /api/health` → `200 { ok: true, bootedAt: string }`, `bootedAt` an ISO-8601 string fixed once per process (module load or controller
  construction — your call; it must not change between requests).

- [ ] **Step 1: Change the test.** Replace the exact-body assertion with: status `200`; `body.ok === true`; `typeof body.bootedAt === 'string'` and
  `Number.isFinite(Date.parse(body.bootedAt))`; a second request answers the identical `bootedAt`. No new test file.
- [ ] **Step 2: Run it, expect FAIL** — `pnpm exec jest test/server/app.test.ts -t 'answers /api/health'` (no `bootedAt`).
- [ ] **Step 3: Implement.** Return type becomes `{ ok: true; bootedAt: string }`. A comment says why: `tick.mjs` stores this stamp in its lock and compares
  it by identity at `record` time to prove the server restarted under a tick — identity, because the container's and the host's clocks drift.
- [ ] **Step 4: Run it, expect PASS.** Also `grep -rln "api/health" test/` and run every hit that asserts the body (the dashboards status suites read the
  OTHER service's health — confirm they don't stub this controller).
- [ ] **Step 5: Commit** — `feat(server): stamp /api/health with the process boot time`.

### Task 2: `decide --peek`

**Files:**
- Modify: `skills/backlog-tick/tools/tick.mjs` — header comment (`:5`, `:10-13`), `USAGE` (`:49-54`), `parseDecide` (`:328-344`), and the four
  `opts.dryRun` readers: `say` (`:359`), `recover(ctx, dir, snap, opts.dryRun)` (`:379`), step 7's `recordCaps` (`:468`), `act` (`:486`). Simplest shape
  (your call): `--peek` sets both `dryRun` and `peek`, so three readers need no change and only `:468` becomes "not a dry run, or a peek".
- Test: `skills/backlog-tick/tools/tick.test.mjs`

**Interfaces:**
- Produces: `parseDecide` opts gain `peek: boolean` (default `false`). Every place that tests `opts.dryRun` to decide "write nothing" tests "dry run OR peek"
  instead — except step 7's `recordCaps`, which a peek DOES run. The printed line gains `peek: true` only when peeking, and `dryRun` is `true` under peek
  (spec: "with `dryRun: true`, and a new `peek: true`"). `cmdDecide` returns `10` instead of `0` when peeking and the verdict is `idle` or `busy`.

- [ ] **Step 1: Write the failing tests**, using the file's existing `decide`/`tick` helpers, `writeLockFile`, `ago`, `readJson`, and the fixture shapes the
  `dry-run leaves no lock` (`:356`) and `dry-run recover writes nothing` (`:867`) cases already build:
  - P1 `--peek` with nothing to do → exit `10`; JSON `verdict: 'idle'`, `peek: true`, `dryRun: true`; `last-decide.json` exists with `verdict: 'idle'`
    and the caps the JSON line printed.
  - P2 `--peek` with one ready task → exit `0`; `verdict: 'execute'` and the task's id; no lock file afterwards; no `last-decide.json`.
  - P3 `--peek` with a lock older than `--lock-ttl` → exit `0`; `verdict: 'recover'`; the lock file's bytes equal what was written before; `state.json`
    unchanged (bytes equal, or still absent if the fixture had none).
  - P4 `--peek` with a fresh lock held for another id → exit `10`; `verdict: 'busy'`.
  - P5 `--peek --dry-run` and `--dry-run --peek` → each exit `1`, nothing on stdout, and stderr's FIRST line (the `tick.mjs: …` message, not the USAGE block
    after it, which already contains `[--dry-run]`) names both `--peek` and `--dry-run` and does not contain `unknown argument` — today `--peek` is an
    unknown argument (`tick.mjs:340`), so that line is what fails first.
  - P6 plain `decide` with nothing to do → exit `0` (unchanged; pins that `10` is peek-only).
  - P7 `--peek` on a tracker fixture with `/api/health` unreachable (`DEAD_PORT`) → exit `10`, `verdict: 'idle'`, `reason: 'stack down'`.
- [ ] **Step 2: Run, expect FAIL** — `node --test --test-name-pattern=peek skills/backlog-tick/tools/tick.test.mjs`.
- [ ] **Step 3: Implement** per the Interfaces block. Header comment and `USAGE` show `[--dry-run | --peek]`; the header's "exits 0 for every verdict"
  paragraph gains one sentence: `--peek` is the scheduler's pre-spawn gate (the dashboard's routine `when:` key), never the session's, and exits `10` for
  `idle`/`busy` so a shell can test it — and the gate must carry the same decide flags as the job's prompt.
- [ ] **Step 4: Run the whole file, expect PASS** — `node --test skills/backlog-tick/tools/tick.test.mjs`.
- [ ] **Step 5: Commit** — `feat(tick): decide --peek, a lock-free pre-spawn gate`.

### Task 3: the boot stamp in the lock, and `record … failed` → `released`

**Files:**
- Modify: `skills/backlog-tick/tools/tick.mjs` — `cmdDecide` step 2 (`:370-371`, keep the health body), `act` (`:485-494`, lock gains `bootedAt`),
  `cmdRecord` (`:725-758`).
- Modify: `skills/backlog-tick/tools/tick-state.mjs:172` — the `ItemRecord` comment's outcome union gains `'released'`.
- Test: `skills/backlog-tick/tools/tick.test.mjs`, `skills/backlog-tick/tools/tick-breaker.test.mjs` (pinned table, `:28-46`),
  `test/tick/tick-breaker.test.ts` (pinned table, `:17-34`).

**Interfaces:**
- Consumes: Task 1's `bootedAt` (tests stub it; no live server).
- Produces: lock shape `{ host, verdict, base, at, bootedAt? }` — `bootedAt` present only when the tracker health answer was JSON with a string `bootedAt`.
  A files project never has it. Outcome `released` in `state.items[id]` and `state.recent`, written through the existing `recordOutcome`.

Record decision table (only when outcome is `failed`, the project is a tracker project, and `ours`; every other record is exactly today's path):

| health at record | lock `bootedAt` | health `bootedAt` | current `state.items[id].outcome` | result |
|---|---|---|---|---|
| unreachable / non-2xx / non-JSON | any | — | not `released` | `released`, `environment: api down — <reason>` |
| JSON | string A | string B ≠ A | not `released` | `released`, `environment: api restarted at B — <reason>` |
| JSON | A | A | any | `failed` + hash, reason unchanged |
| JSON | absent | any | any | `failed` + hash, reason unchanged |
| JSON | A | absent | any | `failed` + hash, reason unchanged |
| any environment row above | | | `released` | `failed` (hashed as today — so no hash when the API is down, `tick.mjs:300-306`), `environment twice: <reason>` |

`released` writes no hash (skip `hashFor` — it may itself need the API), releases the lock, prints the exact stdout line from Global Constraints plus ONE
stderr line naming why it was not `failed` (wording yours, starting `tick.mjs: `), and exits `0`. When `--reason` was omitted, the part after ` — ` is
whatever the record would have stored as its reason today.

- [ ] **Step 1: Write the failing tests.** Tracker fixtures via `withApi(trackerRoutes(...))`; override `'/api/health'` per case. Lock files via
  `writeLockFile` with `verdict.id` = the recorded id unless the case says otherwise.
  - L1 tracker `decide` taking an execute, health body `{ status: 'ok', bootedAt: '2026-11-13T17:58:00.000Z' }` → the lock's `bootedAt` is
    `'2026-11-13T17:58:00.000Z'`.
  - L2 same, health body `{ status: 'ok' }` → the lock has no `bootedAt` key (`'bootedAt' in lock === false`).
  - R1 record `failed`, lock ours with `bootedAt` `17:58…`, health on `DEAD_PORT` → stdout `recorded #<n> released (execute); lock released`, exit `0`;
    `state.items['#<n>']` has `outcome: 'released'`, no `hash`, reason starting `environment: api down — `; no lock file.
  - R2 lock `bootedAt: '2026-11-13T17:58:00.000Z'`, health `bootedAt: '2026-11-13T18:01:30.000Z'`, the body route live → `released`, no `hash`, and a
    following `decide --dry-run` against the same stub offers that item (a `failed` here would carry a hash and be skipped — that is what makes this
    assertion discriminate; on R1 the item is eligible either way, because a down API already yields no hash). Reason starts
    `environment: api restarted at 2026-11-13T18:01:30.000Z — `.
  - R3 both `bootedAt` `'2026-11-13T17:58:00.000Z'` → `failed` with a `hash`, reason exactly the `--reason` given.
  - R4 health answers `500` → `released`, `environment: api down — `.
  - R5 lock without `bootedAt`, health with `18:01:30…` → `failed` with hash.
  - R6 lock `17:58…`, health without `bootedAt` → `failed` with hash.
  - R7 as R2, but `state.json` already holds `state.items['#<n>'].outcome === 'released'` (seed it with a first R2-style record, then retake the lock) →
    `failed` with a `hash`, reason starts `environment twice: `.
  - R8 health answers `200` with body text `not json` → `released`, `environment: api down — `.
  - R9 lock names ANOTHER id, health down → recorded `failed` (no environment check), exit `3`, lock still on disk.
  - R10 record `ok` on a tracker project → the health route's request count is `0` and the outcome is `ok`. `withApi` already accepts a function as a
    route (`answer(url)`), so count in a closure; no harness change.
  - R11 files project, record `failed` with no API listening → `failed` with hash, as today.
  - Breaker twins: add one row to each pinned table, beside the existing `skipped` row —
    `['a released outcome neither counts nor stops', [f(1), f(2, { outcome: 'released' }), f(3)], undefined, 2, T(1)]`. Same row, same expected value,
    in `tick-breaker.test.mjs` and `test/tick/tick-breaker.test.ts`.
- [ ] **Step 2: Run, expect FAIL** — `node --test skills/backlog-tick/tools/tick.test.mjs skills/backlog-tick/tools/tick-breaker.test.mjs` and
  `pnpm exec jest test/tick/tick-breaker.test.ts`. The breaker rows may already PASS (the spec says no change is needed there) — that is fine: they pin
  the rule, they don't drive code. Say so in the report.
- [ ] **Step 3: Implement** `cmdDecide` step 2 keeping the parsed health body, `act` adding `bootedAt` from it, and the table above in `cmdRecord` as one
  small helper `environmentOf(lock) → Promise<string | null>` (`null` = not environment; otherwise `'api down'` or `'api restarted at <B>'`). The
  comment above it carries the spec's why: identity not ordering (clock drift, `server/src/tick/tick.service.ts` `reset`), the one-release bound (an
  execute that itself restarts the API), and that the session's judgement never picks the outcome — the tool proves it.
- [ ] **Step 4: Run all three suites, expect PASS.**
- [ ] **Step 5: Commit** — `feat(tick): record a failed tick as released when the API restarted under it`.

### Task 4: skill prose, rules and docs

**Files:**
- Modify: `skills/backlog-tick/SKILL.md` — the decide-flags line (`:31`) and the "no `blocked` outcome" paragraph (`:93-94`).
- Modify: `skills/backlog-execute/SKILL.md:69` region — first `references/` pointer (the "Am I inside a tick?" section).
- Modify: `.claude/rules/skills.md` — the bullet headed **A tick does at most one unit of work…** (the tick mechanism's one rule-file home; `paths:` covers
  `skills/**`). `.claude/rules/tick.md` is about `settings/tick.json` and does not change.
- Modify: `docs/subsystems/skills.md` (`:93` record usage; the `backlog-tick` section heading at `:245`), `docs/subsystems/api.md:559` (health line),
  `docs/subsystems/invariants.md:274` region (the lock paragraph that names `--dry-run`).

- [ ] **Step 1: `backlog-tick/SKILL.md`.** Line 31 gains: the trigger never carries `--peek` — that flag is the scheduler's gate, never the session's.
  The `blocked` paragraph gains one sentence: on a tracker project the tool itself may store a `failed` as `released` when it can prove the API was down
  or restarted under the tick; record `failed` all the same and do not try to choose — `forget` is still how a person clears any other environment
  failure.
- [ ] **Step 2: `backlog-execute/SKILL.md`.** One imperative sentence beside the first `references/` pointer: read every `references/*.md` file with the
  Read tool, never `cat`-chained in Bash — a `=====` separator is zsh `=cmd` expansion and aborts the line after the first file. Nothing more.
- [ ] **Step 3: Rule file.** In `.claude/rules/skills.md`'s tick bullet, append to the mechanism (never the bold headline — CLAUDE.md carries it
  byte-equal, pinned by `test/guards/claude-rules.test.ts`): `decide --peek` runs the same ladder with dry-run's lock semantics (no lock, no stale-lock
  claim, no `state.json`), writes `last-decide.json` only on the final `idle`, and exits `10` for `idle`/`busy`; a tracker lock carries the health answer's
  `bootedAt`, and `record … failed` on a tracker project under its own lock stores `released` (no hash) when health is down or its `bootedAt` differs from
  the lock's, at most once in a row (`environment twice: ` → `failed`). The breaker bullet already says "any other outcome neither counts nor stops" — no
  change there.
- [ ] **Step 4: Docs.** `skills.md`: decide usage shows `--peek` and exit `10`; record usage stays `ok|failed` (the session's vocabulary) with one sentence
  that the tool may store `released`, when, and that `released` neither counts toward nor resets the breaker. `api.md:559`: health is liveness plus a
  `bootedAt` boot stamp that `tick.mjs` compares by identity. `invariants.md` lock paragraph: "every `--dry-run`" becomes "every `--dry-run` and `--peek`"
  (minimal edit, no reflow).
- [ ] **Step 5: Prose guards.** `git grep -ln "backlog-tick/SKILL.md\|backlog-execute/SKILL.md" -- skills/*/tools/*.test.mjs test/` and run every hit;
  then `node --test skills/backlog/tools/backlog.test.mjs` and `pnpm exec jest test/guards`.
- [ ] **Step 6: Commit** — `docs(tick): document --peek and the released outcome; execute reads references with Read`.

### Task 5: whole-branch check

- [ ] `pnpm run typecheck`.
- [ ] Re-run the touched suites from Tasks 1–4 once more, together.
- [ ] `git diff main --stat` lists only the files named above (plus this plan). Do not push; push, PR and `plugin:sync` are the user's (held).
