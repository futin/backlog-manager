# Review 2 — Jira phase 1, server read (plan), narrow re-check

**Plan:** `docs/superpowers/plans/2026-10-16-jira-phase-1-server-read.md`
**Spec:** `docs/superpowers/specs/2026-10-15-jira-integration-design.md` (§12 phase 1)
**Scope:** only the hunks of `plan-review-1.semantic.diff`, read against the unchanged plan around them and against round 1's report.
**Date:** 2026-10-16 · **Verdict: APPROVE WITH FIXES** — round 1's Critical and most of its Important findings are resolved. Seven Important findings remain.
Four of them were introduced by the edits themselves. Each is a local text fix that needs no new design decision, except I2, which needs one line choosing
the `access` a boot call records. No third round is needed if the fixes land as described.

Every claim about the code was checked against the tree at `docs/jira-integration-spec` (98870e9). `codegraph_explore` was not needed: every lookup was a
known file and line.

---

## Important

**I1 — plan:279 — Task 3's `jiraHttpError` test still says the body is `{ message, access }` "exactly". The edited contract is `{ error, access?, retryAt? }`
(plan:51, plan:239).**
The I2 edit reached the Global Constraints, the Interfaces and every Task 8 case, but missed this line. The line also defers to "exactly as the Global
Constraints state them", and the Global Constraints name `access` on the 401 row only (plan:52). So for 403, 429, 0, 5xx, 400 and 404, the test cannot tell
whether `access` is present or absent. `accessOf` now returns `null` for 400 and 404 (plan:237-238), which suggests "`access` = `accessOf(res)` when non-null",
but the plan never says so. Round 1's I5 asked for exactly this per-row statement.
→ Line 279 becomes `{ error, access?, retryAt? }`. State the rule once, in `jiraHttpError`'s Produces: `access` is `accessOf(res)` when non-null and omitted
otherwise. That gives 401 `unauthorized`, 403 `forbidden`, 429 `rate-limited`, 0 and 5xx `unreachable`, and 400 and 404 none. The test then asserts each
row's full body.

**I2 — plan:237-238 with plan:394 and plan:416-419 — the boot path has no defined `access` for a boot call whose status `accessOf` now maps to `null`.**
`JiraBootState.fail(access, detail, now)` takes a `JiraAccess` (plan:394). The boot cases cover transport, 401, 403, 5xx, and serverInfo's 404 (`unsupported`).
Before this edit, every other status fell through to `unreachable`. Now 400, 404 and any other 4xx return `null` from `accessOf`. That covers `tenant_info`
on a mistyped `*.atlassian.net` hostname, which is Review Focus 2's own example at plan:72 ("a typo in the hostname"). It also covers `myself` or `field`
answering 404, and `field` answering 400. The implementer has to guess what `access` and `detail` become.
→ Add one sentence to Task 6 Step 3: a boot call answering a status `accessOf` maps to `null` records `unreachable` with `detail: 'Jira answered <status>'`,
except serverInfo's 404, which stays `unsupported`. Add one case: `tenant_info` 404 gives `access: 'unreachable'` and `armed` true.

**I3 — plan:55-56 — the new route-side state rule has no test. Round 1's I5 asked for one: "a 404 detail read leaves `status().access` at `ok`".**
The Global Constraints now say that only a 401 (which resets `me`) and a 429 (which opens the window) move the site-level state, and that a 0, 5xx, 400, 403
or 404 on a route does not. Task 8 pins only the 429 half, through "no new call inside the window". Nothing asserts that a route 401 resets `me` and sets
`access: 'unauthorized'`. The 401 half is spec §3 ("A 401 on any later call resets `me`", spec:99). Nothing asserts either that a route 404, 403 or transport
failure leaves `status().access` at `ok`. Without the second case, an implementer who records every route failure on the site state turns the chip red when
someone opens one deleted issue, and every test stays green.
→ Add two cases to Task 6's `issueDetail` bullet (plan:466-470). First, the fake answering 401 makes `status().me` null and `access` `unauthorized`. Second,
a 404, a 403 and a transport failure each leave `status().access: 'ok'` and `detail: null`.

