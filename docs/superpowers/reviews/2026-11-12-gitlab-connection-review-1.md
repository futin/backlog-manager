## Verdict: REVISE

Plan: `docs/superpowers/plans/2026-11-12-gitlab-connection.md` (cited below as `plan:<line>`).
Spec: `docs/superpowers/specs/2026-11-12-gitlab-connection-design.md` (cited as `spec:<line>`).
Reviewed against the tree at `aadc0414`. The repo has no `.codegraph/`, so every code claim was checked by reading the file at HEAD.

## What this proposes

A new server module, `server/src/gitlab/`, reads two env values (a GitLab hostname and a `read_api` token), works out which repos mapped in `jira.json`
live on that GitLab site by reading each repo's `origin`, and sweeps those projects' merge requests every two minutes into an in-memory cache served at
`GET /api/gitlab`. The client reads that one payload through a shell-level provider and a pure library turns it into a per-ticket delivery state (lead MR,
words, tones, track), which is drawn as a Sources row, a Delivery pane in Jira Detail, a chip on board cards, a band line, a List column and a quick
filter. The last two tasks update the invariants, rule files and DESIGN.md, and run `/ui-verify` against the four picked mocks. Fourteen tasks, each
test-first, one commit per task, no literal code.

## How the existing system works, per this document

The server already has two outbound pollers the plan copies shapes from: the tracker poller (a `setTimeout` chain with `timer`, `inFlight`, `arm()`,
`tick()`, `schedule()`), and the Jira poller (one stored 429 window, expired where it is read), plus a Jira client with an injected fetch and its own
abort deadline. Credentials are read from `process.env` per call and never leave the server; `runGit` is the one, read-only, way to run git; every route
is under `/api`. `jira.json` maps Jira project keys to repo paths and a repos save tells `JiraLiveService.reposChanged`, whose listener list is the hook
the new poller subscribes to. On the client, shell-level providers (`JiraProvider`, `PullRequestsProvider`) each own one fetch through `useRefreshing`;
the Jira board is a deck over shelves plus a List table, filtered by panel filters persisted under `JIRA_FILTERS_KEY`; Settings › Sources draws one
`SettingsRow` + `StatusPill` per source and a Read again foot that posts each service's sweep route and treats a 409 as "nothing to sweep".

Every section of the plan could be paraphrased.

## Checklist results

1. **Coverage** — every spec section maps to a task (§5.1 → T1; §5.2 → T3, T5, T6, T9; §6.1 → T2, T4; §6.2 → T4, T8; §6.3 → T3, T5, T6; §6.4 → T5, T7,
   T13; §7 → T8; §7.1 → T10; §7.2 → T11; §7.3 → T11; §7.4 → T12; §7.5 → T9; §8 → T13, T14; §9 → T8's data-driven track, T5's per-MR shape). Gaps: C1,
   I2, I9, M9, M10 below.
2. **Values** — copy strings match the spec's tables (§5.2, §7, §7.1–§7.4) wherever I compared them. Exceptions: C1 (a state the spec defines has no
   producer), M4.
3. **Reality** — every Modify path exists and every Create path is absent at HEAD; line references are accurate except those in I3, M1, M2, M3.
4. **Interfaces** — consistent, apart from I1 (`armed` has no stated meaning), M5, M6.
5. **Order** — no task depends on a later one.
6. **Tests** — see C2, I3–I9.
7. **Own conventions** — no literal code, mocks cited in every view task (T9–T12), one commit per task. See M7.

## Critical

### C1. A sweep that cannot reach GitLab never reaches the Sources row; the row stays green `connected`

