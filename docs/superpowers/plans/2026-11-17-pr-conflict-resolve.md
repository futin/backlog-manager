# PR conflict resolution from the board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One click on a conflicting GitHub PR starts a headless dashboard session that merges the base into the PR's head, resolves mechanical conflicts,
proves the result, and pushes — or stops, pushing nothing, on any judgment call.

**Architecture:** A new plugin skill `skills/pr-resolve/` owns the procedure (SKILL.md) and its deterministic parts (a self-contained CLI: argument parse,
paths, lock, outcome file). The server adds `POST /api/agents/dispatch-pr-resolve` (derives the trigger, reserves, spawns) and
`GET /api/agents/pr-resolve` (live map + outcome files) in `agents/`, over two new public reads on `PullRequestsService`. The client adds a `Resolve
conflicts` row to the PR merge menu and one status line under the strip, fed by the PR provider's existing 60 s tick.

**Tech Stack:** NestJS (server), React + Vite (client), jest (+ jsdom) and `node --test` (skill tool), pnpm.

**Spec:** [docs/superpowers/specs/2026-11-17-pr-conflict-resolve-design.md](../specs/2026-11-17-pr-conflict-resolve-design.md) — executors read both.

**How to read this plan (override of the writing-plans template):** tasks specify behaviour, signatures, exact strings and exact test cases — never literal
code bodies. Where a test step shows code it is the assertion list, not scaffolding to transcribe. If the implementer disagrees with a signature or a case,
say so in the task report rather than silently deviating. Any size figure here is soft.

**No mocks:** the spec decided "no mock round" (one menu row and one chip in the existing vocabulary, `.claude/DESIGN.md` §8.11). Tasks that draw a view cite
that section and the existing `PrActions` row anatomy instead of a mock file. The last task is `/ui-verify`.

## Global Constraints

