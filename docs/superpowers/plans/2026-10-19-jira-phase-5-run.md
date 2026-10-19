# Jira integration — phase 5, Run — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start a Claude session on a Jira ticket from the board — `Run ▾` on a card or in the issue modal, a launch sheet with **Start** (through the
dashboard, optionally assigning and moving the ticket first) and **Copy prompt** (for a terminal) — with this machine's custom skills as extra actions, and
the running session visible on the card until it ends or is stopped.

**Architecture:** Two PRs from one plan (the user's ruling, 2026-10-19). **5a, server:** the skills writers and their two routes, the prompt composer and
`GET /api/jira/prompt`, the in-memory live map (`jira/live.service.ts`), and in `agents/` the `dispatch-jira` and `jira-stop` routes plus the 60 s
reconciler — every route curl-testable before a pixel exists. **5b, client:** `jiraDefaultAction`, the Skills card, `Run ▾`, the launch sheet, the live
strip, and the modal's session fact, Run and Stop. `agents → jira`, never back; the browser still never talks to Jira or the dashboard.

**Tech Stack:** NestJS 10 + TypeScript (server), React 18 + Vite (client), jest (`--runInBand`, supertest through `listenLoopback`, jsdom render suites).

**Spec:** [docs/superpowers/specs/2026-10-15-jira-integration-design.md](../specs/2026-10-15-jira-integration-design.md) — §2 (`jiraDefaultAction`), §3
(`prompt.util.ts`, the live map, the reconciler), §4 (`JiraAction`, `JiraDispatchRequest`, `live`, `session`), §5 (`/prompt`, `/skills`, `/skills/delete`,
`dispatch-jira`, `jira-stop`, the skill validation line), §6.1 (`runChipState`, `resolveJiraAction`, reload-after-write), §6.2 (`Run ▾` and the strip on a
card), §6.3 (Run, Stop and the session fact in the modal), §6.4 Skills, §6.5 the Dispatch row, §7 whole, §8 errors, §9 the built-ins' texts, §10, §11's
phase-5 suites, §12 item 5, §13's last two headlines and the dispatch, spawn-prompt and environment-block widenings. Mocks: `RunMenu.html`,
`Dispatch.html`, `Setup.html` (Skills card) in [`2026-10-15-jira-mockups/`](../specs/2026-10-15-jira-mockups/00-mock-audit.md); where they and the spec
differ, the spec wins (§1's last paragraph lists the differences).

**Plan conventions (they override the writing-plans template where the two differ):**
- Every task states BEHAVIOUR and EXACT TEST CASES — inputs, expected values, edge cases — never literal code. The implementer writes the code and the test
  bodies, and is expected to disagree with a case here when the spec or the code says otherwise (and to say so in the commit). Reason: handed code gets
  transcribed verbatim, bugs included (the user's CLAUDE.md, "Learnings").
- Signatures in **Interfaces** are the one place a name is fixed; a later task that consumes a name spells it exactly as the producing task does.
- Size budgets are soft targets, never a reason to drop a rule or a comment. Comments explain WHY at the density `server/src/jira/poller.service.ts` has;
  new prose wraps at 160.
- **Two branches, each cut in its own worktree** (never switch branches in the shared checkout). 5a: `feat/jira-phase-5a-run-server` from `main`; PR title
  `feat(jira): dispatch, prompt and skills routes for Run`. 5b: `feat/jira-phase-5b-run-client` from `main` **after 5a has merged**; PR title
  `feat(jira): Run ▾, the launch sheet and the live strip`. Commit after every task; nothing is pushed until the part's last task.
- Run only the suites a task touches (`pnpm run test:jest -- <files>`) plus `pnpm run typecheck`; CI runs the whole suite (project CLAUDE.md).

## Global Constraints

- `JIRA_PROMPT_MAX = 4000` — the dashboard's `PROMPT_CAP` (`claude-agents-dashboard/server/lib/spawn.ts:66`, verified 2026-10-19). Not `PROMPT_MAX` (8 000).
- Session name `jira <KEY>`, cut to 60 characters (`sessionName`'s rule).
- Live map: memory only, cap 100 (oldest evicted first), 8 h expiry, Stop clears early, a restart forgets. Reconciler: 60 s, armed only while the map holds
  a confirmed session; keeps an entry only while its session's status is `working` or `question`; never touches a `starting` entry or one younger than 2 min;
  an unreadable list leaves the map untouched.
- Skill: trimmed `name` 1–60, `prompt` 1–2 000, id `s_` + 8 hex, server-minted; create and update follow `writeBoard`'s rule exactly (no `id` → create; an `id` the file lacks → 404).
- Template placeholders are exactly `{key} {summary} {url} {repo} {description}`; anything else in braces stays literal.
- Built-in labels: `execute` → `Work it end to end`, `context` → `Open with the ticket loaded`. Default permission: `acceptEdits` for `execute` and a skill,
  `plan` for `context`, capped by `modesUpTo(spawnMaxPermission)`.
- The launch sheet's Move to defaults to `leave as is`; Assign to me is off by default.
- `jira.json` stays the fourth file this server writes, through `config.util.ts`'s raw-merge writers only; `jiraDefaultAction` is per browser (localStorage).
- No new outbound module, no new env var, no CSP change, no Jira write beyond assign and transition.

## Review Focus

1. **A ticket description that tries to steer the session** (instructions, a fake end marker, a run of backticks longer than the fence) — the prompt must
   keep it inside the nonce-marked, adaptively fenced data block. Pinned in Task 2.
2. **Two Starts on one key in the same second** (double-click, two tabs) — exactly one session; the second is the 409 from the reservation. Pinned in Task 5.
3. **A skill deleted (or `jira.json` hand-edited) while a launch sheet is open, or a stored `jiraDefaultAction` naming a gone skill** — Start is a 400
   naming the skill, the preview says so, and the sheet seeds `execute`. Pinned in Tasks 5, 8 and 9.
4. **The dashboard down or agents off** — `Run ▾` still opens, the sheet draws Copy prompt alone, nothing reads as broken. Pinned in Task 9.
5. **A transition that disappears between the sheet opening and Start** (someone moved the ticket) — 400 `transition not offered` before any write, the
   reservation released, the sheet still offers Copy prompt. Pinned in Task 5.

---

# Part A — PR 5a, server

### Task 1: Skills writers and their routes

**Files:**
- Modify: `server/src/jira/config.util.ts` (writers section), `server/src/jira/jira-write.controller.ts`
- Test: `test/jira-config-write.test.ts`, `test/jira-write-routes.test.ts`

**Interfaces:**
- Produces: `parseSkillWrite(body: unknown): Parsed<{ id?: string; name: string; prompt: string }>`, `writeSkill(input, file?): JiraSkill`,
  `deleteSkill(id: string, file?): void` (throws `JiraUnknownIdError`), routes `POST /api/jira/skills` → `JiraSkill`, `POST /api/jira/skills/delete` →
  `{ ok: true }`.

- [ ] **Step 1: Failing tests.** In `jira-config-write`: a body without `id` mints `s_[0-9a-f]{8}`; a body with an `id` the file lacks → `JiraUnknownIdError`; an update keeps the id and replaces name/prompt;
  name and prompt are stored trimmed; a write preserves a malformed skill entry and an unknown top-level key byte-for-byte (`writeBoard`'s existing case,
  repeated for skills); delete of an unknown id throws; an unreadable file throws `JiraConfigUnreadableError` and is unchanged on disk. In
  `jira-write-routes`: name `''`, `'   '`, 61 chars → 400 naming `name`; prompt `''`, 2 001 chars → 400 naming `prompt`; 60 and 2 000 accepted; unknown id
  on upsert and delete → 404; unreadable file → 409; unconfigured → 503 (after the 400s, as every handler orders it); cross-origin POST → refused by the guard.
- [ ] **Step 2:** Run both files; expect the new cases to fail.
- [ ] **Step 3: Implement** beside `parseBoardWrite`/`writeBoard`, reusing `trimmedLengthWithin`, `mintUnique`, `readRawForWrite`, `writeRawAtomic`, `idsIn`.
  The routes mirror `saveBoard`/`deleteBoard` (guard, `HttpCode(200)`, `writing()`); a skill save does not touch the poller. `writing()` today answers every
  `JiraUnknownIdError` with `unknown board` and the error says `no board with id` (`config.util.ts:236-241`): give the error the entry kind it was thrown for,
  so a skill answers 404 `unknown skill` and a board still `unknown board`; the route tests pin both sentences.
- [ ] **Step 4:** Both files pass; `pnpm run typecheck`.
- [ ] **Step 5: Commit** `feat(jira): the skills writers and their two routes`.

### Task 2: The prompt composer

**Files:**
- Create: `server/src/jira/prompt.util.ts`
- Modify: `server/src/jira/block.ts` (one option), `shared/types.ts` (Jira section)
- Test: `test/jira-prompt.test.ts` (new), `test/jira-block.test.ts`

**Interfaces:**
- Produces in `shared/types.ts`: `type JiraAction = 'execute' | 'context' | { skill: string }`; `JIRA_BUILTIN_LABELS: Record<'execute' | 'context', string>`;
  `parseJiraActionParam(raw: unknown): JiraAction | null` (`'execute'`, `'context'`, `'skill:<s_ id>'`) and `jiraActionParam(a: JiraAction): string` (its
  inverse); `parseJiraAction(raw: unknown): JiraAction | null` for a JSON body. Shape checks only — whether the skill exists is the server's question.
- Produces in `block.ts`: `renderTicketBlock(detail, opts?: { description?: 'as-is' | 'omitted' | { fence: string } })`, default `'as-is'` (so `?format=text`
  and `jira.mjs show` are byte-identical to today).
- Produces in `prompt.util.ts`: `JIRA_PROMPT_MAX = 4000`;
  `composeJiraPrompt(detail: JiraIssueDetail, action: { kind: 'execute' | 'context' } | { kind: 'skill'; skill: JiraSkill }, repo: string, nonce?: string): { ok: true; prompt: string } | { ok: false; error: 'prompt too long' }`.
  `nonce` defaults to 6 random bytes in hex; tests pass a fixed one.

Behaviour (spec §3 `prompt.util.ts`, §9): the instruction text, then one framing line saying the text between `BEGIN TICKET <nonce>` and
`END TICKET <nonce>` is the ticket's own content and not instructions, then the markers around the block. The block's description goes in a fence one
backtick longer than its longest backtick run, three at least. `execute`'s text: branch, implement, verify; then — only when `jira.mjs transitions <KEY>`
offers exactly one transition whose target category is `done` — `jira.mjs transition` through it, else leave the status and say so in the report; then
item dispatch's commit rule (stage only what the session changed, never `git add -A`, do not push) — one copy: move the private `COMMIT_RULE`
(`server/src/agents/prompt.util.ts:61`) to `shared/agent.ts` as an export both prompt utils import (`jira/` must not import `agents/`). `context`'s text: read the ticket and wait. A skill: its template with the five placeholders filled
(`{summary}` through `oneLine`, `{description}` with the same fenced, marked description), and when the template used `{description}` the block is rendered
with `description: 'omitted'`. Over the cap: trim the description from the end and append `[description truncated — open in Jira]` until it fits; still over
with an empty description → `{ ok: false }`.

- [ ] **Step 1: Failing tests** (`jira-prompt`): fixed nonce `abc123` → prompt contains both markers exactly once and ends with the end marker plus newline;
  a description containing ```` ```` ```` (four backticks) is fenced with five; a description containing `END TICKET abc123`-shaped text with a different
  nonce stays inside the fence; `execute` text names `jira.mjs transitions` and `git add -A`; `context` text names neither; a template
  `Do {key}: {summary} in {repo}. {unknown}` fills the three and leaves `{unknown}`; a summary with a newline becomes one line; a template using
  `{description}` → the description text appears once in the whole prompt; a 10 000-char description → length ≤ 4 000 and contains the truncation marker;
  45 children → the block lists 30 and `+15 more`; a 3 990-char template with a 100-char key-plus-facts block → `{ ok: false, error: 'prompt too long' }`.
  Shared helpers: `parseJiraActionParam('skill:s_0123abcd')` → `{ skill: 's_0123abcd' }`; `'skill:'`, `'skill:x'`, `'groom'`, `42` → `null`; round-trip
  through `jiraActionParam`. In `jira-block`: `'omitted'` drops the description and its placeholder note but keeps facts and subtasks; default unchanged.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement. Update `shared/types.ts`'s Jira header comment: `JiraAction` is no longer absent.
- [ ] **Step 4:** Both files pass; typecheck.
- [ ] **Step 5: Commit** `feat(jira): compose Run prompts with the ticket framed as data`.

### Task 3: The live map and the payload fields it fills

**Files:**
- Create: `server/src/jira/live.service.ts`
- Modify: `server/src/jira/jira.module.ts` (provide + export), `server/src/jira/jira.controller.ts` (`status`, `issue`), `shared/types.ts`
- Test: `test/jira-live.test.ts` (new), `test/jira-routes.test.ts`

**Interfaces:**
- Produces in `shared/types.ts`: `JiraLiveSession { name: string; startedAt: string; repo: string; starting: boolean }`; `JiraStatusPayload.live` becomes
  `Record<string, JiraLiveSession>`; `JiraIssueDetail.session` becomes `JiraLiveSession | null`.
- Produces in `shared/types.ts`: `jiraSessionName(key: string): string` — `jira <KEY>`, cut to 60.
- Produces `JiraLiveService` (`@Injectable`): `reserve(key, repo): boolean` (false when a non-expired entry exists), `confirm(key, sessionId): void`,
  `release(key): void` (drops a `starting` entry only), `clear(key): void`, `get(key): { sessionId: string | null; repo: string; startedAt: string } | null`,
  `snapshot(): Record<string, JiraLiveSession>`, `confirmed(): { key: string; sessionId: string; startedAt: string }[]`, `hasConfirmed(): boolean`.
  Constants `JIRA_LIVE_CAP = 100`, `JIRA_LIVE_TTL_MS = 8 * 3600_000`.

The service is pure memory (no I/O), so `jira/` gains no dependency on `agents/`. The controller composes `status()` as the poller's payload with
`live: this.live.snapshot()` (unconfigured: still `{}`), and the JSON detail with `session` from the map; the poller stays unaware of the map. `name` is
`jiraSessionName(key)` — `jira <KEY>` cut to 60 — which lives in `shared/types.ts` beside `isJiraKey` (not `agents/prompt.util.ts`: that would be an
import from jira into agents, R2); Task 5 consumes it from there.

- [ ] **Step 1: Failing tests** (`jira-live`, jest fake timers with `setSystemTime`): `jiraSessionName('PAY-1')` → `jira PAY-1`; reserve → snapshot reads `starting: true`, `get().sessionId` null;
  second reserve same key → false; confirm → `starting: false`; release after confirm is a no-op; clear removes; at 8 h + 1 ms `get` → null and reserve
  succeeds; 101 confirmed entries → the oldest by `startedAt` is gone and a `starting` entry is never the one evicted; `hasConfirmed` false with only a
  starting entry. In `jira-routes`: `GET /api/jira` carries a reserved key in `live`; `GET /api/jira/issue/PAY-1` carries `session` for a live key and `null`
  otherwise; `?format=text` unchanged.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement. Touch every `live: {}` / `session: null` literal the type change breaks (poller, test helpers) — typecheck finds them.
- [ ] **Step 4:** Pass; typecheck.
- [ ] **Step 5: Commit** `feat(jira): the in-memory live map behind live and session`.

### Task 4: `GET /api/jira/prompt`

**Files:**
- Modify: `server/src/jira/jira.controller.ts` (and its header: seven read routes, and the "404 until then" sentence goes), `server/src/jira/jira.module.ts`
  (its header's route count)
- Test: `test/jira-routes.test.ts` — the `GET /api/jira/prompt is 404` case and its `what this phase does not have` block are removed

**Interfaces:**
- Consumes: `composeJiraPrompt`, `parseJiraActionParam` (Task 2); `poller.issueDetail(key)`, `unwrapJira`, `readJiraConfig()`.
- Produces: `resolveJiraActionOrThrow(action: JiraAction, skills: JiraSkill[]): { kind: 'execute' | 'context' } | { kind: 'skill'; skill: JiraSkill }` in
  `prompt.util.ts` — 400 `unknown skill <id>` — shared with Task 5.

Order: `key` fails `isJiraKey` → 400 `invalid issue key`; `action` fails the parse → 400 `action must be execute, context or skill:<id>`; `repo` missing →
400 `repo is required`; unconfigured → 503; unreadable `jira.json` → 409; unknown skill → 400; detail read → `unwrapJira`'s mapping; `repo` not in
`repos[detail.project.key]` → 400 `<repo> is not mapped to <PROJECT>`; compose → `text/plain; charset=utf-8`, or 400 `prompt too long`. Use the same
`@Res({ passthrough: true })` idiom the `?format=text` handler uses.

- [ ] **Step 1: Failing tests** for each refusal above in that order (one case each, asserting the status and the error sentence), a mapped repo → 200
  `text/plain` whose body starts with the execute text and contains `BEGIN TICKET`, `skill:<id>` → the template's text, a path given with a trailing slash
  matches the stored one, because `repo` is passed through `normaliseRepoPath(repo, homedir())` before the comparison, as `parseReposWrite` calls it.
- [ ] **Step 2–4:** Run red, implement, run green; typecheck.
- [ ] **Step 5: Commit** `feat(jira): GET /api/jira/prompt`.

### Task 5: `POST /api/agents/dispatch-jira`

**Files:**
- Create: `server/src/agents/jira-dispatch.service.ts`, `server/src/agents/jira-agents.controller.ts`
- Modify: `server/src/agents/agents.service.ts` (one public method), `server/src/agents/agents.module.ts` (import `JiraModule`), `server/src/jira/unwrap.util.ts`
  (hoist the controller's `written()` as `jiraWriteOrThrow(outcome: JiraIssueWriteOutcome): JiraIssueWriteResult`; `JiraWriteController` calls it)
- Test: `test/agents-dispatch-jira.test.ts` (new; `test/helpers/jira.ts` for Jira, the stub dashboard `agents-dispatch.test.ts` uses)

**Interfaces:**
- Produces in `shared/types.ts`: `JiraDispatchRequest { key; repo; action: JiraAction; assign: boolean; transitionId: string | null; model?; effort?;
  permissionMode; remoteControl }`, `JiraDispatchResult = AgentDispatchResult & { assigned: boolean; transitioned: string | null; session: { name; startedAt; repo } }`.
- Produces `AgentsService.spawnInProject(projectPath: string, opts: { prompt; name; permissionMode; model?; effort?; remoteControl }): Promise<AgentDispatchResult>`
  — the tail of `dispatch()` (project map → 409 `the dashboard cannot see this project`, `clampMode` against the status ceiling, `pickFrom` for model and
  effort, `spawn`). `dispatch()` is refactored to call it, behaviour unchanged (its suite stays green untouched).
- Produces `JiraDispatchService.dispatch(req): Promise<JiraDispatchResult>`; `jiraSessionName` from Task 3.

Order (spec §7, every refusal before the first Jira write releases nothing because nothing is reserved yet):
1. Controller shape check → 400 (`key` via `isJiraKey`, `action` via `parseJiraAction`, `repo` non-empty string, `assign` boolean, `transitionId` null or a
   string ≤ `JIRA_TRANSITION_ID_MAX_CHARS`, hoisted from `jira-write.controller.ts` to `config.util.ts` so a service never imports a controller). Guard: the `SameOriginPostGuard` every agents POST carries.
2. Jira unconfigured → 503; `jira.json` unreadable → 409; unknown skill → 400; repo not mapped to the key's project → 400. The key's project is the part
   before the `-` — no Jira read is needed to know it.
3. `projectDispatchGate(await agents.status(), repo)`: not enabled → 409 with the gate's reason, or 502 when agents are on and the dashboard unreachable —
   `dispatch()`'s exact mapping.
4. `live.reserve(key, repo)` false → 409 `<KEY> already has a session` (or `… is starting`). From here on every failure calls `live.release(key)`.
5. `assign` true and the poller's `me` null → 503 `no identity`. Fresh `poller.issueDetail(key)` (mapped by `unwrapJira`); `transitionId` not in its
   transitions → 400 `transition not offered`; first compose → 400 `prompt too long`.
6. Assign (skipped, `assigned: false`, when the detail's assignee is already `me`) → transition → each through `jiraWriteOrThrow`, its error sentence
   prefixed `assign: ` / `transition: ` and, after a landed assign, suffixed `— the assign stands`.
7. Re-read the detail, compose again (400 with `— the Jira writes stand` when it no longer fits), `agents.spawnInProject(repo, …)` with name
   `jiraSessionName(key)`. A spawn failure keeps its status and gains `— the Jira writes stand` when any write landed.
8. `live.confirm(key, sessionId)`; return the result. (Task 6 adds the reconciler's `arm()` call here.)

- [ ] **Step 1: Failing tests:** each refusal in steps 1–5 makes no Jira write and no spawn (assert the in-memory Jira's write log and the stub dashboard's
  spawn count are empty) and leaves `live` without the key; unmapped repo 400; dashboard-blind repo 409; agents off 409; dashboard down 502; a live key 409
  and a `starting` key 409; two concurrent dispatches on one key (`Promise.all`) → one 200, one 409, one spawn; the over-cap prompt 400 before any write;
  happy path order is assign → transition → spawn (write log order) with `assigned: true`, `transitioned: '<transition name>'`, session name `jira PAY-1`,
  and `GET /api/jira` then shows `live['PAY-1'].starting === false`; already-assigned-to-me → no assign call, `assigned: false`; a transition Jira refuses
  with 400 after a landed assign → 409 whose text starts `transition: ` and ends `the assign stands`, key released; spawn 502 after both writes → 502
  ending `the Jira writes stand`, key released; a skill action spawns its template's text.
- [ ] **Step 2–4:** Red, implement, green; also run `test/agents-dispatch.test.ts` and `test/jira-write-routes.test.ts` (the two refactors); typecheck.
- [ ] **Step 5: Commit** `feat(agents): dispatch-jira — assign, transition, then spawn`.

### Task 6: `POST /api/agents/jira-stop` and the reconciler

**Files:**
- Create: `server/src/agents/session-stop.util.ts`, `server/src/agents/jira-live.service.ts`
- Modify: `server/src/agents/items-abort.service.ts` (uses the hoist), `server/src/agents/agents.service.ts` (`dashboardSessions`),
  `server/src/agents/jira-agents.controller.ts`, `server/src/agents/jira-dispatch.service.ts`, `server/src/agents/agents.module.ts`
- Test: `test/agents-jira-stop.test.ts`, `test/agents-jira-live.test.ts` (new); `test/tracker-abort.test.ts` (covers `stopSession` today — run it unchanged)

**Interfaces:**
- Produces `stopDashboardSession(cfg: AgentsConfig, session: string, untouched: string): Promise<boolean>` — `ItemsAbortService.stopSession` moved verbatim,
  its `— the claim is untouched` tail becoming `— ${untouched}`; items-abort passes `the claim is untouched`, jira-stop passes `Jira is untouched`.
- Produces `dashboardSessions(cfg): Promise<Map<string, string>>` (id → status, `'unknown'` for a missing status string; throws the same 502s), and
  `dashboardSessionStatus` re-expressed over it.
- Produces `JiraLiveReconciler` (`OnApplicationShutdown`): `arm(): void` (idempotent), `tick(): Promise<void>` (public for tests), constant
  `JIRA_RECONCILE_MS = 60_000`, `JIRA_LIVE_GRACE_MS = 120_000`.

`jira-stop`: shape (`key` via `isJiraKey`) → 400; agents off → 409 with `environmentBlock`'s sentence; key absent → 409 `no live session for <KEY>`; entry
`starting` → 409 `<KEY> is still starting`; else stop: `true` or `false` both `live.clear(key)` and answer `{ ok: true }`; a 502 leaves the entry. Jira is
never called. Reconciler tick: agents off or the list throws → map untouched; for each `confirmed()` entry older than the grace, keep it when the status is
`working` or `question`, else `clear`; after the tick, `hasConfirmed()` false → disarm. The timer never runs in a request path and swallows its own errors
(the watchdog's `spawn` comment says why).

- [ ] **Step 1: Failing tests.** Stop: 200 clears; the dashboard's `no live session` 404 clears; another 404 or a 500 → 502, entry kept; unknown key 409;
  starting key 409; agents off 409; a cross-origin POST refused. Reconciler (fake timers): `idle` dropped; absent dropped; `working` and `question` kept; an
  entry 90 s old untouched even when absent; a `starting` entry untouched; the list answering 500 → nothing dropped; disarmed once nothing is confirmed (no
  further fetch after advancing 120 s); `arm()` twice → one timer. Plus `test/tracker-abort.test.ts` stays green untouched.
- [ ] **Step 2–4:** Red, implement, green; typecheck.
- [ ] **Step 5: Commit** `feat(agents): jira-stop and the live-map reconciler`.

### Task 7: Part A docs, rules and the PR

**Files:** `CLAUDE.md`, `.claude/rules/jira.md`, `.claude/rules/dispatch-watchdog.md` (the dispatch bullet at :15 and the spawn-prompt bullet at :31 — a widened headline must stay byte-equal with CLAUDE.md's, `test/claude-rules.test.ts`), `docs/subsystems/
invariants.md`, `docs/subsystems/jira.md`, `docs/subsystems/api.md`, `docs/overview.md` (its `jira/` line: six read routes and five POSTs become seven and seven).

- [ ] **Step 1:** Widen `jira.md`'s `paths:` with `server/src/agents/jira-*.ts`, so a session editing the reconciler or dispatch service loads the rule. New headline (CLAUDE.md, `jira.md` bullet, `invariants.md` section, all byte-equal): **A Jira session is remembered in server memory only;
  a restart forgets it, and Stop is the one hand that clears it early.** — the mechanism (reserve-before-write, cap, TTL, reconciler rules, `agents → jira`).
- [ ] **Step 2:** Widen in all three homes: "The orchestrate spawn prompt is composed server-side" → "The orchestrate and Jira spawn prompts are composed
  server-side" (item dispatch still takes the sheet's prompt); "Dispatch derives the action; it never accepts one" gains the Jira clause (a PICK from a closed
  set — the two built-ins and `jira.json`'s skills — validated server-side, 400 otherwise); the CLAUDE.md layout line for `agents/` names `dispatch-jira`,
  `jira-stop` and the reconciler, and for `jira/` the skills routes, the prompt route and the live map.
- [ ] **Step 3:** `docs/subsystems/jira.md`: `skills` now has its writer; `/prompt` is no longer a 404; the live map section; the error mapping for the two
  agents routes. `api.md`: the two agents routes.
- [ ] **Step 4:** Run `test/claude-rules.test.ts`, `test/dialog-count-docs.test.ts` (unchanged count — sanity), typecheck, `pnpm run build`.
- [ ] **Step 5:** Commit `docs(jira): phase 5a — live map rule, dispatch and spawn-prompt widenings`; push; open the PR titled as in the conventions; bind it
  with the ccd_pr tools. Smoke by hand against the running stack before asking for merge: `curl` the prompt route for a real key and a mapped repo.

---

# Part B — PR 5b, client (cut from `main` after 5a merges)

### Task 8: `jiraDefaultAction`, the derivations, and the Skills card

**Files:**
- Modify: `client/src/lib/settings.ts`, `client/src/lib/jira.ts`, `client/src/components/settings/SettingsView.tsx` (its inline `DispatchGroup`), `client/src/components/jira/JiraSetupView.tsx`
- Create: `client/src/components/jira/JiraSkillsGroup.tsx`
- Test: `test/settings.test.ts`, `test/jira-lib.test.ts`, `test/jira-setup.test.tsx`, `test/settings-view.test.tsx`

**Interfaces:**
- Produces in `settings.ts`: `jiraDefaultAction: string`, default `'execute'`, clamped to a non-empty string of at most 64 characters.
- Produces in `lib/jira.ts`: `resolveJiraAction(setting: string, skills: JiraSkill[]): JiraAction` (`'execute'`/`'context'` as themselves, an id present in
  `skills` → `{ skill }`, anything else → `'execute'`); `jiraSettingOf(a: JiraAction): string` (its inverse); `runChipState(issue: JiraIssue, status: JiraStatusPayload): 'no-repo' | 'live' | 'ready'`
  (`live` when `status.live[issue.key]` exists, starting or not; `ready` needs at least one mapped path for the issue's project); `defaultModeFor(a: JiraAction): PermissionMode`.

The Dispatch row `Jira default action` is a `Select` over the two built-ins (by label) and the skills from `useJiraContext()`, drawn only while the status
says configured. The Skills card (spec §6.4, mock `Setup.html`) sits under Connection: two locked rows (label + `built-in`), one row per skill (name, the
template in mono clamped to two lines, × through `ui/Confirm`), an add row (name `TextInput`, template textarea, `Add` disabled until both are non-empty
after trim), and the hint listing the five placeholders and "a skill has to exist in the repo or the Claude install; this list only names it". Every save
and delete reloads `GET /api/jira`; a refusal shows the server's sentence under the add row.

- [ ] **Step 1: Failing tests:** `clampSettings({ jiraDefaultAction: '' })`, `42`, a 65-char string → `'execute'`; `'s_0123abcd'` kept.
  `resolveJiraAction('s_gone', [])` → `'execute'`; present id → `{ skill }`; `'context'` → `'context'`. `runChipState`: unmapped project → `no-repo`; mapped
  and live → `live`; mapped, starting → `live`; mapped, idle → `ready`. Setup render: two locked rows have no ×; Add posts `{ name, prompt }` trimmed to
  `/api/jira/skills` and reloads; × asks Confirm then posts `{ id }` to `/skills/delete`; a 400 renders its sentence. Settings: the row is absent while
  unconfigured; a stored gone skill renders the select at `Work it end to end`.
- [ ] **Step 2–4:** Red, implement (cite DESIGN.md §8.9 subsections in each new component's header), green; typecheck.
- [ ] **Step 5: Commit** `feat(jira): the Skills card and the default action`.

### Task 9: The launch sheet

**Files:**
- Create: `client/src/components/jira/JiraLaunchSheet.tsx`
- Test: `test/jira-launch.test.tsx` (new)

**Interfaces:**
- Consumes: `resolveJiraAction`, `defaultModeFor`, `jiraActionParam`, `useAgents` (`client/src/hooks/useAgents.ts`), `projectDispatchGate`, `modesUpTo`,
  `sessionUrl` (`client/src/lib/agents.ts`), `FormSheet`, `Select`, `Switch`.
- Produces in `client/src/lib/jira.ts`: `dispatchJira(req: JiraDispatchRequest): Promise<JiraDispatchResult>` and `stopJira(key: string): Promise<void>`
  (Task 10 consumes `stopJira`), throwing the server's sentence.
- Produces: `JiraLaunchSheet({ issue, initialAction, onClose, onStarted }: { issue: JiraIssue; initialAction: JiraAction | null; onClose: () => void; onStarted: () => void })`.

Behaviour, spec §7 field by field: Action seeded from `initialAction ?? resolveJiraAction(settings.jiraDefaultAction, skills)`; prompt preview from
`GET /api/jira/prompt` re-fetched on action or repo change (stale answers dropped — `useFetched`), read-only `.sheet-prompt`, a refusal rendered in its place;
Repository over the project's mapped paths (shown with `~`), preselected when there is one; Assign to me (`Switch`, off, disabled with a title when the
detail's assignee is `me` or `me` is null); Move to (`Select`, `leave as is` first, then the detail's transitions named as the modal names them — reuse the
modal's label function, hoisting it to `lib/jira.ts` if it is local); Model · effort seeded from Settings; Permissions over `modesUpTo(ceiling)` seeded by
`defaultModeFor`; Remote control (on). The transitions and assignee come from one `GET /api/jira/issue/:key` on open. Footer: **Copy prompt** (clipboard;
`Copied` for 2 s; on a missing clipboard API the button is absent and the preview stays selectable) and **Start**, drawn only when
`projectDispatchGate(agentsStatus, repo)` is not `hidden`, disabled with the gate's reason when `disabled`. Start posts `JiraDispatchRequest`; success shows
the session link (`sessionUrl(linkBase, sessionId)`) and calls `onStarted` (the caller reloads `/api/jira` and the board); a refusal shows the server's
sentence and keeps Copy prompt.

- [ ] **Step 1: Failing tests:** agents disabled → no Start, Copy prompt present; gate `disabled` → Start disabled with the reason as its title; one mapped
  path preselected, two → a select; switching action refetches the preview with `action=skill%3As_…`; `context` seeds `plan`, `execute` seeds `acceptEdits`
  but never above the ceiling; Start body carries `transitionId: null` for `leave as is`; a 409 renders its text and Copy prompt stays; success renders a
  link to the session and calls `onStarted` once; a gone skill as `initialAction` (preview 400 `unknown skill`) shows the sentence and Start stays disabled.
- [ ] **Step 2–4:** Red, implement, green; typecheck.
- [ ] **Step 5: Commit** `feat(jira): the launch sheet — Start and Copy prompt`.

### Task 10: `Run ▾`, the strip, and the modal's Run, Stop and session fact

**Files:**
- Create: `client/src/components/jira/JiraRunMenu.tsx`
- Modify: `JiraCard.tsx`, `JiraBoardView.tsx` (hosts the one launch sheet), `JiraIssueModal.tsx`, `client/src/styles.css`
- Test: `test/jira-board.test.tsx`, `test/jira-modal.test.tsx`, `test/use-jira.test.tsx`

**Interfaces:**
- Produces: `JiraRunMenu({ issue, onPick }: { issue: JiraIssue; onPick: (a: JiraAction) => void })` — reads status from `useJiraContext()`.
- `JiraBoardView` owns `{ issue, action } | null` for the sheet; the card and the modal both call `onRun(issue, action)`. The sheet mounts above an open modal
  (Escape closes only the sheet — the existing stack does this; a test asserts it).

`Run ▾` (spec §7, mock `RunMenu.html`) on every card's marker row and in the modal's controls row: `no-repo` → dashed, title `no repository mapped for <PROJECT> —
Jira › Setup › Repositories`, opens nothing; `live` → disabled with title `a session is running on <KEY>`; `ready` → a `Popover` with the two built-ins, a
rule, the skills by name, and a note (`opens the launch sheet`). Never hidden for agents' sake. On a card the chip stops click and Enter/Space propagation
(the card's own link-out precedent). The strip (`board-card-live hatch`, as the Board's live card): `session · <repo basename>` and the elapsed reading
from `startedAt`, or `starting`. On a folded card the strip shows for a live folded issue too, naming its key (the grouped-board design's ruling). Modal:
a `session` fact (`<name> · <repo> · <elapsed>`, `starting`, or `—`), `Run ▾`, and `Stop session` through `ui/Confirm` → `POST /api/agents/jira-stop`, drawn
only while agents are enabled and the key has a confirmed entry; after Stop both `/api/jira` and the board reload.

- [ ] **Step 1: Failing tests:** card for an unmapped project → dashed chip with that title, click opens no menu and no modal; live key → disabled chip and
  the strip with the repo basename; starting → strip reads `starting`; ready → menu lists both built-in labels and a skill name, a pick opens the sheet with
  that action and not the modal; modal shows Stop only with agents on and a confirmed entry, Confirm → posts `{ key }` and reloads; Escape with the sheet
  open over the modal closes the sheet only. `use-jira` (spec §11): a resolved `dispatch-jira` triggers exactly one `GET /api/jira` and the strip appears
  without waiting for the timer; a resolved `jira-stop` does the same and the strip is gone.
- [ ] **Step 2–4:** Red, implement, green; typecheck.
- [ ] **Step 5: Commit** `feat(jira): Run ▾ on cards and the modal, the live strip and Stop`.

### Task 11: Part B docs, rules and the PR

**Files:** `CLAUDE.md`, `.claude/rules/board.md`, `docs/subsystems/invariants.md`, `.claude/DESIGN.md` (§8.7, §8.9), `docs/subsystems/board.md`,
`docs/subsystems/jira.md`, `client/src/hooks/useDialogEscape.ts` (its count comment), `test/dialog-count-docs.test.ts`.

- [ ] **Step 1:** New headline in all three homes: **Run ▾ on a Jira card is never hidden for the dashboard's sake: Copy prompt is its second exit, and only
  Start hides.**
- [ ] **Step 2:** Widen "An environment-level block hides the dispatch control; the per-item ones disable it" and `board.md`'s "with `BM_AGENTS` off the
  board shows no dispatch buttons" with "on the Board", naming the Jira card's `Run ▾` as the stated exception.
- [ ] **Step 3:** The dialog count moves from six to seven (the launch sheet composes `FormSheet`; spec §12 says "to six", written before the What's new drawer made today's six): §8.7, `board.md`'s Escape bullet, `invariants.md`'s
  Escape section, the hook's comment, and `dialog-count-docs`' expectations — keeping the earlier counts' history the way the test's own comment does.
- [ ] **Step 4:** DESIGN.md §8.9: replace the "phase 5's and still ABSENT" sentences in §8.9.1 and §8.9.2 with the Run ▾, strip, session fact and Stop;
  add the launch sheet and the Skills card subsections. `jira.md`: the client half of Run.
- [ ] **Step 5:** Run `test/claude-rules.test.ts`, `test/dialog-count-docs.test.ts`, typecheck, `pnpm run build`. Then the real-app check: `pnpm run docker:up`
  (or the running stack), open Jira › Board in the browser pane, open the sheet on a real ticket, Copy prompt, and — only on a ticket the user names — Start.
- [ ] **Step 6:** Commit `docs(jira): phase 5b — Run ▾ rule, environment-block widening, seven dialogs`; push; open the PR; bind it.

---

## Self-review notes (author's, 2026-10-19)

- **Spec coverage:** §2 → T8; §3 prompt → T2, live map → T3, reconciler → T6; §4 → T2/T3/T5; §5 skills → T1, prompt → T4, dispatch-jira → T5, jira-stop → T6;
  §6.1 derivations → T8; §6.2/§6.3 → T10; §6.4 Skills → T8; §6.5 Dispatch row → T8; §7 → T5/T9/T10; §8 errors → T5's step prefixes; §9 built-ins → T2;
  §13 → T7/T11.
- **Deviations from the spec, each a plan ruling the implementer may contest:** (R1) the spec's `JiraService` does not exist — the poller holds the state —
  so the live map is its own `JiraLiveService` and the controller, not the poller, folds it into the payload. (R2) `jiraSessionName` lives in `shared/types.ts`
  so `jira/` never imports `agents/`. (R3) assigning an issue already assigned to me is skipped and reported `assigned: false`. (R4) the prompt route
  requires `repo` (a template's `{repo}` and the mapping check both need it; a `no-repo` chip never opens the sheet). (R5) the controller of the two agents
  routes is a new file rather than a fifteenth handler in `agents.controller.ts`. (R6) a `starting` entry is never the one evicted. (R7)
  `jiraDefaultAction` is capped at 64 characters. (R8) Stop is drawn for a confirmed entry only — a `starting` one has no session to stop.