**I4 — plan:548-551 with plan:553-555 — Task 8's new Review Focus 2 case cannot run in the app the edited setup prescribes.**
The setup is now "one describe per configuration, configured and unconfigured", with "one `beforeAll` app per describe". The configured describe's boot tick
runs at `app.init()` against a healthy fake, and it has to: the cases right before (`configured: true`, `me`, `tokenKind`) and the `armed` case (plan:573-574)
need a successful boot. Boot calls are asked once (plan:415), and a later 401 resets only `me` (plan:394). So `tenant_info` is never requested again in that
app, and a `failNext` aimed at it never fires. `GET /api/jira` keeps answering `access: 'ok'`. With the real clock (Task 8 mocks nothing), the back-off cannot
be stepped past either.
→ Give the case its own describe: its `beforeAll` sets `failNext` on `tenant_info` (transport) before `app.init()`, then asserts that `GET /api/jira` answers
200 with `access: 'unreachable'` and no `search/jql` in the fake's log. Change "one describe per configuration" to allow that third describe.

**I5 — plan:548-551 with plan:563-566 — in the single configured app, the 429 window bleeds into every case that follows it.**
The §8 bullet opens a 30 s window (`rateLimit: { retryAfter: 30 }`), and a route 429 opens the site window (plan:55-56). The suite runs on the real clock. The
very next cases in the same bullet expect `failWith: 'transport'` → 502 and `failWith: 500` → 502. Inside the window, both are refused up front with the
rate-limit 503 (plan:53-54). The search, projects and jql/check bullets after them hit the same refusal. Before the edit, the describes were unspecified, so
splitting them was open to the implementer. "One describe per configuration" now closes that option.
→ Put the two 429 cases in a describe and app of their own, or `jest.spyOn(Date, 'now')` in this suite and advance past `retryAt` after the 429 cases. State
which one.

**I6 — plan:423-426 — the I9 answer says spec §3's "under `unreachable` the sweep keeps trying on the same ticker" *is* the plan's rule. The spec draws the
opposite contrast.**
Spec:97-99 says the failed identity call "is retried on the sweep ticker with back-off … — under `unauthorized` the sweep itself does not run …, under
`unreachable` the sweep keeps trying on the same ticker". The back-off retry is already the first clause. The contrast in the second says the sweep runs under
`unreachable` and does not run under `unauthorized`. The plan makes the two identical at boot: no board is searched until every boot call has answered. Spec:89
also has the sprint field "retried on the ticker until it answers", not on the back-off. The rule itself is now stated and tested, so an implementer will not
have to guess, and it has a stated reason (a search without the sprint field). But the plan presents a deviation as conformance, and round 1 offered two fixes
— sweep once `cloudId` is held, or amend the spec — and the plan applied neither.
→ Replace "is this" with "deviates from" plus the reason, add it to the Decisions list (plan:671-673), and amend spec §3's identity sentence and spec:89's
"retried on the ticker" in the same PR.

**I7 — plan:641-642 — "left to the next `/docs-sync`, which adopts an unstamped doc" is false. The next run reports the new doc as an error.**
`docs/.docs-sync.yml` has a plan (`docs:` and `out-of-scope:`, neither covering `docs/subsystems/jira.md`). Under a plan, a markdown file with no stamp and no
entry is `unaccounted`, and `unaccounted` "is an error in plan mode" (`~/.claude/skills/docs-sync/references/bootstrap.md:88`). The checker exits non-zero
(`SKILL.md:153`, "fix via bootstrap/migration, never inline"). The one auto-add case explicitly excludes it, on two grounds: "never `unaccounted`" (condition
1) and "An unstamped doc is a draft nobody has read against the code" (condition 3, bootstrap.md:49-57). Spec §12's closing sentence (spec:374) requires
`/docs-sync` to stay green at every merge.
→ Add a Task 9 step: register `docs/subsystems/jira.md` through `/docs-sync` bootstrap (kind `subsystem`, sources `server/src/jira`), stamped at the doc's
commit, in a commit of its own as bootstrap does. Alternatively, say plainly that the PR leaves `/docs-sync` red until that is done.

