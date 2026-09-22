---
paths: ["server/src/agents/**", "shared/agent.ts"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **A board-started run is visible before its run file exists, from server memory that is never written to disk.** `StartingRunsService` is a
  `Map<project, requestedAt>`, lost on restart on purpose, riding the payload as a separate top-level `starting` array — never a `status: 'starting'` member of
  `runs`. An entry dies on three rules: a run for the project whose `startedAt` is at or after `requestedAt` (never "a `run.json` exists"), age past
  `RUN_STALE_MS`, or a run for that project already `running`, fresh or crashed. Marked from `AgentsController` after the awaited spawn; `resume` is
  deliberately not marked; the Board's chip and the Runs Live sheet both render `starting` with no client-side filter, and a starting row carries no controls
  and cannot be selected — there is no run file for the detail sheet to show. Why:
  [invariants.md](docs/subsystems/invariants.md#a-board-started-run-is-visible-before-its-run-file-exists)
- **Dispatch derives the action; it never accepts one.** `deriveAction` (`shared/agent.ts`) is the single implementation for the board's label and the server's
  validation; dispatch re-scans the file and 409s on disagreement. The prompt is the only client field taken outright; unknown `model`/`effort` drop rather than
  reject; the controller rebuilds the body field by field and checks `action` with `isAgentAction`, never a hand-written comparison chain. `AgentAction` has
  three members and ONE check runs ahead of all of them: `capture` is derived for an out-of-scope item by SECTION, before the `status !== 'open'` check; a
  `done/` item still derives `null`; capture spawns `backlog-capture` for a **new** item citing `from: <id>`, and `moveItem` still refuses every move out of
  `out-of-scope/`. **Nothing here asks what an item's `source` is** — task-45's `source !== 'files' → null` first line was removed by task-46's dispatch lift,
  and re-adding it would hide the control for every tracker item again. `findItem` is a one-line delegate to `ItemsService.find`, so a `gh:<owner>/<repo>#<n>`
  URN resolves to exactly the `BacklogItem` the board drew its button from. Why:
  [invariants.md](docs/subsystems/invariants.md#dispatch-derives-the-action-it-never-accepts-one)
- **`isItemId` accepts three shapes, and `#` is the one metacharacter among them.** `[a-z]+-\d+` (a files id), `#\d+` and the URN
  `gh:<owner>/<repo>#\d+` — still no whitespace, no newline, no quote, no `;`, no `$`. `#` is safe because nothing this predicate guards reaches a shell: the
  dispatch prompt is prose handed over JSON, and the ONE composition that concatenates caller text — the orchestrate prompt — **never carries a `#` because
  `resolveTrackerIds` normalises every accepted id to bare digits before composing** (task-47). That normalisation replaced task-46's "refuse a tracker project
  outright" guarantee, and it is the more fragile of the two — a closed door became one `replace` — so anything that weakens or routes around it is the thing
  to re-check first. Why:
  [invariants.md](docs/subsystems/invariants.md#isitemid-accepts-three-shapes)
- **The orchestrate spawn prompt is composed server-side.** `ORCHESTRATE_PROMPT` (`agents.service.ts`) is the literal `/backlog-orchestrate`; the request body
  has no `prompt` field, so a caller-supplied one is never read. What a caller can influence is enumerated by the composition in `orchestrate()` and nowhere
  else, in this order: `ids` first (each proven by `isItemId` and a per-project scan; 400 for a malformed list, 409 for a disagreeing one; absent means the whole
  queue, explicitly empty is a 400) — ids must stay first, because bare tokens parse as ids and a flag ahead of them swallows the first one — then the
  compile-time literals ` --merge-mode branch` and ` --question-mode decide`, then ` --base <ref>`. Each is appended only off its guard and each default appends
  nothing. **They are not all the same kind of safe**: the two mode flags append compile-time literals, so no caller character reaches the prompt, while `base`
  is the one member whose caller text is appended verbatim and is therefore *proved* (`resolveBase`) rather than clamped. Do not restore any claim that every
  appended flag is a literal. Why: [invariants.md](docs/subsystems/invariants.md#the-orchestrate-spawn-prompt-is-composed-server-side)
- **The browser never talks to the dashboard.** Every call goes board → this API → dashboard; `BM_AGENTS_URL` is env-only; `BM_AGENTS` defaults to off — and
  **compose passes that one through as `${BM_AGENTS:-off}`, never as a literal** (bug-25, pinned by `test/compose-env.test.ts`). `BM_AGENTS_URL` beside it is
  stack topology, not a policy default, so compose overrides it under a **second key** and never interpolates `BM_AGENTS_URL` itself:
  `${BM_AGENTS_DOCKER_URL:-http://host.docker.internal:4173}`. Both halves are pinned — the default string, and that no `${BM_AGENTS_URL…}` appears anywhere in
  the file. Do not collapse the two names back into one. Why: [invariants.md](docs/subsystems/invariants.md#the-browser-never-talks-to-the-dashboard)
- **A project the dashboard cannot see cannot be dispatched to.** Never derive a `dirName` from a path to route around this. The `dispatchGate` membership check
  is a raw string compare, deliberately not realpath. Why:
  [invariants.md](docs/subsystems/invariants.md#a-project-the-dashboard-cannot-see-cannot-be-dispatched-to)
- **One run per project, checked twice.** `orchestrate.mjs init` refuses outright on any `status: "running"` run file, fresh or stale (exit `4`; recover via
  `--resume`/`--abort`, never overwrite). `POST /api/agents/orchestrate` re-checks before it spawns: a _fresh_ run file (`RUN_STALE_MS`) or a `starting` entry,
  both 409 with `RUN_IN_PROGRESS_CODE` — the only two 409s on this endpoint that carry a code. Keep no count of its 409 reasons anywhere. Why:
  [invariants.md](docs/subsystems/invariants.md#one-run-per-project-checked-twice)
- **A resume is serialized at three layers, and only the third one can refuse a resume this app never asked for** (bug-19). (1) The board's Resume control has a
  synchronous in-flight guard and its mark ends on `running` **and `fresh`**. (2) `AgentsService.resume()` takes `WatchdogEntry.resumeSpawnAt` synchronously
  before its next `await`, holds it for `RUN_STALE_MS`, clears it when the spawn throws, and refuses with an **uncoded** 409. (3) `orchestrate.mjs` records a
  driver lease (`driver: { sessionId, at } | null`, identity `CLAUDE_CODE_SESSION_ID`, absent means unclaimed); refusal is exit `7`; `claim` refuses only a run
  that is `running`, fresh and led by another session; `abort` and `unpause` TAKE the lease rather than checking it — that is the rule, not an exception. Why:
  [invariants.md](docs/subsystems/invariants.md#a-resume-is-serialized-at-three-layers)
- **The sweeper's prune keeps `paused` runs, because an entry is no longer only its bookkeeping.** `resumeSpawnAt` lives for `RUN_STALE_MS`, not "while the
  sweeper is interested"; the keep set is built in `sweep()`, not decided inside `prune()`. Why:
  [invariants.md](docs/subsystems/invariants.md#a-resume-is-serialized-at-three-layers)
- **The watchdog spawns; it never writes the run file.** `runs()` stays the one reader; `WatchdogService` only ever calls `AgentsService.resume()`. Attempts,
  phase and the event log live in `WatchdogStateService`, in memory, lost on restart on purpose. `settings/watchdog.json` (`watchdog-config.util.ts`) is the
  server's one write, its own single writer, under its own nested read-write mount. Why:
  [invariants.md](docs/subsystems/invariants.md#the-watchdog-spawns-it-never-writes-the-run-file)
- **The watchdog is armed only while some `run.json` says `running`.** No standing interval — a `setTimeout` chain that disarms the tick it finds none. It arms
  on the board's own runs reads, a boot-time scan, a successful `orchestrate`/`resume` spawn (wired in `AgentsController`, never `AgentsService`) and every
  `POST /api/agents/watchdog/config` save, which calls `arm()` and then an unawaited `tick()`. A run started by typing the trigger with the board never opened
  is never watched. Why: [invariants.md](docs/subsystems/invariants.md#armed-idle-off)
- **Any spawn attempt starts the grace clock; only a success counts against the cap.** `exhausted` is decided before grace. A board resume is a spawn attempt
  too (`WatchdogService.noteBoardResume`, called from the controller BEFORE `arm()`): grace yes, cap no. Why:
  [invariants.md](docs/subsystems/invariants.md#grace-any-attempt-starts-the-clock-only-a-success-counts)
- **Every agents POST is guarded by content-type and origin** (`server/src/agents/origin.guard.ts`) — the one place loopback is NOT the access control.
  `test/agents-origin-guard.test.ts`'s route list is where the guarded set lives, never a count in prose. Absent `Origin` stays allowed; the guard compares host
  and port, not scheme. Why: [invariants.md](docs/subsystems/invariants.md#every-agents-post-is-guarded-by-content-type-and-origin)
