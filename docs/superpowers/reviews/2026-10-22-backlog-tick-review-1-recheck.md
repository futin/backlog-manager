# backlog-tick plan — review 1 re-check

Date: 2026-10-22. Scope: only the hunks in the review-1 follow-up diff of `docs/superpowers/plans/2026-10-22-backlog-tick.md` (Tasks 1, 4, 5, 6, 7, 8, 9, 10),
judged against the spec `docs/superpowers/specs/2026-10-22-backlog-tick-design.md` and the code. Line numbers below are the plan's as it stands after the diff.

## Verdict

**APPROVE WITH FIXES** — nothing in the changed hunks ships wrong behaviour on its own, but two of them leave an implementer guessing at a value that decides
whether the tick ever matches its project, and one widens a spec rule without the spec moving with it.

## What the diff fixed, verified

- Task 4 (plan:178, 191-196): `test/tracker-dispatch.test.ts` exists and its in-review pair at `:254-265` drives `/api/agents/plan` (`blocked`) and
  `/api/agents/dispatch` (uncoded 409, nothing spawned) exactly as the new bullet describes; `test/agents-dispatch.test.ts` builds a files project under a temp
  dir (`:113-154`, `bugPath` under `backlog/bugs/open`) and the dispatch re-check at `server/src/agents/agents.service.ts:500-504` runs `inReviewBlock` on any
  item, so a files fixture with `plan-review: true` does reach a chained `planReviewBlock`. Coverage, order and the 409 value all hold.
- Task 5 (plan:226-228): the in-review twin guard is at `test/agents-shared.test.ts:830-833` and asserts the literal `const IN_REVIEW_REASON = '…';` — the
  form `orchestrate.mjs:2026` carries — so the plan-review twin `const PLAN_REVIEW_REASON = '${PLAN_REVIEW_REASON}';` is the right shape, and
  `PLAN_REVIEW_REASON` is produced by Task 4 before Task 5 consumes it. Moving the guard to jest resolves the earlier red-commit problem.
- Task 6 (plan:263-265): the SKILL.md sibling is at `test/agents-shared.test.ts:836-839`, whitespace-collapsed as stated.
- Task 8 (plan:365-367): `skills/backlog-execute/references/pr-mode.md:15` says a tracker `<id>` is the bare issue number, and `:80-88` builds
  `refs/heads/execute/<id>` / `.worktrees/execute-<id>` from it — so `execute/12`, not `execute/#12`, is right, and the new negative case (`execute/#12` does
  not skip) discriminates.
- Task 8 (plan:365): `GET /api/items` rows carry `projectPath` on both sources (`server/src/items/scan.util.ts:93`, `server/src/tracker/map-issue.ts:225`),
  so filtering on it rather than the display name is correct.
- Task 8 (plan:410-411, 379-381): the `record hashes at the lock's base` case discriminates — a hash taken at a re-resolved `main` would differ from the
  `develop` blob and the second `decide --base develop` would not skip.
- Task 9 (plan:435-436): `test/skill-plugin-root.test.ts:29` is `toBe(7)`; `test/skills-plugin-root.test.ts:38-40` is the "seven skills" comment plus the
  `it.each` list.
- Task 10 (plan:464-468): `.claude/rules/skills.md:2` is `paths: ["skills/**", "agents/**"]`; `docs/subsystems/skills.md:3` reads "Seven skills … four CLIs";
  `README.md:3` reads "six backlog skills".
- Task 1 (plan:92-93): true that `inReview` has one writer today — `scan.util.ts` sets none of `runnerFix`/`queued`/`inReview` (the `BacklogItem` doc at
  `shared/types.ts:318-324` says "the mapper is the only writer"), so a two-writer `planReview` is a genuine difference worth the comment.

## Findings

### Important