---

## Minor

- **m1 — plan:14** — Tech Stack still lists `AbortSignal.timeout`. Task 3 now forbids it (plan:272-274, 286).
- **m2 — plan:272-274, 286** — "a `setTimeout` + `AbortController` deadline" does not say the timer settles the call itself. A fake `fetch` that "never
  resolves" and ignores `init.signal` never rejects, so a client that only calls `abort()` and awaits `fetch` hangs the test. Say "races the fetch against the
  deadline; on expiry, aborts and answers `status: 0`".
- **m3 — plan:245-246** — `failNext` is called "the shape of `test/helpers/github.ts`'s rule table". That helper has no table. Its `failNext` is ONE
  `{ fragment, status, headers? }` that removes itself after it fires (`test/helpers/github.ts:95-102, 185-187`). The Jira hook is a standing function under
  the same name, which invites a one-shot port. Name the difference, or rename the hook (`failWhen`).
- **m4 — plan:425** — "until `cloudId`, `serverInfo`, `me` and the sprint field are all in". A site with no `gh-sprint` field keeps `sprintField: null`
  forever. The gate is `fieldsOk` (`answered()`, plan:393), so write "the field list".
- **m5 — plan:413-414 vs plan:486** — a site probe answering 0, 403 or 5xx leaves `tokenKind` null, never retried, still five calls and `access: 'ok'`.
  Step 3's boot chain says "stop at the first failure". Say that the site probe's answer is never a boot failure.
- **m6 — plan:489-490** — `last429At` is built in the client (Task 3, plan:230), so the "`Date.now()`, never `new Date()`" rule belongs in Task 3 Step 3
  too.
- **m7 — plan:563-565** — "the same `retryAt`" on the second request holds for the FIRST 429 only if the poller returns its stored instant in
  `JiraResult.retryAt` and the controller passes it as `opts.retryAt`. Otherwise `jiraHttpError` recomputes now + 30 s and can differ by a millisecond. Say that
  both 429 paths pass the stored instant (plan:240-241 says it only for the up-front refusal).
- **m8 — plan:427-429** — a board search answering a 4xx other than 400, 401, 403, 404 or 429 (405, 410, 413, 422) is classified neither whole-board nor
  per-entry.
- **m9 — plan:631** — `invariants.md:2929`'s "this stays the one cache" says that `RemoteRunsService` adds no cache of its own beside the tracker's. It stays
  true with Jira present. "These stay the two caches" muddles that. Leave the sentence alone, or write "this stays the one tracker cache".
- **m10 — plan:645-646** — "(a session under `server/src/jira/**` reads it in this doc)": nothing injects `docs/subsystems/jira.md`. Only
  `.claude/rules/jira.md` loads. Putting the pointer in the doc is still right, because a bullet in the rule file would be a second home for tracker's anchor,
  which `test/claude-rules.test.ts` refuses. Only the parenthetical is wrong.
- **m11 — plan:617-618** — "(phase 4 widens it to name `jira.mjs`, spec §12)" sits between rule 2's bold headline and "— mechanism:". Mark it as a plan note
  so it is not copied into the bullet.
- **m12 — plan:659-661, 671-673** — the self-review's coverage line and the Decisions list leave out three deviations: the deferred `skills/jira/**` glob
  (spec §13, spec:384), the phase-1 rule-2 headline, and the `AbortSignal.timeout` swap (spec:67).
- **m13 — plan:72-73** — Review Focus 2 still ends "— Task 6", while the self-review (plan:670) now says T6 and T8.
- **m14 — plan:302-303, 521** — `ADF_PLACEHOLDER_RE` matches "at a line start". A placeholder inside a list item or blockquote (`- [table omitted]`,
  `> [panel omitted]`) does not start its line, so the block drops the "something was omitted" line for it. Allow a list or quote prefix, or carry the count
  `adfToMarkdown` already returns.
