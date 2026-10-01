# Review 1 — `docs/superpowers/plans/2026-10-01-tracker-created-timestamp.md`

Reviewer: Fable 5.1, fresh session, 2026-10-01. Spec: none (plan reviewed against the code). Every claim below was checked against the working tree at
`cf7cb7c`, the live stack on `:4322`, and `gh issue view` on claude-agents-dashboard.

## Verdict: APPROVE WITH FIXES

Two Important findings, both in the plan's periphery (Task 4's test set and Task 5's live check); the four code-changing tasks are correct as written.

## Important

- **[I] plan:141 — the live check names `#170`, which is a `done` item, so under the board's default status filter it is not in the Ideas column at all.**
  `curl localhost:4322/api/items` returns `claude-agents-dashboard #170 ideas done`, and `gh issue view 170` says `CLOSED` (created `2026-10-01T21:39:13Z`).
  The Board's status filter defaults to `open` (`client/src/components/board/BoardView.tsx:265`), so the check "Ideas column shows #170 above #169, #165
  and #164" fails on a fresh browser even when the fix is correct. → Re-word the check to the three open issues (`#169` above `#165` above `#164`, created
  21:19 / 08:46 / 08:41Z), or state that the status filter must be switched to `All` first.
- **[I] plan:118-125 — Task 4 states "a timestamp is aged by its UTC calendar day", but no test pins a non-`Z` offset, so `created.slice(0, 10)` passes every
  listed case while violating Global Constraint line 27.** The two new cases (line 123-124) both use UTC stamps, and the behaviour text's one worked example
  (23:59Z yesterday → 1) is also `Z`. Review Focus 1 (line 33) argues exactly this trap for the formatter — "must not split on `T` and trust the left half" —
  and pins it in Task 1, but Task 4 leaves the same door open for `ageDaysSince` (`skills/backlog/tools/backlog.mjs:2088`). → Add one case: a stamp at
  `<day N>T23:30:00-02:00` ages as UTC day N+1 (e.g. 7 days ago at 23:30-02:00 → `ageDays === 6`), or state explicitly that the CLI accepts `Z` only and why
  that differs from the client.

## Minor

- plan:10 — the example stamp `2026-10-01T21:43:23Z` matches no issue the plan later names (`#170` is `21:39:13Z`, `#169` is `21:19:32Z`). Harmless as an
  illustration; if it is meant to be the live value, correct it.
- plan:101 — "Tasks 1, 2 and 4 consume it" names tasks that run BEFORE Task 3. The order is right (readers accept the new shape before the producer emits
  it, so no intermediate commit breaks the board); say that rather than "consume", which reads as a dependency inversion.
- plan:131-137 — Task 5 misses two other sentences that say `created` is a date: `test/helpers/dates.ts:14-15` and `:26` ("`created` is a date (the
  `YYYY-MM-DD` `backlog.mjs` writes…)", "the shape `created` carries") — the helper Task 2 tells the implementer to use — and the design spec's field table
  `docs/superpowers/specs/2026-09-17-tracker-backed-backlog-design.md:193` ("`created_at`, date part"). The spec is a historical record and may be left with a
  dated amendment; the helper comment should be qualified. (`skills/backlog-groom/SKILL.md:363` is files-only context and is fine.)
- plan:37 — Review Focus 3 names only `--json`'s `null`; the text board prints `NaNd` for the same input today (`backlog.mjs:2417`, `:2431` build
  `${item.ageDays}d`). Worth one clause so the Task 4 test author knows both outputs are affected.
- plan:124 — "a stamp from earlier today" leaves the implementer to pick an offset; "now minus one hour" crosses UTC midnight once a day. Specify the current
  instant, or today's date at `T00:00:00Z`, so the case cannot flake.
- plan:84, 87 — the "reported bug" case does not reproduce the reported bug: the fixture hands the board timestamps directly, bypassing the mapper that
  truncates them, so it is green before any change (the plan says so at line 87). The red for the real defect is Task 3's test. Fine as a regression pin;
  consider saying "pins the fixed state" rather than "the reported bug".
- plan:136 — `docs/subsystems/board.md:79` already says "the created / updated / last-commit stamps", and `.claude/rules/tracker.md` has no sentence about
  `created`'s shape, so both checks will find nothing. No action; noted so the implementer does not hunt.

## Checklist

