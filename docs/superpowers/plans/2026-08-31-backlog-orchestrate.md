# Backlog Orchestrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override, deliberate and load-bearing:** this plan specifies behaviour,
> exact signatures, and exact test *cases* — **never literal test code, and
> only illustrative implementation code**. Where superpowers:writing-plans
> demands full code blocks, this plan instead gives the implementer the
> contract (names, parameter and return types, expected values, edge cases)
> and makes the *test cases* authoritative. Reason, from repeated experience
> in this codebase and others: handed code gets transcribed verbatim, so a
> bug in the plan becomes a bug in the branch with nobody positioned to catch
> it — test scaffolding is the worst offender. If a test case below seems
> wrong to you, stop and say so; do not transcribe around it. All size
> guidance in this plan is soft.

**Goal:** A fifth plugin skill, `backlog-orchestrate`, that drains a project's groomed queue one headless session per item — worktree-isolated, reviewed, verified, auto-merged to `main` — with crash-safe run-state under `~/.backlog-manager/orchestrator/` and a live board UI (strip, drawer, card badges, toolbar start).

**Architecture:** The skill is prose driving a new CLI tool (`orchestrate.mjs`) that owns every run-file write (atomic, heartbeated, locked). The Nest server gains one read-only runs endpoint (registry pattern: read per request, never write, never cache) and one outbound start endpoint in the agents module (dashboard spawn, existing gates, plus a 409 lock). The client renders everything from the one runs payload.

**Tech Stack:** Node ESM (`.mjs`) + node test runner for the tool; NestJS + jest for the server; React + jsdom jest for the client; `claude -p --output-format stream-json` as the execution vehicle.

**Spec:** `docs/superpowers/specs/2026-08-31-backlog-orchestrate-design.md` — the plan argues from the spec; executors read both.

## Global Constraints

- pnpm only (`packageManager` pinned); never npm/yarn.
- Every server route lives under `/api`; the Vite proxy keeps exactly one entry (`test/vite-proxy.test.ts` asserts it).
- The server never writes anything under `~/.backlog-manager/` — it reads per request, never caches. The orchestrate tool is the run file's only writer.
- Item files: only skills write them; this plan adds no server/client write path.
- Comments explain *why*, at length — match the existing density; do not strip it.
- App tests are flat in `test/`, `*.test.ts(x)`; component suites start with a `@jest-environment jsdom` docblock. Skill-tool tests live next to the tool (`skills/*/tools/*.test.mjs`) and run under node's own runner (`pnpm run test:skills`), not jest.
- TDD per task: failing test first, minimal code, green, commit. One commit per task minimum.
- Shared shapes live in `shared/types.ts`.
- Freshness threshold is **15 minutes** everywhere (tool, server, client copy); the contract-fixture test (Task 2) pins the number on both sides.
- Run-file stage vocabulary (exact strings, used by tool, server types, client): `pending`, `preflight`, `dispatched`, `inspecting`, `reviewing`, `fixing`, `verifying`, `merging`, `merged`, `failed`, `skipped`, `needs-answers`, `ungroomed`, `parked`.
- `claude` may be absent or unauthenticated on CI: nothing in the automated test suites may invoke the real `claude` binary. Dispatch plumbing is tested against fixture stream-json files and stub child processes.

## File Structure

```
agents/backlog-reviewer.md                        (new — plugin's first custom agent)
skills/backlog-orchestrate/SKILL.md               (new — the loop contract, prose)
skills/backlog-orchestrate/tools/orchestrate.mjs  (new — run-state writer + queue gate + watch + verify)
skills/backlog-orchestrate/tools/orchestrate.test.mjs (new — node-runner suite)
skills/backlog-orchestrate/tools/fixtures/        (new — fixture items, stream-json, run.json)
shared/types.ts                                   (modify — run shapes)
server/src/orchestrator/orchestrator.module.ts    (new — read-only runs endpoint)
server/src/orchestrator/orchestrator.controller.ts(new)
server/src/orchestrator/orchestrator.service.ts   (new)
server/src/agents/*                               (modify — orchestrate start endpoint)
client/src/lib/agents.ts                          (modify — runs fetch + start call)
client/src/hooks/useOrchestratorRuns.ts           (new — poll hook)
client/src/components/board/RunStrip.tsx          (new)
client/src/components/board/RunDrawer.tsx         (new)
client/src/components/board/BoardView.tsx         (modify — strip/drawer/badges/toolbar wiring)
client/src/components/board/ItemCard.tsx          (modify — run-stage badge)
client/src/components/board/LaunchSheet.tsx       (modify or sibling variant — orchestrate sheet)
test/orchestrator-*.test.ts(x)                    (new — server + client suites)
test/fixtures/orchestrator-run.json               (new — THE contract fixture, shared by jest and node suites)
CLAUDE.md, docs/invariants.md                     (modify — new invariants, Task 14)
```

---

### Task 1: Risk spikes — `backlog.mjs` inside a worktree; merge mechanics