- **[I] plan:365 — `<root>` is used (here, at :359, :363 and in `projectDir(orchHome(), root)` at :357) but never defined, and the raw-versus-realpath choice
  decides whether `projectPath === <root>` and the run-file key ever match.** The registry path is compared raw everywhere in this app
  (`skills/backlog-orchestrate/tools/orchestrate.mjs:1903-1904`, "the same not-realpath rule every membership check in this app follows"), and orchestrate
  resolves its root by walking up from `path.resolve(process.cwd())` without `realpathSync` (`orchestrate.mjs:762-768`). `git rev-parse --show-toplevel`
  returns a symlink-resolved path, which on macOS turns a `/var/folders/…` registry path into `/private/var/folders/…` — every Task 8 harness case that
  registers a `mkdtemp` project would then find zero items and no run file. → Define `<root>` once in Task 8 (or Global Constraints): the directory holding
  `.git`, found by walking up from `path.resolve(process.cwd())`, never realpath'd — a twin of `resolveProjectRoot` — and say the `--git-dir` ≠
  `--git-common-dir` check at step 1 runs from it.
- **[I] plan:379-381 — `record`'s hash source is "the `base` stored in the lock, never a re-resolved default", but the plan's own cases run `record` when no lock
  names that id** (`record bug-2 ok --kind groom with a bug-1 lock` at :425-426; a `failed --kind execute` sibling is one flag away, and the real path — a
  slow tick whose lock another tick already recovered as stale — is exactly this). What a files `execute` failure hashes then is undefined, so an implementer
  must guess between the default base, the empty string and "no hash". → State the rule (recommended: no lock for `<id>` → hash at the default base
  resolution, `origin/HEAD`'s branch else `main`, and say so on stderr) and add one case to the `record` bullet that pins it.
- **[I] plan:359 — the busy scan skips every tree under `<root>/.worktrees/`, which the plan itself marks as "broader than the spec's two kinds"; spec:117-118
  names exactly two kinds and says every other linked tree's `started:` blocks the project.** The spec is the approved document; a deliberate widening
  belongs in it, not only in a parenthesis here, and no Task 8 case pins what happens to a `started:` marker in a third kind of tree under `.worktrees/`.
  → Either amend spec:116-118 to "any tree under `<root>/.worktrees/`" with the one-line reason, or narrow the plan to the two spec kinds; in both cases add
  the case `started: only in <root>/.worktrees/other` to the busy bullet (:398) with the verdict the chosen rule gives.

### Minor

- plan:227-228 — the Task 5 bullet says "Run it with `pnpm run test:jest -- agents-shared` in Step 4", but Step 4 (:231) still reads "Run the same — PASS",
  i.e. the node suite only. → Add the jest command to Step 4's text.
- plan:375-376 — on `--dry-run` an unreadable lock reports reason `removed an unreadable lock` while removing nothing. → `would remove …` under `dryRun`, or
  state that the reason is identical and `dryRun: true` is the only tell.
- plan:263 — cites `:836-838` for the SKILL.md sibling; it spans `test/agents-shared.test.ts:836-839`. Cosmetic.
- plan:92-93 — the new doc-comment claim is right, but `shared/types.ts:318-324`'s `inReview` comment ("the mapper is the only writer … `'inReview' in item`
  means what it says") is the sentence the new comment contrasts with; worth naming it so the two comments read as a pair.

## Checklist walk (changed hunks only)

1. Coverage — spec step 3's `execute/<id>` exclusion (→ Task 8 :365-367), step 2's tracker filter (→ :365), "A tick the dashboard killed" (→ :373-376 plus the
   unreadable-lock builder call, tested at :419-420), the route/label/skill counts (→ Tasks 9, 10). No changed spec section is without a task.
2. Values — `this plan awaits review`, `cannot count open PRs`, `killed at timeout`, `execute/12`, `.worktrees/execute-12`, `toBe(8)` all match spec/code.
3. Reality — every file and line the hunks cite exists at the stated place (listed above). No Create path collides with an existing file.
4. Interfaces — `PLAN_REVIEW_REASON` (Task 4 → 5, 6), `Lock.base` (Task 7 → 8), `planReview` (Task 1 → 4, 8) all spelled consistently.
5. Order — Task 5's jest guard depends only on Task 4; Task 6's on Tasks 4 and 6 itself. Holds.
6. Tests — the new cases discriminate (`execute/#12` negative, `record hashes at the lock's base`, `not json` lock with state untouched). Gap: the
   no-lock `record` path (Important 2) and the third-kind `.worktrees/` tree (Important 3).
7. Conventions — behaviour-not-code throughout; no literal bodies added.
