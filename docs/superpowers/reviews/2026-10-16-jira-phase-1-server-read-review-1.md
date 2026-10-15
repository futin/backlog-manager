# Review 1 — Jira phase 1, server read (plan)

**Plan:** `docs/superpowers/plans/2026-10-16-jira-phase-1-server-read.md`
**Spec:** `docs/superpowers/specs/2026-10-15-jira-integration-design.md` (§12 phase 1)
**Date:** 2026-10-16 · **Verdict: REVISE** — one Critical (CI goes red on the rule file the plan prescribes) and fourteen Important findings, several of them
test cases that cannot pass as written. Most fixes are local edits to the plan text, but four need a decision first: the error-body shape, `truncated`, the
unreachable-boot sweep, and per-entry versus whole-sweep failures. A second look after the edits is cheap and worth it.

Every claim about the code below was checked against the tree at `docs/jira-integration-spec` (f06c798). The CodeGraph MCP server was not used. Plain
`grep`/`sed` reads were enough for the narrow lookups this needed.

---

## Critical

**C1 — plan:606 — `.claude/rules/jira.md`'s `paths:` includes `skills/jira/**`, and nothing under `skills/jira/` exists in phase 1.**
`test/claude-rules.test.ts:310-321` ("every paths: glob matches at least one tracked file today") goes through every glob of every rule file against `git
ls-files` plus untracked files (`trackedFiles`, :200-209). `skills/` holds only the six backlog skills today, and `skills/jira` is phase 4 (spec §12 item 4).
Task 9 Step 7 then says "fix the text — never the test", while Step 4 fixes the glob, so the implementer cannot obey both. CI's full suite goes red on
the PR. The spec's §13 table carries the same two-glob value. The plan copies it without phasing it, even though §12 itself puts the `jira.mjs` half in phase 4.
→ Phase 1 ships `paths: ["server/src/jira/**"]`. Phase 4 adds `skills/jira/**` along with the directory. State the deferral in Task 9 and in the self-review.

---

## Important

**I1 — plan:27 — the branch is cut "off `main`", but neither the spec nor this plan is on `main`.**
`git cat-file -e main:docs/superpowers/specs/2026-10-15-jira-integration-design.md` fails, and so does `origin/main`. Both documents live only on
`docs/jira-integration-spec`, 5 commits ahead. Every new file's header is told to "cite the spec section it implements", and `docs/subsystems/jira.md` and the
four invariants sections will link it. A subagent working in a worktree off `main` also cannot open the plan it is executing.
→ State the prerequisite: merge `docs/jira-integration-spec` into `main` first, or cut the branch from it. Make Task 1 Step 0 check that the spec path exists.