`plan:232-235` makes the identity read the only input to `rejected` / `unreachable`. `plan:242-244` says a project list answering status 0 or 5xx sets
that project's `failed: true` and nothing else; `GitlabRepoProblem` (`plan:218`) has no kind for it and `gitlabLines` (`plan:402-414`) has no line for
it. The spec's table decides `unreachable` by "the identity read **or a sweep** gets no HTTP answer (DNS, TLS, timeout), a 5xx, or a 3xx"
(`spec:89`), and §6.3 says a failed sweep "records the failure for the Sources row" (`spec:165-166`). Built as written, GitLab going down after a good
boot leaves a green `connected` pill with no hint line, while every chip silently ages. Review Focus 2 (`plan:48-49`) claims "the row reads
`unreachable`" for a 301/302 but its only state test is the identity read (`plan:265-266`); a 302 on a project list is untested and, per the plan's
rules, would not turn the row.

Fix: state in Task 5 that a sweep whose calls get status 0 / 5xx / refused 3xx sets `unreachable` with the reason (and what restores `connected`: the
next sweep that succeeds), add a Task 5 test (good identity, then list answers status 0 and, separately, 302 → `state: 'unreachable'`,
`reason` set, MRs kept; next good sweep → `connected`), and a Task 9 case is already there for the wording.

### C2. No task blanks `BM_GITLAB_SITE` / `BM_GITLAB_TOKEN` for the jest process, so every `AppModule` suite dials the developer's real GitLab

`test/helpers/env.ts:99-115` overwrites the three `BM_JIRA_*` variables with `''` for exactly this reason: `ConfigModule.forRoot` loads `.env` at import
time (`server/src/app.module.ts:19`), so "any suite that builds `AppModule` and calls `app.init()` then makes a REAL request to a REAL site at boot …
and one that does not [stub fetch] would send the developer's real API token to the network from `pnpm test`" (`test/helpers/env.ts:101-104`). The plan
makes the identity read a bootstrap action that is "independent of arming" (`plan:232-235`, `plan:298`) and Task 1 tells the user to put both values in
`.env` (`plan:84-86`), yet no task touches `test/helpers/env.ts`. After Task 6 every existing suite that builds `AppModule` (e.g.
`test/github-sweep-route.test.ts:51`) sends `PRIVATE-TOKEN` to the real site on this machine, and suites that stub `global.fetch` see a `/user` call
they do not expect. Task 6's own "unconfigured" case (`plan:302-303`) also depends on the two being blank.

Fix: add to Task 1 (or Task 6, before the module is registered) — Modify `test/helpers/env.ts`: `process.env.BM_GITLAB_SITE = ''` and
`process.env.BM_GITLAB_TOKEN = ''` with `=` not `||=`, with the comment in the Jira block's vein; and say that every suite building `AppModule` with them
set overrides `GitlabClient`.

## Important

### I1. `status.armed` is never defined, and the shape the plan says to copy reads `false` during every sweep

`plan:211-212` shapes the poller after `TrackerPollerService`, whose `armed` is `this.timer !== null` (`server/src/tracker/poller.service.ts:419-420`)
and whose sweep clears the timer before its first await (`:807-810`) — so `armed` is false for the whole of a sweep. `plan:228` declares
`get armed(): boolean` with no meaning; `plan:247` calls "not armed" "no timer, no sweep in flight", a different meaning. `deliveryShown`
(`plan:347-348`) keys every surface on `status.armed`: with the tracker's meaning the List column, band line, both filter controls and the stored
filter's effect vanish for the length of each sweep (one detail call per open MR), and before the first sweep finishes `armed` is false, so the spec's
`GitLab not read yet` copy (`spec:195-196`) is never drawn. The only test (`plan:253-254`) reads `armed` after `await tick()`.

Fix: define `armed` in Task 5 as "a timer is pending or a sweep is in flight", and add a test that `payload().status.armed` is `true` while the fake's
list call is pending.

### I2. A failed identity read at boot has no retry

`plan:232-233` re-reads identity only "at bootstrap, and again when a fingerprint of (site, token) changes", plus on a 401 (`plan:243`). A server
started while the laptop is offline, or while GitLab answers 503, sits at `unreachable` with `user: null` until restart — even while sweeps succeed —
and nothing in the plan says what state a successful sweep with a never-read identity shows. The tracker poller paces a retry
(`server/src/tracker/poller.service.ts:826-834`).

