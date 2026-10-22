# Review 1 — `docs/superpowers/plans/2026-10-22-backlog-tick.md`

Reviewed against `docs/superpowers/specs/2026-10-22-backlog-tick-design.md`, `CLAUDE.md`, `.claude/rules/{items,tracker,skills,orchestrator,tests,dispatch-watchdog}.md`
and the code every task names. Every line reference in the plan's **Files:** blocks was opened and checked; all of them point where they say, with the exceptions
listed below. Date: 2026-10-22. Reviewer: a fresh Fable session with only the paths and the checklist.

**Verdict: REVISE** — two Critical findings (a wrong branch name the plan's own test would pin, and a `record` that cannot reproduce `decide`'s hash under
`--base`), four Important.

## Checklist summary

1. **Coverage** — every spec section maps to a task: trigger/defaults → Global Constraints + Task 8; steps 0–6 → Tasks 7–9; killed tick → Task 8 recover;
   tick marker → Task 6; `plan-review` mark → Tasks 1–5; failure record → Task 7; invariants/counts → Task 10; "Left to the builder" — each has a stated
   answer (twins not shell-out, line 39–41; verb name, Task 3; marker placement, Task 6; `failed` ends ordinary + no `blocked`, Task 9). No spec section
   is without a task. Count sites the spec lists (spec:209–212) are all in Task 10 except two the spec did not list (M1).
2. **Values** — every string the spec fixes matches: `[backlog-tick]`, `plan-review`, `plan-review: true`, `Assumptions (unattended)`, `cannot count open
   PRs`, `killed at timeout`, `busy: another tick`, `remote run`, `stack down`, `not a main checkout`, M=2, N=3, 3 h, `gh pr list --state open --limit 500
   --json headRefName`. Strings the spec leaves open (verb output lines, verdict JSON) are the builder's and are stated exactly.
3. **Reality** — all Modify paths and line ranges exist and hold what the plan says (`labels.ts:67-88`, `map-issue.ts:147-162,247-254`, `types.ts:318-324,
   2494,2683`, `source.ts:227-230`, `github.source.ts:243,828-858,922-945`, `items-write.controller.ts:80-120,209-227,267-282`, `backlog.mjs:2187-2240,
   2308-2381,3029-3131,3655-3685`, `scan.util.ts:60-95`, `agent.ts:477-494`, `agents.service.ts:23,418-421,500-504`, `DispatchButton.tsx:1,45,170-172`,
   `orchestrate.mjs:1292-1355,1700-1735,2016-2036`, `orchestrate.test.mjs:7290-7380,7587,7593`, `orchestrate.mjs:267,280`, every Task 10 line). All Create
   paths are absent (`skills/backlog-tick/` does not exist). Three stated facts are false: I1, I2, I3.
4. **Interfaces** — every name Task 8 consumes is produced by Task 7 with the same spelling; `PLAN_REVIEW_LABEL`, `BacklogItem.planReview`, `PLAN_REVIEW_REASON`,
   `planReviewBlock`, `POST /api/items/plan-review`, `planReview` on create/body all flow forward with one spelling.
5. **Order** — no task consumes a later one's output. Task 6 names `--plan-review` (Task 3) and `show --json`'s `"planReview":true` (Task 1 — `show --json`
   passes the API item through, `backlog.mjs:2549`, so no extra work).
6. **Tests** — every Review Focus item has a named test (Task 8: 1, 2, 3, 5; Task 7: 4). Fixtures discriminate where it matters (in-review + plan-review on one
   issue, Task 1; both flags → in-review wins, Tasks 4/5; ttl ± 1 ms, Task 7; `--base develop` read from `develop` not `main`, Task 8). One fixture pins a wrong
   value (C1); one test is named in a file that has no such case (I3); one guard the plan calls new already exists (I1); one existing guard goes red (I2).
7. **Conventions** — behaviour-not-code is held throughout; size targets are stated soft; 160-column wrap is stated; `process.exitCode` form is stated.

## Critical

