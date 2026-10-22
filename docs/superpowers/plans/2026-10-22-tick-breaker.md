# Tick Breaker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This plan specifies behaviour, signatures and exact test cases — never literal code.** That overrides writing-plans' "code blocks required": handed code
> gets transcribed, and a bug in the plan becomes a bug in the branch. Where a test step lists cases, write each as its own assertion with the values given;
> where this plan and the spec disagree, the spec wins — say so in the report. Size notes here are soft.

**Goal:** A per-project failure breaker for `/backlog-tick`: N failures in a row halt a project's ticks until a person resets it on a new Runs › Ticks page;
N is set on Shared Settings.

**Architecture:** `tick.mjs decide` derives a streak from `state.json`'s `recent` and the project's `resetAt`, both read from files, and answers `idle`
when halted. The server reads the tick home read-only, owns `~/.backlog-manager/settings/tick.json` (N and the resets) as its one writer, and serves
`GET /api/ticks` plus two guarded POSTs. The client adds a third Runs page and a Shared Settings card.

**Tech Stack:** Node ESM skill tools (`node --test`), NestJS server, React client, jest + jsdom, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-22-tick-breaker-design.md`

## Global Constraints

- `haltAfter`: integer 1–10, default 3. A non-integer in the FILE reads as 3; out-of-range clamps. In a POST body a non-integer is `400`.
- `tick.json` path: `$BM_TICK_FILE`, else `~/.backlog-manager/settings/tick.json`. Tick home: `$BM_TICK_HOME`, else `~/.backlog-manager/tick/`. Both read per
  call, never cached.
- `tick.json` shape: `{ "haltAfter": <int>, "resetAt": { "<abs main-checkout path>": "<ISO>" } }`. One writer: the server. Written tmp + rename.
- Unreadable `tick.json` (I/O error, not JSON, parsed non-object): `decide` → `idle`, reason `<path> unreadable — fix or remove it by hand`; server GET
  `source: "unreadable"` with `haltAfter: 3`; both POSTs `409`, file byte-identical.
- Streak rule (both copies identical): walk `recent` newest first; an unparseable `at` stops the walk (checked FIRST, whatever the outcome); an `at` at or
  before `resetAt` stops; `ok` stops; `failed` counts; any other outcome neither counts nor stops. `since` = the `at` of the oldest counted entry.
- Halted = streak ≥ `haltAfter`.
- Halted verdict reason, exact: `halted: <streak> failures in a row (halt after <N>) — reset on the board, Runs › Ticks`.
- `status` breaker line, exact: `breaker: <streak> of <N> failures in a row` when not halted; `breaker: HALTED — <streak> failures in a row (halt after <N>)
  since <since>` when halted; either followed by ` (reset <resetAt>)` when one is on file.
- Nothing stores a `halted` flag. The server never writes under the tick home.
- Every new server route under `/api`; both POSTs behind `SameOriginPostGuard` (`server/src/agents/origin.guard.ts`).
- Every new client component cites its `.claude/DESIGN.md` subsection in a header comment (follow `WatchdogMonitor.tsx`'s citations).
- Comments explain why, at the repo's density. New prose wraps at 160 columns.
- Never run the full `pnpm test` locally; run the suites each task names. `pnpm run typecheck` after any TS task.

## Review Focus

1. A stray, undecodable or relative-path directory under the tick home (`%E0%A4%A`, `foo`) — GET must skip it, never 500 and blank every project. Test in
   Task 4.
2. A server write racing a `tick.mjs` read — the write must be tmp + rename, leave no temp file behind, and a reader never sees a half file. Test in Task 3.
3. A container clock behind the host's — Reset must stamp `max(now, newest parseable at)`. Test in Task 4.
4. A double-clicked Reset — the button disables while in flight and only one POST leaves. Test in Task 6.
5. `tick.json` unreadable while the Settings card is open — the Select is disabled and the hint names the file; the Ticks page figures still render. Tests in
   Tasks 6 and 7.

---

### Task 1: The breaker core in the skill tools

**Files:**
- Create: `skills/backlog-tick/tools/tick-breaker.mjs`
- Test: `skills/backlog-tick/tools/tick-breaker.test.mjs`

**Interfaces:**
- Produces:
  - `tickSettingsFile(): string` — `$BM_TICK_FILE` or the default path.
  - `readTickSettings(file = tickSettingsFile()): { ok: true, haltAfter: number, resetAt: Record<string,string>, source: 'default' | 'file' } | { ok: false, file: string, error: string }`
    — absent file → `{ ok: true, haltAfter: 3, resetAt: {}, source: 'default' }`. Never throws.
  - `clampHaltAfter(v: unknown): number` — integer → clamped to 1–10; anything else → 3.
  - `streakOf(recent: Array<{at, outcome}>, resetAt: string | undefined): { streak: number, since: string | null }` — `recent` oldest first, as stored.
  - `HALT_DEFAULT = 3`, `HALT_MIN = 1`, `HALT_MAX = 10`.

- [ ] **Step 1: Write the failing tests** — `streakOf` table (oldest → newest; `f` = failed, `o` = ok, ISO times strictly increasing unless noted):
  - `[]` → 0, since `null`
  - `[f]` → 1, since = that entry's `at`
  - `[f, f, o]` → 0
  - `[o, f, f]` → 2, since = the first `f`'s `at`
  - `[f, f, f]` with `resetAt` between the 1st and 2nd → 2
  - `[f, f, f]` with `resetAt` equal to the 2nd's `at` → 1 (at-or-before stops)
  - `[f, f]` with `resetAt` after both → 0
  - `[f, f(at: "garbage"), f]` → 1
  - `[f, f(outcome: "skipped"), f]` → 2
  - `[f, {outcome: "skipped", at: "garbage"}, f]` → 1
  - groom and execute `kind`s mixed, all `f` → counts all
  - `resetAt: "garbage"` → treated as absent
  - `readTickSettings`: absent → default 3/`{}`/`default`; `{"haltAfter":5}` → 5, `resetAt {}`, `file`; `haltAfter` 0 → 1, 42 → 10, `"7"` → 3, 2.5 → 3;
    `resetAt` entry with a non-string or unparseable value is dropped; not JSON → `ok: false` with the path in `file`; `[1,2]` and `null` → `ok: false`;
    a directory at the path (EISDIR) → `ok: false`.
  - `tickSettingsFile()` honours `BM_TICK_FILE`.
- [ ] **Step 2: Run** `node --test skills/backlog-tick/tools/tick-breaker.test.mjs` — expect FAIL (module missing).
- [ ] **Step 3: Implement** in `tick-breaker.mjs`. Header comment: this is one of two copies of the streak rule (the other is Task 3's), kept apart by the
  tools/server import boundary — the `pauseRequestEffective` precedent — and pinned by the same table on each side.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(skills): tick breaker streak and settings reader`.

