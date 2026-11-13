## Verdict: APPROVE WITH FIXES

Plan: `docs/superpowers/plans/2026-11-12-gitlab-connection.md` (cited as `plan:<line>`, at `dbf382c9`).
Spec: `docs/superpowers/specs/2026-11-12-gitlab-connection-design.md` (cited as `spec:<line>`).
Scope: only the lines changed between `aadc0414` and `dbf382c9`; surrounding text read for context. The repo has no `.codegraph/`, so code claims were
checked by reading the files at HEAD.

## What changed, and whether review 1's findings are closed

All twelve rulings of review 1 have matching plan text, and the new code references are accurate:

| Review 1 | Plan now | Checked against |
| -------- | -------- | --------------- |
| C1 sweep failure → `unreachable` | `plan:252-254`, test `plan:286-288` | `spec:89`, `spec:165-166` |
| C2 blank `BM_GITLAB_*` in jest | `plan:64-66` | `test/helpers/env.ts:113-115` is the Jira trio, `=` not `||=` (`:106-111`) |
| I1 `armed` meaning | `plan:232-233`, test `plan:263` | `server/src/tracker/poller.service.ts:419-420` |
| I2 identity retry | `plan:240-242`, test `plan:283-284` | `server/src/tracker/poller.service.ts:95` (`IDENTITY_RETRY_MS = 60_000`) |
| I3 `poll-coalescing` | `plan:341`, `plan:353-355` | `test/poll-coalescing.test.tsx:88-134` (`SUBJECTS`), `:140` (`GATED`) |
| I4 PAT route test | `plan:324-328` | `readJiraConfig` reads `BM_JIRA_FILE` per call (`server/src/jira/config.util.ts:54-55,239`); `readRepos` accepts any non-empty path (`:157-179`) |
| I5 detail reads | `plan:247-250`, tests `plan:270-272` | internally consistent now |
| I6 two Jira keys | `plan:274-276` | discriminates: an unscoped `mrKeys` would key the proxy MR `PAY-7` |
| I7 sweep bodies, known stays known | `plan:329-330`, `plan:399-400` | `server/src/jira/jira-write.controller.ts:111-112`; `spec:198-199` |
| I8 join rule | `plan:467-468` | `spec:238` |
| I9 `http://` | `plan:117-118` | `spec:113-116` |
| I10 docs list | `plan:550-552` | `.claude/rules/jira.md:24-25`, `.claude/rules/board.md:153-155`, `CLAUDE.md:44-45` |

No Critical finding. Three places in the new Task 5 text still make the implementer guess; each is a one-sentence fix plus one assertion.

## Checklist results (changed lines only)

1. **Coverage** — the added rules map to spec §5.2 (`spec:89`, `spec:100-103`), §6.1, §6.3 and §7. Nothing added is without a task.
2. **Values** — `GitLab is not being polled`, `rate limited`, `redirect refused (302)`, the no-MR line and `GITLAB_IDENTITY_RETRY_MS = 60_000` match the
   spec or the cited precedent.
3. **Reality** — every new path and line reference exists; one is off by a line or two (M1).
4. **Interfaces** — `GITLAB_IDENTITY_RETRY_MS` is produced (`plan:228`) before it is used (`plan:241`); `armed` now has one meaning.
5. **Order** — the `test/helpers/env.ts` edit sits in Task 1, ahead of Task 6 where it starts to matter. Correct.
6. **Tests** — I1, I2, I3 below.
7. **Own conventions** — no literal code added.

## Important

### I1. The state has two inputs now (identity verdict, sweep outcome) and no rule for which wins

`plan:254` says "the next sweep in which no call fails that way restores `connected`", unconditionally. `plan:244` says `connected` needs "a successful
identity read", and the new test at `plan:283-284` expects `unreachable` to hold after "identity 503 at bootstrap" until the identity is re-read — yet
with a mapped repo the bootstrap `arm()` runs an immediate, healthy sweep (`plan:243`, `plan:317`), which by `plan:254` read literally turns the state
`connected` with `user: null`. The reverse is unstated too: identity `rejected`, then a list call with status 0 — `rejected` or `unreachable`
(`plan:252-253`)? Task 9 draws `<username> · <site>` for `connected` (`plan:437`), so a `connected` state with no user is a visible defect.

Fix: one sentence in Task 5's behaviour, for example "state = the identity's verdict while it is not a working token (`checking` / `rejected` /
`unreachable`); otherwise `unreachable` while the last sweep had a status 0 / 5xx call; otherwise `idle` or `connected`", and one assertion: identity 503
at bootstrap with a mapped repo, first sweep healthy → state still `unreachable`, `user: null`.

### I2. A detail call answering 0 / 5xx: does the state turn `unreachable`?