Fix: say when a failed (status 0 / 5xx) identity read is retried (e.g. at the top of each sweep while it has no answer) and add the test: identity 503,
then 200 on the next sweep → `connected` with `user` set.

### I3. Task 7's `poll-coalescing` instruction names an entry that does not exist, and leaves `GATED` unstated

`plan:330` says "add `useGitlab` to `SUBJECTS` with the same assertions the `usePullRequests` entry gets". `SUBJECTS`
(`test/poll-coalescing.test.tsx:88-134`, not `:95-133` as `plan:318` says) holds `useOrchestratorRuns`, `useBoard`, `useWatchdog`, `useAgents`,
`useOrchestratorArchive`, `useTicks`; `usePullRequests` is not imported by that suite at all. A constantly-armed 30 s poller also lands in `GATED`
(`:140`, case 9 "arming conditions hold", `:349`) unless it is excluded by name the way `useTicks` is, and entries are appended last because of the
index-based `SUBJECTS[n]` lookups (`:126-127`).

Fix: name the model entry (`useTicks`: `periodMs: GITLAB_CLIENT_POLL_MS`, `perRequest: 1`), say "append last", and say `useGitlab` is added to the
`GATED` exclusion with its reason.

### I4. Task 6's token/PAT route test cannot fail for `oauth2`

`plan:305-307` asserts `GET /api/gitlab`'s body contains neither `glpat-SECRET-123` nor `oauth2`, and Review Focus 1 (`plan:46-47`) relies on it for
"route JSON". Nothing in the test puts `oauth2` into the system: the route reads repos from `readJiraConfig()` (`BM_JIRA_FILE`, a missing temp file by
default — `test/helpers/env.ts:123`) and origins from real `runGit`, and the plan sets up neither. The assertion passes against an implementation that
returns the raw remote.