### Task 2: `decide` halts, `status` reports

**Files:**
- Modify: `skills/backlog-tick/tools/tick.mjs` (`cmdDecide` around the lock step and `readState` call, ~lines 340–390; `cmdStatus` ~690–715)
- Modify: `skills/backlog-tick/SKILL.md` (the `idle`/`busy` bullet, ~line 47, plus one note line)
- Test: `skills/backlog-tick/tools/tick.test.mjs`

**Interfaces:**
- Consumes: Task 1's `readTickSettings`, `streakOf`.
- Produces: `status --json` gains `breaker: { streak, haltAfter, halted, resetAt: string | null, settings: 'default' | 'file' | 'unreadable' }`.

- [ ] **Step 1: Write the failing tests** (use the file's existing fixtures for a files project and `BM_TICK_HOME`). First, the `tick()` harness
  (`tick.test.mjs:87-97`) spreads `process.env`, so pin `BM_TICK_FILE` to a per-fixture path in its `env` for EVERY case — absent by default — or every
  existing case reads the developer's real `tick.json`; update the header comment that counts the env vars the harness pins. Then:
  - streak 2, N 3 (absent file) → `decide` is NOT halted (proceeds to its normal verdict).
  - streak 3, absent file → `{verdict:"idle", reason:"halted: 3 failures in a row (halt after 3) — reset on the board, Runs › Ticks"}`.
  - streak 5, file `haltAfter: 3` → reason starts `halted: 5 failures in a row (halt after 3)`.
  - streak 1, file `haltAfter: 1` → halted; same records, file `haltAfter: 2` → not halted (raising N un-halts with no new record).
  - streak 1, file `haltAfter: 0` → halted (clamped to 1); streak 9, file `haltAfter: 42` → not halted (clamped to 10).
  - streak 3, file `resetAt[root]` later than every record → not halted.
  - a tracker project, stack down, streak 3 → the existing `stack down` verdict, not `halted` (the stack check stays first).
  - streak 3, file `resetAt` holding only a DIFFERENT root (later than every record) → still halted (the reset is per project).
  - file is not JSON, streak 0 → `idle`, reason = `<that path> unreadable — fix or remove it by hand`.
  - a held fresh lock and streak 3 → `busy` `another tick` (busy wins).
  - a stale lock naming a unit, streak 2, N 3 → first `decide` is `recover` and records `failed`; second `decide` is `idle` halted.
  - `--dry-run` with streak 3 → same halted verdict.
  - an unreadable `state.json` → `decide` fails the way it does today (non-zero, the `readState` message), and starts nothing.
  - `status` prints `breaker: 1 of 3 failures in a row`; halted prints `breaker: HALTED — 3 failures in a row (halt after 3) since <at>`; with a reset on
    file, the line ends ` (reset <resetAt>)`.
  - `status --json` carries `breaker` with the five keys; `settings: "unreadable"` when the file is bad.
- [ ] **Step 2: Run** `node --test skills/backlog-tick/tools/tick.test.mjs` — expect the new cases to FAIL.
- [ ] **Step 3: Implement.** In `cmdDecide`, after the lock/recover step and before the runs/items API reads: read settings (unreadable → `say('idle', …)`),
  move the existing `readState(dir)` up to here, derive the streak with `resetAt[root]`, `say('idle', halted reason)` when halted; later code reuses the same
  `state`. `cmdStatus` reads the same two and prints/emits the breaker. SKILL.md: the `idle` bullet names `halted` as one of its reasons; one note line —
  "A halted project is reset on the board (Runs › Ticks), not by `forget`, which only clears one item."
- [ ] **Step 4: Run** `node --test skills/backlog-tick/tools/*.test.mjs` — expect PASS.
- [ ] **Step 5: Commit** `feat(skills): backlog-tick halts after N failures in a row`.

### Task 3: Shared types and the server's breaker util

**Files:**
- Modify: `shared/types.ts` (beside `WatchdogStatus`, ~line 2146)
- Create: `server/src/tick/tick-breaker.util.ts`
- Test: `test/tick-breaker.test.ts`

**Interfaces:**
- Produces (in `shared/types.ts`):
  - `TICK_HALT_LIMITS = { min: 1, max: 10, default: 3 }`
  - `TickRecentEntry { at: string; id: string; kind: string; outcome: string; reason: string }`
  - `TickLock { kind: string; id: string; host: string; at: string }`
  - `TickConfig { haltAfter: number; source: 'default' | 'file' | 'unreadable'; error?: string }`
  - `TickProject { root: string; name: string; streak?: number; halted?: boolean; haltedSince?: string; resetAt?: string; lock: TickLock | null;
    recent: TickRecentEntry[]; error?: string }` — `recent` newest first.
  - `TicksPayload { config: TickConfig; projects: TickProject[] }`
- Produces (in `tick-breaker.util.ts`):
  - `tickFile(env = process.env): string`, `tickHome(env = process.env): string`
  - `streakOf(recent, resetAt): { streak: number; since: string | null }` — same rule and table as Task 1.
  - `readTickFile(file = tickFile()): { ok: true; haltAfter: number; resetAt: Record<string,string>; source: 'default' | 'file' } | { ok: false; file: string; error: string }`
  - `writeTickFile(patch: { haltAfter?: number; resetAt?: Record<string,string> }, file = tickFile()): void` — throws `TickFileUnreadable` (exported
    class) when the current file is unreadable, without touching it; otherwise merges `resetAt` key-wise over the current one and writes tmp + rename.

- [ ] **Step 1: Write the failing tests:** the full Task 1 `streakOf` table; `readTickFile` with the Task 1 `readTickSettings` cases (same expectations);
  `writeTickFile` — from absent creates the file with `haltAfter` 3 when only `resetAt` is patched; patching `haltAfter` keeps an existing `resetAt`; patching
  one `resetAt` key keeps the others; on a not-JSON file it throws `TickFileUnreadable` and the file's bytes are unchanged; after any write the directory
  holds no `.tmp` file (Review Focus 2).
- [ ] **Step 2: Run** `pnpm run test:jest -- tick-breaker` — expect FAIL.
- [ ] **Step 3: Implement.** Header comment says this is the second copy of the streak rule and why (Task 1's reason), and that `tick.json`'s posture is
  `jira.json`'s, stricter on a parsed non-object.
- [ ] **Step 4: Run** the same command plus `pnpm run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(server): tick.json reader/writer and the shared tick types`.

### Task 4: `GET /api/ticks` and the two POSTs

**Files:**
- Create: `server/src/tick/tick.service.ts`, `server/src/tick/tick.controller.ts`, `server/src/tick/tick.module.ts`
- Modify: `server/src/app.module.ts:16` (import `TickModule`)
- Test: `test/tick-routes.test.ts` (supertest via `listenLoopback`, `test/helpers/app.ts`)

**Interfaces:**
- Consumes: Task 3's util and types; `RegistryService` (`server/src/registry/registry.service.ts`) for display names; `SameOriginPostGuard`.
- Produces: `GET /api/ticks` → `TicksPayload`; `POST /api/ticks/config` `{ haltAfter }` → `TicksPayload`; `POST /api/ticks/reset` `{ project }` →
  `TicksPayload`.

- [ ] **Step 1: Write the failing tests** (temp `BM_TICK_HOME`, `BM_TICK_FILE`, registry file):
  - Two projects with distinct roots and distinct `recent`s — A halted (3 × failed), B not (`[failed, ok]`); A sorts nowhere in particular here (sorting is
    the client's); assert each project's `streak`, `halted`, `haltedSince`, and `recent` reversed to newest first.
  - A registered root gets the registry `name`; an unregistered one gets the path's basename.
  - A dir with a `lock` (`{host, verdict:{kind,id}, at}`) and no `state.json` → `recent: []`, `streak: 0`, `lock: {kind, id, host, at}`.
  - A dir with a not-JSON `state.json` → entry with `error`, no `streak`/`halted`.
  - Dirs named `%E0%A4%A` and `foo` are skipped; the response is 200 (Review Focus 1).
  - `config.source` is `default` / `file` / `unreadable` (with `error`, `haltAfter: 3`) for absent / valid / not-JSON files.
  - `POST /config` (fixture file before each write: `haltAfter: 5`, `resetAt` with two roots A and B, distinct times): `{haltAfter: 7}` → file has 7 and
    both `resetAt` keys byte-equal to before; 0 → 1; 42 → 10; `"7"`, `2.5`, `{}` → 400; array body → 400; unreadable file → 409
    and bytes unchanged; cross-origin and non-JSON content-type → refused by the guard.
  - `POST /reset`: non-object body, missing `project`, `project: 42`, `project: "rel/path"` → 400; an absolute path with no tick dir → 404; a known root →
    `resetAt[root]` ≈ now, and the answer shows that project's `streak: 0`; with the fixture file at `haltAfter: 5` and a `resetAt` for B, resetting A keeps
    `haltAfter: 5`, keeps B's `resetAt` byte-equal, and the answer's B row keeps its `streak`, `halted` and `haltedSince`; a known root whose newest `at` is
    10 min in the future → `resetAt[root]` equals that `at` (Review Focus 3); a dir whose `state.json` is not JSON → 200, `resetAt[root]` ≈ now, and its row
    still carries `error`; a dir with a lock and no `state.json` → 200, `resetAt[root]` ≈ now, and the `lock` file byte-identical after; unreadable
    `tick.json` → 409.
- [ ] **Step 2: Run** `pnpm run test:jest -- tick-routes` — expect FAIL.
- [ ] **Step 3: Implement.** Reset's clock guard treats an absent or unreadable `state.json` as "no records" and stamps now — Reset is allowed in every
  state (spec), so it never answers 500 for a broken history. The service builds the payload on every call (no cache); the controller follows `agents.controller.ts`'s `watchdogConfig` for
  guard, `@HttpCode(200)` and body checks; `TickFileUnreadable` → 409 with a message naming the file. Module header says: not an outbound-calling module;
  reads the tick home, writes only `settings/tick.json`.
- [ ] **Step 4: Run** the same command plus `pnpm run test:jest -- vite-proxy agents-origin-guard` and `pnpm run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(server): /api/ticks, its config and reset routes`.

### Task 5: Client lib and hook

**Files:**
- Create: `client/src/lib/ticks.ts`, `client/src/hooks/useTicks.ts`
- Test: `test/ticks-lib.test.ts`, `test/ticks-hook.test.tsx`

**Interfaces:**
- Consumes: Task 3's types.
- Produces:
  - `fetchTicks(): Promise<TicksPayload>`, `updateTickConfig(haltAfter: number): Promise<TicksPayload>`, `resetTicks(project: string): Promise<TicksPayload>`
    — shape-guarded like `fetchWatchdog` (`client/src/lib/agents.ts:720`).
  - `sortTickProjects(ps: TickProject[]): TickProject[]` — halted first; within each group by newest `recent[0].at` descending; then `recent: []`; then
    `error` rows; ties by `name`.
  - `tickActivity(ps: TickProject[], max = 50): Array<TickRecentEntry & { project: string; root: string }>` — merged, newest first, capped.
  - `ticksLast24h(ps: TickProject[], now: number): { total: number; ok: number; failed: number }`.
  - `useTicks(opts?: { live?: boolean }): { data: TicksPayload | null; error: string | null; saveError: string | null; reload(); save(haltAfter: number);
    reset(project: string): Promise<void> }` — built on `useCoalescedFetch`, `armed: live`, `intervalMs: 15_000`; `live: false` reads once on mount.
- [ ] **Step 1: Write the failing tests:** `sortTickProjects` with five projects — two halted (older and newer last tick), one ticking, one `recent: []`, one
  `error` — expected order: newer-halted, older-halted, ticking, empty, error; two `recent: []` rows tie-break by name. `tickActivity` merges two projects'
  interleaved entries newest first and caps at 3 when `max = 3`. `ticksLast24h` counts only entries newer than `now − 24 h`, splitting ok/failed and counting
  other outcomes only in `total`. Hook: `live: false` fetches once and never again after 20 s of fake time; `live: true` re-fetches at 15 s; `save` and
  `reset` replace `data` with the POST's answer; a failed POST sets `saveError` and keeps `data`.
- [ ] **Step 2: Run** `pnpm run test:jest -- ticks-lib ticks-hook` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same plus `pnpm run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(client): tick lib and useTicks hook`.

### Task 6: Runs › Ticks page

**Files:**
- Modify: `client/src/lib/runs-mode.ts:32-35` (add `'ticks'` after `'watchdog'`), `client/src/components/SideRail.tsx:376-379` (`ticks: 'Ticks'`),
  `client/src/components/runs/RunsView.tsx` (a `mode === 'ticks'` branch beside the `'watchdog'` one, ~line 744)
- Create: `client/src/components/runs/TickMonitor.tsx`
- Modify: `client/src/styles.css` (where `.watchdog-table` lives) — only the classes the halted-row tint needs
- Test: `test/tick-monitor.test.tsx`; extend `test/runs-mode.test.ts` and `test/rail.test.tsx`

**Interfaces:**
- Consumes: Task 5's `useTicks`, `sortTickProjects`, `tickActivity`, `ticksLast24h`; `Band`, `Sheet`, `FigureStrip`/`Figure`, `Chip`, `Pill` from `components/ui/`.

Copy, exact (from the spec):
- Band title `Runs · Ticks`; sub `<h> halted · <p> with tick history` (`<h> halted · ` omitted at 0); chip `Policy in Settings ›`, flat, inert, `title`
  `Settings › Backlog tick`.
- Figures: *breaker* `<h> halted` (bad ink when > 0) or `none halted`; line = halted names joined `, `, or `after <N> failures in a row`. *last 24 h*
  `<n>` + unit `ticks`; line `<ok> ok · <failed> failed`. *policy* `halt after` `<N> failures`, `history on` `<p> projects`; line `a reset clears the count,
  not the item records`, or when `source` is `unreadable`: `tick.json cannot be read — showing the default` (my wording; the spec gives no exact string).
- Projects sheet title `Projects`. Halted row: pill `halted`, `<streak> failures in a row since <time> · last: <reason> on <id>`, button `Reset`. Other
  rows: pill `ticking` only when `lock` is set; `last tick <time> · <kind> <id> → <outcome> · <streak> failures in a row`. Error row: muted, the error text,
  no Reset.
- Activity sheet title `Activity`, columns `time` / `outcome` / `project` / `did` / `item` / `what happened`; outcome `✓ ok` (done kind) / `✕ failed` (bad
  kind).
- Empty: band and figures stay; sheets replaced by one: `No project has ticked yet. A tick starts from a scheduled job running /backlog-tick.`
- Unreachable: band stays; one sheet `Could not reach the tick history — <error>. This page will fill in once the API answers GET /api/ticks again.`

- [ ] **Step 1: Write the failing tests:** halted-first row order from a three-project payload; band sub-line text for 1 halted / 2 projects and for 0
  halted; Reset click posts `{project: <that row's root>}` and redraws from the answer (the row loses `halted`); Reset is disabled while its POST is pending
  and a second click sends nothing (Review Focus 4); a failed Reset shows its error under that row; empty payload → the empty sheet AND the three figures;
  `source: "unreadable"` → the policy line names `tick.json` (Review Focus 5); `fetch` rejecting → the unreachable sheet; activity rows newest first with the
  six columns. `runs-mode.test.ts`: `isRunsMode('ticks')` true; the existing `toEqual(['runs', 'watchdog'])` (line 24) becomes
  `['runs', 'watchdog', 'ticks']`. `rail.test.tsx`: the existing tree-labels assertion (lines 101-108, `['History', 'Watchdog']`) becomes
  `['History', 'Watchdog', 'Ticks']` with its test name updated; the Runs tree shows `Ticks` and
  clicking it sets the mode to `ticks`.
- [ ] **Step 2: Run** `pnpm run test:jest -- tick-monitor runs-mode rail` — expect FAIL.
- [ ] **Step 3: Implement** `TickMonitor` with `useTicks({ live: true })`; header comment cites the DESIGN.md subsections `WatchdogMonitor.tsx` cites.
- [ ] **Step 4: Run** the same plus `pnpm run test:jest -- runs-view watchdog-monitor use-runs-mode` and `pnpm run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(client): Runs › Ticks page`.

### Task 7: Shared Settings — "Backlog tick" card

**Files:**
- Create: `client/src/components/settings/TickGroup.tsx`
- Modify: `client/src/components/settings/SettingsView.tsx:215-231` (`SharedPage`: render `TickGroup` under `WatchdogGroup` in the left `set-col` — both
  are machine-wide controls, the right column is host reports; update the header comment that describes the columns)
- Test: `test/settings-tick.test.tsx`

**Interfaces:**
- Consumes: Task 5's `useTicks({ live: false })`; `SettingsGroup`, the Select used by `WatchdogGroup.tsx`, its `saveErrorSlot` pattern.

Copy, exact: group title `Backlog tick`, scope `this machine`; control label `Halt after` … `failures in a row` around a Select of `1`–`10`; hint `A halted
project stops ticking until reset on Runs › Ticks.`; when unreadable, the hint is `<error> — fix or remove the file by hand.` and the Select is disabled.

- [ ] **Step 1: Write the failing tests:** the Select shows the payload's `haltAfter`; picking 5 posts `{haltAfter: 5}` once and shows the answer's value; a
  409 answer shows the save error and keeps the old value; `source: "unreadable"` disables the Select and shows the file hint (Review Focus 5); the card is on
  the Shared page and not the Local one (`settings-view.test.tsx` style).
- [ ] **Step 2: Run** `pnpm run test:jest -- settings-tick settings-view` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same plus `pnpm run test:jest -- settings-watchdog` and `pnpm run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(client): Backlog tick card on Shared Settings`.

### Task 8: Docs, rules, invariants

**Files:**
- Modify: `CLAUDE.md` (Layout: `server/src/` gains `tick/`; "ten path-scoped files" → eleven; two headlines in Invariants)
- Modify: `docs/subsystems/invariants.md` (two new `##` sections; the existing tick-home single-writer section notes the server reads it)
- Create: `.claude/rules/tick.md` (`paths: ["server/src/tick/**"]`) — the `tick.json` headline's mechanism bullet
- Modify: `.claude/rules/skills.md` — the halt-derivation headline's mechanism bullet
- Modify: `docs/subsystems/api.md` (three routes), `docs/subsystems/board.md` (the page, the card), `docs/subsystems/skills.md` (the breaker in `decide`,
  the `status` line)
- Test: `test/claude-rules.test.ts` (existing — must pass unchanged)

Headlines, exact (byte-equal in CLAUDE.md and the rules files):
- **`~/.backlog-manager/settings/tick.json` has exactly one writer, the server, and a file that cannot be read is never replaced.**
- **A tick halt is derived from `state.json`'s `recent` and the reset time, never stored, and only a person's Reset clears it.**

- [ ] **Step 1: Run** `pnpm run test:jest -- claude-rules` before editing — note it passes.
- [ ] **Step 2: Edit** the files above. Each CLAUDE.md headline carries a `Why:` link to its new invariants.md anchor; each rules bullet is anchored exactly
  once (follow the file's existing bullets).
- [ ] **Step 3: Run** `pnpm run test:jest -- claude-rules` — expect PASS.
- [ ] **Step 4: Commit** `docs: tick breaker in CLAUDE.md, invariants, rules and subsystem docs`.