`plan:248-250` says a failed detail call keeps the last pipeline and "does not mark the project `failed`". `plan:252-254` says "Status 0 … or 5xx **on a
project**" turns the state `unreachable`, and that `connected` returns on "the next sweep in which **no call** fails that way" — "no call" includes detail
calls, "on a project" may or may not. The test at `plan:271-272` (detail for `!412` answers 500) asserts the pipeline and `failed: false` and says nothing
about the state, so both readings pass. The spec's rule is "the identity read or a sweep gets no HTTP answer …, a 5xx, or a 3xx" (`spec:89`), which
covers a detail call.

Fix: say which. Recommended, following `spec:89`: a detail call with status 0 / 5xx turns the state `unreachable` (reason = its message) without marking
the project `failed`; a detail 404 or 403 does neither. Add `state` to the assertion at `plan:271-272`.

### I3. The identity retry rule reads two ways, and one of them double-reads `/user` at every boot

`plan:240-241`: "While the identity is unanswered or `unreachable`, it is retried at the top of each sweep and by `payload()` at most once per
`GITLAB_IDENTITY_RETRY_MS`". Two guesses are left:

- Whether the 60 s pace applies to the sweep-top retry or only to `payload()`. The cited precedent paces the sweep
  (`server/src/tracker/poller.service.ts:831-833`); the test at `plan:283-284` pins the pace for `payload()` only ("no second `/user` call is made by
  `payload()`").
- What "unanswered" retries. Bootstrap starts the identity read and calls `arm()` (`plan:317`), whose immediate sweep starts while that read is still in
  flight — "unanswered" — so the literal reading issues a second `/user` call at every boot, and a `payload()` during a slow read does the same.

Fix: state that a read in flight is never duplicated, and that both callers share one pace measured from the last read's start; add one assertion:
bootstrap with a mapped repo and a healthy fake → exactly one `/user` call after the first sweep settles. Split the test at `plan:283-284` into its
`payload()` case and its sweep case so each has one expected outcome.

## Minor

- **M1.** `plan:354` cites the `useTicks` entry as `:126-131`; the entry is `test/poll-coalescing.test.tsx:125-133` (the comment is `:126-127`).
- **M2.** `plan:467-468` rests the no-MR line's order on "`jiraProjects` order — by project path", but no Task 5 case asserts the order of
  `jiraProjects[key]` (`plan:274-276` says "both"). Assert `jiraProjects.TIMIFY` as an ordered pair there.
- **M3.** `plan:399-401` — the inserted sentence broke the bullet's line wrap; and Task 8's `none` fixture still has one repo
  (`plan:400`). The two-repo case is only reached through `DeliveryPane` in Task 10 (`plan:467`), which is enough to catch a first-repo-only
  implementation, but a `repos: ['microservice', 'dev-api-graphql-proxy']` case in the pure suite would fail closer to the cause.
- **M4.** `plan:550` adds `.claude/rules/jira.md:24`; the same statement lives in two code comments the task does not list:
  `server/src/jira/jira-write.controller.ts:63-64` ("A repos write does tell `JiraLiveService` (`reposChanged`), so the session reconciler in `agents/`
  arms") and `server/src/jira/live.service.ts:343-346` ("the reconciler subscribes"). After Task 5 there is a second subscriber. Comments are
  load-bearing in this repo (`CLAUDE.md` Conventions); name both in Task 5 or Task 13.
- **M5.** `plan:324-328` — pointing `BM_JIRA_FILE` at a mapped repo inside an `AppModule` suite also arms the Jira session reconciler
  (`server/src/jira/live.service.ts:343-346`). Harmless, but say that the suite restores `BM_JIRA_FILE` afterwards, as
  `test/github-sweep-route.test.ts:86-90` restores `process.env`.
- **M6.** `plan:329-330` — "armed, healthy" does not say how the suite gets a mapped repo; it is the temp repo of the case above. One word ("with the
  same temp repo") removes the guess.
- **M7.** `plan:117-118` settles `http://` remotes as never on the site, which the spec does not state (`spec:113-116` speaks of SSH and HTTPS only). It
  is the safe reading; worth a line in the spec's "Calls I made" so the two documents agree.

## Rulings

| Id | Outcome | Evidence |
| -- | ------- | -------- |
| 2-1 | FIX | Unconditional restore contradicted the identity rule; a state-precedence sentence and a 503-then-healthy-sweep assertion added (Task 5). |
| 2-2 | FIX | Detail 0/5xx/3xx now turns the state `unreachable`, project stays `failed: false`; detail 404 does neither; state asserted in the test. |
| 2-3 | FIX | One shared 60 s pace from the last read's start, in-flight read joined; one-`/user`-at-boot assertion; retry test split into `payload()` and sweep cases. |