### C1. plan:358–359, 396 — the tracker branch and worktree are named with `#`, but execute names them with the bare number

The plan: "The `<id>` in the branch and path checks is the id exactly as passed to execute" (358–359) and the test "branch `execute/#12` exists → skipped"
(396). Execute's `pr` finish says the opposite: `skills/backlog-execute/references/pr-mode.md:15` — "in a tracker project `<id>` is the bare issue number
(`31`, never `#31`)" — and builds `refs/heads/execute/<id>` and `<root>/.worktrees/execute-<id>` from it (`pr-mode.md:80-82`). So a killed, open or
verification-failed execute on `#12` leaves `execute/12` and `.worktrees/execute-12`; a tick looking for `execute/#12` never finds them and picks `#12`
again every tick — exactly the case spec:132–134 says "the tick must not even pick". The plan's own test would pin the wrong name green.

→ For a tracker id, strip the `#` for the branch and worktree checks (`refs/heads/execute/12`, `.worktrees/execute-12`), cite `pr-mode.md:15`, and change the
Task 8 fixture to "branch `execute/12` exists → `#12` skipped". The execute `args` may keep `#12` (`backlog.mjs` accepts both spellings).

### C2. plan:338 vs 371, 408 — `record` cannot reproduce the `<base>` blob hash `decide` compares against when the tick ran with `--base`

`decide` (355–358) reads a files execute candidate — and the hash `isSkipped` compares — from `git show <base>:<rel path>`, where `<base>` is `--base`, else
`origin/HEAD`'s branch, else `main`. `record` (338) is `record <id> ok|failed --kind … [--reason …]` with no `--base`, yet 371 says a files `execute` failure
hashes "the item's blob at `<base>`" and the test at 408 "stores the hash of the `<base>` blob". With a schedule line `/backlog-tick --base develop`, `record`
resolves `<base>` to `main`: the stored hash is `main`'s blob (or nothing — the plan does not say what `record` does when the blob is absent at that ref),
the next `decide --base develop` hashes `develop`'s blob, they differ, and the failed item is eligible again every tick — the retry loop spec:28 and spec:48
rule out. The test as written (no `--base`) cannot see it.

→ Put `base` in the lock (`Lock` gains `base: string`, the resolved ref `decide` used) and have `record` hash the blob at the lock's `base`, falling back to
the default resolution only when no lock is held for that id; say what an absent blob at that ref does (hash the empty string, say). Add the test:
`decide --base develop` → `record bug-1 failed --kind execute` → `decide --base develop` again skips `bug-1`, while `decide` with no `--base` on the same
repo does not read `main` for the hash.

## Important

### I1. plan:223–224 — "No such guard exists for the in-review twin today" is false