- Every server route under `/api`; every agents POST under `@UseGuards(SameOriginPostGuard)` and in `test/agents/agents-origin-guard.test.ts`'s list.
- The server never writes git, never spawns git, and never writes under `~/.backlog-manager/pr-resolve/` — it only reads there.
- `~/.backlog-manager/pr-resolve/` (override `$BM_PR_RESOLVE_HOME`, read per call) has exactly one writer: `skills/pr-resolve/tools/pr-resolve.mjs`.
- The skill tool imports nothing from another skill's `tools/`, `server/` or `shared/`; it ends `process.exitCode = main(…)`, never `process.exit`.
- Dispatch derives the action: the POST body is `{ repo, number }` and nothing else is read. No model, effort, prompt or mode crosses the wire.
- The spawn carries `model: DEFAULT_MODEL` (by passing no `model`) and no `effort` key; `permissionMode: clampMode('auto', status.spawnMaxPermission)`
  (item dispatch's default); `remoteControl: false`; home machine only.
- Exact strings (server): `body must be { repo: "owner/name", number }`; `<repo> is not the repo of a registered GitHub project`; `syncOffBlock`'s sentence
  unchanged; `BM_GITHUB_TOKEN is not set on this machine`; `could not read <repo>#<n> from GitHub`; `<repo>#<n> is not open`;
  `<repo>#<n> is from a fork — the session cannot push to it`; `GitHub is still computing mergeability — try again in a moment`;
  `<repo>#<n> has no conflicts`; `a resolve of <repo>#<n> is already running`.
- Exact strings (client): label `Resolve conflicts`; sub `merge <base> in with a headless session`; reasons `sync off`, the gate's own `disabled` text,
  `fork — cannot push`, `mergeability pending`, `no conflicts`, `resolving…`, `resolved — waiting for GitHub`, `prRunWarning`'s text unchanged; chips
  `resolving…`, `resolved — waiting for GitHub`; note `resolve stopped: <reason>` with link text `session ↗`. None joins `REPO_REASONS`.
- Exact strings (skill): final lines `pr-resolve: pushed`, `pr-resolve: up to date — nothing pushed`, `pr-resolve: stopped — <one-line reason>`; lock stop
  reason `another resolve of #<N> is running`.
- Timings: live grace `JIRA_LIVE_GRACE_MS` (120 000 ms, imported, not copied); lock stale age 3 h (10 800 000 ms).
- Wrap new prose at 160 columns; comments explain why, at the repo's density. New files cite their `.claude/DESIGN.md` subsection (client) or spec (server).
- Never `git add -A`; stage by path.

## Review Focus

1. **A missing or half-written outcome file** (fresh machine with no `pr-resolve/` dir; a file truncated by a crash; a hand-edited one) → `GET
   /api/agents/pr-resolve` still answers, skipping what it cannot parse. Pinned in Task 4.
2. **The agents status not landed yet** → the Resolve row is not drawn at all (no flash of an enabled row that then hides). Pinned in Task 6.
3. **A double click before the POST answers** → the second click is swallowed (the row is disabled while the page's in-flight set holds the PR). Pinned in
   Task 6.
4. **A resolve entry for a PR the list no longer shows** (merged or closed meanwhile) → ignored by the client, nothing throws. Pinned in Task 6.
5. **A leftover lock written by a terminal run** (`sessionId: null`) → the route cannot prove it dead by id: younger than 3 h → 409 already running; older →
   plain trigger (the tool reclaims by age). Pinned in Task 4. (This case is the plan's call; the spec's rung 7 names only a lock with an id.)

---

### Task 1: Skill tool — `pr-resolve.mjs` and its lib

**Files:**
- Create: `skills/pr-resolve/tools/pr-resolve-lib.mjs`, `skills/pr-resolve/tools/pr-resolve.mjs`
- Test: `skills/pr-resolve/tools/pr-resolve.test.mjs` (node runner — sits at the `tools/` level, the glob does not descend)
- Modify: `skills/backlog/tools/backlog.test.mjs` — `CLI_SOURCES` (line ~3519, name → absolute path) gains a `'pr-resolve.mjs'` key resolved from
  `../../pr-resolve/tools/pr-resolve.mjs` the way its siblings are; `ENTRY_SHAPES` (line ~3560) gains
  `'pr-resolve.mjs': ['process.exitCode = main(']`

**Interfaces — Produces (lib, all synchronous):**
- `parseTarget(arg: string): { owner, name, repo, number } | null` — accepts exactly `^([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)#([1-9][0-9]*)$`.
- `prResolveHome(env = process.env): string` — `env.BM_PR_RESOLVE_HOME || ~/.backlog-manager/pr-resolve`, read per call.
- `fileKey(repo: string, number: number): string` — `<owner>__<name>__<N>` (owner never contains `_` on GitHub, so the key splits back unambiguously; the
  server relies on this).
- `paths(cwd, home, target)` → `{ tree: <cwd>/.worktrees/pr-resolve-<N>, baseTree: <cwd>/.worktrees/pr-resolve-<N>-base,
  lockFile: <home>/locks/<key>.lock, outcomeFile: <home>/<key>.json }`.
- `takeLock(lockFile, { sessionId, now, reclaim }): { taken: true, recovered: boolean } | { taken: false }` — exclusive create (`wx`); on `EEXIST`, judge the
  raw content stale (age > 3 h by `at`; unparseable → by file mtime; or `reclaim !== null && lock.sessionId === reclaim`); a stale lock goes through
  `claimStale`, then a fresh `wx` take; any lost race → `{ taken: false }`.
- `claimStale(lockFile, judgedRaw): string | null` — TWIN of `skills/backlog-tick/tools/tick-state.mjs` `claimStaleLock` (rename aside to
  `<lock>.recover-<pid>-<hex>`, re-read equals `judgedRaw`, else restore via `link`/`EEXIST`-wins and remove the claimed name). Its comment names the
  original and says why it is copied (self-contained rule).
- `releaseLock(lockFile, sessionId)` — removes the lock only when its recorded `sessionId` equals `sessionId` (`null` matches `null`); otherwise leaves it.
- `writeOutcome(outcomeFile, { sessionId, outcome, reason, fromSha, headSha, now })` — temp file in the same dir plus `rename`; creates the dir; writes
  `{ sessionId, outcome, reason, fromSha, headSha, at }` (`at` ISO).

**CLI (`pr-resolve.mjs`), exit 0 ok / 2 usage / 3 lock refused; JSON on stdout, one line:**
- `parse <owner/repo#N> [--reclaim <id>]` → `{ repo, number, reclaim, tree, baseTree, lockFile, outcomeFile }`; malformed → stderr `not owner/repo#N: <arg>`,
  exit 2.
- `lock take <target> [--reclaim <id>]` → `{ taken: true, recovered }`; on `recovered`, also `git worktree remove --force` each of `tree`/`baseTree` that exists
  and `git worktree prune`, run in cwd (async-free `execFileSync`, git errors reported in the JSON as `cleanup: [<message>…]`, never fatal). Refused →
  `{ taken: false, reason: "another resolve of #<N> is running" }`, exit 3.
- `lock release <target>` → `{ released: boolean }`.
- `outcome <target> --outcome pushed|stopped|up-to-date --reason <text> --from <sha> [--head <sha>]` → `{ written: <path> }`; `--head` required for `pushed`;
  for the other two it defaults to `--from` and a different value is a usage error.
- `sessionId` everywhere is `process.env.CLAUDE_CODE_SESSION_ID`, or `null` when unset or empty.

- [ ] **Step 1: Write the failing tests** — every case uses a fresh temp dir as `BM_PR_RESOLVE_HOME` (via the `scripts/test-tmpdir.mjs` convention the
  other tool suites use):
  - `parseTarget`: `acme/web#12` → `{ owner:'acme', name:'web', repo:'acme/web', number:12 }`; `acme/web.js#3` accepted; `acme/web`, `acme/web#0`,
    `acme/web#-1`, `acme/web#1x`, `acme_x/web#1`, ``, `acme/web#12 ` → `null`.
  - `fileKey('acme/my__lib', 12)` → `acme__my__lib__12`; `parseTarget('acme/my__lib#12')` accepted (the split back is Task 4's `parseFileKey`, tested there).
  - `paths` with cwd `/r`, home `/h`, `acme/web#12` → tree `/r/.worktrees/pr-resolve-12`, baseTree `/r/.worktrees/pr-resolve-12-base`, lock
    `/h/locks/acme__web__12.lock`, outcome `/h/acme__web__12.json`.
  - `takeLock` fresh → `{ taken:true, recovered:false }` and the file holds `{ sessionId:'s1', at }`; a second `takeLock` with `s2` → `{ taken:false }`.
  - Stale by age: a lock with `at` 3 h + 1 s before `now` → `s2` takes it, `recovered: true`; 3 h − 1 s → refused.
  - Stale by reclaim: lock `s1` fresh; `takeLock(…, { sessionId:'s2', reclaim:'s1' })` → taken, recovered; `reclaim:'s9'` → refused.
  - Lock with `sessionId: null`, fresh, `reclaim: null` → refused (a null never matches a reclaim).
  - Two claimers: write a stale lock, read its raw once, call `claimStale(lock, raw)` twice → first returns a path, second `null`; and a claim whose re-read
    differs from `judgedRaw` restores the newer lock (`claimStaleLock`'s own case shape in `tick-state.test.mjs`).
  - `releaseLock`: matching id removes; a different id leaves the file; `null`/`null` removes.
  - `writeOutcome`: file shape exactly `{ sessionId, outcome, reason, fromSha, headSha, at }`; no `*.tmp` left in the dir; `sessionId: null` when the CLI runs
    with `CLAUDE_CODE_SESSION_ID` unset.
  - CLI: `parse acme/web#12` → `reclaim: null`; `parse acme/web#12 --reclaim s1` → `reclaim: 's1'`; `--reclaim` with no value → exit 2;
    `parse acme/web` → exit 2, stderr `not owner/repo#N: acme/web`; `lock take` twice → second exit 3 with the exact reason; `outcome … --outcome
    stopped --from aaa --head bbb` → exit 2; `outcome … --outcome pushed --from aaa` (no head) → exit 2.
- [ ] **Step 2: Run** `node --test skills/pr-resolve/tools/pr-resolve.test.mjs` — expect FAIL (module not found).
- [ ] **Step 3: Implement** the lib and the CLI to the interfaces above.
- [ ] **Step 4: Run** the suite again — PASS; then `node --test skills/backlog/tools/backlog.test.mjs` (the `CLI_SOURCES` /
  `ENTRY_SHAPES` guard) — PASS.
- [ ] **Step 5: Commit** — `git add` the three new files and `backlog.test.mjs`; `feat(skills): pr-resolve tool — target parse, lock, outcome file`.

### Task 2: Skill — `SKILL.md`, references, and the repo's rules and docs about skills

**Files:**
- Create: `skills/pr-resolve/SKILL.md`, `skills/pr-resolve/references/classify.md` (the mechanical-vs-judgment worked examples)
- Modify: `test/guards/skills-plugin-root.test.ts:38-44` — the `it.each` list gains `'pr-resolve'`; the comment's "nine skills" → "ten skills"; the
  tool-name class in the line-44 regex widens from `[a-z]+\.mjs` to `[a-z-]+\.mjs` (the spec names the tool `pr-resolve.mjs`, which the old class refuses;
  widening keeps the spec's name and still pins the braced root and the `skills/<name>/tools/` shape)
- Modify: `CLAUDE.md` — "nine skills under `skills/` (eight backlog skills and `jira`)" → ten (add `pr-resolve`); the Layout line for `skills/` likewise.
  Stay under the byte budget `test/guards/claude-rules.test.ts` enforces; the `backlog-orchestrate` headline is NOT touched.
- Modify: `.claude/rules/skills.md` — new bullet: `~/.backlog-manager/pr-resolve/` has exactly one writer, `pr-resolve.mjs`; the server only reads it; with
  its `Why:` link to a new `invariants.md` section.
- Modify: `.claude/rules/orchestrator.md` and `docs/subsystems/invariants.md` — only the BODY sentence "Execute and groom are the two other skills that write
  git" gains `pr-resolve` (merges a PR's base into that PR's head and pushes the head, never forced). Headline byte-identical.
- Modify: `docs/subsystems/invariants.md` — new section for the one-writer rule (anchor matching the rule's link).
- Modify: `docs/subsystems/skills.md` — the new skill.

**SKILL.md content (behaviour the prose must carry — the spec's "The skill" section is the source; do not paraphrase it away):**
- Frontmatter `name: pr-resolve`, a description that names the trigger and says it never asks and never force-pushes.
- Trigger `/backlog-manager:pr-resolve <owner>/<repo>#<number> [--reclaim <sessionId>]`; `--reclaim` is route-only.
- Every tool call is `node "${CLAUDE_PLUGIN_ROOT}/skills/pr-resolve/tools/pr-resolve.mjs" …` (the guard's regex requires this exact form).
- The three stop kinds and which step-8 acts each runs; steps 1–8 in the spec's order and wording, including: detached worktree at `origin/<head>`; the
  `info/exclude` step as `backlog-execute`'s `pr-mode.md` does it (cite it); `node_modules` symlink; `git merge --no-ff --no-commit origin/<base>`; the
  lockfile case replacing the symlink with the tree's own install; one judgment hunk aborts; the base-tree re-run of a failing check; "no check defined"
  pushes, "check cannot run" stops; stage by path, never `-A`; `git push origin HEAD:<head>`, never forced; step 8's order (a)–(f) with each act attempted
  and failures named; the three exact final lines.
- `references/classify.md`: at least one worked example per mechanical class (independent list/import/registry entries; non-overlapping edits; rename vs
  unrelated edit; formatting-only; lockfile/generated) and per judgment class (same logic both sides; delete vs edit; semantic choice; not confident).

- [ ] **Step 1: Write the failing test** — the guard list change in `skills-plugin-root.test.ts` (the `pr-resolve/SKILL.md calls its tools through
  ${CLAUDE_PLUGIN_ROOT}` case); and needle cases in `skills/backlog/tools/backlog.test.mjs` (where `.claude/rules/tests.md` puts skill-prose
  cases) for the three exact final lines, `never forced` and the never-`-A` rule in `skills/pr-resolve/SKILL.md`.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/guards/skills-plugin-root.test.ts` — FAIL (no `skills/pr-resolve/SKILL.md`).
- [ ] **Step 3: Write** `SKILL.md` and `references/classify.md`; then the rules and docs edits above.
- [ ] **Step 4: Run** `pnpm run test:jest -- test/guards/skills-plugin-root.test.ts test/guards/claude-rules.test.ts` and
  `node --test skills/backlog/tools/backlog.test.mjs` — PASS (the last one also checks skill prose seams; a red there names what to fix).
- [ ] **Step 5: Commit** — by path; `feat(skills): pr-resolve skill — merge base into a conflicting PR head`.

### Task 3: `PullRequestsService` — two public reads for the route

**Files:**
- Modify: `server/src/tracker/pulls.service.ts` (beside `write`, ~line 351, and `reread`, ~line 404)
- Test: `test/github/prs-read-one.test.ts` (new; reuse `prs-write.test.ts`'s fixtures and fake client — read its setup first)
- Modify: `.claude/rules/tracker.md` and the PR-cache section of `docs/subsystems/invariants.md` — the sentence listing where a PR read happens gains the
  resolve route's one-PR read, spliced like a write's re-read.

**Interfaces — Produces:**
- `projectFor(repo: string): { ok: true; path: string } | { ok: false; status: 404 | 409; error: string }` — `registeredRepos()` lookup (404 with the
  exact sentence), then `this.poller.syncOffBlock(path)` (409 with its sentence). Throws `registryProjectsOr503`'s 503 as `registeredRepos` does.
- `readOne(repo: string, number: number, at?: number): Promise<{ ok: true; pr: PullOne | null } | { ok: false; status: 503 | 429 | 502; error: string }>`
  — no token → 503 `NO_TOKEN`; `asleepDetail(repo, now, 'graphql')` → 429 with that detail; then `readPull`: a 404 answer (`readPull`'s not-found shape,
  `pulls.query.ts:251`) → `splice(repo, null, number)` and `{ ok: true, pr: null }` (the route words it as not open, spec rung 5); any other failure →
  `failureVerdict` → `noteSleep(…, 'graphql')` and 429 with `verdict.detail` when it is a limit, else 502 `could not read <repo>#<n> from GitHub`; success →
  `splice(repo, openRow(pr), number)` and `{ ok: true, pr }`. Not serialised behind writes (it writes nothing).

- [ ] **Step 1: Write the failing tests:**
  - `projectFor('acme/web')` with two registered projects on that repo → the FIRST path in registry order.
  - `projectFor('acme/none')` → `{ ok:false, status:404, error:'acme/none is not the repo of a registered GitHub project' }`.
  - sync off for the path → 409 with exactly `syncOffBlock`'s string for it.
  - `readOne` with no token → 503 `BM_GITHUB_TOKEN is not set on this machine`, and the fake client saw no request.
  - graphql pool asleep → 429 with the sleep's detail, no request.
  - read answers a rate-limit → 429 with the verdict's detail, and a following `readOne` is refused 429 without a request (the pool slept).
  - read answers 500 → 502 `could not read acme/web#7 from GitHub`.
  - read answers an OPEN PR → `ok: true`, and the cached list now holds that row (spliced); a CLOSED one → `ok: true`, `pr.state === 'CLOSED'`, and the row
    is gone from the cache.
  - read answers GraphQL's null `pullRequest` (no such PR) → `{ ok: true, pr: null }`, not a 502, and any cached row for that number is gone.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/github/prs-read-one.test.ts` — FAIL.
- [ ] **Step 3: Implement** both methods; `registeredRepos` stays private (the new method is its public face).
- [ ] **Step 4: Run** that suite plus `test/github/prs-write.test.ts test/github/prs-cache.test.ts` — PASS.
- [ ] **Step 5: Commit** — by path; `feat(prs): public one-PR read and project lookup for the resolve route`.

### Task 4: Server — `PrResolveService`, the two routes, shared types

**Files:**
- Create: `server/src/agents/pr-resolve.util.ts` (pure helpers), `server/src/agents/pr-resolve.service.ts`, `server/src/agents/pr-resolve.controller.ts`
- Modify: `server/src/agents/agents.module.ts` — controller + provider, and a paragraph in the module comment (agents → tracker edge, why the state lives
  here and not in `TrackerModule`)
- Modify: `shared/types.ts` — `PrResolveRequest`, `PrResolveOutcome`, `PrResolveState`, `PrResolvePayload`
- Modify: `test/agents/agents-origin-guard.test.ts` — `'/api/agents/dispatch-pr-resolve'` in the list (~line 158) and, like `dispatch-jira` (~line 133), a
  body the controller would accept so a 403 is the guard's alone
- Test: `test/agents/agents-dispatch-pr-resolve.test.ts` (new; model the dashboard fake and status stubs on `test/jira/agents-dispatch-jira.test.ts`)
- Modify: `docs/subsystems/api.md` (both routes), `.claude/rules/dispatch-watchdog.md` (the derived-dispatch route beside `dispatch-jira`: guard,
  reservation, trigger composed from the PR read and the lock file, never the body)

**Interfaces — Produces:**
- Shared types:
  - `PrResolveRequest = { repo: string; number: number }`
  - `PrResolveOutcome = { outcome: 'pushed' | 'stopped' | 'up-to-date'; reason: string; fromSha: string; headSha: string; sessionId: string | null }`
  - `PrResolveState = { repo: string; number: number; live: { sessionId: string | null } | null; outcome: PrResolveOutcome | null }`
  - `PrResolvePayload = { resolves: PrResolveState[] }`
- `pr-resolve.util.ts`: `prResolveHome(env)` (same rule as the tool's), `fileKey(repo, n)`, `parseFileKey(base): { repo, number } | null` (split on the
  first and last `__`), `readOutcome(file): PrResolveOutcome | null` (null on missing, unparseable, or any field of the wrong type/value),
  `readLock(file): { sessionId: string | null; at: number } | null`, `resolveTrigger(repo, n, reclaim: string | null): string` →
  `/backlog-manager:pr-resolve <repo>#<n>` or `… --reclaim <id>`, `parseResolveBody(body: unknown): PrResolveRequest | null`.
- `PrResolveService` (injects `AgentsService`, `PullRequestsService`):
  - `dispatch(body: unknown): Promise<{ sessionId: string }>` — the spec's ladder 1–7, throwing `HttpException({ error }, status)`; then
    `agents.spawnInProject(path, { prompt: trigger, name: \`pr-resolve ${repo}#${n}\`, permissionMode: 'auto', maxPermission: status.spawnMaxPermission,
    remoteControl: false })` — no `model`, no `effort`. Rung 4's status code follows `JiraDispatchService`'s convention (502 when
    `status.enabled && !status.reachable`, else 409) — the spec leaves codes to an existing convention. Rung 5 maps `readOne`'s refusals through, then: `pr`
    `null` (not found) or state not `OPEN` → 409 not open; `row.crossRepository` → 409 fork; `mergeable === 'unknown'` → 409 computing; `'mergeable'` → 409 no conflicts. Rung 6 is
    synchronous with no `await` between the check and the `set`. Rung 7: no lock → plain; lock `sessionId === null` → 409 while younger than 3 h, plain
    trigger after; lock younger than `JIRA_LIVE_GRACE_MS` → 409; `dashboardSessionRow` throws → 409; row `processLive === true` → 409; else `--reclaim <id>`.
    Every 409 after rung 6 and a spawn failure delete the reservation before throwing. Success stores the minted `sessionId` on the entry.
  - `list(now = Date.now()): Promise<PrResolvePayload>` — every outcome file under the home (missing dir → none) plus every live-map entry, merged per
    `repo#n`; entries judged dead are deleted from the map; dashboard lookups run under one `Promise.all`.
  - Live rule (private `isLive(entry, now, cfg)`): the entry's `sessionId` is NON-NULL and the outcome file carries that same id → dead (no call) — a
    `null` never matches, so a terminal run's outcome file (`sessionId: null`) cannot kill a reservation still spawning; `now - startedAt < JIRA_LIVE_GRACE_MS` →
    live; `sessionId === null` past the grace → live (a spawn still hanging); `dashboardSessionRow` throws → live; `null` row → dead; `processLive === true`
    → live; else dead.
- `PrResolveController` (`@Controller('api/agents')`): `@UseGuards(SameOriginPostGuard) @Post('dispatch-pr-resolve') @HttpCode(201)` → `dispatch(body)`;
  `@Get('pr-resolve')` → `list()`.

- [ ] **Step 1: Write the failing tests** (supertest through `listenLoopback`, per `.claude/rules/tests.md`; `BM_PR_RESOLVE_HOME` a temp dir; fake dashboard
  answering `/api/sessions/<id>/row` per case; a fake `PullRequestsService.readOne`):
  - Ladder, one case per rung in order, each asserting status and exact `error`: `{}` → 400; `{ repo:'acme/web', number:'7' }` → 400; unregistered → 404;
    sync off → 409 sync sentence; agents off → 409 with `projectDispatchGate`'s text; dashboard unreachable → 502 with its text; project not listed → 409
    `the dashboard does not list <path> — most likely no Claude session there inside its LOOKBACK_HOURS`; no token → 503; asleep → 429 detail; read failure
    → 502; CLOSED → 409 `acme/web#7 is not open`; MERGED → the same 409; not found (`readOne` → `pr: null`) → the same 409; fork → 409; `unknown` → 409;
    `mergeable` → 409 `acme/web#7 has no conflicts`.
  - Happy path → 201 `{ sessionId }`; the dashboard spawn body has `prompt === '/backlog-manager:pr-resolve acme/web#7'`, `model === DEFAULT_MODEL`,
    `'effort' in body === false`, `remoteControl === false`, and its project is the dirName of the FIRST of two registered paths sharing `acme/web`.
  - A second POST while the first's entry is inside the grace → 409 `a resolve of acme/web#7 is already running`.
  - Two POSTs fired together (both reach rung 5 before either spawns — hold the fake `readOne` on one shared promise, then release) → exactly one spawn, one
    201 and one 409 — run once with no outcome file and once with an outcome file `{ sessionId: null, … }` for `acme/web#7` already on disk (a terminal
    run's), still exactly one spawn.
  - Keying: with `acme/web#7` live, POSTs for `acme/web#8` and for `acme/api#7` (a second registered repo) both answer 201.
  - Clock for every past-grace case: stub `Date.now` only (`jest.spyOn(Date, 'now')`), never fake timers — fake timers would also fire the spawn's own
    timeout and drop the reservation the case asserts is kept. The service reads `Date.now()` in `dispatch` and `list`.
  - Spawn held open past the grace (fake dashboard spawn never answers; `Date.now` moved past `JIRA_LIVE_GRACE_MS`): GET lists `acme/web#7` with `live: { sessionId:
    null }`, and a second POST → 409 already running.
  - Spawn fails (dashboard 500) → the error returns, and an immediate retry is NOT refused as already running.
  - Leftover lock `{ sessionId:'old', at: now-10min }`, dashboard row for `old` with `processLive: true` → 409; with no row → 201 and the prompt ends
    ` --reclaim old`; dashboard unreachable on that lookup → 409. Lock `at: now-30s` → 409 without asking the dashboard. Lock `sessionId:null` at now-1h → 409;
    at now-4h → 201, plain trigger.
  - `GET /api/agents/pr-resolve` with no home dir → `{ resolves: [] }`. With a valid outcome file `acme__web__7.json`, a truncated one `acme__web__8.json`,
    and a live entry for #9 → two entries (#7 outcome only, #9 live only), #8 skipped. Also skipped: `acme__web__10.json` holding valid JSON with
    `outcome: 'done'` (Review Focus 1's hand-edited file), and a file named `notakey.json`. `acme__my__lib__12.json` (repo `acme/my__lib`) → listed as
    `repo: 'acme/my__lib', number: 12`. One PR with BOTH an older outcome file (`sessionId: 'old'`) and a live entry (`sessionId: 'new'`, inside grace) → ONE
    entry carrying `live` and `outcome`.
  - Live rule via GET (clock injected through `list(now)` or a fake timer): entry inside grace, dashboard 404 → still listed live; past grace, row with
    `processLive: false` → gone; past grace, dashboard unreachable → still live; outcome file carrying the entry's sessionId → `live: null`; entry with
    `sessionId: null` inside grace beside an outcome file with `sessionId: null` → still live.
  - Parallel lookups: three live entries, the fake dashboard delays each row by 300 ms → GET answers in < 600 ms.
  - Origin guard: the cross-origin POST to `/api/agents/dispatch-pr-resolve` → 403.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/agents/agents-dispatch-pr-resolve.test.ts test/agents/agents-origin-guard.test.ts` — FAIL.
- [ ] **Step 3: Implement** util, service, controller, module wiring, shared types.
- [ ] **Step 4: Run** the two suites plus `test/agents/default-model.test.ts`, `pnpm run typecheck` — PASS. Then `grep -l` `test/` for `spawnInProject`,
  `dashboardSessionRow`, `projectDispatchGate`, `JIRA_LIVE_GRACE_MS`, `syncOffBlock` and run every suite it names, plus `test/guards/claude-rules.test.ts` (the
  `dispatch-watchdog.md` edit joins the existing `dispatch-jira` bullet, or is a new bullet within that guard's limits).
- [ ] **Step 5: Commit** — by path; `feat(agents): dispatch-pr-resolve route and resolve state read`.

### Task 5: Client lib — derivations and API calls

**Files:**
- Create: `client/src/lib/pr-resolve.ts`
- Modify: `client/src/lib/prs-api.ts` — `fetchPrResolves(): Promise<PrResolvePayload>`, `dispatchPrResolve(req: PrResolveRequest): Promise<{ sessionId: string }>`
  (same error-text convention as the PR writes: a refused POST rejects with the server's `error` sentence)
- Modify: `client/src/lib/prs.ts` — `updateBlock`'s comment no longer says nothing on the page can resolve a conflict; it points at the Resolve row
- Test: `test/github/pr-resolve-lib.test.ts` (new)

**Interfaces — Produces:**
- `shownOutcome(pr: PullRequestRow, outcome: PrResolveOutcome | null): PrResolveOutcome | null` — the spec's "Last outcome" rule: `stopped`/`up-to-date` while
  `pr.headSha === outcome.headSha`; `pushed` while `pr.headSha === outcome.fromSha`, or `=== outcome.headSha` with `pr.mergeable` `conflicting` or `unknown`;
  else `null`.
- `resolveBlock(pr: PullRequestRow, repo: PrRepoView, gate: DispatchGate, state: PrResolveState | undefined, warning: string | null): string | null` — first
  that holds, in the spec table's order: `sync off`; gate `disabled` → `gate.reason`; `fork — cannot push`; `mergeability pending`; `no conflicts`;
  `resolving…` (`state?.live != null`); `resolved — waiting for GitHub` (shown outcome is `pushed`); `warning`; else `null`. Never called with a `hidden`
  gate.
- `resolveGateFor(status: AgentsStatus | null, repo: string, projects: readonly ProjectSummary[]): DispatchGate | null` — `null` while `status` is `null`;
  else `projectDispatchGate(status, <path of the FIRST project whose repo is repo>)`; no such project → `{ control: 'hidden', reason: '' }`.
- `resolveIndex(states: readonly PrResolveState[]): ReadonlyMap<string, PrResolveState>` keyed by `prKey(repo, number)`.

- [ ] **Step 1: Write the failing tests** — fixtures with distinct SHAs (`fromSha 'f1'`, `headSha 'h2'`, PR head varying), never one value for all:
  - `shownOutcome`: stopped at its head → shown; stopped, PR at another head → `null`; up-to-date at head → shown; pushed, PR at `f1` → shown; pushed, PR at
    `h2` `conflicting` → shown; at `h2` `unknown` → shown; at `h2` `mergeable` → `null`; pushed, PR at `x9` → `null`.
  - `resolveBlock`, one case per row of the table, each with every EARLIER condition false and a LATER one true (so order is pinned): e.g. fork AND
    `mergeable` → `fork — cannot push`; live AND pushed-shown → `resolving…`; pushed-shown AND warning → `resolved — waiting for GitHub`; all clear but
    warning → the warning text verbatim; all clear → `null`. A stopped outcome shown → `null` (the row is enabled again).
  - `resolveGateFor`: `null` status → `null`; agents off → `hidden`; project listed → `enabled`; two projects on the repo, only the second listed → `disabled`
    (first path wins); no project on the repo → `hidden`.
  - `resolveIndex` with an entry for a PR no repo shows → present in the map; nothing else reads it (Review Focus 4 is pinned in Task 6's render case).
- [ ] **Step 2: Run** `pnpm run test:jest -- test/github/pr-resolve-lib.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite plus `test/github/prs-lib.test.ts` — PASS.
- [ ] **Step 5: Commit** — by path; `feat(prs): resolve derivations and API calls`.

### Task 6: Client — provider read, the menu row, the status line

**Files:**
- Modify: `client/src/hooks/usePullRequests.ts` — `load` reads `fetchPullRequests()` and `fetchPrResolves()` together; the hook returns `resolves:
  PrResolveState[]` too; a failed resolves read keeps the last `resolves` and does not set `error` (the PR read alone decides `error`); `refresh` still
  resolves the PR payload.
- Modify: `client/src/hooks/PullRequestsContext.tsx` — `PullRequestsContextValue` gains `resolves: PrResolveState[]` (`[]` when disabled).
- Modify: `client/src/components/github/pr-layout-props.ts` — `PrLayoutProps` gains `resolves: ReadonlyMap<string, PrResolveState>`,
  `gateFor: (repo: string) => DispatchGate | null`, `resolve: (key: string, repo: string, number: number) => Promise<void>`.
- Modify: `client/src/components/github/PullRequestsView.tsx` — `useAgents()` for the status; builds `gateFor` with `resolveGateFor(status, repo,
  projects)`; `resolve` mirrors `write`'s in-flight and outcome handling (adds the key to `inFlight`, clears the old outcome, POSTs `dispatchPrResolve`,
  on rejection records `{ kind: 'error', text: <server sentence> }`, on success records nothing, then `await refresh()`, then drops the key).
- Modify: `client/src/components/github/PrActions.tsx` — new props `warning: string | null` (the row's `prRunWarning`: `PrRow` passes its existing `warning` (`PrRow.tsx:47`); `MatrixExpand` has none in scope, so `PrMatrix` computes it once per
  PR and hands it to both `MatrixRow` and `MatrixExpand`, or `MatrixExpand` calls `prRunWarning(pr, repo.repo, props.ctx, props.now)` itself), `gate: DispatchGate | null`, `resolveState: PrResolveState | undefined`,
  `onResolve: () => void`; the fourth row `{ id: 'resolve', glyph: <builder's pick>, tone: 'neutral', label: 'Resolve conflicts', sub: \`merge ${base} in
  with a headless session\`, block: resolveBlock(…, warning), act: onResolve, primary: false }`, appended only when `gate !==
  null && gate.control !== 'hidden'`; header comment updated (the menu's rows, the resolve row's hidden/disabled split per `.claude/rules/board.md`).
- Create: `client/src/components/github/PrResolveLine.tsx` — drawn by `PrActions` under the strip (sibling of the why-line), cites `.claude/DESIGN.md` §8.11:
  live → `Chip` (`components/ui/Chip.tsx`) `resolving…`, an `<a>` to `sessionUrl(linkBase, id)` when the id is non-null, plain text when `null`; shown `pushed` → `Chip`
  `resolved — waiting for GitHub`; shown `stopped` → `<p>` `resolve stopped: <reason>` plus ` session ↗` link (`target="_blank" rel="noreferrer"`) when its
  `sessionId` is non-null; `up-to-date` or nothing shown → renders nothing. `linkBase` from `useSettings()` as `components/board/LaunchSheet.tsx` reads it.
- Modify: `client/src/components/github/PrRow.tsx`, `PrMatrix.tsx` (both `PrActions` call sites) — pass the new props from `PrLayoutProps`.
- Modify: `client/src/styles.css` only if the line needs a class the existing `.prs-why` / `.prs-outcome` vocabulary lacks (inline styles are forbidden by the
  CSP rule).
- Modify: `docs/subsystems/board.md` — the row and the line.
- Test: `test/github/prs-actions.test.tsx` (extend), `test/github/use-pull-requests.test.tsx` and `test/github/pull-requests-context.test.tsx` (extend)

- [ ] **Step 1: Write the failing tests:**
  - `PrActions` with `gate: null` → no `Resolve conflicts` row in the opened menu (Review Focus 2); `hidden` gate → none; `enabled` gate, conflicting PR,
    nothing else → row enabled, sub reads `merge main in with a headless session` (base `main`).
  - Each reason drawn as the row's sub with `aria-disabled="true"`, and a click sends no POST: `sync off`, a `disabled` gate's text, `fork — cannot push`,
    `mergeability pending`, `no conflicts`, `resolving…`, `resolved — waiting for GitHub`, and a `warning: 'run in progress on this machine'` prop drawn verbatim.
  - Threading, page-level in `prs-view.test.tsx`, once in Inbox and once in Matrix (expanded row): a PR on head `backlog/3`, the page's `ctx` with a
    project mapped to the repo and a `running` run on that project whose `queue` has an entry `id: '3'` at a `RUN_HELD_STAGES` stage → the Resolve row's
    sub reads `run in progress on this machine` (`pr-run.ts:19,45-46`).
  - Enabled row click → `onResolve` called once.
  - Review Focus 3, in `PullRequestsView` (`prs-view.test.tsx`): the POST to `/api/agents/dispatch-pr-resolve` held on an unresolved promise, Resolve
    clicked → the strip's chevron is disabled, a click on it opens no menu, and exactly ONE POST was sent (pins that `resolve` puts the key into
    `inFlight` before the POST answers).
  - `PrResolveLine`: live with id → `resolving…` with an href ending `?session=s1`; live with `null` → `resolving…` and no link; pushed at `fromSha` →
    `resolved — waiting for GitHub`; pushed at `headSha` while `mergeable` → nothing; stopped → `resolve stopped: tests failed` and a `session ↗` link;
    stopped with `sessionId: null` → no link; stopped for another head → nothing.
  - `PullRequestsView` (in `prs-view.test.tsx` if that is where the page's write cases live): a refused POST's sentence lands in `PrOutcomeLine` with the
    error kind; a `resolves` entry for a PR absent from `data` renders nothing and throws nothing (Review Focus 4).
  - `usePullRequests`: one tick issues one `/api/prs` and one `/api/agents/pr-resolve`; a 500 on the second keeps the previous `resolves` and leaves
    `error` `null`.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/github` — FAIL on the new cases only.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm run test:jest -- test/github`, `pnpm run typecheck`; then `grep -l` `test/` for `useAgents`, `usePullRequestsContext`,
  `prRunWarning`, `PrActions`, `sessionUrl`, `useSettings` and run every suite it names (CLAUDE.md's source-guard rule — several guards count callers).
- [ ] **Step 5: Commit** — by path; `feat(prs): Resolve conflicts row and resolve status line`.

### Task 7: `/ui-verify`

**Files:** none changed unless a defect is found (fix on the branch, own commit).

- [ ] **Step 1:** Start the stack through `.claude/launch.json` / `preview_start` (pid-owned, per memory `ui-mockups`), light theme.
- [ ] **Step 2:** Seed the page without GitHub: intercept `GET /api/prs`, `GET /api/agents/pr-resolve` and `GET /api/agents/status` in the browser pane with
  fixtures holding one conflicting PR per state — enabled, `resolving…` (with and without id), `resolved — waiting for GitHub`, `resolve stopped: <a long
  reason that wraps>`, fork, sync-off repo — on each of the three layouts (Inbox, Matrix, Cards).
- [ ] **Step 3:** Invoke `/ui-verify` with those fixtures; no mock to compare (the spec decided none) — check against `.claude/DESIGN.md` §8.11 row anatomy:
  menu row tile, label and sub alignment with its siblings; the line's wrap at phone width (375 px) with no horizontal scroll; dark and light.
- [ ] **Step 4:** Fix defects, re-run, record the report path for the final review.
- [ ] **Step 5: Name the live precondition.** Nothing above runs the skill for real: `skills/` changes nothing until the branch is committed, pushed and
  `pnpm run plugin:sync` reinstalls the plugin (CLAUDE.md invariant), and the API needs a restart for the new routes. Push and `plugin:sync` are the user's
  call (held), so the closing report lists them as the precondition and hands the person one end-to-end check: after sync and restart, click Resolve on a
  real conflicting PR and confirm the session starts, the chip shows, and the outcome line lands.
