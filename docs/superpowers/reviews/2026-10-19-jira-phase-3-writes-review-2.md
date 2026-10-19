# Review 2 — `docs/superpowers/plans/2026-10-19-jira-phase-3-writes.md`

A narrow re-check after review 1 (`2026-10-19-jira-phase-3-writes-review-1.md`): for each of I1–I7 and M1, M3, M5, M6, M9, M10, (a) did the fix land, and
(b) did the edited text introduce a new problem. The rest of the plan was not re-reviewed. Every code claim below was checked against the checkout at
`main` (901fb5c); `file:line` cites are to it. Plan line numbers are to the untracked file as it stands today (265 lines).

## Verdict: APPROVE

All seven Important findings landed as written, with the values the code has, and none of the edits introduced a new Critical or Important problem.
Two of the Minor fixes are not quite complete (M5, M9 below); neither blocks.

---

## Important findings from review 1

### I1 — R8 mechanism (plan:68–69, 228, 230–233) — LANDED

- The plan now says a `rev` counter in `useFetched`'s deps only TRIGGERS the re-read, that `useFetched` answers `PENDING` on any dep change, and that the
  modal keeps the last landed detail for the same key in its own state and draws that while the re-read is pending (plan:231–233).
- Code: the cite `client/src/hooks/useFetched.ts:73` is exact — `if (held === null || held.gen !== gen) return PENDING;`. The test at plan:228 ("the
  description stays on screen while the re-read is held unresolved (no `loading…`)") now pins the behaviour the mechanism produces.
- No new problem.

### I2 — identity-unknown cases must not use a 401 on `myself` (plan:133–135, 182) — LANDED

- Task 2 now names "the gateway `myself` answering 403 at boot, as the file's `myself 403: forbidden` case does — NOT a 401" and Task 3 says "boot's
  gateway `myself` answering 403, not 401". The `fake.me` phrasing is gone.
- Code: the case name is exact (`test/jira-poller.test.ts:304`, `fake.failNext = (c) => (isGatewayMyself(c.url) ? { status: 403, … } : null)`). A 403 on
  `myself` goes through `bootFail(accessOf(res), …)` → `JiraBootState.fail('forbidden', …)` (`server/src/jira/identity.ts:66–71`), leaving `me === null`,
  `access === 'forbidden'`. The boot asks `tenantInfo` first (`server/src/jira/poller.service.ts:598`) and `myself` third (`:633`), so `cloudId` is already
  set when `myself` fails, and `gate()` (`:834–845`) refuses only on `unsupported` or `cloudId === null` — so R2's `no identity` branch is the one reached,
  and the `transitionIssue` half of the case (plan:134–135) does get through the gate as the plan says. `sweepFields()` tolerates the never-asked sprint
  field (`:811–813`), so the splice's re-read works in that state too.
- No new problem.

### I3 — Review Focus 4 route test must hold the 401 (plan:177–181) — LANDED

- The plan now says `fake.unauthorized = true` (persistent, not a one-shot `failNext`), explains why (`routeFailed` calls `wake()`; a recovered `myself`
  would restore `me`), expects the recorded `myself` retry, and adds that a board save in the same state is still 200.
- Code: `fake.unauthorized` 401s every authenticated gateway call (`test/helpers/jira.ts:191`); `routeFailed` on 401 does `boot.reset()`, `fail('unauthorized')`
  once per streak, then `wake()` (`server/src/jira/poller.service.ts:859–864`, `:484–486`). Assign sends no Jira call before the PUT (gate → R2 → window →
  PUT), so "the PUT answers 401" is accurate. `POST /api/jira/boards` checks only `requireConfigured()` (`server/src/jira/jira-write.controller.ts:44, 76–78`),
  so it stays 200 under `unauthorized` even though `boardSaved` (`:46`) sweeps and that sweep 401s.
- No new problem.

### I4 — modal test values vs. the reused fixture (plan:215–227) — LANDED

- Values are now `PAY-131`, `ADA` / `acc-ada`, `/api/jira/issue/PAY-131`, `{"key":"PAY-131"}`, `{"key":"PAY-131","transitionId":"41"}`, and the plan
  says every case that clicks Assign mounts `{ ...CARD, assignee: null }` or another person.
- Code: `ADA = { accountId: 'acc-ada', … }` (`test/jira-modal.test.tsx:25`), `CARD.key = 'PAY-131'` (`:28`), `assignee: ADA` (`:37`), `status()`'s
  `me: ADA` (`:68`) and `status(over: Partial<JiraStatusPayload>)` accepts `{ me: null }` (`:64`); `mount` takes `status` and `issue` options (`:96–101`);
  the modal fetches `/api/jira/issue/${encodeURIComponent(issue.key)}` (`client/src/components/jira/JiraIssueModal.tsx:98`); `failureOf` is that file's own
  function (`:62–71`) and its rule (`{ error }`, else `HTTP <status>`) is what plan:210–211 states. The Children-row swap case the plan reuses exists
  (`test/jira-modal.test.tsx:185–234`). The option labels at plan:220 follow the plan's own rule (`Start → In Progress` differ, `Done` does not).
- No new problem.

### I5 — `Select` has no `title` (plan:196, 222) — LANDED

- `client/src/components/ui/Select.tsx` is in Task 4's Files with "an optional `title?: string` prop on the `<select>` — the primitive has none today".
- Code: `Select` takes `value, options, onChange, disabled, label` and spreads nothing (`client/src/components/ui/Select.tsx:15–38`). The test at plan:222
  reads the title from the control itself, which is where the new prop puts it.
- No new problem.

### I6 — non-2xx write pipeline wording (plan:148–149) — LANDED

- Now: "A non-2xx write returns `routeFailed(res)` and splices nothing; a 2xx proceeds to `splice`." Matches spec §8 (re-read "after either" write that landed)
  and R1.

### I7 — transition refusal scope (plan:51–53, 133–135) — LANDED

- R2 now says transition is refused ONLY while `access === 'unauthorized'`, never for `me === null` alone, quoting spec §8 ("every ISSUE write … a 503 until
  the next successful `myself`" — spec:304–305, paraphrased faithfully), and Task 2 has the case: `myself` 403 at boot, `transitionIssue('PAY-1','31')` →
  `{ ok: true, value: { ok: true, reread: true } }`.
- Code: see I2 — the gate passes, the identity is not needed, the case is deterministic because the `failNext` hook persists across the boot retry.
- No new problem.

---

## Minor findings from review 1

### M1 (plan:97) — LANDED

`{ status: 204, data: null, message: null, retryAfter: null }`: `request` returns `retryAfter: got.retryAfter` on 2xx (`server/src/jira/jira.client.ts:203`),
and `numberHeader(null)` is `null` (`:239–240`); an empty body parses to `data: null`. Exact.

### M3 (plan:167) — LANDED

"another origin → 403; no content type → 403" — the guard throws 403 for both (`server/src/agents/origin.guard.ts:77`), and the cases to copy are at
`test/jira-write-routes.test.ts:91–99`.

### M5 (plan:186–188) — LANDED, with one inaccuracy and one open choice (Minor)

- The plan now keeps `unwrap` out of `errors.util.ts` and says why: "it would need `JiraResult` from `poller.service.ts`, which imports `errors.util.ts`, an
  import cycle". Review 1's point was the opposite nuance: a type-only import (`import type { JiraResult }`) is erased at compile time, so there would be no
  RUNTIME cycle — only a type-level one, which TypeScript resolves. The decision (share the function somewhere other than `errors.util.ts`) is sound and
  harmless; the stated reason overstates it. `JiraResult` is exported (`server/src/jira/poller.service.ts:136`) either way.
- "share one function between both controllers" names no home. The implementer must pick one (a small `unwrap.util.ts` beside the controllers, or an export
  from `jira.controller.ts`). Low stakes; noting it so the choice is deliberate.

### M6 (plan:220) — LANDED

`to:{name:'In Progress',category:'indeterminate'}` typechecks against `JiraTransition.to: { name: string; category: JiraStatusCategory }`
(`shared/types.ts:621–625`). Task 2's fixture at plan:130 correctly uses the FAKE's raw shape instead (`to: { name, statusCategory: { key } }`,
`test/helpers/jira.ts:40–44`) — the two shapes are different on purpose and the plan keeps them apart.

### M9 (plan:240–241, 250–251) — LANDED, with one sentence left over (Minor)

- The hedge is gone; Task 5 now says `api.md`'s jira paragraph "counts only the read routes" and must name "the two issue-write routes beside its read routes".
- `docs/subsystems/api.md:134–138` says "Six read routes under `/api/jira` … and no write route yet". That last clause is already false (phase 2's three
  config writes), and the plan's instruction names only the TWO issue writes. An implementer following it literally could leave "no write route yet" in
  place or omit the three config routes. Suggest: "rewrite the paragraph's route sentence to name all five writes — the three `jira.json` routes and the two
  issue routes — and drop 'no write route yet'".

### M10 (plan:249–252) — LANDED

The false "wherever `invariants.md` and `api.md` state it" clause is gone. The remaining targets are real: CLAUDE.md:107 carries "the one thing this server
writes" (an unlinked bullet; plan:250 names the `UNLINKED_WORD_CAP`, which is 80 at `test/claude-rules.test.ts:44`) and CLAUDE.md:42 carries "`jira.json`'s
three guarded write routes".

---

## Carried over, unchanged, outside this re-check's scope

- M8 (plan:206 "DESIGN.md §8.9.2, written in Task 5") — the subsection exists today (`.claude/DESIGN.md:453`); only its text changes in Task 5. Wording only.

## Checklist for the edited text

1. **Values** — every value in the edited lines matches the code: `PAY-131`/`acc-ada`/`ADA`, `myself 403: forbidden`, 403 for the guard, the 204 shape,
   `JiraTransition.to.category`, `useFetched.ts:73`, `fake.unauthorized`. ✓
2. **Reality** — `Select.tsx`, `useFetched.ts`, `origin.guard.ts`, `jira-write.controller.ts`, `test/helpers/jira.ts`, `test/jira-modal.test.tsx`,
   `test/jira-poller.test.ts`, `docs/subsystems/api.md`, CLAUDE.md:42/107 all exist and carry the strings named. ✓
3. **Interfaces** — `JiraIssueWriteOutcome`'s `refusal` union, the synthesised-401 `JiraResult` failure under `unauthorized`, and the controller's mapping
   (plan:120–123, 185–186) agree across Tasks 2 and 3; `nudge`/`onWrote`/`title` agree inside Task 4. ✓
4. **Tests** — the rewritten cases are deterministic (persistent `fake.unauthorized`, persistent `failNext` hook on `myself`) and would fail before the
   implementation (methods/routes/controls absent). ✓
5. **Conventions** — no literal code entered with the edits; the one mechanism statement (plan:231–233) is a constraint the test at plan:228 pins, not code. ✓