1. **Coverage.** Goal → Task 3 (producer) + Task 2 (sort pin). Global Constraints: tracker-only (Task 3 touches only `map-issue.ts`; `backlog.mjs new` at
   `:2334` untouched), derived readings keep their values (Task 1 and Task 4 tests assert `oct 1` / `ageDays` unchanged), UTC calendar readings (Task 1 pins
   it; Task 4 does not — Important above), 160-col prose and comment density (stated), plugin:sync (Task 5 step 4). Review Focus 1 → Task 1 case 3 ✓;
   2 → Task 2 case 2 ✓; 3 → Task 4 case 1 ✓; 4 → Task 1 case 4 ✓ (and `''`, `'whenever'`, `'2026-13-45'` stay green: `2026-13-45` matches `DATE_ONLY` and
   goes down today's path → NaN → verbatim); 5 → Task 2 case 3 ✓ (`BoardView.tsx:98` secondary key is the same comparison; option value `project` exists at
   `:727`).
2. **Values (recomputed in node).** `'2026-10-01T23:30:00-02:00'` → `2026-10-02T01:30:00Z` → `oct 2` ✓. `Date.parse('2026-10-01T25:00:00Z')` → `NaN` →
   verbatim ✓. `'…T08:00:00Z'.localeCompare('…T21:00:00Z')` = -1 and `'…T08:00:00Z'.localeCompare('2026-10-01')` = 1, so under
   `created: (a, b) => b.created.localeCompare(a.created)` (`BoardView.tsx:99`) #170 sorts above #164 and a timestamp sorts above the bare date ✓.
   `ageDaysSince('<stamp>')` today: `Date.parse('<stamp>T00:00:00Z')` → NaN → `JSON.stringify` → `null` ✓ (plan:37). A UTC stamp exactly 7 days ago → 7 ✓.
   Tracker-map fixture values `2026-09-01T10:11:12Z` / `2026-09-01T23:59:59Z` match `test/tracker-map.test.ts:36` and `:220` ✓.
3. **Reality.** Every cited path and line exists: `map-issue.ts:196` (`created: issue.created_at.slice(0, 10)`, the only `slice(0, 10)` in `server/src`),
   `shared/types.ts:70`, `item-age.ts:107` (`formatCreated`) and `:39` (`DATE_ONLY`), `BoardView.tsx:85-99`, `test/item-age.test.ts:117`,
   `test/board.test.tsx:227` and `:638`, `test/helpers/dates.ts` (`daysAgoDate`/`daysAgoStamp`), `test/fixture-clock.test.ts` (regex at `:70` — a template
   literal `\`${day}T08:00:00Z\`` passes it), `test/tracker-map.test.ts:50` and `:219`, `backlog.mjs:2088`, `backlog.test.mjs:449`, `:461`, `:3972`,
   `withApi`/`trackerFixture`/`apiItem` at `:3712`/`:3724`/`:3736`, `invariants.md:1032`, `board.md:79`. No new files are created. `jest.config.ts` exists, so
   `pnpm exec jest --runInBand <file>` and `pnpm run test:jest -- <file>` both resolve.
4. **Interfaces.** Only one cross-task contract (Task 3's `created` shape); see the Minor note on "consume". Signature of `formatCreated` unchanged ✓.
5. **Order.** Readers (1, 2) before the producer (3) before the CLI reader (4) before docs (5). The CLI is not live until plugin:sync, so the Task 3→4 window
   is harmless. No external prerequisites.
6. **Tests.** Task 1, 3, 4 tests are red before their step 3 (verified by recomputation above). Task 2's are green before any change, by design and stated.
   Task 4's set under-pins its own stated rule (Important). Task 3 step 4's hunt for other date-only `created` asserts will find none: `grep "'2026-09-01'"
   test/` hits only `tracker-map.test.ts:50,221` and unrelated `item-age`/`run-stats`/`item-month` cases.
7. **Conventions.** No literal code anywhere in the plan ✓; the override is stated at the top ✓.

## Other readers checked and out of scope, correctly

`lastTouched`'s third rung (`client/src/lib/item-touched.ts:29`) is consumed by `item-stale.ts:63-65` and `item-month.ts:49`, both of which already branch
on `DATE_ONLY` and `Date.parse` the rest — they accept a timestamp today. A tracker item also always has `updated` (`map-issue.ts:200`), so the `created`
rung is never reached for one. `ItemModal.tsx:350` renders `item.created` raw (plan:25-26, 142 ✓). `import-lib.mjs:151-163` sorts files items by string
`created` and only ever sees files frontmatter. `orchestrate.mjs` does not read `created`. `.claude/rules/` files scoped to the touched paths (`board.md`
→ `client/src/**`, `tracker.md` → `server/src/tracker/**`, `skills.md` → `skills/**`, `tests.md` → `test/**`) carry no bullet the plan contradicts; the
fixture-date rule in `tests.md:22-29` is followed at plan:80-81.