Fix: have the test write a `jira.json` under `BM_JIRA_FILE` mapping a temp git repo whose `origin` is
`https://oauth2:glpat-abc@www.gitlab.timify.io/ns/repo.git` (or override the poller's `repos`/`readOrigin` deps), await a `tick()`, then assert on the
body — including a problem-line path (`origin`, `cannot-read`) so the strings that could carry it are present.

### I5. Pipeline detail read: which MRs get one is contradictory, and a failed detail call is unspecified

`plan:240` says "one `mergeRequest` call per **kept** opened MR" and `plan:241` drops MRs with no keys; the test at `plan:259` expects detail calls
"for 412, 419, 500" — `!500` is the keyless MR the same test says is absent from `mrs`. An implementer must guess whether key-less open MRs cost a
request each sweep (spec §6.3 bounds the count by open MRs; either reading fits, the two lines do not agree). Separately, nothing says what an opened
MR's `pipeline` is when its detail call answers 0 / 5xx / 404 (type `GitlabPipeline | null`, `null` reserved for merged/closed, `plan:215-216`), or
whether that marks the project `failed`.

Fix: pick one (recommended: detail only for opened MRs that carry a key — drop `500` from `plan:259`), and state the failed-detail rule with a test.

### I6. `jiraProjects` (per Jira key) is only ever built with one key in the poller tests

Every Task 5 case maps repos under one Jira key (`plan:253-264`); `jiraProjects.TIMIFY[0]` is the only read. An implementation that lists every GitLab
project under every key, or keys MRs with all Jira keys rather than `target.jiraKeys`, passes Task 5. Task 4 has two keys but stops at the mapping; the
client's `hidden` rule (`plan:350`, `plan:373`) depends on this map being scoped.

Fix: add a Task 5 case with `{ TIMIFY: [microservice, proxy], PAY: [microservice] }` asserting `jiraProjects.PAY` holds microservice only and an MR in
proxy on branch `pay-7-x` carries no key.

### I7. Task 5 / Task 6 leave two of the three sweep-route answers and the "known stays known" rule untested

- Route: `plan:294-296` defines 200 `{ ok: true }`, 409 and 429 `{ message: 'rate limited', retryAt }`; the tests (`plan:302-307`) pin only the 409 and
  the guard's 403. The 429 body is what `refusalText` reads (`client/src/lib/sweep.ts:33-38`).
- Delivery: spec "A later failed sweep keeps the last good answer, so a known ticket stays known" (`spec:198-199`). `plan:373` tests `failed` only with
  `polledAt: null`; a project with `failed: true`, `polledAt` set and no MR must read `none`, and no case says so — an implementation returning
  `unknown/failed` whenever `failed` passes.

Fix: add both cases.

### I8. The no-MR line's repo list has no join rule, and the real project maps two repos

`plan:441` tests `no merge request for TIMIFY-144 in microservice in the last 30 days` with one repo; `TicketDelivery`'s `none` carries `repos: string[]`
(`plan:349`). `TIMIFY` maps `microservice` and `dev-api-graphql-proxy` (`spec:12-13`), so the drawn line always has two names and the separator is the
implementer's guess (spec: `<repo basenames>`, `spec:238`).

Fix: state the join (e.g. `, `) and test it with two repos; make the Task 8 `none` fixture two repos as well.

### I9. `remoteOnSite` is undefined for an `http://` remote

`ParsedRemote.scheme` includes `'http'` (`plan:99`); `plan:112-114` gives rules and rows for scp, ssh and https only. The spec's port rule is stated for
`https://` (`spec:115-116`). Whether `http://www.gitlab.timify.io/ns/r.git` (no port, or `:80`) is on the site is a guess.

Fix: one sentence and one test row.

### I10. Task 13's file list misses mechanism text this change makes false

- `.claude/rules/jira.md:24` — "repos and skills re-aim no poller work, since no sweep reads them (a repos save only calls
  `JiraLiveService.reposChanged`, which arms the session reconciler)". After Task 5 the same call arms the GitLab poller (`plan:227`). The rule file is
  "the one home of its rules' mechanism" (`CLAUDE.md:157`). The same sentence is in `server/src/jira/jira-write.controller.ts:63-64`.
- `.claude/rules/board.md:153-155` enumerates every poller that enters through `useRefreshing`; `GitlabProvider`/`useGitlab` joins it.
- `CLAUDE.md:44-45` lists the server's modules "one module per directory"; `gitlab/` is not added by `plan:518-522` (which names `:108`, `:159`, the
  table and the new headline only). Those bytes also count against the budget in `plan:539`.

Fix: add the three to Task 13's Modify list.

## Minor

- **M1.** `plan:14` says "NestJS 10"; `package.json:31` pins `@nestjs/core ^11.2.1`.
- **M2.** `plan:399-400` — "beside `jiraTone`'s helpers" in `client/src/lib/service-status.ts`: `jiraTone` is a local const in
  `SourcesGroup.tsx:79-82`; the helpers there are `serviceTone`, `jiraDown`, `githubDown`. Also `CARD_WORD` (`SourcesGroup.tsx:181`) has one grey word,
  `not polled yet`; the grey `not configured` and `checking…` pills of `plan:403-405` are literals, as the Jira row does at `:151` — worth saying.
- **M3.** `plan:487` lists `JiraPanelFilters :688` as the place the field is added; it is `Omit<JiraBoardFilters, 'search'>`
  (`client/src/lib/jira.ts:688`), so the field goes on `JiraBoardFilters` and `NO_JIRA_FILTERS` (`:685`) too, and the "four panel filters" comments
  (`:687`, `:761`) become five.
- **M4.** `plan:378-380` words the band age with `polledPhrase`, which prints `polled 4m ago` / `not polled yet`
  (`client/src/lib/jira.ts:466-469`); the spec writes `polled <age>` and `polled 2m` (`spec:170`, `spec:256`). Say which wins. `plan:414`'s
  `next read in …` is a future instant; `pollAge`/`ageText` age the past (`client/src/lib/tracker.ts:37`, `client/src/lib/dashboards.ts:413`) — name the
  helper.