- **m15 — plan:558-559** — `b_zz` and `b_ffffffff` both answer 404. Unless their bodies differ, the test cannot show that the id check ran "before any lookup".
- **m16 — plan:129-130, 160, 201, 257, 447** — reflow orphans, two of them in edited text (201 `agree.`, 257). The prose lines are all within 160 characters.
  The only longer lines are the file-structure table (85-102), which is exempt.

---

## Round 1 → this round

| round 1 | status | note |
| --- | --- | --- |
| C1 rule glob | resolved | Task 9 Step 4. Self-review not updated (m12) |
| I1 branch base | resolved | |
| I2 `{ error }` | partly | Task 3's test line missed (I1) |
| I3 rate-limit constant home | resolved | |
| I4 timeout | resolved | m1, m2 residue |
| I5 `access` per row, route state | partly | per-row body unstated (I1); requested case missing (I3); new boot hole (I2) |
| I6 FakeJira hooks | resolved | m3 |
| I7 token value | resolved | |
| I8 `truncated` | resolved | matches spec:84 and spec:215 |
| I9 unreachable boot | stated, not reconciled | I6 |
| I10 whole-board vs per-entry | resolved | m8 |
| I11 `off` cold-sweep retry | resolved | |
| I12 done root | resolved | |
| I13 `armed` after init | resolved | |
| I14 rule 2 headline | resolved | m11 |
| M1, M2, M5–M9, M12, M15, M17, M18, M20–M25 | resolved | facts checked: compose `server` (`docker-compose.yml:37`), `GITHUB_TOKEN_ENV` (`test/compose-env.test.ts:5,108`), repo-root links (73 of 73), `readRaw`/`writeSyncInterval` (`sync-config.util.ts:49,115`), `TZ` (`global-setup.ts:48`), Nest `^11.2.1` |
| M3 docs-sync stamp | changed, claim false | I7 |
| M4 widenings | resolved | every line named exists (overview :68, :72, :73; api :3-7, :96, :138; invariants :2929, :3053); m9 |
| M10 board ids | resolved | m15 |
| M11 placeholder home | resolved | m14 |
| M13 `Date.now` | resolved | m6 |
| M14 reflow | partly | m16 |
| M16 Review Focus 2 route case | added, unwritable | I4 |
| M19 cache-age pointer | changed | m10 |

## Checklist, changed sections only

1. **Coverage.** No spec requirement or round-1 test case was dropped. One requested case was never added (I3), and one added case cannot run (I4).
2. **Values.** Checked and correct: `{ error }` (120 `{ error: ` sites in `server/src`, and `client/src/lib/agents.ts` `unwrap` reads `data.error`), the
   `truncated` semantics, `JIRA_RATE_LIMIT_DEFAULT_MS = 60_000`, `'timed out after 10000 ms'`, the token `t0k3n-SECRET`, the `[1, 2]` → `unreadable: null`
   ruling, and P11's `nextPage` deviation. One value is stale: line 279's `{ message, access }` (I1).
3. **Reality.** Every Modify target and named line exists. Two stated facts are false: the docs-sync adoption (I7) and github.ts's "rule table" (m3).
4. **Interfaces.** These are produced before they are consumed, and spelled the same: `JIRA_RATE_LIMIT_DEFAULT_MS` (T3 → T6), `ADF_PLACEHOLDER_RE`
   (T4 → T7), `jiraEnv` (T1 → T8), `JIRA_ENV` (T1 → T9). The return type of `accessOf` widened to `| null`, and the boot consumer was not updated (I2).
5. **Order.** No forward dependency remains.
6. **Tests.** Two of the new Task 8 cases fail as listed because of the shared app (I4, I5). The new Task 6 cases (boards waiting for boot, whole-board versus
   per-entry, the done root, the `off` retry) can be written with the extended fake and pin behaviour.
7. **Conventions.** No literal code. The edited prose is within 160 characters. Orphans remain (m16).