The spec front-loads these because a failure here invalidates the worktree
strategy. **This task writes no product code and commits nothing**; its
deliverable is a short findings note appended to this plan file under a
`## Task 1 findings` heading (committed with the next task's commit).

**Files:**
- Read: `skills/backlog/tools/backlog.mjs` (how the store root is resolved)
- Append findings to: `docs/superpowers/plans/2026-08-31-backlog-orchestrate.md`

**Interfaces:**
- Consumes: nothing.
- Produces: go/no-go facts later tasks rely on: (a) `backlog.mjs board/show/start/stop` behave identically in a worktree; (b) `git worktree add .worktrees/x -b backlog/x main` works while `main` is checked out elsewhere or not at all; (c) merging `backlog/x` from the main tree with unrelated dirty files succeeds; (d) `.git/info/exclude` hides `.worktrees/`.

- [ ] **Step 1: Worktree + tool probe.** In this repo: `git worktree add .worktrees/spike -b backlog/spike main`, then from inside `.worktrees/spike` run `node <abs path>/skills/backlog/tools/backlog.mjs board --section tasks` and `show <existing-id>`. Expected: identical output to running in the main tree, with the printed absolute path pointing *inside the worktree*. If the tool resolves the registry or the main tree instead, STOP — flag to the human partner; the tool needs a `--repo` pass first and this plan pauses.
- [ ] **Step 2: Marker round-trip in the worktree.** `start <id> --as execute` then `stop <id>` inside the worktree; confirm the item file *in the worktree* gained and lost the marker and the main tree's copy never changed. Expected: main tree file byte-identical throughout.
- [ ] **Step 3: Merge with a dirty main tree.** Touch a scratch tracked file in the worktree, commit on `backlog/spike`; in the main tree (dirty with an unrelated modified file) run `git merge --no-ff backlog/spike`. Expected: merge succeeds; then undo it (`git reset --hard ORIG_HEAD` — confirm the unrelated dirty file survives, because reset --hard only moves tracked content and the dirty file is a *modification*… verify precisely and record what actually happens; if reset endangers it, record `git revert -m 1` as the abort path instead).
- [ ] **Step 4: Exclusion.** Add `.worktrees/` to `.git/info/exclude`; `git status` shows no worktree noise. Record that the skill must do this idempotently per target repo.
- [ ] **Step 5: Clean up** (`git worktree remove`, delete branch, drop scratch commits) and append the findings note to this plan.

### Task 2: Shared run shapes + the contract fixture

**Files:**
- Modify: `shared/types.ts`
- Create: `test/fixtures/orchestrator-run.json`
- Test: `test/orchestrator-shapes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (exact, all exported from `shared/types.ts`):
  - `type RunStage = 'pending'|'preflight'|'dispatched'|'inspecting'|'reviewing'|'fixing'|'verifying'|'merging'|'merged'|'failed'|'skipped'|'needs-answers'|'ungroomed'|'parked'`
  - `interface RunVerification { cmd: string; ok: boolean; tail: string }`
  - `interface RunQueueItem { id: string; title: string; stage: RunStage; sessionId: string | null; worktree: string | null; branch: string | null; fixLoops: number; stageAt: Partial<Record<RunStage, string>>; verification: RunVerification[]; questions: string[]; note: string | null }`
  - `interface RunAttention { id: string; kind: 'needs-answers'|'parked'|'fix-exhausted'; detail: string }`
  - `interface OrchestratorRun { runId: string; project: string; status: 'running'|'done'|'aborted'|'failed'; startedAt: string; updatedAt: string; maxItems: number | null; queue: RunQueueItem[]; attention: RunAttention[] }`
  - `const RUN_STALE_MS = 15 * 60 * 1000` (exported; the one freshness number)
  - `interface OrchestratorRunsPayload { runs: Array<OrchestratorRun & { fresh: boolean; pastRuns: number }> }`
- The fixture is one complete, realistic `OrchestratorRun` as JSON: seven items covering at least stages `merged`, `reviewing`, `pending`, `needs-answers`, `ungroomed`; one `attention` entry of each kind; timestamps as `2026-08-31T…Z` strings. Both jest suites and the node suite load this same file — it is the cross-language schema pin.

- [ ] **Step 1: Failing test.** `test/orchestrator-shapes.test.ts`: imports the fixture with a type assertion to `OrchestratorRun`; asserts (1) `RUN_STALE_MS === 900000`, (2) every `queue[].stage` value is a member of an exact stage-string array written out in the test, (3) fixture round-trips `JSON.parse(JSON.stringify(...))` deeply equal. Case (2) is what catches a stage string drifting anywhere.
- [ ] **Step 2: Run** `pnpm test -- orchestrator-shapes`. Expected: FAIL (types and fixture missing).
- [ ] **Step 3: Add types + fixture.** Follow the density and comment style of the existing `shared/types.ts` blocks; the comment on `RUN_STALE_MS` states why 15 minutes (watch heartbeats at most ~9.5 min apart — Task 5 — so 15 gives one missed beat of slack before the UI declares a run dead).
- [ ] **Step 4: Run again.** Expected: PASS, and `pnpm run typecheck` clean.
- [ ] **Step 5: Commit** (include the Task 1 findings appended to this plan).

### Task 3: `orchestrate.mjs` — run-state core (init/lock, stage, heartbeat, attention, finish, status)

**Files:**
- Create: `skills/backlog-orchestrate/tools/orchestrate.mjs`
- Test: `skills/backlog-orchestrate/tools/orchestrate.test.mjs`
- Create: `skills/backlog-orchestrate/tools/fixtures/` (items for Task 4; started here if convenient)

**Interfaces:**
- Consumes: `test/fixtures/orchestrator-run.json` (copied or path-referenced — the node suite asserts the tool can read the jest fixture verbatim).
- Produces: a CLI, `node orchestrate.mjs <command>`, state rooted at `$BM_ORCH_HOME` when set, else `~/.backlog-manager/orchestrator/` (the env override exists solely so tests never touch the real home). Project key = `encodeURIComponent(<abs project path>)` — reversible with `decodeURIComponent`, no lookup table. Layout per project: `<key>/run.json` (latest) and `<key>/runs/<runId>.json` (archives). All writes atomic: temp file in the same dir, `renameSync` over. Every write re-stamps `updatedAt`.
  - `init --project <abs> [--ids a,b,c] [--max N]` → builds the gated queue (Task 4 wires the gate; until then a `--queue-json <file>` escape hatch used only by tests), archives any existing non-`running` run.json to `runs/`, writes the new run, prints `{ runId, dir }` JSON. **Exit 4, writing nothing**, when a `run.json` exists with `status:"running"` and `updatedAt` fresher than `RUN_STALE_MS`. A *stale* running run is not a lock (crashed run; `--resume`, Task 5, owns it) — plain `init` over it exits 4 too, with a message naming `--resume`/`--abort`, so a crash is never silently buried.
  - `stage <itemId> <stage> [--session S] [--worktree W] [--branch B] [--note S] [--verify-json <file>]` → updates that queue item, stamps `stageAt[<stage>]`, merges the optional fields; unknown itemId or unknown stage string → exit 1, nothing written.
  - `heartbeat` → re-stamps `updatedAt` only.
  - `attention <itemId> --kind <needs-answers|parked|fix-exhausted> --detail <s>` → appends to `attention` (and mirrors `questions` onto the queue item when kind is `needs-answers` and `--questions-json` is given).
  - `finish --status <done|aborted|failed>` → sets run status, final heartbeat.
  - `status [--json]` → prints run.json (exit 3 when none exists).
- Every command exits 0 on success; error exits: 1 bad args/unknown item, 3 no run, 4 lock held.

**Test cases (authoritative; node runner, tmp `BM_ORCH_HOME` per test):**
1. `init` writes a parseable run.json whose shape satisfies the contract fixture's field set exactly (same keys, per queue item and run — compare key sets, not values).
2. `init` twice, second within freshness → exit 4, first file byte-identical after.
3. `init` over a `status:"done"` run → old file lands in `runs/<runId>.json`, new run.json written, `pastRuns` derivable (dir listing length 1).
4. `stage task-5 dispatched --session abc --worktree /tmp/w --branch backlog/task-5` → those three fields set, `stageAt.dispatched` is a parseable ISO timestamp, `updatedAt` strictly newer than before.
5. `stage task-5 nonsense` → exit 1, file unchanged (byte-compare).
6. Atomicity: after any successful command, no `*.tmp` litter remains in the dir.
7. `heartbeat` changes `updatedAt` and nothing else (deep-equal ignoring that field).
8. `attention task-6 --kind needs-answers --detail "which column?"` → attention row appended; run still parses as the contract shape.
9. `status` with no run → exit 3.

- [ ] **Step 1: Write the failing suite** for the cases above (follow the existing `skills/backlog/tools/backlog.test.mjs` house style — `node:test`, tmp dirs, spawnSync of the tool).
- [ ] **Step 2: Run** `pnpm run test:skills`. Expected: new tests FAIL (tool missing).
- [ ] **Step 3: Implement** the tool to the contract. Keep it one file; internal helpers (`readRun`, `writeRunAtomic`, `projectDir`) are plain functions — the CLI switch is thin. Comment the lock/stale distinction at length (why a stale "running" file still refuses plain `init`).
- [ ] **Step 4: Run again.** Expected: PASS, and the pre-existing backlog tool suite still green.
- [ ] **Step 5: Commit.**

### Task 4: `orchestrate.mjs` — queue build + refusal gate

**Files:**
- Modify: `skills/backlog-orchestrate/tools/orchestrate.mjs`
- Test: `skills/backlog-orchestrate/tools/orchestrate.test.mjs` (extend)
- Create: `skills/backlog-orchestrate/tools/fixtures/store/backlog/…` — a fixture store: `bugs/open/`, `tasks/open/`, with the six items the cases below name.

**Interfaces:**
- Consumes: item file layout as `backlog.mjs` writes it (frontmatter + `##` sections; sections `## Plan`, `## Fix`, `## Done when`).
- Produces: `plan --project <abs> [--ids …] [--max N] [--json]` → prints the gated queue *without writing anything* (the UI's queue preview and `init`'s builder are the same code path — `init` calls it internally). Per item: `{ id, title, gate: 'ready'|'ungroomed'|'needs-answers', reasons: string[], questions: string[] }`. Ordering: bugs oldest-first, then tasks oldest-first (file mtime is NOT the order — the id number is; ids are monotonic per store). `--ids` restricts and re-orders to the given sequence; unknown id → exit 1 naming it.
- Gate rules (mirror `backlog-execute`'s prose gate, mechanically): task → `## Plan` must exist with non-empty content before the next `##` heading that is not just `unknown`/whitespace; bug → `## Fix` content must not be exactly `unknown`. Question detection for `needs-answers`: body contains `TBD`, or a line ending in `?` inside `## Plan`/`## Fix`, or a `## Done when` naming a command not present in `verify.json`/`package.json` scripts (this last check is a *warning* question, phrased as one, not a gate failure).

**Test cases:**
1. Fixture task with real Plan → `ready`, empty reasons.
2. Fixture task with `## Plan` heading and only whitespace under it → `ungroomed`, reason names the empty Plan.
3. Fixture task with no `## Plan` heading at all → `ungroomed`.
4. Fixture bug with `## Fix` exactly `unknown` → `ungroomed`.
5. Fixture task with `TBD` in Plan → `needs-answers`, `questions` non-empty, still listed (not dropped).
6. Ordering: bug-2 (older) before bug-7, both before task-1; `--ids task-1,bug-2` yields exactly that order.
7. `--max 2` marks items beyond the second `ready` one as excluded from the run queue `plan` output (field `beyondMax: true`) — the preview shows what a capped run will skip.
8. `plan` never creates or modifies any file under the fixture store or the state dir (byte-compare the tree).

- [ ] **Step 1: Write the failing cases** against the fixture store.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** (frontmatter/section parsing may crib from `backlog.mjs`'s internals *by the same conventions*, but do not import from it — the tools stay standalone; comment why: plugin skills must not couple across skill directories, an install may prune).
- [ ] **Step 4: Run; expect PASS. Remove Task 3's `--queue-json` escape hatch** now that `init` builds real queues, and re-point the affected Task-3 tests at fixture stores.
- [ ] **Step 5: Commit.**

### Task 5: `orchestrate.mjs` — watch, verify, resume-reconcile, abort

**Files:**
- Modify: `skills/backlog-orchestrate/tools/orchestrate.mjs`
- Test: `skills/backlog-orchestrate/tools/orchestrate.test.mjs` (extend)
- Create: fixtures — `stream-init.jsonl` (a realistic `claude -p --output-format stream-json` transcript head including the init event that carries the session id), `stream-noinit.jsonl`.

**Interfaces:**
- Produces:
  - `watch <itemId> --pid <p> --jsonl <file> [--interval-ms 30000] [--budget-ms 540000]` → loops: stamp `heartbeat`, parse the jsonl so-far for the session id (first init-type event; once found, write it via the same code `stage --session` uses), check the pid (`process.kill(pid, 0)`). Exits **0 the moment the pid is gone** (child finished — caller inspects), **3 when the budget elapses with the child still alive** (caller just calls `watch` again — this is how a Bash-tool 10-minute ceiling is survived), **1 on a jsonl parse wedge or missing file after the first interval**. Budget default 540000 (9 min) stays under the Bash cap with slack.
  - `verify <itemId> --cwd <dir> [--json]` → resolves the command list: `<cwd>/backlog/verify.json` (`{ "commands": ["…", …] }`) if present, else `package.json` scripts named exactly `test`, `typecheck`, `build` (in that order, as `pnpm run <name>` when a `pnpm-lock.yaml`/`packageManager` marks pnpm, else `npm run <name>`), plus any fenced ```` ```bash ```` blocks under the item's `## Done when` in `<cwd>`'s copy of the item file. Runs each sequentially in `<cwd>`; records `{cmd, ok, tail}` (tail = last 20 lines) onto the queue item's `verification` via the run file; exit 0 all green, 1 any red, **5 when the resolved list is empty** (the "cannot prove itself" case — caller parks).
  - `reconcile [--json]` → for each non-terminal queue item, reports reality vs record: worktree dir exists?, branch exists?, item file location in the worktree (open/done), `phase:`/`started:` marker present?, pid/session unknown. Prints a per-item suggested action from the fixed set `resume-session | redispatch-after-stop | inspect | park`. **Read-only.**
  - `abort` → walks queue items with worktree/branch recorded: `git worktree remove --force`, `git branch -D`, and for any item whose worktree copy carried a marker, notes it in `attention` (the *skill* runs `backlog.mjs stop` — this tool never touches item files; comment why: item files have exactly one writer family, the backlog skills). Then `finish --status aborted`.
- Consumes: Task 3's `stage`/`heartbeat`; Task 1's finding that `.git/info/exclude` handles `.worktrees/`.

**Test cases:**
1. `watch` against a real short-lived child (`node -e "setTimeout(()=>{},200)"`) with `stream-init.jsonl` → exits 0, session id from the fixture landed in run.json, `updatedAt` moved.
2. `watch` with `--budget-ms 300 --interval-ms 100` against a long-lived child → exits 3, child still alive (test then kills it), at least two heartbeats observed (`updatedAt` sampled between intervals differs).
3. `watch` with `stream-noinit.jsonl` → still exits per pid rules; sessionId stays null; no crash.
4. `verify` in a tmp cwd with `backlog/verify.json` listing one passing and one failing command → exit 1, two verification rows, tails captured, order preserved.
5. `verify` with no verify.json and a package.json with only a `test` script → runs exactly that; exit reflects it.
6. `verify` with nothing resolvable → exit 5, zero rows written.
7. `reconcile` on a run whose recorded worktree was deleted out-of-band → that item's suggestion is `redispatch-after-stop` when a marker is recorded, else `inspect`; run.json untouched.
8. `abort` on a run with one fabricated worktree (a real `git worktree add` in a tmp repo) → worktree gone, branch gone, run status `aborted`.

- [ ] **Step 1: failing cases** (child-process cases use tiny `node -e` children; no `claude` anywhere).
- [ ] **Step 2: Run; expect FAIL.**  
- [ ] **Step 3: Implement.** The jsonl parse tolerates partial trailing lines (the file is being appended live). Comment the exit-code contract at the top of the command switch — the SKILL prose quotes it.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit.**

### Task 6: `agents/backlog-reviewer.md`

**Files:**
- Create: `agents/backlog-reviewer.md`
- Verify against: the caveman plugin's installed layout (`~/.claude/plugins/cache/**/caveman/**/agents/`) as the working example of plugin agent frontmatter; check whether this repo's plugin manifest must declare the dir, and add the declaration if so.

**Interfaces:**
- Produces: an agent invokable as `backlog-manager:backlog-reviewer` once the plugin is synced. Frontmatter: `name: backlog-reviewer`, a `description` that tells the *orchestrator* when to dispatch it, `tools: Read, Grep, Glob, Bash` (Bash for `git diff`; no Edit/Write — reviewers do not fix).
- The body is config-not-code, so it IS written out in full here as the contract the file must carry (wording may be polished, obligations may not):
  1. Input contract: the dispatch prompt supplies `worktree`, `branch`, `item file path`, `report path`. Review `git -C <worktree> diff main...<branch>` against the item's `## Plan`/`## Fix`.
  2. Priorities in order: correctness of the change; adherence to the repo's CLAUDE.md Invariants section (read it from the worktree); test adequacy (do the new tests pin the behaviour the plan promised).
  3. **Output contract, verbatim obligation:** write the FULL report to the given report path. The final message returns ONLY: `verdict: approve` or `verdict: fix`, plus at most the Critical/Important findings, one line each, each naming file:line. No prose walkthrough, no restating the diff, no report body in the message — the report file is where detail lives. (This contract lives here, in the agent definition, precisely because dispatch-prompt copies of it have historically lost to reviewer-template defaults.)
  4. Never stage, commit, edit, or write anything except the report file.

- [ ] **Step 1:** Inspect the caveman plugin's agent layout + this repo's plugin manifest; note the registration mechanism in a code comment at the top of the new file.
- [ ] **Step 2:** Write the agent file per the contract above.
- [ ] **Step 3:** Validate mechanically what can be validated now: frontmatter parses as YAML; `pnpm run test:skills` still green (no tool changes). Full liveness is only provable post-sync — recorded as an explicit checklist line in Task 14.
- [ ] **Step 4: Commit.**

### Task 7: `skills/backlog-orchestrate/SKILL.md`

**Files:**
- Create: `skills/backlog-orchestrate/SKILL.md`

**Interfaces:**
- Consumes: every `orchestrate.mjs` command from Tasks 3–5 (quote their exact exit codes), `backlog.mjs stop`, the reviewer agent from Task 6.
- Produces: the prose contract the headless orchestrator session follows. Frontmatter mirrors the sibling skills (`name`, `description` with trigger phrases, `trigger: /backlog-orchestrate`).

The SKILL body must cover, in this order, each with the actual commands inline the way `backlog-execute` does:

1. **Queue + preview** — `plan` first, always; show the gate table; `--ids`/`--max` pass-through.
2. **Pre-flight per item** — question hunt; AskUserQuestion best-effort with the spec's degradation: on timeout/no-channel, `attention … --kind needs-answers` + `stage <id> needs-answers`, continue. Item-body amendments follow groom's write rules (round-trip unknown keys, body byte-for-byte, write before move).
3. **The loop** — worktree add (plus an idempotent `.git/info/exclude` entry for `.worktrees/` — Task 1 finding (d): that file lives in the repo's *shared common* git dir, so it is one file per repo affecting every worktree's `git status`, and the skill must check for the line before appending), `stage dispatched`, launch `claude -p "/backlog-execute <id>" --output-format stream-json --dangerously-skip-permissions` backgrounded with output to the run dir, then `watch` in a loop while it exits 3. State plainly why `--dangerously-skip-permissions` is safe *here and only here*: disposable worktree, review gate, verify gate, merge as the only door to `main` (spec §Inner-session permissions).
4. **Inspect** — item in `done/` with verification-bearing Outcome → proceed; failure Outcome or dead session → the retry/skip/stop ask, resume via `claude -p --resume <sessionId>`.
5. **Commit** — orchestrator commits in the worktree (conventional subject from the item title; body names the orchestrator as committer and the item id). Execute's own never-commits limit is restated, unchanged.
6. **Review** — dispatch `backlog-manager:backlog-reviewer` with the four input fields; `verdict: fix` → resume executor session with findings, re-commit, re-review; max 2 loops then `attention --kind fix-exhausted` + park (no channel) or the merge-anyway ask (channel).
7. **Verify** — `verify <id> --cwd <worktree>`; exit 5 → park with attention (never merge unproven); exit 1 → treat as fix-loop input.
8. **Merge** — precondition: main tree has `main` checked out (`git symbolic-ref HEAD`) — else `attention --kind parked` and continue; `git merge --no-ff backlog/<id>`; conflict → `git merge --abort`, park, continue. Success → `stage merged`, worktree remove, branch delete. **Undoing an already-completed merge uses `git revert -m 1 <merge-sha>`, never `git reset --hard`** — Task 1 proved empirically that `reset --hard` silently destroys unrelated uncommitted modifications in the main tree, which an unattended run can never rule out (see `## Task 1 findings` (c)). State that rule in the SKILL where the merge is described, with its reason.
9. **Resume/abort** — `--resume`: `reconcile`, act per suggestion (the `redispatch-after-stop` path runs `backlog.mjs stop <id>` in the worktree first — billing the dead interval, the tool's own job); `--abort`: skill clears markers via `backlog.mjs stop` for items reconcile flagged, then `orchestrate.mjs abort`.
10. **Hard limits** — sequential always; never merge red; never force-push; never write the registry; item bodies only in pre-flight; the run file is written only through `orchestrate.mjs`.

- [ ] **Step 1:** Write the SKILL following `backlog-execute`'s voice and density (rules carry their *why* inline).
- [ ] **Step 2:** Cross-check every quoted command and exit code against the implemented tool (`node orchestrate.mjs --help` or the source) — a skill quoting a wrong flag is a runtime failure on some future machine.
- [ ] **Step 3: Commit.**

### Task 8: Server — `GET /api/orchestrator/runs`

**Files:**
- Create: `server/src/orchestrator/orchestrator.module.ts`, `orchestrator.controller.ts`, `orchestrator.service.ts`
- Modify: `server/src/app.module.ts` (import the module)
- Test: `test/orchestrator-runs.test.ts`

**Interfaces:**
- Consumes: `OrchestratorRun`, `RUN_STALE_MS`, `OrchestratorRunsPayload` from `shared/types.ts`; state dir root resolved exactly as the tool resolves it (env override honored: `BM_ORCH_HOME` — the service reads the same variable so tests can point both sides at one tmp dir).
- Produces: `GET /api/orchestrator/runs` → `OrchestratorRunsPayload`. Per project dir: read `run.json` (skip unparseable with a warn log, never 500 the whole payload), `fresh = status==='running' && (now - Date.parse(updatedAt)) < RUN_STALE_MS`, `pastRuns = runs/ dir entry count`. No caching of any kind — read inside the request handler, the registry pattern (say so in a comment pointing at the registry service).

**Test cases (supertest against the Nest app, `BM_ORCH_HOME` at a tmp dir):**
1. Empty/absent state dir → `{ runs: [] }`, 200.
2. One fresh running fixture (the contract fixture with `updatedAt` = now-ish, injected at test setup) → one run, `fresh: true`, queue passed through intact.
3. Same file with `updatedAt` 16 minutes old → `fresh: false`.
4. No-cache proof: request, rewrite the file's `status` to `done`, request again → second response reflects it.
5. A corrupt `run.json` alongside a valid project → valid one returned, 200, corrupt skipped.
6. Route lives under `/api` (the existing vite-proxy test keeps passing untouched).

- [ ] **Step 1: failing suite** per the cases.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** (thin: service does dir walk + parse + freshness; controller returns).
- [ ] **Step 4: Run; expect PASS; typecheck clean.**
- [ ] **Step 5: Commit.**

### Task 9: Server — `POST /api/agents/orchestrate`

**Files:**
- Modify: `server/src/agents/` (controller + service + module as the existing dispatch route is laid out)
- Test: `test/orchestrator-start.test.ts`

**Interfaces:**
- Consumes: the agents module's existing dashboard client, gates and guards (origin guard, content-type guard, `BM_AGENTS` env gate, `dispatchGate` membership check — raw string compare, deliberately not realpath), Task 8's freshness read (via the orchestrator service, injected).
- Produces: `POST /api/agents/orchestrate`, body rebuilt field by field — `{ project: string; model?: string; effort?: string; permissionMode?: string }`, nothing else survives (a `prompt` in the body is dropped, exactly as unknown fields are dropped in dispatch — comment: the prompt is a server-side constant, dispatch's "derive, never accept" applied to orchestration). Behaviour: `BM_AGENTS` off → 404 (same shape as existing agents routes when off); project not visible to the dashboard → the dispatchGate refusal the dispatch route uses; **fresh running run for that project → 409** with a body naming the runId; otherwise spawn via the dashboard with prompt exactly `/backlog-orchestrate`, forwarding model/effort (unknown values drop, never reject) and clamped permissionMode; respond with the dashboard's `{ sessionId }`.

**Test cases:**
1. `BM_AGENTS` unset → 404.
2. Wrong content-type → rejected by the existing guard (mirror the assertion style of the current agents guard tests).
3. Cross-origin `Origin` header → rejected; absent `Origin` → allowed (the guard's documented semantics — reuse its test helpers).
4. Project absent from the dashboard's project list → the same refusal dispatch gives.
5. Fresh `run.json` for the project (tmp `BM_ORCH_HOME`) → 409, dashboard spawn NOT called (assert on the stubbed client).
6. Stale run.json → spawn called.
7. Body `{ project, prompt: "rm -rf" , model: "claude-x" }` → spawn called with prompt `/backlog-orchestrate` and no model (unknown dropped) — assert the exact outbound body.

- [ ] **Step 1: failing suite** (stub the dashboard HTTP client the way existing agents tests do).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expect PASS**, plus the whole existing agents suite green (the controller rebuild rule means touching it risks the dispatch path — the suite is the fence).
- [ ] **Step 5: Commit.**

### Task 10: Client — runs fetch + poll hook

**Files:**
- Modify: `client/src/lib/agents.ts` (add `fetchOrchestratorRuns(): Promise<OrchestratorRunsPayload>` and `startOrchestrate(req): Promise<{sessionId: string}>` — same-origin, same error conventions as the existing fns)
- Create: `client/src/hooks/useOrchestratorRuns.ts`
- Test: `test/orchestrator-hook.test.tsx` (jsdom)

**Interfaces:**
- Produces: `useOrchestratorRuns(): { runs: OrchestratorRunsPayload['runs']; refresh(): void }` — fetch on mount and window focus (the `useAgents` pattern; read that hook first and mirror its listener hygiene), plus an interval that polls every **5s while any run is fresh** and **stops entirely when none is** (focus/mount still refresh — a dead board costs zero background requests; comment why).
- Consumes: Task 8's payload shape.

**Test cases (jsdom, mocked fetch):**
1. Mount → one fetch; payload lands in state.
2. Response with a fresh run → after advancing fake timers 5s, a second fetch fired.
3. Response with only a stale run → advancing 30s fires nothing further.
4. Window focus event → refetch, in both fresh and stale worlds.
5. Unmount → timers and listeners gone (no act warnings, no leaked interval — assert via fake-timer count).

- [ ] **Step 1: failing suite. Step 2: run, FAIL. Step 3: implement. Step 4: run, PASS + typecheck. Step 5: commit.**

### Task 11: Client — RunStrip + card badges

**Files:**
- Create: `client/src/components/board/RunStrip.tsx`
- Modify: `client/src/components/board/BoardView.tsx` (render strips above the columns from `useOrchestratorRuns`; build an `id → stage` map per fresh run and pass each card its stage), `client/src/components/board/ItemCard.tsx` (render the badge), `shared/theme.css`/`client/src/styles.css` per the existing styling split
- Test: `test/orchestrator-strip.test.tsx` (jsdom)

**Interfaces:**
- Consumes: `useOrchestratorRuns`; the run's `project` field matched against the board's item→project association (BoardView already knows each card's project — reuse that source, do not re-derive from paths).
- Produces: `RunStrip({ run, onOpen })` — one strip per fresh run: live dot (heartbeat age < interval renders "live", else the age), `merged/total` where total excludes `ungroomed`, current item id + stage, progress bar, attention count; click → `onOpen(run)`. ItemCard gains optional `runStage?: RunStage` and renders a small chip for the active-ish stages (`dispatched|inspecting|reviewing|fixing|verifying|merging` → shown; `needs-answers` → warning chip; terminal/`pending` → nothing).

**Test cases:**
1. Fresh run → strip in the document with `3/7`-style count computed from the contract fixture (fix the expected numbers against that fixture, e.g. its exact merged and total counts).
2. Stale run → no strip.
3. Two fresh runs, different projects → two strips.
4. Card whose id is `reviewing` in a fresh run → chip text `reviewing`; same board rerendered with the run gone stale → chip gone.
5. Strip click calls `onOpen` with the run.
6. Attention count equals fixture's `attention.length`.

- [ ] **Step 1 failing suite → Step 5 commit** (the TDD cycle as in Task 10).

### Task 12: Client — RunDrawer

**Files:**
- Create: `client/src/components/board/RunDrawer.tsx`
- Modify: `client/src/components/board/BoardView.tsx` (open/close state; ItemDrawer stays untouched)
- Test: `test/orchestrator-drawer.test.tsx`

**Interfaces:**
- Consumes: the selected run object; the ItemDrawer's presentation pattern (overlay, dismiss, aria) — read it first and mirror its accessibility choices (labelled dialog, focus handling, escape/scrim close).
- Produces: `RunDrawer({ run, onClose })`: pipeline chips (merged / active item / queued / attention counts), per-item rows (id, title, stage, fix-loop count when > 0, last verification tail when present), attention section listing each entry's kind + detail + the item's `questions` verbatim, a `pastRuns` line, and a plain-words note when the run is stale ("no heartbeat for N minutes — resume or abort from the terminal"). Read-only; the only interactions are close and (v1) nothing else.

**Test cases:**
1. Contract fixture renders: every queue item id appears; the `needs-answers` item's question text is visible verbatim.
2. Stage chip per row matches the fixture stages.
3. Stale run shows the no-heartbeat note; fresh run does not.
4. Escape and scrim both call `onClose` (mirroring ItemDrawer's behaviour).
5. Fix-loop count renders only when > 0.

- [ ] **Step 1 failing suite → Step 5 commit.**

### Task 13: Client — toolbar Orchestrate control + launch sheet variant

**Files:**
- Modify: `client/src/components/board/BoardView.tsx` (toolbar button), `client/src/components/board/LaunchSheet.tsx` **or** create `client/src/components/board/OrchestrateSheet.tsx` — decide by reading LaunchSheet first: if its item-coupling is shallow, extend with a mode; if deep, sibling component reusing its pieces (state the choice in a comment)
- Modify: `client/src/lib/agents.ts` only if Task 10 left gaps
- Test: `test/orchestrator-start-ui.test.tsx`

**Interfaces:**
- Consumes: `useAgents` (env capability + project visibility — the same signals DispatchButton consumes; read DispatchButton for the hide-vs-disable rule), `useOrchestratorRuns` (lock state), the board's project-filter state, `startOrchestrate` from Task 10, settings seeds `dispatchDefaultModel`/`dispatchDefaultEffort` clamped against `MODELS`/`EFFORTS`, permission default from `plan.defaultMode` clamped to the host ceiling (the LaunchSheet already does this — reuse, don't copy).
- Produces: toolbar **Orchestrate** button rendered only when: board narrowed to exactly one project AND env capability on AND no fresh run for it; project invisible to the dashboard → rendered disabled with the reason in `title` + `aria-describedby` (the dispatch convention). Click → sheet: queue preview table from `plan`-equivalent data — **v1 derives the preview client-side from the board's own items** (`groomed` flags the board already has) and labels it "preview; the run re-gates authoritatively" (comment why: no server endpoint runs the tool, and the tool's gate remains the truth) — model/effort/permission pickers seeded per the invariant, Start button → `startOrchestrate`, success → sheet closes, strip appears on next poll (optimistic `refresh()`).

**Test cases:**
1. Board unfiltered → no button, even with capability on.
2. Narrowed + `BM_AGENTS` capability off → no button at all (hide, not disable).
3. Narrowed + capable + project not dashboard-visible → button disabled with reason in `title`.
4. Narrowed + capable + fresh run → no button (strip owns the space).
5. Sheet pickers seed from settings values, not from any previous launch (set settings, open, assert).
6. Start success path calls `startOrchestrate` with exactly `{ project, model, effort, permissionMode }` and triggers a runs `refresh`.
7. 409 from start → sheet shows the "already running" message and closes into the strip world after `refresh`.

- [ ] **Step 1 failing suite → Step 5 commit.**

### Task 14: E2E on this repo, invariants, docs

**Files:**
- Modify: `CLAUDE.md` (Invariants), `docs/invariants.md` (rationale entries), plugin README if the skills table lives there
- No product code except what E2E shakes out.

**Interfaces:** consumes everything; produces the recorded proof.

- [ ] **Step 0 (blocks step 1): make `agents/` publishable.** Task 6 discovered that an install carries only the paths in `PUBLISHED_PATHS` in `scripts/sync-plugin.mjs` (`skills`, `.claude-plugin`) and, on the marketplace side, `sparsePaths` in the user's `known_marketplaces.json` — so a root-level `agents/` never reaches an installed plugin and `backlog-manager:backlog-reviewer` would not exist post-sync. Add `agents` to `PUBLISHED_PATHS` (a repo change, covered by whatever test guards that script), and tell the human partner that the `sparsePaths` half is machine state on their install: it needs `agents` added there too, or the marketplace re-added, before the agent resolves. Both halves must be true before step 2's liveness check can pass.
- [ ] **Step 1: Sync the plugin** (commit, push, `pnpm run plugin:sync`; new skill + agent load on next Claude Code restart — the publishing-boundary invariant).
- [ ] **Step 2: Agent liveness** — deferred check from Task 6: dispatch `backlog-manager:backlog-reviewer` on a trivial diff; confirm the report file appears and the return message is verdict-shaped only.
- [ ] **Step 3: E2E run** against a *scratch fixture item* filed via `backlog-capture` in this repo (not tasks 2–6, which are real work owned by other plans): groom it trivially, ensure `main` is checked out (session-note: the repo currently sits on a task branch — coordinate with the human partner before this step), run `/backlog-orchestrate --ids <scratch-id>`. Expect: silent clean run, merge commit on `main`, worktree and branch gone, `execute-elapsed` billed once.
- [ ] **Step 4: Kill/resume drill** — start a second scratch run, `kill` the child mid-execute, confirm the strip goes stale at 15m (or temporarily drop `RUN_STALE_MS` via a test build — do not ship the change), `--resume`, confirm `reconcile`'s suggestion path ran `backlog.mjs stop` (one billing, not two) and the item completed.
- [ ] **Step 5: `--abort` drill** — no worktrees, no branches, no markers left; run marked aborted.
- [ ] **Step 6: UI walkthrough** — `pnpm run dev` + `dev:web`, watch a scratch run live: strip, badges, drawer, needs-answers surfacing, toolbar lock (409 on double-start).
- [ ] **Step 7: Write the invariants** (from the spec's "Invariants this adds": run-file single writer/reader; orchestrate as the only committing/merging skill, merge commits only; the per-project lock enforced twice; the server-side constant prompt) into `CLAUDE.md` + rationale into `docs/invariants.md`.
- [ ] **Step 8: Commit** docs; record E2E outputs in the commit body.

---

## Self-review (done at write time)

- **Spec coverage:** queue/gate → T4; pre-flight/questions → T7(§2); loop/worktree/dispatch/watch → T3/T5/T7; commit/review/fix loops → T6/T7; verify + verify.json + park-on-unprovable → T5/T7; merge + conflict/branch guard → T7(§8); run file/lock/heartbeat/resume/abort → T3/T5; reviewer contract → T6; GET runs → T8; POST orchestrate + 409 + constant prompt → T9; strip/badges → T11; drawer → T12; toolbar/sheet/seeding → T13; permissions trade → T7(§3); risks 1–2 → T1; risk 5 (stream-json session id mid-run) → T5 case 1–3; invariants/docs → T14. Spec's risk 3 (registry-vs-worktree visibility copy) → drawer stale/live copy, T12 case 3 + T11 badge-from-run-file design. Risk 4 (lookback) → inherited by reusing the dispatch spawn path, surfaced in T13 case 3's disabled-reason.
- **Placeholder scan:** no TBDs; the two deliberate deferrals (LaunchSheet extend-vs-sibling in T13, agent-registration mechanism in T6) are decisions assigned to the implementer *with the decision rule stated*, not gaps.
- **Type consistency:** stage strings, `RUN_STALE_MS`, payload and CLI names cross-checked; the contract fixture (T2) is the mechanical enforcement for everything downstream.

---

## Task 1 findings

Full report with every command and its output:
`.superpowers/sdd/2026-08-31-backlog-orchestrate/task-1-report.md`. All
probing was done in a disposable `spike-tmp` worktree of this repo (based on
current HEAD, not `main`) and, for the merge/reset/revert mechanics, in a
throwaway synthetic repo under scratch space — nothing here touched the
real `main` branch or working tree. Everything created (worktrees,
branches, the synthetic repo, the temporary `.git/info/exclude` line) was
removed/restored; `git worktree list` is back to the two entries this repo
started with.

**(a) `backlog.mjs board/show/start/stop` behave identically in a worktree — GO.**
`resolveRoot` in `skills/backlog/tools/backlog.mjs` walks up from
`process.cwd()` and stops at the first directory containing a `.git` entry
— a comment there already notes it accepts both a directory (normal clone)
and a file (worktree/submodule) — and returns *that* directory as root. It
never follows a worktree's `gitdir:` pointer back to the main tree. Running
`board --section tasks` and `show task-3` from inside the spike worktree
gave the same items/summaries as the main tree, and `show`'s printed path
pointed inside the worktree. `start --as execute` then `stop` on `task-3`
inside the worktree mutated only the worktree's copy (frontmatter gained
then lost `started:`/`phase:`, gained `updated:`/`execute-elapsed:`); the
main tree's copy was re-hashed (md5) after each step and never changed.
`registerBestEffort` (the registry writer) is only wired into `init`/`new`,
not `board`/`show`/`start`/`stop`, so none of this probing touched the real
`~/.backlog-manager/registry.json`.

**(b) `git worktree add <path> -b <branch> HEAD` works — GO.** Worked from
inside an already-linked worktree (registers against the shared common
`.git` dir) with the base branch checked out elsewhere at the same time —
no lock conflict, since the new branch differs from whatever is currently
checked out. Nested worktrees of the same repository are fine, matching
what the task's context note predicted.

**(c) Merge with a dirty main tree — merge itself is a GO; `reset --hard`
is a NO-GO for abort, use `git revert -m 1` instead.** Verified in a
synthetic repo: `git merge --no-ff backlog/spike` succeeded while an
*unrelated tracked file* had an uncommitted modification, and left that
modification untouched. But undoing the merge with
`git reset --hard ORIG_HEAD` silently discarded that unrelated uncommitted
modification along with the merge — `reset --hard` resets working tree and
index to the target commit in full, with no way to distinguish "changes
from the merge" from "unmodified-by-the-merge but still uncommitted
changes," and there is no reflog-style recovery for a modification that was
never staged or committed. Redid the same scenario and undid the merge with
`git revert -m 1 --no-edit <merge-sha>` instead: the merge's own tree change
was undone by the revert commit, and the unrelated uncommitted modification
survived byte-for-byte. **The orchestrate skill's merge/abort path must use
`git revert -m 1`, never `git reset --hard`, whenever the main tree cannot
be guaranteed clean.**

**(d) `.git/info/exclude` hides the worktree dir — GO, with a design note.**
Confirmed empirically: before adding a line for the spike directory,
`git status --short` showed it as untracked noise; after, it didn't.
Caveat worth designing around: `info/exclude` lives under the **common**
`.git` directory, shared by every worktree of the repo (verified via
`git rev-parse --git-common-dir`) — it is not per-worktree. The skill must
treat it as one shared file per target repo and write to it idempotently
(check whether the line is already present before appending), since editing
it from any worktree affects `git status` output repo-wide, including the
original main tree.