**I2 — plan:51-56, 237-238 (and every route test in Task 8) — the error body is `{ message, access, retryAt? }`. The API's failure body is `{ error }`
everywhere else.**
`grep` finds 114 `HttpException({ error … })` sites in `server/src` and none of the form `{ message … }` (e.g. `server/src/agents/origin.guard.ts:77`,
`server/src/agents/items-abort.service.ts:72`). The client's one shared unwrapper reads `data.error` (`client/src/lib/agents.ts:70-83`, "Unwraps the `{ error
}` body the API answers failures with"), and `useTrackers.ts:193` does the same. A `{ message }` body reaches phase 2's client as `request failed (503)`
through that helper, unless phase 2 adds a second unwrapper. The spec does not prescribe a key, so this is a convention break the spec does not ask for.
→ Use `{ error, access?, retryAt? }` (the route tests become `{ error: 'q is required' }`, and so on), or say why Jira is the exception and where the
client reads it.

**I3 — plan:274 vs 392 — Task 3's `jiraHttpError` test needs the 60 s default ("now + 60 s when `retryAfter` is null"), but `JIRA_RATE_LIMIT_DEFAULT_MS` is
produced by Task 6 (`poller.service.ts`).**
`errors.util.ts` must either import from a later task's service file (a forward dependency, with a mapper importing an injectable) or hard-code a second
`60_000`, which breaks the Global Constraints' "Constants, one home each" (plan:47).
→ Home `JIRA_RATE_LIMIT_DEFAULT_MS` in `errors.util.ts` (or `jira.client.ts`) in Task 3, and move it from Task 6's Produces to its Consumes.

**I4 — plan:269 with 281 — the timeout test cannot pass with the mechanism Step 3 prescribes.**
Step 3 says `AbortSignal.timeout(JIRA_TIMEOUT_MS)` on every call. The test is "a `fetch` that never resolves → `status: 0` with a message containing `timed
out` within `JIRA_TIMEOUT_MS` (fake timers)". This was measured in a scratch jest run on this machine (Node 22.23.1). Under `jest.useFakeTimers()`,
`AbortSignal.timeout(10_000)` is still not aborted after `advanceTimersByTime(20_000)`, because Node schedules it on internal timers that jest does not patch.
Its reason, once it does fire, reads `The operation was aborted due to timeout` (`TimeoutError`), with no `timed out` in it. Also, a fake `fetch` that
"never resolves" and ignores `init.signal` never rejects at all.
→ Either have the client own the deadline (a `setTimeout` race plus `AbortController.abort()`, which fake timers do control, with its own `timed out after 10 s`
message), or make the fake honour `init.signal`, inject a short timeout, run on real timers, and match the client's own message. Say which one.

**I5 — plan:236-238 — `accessOf` maps every status outside 200–299/401/403/429 to `unreachable`, and `jiraHttpError`'s body carries `access` on every row.**
That makes a 404 read `{ message: 'issue not found', access: 'unreachable' }`, and a search 400 (the 409 row) read `access: 'unreachable'`. Neither is the site
being unreachable. The plan also never says whether a ROUTE call's failure updates the site-level `access`/`detail` in `status()`. If it does, opening one
deleted issue turns the chip red. The only route-side state changes the plan pins are the 429 window and, through spec §3, the 401 reset. The Task 8
assertions (`404 { message: 'issue not found' }`, exact) and the Task 3 assertion ("`{ message, access }` exactly") disagree on whether `access` is present.
→ Say which statuses carry `access` in the body (401, 403, 429, 0 and 5xx), have 400 and 404 carry none, and state that only 401, 429 and 0 from a route move
the site-level state. Add one case: a 404 detail read leaves `status().access` at `ok`.

**I6 — plan:240-250 vs 416-421, 433-435, 439 — `FakeJira` as specified cannot express several Task 6 cases.**
Its failure switches are all global (`unauthorized`, `failWith`, `rateLimit`), and it always mints a `nextPageToken`. That leaves these cases with no way to
be written:
- "A root search answering 400": `key = "K"` is always answered from the map, as 0 or 1 issues.
- "A root whose walk hits 403 … the rest of the board proceeds": with `failWith: 403` every search fails, so nothing "proceeds".
- "`serverInfo` … a 404", "`myself` 403", "`field` 500": `failWith` hits `tenant_info` first, so the boot stops at the wrong call.
- "`myself` 401": `unauthorized` also 401s `serverInfo`, which runs before `myself`.
- Review Focus 3, "a page with `isLast: false` and no `nextPageToken`": the fake always mints one.

`test/helpers/github.ts` solves this with a one-shot answer that pre-empts the router (the "One answer that pre-empts the router" member, :95-100).
→ Add a per-request failure hook to the `FakeJira` interface (match on method plus URL or endpoint, plus JQL; one-shot or standing), and a switch that drops
`nextPageToken` on a chosen page.

**I7 — plan:472 (and 546) — "`status()` serialised never contains `tok`" fails against a correct implementation: the payload's own key `tokenKind` contains
`tok`.** The fake token from Task 3 (plan:252) is `'tok'`. The same weakness makes "`tok` appears only in `authorization` headers" (plan:271, 472) pass
without testing anything: Basic auth puts `base64(email:tok)` in that header, so `tok` never appears in clear anywhere.
→ Use a distinctive token value (e.g. `fake-jira-token-9f3c`), and search the log and the payload for the raw value, its base64 form and `email:token`.

**I8 — plan:438-439 — a single query capped at 200 sets `truncated: true` on a board holding 200 issues, but spec §3 ties `truncated` to the 500 board cap
(spec:83-84).** The Band then reads `first 500 shown` when truncated (spec:214–215), which is wrong on a 200-issue board. The root-cap case (plan:439-440)
leaves `truncated` unstated, so the two caps are also inconsistent with each other.
→ Either `truncated` means the 500 cap only (the 250-issue query case expects `truncated: false`), or the spec's Band copy changes. Pick one, and pin the
root-cap case either way.

**I9 — plan:416, 479 — the plan sends no search while any boot call is unanswered. Spec §3 identity says "under `unreachable` the sweep keeps trying on the same
ticker" (spec:98-99), in contrast to `unauthorized`, where "the sweep itself does not run".**
The plan's `field` 500 → `unreachable` with no search sent, and its "stop at the first failure" boot chain, follow neither half of that sentence for a
`myself`/`field` network failure once `cloudId` is known. With no `cloudId` (`tenant_info` down), not sweeping is forced and fine. This is a spec contradiction
in a corner. It is rated Important rather than Critical because the spec's §3 poller paragraph is compatible with both readings.
→ State the rule. Either boards sweep under `unreachable` once `cloudId` is held (sprint `null` until `field` answers), with a test, or the spec sentence
is amended in the same PR.

**I10 — plan:433-435, 480 — the plan never says which failures are per-entry (a `failures` row, the rest proceeds) and which abort the board (last good list
kept).** It pins 400 and 403 as per-entry and 401 and 429 as board-level. Status `0` (transport or timeout) and 5xx on a board search are unassigned, and
untested. Spec §3 lists "the site unreachable" with 401 and 429 as the failures that leave the last good list in place (spec:86-87). An implementer who files
a mid-sweep transport failure as a root failure swaps in a partial list.
→ Add the classification to Task 6 Step 3 (0 and 5xx → whole board, last good list and `polledAt` kept, site `access`/`detail` set) and a case for each.

**I11 — plan:445-449 — no case for spec §3's "a boot sweep that failed is owed again on the next tick until one succeeds" (spec:80).**
The `off` case covers only a successful cold sweep. Missing: an `off` board whose cold sweep fails (transport or 429) stays owed, `armed` stays true, the next
tick retries it, and after the first success it is never swept again. This is one of the three arming clauses, and §11 asks for "armed/idle/off".
→ Add the case. Define "succeeded": the board's list was swapped in, so per-entry failures still count as a success.

**I12 — plan:443-444 — the Done-window walk case covers a dropped CHILD only. Spec §3's "a root it drops still has its descendants walked" (spec:94) has no
case, and it is the one with a trap.** A done root resolved 15 days ago maps to nothing. An implementer who detects "Jira knows no issue K" from the MAPPED
result, not the raw one, records a false `failures` entry for it (the plan's own message, plan:433-434) and may skip its walk.
→ Add the case: root done, now − 15 d → absent from the cache, no `failures` entry, its children present.

**I13 — plan:541-543 with 567 — "`poller.armed` true after `app.init()` with a `'1m'` board" cannot pass in the setup the same task prescribes.**
The keys are set in `beforeEach` while the app is built in `beforeAll`, which runs first, so at `init` the poller sees `env.ts`'s blanks and stays idle.
Even with the keys set first, `armed` is derived from the timer (`server/src/tracker/poller.service.ts:281-283`). A sweep clears that timer on entry
(:606-609) and schedules the next one only at the end. Right after `init()` the boot tick is in flight and `armed` reads `false`.
→ For that describe, set the keys and write `BM_JIRA_FILE` in `beforeAll` before `createNestApplication`, then `await poller.tick()` (which returns the
in-flight promise) before asserting `armed`.

**I14 — plan:613 — rule 2's headline ships the `jira.mjs` half that spec §12 says waits for phase 4 (spec:361-362, "the token (its `jira.mjs` half waits for
phase 4)"; spec:369).** Phase 1's CLAUDE.md and `jira.md` would assert that `jira.mjs` goes through `/api/jira` three phases before `jira.mjs` exists. Phase 4's
"the token rule's `jira.mjs` half" would then have nothing left to add. This contradicts the spec's phasing in docs only, hence Important.
→ Phase 1 headline: "The Jira token never leaves the server: the browser goes through `/api/jira`, and the poller is armed only while a board syncs." Phase
4 widens it to §13's wording. Note this in the self-review.

---

## Minor

- **M1 — plan:587, 598** — "the `api` service" does not exist. The compose service is `server` (`docker-compose.yml:37`). `assignments()` scans the whole file
  (`test/compose-env.test.ts:30-38`), so the test is unaffected, but the instruction is wrong. Mirroring the `BM_GITHUB_TOKEN` case "exactly" also means a
  third case asserting through `JIRA_ENV`, as the GitHub case uses `GITHUB_TOKEN_ENV` (:104-109). Say so.
- **M2 — plan:607-609** — "the relative form the other rule files use" is given as `../../docs/subsystems/invariants.md#…`. All 73 links in `.claude/rules/*.md`
  use the repo-root form `docs/subsystems/invariants.md#…`, e.g. `.claude/rules/tracker.md:82`. The test regex accepts both, but the stated fact is wrong.
