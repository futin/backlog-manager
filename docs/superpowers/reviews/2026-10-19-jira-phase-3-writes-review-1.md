# Review 1 — `docs/superpowers/plans/2026-10-19-jira-phase-3-writes.md`

Reviewed against `docs/superpowers/specs/2026-10-15-jira-integration-design.md` (§5, §6.1, §6.3, §8, §11, §12, §13) and the code at `main` (901fb5c).
Every claim about the code below was checked by reading it; `file:line` cites are to this checkout.

## Verdict: APPROVE WITH FIXES

No Critical finding. The architecture, the rulings R1–R8, the error table and the interface chain all hold against the code. The Important findings are
test values and mechanism statements an implementer following the plan literally would get wrong — each is a one-line edit to the plan.

---

## Important

### I1 — Task 4 Step 3's `rev`-in-`useFetched`-deps mechanism contradicts R8 and the R8 test

- Plan: line 223 ("The re-read is a `rev` counter in `useFetched`'s deps"), against R8 at lines 68–69 and the test at line 220 ("the description stays on
  screen while the re-read is held unresolved (no `loading…`)").
- Code: `client/src/hooks/useFetched.ts:39–41` bumps `gen` when any dep changes, and `:73` returns `PENDING` while `held.gen !== gen`. In the modal,
  `mine === null` → `detail === null` (`client/src/components/jira/JiraIssueModal.tsx:106`), and the body branch at `:155` draws `loading…`; the plan's
  "Move disabled while the detail has not landed" (line 202) would also fire. So bumping `rev` alone produces exactly the flash R8 forbids.
- Fix: say that the modal keeps the last LANDED detail for the current key in its own state (a `useState`/`useRef` stamped with `issue.key`, cleared when the
  key changes) and draws that while `useFetched` is pending for the same key; `rev` in the deps is fine as the trigger, but the retained copy is the mechanism.

### I2 — The "identity unknown" cases must fail `myself` with a status other than 401, or they get the wrong body

- Plan: line 133 ("Identity unknown (`fake.me` made to fail `myself` before boot, as the file's identity cases do) → `refusal: 'no identity'`") and line 177
  ("Identity not yet known (boot's `myself` failing) → assign 503 `{ error: 'no identity' }`").
- Code: R2 (lines 50–51) says the body is `jiraHttpError`'s 401 body whenever `access === 'unauthorized'`. The poller suite's first identity case is
  "myself 401: unauthorized" (`test/jira-poller.test.ts:297`), and `JiraBootState.fail('unauthorized', …)` is what a 401 on `myself` records
  (`server/src/jira/identity.ts:66–67`). An implementer copying that case gets `Jira rejected the credentials`, not `no identity`, and the test at 133/177 is
  then wrong rather than the code. There is also no `fake.me` failure switch — the file's identity cases use `failNext`/`failWith` against the `myself` URL
  (`test/jira-poller.test.ts:101, 297–311`).
- Fix: name the status — `myself` answering 403 (`forbidden`) or 500 (`unreachable`), as `test/jira-poller.test.ts:304` and `:311` do — and drop "`fake.me`".

### I3 — Review Focus 4's route test must hold the 401 with `fake.unauthorized`, not a one-shot `failNext`

- Plan: lines 174–176 ("401 on the PUT → 503 …; a following assign and a following transition are both 503 and the fake records no further write").
- Code: `routeFailed` on a 401 calls `boot.reset()` and then `wake()` (`server/src/jira/poller.service.ts:859–863`), which schedules a tick
  (`:484–486`) that re-asks `myself`. If only the PUT was made to 401 (a `failNext` on that one call), that tick's `myself` answers 200 and restores `me`, so
  the "following assign is 503" assertion races the tick. With `fake.unauthorized = true` every authenticated gateway call 401s
  (`test/helpers/jira.ts:191`), the boot cannot recover, and the assertion is deterministic. The poller suite's own 401 case does it that way
  (`test/jira-poller.test.ts:444–465`).
- Fix: state "`fake.unauthorized = true` before the PUT" at line 174, and note that the recorded `myself` retry is expected and is not a write.

### I4 — The modal test values name fixtures the suite the plan reuses does not have

- Plan: lines 209–210 (`{"key":"PAY-1"}`, `/api/jira/issue/PAY-1`), 211 (`assignee acc-1` with `me.accountId acc-1`), 213 (`{"key":"PAY-1", …}`), 219
  ("no re-read of `PAY-1`"), while line 208 tells the implementer to use `jira-modal.test.tsx`'s "existing fetch stub and `JiraContext` provider value".
- Code: that suite's card is `PAY-131` (`test/jira-modal.test.tsx:28`) and its identity is `ADA = { accountId: 'acc-ada', … }` (`:25`), used as BOTH
  `CARD.assignee` (`:37`) and `status().me` (`:68`) — so the default fixture is already "assigned to you", and every "Assign enabled" case needs an issue
  whose assignee is someone else or `null`.
- Fix: write the values as the fixture has them (`PAY-131`, `acc-ada`), or say "the fixture's key / `me`"; and say which cases mount `issue` with another
  assignee so Assign is enabled (the happy path at 209, Review Focus 1 and 2, the 409 case).

### I5 — `Select` has no `title` prop, and Task 4's file list does not include the primitive

- Plan: lines 202 ("disabled … title `transitions unavailable`") and 214, against the Files list at 188–191.
- Code: `client/src/components/ui/Select.tsx:15–38` accepts `value, options, onChange, disabled, label` and spreads nothing else onto the `<select>`.
  `Chip` does take `title` and `disabled` (`client/src/components/ui/Chip.tsx:39–40`), so Assign is fine; Move is not.
- Fix: either add `client/src/components/ui/Select.tsx` to Task 4's Files (a `title?: string` passed to the element) or move the title onto a wrapper and say so.
  Either way the test at 214 should say where the title is read from.

### I6 — Task 2 Step 3's "a non-2xx write goes through `routeFailed` → `splice`" reads as a pipeline

- Plan: line 146.
- Spec: §8 line 292–293 — the re-read is "after either" write, i.e. after a write that landed; R1 (lines 46–49) is also written for a landed write.
- Fix: "a non-2xx write returns `routeFailed(res)` and splices nothing; a 2xx proceeds to `splice`". One clause, but it is the branch the whole task hinges on.

### I7 — Whether `transitionIssue` is refused on every `me === null`, or only under `unauthorized`, is left open

- Plan: R2 lines 50–53 ("`this.boot.me === null` → 503 … Transition does not need the identity but is refused the same way under `unauthorized`"), Task 2
  Step 3 line 144 ("R2's `unauthorized` and `me` checks"), and the tests at 133 and 177 cover assign only.
- Spec: §8 line 291 ties `no identity` to the ASSIGN route alone; line 304–305 ties the 503-for-every-issue-write to `unauthorized`. Under a boot whose `myself`
  answered 403 or 500 (`me === null`, `access` `forbidden`/`unreachable`, `cloudId` set), the spec lets a transition through and the plan is ambiguous.
- Fix: one sentence in R2 — "transition is refused only while `access === 'unauthorized'`; a `me === null` for any other reason refuses assign alone" — and
  one Task 2 case: `myself` 403 at boot, `transitionIssue('PAY-1','31')` → `reread: true`.

---

## Minor

- **M1** Plan:97 — a 204 through `request` is `{ status: 204, data: null, message: null, retryAfter: null }` (`server/src/jira/jira.client.ts:159–205`); the
  expected object omits `retryAfter`. Add it or say `toMatchObject`.
- **M2** Plan:102–107 — the fake's `issuePath` regex is `/^\/issue\/([^/]+)(\/transitions)?$/` (`test/helpers/jira.ts:227`), so `/assignee` needs a new
  branch, not just a method check. Worth one word ("extend the issue-path match").
- **M3** Plan:164 — "the guard's own refusal status" is 403 (`server/src/agents/origin.guard.ts:77`), and the case to copy is "no content type is 403"
  (`test/jira-write-routes.test.ts:91–92`). Name the number.
- **M4** Plan:165 — say the body is otherwise valid in the unconfigured case; the handler order validate → configured (line 180,
  `server/src/jira/jira-write.controller.ts`) means a `{}` body answers 400 before the 503.
- **M5** Plan:182 — hoisting `unwrap` into `errors.util.ts` needs `JiraResult` from `poller.service.ts`, which imports `errors.util.ts`
  (`server/src/jira/poller.service.ts:21`). An `import type` is erased, so no runtime cycle, but say so, and keep `JiraResult` exported.
- **M6** Plan:212 — `JiraTransition.to` is `{ name, category }` (`shared/types.ts`, the `JiraTransition` interface); the fixture `to:{name:'In Progress'}` does
  not typecheck in a strict `.tsx` suite. Add `category`.
- **M7** Plan:196 — `useJiraBoard`'s new third parameter is required; `test/use-jira.test.tsx:290`'s `BoardProbe` and `JiraBoardView.tsx:93` are its only
  callers, both touched by Task 4, so this is fine — but a `= 0` default would keep the probe's existing cases untouched. Taste.
- **M8** Plan:199 — "DESIGN.md §8.9.2, written in Task 5": the subsection exists today (`.claude/DESIGN.md:453`), so the component's header can cite it from
  Task 4; only its text changes in Task 5. Reword to "updated in Task 5".
- **M9** Plan:230–231 — `docs/subsystems/api.md` does not list the write routes, but `:134–138` describes the module as "Six read routes under `/api/jira`"
  and already omits phase 2's three writes. The hedge "(if it lists …)" will make a reader skip it; say "update `api.md`'s `jira/` paragraph to name the
  five writes".
- **M10** Plan:240 — "the same sentence wherever `invariants.md` and `api.md` state it": neither file carries "one thing this server writes" (grep across
  `docs/`); `invariants.md:3210` carries the already-widened outbound-modules sentence. Harmless, but the premise is false — drop the clause or point at
  `invariants.md:3210` if that is the sentence meant.
- **M11** Plan:239 — CLAUDE.md:106–108 is an UNLINKED bullet (no `Why:`), currently 60 words against `UNLINKED_WORD_CAP = 80`
  (`test/claude-rules.test.ts:44`). The widening fits, but say "stay under the 80-word cap" so a longer phrasing does not go red in `claude-rules`.
- **M12** Plan:246 — `test/dialog-count-docs.test.ts` asserts the Escape-stack dialog count (`:41–60`); nothing in this phase adds a dialog. Running it is
  harmless; listing it suggests a dependency that is not there.
- **M13** Plan:169 vs spec §11 line 352 — the spec files "transition not offered → 400" under `jira-routes`; the plan puts it in the new
  `jira-issue-writes.test.ts`. Reasonable (the write suites are built the same way), but note the deviation in the self-review.
- **M14** Plan:54 / 166 — the 65-character refusal is tested; a 64-character acceptance is not. One `toBe(200)` would pin the boundary. Taste.

---

## Checklist

1. **Coverage** — §5 both issue-write rows → Task 3 (160–161); §6.1 "reloads both the board and `GET /api/jira`" → R7 (65–67) and Task 4 (205); §6.3
   controls and inline error → Task 4 (199–205), `Run ▾`/`Stop session`/`session` fact correctly excluded as phase 5 (252); §8 assign/transition/splice/
   newest-wins → Tasks 1–2, error table → Global 37–38 and Task 3 (170–173); §11 `jira-poller` and route cases → Tasks 2–3 (M13); §12 phase 3 → whole
   plan; §13 headline (spec:392) verbatim at 234–235, item-write widening (spec:404–405) at 239–240. No spec section without a task.
2. **Values** — error table matches `server/src/jira/errors.util.ts:57–80` exactly; `invalid issue key` matches `server/src/jira/jira.controller.ts`'s
   message; `Jira is not configured` matches `jira-write.controller.ts:76–78`; gateway URL with `c1` matches `test/helpers/jira.ts:102`; `acc-1` /
   `Ada Lovelace` match `:103`. Wrong or incomplete: I4, M1, M6.
3. **Reality** — every Modify path exists; `test/jira-issue-writes.test.ts` does not (Create ✓); `jira.client.ts:135` carries "read only in phase 1";
   `JiraIssueModal.tsx:21` carries "Phase 2 has no controls"; `DESIGN.md:463`, `jira.md:8/41/211`, `CLAUDE.md:42/107` carry the strings Task 5 names;
   `boot.reset()` sets only `me` (`identity.ts:87–89`), so R2's `cloudId` claim is true; `sweepBoard`'s `caches.set` at `poller.service.ts:754`;
   `sweepFields()`, `windowRefusal()`, `routeFailed`, `boardSaved`, `boardsHolding` all exist as described. False/incomplete: I5 (`Select` `title`), M10.
4. **Interfaces** — Task 1 methods → Task 2 ✓; `JiraIssueWriteResult`/`JiraIssueWriteOutcome` → Task 3 ✓; `JiraIssueWriteResult`, `data.me`, `reload`
   (`client/src/hooks/useJira.ts:35–40`) → Task 4 ✓; `onWrote`, `nudge` produced and consumed inside Task 4 ✓.
5. **Order** — no task consumes a later task's product; Task 5 last. M8 is a wording issue, not a real forward dependency.
6. **Tests** — every case would fail before implementation (methods undefined, routes 404, controls absent). Review Focus 1–5 each has a named test (73–78,
   137–141, 174–178, 217–220). Behaviour-pinning throughout; the one place a mechanism is prescribed (223) is wrong — I1.
7. **Conventions** — no literal code anywhere; names fixed only in Interfaces; soft budgets; commit per task; PR title passes `ci / pr-title`;
   `pnpm run test:jest -- <file>` only. ✓
