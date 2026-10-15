# Jira integration — phase 1, server read — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `server/src/jira/` module that reads a Jira Cloud site through the API gateway, keeps one in-memory cache per configured board, and serves six of
the seven read routes of the spec's §5 under `/api/jira` (`/prompt` is phase 5's) — nothing written to Jira, nothing written to `jira.json`, no client code.

**Architecture:** A third outbound-calling Nest module beside `tracker/` and `agents/`, built in the tracker's shape: a plain `JiraClient` over an injected
`fetch` (no decorators, provided by factory, overridden in tests), a `setTimeout`-chain poller that arms itself only while something is owed, pure mappers
(`map-issue.ts`, `adf.ts`, `block.ts`) with no I/O, and one controller whose every answer comes from the poller's cache or one fresh client call. Credentials
are read from the environment per call and cached nowhere; the board list is read from `~/.backlog-manager/settings/jira.json` per use and cached nowhere.

**Tech Stack:** NestJS 11 on Node 22 (`fetch`, `AbortSignal.timeout`), TypeScript strict, jest + supertest (`test/helpers/app.ts`'s `listenLoopback`), pnpm. No
new dependencies.

**Spec:** [docs/superpowers/specs/2026-10-15-jira-integration-design.md](../specs/2026-10-15-jira-integration-design.md) — §2 scopes, §3 server, §4 shapes, §5
reads, §8 error mapping and ADF, §10 security, §11 testing, §12 phase 1, §13 rules, §14 probe findings (P1–P14 are the facts the tests below encode).

**Plan conventions (they override the writing-plans template where the two differ):**
- Every task states BEHAVIOUR and EXACT TEST CASES — inputs, expected values, edge cases — never literal code. The implementer writes the code and the test
  bodies, and is expected to disagree with a case here when the spec or the probe says otherwise (and to say so in the commit). Reason: handed code gets
  transcribed verbatim, bugs included (the user's CLAUDE.md, "Learnings").
- Signatures in **Interfaces** are the one place a name is fixed; a later task that consumes a name must spell it exactly as the producing task does.
- Size budgets are soft targets, never a reason to drop a rule or a comment. Every new file carries a header comment that explains WHY, at the density
  `server/src/tracker/*.ts` has, and cites the spec section it implements. New prose wraps at 160 columns.
- Commit after every task with the message given; nothing is pushed by this plan. The branch is `feat/jira-phase-1-server-read`, cut from
  `docs/jira-integration-spec` (the branch that carries the spec and this plan — neither is on `main` yet) or from `main` once that branch has merged; the PR
  title (`ci / pr-title`) is `feat(jira): server read — client, poller, cache, read routes`.
- Run only the suites a task touches (`pnpm run test:jest -- test/<name>.test.ts`); CI runs the whole suite on the PR. `pnpm run typecheck` before each commit.

## Global Constraints

Copied from the spec and CLAUDE.md; every task's requirements include these.

- Every route lives under `/api` and behind the Host allowlist `AppModule` already applies (`applySecurityMiddleware`); the CSP is untouched.
- `BM_JIRA_SITE`, `BM_JIRA_EMAIL`, `BM_JIRA_TOKEN` are read from `process.env` on every call, trimmed, never cached (the shape of `githubToken()`); the site is
  a hostname only (`acme.atlassian.net`), lower-cased, no scheme, path, port or query; the server always speaks `https://`.
- Every Jira call goes to the gateway `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/…` (P14); `cloudId` comes from the unauthenticated `GET
  https://<site>/_edge/tenant_info` (`{ cloudId }`); only `browse` links use `https://<site>/browse/<KEY>`; one extra `GET https://<site>/rest/api/3/myself` at
  boot decides `tokenKind` (`classic` on 200, `scoped` on 401), asked once per process.
- The token and the email reach no payload, no log line, no URL; the payload carries `site`, `me.name`, `me.accountId` only (§10).
- `~/.backlog-manager/settings/jira.json` (`BM_JIRA_FILE` overrides) is read fresh per use and cached nowhere; per-ENTRY fallback; a file that exists and cannot
  be read or parsed is reported (`configUnreadable`) and never replaced — this phase has no writer at all.
- Every value the server itself puts into JQL is double-quoted with `\` and `"` backslash-escaped (`key = "PAY-1"`, `summary ~ "x*"`); a person's JQL is passed
  verbatim (§10). `isJiraKey` is `^[A-Z][A-Z0-9_]+-\d+$`.
- Constants, one home each: `JIRA_POLL_MS = 15_000`; `DEFAULT_JIRA_INTERVAL = '1m'` (type `SyncInterval`, table `SYNC_INTERVALS`); `JIRA_QUERY_CAP = 200`,
  `JIRA_ROOT_CAP = 200`, `JIRA_BOARD_CAP = 500`, `JIRA_DESCENDANT_ROUNDS = 2`; `JIRA_DONE_WINDOW_DAYS = 14` (in `map-issue.ts` only);
  `JIRA_RATE_LIMIT_DEFAULT_MS = 60_000`; identity/boot back-off 15 s doubling to a 5 min cap (`JIRA_BACKOFF_MIN_MS = 15_000`, `JIRA_BACKOFF_MAX_MS = 300_000`);
  `JIRA_SEARCH_LIMIT = 20`, `JIRA_SEARCH_MAX_CHARS = 100`; `JIRA_TIMEOUT_MS = 10_000` (the bound `runGit` uses).
- Error mapping (§8), one function, used by every route, every body `{ error, access?, retryAt? }` — `error` because it is this API's one error key (120 sites
  say `{ error: … }`, and the client's shared unwrapper reads `data.error`): Jira 401 → HTTP 503 `Jira rejected the credentials` (`access: 'unauthorized'`); 403
  → 502 `Jira refused: <message>`; 429 → 503 `Jira rate limit — retry after <ISO instant>` (+ `retryAt`), and a read inside a known 429 window is refused up
  front with the same 503 and NO call sent; transport failure or timeout → 502 `Jira unreachable: <message>`; 400 → 409 `Jira refused: <message>`; 404 → 404
  `issue not found`; any other 5xx → 502 `Jira answered <status>`. Only a 401 (resets `me`, `access: 'unauthorized'`) and a 429 (opens the window, `access:
  'rate-limited'`) met on a ROUTE move the site-level state; a 0, 5xx, 400, 403 or 404 on a route answers its mapping and leaves `access` to the sweep.
  Unconfigured → 503 `Jira is not configured` on every route but `GET /api/jira` (which answers 200 with `configured: false`).
- The sweep's field list is exactly `summary issuetype status priority assignee reporter parent subtasks labels created updated resolutiondate project` plus the
  discovered sprint field; search pages ask `maxResults: 100` and follow `nextPageToken` (string, present only while `isLast: false` — P2).
- jest suites are flat in `test/`, supertest listens through `listenLoopback`, fixture dates are computed relative to the clock the assertion runs under, and NO
  suite may reach a real Jira: `test/helpers/env.ts` blanks the three keys (Task 1), and every suite that builds `AppModule` with them set overrides
  `JiraClient` with one built on a fake `fetch`.
- Comments explain why, at length; `.claude/rules/jira.md` bullets are anchored once each into `docs/subsystems/invariants.md`; CLAUDE.md headlines are
  byte-equal with the rule file's bold spans (`test/claude-rules.test.ts`).

## Review Focus

Inputs the spec implies but names no test for, most likely to bite first; each line's test is added to the task that owns the code.

1. `BM_JIRA_SITE=https://acme.atlassian.net/` (a pasted URL) must read `configured: false` with a `detail` that names the key and says hostname only, never a
   request to `https://https://…` — Task 1.
2. `tenant_info` unreachable at boot (DNS down, a typo in the hostname) must leave `access: 'unreachable'` with no search ever sent, keep retrying on the
   back-off, and `GET /api/jira` must still answer 200 — Task 6.
3. A search page answering `isLast: false` with no `nextPageToken` must end the walk at that page, with no second request and `truncated: false` — Task 6.
4. `jira.json` holding `"boards": {}` (an object, not an array) must read as no boards with `unreadable: null`, and `repos`/`skills` still read — Task 2.
5. `GET /api/jira/issue/:key` for a key on no board must still answer 200 from a fresh read with `boards: []`; a Jira description of `null` must render as
   `description: ''` and the block's `(no description)` line, never the string `null` — Tasks 6, 7 and 8.

---

## File structure

| file                                       | responsibility                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `shared/types.ts` (modify, append)          | the Jira shapes of spec §4 that this phase serves, `isJiraKey`, `DEFAULT_JIRA_INTERVAL`                           |
| `server/src/jira/env.util.ts`               | the three credentials: `jiraEnv()`, hostname validation, the one spelling of each variable                        |
| `server/src/jira/config.util.ts`            | `jira.json`'s reader half: path, per-entry validation, `unreadable`                                                |
| `server/src/jira/jira.client.ts`            | the one `fetch` wrapper: gateway base, Basic auth, timeout, response normalisation, call counting, `jqlString`     |
| `server/src/jira/errors.util.ts`            | §8's one mapping from a `JiraResponse` to the HTTP answer, and `accessOf`                                         |
| `server/src/jira/adf.ts`                    | ADF → Markdown, pure                                                                                              |
| `server/src/jira/map-issue.ts`              | Jira JSON → `JiraIssue`, the sprint pick, the Done window, the field list                                          |
| `server/src/jira/identity.ts`               | the boot state: cloudId, serverInfo, me, token kind, sprint field, access/detail, back-off                        |
| `server/src/jira/poller.service.ts`         | the ticker, the board caches, the sweep, the fresh reads the routes need, `status()`                              |
| `server/src/jira/block.ts`                  | the ticket block, one renderer for `?format=text` now and `jira.mjs show` / the prompt later                      |
| `server/src/jira/jira.controller.ts`        | the six read routes of this phase                                                                                |
| `server/src/jira/jira.module.ts`            | wiring; `JiraClient` by factory; exports the poller for phases 3–5                                                |
| `server/src/app.module.ts` (modify)         | imports `JiraModule`                                                                                             |
| `test/helpers/jira.ts`                      | an in-memory Jira over the endpoints this phase touches, faked at `fetch` inside a real `JiraClient`              |
| `test/helpers/env.ts` (modify)              | blanks the three keys for every suite; defaults `BM_JIRA_FILE` to a temp path                                     |
| `test/jira-*.test.ts` (eight suites)        | per task below                                                                                                   |
| `.env.example`, `docker-compose.yml`, `test/compose-env.test.ts` (modify) | the three keys documented and passed through as interpolations with defaults                    |
| `docs/subsystems/jira.md` (new), `docs/overview.md`, `docs/subsystems/api.md`, `docs/subsystems/invariants.md`, `CLAUDE.md`, `.claude/rules/jira.md` (new), `.claude/rules/tracker.md` | the docs and rules of §12 phase 1 and §13 |

Not in this phase (later plans): every write route and `jira.json` writer (phase 2), assign/transition and the splice (3), `skills/jira` (4), prompt, dispatch,
stop, the live map and `agents/jira-live.service.ts` (5), all client code (2 and 5).

---

### Task 1: Shared shapes, `isJiraKey`, and the credential reader

**Files:**
- Modify: `shared/types.ts` (append a `// ── Jira ──` section after the tracker types, before the dashboard permission ladder)
- Create: `server/src/jira/env.util.ts`
- Modify: `test/helpers/env.ts`
- Test: `test/jira-env.test.ts`

**Interfaces:**
- Produces (`shared/types.ts`): `JiraStatusCategory = 'new' | 'indeterminate' | 'done'`; `JiraAccess = 'ok' | 'unconfigured' | 'unsupported' | 'unauthorized'
  | 'forbidden' | 'rate-limited' | 'unreachable'`; `JiraTokenKind = 'classic' | 'scoped'`; `interface JiraIssue` exactly as §4 lists it (`key, id, url, summary,
  project { key, name }, type { name, level, subtask }, status { name, category }, priority: string | null, assignee { accountId, name } | null, reporter:
  string | null, parent { key, summary } | null, subtasks: number, labels: string[], sprint: string | null, created, updated: string, resolved: string | null`);
  `interface JiraQuery { id, label, jql }`; `interface JiraBoard { id, name, roots: string[], queries: JiraQuery[], interval: SyncInterval }`; `interface
  JiraSkill { id, name, prompt }`; `interface JiraBoardFailure { kind: 'root' | 'query'; id: string; message: string }`; `interface JiraBoardStatus extends
  JiraBoard { polledAt: string | null; count: number; truncated: boolean; failures: JiraBoardFailure[] }`; `interface JiraTransition { id: string; name: string;
  to: { name: string; category: JiraStatusCategory } }`; `interface JiraIssueDetail extends JiraIssue { description: string; children: JiraIssue[]; transitions:
  JiraTransition[]; boards: string[]; session: null }` (`session` is typed `null` in this phase; phase 5 widens it); `interface JiraStatusPayload { configured:
  boolean; configUnreadable: string | null; site: string | null; me: { accountId: string; name: string } | null; tokenKind: JiraTokenKind | null; access:
  JiraAccess; detail: string | null; boards: JiraBoardStatus[]; repos: Record<string, string[]>; projects: { key: string; name: string }[]; skills: JiraSkill[];
  calls: { sweep: number; last429At: string
  | null }; live: Record<string, never> }` (`live` is always `{}` in this phase; phase 5 widens it); `DEFAULT_JIRA_INTERVAL: SyncInterval = '1m'`;
  `JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/`; `isJiraKey(value: unknown): value is string`.
- Produces (`env.util.ts`): `JIRA_ENV = { site: 'BM_JIRA_SITE', email: 'BM_JIRA_EMAIL', token: 'BM_JIRA_TOKEN' } as const`; `type JiraEnv = { configured: true;
  site: string; email: string; token: string } | { configured: false; detail: string }`; `jiraEnv(env: NodeJS.ProcessEnv = process.env): JiraEnv`;
  `isJiraHostname(value: string): boolean`.

- [ ] **Step 1: Write the failing tests** in `test/jira-env.test.ts`, one `it` per line:
  - `isJiraKey`: `'PAY-1'`, `'PAY_2-10'`, `'PAY-01'`, `'A1-7'` → true; `'pay-1'`, `'P-1'`, `'1PAY-1'`, `'PAY-'`, `'PAY-1 '`, `' PAY-1'`, `'PAY-1\n'`, `123`,
    `null`, `undefined` → false.
  - `isJiraHostname`: `'acme.atlassian.net'`, `'jira.corp.example'` → true; `'https://acme.atlassian.net'`, `'acme.atlassian.net/'`, `'acme.atlassian.net:443'`,
    `'acme'` (no dot), `'acme .atlassian.net'`, `''` → false.
  - `jiraEnv` with all three set (`'acme.atlassian.net'`, `' ada@example.com '`, `' tok '`) → `{ configured: true, site: 'acme.atlassian.net', email:
    'ada@example.com', token: 'tok' }` (trimmed).
  - `jiraEnv` with `BM_JIRA_SITE: 'ACME.Atlassian.NET'` → `site: 'acme.atlassian.net'` (lower-cased).
  - `jiraEnv` with the site absent → `{ configured: false, detail: 'BM_JIRA_SITE is not set' }`; with the email `'   '` → `'BM_JIRA_EMAIL is not set'`; with the
    token absent → `'BM_JIRA_TOKEN is not set'`; with all three absent → the site's detail (first in `site, email, token` order).
  - `jiraEnv` with `BM_JIRA_SITE: 'https://acme.atlassian.net/'` → `{ configured: false, detail: 'BM_JIRA_SITE must be a hostname such as acme.atlassian.net (no
    scheme, path or port): https://acme.atlassian.net/' }` — Review Focus 1.
  - `jiraEnv()` with no argument, under the jest environment, is `configured: false` — pins the `env.ts` guard from Step 3.
  - `jiraEnv` reads the object it is given on every call: two calls with two different objects give two different answers (nothing memoised).

- [ ] **Step 2: Run the suite; expect every case to fail** (`pnpm run test:jest -- test/jira-env.test.ts`) — the module does not exist.

- [ ] **Step 3: Implement.** Types appended to `shared/types.ts` with a header comment tying them to spec §4 and saying which fields later phases widen.
      `env.util.ts` in `token.util.ts`'s shape and with its header argument restated for three variables: per-call read, trim, whitespace-only is absent, the
      first missing key in `site, email, token` order names the detail, the hostname check is a regex over the lower-cased value
      (`^[a-z0-9-]+(\.[a-z0-9-]+)+$`). `test/helpers/env.ts`: add a block, argued at the length of the `BM_WATCHDOG` block above it, that sets the three keys to
      `''` UNCONDITIONALLY (`=`, not `||=`: a developer's shell export or `.env` must never arm the Jira poller — the three together make a suite that builds
      `AppModule` call a real site at boot — and `ConfigModule.forRoot` loads `.env` at import time without overriding a key that already exists, so blanking
      them here, before any import, is what keeps `.env`'s values out) and `BM_JIRA_FILE ||= <mkdtemp>/jira.json` so no suite reads the developer's real board
      list.

- [ ] **Step 4: Run the suite; expect every case to pass.** Then `pnpm run typecheck`.

- [ ] **Step 5: Commit** — `feat(jira): shared shapes, isJiraKey and the credential reader`.

---

### Task 2: `jira.json`'s reader half

**Files:**
- Create: `server/src/jira/config.util.ts`
- Test: `test/jira-config.test.ts`

**Interfaces:**
- Consumes: `JiraBoard`, `JiraQuery`, `JiraSkill`, `DEFAULT_JIRA_INTERVAL`, `isJiraKey`, `isSyncInterval` (all `shared/types.ts`).
- Produces: `jiraConfigFile(env = process.env): string` (`BM_JIRA_FILE` or `~/.backlog-manager/settings/jira.json`); `interface JiraConfig { boards:
  JiraBoard[]; repos: Record<string, string[]>; skills: JiraSkill[]; unreadable: string | null }`; `readJiraConfig(file = jiraConfigFile()): JiraConfig`;
  `JIRA_ID_RE = /^(b|q|s)_[0-9a-f]{8}$/` and `isJiraId(kind: 'b' | 'q' | 's', value: unknown)`; `JIRA_PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]+$/`.

- [ ] **Step 1: Write the failing tests**, each over a file under `mkdtempSync` (removed in `afterEach`):
  - No file → `{ boards: [], repos: {}, skills: [], unreadable: null }`. The file `{}` → the same. The file `{ "boards": [], "other": 1 }` → the same (unknown
    keys ignored).
  - A full valid file — one board `{ id: 'b_0123abcd', name: 'Sprint 42', roots: ['PAY-120'], queries: [{ id: 'q_0123abcd', label: 'mine', jql: 'assignee =
    currentUser()' }], interval: '1m' }`, repos `{ PAY: ['/w/payments-api', '/w/payments-web'] }`, skills `[{ id: 's_0123abcd', name: 'Groom', prompt:
    '/jira-groom {key}' }]` — reads back equal, arrays in file order.
  - Boards, per entry: `[valid, { id: 'b_x', name: 'bad id' }, 'a string', null, { id: 'b_0000ffff', name: '', roots: [] }, { id: 'b_0000aaaa', name: 'no
    interval', roots: ['PAY-1'], queries: [] }, { ...valid, id: 'b_0000bbbb', interval: '2h' }]` → three boards: the valid one, `b_0000aaaa` with `interval:
    '1m'`, `b_0000bbbb` with `interval: '1m'`. (An unknown or missing interval defaults; an invalid id or empty name drops the board.)
  - Roots and queries inside a board, per entry: `roots: ['PAY-1', 'pay-2', 7, 'PAY-3']` → `['PAY-1', 'PAY-3']`; `queries: [{ id: 'q_0123abcd', label: 'ok',
    jql: 'x' }, { id: 'q_1', label: 'bad id', jql: 'x' }, { id: 'q_0123abce', label: '', jql: 'x' }, { id: 'q_0123abcf', label: 'no jql' }]` → the first only. A
    board whose roots and queries both end empty is still returned. (Finer than spec §2's ENTRY — a board, a skill, one project's list — by design: a bad root
    costs the root, not its board; recorded here as the deviation it is.)
  - `"boards": {}` → `boards: []`, `unreadable: null`, and the file's `repos` still read — Review Focus 4. `"repos": []` → `repos: {}`. `"skills": "x"` → `[]`.
  - Repos: `{ PAY: ['/a', '/a', '/b'], 'bad key': ['/x'], OPS: '/y', AM: ['/z', 7, ''], EMPTY: [] }` → `{ PAY: ['/a', '/b'], AM: ['/z'] }` (dedup, key regex,
    non-array dropped, non-string and empty paths dropped, an emptied list dropped); `__proto__` as a key is skipped.
  - Skills: `[{ id: 's_0123abcd', name: 'ok', prompt: 'p' }, { id: 's_0123abce', name: 'no prompt' }, { id: 's_0123abcf', name: '', prompt: 'p' }]` → the first
    only.
  - Unreadable, two ways, each with `boards: []` and the reason: a file holding `{not json` → `unreadable: 'does not parse as JSON'`; the path being a directory
    → `'cannot be read'`. A file holding `[1, 2]` (parsed, not an object) → `unreadable: null` and everything empty: the reader folds a parsed non-object into
    nothing, as `sync-config.util.ts`'s `readRaw` does, so this reader and phase 2's writers (which replace a parsed non-object, as `writeSyncInterval` does)
    agree.
  - `jiraConfigFile({ BM_JIRA_FILE: '/x/y.json' })` → `'/x/y.json'`; `jiraConfigFile({})` ends with `/.backlog-manager/settings/jira.json`.
  - Two reads of the same path after the file changed between them give the second content (read fresh, cached nowhere).

- [ ] **Step 2: Run; expect failure** (`pnpm run test:jest -- test/jira-config.test.ts`).

- [ ] **Step 3: Implement.** Header restates `sync-config.util.ts`'s argument for a per-ENTRY fallback and names this the fourth file the server writes — in
      phase 2; this file holds the reader only, and says so. One validating function per entry kind (`readBoard`, `readQuery`, `readRepos`, `readSkill`) so
      phase 2's writers validate with the same code, adding spec §5's stricter write-time rules (lengths, counts) on top. `console.warn` once per dropped entry
      naming the file and the entry's index or id.

- [ ] **Step 4: Run; expect pass.** `pnpm run typecheck`.

- [ ] **Step 5: Commit** — `feat(jira): read jira.json with a per-entry fallback`.

---

### Task 3: The client

**Files:**
- Create: `server/src/jira/jira.client.ts`, `server/src/jira/errors.util.ts`
- Create: `test/helpers/jira.ts`
- Test: `test/jira-client.test.ts`

**Interfaces:**
- Consumes: `jiraEnv` (Task 1), `JiraAccess`.
- Produces (`jira.client.ts`): `interface JiraAuth { site: string; email: string; token: string; cloudId: string }`; `interface JiraResponse<T> { status:
  number; data: T | null; message: string | null; retryAfter: number | null }` (`status: 0` for a transport failure or timeout, `message` the error's text;
  `retryAfter` in seconds from the `retry-after` header, `null` without one); `class JiraClient` with `constructor(fetchImpl: FetchLike = fetch)`, `get calls():
  number`, `takeCalls(): number` (returns and resets), `get last429At(): string | null`, and the methods `tenantInfo(site: string): Promise<JiraResponse<{
  cloudId: string }>>`, `serverInfo(auth)`, `myself(auth)` → `JiraResponse<{ accountId: string; displayName: string }>`, `myselfAtSite(auth)` (the site-URL
  probe), `fields(auth)` → `JiraResponse<{ id: string; name: string; schema?: { custom?: string } }[]>`, `search(auth, body: { jql: string; fields: string[];
  maxResults: number; nextPageToken?: string })` → `JiraResponse<{ issues: unknown[]; isLast: boolean; nextPageToken?: string }>`, `issue(auth, key, fields:
  string[])`, `transitions(auth, key)`, `projects(auth, startAt: number)` → `JiraResponse<{ values: { key: string; name: string }[]; isLast: boolean }>`,
  `parseJql(auth, jql)` → `JiraResponse<{ queries: { errors?: string[] }[] }>`, `approximateCount(auth, jql)` → `JiraResponse<{ count: number }>`;
  `jqlString(value: string): string`; `JIRA_TIMEOUT_MS = 10_000`; `gatewayBase(cloudId): string`; `siteBase(site): string`.
- Produces (`errors.util.ts`): `accessOf(res: JiraResponse<unknown>): JiraAccess | null` (200–299 → `ok`, 401 → `unauthorized`, 403 → `forbidden`, 429 →
  `rate-limited`, 0 and 5xx → `unreachable`, any other status → `null`: a 400 or a 404 says nothing about access); `jiraHttpError(res: JiraResponse<unknown>,
  opts?: { retryAt?: string }): HttpException` — §8's table in the Global Constraints, the body `{ error, access?, retryAt? }`; `JIRA_RATE_LIMIT_DEFAULT_MS =
  60_000` (its one home; Task 6 consumes it). A read inside the 429 window is refused by the poller with a synthesised `JiraResponse` of status 429 and the
  STORED instant passed as `opts.retryAt`, so the one mapping covers it and the instant never drifts.
- Produces (`test/helpers/jira.ts`): `class FakeJira` holding `site`, `cloudId`, `me`, `deploymentType`, `fields`, a `Map<key, raw issue>`, `transitions:
  Map<key, …>`, `projects`, `answers: Map<jql, key[]>` (canned search results by exact JQL), `counts: Map<jql, number>`, `parseErrors: Map<jql, string[]>`,
  `calls: { method; url; headers; body }[]`, switches `unauthorized`, `siteMyselfStatus` (200, 401, or any other status), `rateLimit: { retryAfter: number |
  null } | null`, `failWith: number | 'transport' | null` (global), a per-request hook `failNext: (call: { method; url; body }) => { status: number; body?:
  unknown } | 'transport' | null` consulted before every canned answer (the shape of `test/helpers/github.ts`'s rule table — what lets one root fail while the
  next proceeds), `omitNextPageToken: boolean` (a page says `isLast: false` and carries no token — Review Focus 3), and a `fetch` that answers: `tenant_info`;
  `serverInfo`; `myself` (gateway, and site by `siteMyselfStatus`); `field`; `search/jql` — `key = "K"` and `key in (...)` from the map, `parent in ("A", "B")`
  — whitespace-tolerant, any spacing — from the map's `parent.key`, any other JQL from `answers` (or 400 `Field 'x' does not exist…` when absent), the empty or
  `order by`-only JQL as 400 with the exact message `Unbounded JQL queries are not allowed here. Please add a search restriction to your query.`, pages of
  `maxResults` with `nextPageToken` minted as `pN` and `isLast`; `issue/{key}` (404 for an unknown key, the field subset asked for); `issue/{key}/transitions`;
  `project/search` paged by `startAt`; `jql/parse`; `search/approximate-count` (400 on unbounded, else `counts` or the matching map size). Every answer carries
  `x-ratelimit-remaining`. Builds raw issues with `makeRawIssue(partial)` defaults an implementer can override (the P2/P4 shapes:
  `fields.issuetype.hierarchyLevel`, `fields.parent.fields.summary`, `fields.customfield_10020` as an array).

- [ ] **Step 1: Write the failing tests** (a `JiraClient` over `FakeJira.fetch`, `auth = { site: 'acme.atlassian.net', email: 'ada@example.com', token:
      't0k3n-SECRET', cloudId: 'c1' }`):
  - `jqlString('PAY-1')` → `"PAY-1"` (with the quotes); `jqlString('a"b\\c')` → `"a\"b\\c"`.
  - `gatewayBase('c1')` → `https://api.atlassian.com/ex/jira/c1/rest/api/3`; `siteBase('acme.atlassian.net')` → `https://acme.atlassian.net/rest/api/3`.
  - `tenantInfo` GETs `https://acme.atlassian.net/_edge/tenant_info` with NO `authorization` header and answers `data: { cloudId: 'c1' }`.
  - `myself` GETs `<gateway>/myself` with `authorization: Basic <base64 of ada@example.com:t0k3n-SECRET>`, `accept: application/json`, `user-agent:
    backlog-manager`; `myselfAtSite` GETs `<site base>/myself` with the same headers.
  - `search` POSTs `<gateway>/search/jql` with `content-type: application/json` and the body exactly `{ jql, fields, maxResults }` — `nextPageToken` present
    only when given.
  - `issue(auth, 'PAY-1', ['summary', 'status'])` GETs `<gateway>/issue/PAY-1?fields=summary%2Cstatus`; `transitions` GETs `<gateway>/issue/PAY-1/transitions`;
    `projects(auth, 50)` GETs `<gateway>/project/search?startAt=50&maxResults=50`; `parseJql` POSTs `<gateway>/jql/parse?validation=strict` with `{ queries:
    [jql] }`; `approximateCount` POSTs `<gateway>/search/approximate-count` with `{ jql }`.
  - Normalisation: 200 JSON → `{ status: 200, data, message: null, retryAfter: null }`; 204 → `data: null`; 400 `{ errorMessages: ['Unbounded …'], errors: {} }`
    → `message` = that sentence; 400 `{ errorMessages: [], errors: { assignee: 'User cannot be assigned' } }` → `message: 'assignee: User cannot be assigned'`;
    both arrays empty → `message: 'Jira answered 400'`; a 502 with an HTML body → `message: 'Jira answered 502'`; 429 with `retry-after: 7` → `retryAfter: 7`
    and `last429At` an ISO instant within the test's clock; 429 without the header → `retryAfter: null`; `fetch` rejecting → `status: 0`, `message` = the
    error's message; a `fetch` that never resolves → `status: 0`, `message: 'timed out after 10000 ms'` once fake timers advance `JIRA_TIMEOUT_MS` — the client
    owns a `setTimeout` + `AbortController` deadline (not `AbortSignal.timeout`, which jest's fake timers do not fire and whose message is `aborted due to
    timeout`) and clears the timer when the response lands.
  - `calls` counts every call including `tenantInfo`; `takeCalls()` returns 3 after three calls and leaves 0.
  - Over the fake's call log after every method once: neither `t0k3n-SECRET` nor the base64 of `ada@example.com:t0k3n-SECRET` appears anywhere but an
    `authorization` header value, and `ada@example.com` appears nowhere in clear.
  - `accessOf` for 200, 204, 401, 403, 429, 500, 0 → `ok, ok, unauthorized, forbidden, rate-limited, unreachable, unreachable`; for 400 and 404 → `null`.
  - `jiraHttpError` for each row of the §8 table: status and body `{ message, access }` exactly as the Global Constraints state them (`retryAt` included for a
    429 given `retryAfter: 7` under a mocked clock: now + 7 s; now + 60 s when `retryAfter` is null).

- [ ] **Step 2: Run; expect failure** (`pnpm run test:jest -- test/jira-client.test.ts`).

- [ ] **Step 3: Implement.** `github.client.ts`'s shape: no decorators, `fetch` injected, nothing thrown on a status, every failure a value. Header: why the
      gateway (P14), why `tenant_info` is unauthenticated, why the token is in one header and nowhere else, why calls are counted here (the chip's CALLS meter,
      §6). A `setTimeout` + `AbortController` deadline of `JIRA_TIMEOUT_MS` on every call, cleared on settle. `FakeJira` in `test/helpers/github.ts`'s shape
      with a header saying why a little server rather than a stub per case (the walk, the paging and the 429 window are sequences).

- [ ] **Step 4: Run; expect pass.** `pnpm run typecheck`.

- [ ] **Step 5: Commit** — `feat(jira): the client over the API gateway, and the error mapping`.

---

### Task 4: ADF → Markdown

**Files:**
- Create: `server/src/jira/adf.ts`
- Test: `test/jira-adf.test.ts`

**Interfaces:**
- Produces: `adfToMarkdown(doc: unknown): { markdown: string; placeholders: number }`; `escapeMarkdown(text: string): string`; `ADF_PLACEHOLDER_RE: RegExp` (the
  four placeholder forms at a line start — the one home, which Task 7 consumes).

- [ ] **Step 1: Write the failing tests**, one fixture per node (each fixture is the minimal ADF object: `{ type: 'doc', version: 1, content: [...] }`):
  - `null`, `undefined`, a string, `{}` → `{ markdown: '', placeholders: 0 }`.
  - One paragraph `Hello` → `Hello`; two paragraphs → `A\n\nB`; an empty paragraph between two → `A\n\nB` (no triple newline).
  - Heading level 2 `Title` → `## Title`; level 7 → `###### Title` (clamped to 6).
  - bulletList of two listItems → `- one\n- two`; orderedList → `1. a\n2. b`; a bulletList nested in a listItem → the nested lines indented two spaces.
  - codeBlock `attrs.language: 'ts'`, text `const x = 1;` → three backticks + `ts`, the text, three backticks; no language → a bare fence; text inside is NOT
    escaped (`a_b` stays `a_b`).
  - Marks: strong → `**b**`; em → `_i_`; code → `` `c` `` (content not escaped); strike → `~~s~~`; underline → the plain text; link `attrs.href` →
    `[text](href)`; strong + em on one text → `**_x_**`.
  - inlineCard `attrs.url` → `[url](url)`; mention `attrs.text: '@Ada'` → `@Ada`, `attrs.text: 'Ada'` → `@Ada`; emoji `attrs.shortName: ':smile:'` → `:smile:`;
    date `attrs.timestamp: '1700000000000'` → `2023-11-14`; status `attrs.text: 'DONE'` → `DONE`.
  - hardBreak inside a paragraph (`a`, hardBreak, `b`) → `a\nb`; rule → `---`; blockquote with one paragraph → `> text`, two paragraphs → `> a\n>\n> b`.
  - taskList with two taskItems (`state: 'TODO'`, `state: 'DONE'`) → `- [ ] a\n- [x] b`.
  - mediaSingle→media `attrs.alt: 'shot.png'` → `[attachment: shot.png]`, `placeholders: 1`; media with no alt → `[attachment]`; table → `[table omitted]`;
    panel → `[panel omitted]`; expand → `[expand omitted]`; a doc with one of each → `placeholders: 5`.
  - An unknown node `fancy` with a text child → its text; an unknown node with no children → nothing.
  - Escaping: `snake_case_name` → `snake\_case\_name`; `2 * 3` → `2 \* 3`; `a < b` → `a \< b`; `[x]` → `\[x\]`; a backslash → `\\`; `~` → `\~`.

- [ ] **Step 2: Run; expect failure** (`pnpm run test:jest -- test/jira-adf.test.ts`).

- [ ] **Step 3: Implement.** Pure, recursive, one function per node kind in a table keyed by `type`; block nodes joined by a blank line, inline nodes
      concatenated. Header cites §8 and P10 (the inventory this covers, and that `expand`, `date` and `status` were not seen but are documented nodes).

- [ ] **Step 4: Run; expect pass.** `pnpm run typecheck`.

- [ ] **Step 5: Commit** — `feat(jira): ADF to Markdown`.

---

### Task 5: Mapping an issue, the sprint pick and the Done window

**Files:**
- Create: `server/src/jira/map-issue.ts`
- Test: `test/jira-map-issue.test.ts`

**Interfaces:**
- Consumes: `JiraIssue`, `JiraStatusCategory`.
- Produces: `JIRA_ISSUE_FIELDS: readonly string[]` (exactly `['summary', 'issuetype', 'status', 'priority', 'assignee', 'reporter', 'parent', 'subtasks',
  'labels', 'created', 'updated', 'resolutiondate', 'project']`); `JIRA_DONE_WINDOW_DAYS = 14`; `pickSprintField(fields: { id: string; name: string; schema?: {
  custom?: string } }[]): string | null`; `interface MapContext { site: string; sprintField: string | null; now: number | null }` (`now: null` turns the window
  off — the search route needs any issue); `mapJiraIssue(raw: unknown, ctx: MapContext): JiraIssue | null`; `categoryOf(key: unknown): JiraStatusCategory`.

- [ ] **Step 1: Write the failing tests** (ctx `{ site: 'acme.atlassian.net', sprintField: 'customfield_10020', now: Date.parse('2026-10-16T12:00:00Z') }`;
      every date below is derived from that `now` with arithmetic, never typed as a literal that will age):
  - A full raw issue (`key: 'PAY-131'`, `id: '10001'`, `fields` with summary, `issuetype { name: 'Story', hierarchyLevel: 0, subtask: false }`, `status { name:
    'In Progress', statusCategory: { key: 'indeterminate' } }`, `priority { name: 'High' }`, `assignee { accountId: '622x', displayName: 'Ada Lovelace' }`,
    `reporter { displayName: 'Cho M.' }`, `parent { key: 'PAY-120', fields: { summary: 'Refund flows' } }`, `subtasks: [{}, {}]`, `labels: ['refunds',
    'ledger']`, `customfield_10020: [{ id: 3, name: 'Sprint 42', state: 'active' }]`, `created`, `updated`, `resolutiondate: null`, `project { key: 'PAY', name:
    'Payments' }`) → the `JiraIssue` of §4 with `url: 'https://acme.atlassian.net/browse/PAY-131'`, `type: { name: 'Story', level: 0, subtask: false }`,
    `status: { name: 'In Progress', category: 'indeterminate' }`, `priority: 'High'`, `assignee: { accountId: '622x', name: 'Ada Lovelace' }`, `reporter: 'Cho
    M.'`, `parent: { key: 'PAY-120', summary: 'Refund flows' }`, `subtasks: 2`, `sprint: 'Sprint 42'`, `resolved: null`.
  - `categoryOf`: `'new'`, `'indeterminate'`, `'done'` → themselves; `'undefined'`, `undefined`, `'weird'` → `'new'` (P5).
  - `hierarchyLevel` absent with `subtask: true` → `level: -1`; absent with `subtask: false` → `0`; `1` → `1`.
  - `parent`, `assignee`, `priority`, `reporter` absent or `null` → `null`; `labels` absent → `[]`; `subtasks` absent → `0`; `project` absent → `{ key: 'PAY',
    name: 'PAY' }` (from the key's prefix).
  - Sprint: `[{ id: 1, state: 'closed', name: 'S1' }, { id: 3, state: 'active', name: 'S3' }, { id: 2, state: 'future', name: 'S2' }]` → `'S3'`; `[{ id: 1,
    closed, 'S1' }, { id: 2, future, 'S2' }]` → `'S2'` (last by id); `[]` → `null`; `ctx.sprintField: null` → `null`; the field a string → `null`.
  - `pickSprintField`: `[epic-link field, { id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }]` →
    `'customfield_10020'` (P4); two `gh-sprint` fields, one named `Sprint` → that one; two, neither named `Sprint`, ids `customfield_10099` and
    `customfield_10020` → `'customfield_10020'` (lowest numeric id); none → `null`; `[]` → `null`.
  - Done window, category `done`: `resolutiondate` = now − 15 d → `null`; now − 13 d → kept, `resolved` = that instant; exactly now − 14 d → kept; now − 14 d −
    1 s → `null`; `resolutiondate: null` and `updated` = now − 15 d → `null`; `resolutiondate: null` and `updated` = now − 1 d → kept. Category `indeterminate`
    with `resolutiondate` = now − 40 d → kept (a stale resolution never drops a live issue). `ctx.now: null` with a done issue resolved 400 d ago → kept.
  - `raw` without `key` or without `fields` → `null`; `raw` not an object → `null`.

- [ ] **Step 2: Run; expect failure** (`pnpm run test:jest -- test/jira-map-issue.test.ts`).

- [ ] **Step 3: Implement.** Pure. Header: why the window lives here and only here (§3), why the sprint pick is active-else-last-by-id, why `undefined` maps to
      `new`, and that `level`, never the type's name, decides hierarchy (P3's oddly named subtask types).

- [ ] **Step 4: Run; expect pass.** `pnpm run typecheck`.

- [ ] **Step 5: Commit** — `feat(jira): map an issue, pick the sprint, apply the Done window`.

---

### Task 6: Identity, the poller and the board caches

**Files:**
- Create: `server/src/jira/identity.ts`, `server/src/jira/poller.service.ts`
- Test: `test/jira-poller.test.ts`

**Interfaces:**
- Consumes: `jiraEnv`, `readJiraConfig`, `JiraClient` and `JiraResponse` and `jqlString`, `accessOf`, `JIRA_RATE_LIMIT_DEFAULT_MS` (Task 3), `mapJiraIssue`,
  `pickSprintField`, `JIRA_ISSUE_FIELDS`, `adfToMarkdown`, `SYNC_INTERVALS`, every shape of Task 1.
- Produces (`identity.ts`): `JIRA_BACKOFF_MIN_MS = 15_000`, `JIRA_BACKOFF_MAX_MS = 300_000`, `nextBackoff(previous: number | null): number` (null → 15 000, then
  doubling, capped at 300 000); `class JiraBootState` holding `cloudId: string | null`, `serverInfoOk: boolean`, `me: { accountId; name } | null`, `tokenKind:
  JiraTokenKind | null`, `sprintField: string | null`, `fieldsOk: boolean`, `access: JiraAccess`, `detail: string | null`, `failedAt: number | null`,
  `backoffMs: number | null`, `retryAt: number | null` (the 429 window's end), with `answered(): boolean` (cloudId, serverInfo, me and fields all in),
  `due(now): boolean` (never asked, or `failedAt + backoffMs ≤ now`), `fail(access, detail, now)`, `reset()` (what a 401 mid-sweep does to `me`).
- Produces (`poller.service.ts`): `JIRA_POLL_MS`, `JIRA_QUERY_CAP`, `JIRA_ROOT_CAP`, `JIRA_BOARD_CAP`, `JIRA_DESCENDANT_ROUNDS`, `JIRA_SEARCH_LIMIT`,
  `JIRA_SEARCH_MAX_CHARS`, `JIRA_PAGE_SIZE = 100`; `interface JiraBoardCache { issues: JiraIssue[]; polledAt: string | null; truncated: boolean; failures:
  JiraBoardFailure[] }`; `type JiraResult<T> = { ok: true; value: T } | { ok: false; response: JiraResponse<unknown>; retryAt?: string }`; `@Injectable() class
  JiraPollerService implements OnApplicationBootstrap, OnApplicationShutdown` with `constructor(client: JiraClient)`, `get armed(): boolean`, `arm(): void`,
  `tick(): Promise<void>` (the in-flight promise when one runs), `disarm(): void`, `status(): JiraStatusPayload`, `boardIssues(id: string): { issues:
  JiraIssue[]; polledAt: string | null } | null`, `issueDetail(key: string): Promise<JiraResult<JiraIssueDetail>>`, `search(q: string):
  Promise<JiraResult<JiraIssue[]>>`, `projects(): Promise<JiraResult<{ key: string; name: string }[]>>`, `checkJql(jql: string): Promise<JiraResult<{ ok: true;
  count: number } | { ok: false; message: string }>>`, and `boardsHolding(key: string): string[]`.

- [ ] **Step 1: Write the failing tests.** Setup per case: the three keys set to fake values in `beforeEach` (`BM_JIRA_SITE=acme.atlassian.net`), `BM_JIRA_FILE`
      a temp file the case writes, a `FakeJira` and a `JiraPollerService(new JiraClient(fake.fetch))`, `Date.now` mocked (`jest.spyOn`) and advanced by hand,
      every sweep driven by `await poller.tick()` — never by real timers (the chain's `setTimeout` is asserted through `armed`, and `disarm()` runs in
      `afterEach`). Cases:
  - **Unconfigured**: site `''` → `arm()` leaves `armed` false and makes no call; `status()` → `{ configured: false, configUnreadable: null, site: null, me:
    null, tokenKind: null, access: 'unconfigured', detail: 'BM_JIRA_SITE is not set', boards: [], repos: {}, projects: [], skills: [], calls: { sweep: 0,
    last429At: null }, live: {} }`.
  - **Before the first tick** (configured, nothing called yet): `status()` → `access: 'ok'`, `detail: 'connecting'`, `me: null`, `site: 'acme.atlassian.net'`.
  - **Boot, no boards**: after one tick, the fake saw exactly `tenant_info`, `serverInfo`, gateway `myself`, site `myself`, `field` (five calls, `calls.sweep:
    5`); `access: 'ok'`, `detail: null`, `me: { accountId, name }` from the fake, `tokenKind: 'scoped'` when the site `myself` is 401 and `'classic'` when 200,
    and `null` for the life of the process on any other answer from the site probe (0, 403, 5xx — asked once, never retried); `armed` false afterwards (nothing
    owed). A second tick makes NO boot call (asked once).
  - **Boot failures**, each leaving `me: null`, no search sent, and `armed` true (owed): `tenant_info` transport failure → `access: 'unreachable'`, `detail` =
    the error's message, and the other three boot calls NOT made that tick (Review Focus 2); `serverInfo` → `deploymentType: 'Server'` or a 404 → `access:
    'unsupported'`, `detail: 'Jira Server/DC is not supported'`, and `armed` FALSE (final until restart); `myself` 401 → `access: 'unauthorized'`, `detail` =
    Jira's message; `myself` 403 → `'forbidden'`; `field` 500 → `access: 'unreachable'`, `detail: 'Jira answered 500'`.
  - **Back-off**: after a failed boot, a tick at +10 s makes no call; at +15 s one retry; failing again, the next retry waits 30 s, then 60, 120, 240, 300, 300
    (`nextBackoff` pinned directly: `null → 15000`, `15000 → 30000`, `160000 → 300000`, `300000 → 300000`). A success resets the back-off (the next failure
    waits 15 s again).
  - **Boards wait for boot**: a `'1m'` board and a `tenant_info` that fails on the first tick → no search that tick; on the tick where every boot call has
    answered the board is swept in that same tick. Spec §3's "under `unreachable` the sweep keeps trying on the same ticker" is this: the boot calls retry on
    the back-off, and no board is searched until `cloudId`, `serverInfo`, `me` and the sprint field are all in (a search made without the sprint field would
    fill a cache the next sweep could not compare with).
  - **Whole-board versus per-entry**: a board search answering 0 (transport) or a 5xx leaves that board's last good list and `polledAt` in place, sets `access:
    'unreachable'` with `detail` (the error's message, or `Jira answered 500`), and ends the sweep for that tick; a 400, 403 or 404 on one root or query is that
    entry's `failures` row, the rest of the board proceeds, and `access` is unchanged.
  - **A 401 on any later call** (a board search answering 401) → `me: null`, `access: 'unauthorized'`, the board's last good list and `polledAt` kept, and the
    retry chain starts again.
  - **One root**: board `b_…` with `roots: ['PAY-120']` where the fake holds the epic (level 1), its children `PAY-131`, `PAY-134` (level 0, `parent.key:
    'PAY-120'`) and `PAY-131`'s subtasks `PAY-132`, `PAY-133` (level −1). After the tick: the cache holds the five in the order root, children, grandchildren;
    the fake saw the searches `key = "PAY-120"`, `parent in ("PAY-120")`, `parent in ("PAY-131", "PAY-134")` and NO fourth (`JIRA_DESCENDANT_ROUNDS`); every
    search body's `fields` = `JIRA_ISSUE_FIELDS` + `customfield_10020` and `maxResults: 100`; `status().boards[0]` = `{ ...board, polledAt: <the tick's
    instant>, count: 5, truncated: false, failures: [] }`.
  - **Root Jira does not know** (`roots: ['ZZZ-1', 'PAY-120']`, the fake answers 0 issues for `ZZZ-1` — P3): `failures: [{ kind: 'root', id: 'ZZZ-1', message:
    'Jira knows no issue ZZZ-1' }]`, the other root walked. A root search answering 400 → `failures[0].message` = Jira's message. A root whose walk hits 403 → a
    failure with Jira's message, the rest of the board proceeds, `access` stays `ok`.
  - **One query**: `queries: [{ id: 'q_…', label: 'mine', jql: 'assignee = currentUser()' }]` with the fake's `answers` → the search body's `jql` is the string
    verbatim; a query the fake refuses with 400 → `failures: [{ kind: 'query', id: 'q_…', message }]`.
  - **Paging and the caps**: a query answering 250 issues in pages of 100 → two requests (the second carries `nextPageToken: 'p1'`), 200 kept, `truncated:
    false` — the per-query and per-root caps are silent, because spec §3 ties `truncated` to the 500 board cap and the Band's copy reads `first 500 shown`; a
    page with `isLast: false` and no `nextPageToken` → one request, all its issues, `truncated: false` (Review Focus 3); a root with 250 children → 200 kept,
    the root's own issue counting as the first of the 200, `truncated: false`; three queries of 200 each → 500 kept, `truncated: true`, in query order.
  - **Dedupe and order**: a query returning `PAY-131` and a root whose walk returns `PAY-131` → one entry, the query's position; two roots sharing a child → one
    entry.
  - **The Done window inside a walk**: a root's child in `done` resolved now − 15 d is absent from the cache, but its own subtask (live) IS present (the `parent
    in` round still named the dropped key). A ROOT in `done` resolved now − 15 d is itself absent from the cache, carries no `failures` entry (Jira knew it),
    and its children are present (the walk still ran from its key).
  - **Due intervals**: board `interval: '1m'` swept at t0; a tick at t0 + 30 s makes no search; at t0 + 60 s it is swept again. Board `interval: 'off'` → swept
    once on the first tick (the cold sweep, `polledAt` set), never on a later tick, and `armed` false once boot is answered. An `off` board whose cold sweep
    fails whole-board (transport) stays owed: `armed` true, swept again on the next tick, `polledAt` still `null`; a cold sweep has succeeded once the board's
    list was replaced, per-entry `failures` included. Two boards, `'1m'` and `'5m'` → after t0 + 60 s only the first is re-swept.
  - **Armed**: configured with one `'1m'` board → `armed` true after a tick; with only an `'off'` board and boot answered → false; with boot unanswered → true
    regardless of boards.
  - **429**: a search answering 429 with `retry-after: 30` → the board keeps its last good list and `polledAt`, `access: 'rate-limited'`, `detail` names the
    retry instant, `calls.last429At` set; a tick at +10 s makes no Jira call at all; at +30 s the sweep runs and `access` returns to `'ok'`. Without the header
    the window is `JIRA_RATE_LIMIT_DEFAULT_MS`.
  - **Unreadable config**: a `jira.json` of `{not json` → `status().configUnreadable: 'does not parse as JSON'`, `boards: []`, the boot calls still made, no
    search.
  - **`boardIssues`**: `'b_unknown'` → `null`; a known board before its sweep → `{ issues: [], polledAt: null }`; after → the cache. `boardsHolding('PAY-131')`
    → every board id whose cache holds the key, `[]` otherwise.
  - **`projects` in `status()`**: the union of project keys across every cache and the `repos` keys, sorted by key, names from a cached issue when there is one
    and the key itself otherwise (`{ key: 'OPS', name: 'OPS' }`); no outbound call.
  - **`issueDetail('PAY-131')`**: calls `issue/PAY-131` with `fields` = `JIRA_ISSUE_FIELDS` + sprint + `description`, then `search` `parent in ("PAY-131")`,
    then `transitions`; answers `ok` with the mapped issue (window OFF — a detail read never drops), `description` = `adfToMarkdown` of the raw description
    (`''` for `null` — Review Focus 5), `children` mapped (window off), `transitions: [{ id, name, to: { name, category } }]` from the fake, `boards` =
    `boardsHolding(key)` (`[]` for a key on no board — Review Focus 5), `session: null`. A 404 → `{ ok: false, response.status: 404 }`; a transport failure →
    status 0. Inside a 429 window → `{ ok: false, response.status: 429, retryAt }` with NO call made.
  - **`search`**: `'pay-131'` → one search with `jql: 'key = "PAY-131"'`, `maxResults: 20`; `'refund "x"'` → `jql: 'summary ~ "refund \"x\"*"'`; `'   '` → `ok`
    with `[]` and no call; the fake answering 400 → `{ ok: false, response.status: 400 }`; results mapped with the window off.
  - **`projects()`**: the fake holding 70 projects → two `project/search` calls (`startAt` 0 and 50), the union sorted by key. (Paged by `startAt`, not by
    following Jira's `nextPage` URL as P11 suggested — a deliberate deviation: the client never sends Basic auth to a URL Jira handed back.)
  - **`checkJql`**: `'assignee = currentUser()'` → `{ ok: true, value: { ok: true, count: 875 } }` (the fake's `counts`); `'sprnt = 1'` → `{ ok: true, value: {
    ok: false, message: "Field 'sprnt' does not exist or you do not have permission to view it." } }` after `parse` only (no count call); `'order by updated
    desc'` → parse passes, count answers 400 → `value: { ok: false, message: 'Unbounded JQL queries are not allowed here. Please add a search restriction to
    your query.' }` (P8).
  - **The token**: with `BM_JIRA_TOKEN=t0k3n-SECRET`, over the whole suite's call log the value and its base64 pairing with the email appear only in
    `authorization` header values; `JSON.stringify(status())` contains neither `t0k3n-SECRET` nor the email.

- [ ] **Step 2: Run; expect failure** (`pnpm run test:jest -- test/jira-poller.test.ts`).

- [ ] **Step 3: Implement.** The tracker poller's chain verbatim in shape (`arm` / `tick` / `sweep` / `clearTimer` with the same "timer OR in-flight means
      alive" comment, `unref` on the timer, `stopped` on shutdown). The sweep: read env (return if unconfigured), read config (record `unreadable`), run the
      boot calls that are owed and due (tenant_info first, then serverInfo, myself + the site probe, fields — stop at the first failure and record it), then per
      due board the queries then the roots with the walk, dedupe into the board's new list, cap, swap in the cache only when the sweep got that far, `polledAt`
      = the instant the board's last call answered; `calls.sweep` is what `takeCalls()` returns at the END of a sweep after a `takeCalls()` at its START
      discarded the route calls made between ticks; `polledAt`, `last429At` and every window are built from `Date.now()`, never `new Date()`, so the suite's
      mocked clock is the only clock. Header: the arming rule's three clauses (§3), why `off` still gets one cold sweep, why the window applies at map time, why
      a sweep failure keeps the last good list, why the 429 window refuses reads up front.

- [ ] **Step 4: Run; expect pass.** `pnpm run typecheck`.

- [ ] **Step 5: Commit** — `feat(jira): identity, the poller and the board caches`.

---

### Task 7: The ticket block

**Files:**
- Create: `server/src/jira/block.ts`
- Test: `test/jira-block.test.ts`

**Interfaces:**
- Consumes: `JiraIssueDetail`, `ADF_PLACEHOLDER_RE` (Task 4).
- Produces: `renderTicketBlock(detail: JiraIssueDetail): string`; `JIRA_BLOCK_CHILDREN_CAP = 30`; `shortDate(iso: string): string` (`YYYY-MM-DD` of the instant
  in UTC, whatever offset Jira's string carries and whatever `TZ` the process runs under — the suite runs under `TZ=America/New_York`).

- [ ] **Step 1: Write the failing tests** (a full `JiraIssueDetail` fixture; `toBe` against the exact multi-line string):
  - The full fixture renders, in this order and with these separators (` · `): line 1 `PAY-131 · Refund ledger entries`; line 2 `type: Story · status: In
    Progress (in progress) · priority: High`; line 3 `project: PAY · Payments · parent: PAY-120 Refund flows · sprint: Sprint 42`; line 4 `assignee: Ada
    Lovelace · reporter: Cho M. · labels: refunds, ledger`; line 5 `created: 2026-10-02 · updated: 2026-10-16 · resolved: —`; line 6 `url:
    https://acme.atlassian.net/browse/PAY-131`; a blank line; the description Markdown; a blank line; `Subtasks (2):`; `- PAY-132 Ledger migration · In Progress
    · Ada Lovelace`; `- PAY-133 Ledger writer · In Review · —`; a final newline. The category in parentheses is `to do`, `in progress` or `done`.
  - Every nullable fact absent (`priority`, `parent`, `sprint`, `assignee`, `reporter`, `resolved` null, `labels: []`) → `—` in its place (`labels: —`).
  - `description: ''` → the line `(no description)` where the Markdown would be (Review Focus 5).
  - `children: []` → no `Subtasks` section and no trailing blank line.
  - 31 children → the first 30 lines then `+1 more`; 30 → no `+N more`.
  - A description that contained a placeholder (the fixture's `description` holds `[table omitted]`) → the line `(something was omitted — open in Jira:
    https://acme.atlassian.net/browse/PAY-131)` after the description. The detector is `ADF_PLACEHOLDER_RE` from Task 4.

- [ ] **Step 2: Run; expect failure** (`pnpm run test:jest -- test/jira-block.test.ts`).

- [ ] **Step 3: Implement.** Pure. Header: one renderer, two readers now (`?format=text`, the modal does NOT use it) and two more later (`jira.mjs show`, the
      prompt), so phase 5's cap lives here already.

- [ ] **Step 4: Run; expect pass.** `pnpm run typecheck`.

- [ ] **Step 5: Commit** — `feat(jira): the ticket block`.

---

### Task 8: The module and the six read routes

**Files:**
- Create: `server/src/jira/jira.controller.ts`, `server/src/jira/jira.module.ts`
- Modify: `server/src/app.module.ts` (import `JiraModule` after `HubModule`)
- Test: `test/jira-routes.test.ts`

**Interfaces:**
- Consumes: `jiraEnv` (Task 1, the unconfigured check), `JiraPollerService` (Task 6), `JiraClient` (Task 3, provided by factory and exported, the tracker
  module's pattern), `jiraHttpError`, `renderTicketBlock`, `isJiraKey`, `JIRA_ID_RE` (Task 2), `JIRA_SEARCH_MAX_CHARS`.
- Produces: `JiraModule` (providers `JiraPollerService`, `{ provide: JiraClient, useFactory: () => new JiraClient() }`; exports both); the routes `GET
  /api/jira`, `GET /api/jira/boards/:id/issues`, `GET /api/jira/issue/:key` (+ `?format=text`), `GET /api/jira/search?q=`, `GET /api/jira/projects`, `GET
  /api/jira/jql/check?jql=`. Not produced: `/api/jira/prompt` (phase 5) and every POST (phase 2).

- [ ] **Step 1: Write the failing tests** — an app from `AppModule` with `.overrideProvider(JiraClient).useValue(new JiraClient(fake.fetch))`, `listenLoopback`,
      the three keys set in `beforeAll` BEFORE `app.init()` (one describe per configuration, configured and unconfigured — the poller's boot tick runs at init,
      so the keys must be there first; `BM_JIRA_TOKEN=t0k3n-SECRET`), `BM_JIRA_FILE` a temp file, `REGISTRY_FILE` overridden as `tracker-sync-route` does so no
      real registry is read; one `beforeAll` app per describe:
  - `GET /api/jira` unconfigured → 200 with `configured: false`, `access: 'unconfigured'`, `detail: 'BM_JIRA_SITE is not set'`, `boards: []`.
  - `GET /api/jira` configured, after `await poller.tick()` → 200, `configured: true`, `site`, `me`, `tokenKind`, the board statuses; the serialised body
    contains neither the token nor the email. With `failNext` failing `tenant_info` by transport → still 200, `access: 'unreachable'`, the error's message in
    `detail` (Review Focus 2).
  - A request with `Host: evil.example` on `GET /api/jira` → the allowlist's refusal (the status `test/allowed-hosts.test.ts` asserts today).
  - Every other route while unconfigured → 503 `{ error: 'Jira is not configured' }`.
  - `GET /api/jira/boards/b_0123abcd/issues` → 200 `{ issues, polledAt }`; `b_ffffffff` (well-formed, unknown) → 404 `{ error: 'unknown board' }`; `b_zz` → 404
    from the id check (`JIRA_ID_RE`'s `b` form, before any lookup).
  - `GET /api/jira/issue/pay-1` → 400 `{ error: 'invalid issue key' }`; `/issue/PAY-999` the fake does not hold → 404 `{ error: 'issue not found' }`;
    `/issue/PAY-131` → 200 with the `JiraIssueDetail` JSON, `content-type` JSON; `/issue/PAY-131?format=text` → 200 `text/plain; charset=utf-8`, the body equal
    to `renderTicketBlock` of the JSON answer; `?format=html` → 400 `{ error: 'format must be text' }`.
  - §8 through the detail route: the fake `unauthorized` → 503 `{ error: 'Jira rejected the credentials', access: 'unauthorized' }`; 403 → 502 `Jira refused:
    <message>`; `rateLimit: { retryAfter: 30 }` → 503 with `retryAt` and `error` starting `Jira rate limit — retry after`; a second request inside the window →
    the same 503, the same `retryAt`, and no new call in the fake's log; `failWith: 'transport'` → 502 `Jira unreachable: <message>`; `failWith: 500` → 502
    `Jira answered 500`.
  - `GET /api/jira/search` → 400 `{ error: 'q is required' }`; `?q=` and `?q=%20%20` → 200 `[]`; `?q=pay-131` → 200 one issue (the fake saw `key = "PAY-131"`);
    `?q=` of 101 characters → 400 `{ error: 'q is too long (max 100)' }`; the fake answering 400 → 409 `Jira refused: <message>`.
  - `GET /api/jira/projects` → 200 the sorted list; while the fake is unauthorized → 503.
  - `GET /api/jira/jql/check` → 400 `{ error: 'jql is required' }`; `?jql=assignee%20%3D%20currentUser()` → 200 `{ ok: true, count: 875 }`; a parse error → 200
    `{ ok: false, message }` (200, not 4xx: the sheet shows it inline); a `jql` over 2 000 characters → 400 `{ error: 'jql is too long (max 2000)' }`.
  - `POST /api/jira/boards` → 404 (no write route in this phase); `GET /api/jira/prompt` → 404.
  - In the configured describe, whose `beforeAll` also wrote a `'1m'` board before building the app: after `app.init()` and `await poller.tick()` (the boot tick
    is in flight right after init, and `armed` reads false mid-tick), `poller.armed` is true; in the unconfigured describe it is false.

- [ ] **Step 2: Run; expect failure** (`pnpm run test:jest -- test/jira-routes.test.ts`).

- [ ] **Step 3: Implement.** `@Controller('api/jira')`, one method per route, each validating its parameter first (400), then unconfigured (503), then the
      poller; `JiraResult` failures go through `jiraHttpError`. `?format=text` sets `content-type: text/plain; charset=utf-8` through `@Res({ passthrough: true
      })` or `@Header` — whichever the existing controllers use for plain text (check `items` body route). `JiraModule` header: why `JiraClient` is a factory
      value (one instance per process, overridable), why the module exports the poller (phases 3–5), why `AgentsModule` will import it and never the reverse.

- [ ] **Step 4: Run; expect pass.** `pnpm run typecheck`. Also run `pnpm run test:jest -- test/app.test.ts test/csp.test.ts test/vite-proxy.test.ts` — the
      suites that pin every route under `/api` and the untouched CSP.

- [ ] **Step 5: Commit** — `feat(jira): the module and the read routes under /api/jira`.

---

### Task 9: Environment, compose, docs and rules

**Files:**
- Modify: `.env.example` (after the `BM_GITHUB_TOKEN` block), `docker-compose.yml` (the `server` service's `environment`, after `BM_GITHUB_TOKEN`),
  `test/compose-env.test.ts`
- Create: `docs/subsystems/jira.md`, `.claude/rules/jira.md`
- Modify: `docs/overview.md`, `docs/subsystems/api.md`, `docs/subsystems/invariants.md`, `CLAUDE.md`, `.claude/rules/tracker.md`
- Test: `test/claude-rules.test.ts` (existing, must stay green), `test/compose-env.test.ts`, `test/dialog-count-docs.test.ts` (existing, untouched, must stay
  green)

**Interfaces:** none produced; this task is text.

- [ ] **Step 1: Write the failing test** — extend `test/compose-env.test.ts` with the three keys, mirroring its `BM_GITHUB_TOKEN` case exactly: each of
      `BM_JIRA_SITE`, `BM_JIRA_EMAIL`, `BM_JIRA_TOKEN` appears in the `server` service's environment as `'${BM_JIRA_<NAME>:-}'` and never as a literal value,
      asserted through `JIRA_ENV`'s three spellings as the GitHub case asserts through `GITHUB_TOKEN_ENV`.

- [ ] **Step 2: Run; expect failure** (`pnpm run test:jest -- test/compose-env.test.ts`).

- [ ] **Step 3: Environment and compose.** `.env.example`: a block for the three keys in the `BM_GITHUB_TOKEN` block's voice — hostname only, the scoped token's
      three scopes (`read:jira-work`, `write:jira-work`, `read:jira-user`) or a classic token, the token never leaves the process, an absent key is a supported
      state (the Jira section is simply not drawn). `docker-compose.yml`: three interpolations with defaults and a comment that restates bug-25's rule.

- [ ] **Step 4: Rules and headlines.** `.claude/rules/jira.md` with `paths: ["server/src/jira/**"]` — phase 4 adds `skills/jira/**` when that directory exists,
      because `test/claude-rules.test.ts` requires every glob to match a tracked file today — and four bullets, each bold headline byte-equal with its CLAUDE.md
      line and each ending `Why: [invariants.md](docs/subsystems/invariants.md#<anchor>)` (the repo-root form every link in `.claude/rules/*.md` uses):
  1. **`~/.backlog-manager/settings/jira.json` has exactly one writer, the server, and a file that cannot be read is never replaced.** — mechanism: the reader
     of Task 2 (per-entry fallback, `unreadable` → `configUnreadable`), and the sentence that the writers land in phase 2 on `writeSyncInterval`'s contract.
  2. **The Jira token never leaves the server: the browser goes through `/api/jira`, and the poller is armed only while a board syncs.** (phase 4 widens it to
     name `jira.mjs`, spec §12) — mechanism: `jiraEnv()` per call, the gateway, the one header, the payload's three fields, compose's interpolation, the arming
     rule's three clauses.
  3. **Jira's Done column is a window, not a store: a done issue whose resolution — or, lacking one, whose last update — is older than 14 days is dropped at map
     time.** — mechanism: `JIRA_DONE_WINDOW_DAYS` in `map-issue.ts`, applied before the cap, `now: null` for the detail and search reads.
  4. **Every value the server puts into JQL — a key or the search term — is quoted and escaped, and a person's JQL is passed verbatim for Jira to parse.** —
     mechanism: `jqlString`, `isJiraKey` before interpolation, the search route's trim/upper-case/escape, the query's `jql` sent as the file holds it.
  CLAUDE.md: the four headlines added to the Invariants list after the tracker-cache line, each as `- **<headline>** Why:
  [invariants.md](docs/subsystems/invariants.md#<anchor>)`; the layout line's `tracker/` entry followed by a `jira/` entry (`the Jira Cloud client, the board
  poller and its caches, the read routes under /api/jira`) and `those two are the outbound-calling modules, and the ONLY two` → `those three are the
  outbound-calling modules, and the ONLY three`; `nine path-scoped files` → `ten path-scoped files`. The cache-age widening, in all its homes at once:
  CLAUDE.md's headline and `.claude/rules/tracker.md`'s bullet become **The tracker and Jira caches are the two caches in this server whose age is a rendered
  value.**, `invariants.md`'s `##` heading is renamed to the same words (its anchor changes), and the two links to the old anchor (CLAUDE.md, `tracker.md`)
  follow — the 2026-09-22 spec's mention is a code span in a historical record and is left alone; the section's first paragraph gains one sentence saying the
  Jira board cache (`polledAt` per board in `GET /api/jira`) is the second; `invariants.md:2929`'s `this stays the one cache` becomes `these stay the two
  caches`; `docs/overview.md:73`'s `the one cache in this server whose age is rendered` becomes `one of the two caches`.

- [ ] **Step 5: Reasoning sections.** `docs/subsystems/invariants.md`: four new `##` sections, one per headline above, in the voice of the token section at line
      2795 (what the rule is, the failure it prevents, where the mechanism is), each 10–20 lines; and the sentence at line 3053 widened to `` `agents/`,
      `tracker/` and — since the Jira integration — `jira/` are the only outbound-calling modules``. The same widening lands in `docs/overview.md:68` (`one of
      the two modules that make an outbound call` → three), `:72` (`the other outbound-calling module` → `the second of three`), `docs/subsystems/api.md:3-7`
      (`It owns six things` → seven, the Jira boards named) and `api.md:138` (`The one module that calls anything outbound` → `one of the three modules that
      call outbound`).

- [ ] **Step 6: Subsystem docs.** `docs/subsystems/jira.md`, new, with no docs-sync stamp of its own (the stamp is a footer `/docs-sync` writes, and
      `docs/.docs-sync.yml` — "edit only via bootstrap" — is where a doc is registered; both are left to the next `/docs-sync`, which adopts an unstamped doc),
      covering: the scopes (§2), the module file by file (§3, phase 1 only, with a line per later phase saying what is not there yet), the shapes (§4), the six
      routes with their status codes (§5 and §8), the sweep's caps and the arming rule, `jira.json`'s reader, the probe facts the code encodes (P1–P14, one line
      each), and one sentence saying the widened cache-age rule's mechanism stays in `.claude/rules/tracker.md` (a session under `server/src/jira/**` reads it
      in this doc). `docs/overview.md`: a table row for `subsystems/jira.md` and one sentence under "The API". `docs/subsystems/api.md`: a `### \`jira/\``
      heading after `tracker/` (six lines: what it owns, that it is the third outbound module, where the full doc is), line 96's `and the only other one` → `and
      the second of three (`jira/` is the third)`, and an Interfaces row for `api.atlassian.com` beside `api.github.com`'s.

- [ ] **Step 7: Run** `pnpm run test:jest -- test/claude-rules.test.ts test/compose-env.test.ts test/dialog-count-docs.test.ts` and `pnpm run typecheck`; expect
      green. If `claude-rules` names an anchor, a count or a headline mismatch, fix the text — never the test.

- [ ] **Step 8: Commit** — `docs(jira): phase 1 rules, invariants, subsystem doc, env and compose passthrough`.

---

## Self-review (run by the author before handing the plan over)

- Spec coverage, phase 1 of §12: client (T3), config reader (T2), poller (T6), map (T5), ADF (T4), identity (T6), block (T7), the read routes and `GET
  /api/jira` (T8), `.env.example` and compose (T9), `docs/subsystems/jira.md` (T9), `.claude/rules/jira.md` with the four rules and the two widenings (T9). `GET
  /api/jira/prompt` is §5's seventh read and belongs to phase 5 (it needs `prompt.util.ts`); it is deliberately absent, and T8 pins the 404.
- Test cases named by §11 for these files: `jira-config` ✓ (T2), `jira-map-issue` ✓ (T5), `jira-adf` ✓ (T4), `jira-poller` ✓ (T6, including identity retry and
  back-off, `serverInfo` → `unsupported`, 429 back-off, failures with the last good list kept; the splice and newest-`updated`-wins wait for phase 3),
  `jira-routes` ✓ (T8: 503 unconfigured, Host gate, key validation, `?format=text` — §12 lists it under phase 4, pulled forward because the block and the detail
  route are here and it is one header — search trimming/escaping/409; the guard and transition-not-offered wait for phases 2–3), `test/helpers/jira.ts` ✓ (T3).
  Added beyond §11: `jira-env`, `jira-client`, `jira-block` — units the spec folds into the suites above.
- Names: `JiraClient`, `JiraResponse`, `JiraAuth`, `jqlString`, `accessOf`, `jiraHttpError`, `mapJiraIssue`, `MapContext`, `pickSprintField`,
  `JIRA_ISSUE_FIELDS`, `adfToMarkdown`, `renderTicketBlock`, `JiraPollerService`, `JiraResult`, `JiraBoardCache`, `readJiraConfig`, `JiraConfig`, `jiraEnv`,
  `isJiraKey`, `JIRA_ID_RE` — each produced once and consumed by that spelling.
- Review Focus: 1 → T1, 2 → T6 and T8, 3 → T6, 4 → T2, 5 → T6/T7/T8 — each has its case in the owning task.
- Decisions taken in review round 1, where the spec left room: error bodies use `{ error }` (the API's one key); `truncated` means the 500 board cap only; no
  board is searched until every boot call has answered; a transport failure or 5xx on a board search is whole-board, a 400/403/404 is per-entry; a parsed
  non-object `jira.json` reads as empty, not unreadable; `project/search` pages by `startAt`.