- **M3 — plan:632** — "the provenance header `api.md` carries (copy its first lines' form)": the docs-sync stamp is a FOOTER (`docs/subsystems/api.md:240-245`),
  and api.md's `sources: server/src` already covers `server/src/jira/`. `docs/.docs-sync.yml` is the layout contract ("Edit only via bootstrap") and lists no
  `jira.md`. Say how the new doc enters it, or leave the stamp off and let `/docs-sync` adopt it.
- **M4 — plan:623-626, 635-637** — the cache-age widening is said to happen "in all its homes at once", but `docs/overview.md:73` ("the one cache in this
  server whose age is rendered") and `docs/subsystems/invariants.md:2929` ("this stays the one cache") are not listed. The outbound edits also leave
  `docs/overview.md:68` ("one of the two modules that make an outbound call"), `:72` ("the other outbound-calling module"), `docs/subsystems/api.md:3-7` ("It
  owns six things") and `api.md:138` ("The one module that calls anything outbound", already stale) unchanged.
- **M5 — plan:7** — the Goal says "the seven read routes of the spec's §5". The plan delivers six (`/prompt` is phase 5, plan:539, 650).
- **M6 — plan:263, 467** — `projects` pages by `startAt`, while spec P11 (spec:419) says the route "follows `nextPage` until `isLast`". `startAt` is arguably
  better: it never sends Basic auth to a URL Jira handed back. But it is an unacknowledged deviation, so record it.
- **M7 — plan:537, 552-554** — `?format=text` is phase 4 in spec §12 (spec:369). §5 and §11 list it, so building it now is defensible. The self-review
  should say it was pulled forward.
- **M8 — plan:245 vs 429** — the fake parses `parent in ("A","B")` with no space, while Task 6 expects `parent in ("PAY-131", "PAY-134")` with one. Pick one
  spelling, or make the fake's parser whitespace-tolerant and say so.
- **M9 — plan:198-199 with 611-612** — `[1, 2]` → `unreadable: 'is not an object'`. Spec §2 defines unreadable as "cannot be read or parsed". Rule 1 also says
  phase 2's writers follow `writeSyncInterval`'s contract, which REPLACES a parsed non-object (`server/src/tracker/sync-config.util.ts:86-87`). So phase 1 would
  report as unreadable a file that phase 2 would overwrite. Decide now and record it.
- **M10 — plan:456, 549** — `b_unknown` fails `JIRA_ID_RE` (not 8 hex), so neither case exercises a well-formed unknown board. Use `b_ffffffff`. The `../x`
  case is a 404 from the router (extra path segment), not from the id check.
- **M11 — plan:297, 512** — `adfToMarkdown`'s `placeholders` count has no consumer, because `JiraIssueDetail.description` is a string. Task 7 re-detects the
  placeholders from literals. Export the placeholder strings or regex from `adf.ts` as one home, and Task 7 consumes them.
- **M12 — plan:228, 408** — `calls.sweep` is "every call the last tick made" (spec:140). Route calls between ticks go through the same `JiraClient` counter, and
  the plan does not say whether `takeCalls()` discards them at sweep start.
- **M13 — plan:404** — tests mock `Date.now` with `jest.spyOn`, so `polledAt`, `last429At` and the windows must be built from `Date.now()`, never `new Date()`.
  Say so in Step 3.
- **M14 — plan:52-53, 180-182, 190, 205-206, 240-241, 259-261, 278-279, 361-362, 395-396, 402-403, 411-420, 430-431, 450-451, 476-477, 535-536, 552-553,
  559-560, 563-564, 576-577, 607-608, 610-611, 619-620** — reflow artifacts: one- or two-word orphan lines left by a re-wrap. No prose line exceeds 160
  characters (counted as characters, not bytes).
- **M15 — plan:238-239** — "`JiraRetryAtError`? — no: …" reads as a draft note inside Interfaces. Replace it with the decision.
- **M16 — plan:71-72** — Review Focus 2's "`GET /api/jira` must still answer 200" has no route case. Task 8 tests `GET /api/jira` only against a healthy fake.
- **M17 — plan:591, 625** — editing `docs/superpowers/specs/2026-09-22-claude-md-three-tiers-design.md:117` rewrites a record of a moment (the reason
  `docs/.docs-sync.yml` excludes `docs/superpowers/`). That line is a code span, not a link, so nothing breaks if it is left alone.
- **M18 — plan:498** — `shortDate` does not say whether it is UTC, Jira's offset or local time. Tests run under `TZ=America/New_York`
  (`test/helpers/global-setup.ts:48`), and Jira's ISO strings carry an offset. The fixture's expected dates depend on the choice.
- **M19 — plan:623-626** — the widened cache-age bullet stays in `.claude/rules/tracker.md` (`paths: ["server/src/tracker/**"]`), so a session reading
  `server/src/jira/**` never loads the Jira half of its mechanism. Worth one sentence on why that is acceptable, or put a pointer in `jira.md`.
- **M20 — plan:189, 194** — the reader drops a bad root inside a board and a bad path inside a list, while spec §2's ENTRY is "a board, a skill, one project's
  path list". The finer grain is defensible, but it is a deviation, and plan:207 claims phase 2's writers validate "with the same code" though the write rules
  (spec:173-177) are stricter.
- **M21 — plan:533-534** — Task 8 needs the unconfigured check, but its Consumes omits `jiraEnv`, or the poller method that answers it.
- **M22 — plan:41, 413** — `tokenKind` is unstated when the site probe answers something other than 200 or 401 (0, 403, 5xx). It is asked once and never
  retried (spec:96-97), so does it stay `null` for the life of the process?
- **M23 — plan:439-440** — does the root's own issue count toward its walk's 200?
- **M24 — plan:238-239, 556-557** — a 429 refused up front is synthesised with `retryAfter` = seconds left, then re-expanded to an instant. That drifts by up to
  1 s from the stored `retryAt`, so "the same 503" only holds if the stored instant is passed (`opts.retryAt`). Say which.
- **M25 — plan:14** — "NestJS 10": `package.json:29-31` pins `@nestjs/common`/`core` `^11.2.1`.

---

## Checklist

### 1. Coverage — spec phase 1 → task

| spec item (phase 1, §12) | task | gap |
| --- | --- | --- |
| §3 `jira.client.ts` (gateway, tenant_info, Basic auth, timeout, error states, call count, last 429) | T3 | I4 timeout |
| §3 `config.util.ts` reader (writers are phase 2) | T2 | M9, M20 |
| §3 `poller.service.ts` (ticker, arming's three clauses, due, cold sweep, walk, caps, dedupe, failures, last good list) | T6 | I8, I9, I10, I11 |
| §3 `map-issue.ts` (category, level, sprint pick, Done window) | T5 | I12 (walk side, T6) |
| §3 `adf.ts` | T4 | — |
| §3 `identity.ts` (myself, site probe, back-off, 401 reset) | T6 | M22 |
| §3 `block.ts` | T7 | M18 |
| §4 shapes this phase serves | T1 | — |
| §5 reads: `GET /api/jira`, boards/:id/issues, issue/:key (+ `?format=text`), search, projects, jql/check | T8 | M7; `/prompt` deferred to phase 5, correctly |
| §8 error mapping (reads) and ADF | T3, T4, T8 | I2, I5 |
| §10 security (hostname, quoting, isJiraKey, no token in payload, CSP untouched) | T1, T3, T6, T8 | I7 |
| §12 `.env.example`, compose passthrough | T9 | M1 |
| §12 `docs/subsystems/jira.md` | T9 | M3 |
| §12 `.claude/rules/jira.md`: reader half, token (no `jira.mjs`), JQL quoting, Done window | T9 | C1, I14 |
| §13 widened cache-age line, outbound-modules lines (CLAUDE.md, invariants.md:3053, api.md:96) | T9 | M4 |

§11 test cases that belong to phase 1:
- `jira-config` per-part fallbacks: T2.
- `jira-map-issue` category, level, sprint discovery and active pick, and the three Done-window cases: T5.
- `jira-adf` one fixture per node, placeholders, unknown nodes: T4.
- `jira-poller`:
  - dedupe, depth and size caps, due intervals, identity retry and back-off, `serverInfo` → `unsupported`, 429 back-off: T6.
  - armed/idle/off: T6, with I11 missing.
  - failures with the last good list kept: T6, with I10 missing for 0 and 5xx.
- `jira-routes`:
  - 503 unconfigured, Host gate, key validation, `?format=text`, search escaping and the 409: T8.
  - Search trimming: `?q=%20%20` → `[]` is pinned, but a padded key (`%20pay-131%20` → a key search) is not.
- `test/helpers/jira.ts`: T3, with I6 open.

### 2. Values

Checked against the spec: `isJiraKey`, all caps and intervals, the window (14 days, kept at exactly 14), the sweep field list, the P2/P8 unbounded-JQL message,
P8's parse error text, the §8 status mapping, `Jira refused: <message>`, `Jira answered <status>`, `issue not found`, the scoped-token scopes, and
`DEFAULT_JIRA_INTERVAL = '1m'`. All of these match.

Strings the plan adds where the spec is silent, all consistent with it: `Jira rejected the credentials`, `Jira rate limit — retry after <ISO>`, `Jira
unreachable: <message>`, `Jira is not configured`, `connecting`, `Jira knows no issue K`, `unknown board`, `invalid issue key`, `format must be text`, `q is
required`, `q is too long (max 100)`, `jql is required`, `jql is too long (max 2000)`, the three `unreadable` reasons, the block's line layout, and
`(something was omitted — open in Jira: <url>)`. The last stands in for spec §8's `open in Jira ↗`, adapted for text, which is reasonable.

`tokenKind` is in the payload although spec §4's list omits it. §3 and §6.4 need it, so adding it is correct.

The wrong values are I7 (`tok`), I8 (`truncated`) and I13 (`armed`).

### 3. Reality

These Modify targets and named references exist:
- `shared/types.ts`: the tracker types, then the permission ladder at about :533; `SYNC_INTERVALS` :516; `isSyncInterval` :529.
- `test/helpers/env.ts`: the `BM_WATCHDOG` block.
- `server/src/app.module.ts`: `HubModule`, `ConfigModule.forRoot`. The `.env`-is-not-overridden claim holds for `@nestjs/config` 4.0.4
  (`assignVariablesToProcess` skips keys already present), and a repo-root `.env` does hold `BM_JIRA_*` keys, so the unconditional `=` blank is needed.
- Tracker pieces: `token.util.ts` / `githubToken`, `github.client.ts` (`FetchLike`, factory provider in `tracker.module.ts`), `sync-config.util.ts` /
  `writeSyncInterval`.
- Test helpers and suites: `test/helpers/github.ts`, `test/helpers/app.ts` (`listenLoopback`), `test/tracker-sync-route.test.ts` (`REGISTRY_FILE` override),
  `test/allowed-hosts.test.ts` (403), `test/app.test.ts`, `test/csp.test.ts`, `test/vite-proxy.test.ts`, `test/dialog-count-docs.test.ts`,
  `test/claude-rules.test.ts`, `test/compose-env.test.ts`.
- The items body route's `text/plain` (`server/src/items/items.controller.ts:121`, `res.type(...)`).
- The docs: invariants.md :2795 (the token section) and :3053 (the outbound sentence), `api.md:96`, the old cache-age anchor's three references, and CLAUDE.md's
  "nine path-scoped files" and "those two are the outbound-calling modules".
- `GIT_TIMEOUT_MS = 10_000`.

None of the Create targets exist yet: `server/src/jira/`, `test/helpers/jira.ts`, `test/jira-*.test.ts`, `docs/subsystems/jira.md`, `.claude/rules/jira.md`.

The false statements are M1, M2, M3 and M25.

### 4. Interfaces

Every Consumes name matches a Produces spelling, with two exceptions:
- I3: `JIRA_RATE_LIMIT_DEFAULT_MS` is used before it is produced.
- M21: `jiraEnv` is missing from Task 8's Consumes.

Return types the plan leaves unstated for `issue`, `transitions` and `serverInfo` on `JiraClient` (plan:232) are left to the implementer, which is acceptable
under the plan's own conventions.

### 5. Order

There is one forward dependency, I3. The unstated prerequisite is I1.

### 6. Tests

Most cases would fail before the code exists and pin behaviour, not implementation details. These need changes:
- **Cannot pass as written:** I4, I7, I13.
- **Cannot be expressed with the specified fake:** I6.
- **Assert nothing:** the "token only in `authorization`" checks (I7).
- **Missing cases:** I10, I11, I12, M16.

Review Focus 1 and 4 are fully pinned. Review Focus 3 depends on I6. Review Focus 2 and 5 are pinned at the poller level only.

### 7. Plan conventions

No literal code. Signatures and regexes are stated as values, and the budgets are soft. The 160-column wrap is broken in places (M14).