`test/agents-shared.test.ts:830-833` reads `orchestrate.mjs` as text and asserts `const IN_REVIEW_REASON = '${IN_REVIEW_REASON}';`, and `:836-838` asserts
execute's `SKILL.md` carries the sentence. The plan sends the implementer to invent a new guard in `orchestrate.test.mjs` and leaves the existing seam
without a `PLAN_REVIEW_REASON` case, so the execute copy (Task 6's `this plan awaits review`) is guarded by nothing.

→ In Task 4 (where `PLAN_REVIEW_REASON` is born) add two cases beside `agents-shared.test.ts:830-838`: `orchestrate.mjs` contains
`const PLAN_REVIEW_REASON = 'this plan awaits review';` and `skills/backlog-execute/SKILL.md` contains the sentence. Note they go red until Tasks 5 and 6
land (or place them in Task 6, the last of the three). Drop the sentence at 223–224 or reword it to "the existing guard at `agents-shared.test.ts:830`".

### I2. plan:421–422, 438 — `test/skill-plugin-root.test.ts` goes red the moment `skills/backlog-tick/SKILL.md` exists

`test/skill-plugin-root.test.ts:29`: `expect(files.filter((f) => f.endsWith('/SKILL.md')).length).toBe(7)`. Task 9 creates the eighth SKILL.md and says
"existing guards — PASS" with no edit named. `test/skills-plugin-root.test.ts:40` enumerates the seven skills by name for its non-vacuity case; the new
skill (which calls `tick.mjs` through the braced root) belongs in that list too, or the braced-root rule is unguarded for it.

→ Task 9 Step 1: bump `toBe(7)` → `toBe(8)` and add `'backlog-tick'` to the `it.each` list at `skills-plugin-root.test.ts:40`; keep Step 2 as the run.

### I3. plan:191 — `test/agents-dispatch.test.ts` has no in-review refusal case to copy

The in-review refusal cases are in `test/tracker-dispatch.test.ts:257` (`plan` → `blocked: 'a PR is open for this item'`) and `:265` (`dispatch` → 409
`{ error: … }`); `agents-dispatch.test.ts` never mentions `inReview` and drives files items (`bugPath(...)`). The implementer must guess which file and which
status.

→ Name both: the tracker `planReview: true` plan-and-dispatch pair beside `tracker-dispatch.test.ts:257-265` (409 on dispatch, `blocked` on plan), and a files
case in `agents-dispatch.test.ts` using an item file with `plan-review: true` in its frontmatter (this is also the only end-to-end proof of Task 4's
`scan.util.ts` read reaching the ladder). Keep the "both flags → in-review reason" case.

### I4. plan:285–286, 365–367 — recover on an unreadable or malformed lock is unspecified

`lockState` returns `stale` "with whatever fields parsed" for a file holding `not json`, and recover then calls `recordOutcome(id, failed, kind, 'killed at
timeout', hash)` and composes `recovered a killed <kind> on <id>` — with no `id` and no `kind`. Built as written, `state.json` gains `items["undefined"]`
or the tick throws, and no test covers it (311 only pins `lockState`).

→ State it: a stale lock without a parseable `verdict.id` and `verdict.kind` is removed (`removeLock`) and nothing is recorded; verdict `recover`, reason
`removed an unreadable lock`, `stop: false`. Add the Task 8 case: lock file holding `not json` → that verdict, no lock afterwards, `state.json` unchanged.

## Minor

- **M1. plan:446** — two more skill-count sites: `README.md:3` ("six backlog skills") and `docs/subsystems/skills.md:3` ("Seven skills … four CLIs" — the tick
  adds a fifth CLI). Add both to Task 10's list.
- **M2. plan:93** — `BacklogItem.inReview`'s doc (`shared/types.ts:317`) says "for a TRACKER item only" and `runnerFix`'s (`:290-301`) says "the mapper is the
  only writer … every files item carries no key". `planReview` has two writers (`scan.util.ts` for files, `map-issue.ts` for tracker); its doc comment should
  say so rather than copy `inReview`'s.
- **M3. plan:357** — "`GET /api/items` (filtered to this project)": name the field — `projectPath === <root>` — since `project` is the display name and two
  checkouts can share one (`shared/agent.ts:470-473` makes the same point).
- **M4. plan:346–348 vs spec:101–103** — the spec says the stack check comes "before any other check"; the plan's git/`backlog/`/source checks must precede it
  (the source is read from `backlog/source.json`). Fine — say so in one comment so a spec reader does not file it as drift.
- **M5. plan:352–353** — skipping every tree under `<root>/.worktrees/` is broader than the spec's two kinds (`.worktrees/<id>` and `.worktrees/execute-<id>`,
  spec:117–118). Acceptable; state that it is deliberate.
- **M6. plan:137–138** — `test/tracker-origin.test.ts` does not enumerate routes (it tests `parseGithubRemote`, `:34-116`); the "if it enumerates routes"
  clause is dead and can go.
- **M7. plan:280** — `orderExecute` matches orchestrate's order (`orchestrate.mjs:1644-1645, 1994-1995`, hoist at `:1795`) — correct; cite those lines in the
  twin comment so the test's expected order has a named original.
- **M8. plan:47–57** — Review Focus 2 says "step 3 reads `<base>`" while the numbered list at 344–363 has the `<base>` read at step 5; renumber one of them.