- **M5.** `plan:128` — `FetchLike` is not exported from `server/src/jira/jira.client.ts:55`; `gitlab.client.ts` must declare and export its own for
  `test/helpers/gitlab.ts` (`plan:139`).
- **M6.** `plan:181-182` puts `GitlabPipeline` in `shared/types.ts` in Task 4, whose Files list (`plan:165-167`) does not name that file. `plan:430`
  attributes `polledPhrase` to Task 8. `plan:464` omits `deliveryIndex` from Task 11's Consumes.
- **M7.** `plan:38` hardcodes a model name in the commit trailer; the implementing session's own attribution may differ.
- **M8.** `plan:76-77` tests a malformed site only "with a token"; malformed site and no token (which detail?) is unstated. `plan:79-80` says
  `it.each` for all three compose assertions, the Jira describe's third is a single `toEqual` on the constant (`test/compose-env.test.ts:132-134`).
- **M9.** `plan:151-152` — the opaque-redirect case has `status: 0`, so the `<code>` in `redirect refused (<code>)` is undefined for it.
- **M10.** No test pins the draft word at the MR open step in Detail (`spec:205-206`) or the List's mini-track dot tones (`spec:266`); `plan:261`'s
  `shown: 500` does not say whether rows without a key count; `plan:412` does not say `1 repo` vs `1 repos`.
- **M11.** Tasks 10–12 add `.test.tsx` suites with Jira issue fixtures and age assertions; `.claude/rules/tests.md` requires `daysAgoDate`/`daysAgoStamp`
  for `created`/`updated` (guarded by `test/fixture-clock.test.ts`). Worth one line in Global Constraints.
- **M12.** `plan:294-296` + `plan:247`: with `arm()` called first, a configured server with no repo on the site answers the sweep route 200 (a tick is
  in flight), not the 409 `spec:104-105` describes. Harmless to the foot; say it or test it.

## Rulings

| Id | Outcome | Evidence |
| -- | ------- | -------- |
| 1-1 | FIX | spec:89 and :165-166 — a sweep with no HTTP answer is `unreachable`; Task 5 now sets it, says what restores `connected`, tests 0 and 302 after a good identity. |
| 1-2 | FIX | `test/helpers/env.ts:113-115` blanks only the Jira trio; `app.module.ts:19` loads `.env`. Task 1 now blanks `BM_GITLAB_*` with `=`. |
| 1-3 | FIX | `server/src/tracker/poller.service.ts:419-420` `armed = timer !== null`; Task 5 defines armed as timer pending or sweep in flight, tested mid-sweep. |
| 1-4 | FIX | No retry was stated; Task 5 retries an unanswered/unreachable identity per sweep and from `payload()` at most once per 60 s, tested 503 → 200. |
| 1-5 | FIX | `test/poll-coalescing.test.tsx:88-140` has no `usePullRequests` entry; model is now `useTicks`, appended last, excluded from `GATED`. |
| 1-6 | FIX | Nothing fed a PAT remote; Task 6 now maps a temp repo with an `oauth2:glpat-abc@` origin and asserts the path was read. |
| 1-7 | FIX | Contradiction resolved: keyed opened MRs only; a failed detail read keeps the last pipeline, else `none`, tested. |
| 1-8 | FIX | Task 5 adds a TIMIFY + PAY case. |
| 1-9 | FIX | Task 6 tests the 200 and 429 sweep bodies; Task 8 pins failed-with-`polledAt` → `none`. |
| 1-10 | FIX | Join rule `, ` in project-path order, tested with two repos (Task 10). |
| 1-11 | FIX | `http://` remotes are never on the site; one test row. |
| 1-12 | FIX | `.claude/rules/jira.md:24`, `.claude/rules/board.md:153-155`, `CLAUDE.md:44-45` added to Task 13's Modify list. |
