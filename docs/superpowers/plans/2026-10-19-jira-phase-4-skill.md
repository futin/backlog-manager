# Jira integration — phase 4, the `jira` skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A seventh published skill, `skills/jira/`, whose CLI `jira.mjs` lets any Claude session read a Jira ticket and move it — `show`, `transitions`,
`transition`, `assign`, `status` — entirely through this machine's `/api/jira`, so the token stays in the server and the server stays Jira's one caller.

**Architecture:** One new node CLI with an async `main`, one `fetch` per request to `http://127.0.0.1:${BM_API_PORT || 4322}`, and the server's own sentences
passed through on stderr under four exit codes. It consumes routes that already exist — phase 1's `GET /api/jira`, `GET /api/jira/issue/:key` (JSON and
`?format=text`) and phase 3's `POST /api/jira/issue/assign` and `/issue/transition` — and adds none. Around it: a `SKILL.md`, the plugin description, the
exit-code source guard, the two widened rules and the docs.

**Tech Stack:** Node 22 ESM, `node --test` (the `test:skills` runner), no dependencies. Docs and rules are Markdown; the rules guard is jest
(`test/claude-rules.test.ts`).

**Spec:** [docs/superpowers/specs/2026-10-15-jira-integration-design.md](../specs/2026-10-15-jira-integration-design.md) — §9 the skill (the whole of it),
§10 "`jira.mjs` goes through the server", §11 the node suite, §12 phase 4, §13 the token headline's `jira.mjs` half, the `jira.md` `paths:` widening and the
exit-5 widening. §8's error table is what the server already answers; this phase only maps its statuses onto exit codes. The phase 3 plan
([2026-10-19-jira-phase-3-writes.md](2026-10-19-jira-phase-3-writes.md), PR futin/backlog-manager#307) is what the two write routes look like.

**Plan conventions (they override the writing-plans template where the two differ):**
- Every task states BEHAVIOUR and EXACT TEST CASES — inputs, expected values, edge cases — never literal code. The implementer writes the code and the test
  bodies, and is expected to disagree with a case here when the spec or the code says otherwise (and to say so in the commit). Reason: handed code gets
  transcribed verbatim, bugs included (the user's CLAUDE.md, "Learnings").
- Signatures in **Interfaces** are the one place a name is fixed; a later task that consumes a name spells it exactly as the producing task does.
- Size budgets are soft targets, never a reason to drop a rule or a comment. Comments explain WHY at the density `skills/backlog/tools/backlog.mjs` has around
  `apiRequest`; new prose wraps at 160.
- Branch `feat/jira-phase-4-skill`, cut in a worktree (never switch branches in the shared checkout) from `main` **after #307 has merged** — the user's ruling.
  Commit after every task with the message given; nothing is pushed by this plan. PR title (`ci / pr-title`): `feat(jira): the jira skill and jira.mjs`.
- Run only the suites a task touches — `node scripts/test-tmpdir.mjs skills/jira/tools/jira.test.mjs` (add `skills/backlog/tools/backlog.test.mjs` where named)
  and the named jest files; CI runs the whole suite.

## Global Constraints

- **Precondition, checked before Task 1:** `origin/main` contains phase 3 — `git grep -n "issue/assign" origin/main -- server/src/jira/jira-write.controller.ts`
  prints a line. If it does not, stop: #307 has not merged and this plan's two write commands have no route to call.
- **No server, client or `shared/` change.** Phase 4 adds no route and edits no existing one. If a test seems to need one, the plan is wrong — say so rather
  than add it.
- `skills/jira/` sits under the plugin root `skills/`; never a copy under `.claude/skills/`. `agents/` is untouched (§9).
- **No import from another skill's `tools/`** and none from the repo (`shared/`, `server/`): an installed skill's `tools/` is a standalone copy of the pushed
  HEAD with no path back. Every helper `jira.mjs` shares in spirit with `backlog.mjs` (`apiBase`, `apiRequest`, the key regex) is a COPY with a one-line
  comment naming its original — `skills.md`'s "a helper two of them need exists twice, on purpose".
- Every request goes to `http://127.0.0.1:${BM_API_PORT || 4322}` — the variable compose reads, `||` so an empty value is the default (backlog.mjs's
  `apiBase`). No other host appears in the file; no `BM_JIRA_*` variable is read; no `authorization` header is sent (§10).
- Every request carries `connection: close` and NO `Origin` header; a POST adds `content-type: application/json` (`SameOriginPostGuard` refuses a POST
  without it with a 403, which would read as exit `2` and mislead).
- Exit codes, verbatim from §9: success `0`; usage `1`; a 4xx the server answers `2`; a 5xx `3`; the stack down (no connection) `5`.
- The entry guard is `process.exitCode = await main(process.argv.slice(2))` — never `process.exit(` anywhere in the file (R1).
- Skill commands in `SKILL.md` spell the root `${CLAUDE_PLUGIN_ROOT}`, braces included (`test/skill-plugin-root.test.ts` refuses the bare form).

## Rulings this plan makes where the spec is silent

- **R1 — The entry is the awaited form.** §9 writes `process.exitCode = main(...)`; `main` is async here (every command awaits a `fetch`), so the guard is
  `process.exitCode = await main(...)` — the shape `backlog.mjs` and `api-call.mjs` already have, which the rule explicitly allows: it is `process.exit()`
  that truncates a pipe, and every `fetch` is awaited to completion with `connection: close`, so nothing holds the event loop open when `main` returns.
- **R2 — Status → exit, whole table.** No connection at all (any `fetch` throw) → `5`. 200–299 → success, unless the body a command needs is unreadable (a
  JSON route answering non-JSON) → `3` `the API answered <status> with a body jira.mjs cannot read`. 400–499 → `2`. 500–599, and any other status → `3`.
  The stderr line is the body's `error` string verbatim when there is one (the server composes every refusal, including the `retry after <instant>`), else
  `the API answered <status>`. `access` and `retryAt` on an error body are not printed separately — `error` already says them.
- **R3 — Keys are normalised, then checked, before any request.** The argument is trimmed and upper-cased, then must match `^[A-Z][A-Z0-9_]+-\d+$` (a copy of
  `JIRA_KEY_RE` in `shared/types.ts`). A miss is exit `1` with `not a Jira issue key: <raw> — expected a key like PAY-131` and sends nothing — a malformed key is
  the caller's typo, not a refusal the server made, and checking first also means no raw argument ever reaches a URL path. `pay-131 ` therefore works.
- **R4 — `transition` matches id, then transition name, then target status (the user's ruling).** The argument is every word after the key joined by one
  space, so `transition PAY-1 In Progress` needs no quotes; empty is usage (`1`). Against the issue's offered transitions, in three steps, stopping at the
  first that matches anything: (1) `id` equal to the argument exactly; (2) `name` equal case-insensitively after trimming; (3) `to.name` equal the same way.
  One match → that id is posted. More than one at the deciding step → exit `2` `"<arg>" is ambiguous for <KEY> — <candidates>`; none at all → exit `2`
  `"<arg>" is not offered for <KEY> — offered: <list>`; an issue offering nothing → exit `2` `<KEY> offers no transitions`. `<list>` and `<candidates>` are
  each transition as `name (→ to.name)`, comma-separated, in Jira's order. The resolution is the CLI's; the server re-checks the id against a fresh read
  (§8), and its `transition not offered` 400 — a workflow that changed between the two reads — is exit `2` like any 4xx.
- **R5 — `transitions` and `transition` read the detail route.** `GET /api/jira/issue/:key` costs the server three Jira calls (issue, children, transitions)
  where one would do; accepted, because a session moves a ticket a handful of times, and a transitions-only route is a server change this phase does not
  make (Global Constraints). A later phase that needs it adds it.
- **R6 — Output, exactly.** `show`: the `text/plain` body verbatim on stdout, plus one `\n` only when it does not already end in one. `transitions`: one line
  per transition, in Jira's order, `<id>\t<label>\t<category>`, where `<label>` is `name` when it equals `to.name` case-insensitively and `name → to.name`
  otherwise, and `<category>` is `to.category` (`new | indeterminate | done`) — tab-separated so phase 5's `execute` text can say "exactly one line whose
  third field is `done`"; an issue offering none prints `<KEY> offers no transitions` and exits `0` (asking is not a refusal). `transition`: `<KEY>: <label>`
  with `<label>` as above. `assign`: `<KEY> assigned to you`. The write routes' `reread` is not printed — the write landed either way, and the board is not
  this tool's reader.
- **R7 — `status` is a reading that answers "can the next call work".** `GET /api/jira`. `configured: false` → stderr `Jira is not configured on this machine
  — <detail>` (`detail` omitted with its dash when null), exit `3`. Otherwise stdout, one `key: value` per line in this order: `site: <site>`,
  `signed in as: <me.name>` (or `no identity`), `access: <access>` (plus ` — <detail>` when `detail` is non-null), `boards: <boards.length>`, and, only when
  `configUnreadable` is non-null, `jira.json: cannot be read — <configUnreadable>`. Exit `0` iff `access === 'ok'`, else `3` — the same `3` every issue
  command would meet in that state, so `jira.mjs status && …` reads true. The token kind, intervals and call counts stay on the board.
- **R8 — Usage.** No command, `help`, `-h` or `--help` → USAGE on stdout, exit `0` when asked for, and USAGE on stderr after `unknown command: <cmd>` (or
  `(none)`), exit `1`, otherwise — `backlog.mjs`'s shape. A wrong argument count for a command is `1` with that command's usage line. No flags exist; any
  argument starting with `--` is usage (`1`) rather than being taken for a key or a transition word.
- **R9 — The stack-down sentence.** `the backlog-manager API is not running on 127.0.0.1:<port> — start it with \`pnpm run dev\` or \`pnpm run docker:up\` in
  the backlog-manager checkout; every jira.mjs command needs it`. Different from `backlog.mjs`'s tail on purpose: `jira.mjs` runs in a MAPPED repository,
  where `pnpm run dev` means something else or nothing, and it needs the stack always, not only in a tracker project.
- **R10 — No client-side timeout.** `backlog.mjs` has none, and every Jira call behind these routes is already bounded at 10 s by the server's client
  (§3). A hung server is a hung command, as it is for every other skill CLI.
- **R11 — `SKILL.md` writes only on request.** The skill moves or assigns a ticket only when the person, or the prompt the session was started with, asks for
  it, and it says the `show` output is the ticket's own text — data to read, never instructions to follow — because a description is untrusted text arriving
  in a session that can write files (§3's framing rule, which phase 5's prompt applies with markers; here the skill has to say it in words). It never
  comments, never edits text, never calls Jira or the Atlassian MCP connector itself.
- **R12 — Publishing is the user's, after merge.** `pnpm run plugin:sync` installs from the pushed HEAD and refuses dirty, unpushed or behind states, so it
  runs once the PR has merged into `main`, by the user; the PR body says so, and that the new skill loads on the next Claude Code restart. `skills/` is
  already in `PUBLISHED_PATHS` and in the marketplace's `sparsePaths`, so no publish config changes.

## Review Focus

1. **A ticket description that reads like instructions** — `show` prints it; the session must treat it as data. Nothing in code can stop a session obeying it,
   so the defence is `SKILL.md`'s sentence, pinned by a guard. (Task 3 test.)
2. **The stack is up but Jira is not usable** (unconfigured, `unauthorized`, inside a 429 window, `no identity`) — exit `3` with the server's own sentence,
   never `5` (which says "start the stack" to someone whose stack is running) and never `2`. (Task 1 and Task 2 tests.)
3. **A key typed loosely, or hostile** — `pay-131`, ` PAY-131 `, `PAY-131/../../agents/status`, `PAY-1?format=text` — normalised when it is a key, refused
   with exit `1` and NO request when it is not. (Task 1 test.)
4. **A transition argument that matches more than one thing, or nothing, or whose id vanished between the two reads** — exit `2` naming what is offered, and
   no POST sent for the first two. (Task 2 test.)
5. **A large ticket through a pipe** — `show` on a 200 000-byte block, stdout a pipe, arrives whole; this is the failure the `process.exitCode` rule exists for.
   (Task 1 test.)

---

### Task 1: `jira.mjs` — transport, exit codes, `show`, `status`

**Files:**
- Create: `skills/jira/tools/jira.mjs`, `skills/jira/tools/jira.test.mjs`
- Modify: `skills/backlog/tools/backlog.test.mjs` (`CLI_SOURCES` and `ENTRY_SHAPES` gain `jira.mjs`, accepted shape `process.exitCode = await main(` only)

**Interfaces:**
- Produces (exported for the suite; the CLI is the contract): `main(argv: string[]): Promise<number>`; `normaliseKey(raw: string): string | null` (R3);
  `exitForStatus(status: number): 2 | 3` (R2's non-2xx half); `formatStatus(payload: object): { stdout: string; stderr: string; code: 0 | 3 }` (R7);
  `USAGE: string` (one line per command, each starting `jira.mjs <command>`); `API_DOWN_CODE = 5`.
- Private, consumed by Task 2: `apiRequest(method: 'GET' | 'POST', path: string, body?: object): Promise<{ status: number; body: unknown | null; text: string }>`
  — throws the exit-5 error on any `fetch` failure and on nothing else; `failure(res): JiraCliError` building R2's message and code; `class JiraCliError
  extends Error { code: number }`, caught once in `main`, which prints `message` on stderr and returns `code`.

The suite stands a fake API up in-process on `127.0.0.1:0` and runs the CLI with `spawn` (async — `spawnSync` would deadlock against a server in the same
process; `backlog.test.mjs`'s `runNode` comment), with `BM_API_PORT` set to the fake's port. Copy `backlog.test.mjs`'s `fakeApi` / `runNode` / `withApi`
shape (recorded requests with method, path, query, headers, body); do not import it.

- [ ] **Step 1: Failing tests.**
  - Unit: `normaliseKey` — `'PAY-131'` → `'PAY-131'`; `' pay-131 '` → `'PAY-131'`; `'AB_2-7'` → `'AB_2-7'`; `null` for `'PAY'`, `'131'`, `'1PAY-1'`,
    `'PAY-1x'`, `'PAY-131/../../agents/status'`, `'PAY-1?format=text'`, `''`. `exitForStatus` — 400, 404, 409 → `2`; 500, 502, 503 → `3`; 302 → `3`.
  - Unit: `formatStatus` — configured+ok payload (`site: 'acme.atlassian.net'`, `me: { name: 'Ada Lovelace' }`, `access: 'ok'`, `detail: null`, two boards,
    `configUnreadable: null`) → code `0`, stdout exactly the four lines of R7; `me: null` → `signed in as: no identity`; `access: 'unauthorized'`,
    `detail: 'Jira rejected the credentials'` → `access: unauthorized — Jira rejected the credentials`, code `3`; `configUnreadable: 'does not parse as JSON'`
    → a fifth line `jira.json: cannot be read — does not parse as JSON`, code unchanged by it; `configured: false, detail: 'BM_JIRA_TOKEN is not set'` →
    stdout empty, stderr `Jira is not configured on this machine — BM_JIRA_TOKEN is not set`, code `3`.
  - CLI `show pay-131` → one request, `GET /api/jira/issue/PAY-131` with query `{ format: 'text' }`, headers carrying `connection: close` and NO `origin`,
    `authorization` or `content-type`; stdout exactly the fake's text plus `\n`; a fake text already ending in `\n` gets none added; exit `0`.
  - CLI `show PAY-131/../../agents/status` → exit `1`, stderr names the raw argument and `PAY-131` as the example, the fake recorded ZERO requests (RF 3).
  - CLI `show PAY-9` with the fake answering 404 `{ error: 'issue not found' }` → exit `2`, stderr `issue not found`. 503 `{ error: 'Jira is not configured' }`
    → exit `3` with that sentence. 503 `{ error: 'Jira rate limit — retry after 2026-10-19T12:00:00.000Z', retryAt: … }` → exit `3`, stderr the `error`
    verbatim. 502 with a non-JSON body `<html>bad gateway</html>` → exit `3`, `the API answered 502` (RF 2).
  - CLI against a CLOSED port (listen on `127.0.0.1:0`, read the port, close, run) → exit `5`, stderr R9's sentence with that port in it.
  - CLI `status` → `GET /api/jira`; the R7 cases above end to end for `ok` (exit `0`) and `unauthorized` (exit `3`) and `configured: false` (exit `3`).
  - CLI usage: no args → exit `1`, stderr `unknown command: (none)` then USAGE; `--help` → exit `0`, USAGE on stdout; `show` with no key and `show PAY-1 PAY-2`
    → exit `1`; `show --json PAY-1` → exit `1` and zero requests (R8); `bogus` → exit `1`.
  - **RF 5:** the fake answers `show` with a 200 000-byte text; stdout read through the child's pipe has exactly 200 001 bytes (the text plus its `\n`).
  - Source guard over `jira.mjs`'s CODE lines (comments stripped, as `backlog.test.mjs`'s `codeLines` does — the header comment may well name Atlassian):
    no `process.exit(`; no `atlassian` (case-insensitive) and no `BM_JIRA_`; no `authorization`; the only `http://` literal is `http://127.0.0.1` (§10's half
    that a test can hold).
  - `backlog.test.mjs`: the existing "every skill CLI ends through process.exitCode" case now lists `jira.mjs` and passes only on the awaited shape.
- [ ] **Step 2: Run** `node scripts/test-tmpdir.mjs skills/jira/tools/jira.test.mjs skills/backlog/tools/backlog.test.mjs` — the new cases FAIL (no file).
- [ ] **Step 3: Implement** `jira.mjs`: a header comment saying what the tool is and is not (the server's one caller is the server — R5's and §10's reason;
  why there is no offline mode — the same as `backlog.mjs`'s, plus: there is no Jira credential on this side at all), `apiBase` / `apiRequest` copied from
  `backlog.mjs` with the copy named, R2's mapping in `failure`, R3 in `normaliseKey`, `show` via `apiRequest('GET', '/api/jira/issue/<KEY>?format=text')` and
  its `text`, `status` via `formatStatus`, and the entry guard of R1 with its own short note pointing at `retro.mjs`'s long-form copy (the convention every
  skill CLI follows).
- [ ] **Step 4: Run** the two suites — PASS.
- [ ] **Step 5: Commit** `feat(jira): jira.mjs show and status over /api/jira`

### Task 2: `jira.mjs` — `transitions`, `transition`, `assign`

**Files:**
- Modify: `skills/jira/tools/jira.mjs`, `skills/jira/tools/jira.test.mjs`

**Interfaces:**
- Consumes: Task 1's `apiRequest`, `failure`, `normaliseKey`, `JiraCliError`.
- Produces (exported): `resolveTransition(transitions: Transition[], arg: string, key: string): { ok: true; transition: Transition } | { ok: false; code: 2;
  message: string }` (R4; `Transition` is `JiraIssueDetail.transitions`' element, `{ id, name, to: { name, category } }`; `key` is only for the message);
  `formatTransitions(key: string, transitions: Transition[]): string` (R6).
- Wire: `GET /api/jira/issue/<KEY>` (JSON, `transitions` read from it); `POST /api/jira/issue/transition` body `{ key, transitionId }`; `POST
  /api/jira/issue/assign` body `{ key }`. Both POSTs answer `200 { ok: true, reread: boolean }` (phase 3's R1).

Fixture transitions for the cases below, in this order: `{ id: '11', name: 'Start', to: { name: 'In Progress', category: 'indeterminate' } }`,
`{ id: '21', name: 'Done', to: { name: 'Done', category: 'done' } }`, `{ id: '31', name: 'Review', to: { name: 'In Progress', category: 'indeterminate' } }`.

- [ ] **Step 1: Failing tests.**
  - Unit `resolveTransition`: `'21'` → id 21 (step 1); `'start'` → id 11 (step 2, case); `'  Done '` → id 21; `'In Progress'` → not ok, code 2, message
    `"In Progress" is ambiguous for PAY-1 — Start (→ In Progress), Review (→ In Progress)` (step 3 matched two); with only the first two fixtures,
    `'in progress'` → id 11 (step 3, single); `'11'` when a transition is NAMED `'11'` and another has id `'11'` → the id wins (step 1 stops the search);
    `'Close'` → `"Close" is not offered for PAY-1 — offered: Start (→ In Progress), Done (→ Done), Review (→ In Progress)`; `[]` with any arg →
    `PAY-1 offers no transitions`.
  - Unit `formatTransitions`: the three fixtures → `11\tStart → In Progress\tindeterminate`, `21\tDone\tdone`, `31\tReview → In Progress\tindeterminate`,
    `\n`-joined; `[]` → `PAY-1 offers no transitions`.
  - CLI `transitions pay-1` → one `GET /api/jira/issue/PAY-1` with NO `format` query; stdout the three lines; exit `0`. With the fake's `transitions: []` →
    stdout `PAY-1 offers no transitions`, exit `0`.
  - CLI `transition PAY-1 In Progress` (two argv words) with only the first two fixtures → requests in order: the GET, then `POST /api/jira/issue/transition`
    with `content-type: application/json`, no `origin`, body exactly `{ "key": "PAY-1", "transitionId": "11" }`; stdout `PAY-1: Start → In Progress`; exit `0`.
  - CLI `transition PAY-1 In Progress` with all three fixtures → exit `2`, the ambiguity message, and NO POST recorded (RF 4). `transition PAY-1 Close` → exit
    `2`, no POST. `transition PAY-1` → exit `1`, zero requests.
  - CLI `transition PAY-1 Done` where the fake's POST answers 400 `{ error: 'transition not offered' }` (the workflow moved between reads) → exit `2`, stderr
    `transition not offered` (RF 4).
  - CLI `transition PAY-1 Done` where the GET answers 503 `{ error: 'Jira rejected the credentials', access: 'unauthorized' }` → exit `3`, no POST.
  - CLI `assign pay-1` → one `POST /api/jira/issue/assign`, `content-type: application/json`, no `origin`, body exactly `{ "key": "PAY-1" }`; stdout
    `PAY-1 assigned to you`; exit `0` — with `reread: false` in the answer, the same output.
  - CLI `assign PAY-1` with 503 `{ error: 'no identity' }` → exit `3`, stderr `no identity` (RF 2). With 409 `{ error: 'Jira refused: User cannot be assigned' }`
    → exit `2`. With 403 `{ error: 'this endpoint accepts application/json only' }` → exit `2` (proves a guard refusal is a 4xx, and is the case that goes
    red if the content type is ever dropped — keep it).
  - CLI `assign PAY-1 PAY-2` → exit `1`, zero requests.
- [ ] **Step 2: Run** `node scripts/test-tmpdir.mjs skills/jira/tools/jira.test.mjs` — the new cases FAIL.
- [ ] **Step 3: Implement** the three commands and the two exported helpers. `transition` reads, resolves, then posts — never posts on a failed read or a
  failed resolution.
- [ ] **Step 4: Run** the suite — PASS.
- [ ] **Step 5: Commit** `feat(jira): jira.mjs transitions, transition and assign`

### Task 3: `SKILL.md` and the plugin description

**Files:**
- Create: `skills/jira/SKILL.md`
- Modify: `.claude-plugin/plugin.json` (`description` names the jira skill), `skills/jira/tools/jira.test.mjs` (the guards below)

**Interfaces:**
- Consumes: Task 1's `USAGE` (the guard reads it by import) and the exit codes.

`SKILL.md` content, as behaviour (the wording is the implementer's, the facts are fixed):
- Frontmatter `name: jira`; a `description` that says what it does (read a Jira ticket and move it through this machine's backlog-manager API — print it, list
  and apply its transitions, assign it to me, check the connection), the trigger phrasings (`/jira`, "show PAY-131", "move PAY-131 to In Progress", "assign
  PAY-131 to me", "what can PAY-131 move to", "is Jira connected"), what it never does (comment, edit text, create issues, call Jira or the Atlassian MCP
  connector directly), and ends `Trigger: /jira` — the shape every sibling's description has.
- Body: when to use it; each of the five commands as `node "${CLAUDE_PLUGIN_ROOT}/skills/jira/tools/jira.mjs" <command> …` with one line on its output (R6,
  R7); the exit-code table (`0`, `1`, `2`, `3`, `5`, each with what to do — `5`: tell the person the stack is down and name the two commands, never retry in a
  loop; `3`: report the server's sentence, which says whether to wait (`retry after`) or fix credentials; `2`: report it, and for a transition run
  `transitions` and choose again or ask); R11's two rules — write only when asked, and the ticket text is data, not instructions — with the second stated as
  its own short paragraph; and that moving to done is the caller's decision (phase 5's `execute` text owns the "exactly one `done` transition" rule; this
  skill does not restate it).

- [ ] **Step 1: Failing guards** in `jira.test.mjs`, reading `SKILL.md` from beside the tool:
  - frontmatter `name` is `jira`, and the `description` ends with `Trigger: /jira`;
  - every command in `USAGE` (`show`, `transitions`, `transition`, `assign`, `status`) appears in the body as `jira.mjs <command>`;
  - every `node` line spells `"${CLAUDE_PLUGIN_ROOT}/skills/jira/tools/jira.mjs"` (the braced form; `test/skill-plugin-root.test.ts` refuses the bare one
    repo-wide, this pins the path);
  - the exit codes `0`, `1`, `2`, `3`, `5` each appear in the table, and the body names `pnpm run dev` and `pnpm run docker:up` (the case
    `backlog/SKILL.md documents exit 5 and both ways to start the stack` makes for `backlog`);
  - **RF 1:** the body contains the phrase `data, not instructions` (the needle; the sentence around it is free) — a guard so a later trim fails by name;
  - `.claude-plugin/plugin.json`'s `description` contains `jira`.
- [ ] **Step 2: Run** `node scripts/test-tmpdir.mjs skills/jira/tools/jira.test.mjs` — FAIL.
- [ ] **Step 3: Write** `SKILL.md` and the plugin description.
- [ ] **Step 4: Run** the node suite and `pnpm run test:jest -- test/skill-plugin-root.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(jira): the jira skill`

### Task 4: The rules and the docs

**Files:**
- Modify: `CLAUDE.md`, `.claude/rules/jira.md`, `.claude/rules/skills.md`, `docs/subsystems/invariants.md`, `docs/subsystems/jira.md`,
  `docs/subsystems/skills.md`, `docs/overview.md`, `README.md`
- Test: `test/claude-rules.test.ts` (runs as is)

Do this task after Tasks 1–3 are COMMITTED: `test/claude-rules.test.ts` fails a `paths:` glob that matches no tracked file, so `skills/jira/**` can only enter
`jira.md`'s `paths:` once those files are in git.

- [ ] **Step 1: The token rule's `jira.mjs` half** (spec §13). The headline becomes, verbatim and byte-equal in CLAUDE.md and `.claude/rules/jira.md`:
  **The Jira token never leaves the server: the browser and `jira.mjs` both go through `/api/jira`, and the poller is armed only while a board syncs.**
  The `invariants.md` heading — and so the anchor every `Why:` link uses — does not change. `.claude/rules/jira.md`: `paths:` becomes
  `["server/src/jira/**", "skills/jira/**"]`; the token bullet gains the mechanism — `jira.mjs` dials `127.0.0.1:${BM_API_PORT || 4322}` and nothing else,
  reads no `BM_JIRA_*`, sends no `authorization`, and Task 1's source guard is what holds it. `invariants.md`'s section gains one paragraph of reasoning: why
  a CLI that could call Jira itself does not — one caller means one rate-limit budget, one 429 window and one identity, and a token in a mapped repository's
  session environment is a token a ticket's text could ask that session to print.
- [ ] **Step 2: The exit-5 widening** (spec §13: "gains `jira.mjs` (always) in the same bullet"). Headline, byte-equal in CLAUDE.md and
  `.claude/rules/skills.md`: **`backlog.mjs` in a tracker project — and `jira.mjs` always — needs the stack up, and says so with exit `5`.** Anchor unchanged.
  The rules bullet gains: `jira.mjs` has no files mode at all, every command is an API call, its stack-down sentence is R9's, and its other codes are `2`
  (4xx) and `3` (5xx). `invariants.md`'s section gains the reason it is "always": a Jira ticket has no local store to fall back to, and the token exists
  only in the server.
- [ ] **Step 3: CLAUDE.md's other lines.** The opening line's skill count and list name `jira` (seven skills: the six backlog skills and `jira`, which reads and
  moves a Jira ticket through `/api/jira`); the `skills/…` layout bullet names `skills/jira/` and `jira.mjs` beside the other CLIs. Keep every unlinked bullet
  under `UNLINKED_WORD_CAP`.
- [ ] **Step 4: The subsystem docs.** `docs/subsystems/skills.md`: seven skills (the table gains a `jira` row), the CLI list gains `jira.mjs` (API-only,
  never a writer of any file, the exit codes), and the exit-code paragraphs name it beside `backlog.mjs` and `api-call.mjs` as the third awaited entry.
  `docs/subsystems/jira.md`: the opening paragraph says phases 1–4; the "Not there yet, by phase" line drops 4; a short `## The skill (phase 4)` section —
  the five commands, the routes each calls, R4's matching, R7's exit rule, and that nothing in the server changed for it. `docs/overview.md` and
  `README.md`: every "six skills" / "three CLIs" that counts the published skills or their CLIs follows (grep `six\|three CLIs` in both; the spots found at
  plan time are `README.md:3,271,302` and `docs/overview.md:3,22,100`).
- [ ] **Step 5: Run** `pnpm run test:jest -- test/claude-rules.test.ts` — PASS (it compares the two widened headlines across CLAUDE.md and the rule files,
  and checks the new `paths:` glob matches a tracked file).
- [ ] **Step 6: Commit** `docs(jira): the jira skill in the rules and docs`

## After the plan

The PR (title above) body lists, for the user to do after it merges into `main`: `pnpm run plugin:sync` from the main checkout, then restart Claude Code so
`/jira` loads (R12). Phase 5 is next: its `execute` built-in tells the session to call `jira.mjs transitions` and `jira.mjs transition`, which is why R6 fixes
the output format here.

## Self-review notes

- Spec coverage: §9 commands, routing and exit codes → Tasks 1–2; §9 `process.exitCode`, `jira.test.mjs` beside the tool, `plugin.json` → Tasks 1 and 3;
  §9 publish → R12; §10 `jira.mjs` through the server → Global Constraints + Task 1's source guard; §11 node suite → Tasks 1–2; §12 phase 4's docs, `paths:`,
  exit-5 widening and token half → Task 4. Out of this phase: the `execute`/`context` built-in texts and `prompt.util.ts` (phase 5 — §9 describes them, but
  they are server prompt text, composed by phase 5's code), the Skills card and `jira.json` `skills` writers (phase 5).
- Not covered by a test, by choice: a hung server (R10 — no timeout, as every skill CLI); the `SKILL.md` prose beyond its guarded needles — its quality is
  the reviewer's to judge.
