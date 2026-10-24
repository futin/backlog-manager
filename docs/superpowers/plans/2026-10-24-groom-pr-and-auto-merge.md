# Groom PR finish + auto-merge/fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `backlog-groom` gains `--finish pr --base <ref>` (worktree → commit → push → PR), and every PR finish — groom or execute — can arm GitHub
auto-merge (`--auto-merge`) and stay to fix failing checks and base conflicts (`--fix`), all chosen on the launch sheet with Settings defaults.

**Architecture:** The trigger tokens are composed server-side by one shared function, `finishClause` (`shared/agent.ts`), from validated dispatch fields;
the sheet previews the same function. The skills own every git/gh step: groom's new `references/pr-mode.md`, and one shared
`skills/backlog-execute/references/auto-merge.md` read by both skills. `tick.mjs` learns to ignore a pr-mode groom's tree and branch.

**Tech Stack:** TypeScript (NestJS server, React 18 client, shared module), jest + supertest + Testing Library, `node --test` for skill tools, Markdown
skill files.

**Spec:** `docs/superpowers/specs/2026-10-24-groom-pr-and-auto-merge-design.md` — read it before any task; this plan argues from it.

**Override of the writing-plans template (user's global CLAUDE.md):** this plan specifies behaviour, signatures, exact values and exact test *cases* — never
literal function bodies or test scaffolding. Write the code and the test harness yourself, in the style of the file you are editing; if a case here looks
wrong against the code, say so rather than transcribe it. Any size figure in this plan is a soft target, never a reason to cut a rule.

## Global Constraints

- Wrap new prose (comments, Markdown) at 160 columns; never reflow existing text. Comments explain *why*, at the density the file already has.
- Every client component edit cites its `.claude/DESIGN.md` §8 subsection in the header comment it already has (LaunchSheet cites §8.2/§8.6).
- Never `git add -A` / `git add .`; stage the files the task touched, by name.
- Commit subjects pass `ci / pr-title`: `feat|fix|perf|docs|chore|test|refactor|ci|build`, optional lowercase `(scope)`, `: `, description.
- Tests: jest suites are flat in `test/`; node suites sit beside the tool. Run only the suites a task touches (`pnpm exec jest --runInBand test/<file>`,
  `node --test skills/backlog-tick/tools/tick.test.mjs`). Never run the whole `pnpm test`; CI does.
- Before editing a file under a `.claude/rules/` glob through any route, read the rule file scoped to it (CLAUDE.md, Invariants intro).
- An In place groom's final spawned prompt is byte-identical to today's (`composePrompt(item,'groom')` before this change). An execute's prompt with no
  `autoMerge`/`fix` is byte-identical to today's.
- Exact tokens: `--finish pr`, `--base <ref>`, `--auto-merge`, `--fix`. Exact branch/tree: `groom/<id>` and `<root>/.worktrees/groom-<id>`, where `<id>` has
  any leading `#` stripped (execute's `execute/<id>` convention, `executeId` in `tick.mjs`).
- Bounds (soft defaults, stated in the reference file): wait **45 minutes** from arming; at most **3** fix rounds inside it.
- Merge method preference: squash, else merge commit, else rebase.

## Review Focus

1. **An old tab (sheet opened before the deploy) launching a groom** — its body ends in `COMMIT_RULE`; the spawned prompt must carry exactly one closing
   clause, and under PR must not say "Do not push." → Task 2 pins both.
2. **A remote launch** — remote execute keeps forced PR and now also carries `autoMerge`/`fix`; a remote groom sends no finish, and a body naming one is a 400.
   → Task 2 (server) and Task 4 (sheet) pin it.
3. **A title that contains `--fix` or `--auto-merge`** (free text) — the board's own untouched groom or execute prompt must not trip rule 5 → Task 1 (defuse)
   and Task 2 (untouched-plan dispatch) pin it.
4. **Stored settings that disagree** — `prFixDefault: true` beside `prAutoMergeDefault: false`, or a hand-edited non-boolean → seeds Fix off / clamps to
   `false`. → Tasks 3 and 4.
5. **A killed pr-mode groom on a files project** — its `.worktrees/groom-<id>` tree keeps a `started:` marker forever; ticks must keep running on the project
   and never re-groom that item while its branch or tree exists. → Task 5.

---

### Task 1: `finishClause` takes the action and the two flags; the flag pattern learns the new tokens

**Files:**
- Modify: `shared/agent.ts:872-878` (`FINISH_FLAG` doc + pattern), `:880-888` (`defuseFinishFlags` doc), `:890-940` (`COMMIT_RULE` doc's last lines,
  `finishClause`)
- Modify: `shared/types.ts:893-899` (`AgentPlan.prompt` doc), `:916-948` (`AgentDispatchRequest`)
- Modify (call sites only, mechanical): `server/src/agents/agents.service.ts:568`, `client/src/components/board/LaunchSheet.tsx:206`
- Test: `test/agents-shared.test.ts` (the `finishClause` describe at :1016 and the pr-mode quote case at :846), `test/agents-prompt.test.ts`

**Interfaces:**
- Produces:
  - `type FinishAction = 'execute' | 'groom'` (exported from `shared/types.ts`, beside `ExecuteFinish`).
  - `interface FinishFlags { autoMerge?: boolean; fix?: boolean }` (exported from `shared/types.ts`).
  - `finishClause(action: FinishAction, finish: ExecuteFinish, base: string, flags?: FinishFlags): string`.
  - `FINISH_FLAG` matches `--finish`, `--base`, `--auto-merge`, `--fix` under the same `(?<![\w-])…(?![\w-])` boundary, still non-global.
  - `AgentDispatchRequest` gains `autoMerge?: boolean` and `fix?: boolean`; its `finish`/`base` doc says execute or groom.

**Exact sentences** (base shown as `main`; the base is interpolated in both places, as today):

| action / flags          | sentence |
| ----------------------- | -------- |
| any, `in-place`         | `COMMIT_RULE`, byte for byte; base and flags ignored |
| execute, pr, none       | ``Finish with `--finish pr --base main`: the skill commits, reviews, pushes and opens the PR into main, and never merges.`` (today's, unchanged) |
| groom, pr, none         | ``Finish with `--finish pr --base main`: the skill commits, pushes and opens the PR into main, and never merges.`` |
| execute, pr, autoMerge  | ``Finish with `--finish pr --base main --auto-merge`: the skill commits, reviews, pushes, opens the PR into main and arms GitHub auto-merge if the repository allows it, then waits for GitHub to merge it; the skill never merges itself.`` |
| execute, pr, autoMerge+fix | ``Finish with `--finish pr --base main --auto-merge --fix`: the skill commits, reviews, pushes, opens the PR into main and arms GitHub auto-merge if the repository allows it, then waits for GitHub to merge it, fixing failing checks and conflicts with main meanwhile; the skill never merges itself.`` |
| groom, pr, autoMerge / +fix | the two rows above with `reviews, ` removed |

`fix` without `autoMerge` is ignored by the function (the server 400s it first, Task 2); the result equals the no-flag sentence.

- [ ] **Step 1: Write the failing tests** in `test/agents-shared.test.ts`, replacing the three existing `finishClause` cases' calls with the new signature
  (their expected strings stay byte-identical) and adding:
  - `in-place is COMMIT_RULE for both actions and any flags` — `finishClause('groom','in-place','develop',{autoMerge:true,fix:true}) === COMMIT_RULE`.
  - `groom pr drops "reviews"` — equals the groom/pr/none row; `not.toContain('reviews')`.
  - `each flag combination, both actions` — the four flag rows exactly, for base `release/1.x` (slashed base verbatim in both places).
  - `fix alone is ignored` — `finishClause('execute','pr','main',{fix:true})` equals the execute/pr/none row.
  - `flags only inside the backticks` — for every action × flag combination, every `--auto-merge`/`--fix` occurrence lies between the first pair of backticks.
  - Update the pr-mode quote case (:846) to `finishClause('execute','pr','<base>')`.
  - In `test/agents-prompt.test.ts`: `FINISH_FLAG` matches `--auto-merge` and `--fix` bare, quoted and parenthesised; does not match `--fixed`, `--fix-up`,
    `--auto-merged`, `prefix--fix`; `defuseFinishFlags('Use --fix and --auto-merge')` contains no FINISH_FLAG match and keeps the visible words.
- [ ] **Step 2: Run** `pnpm exec jest --runInBand test/agents-shared.test.ts test/agents-prompt.test.ts` — expect FAIL (signature/arity, new tokens).
- [ ] **Step 3: Implement** the types, the pattern and `finishClause` per the table; update the two call sites to pass `'execute'` (behaviour unchanged in
  this task — Task 2 and Task 4 widen them). Update the doc comments named above so none still says "execute only" or "Groom and capture keep their
  `COMMIT_RULE` inside this text" (groom no longer does; capture still does).
- [ ] **Step 4: Run** the same command plus `pnpm run typecheck` — expect PASS.
- [ ] **Step 5: Commit** — `feat(dispatch): finishClause takes the action and the auto-merge/fix flags`.

### Task 2: Dispatch accepts a groom finish and the two booleans; groom's closing clause moves out of the editable text

**Files:**
- Modify: `server/src/agents/agents.service.ts:410-455` (machine rule, rules 1–5), `:560-570` (base proof + prompt append)
- Modify: `server/src/agents/prompt.util.ts:26-36` (`composePrompt`) and its doc comments
- Test: `test/agents-dispatch.test.ts`, `test/agents-dispatch-remote.test.ts`, `test/agents-prompt.test.ts`, `test/agents-plan.test.ts`

**Interfaces:**
- Consumes: `finishClause`, `FinishAction`, `FinishFlags`, extended `FINISH_FLAG`, `AgentDispatchRequest.autoMerge/fix` (Task 1).
- Produces: `composePrompt(item, 'groom')` no longer ends in `COMMIT_RULE` (capture still does; execute unchanged). Dispatch appends
  `finishClause(action, finish, base, { autoMerge, fix })` for groom and execute.

**Rules, in this order, all before the item lookup** (exact 400 bodies):
1. `finish` outside the vocabulary → `finish must be in-place or pr` (unchanged).
2. `finish` on an action other than execute or groom → `finish applies only to execute or groom` (was `…only to execute`).
3. A remote machine and a groom with `finish` present → `` a groom on <label> has no finish `` (label = `m.label`). A remote execute stays forced to `pr`
   and its existing `finish must be pr on <label>` stays.
4. `autoMerge` or `fix` present and not a boolean → `autoMerge must be a boolean` / `fix must be a boolean`.
5. Base rules (unchanged wording) run on the derived finish.
6. `autoMerge: true` or `fix: true` with a derived finish other than `pr` → `autoMerge and fix apply only to finish pr`. `false` values are accepted
   anywhere (an untouched toggle).
7. `fix: true` without `autoMerge: true` → `fix requires autoMerge`.
8. Rule 5, now for execute **and groom** bodies: a FINISH_FLAG match → `the finish mode, base, auto-merge and fix are set by the sheet's pickers — remove
   --finish, --base, --auto-merge and --fix from the prompt`. Capture bodies are not checked (unchanged).

**Prompt composition:** for a groom, strip one trailing `COMMIT_RULE` (with the whitespace before it) from the body if the body, trailing whitespace
ignored, ends with it; then append `' ' + finishClause('groom', finish, base, flags)` (no leading space when the stripped body is empty). Execute is
appended exactly as today (no strip — its existing "doubled, harmless" case at `test/agents-dispatch.test.ts:586` stays). Capture is sent unchanged.

- [ ] **Step 1: Write the failing tests.** In `test/agents-dispatch.test.ts` (reuse the file's `exec`/`spawnedPrompt` helpers; add a groom twin of `exec`):
  - `in-place groom: the spawned prompt equals today's composePrompt bytes` — dispatch the plan's own untouched groom prompt (no finish key) and with
    `finish:'in-place'`; both spawn `plan.prompt + ' ' + COMMIT_RULE`, which equals the pre-change `[head, instruction, COMMIT_RULE].join(' ')`.
  - `old-tab groom body ending in COMMIT_RULE: exactly one clause` — body `plan.prompt + ' ' + COMMIT_RULE`, no finish → spawned prompt contains
    `COMMIT_RULE` exactly once; with `finish:'pr', base:'main'` → contains `COMMIT_RULE` zero times and ends with `finishClause('groom','pr','main')`.
  - `groom finish pr + base main: ends with finishClause(groom, pr, main)`.
  - `groom pr with autoMerge and fix: ends with the groom flag sentence`; `execute pr with autoMerge: ends with the execute autoMerge sentence`.
  - `capture with finish → 400 finish applies only to execute or groom` (replaces the :629 expectation's wording).
  - `autoMerge true with finish in-place → 400`; `fix true with no finish → 400`; `fix true without autoMerge (finish pr) → 400 fix requires autoMerge`;
    `autoMerge "yes" → 400 autoMerge must be a boolean`; `fix 1 → 400 fix must be a boolean`; `autoMerge false, fix false with in-place → 201`.
  - `typed --auto-merge / --fix in an execute body → 400` and `typed --finish / --auto-merge in a groom body → 400` (new refusal text; update
    `TOKEN_REFUSAL` at :578). `typed --fix in a capture body → 201` (capture unchecked).
  - `the untouched groom plan for an item titled "Add --fix and --auto-merge flags" dispatches 201` (Review Focus 3).
  In `test/agents-dispatch-remote.test.ts`:
  - `remote groom with finish pr → 400 a groom on Pro has no finish`; `remote groom with no finish still spawns 'Groom #32. ' + COMMIT_RULE` (the existing
    :375–426 expectations must keep passing unchanged).
  - `remote execute with autoMerge and fix → the sent prompt ends with finishClause('execute','pr','main',{autoMerge:true,fix:true})`.
  In `test/agents-prompt.test.ts`: change `'%s still ends with COMMIT_RULE'` (:327) so capture still does and groom does not contain `COMMIT_RULE`; add
  `the groom prompt carries no FINISH_FLAG match for every section`. In `test/agents-plan.test.ts`: a groom plan's prompt does not contain `COMMIT_RULE`.
- [ ] **Step 2: Run** `pnpm exec jest --runInBand test/agents-dispatch.test.ts test/agents-dispatch-remote.test.ts test/agents-prompt.test.ts
  test/agents-plan.test.ts` — expect the new cases to FAIL.
- [ ] **Step 3: Implement** the rules and the composition above. Rewrite the comments at the rule block and at `composePrompt` so they describe the new
  split (finish is execute's or groom's; the clause is appended at dispatch for both; capture keeps `COMMIT_RULE` in its text).
- [ ] **Step 4: Run** the same command — expect PASS. `pnpm run typecheck` — PASS.
- [ ] **Step 5: Commit** — `feat(dispatch): groom takes a PR finish; auto-merge and fix ride with any PR finish`.

### Task 3: Settings — groom default finish and the two PR defaults

**Files:**
- Modify: `client/src/lib/settings.ts:144` (type), `:185` (defaults), `:230` area (new helper beside `pickOne`), `:345` (clamp)
- Modify: `client/src/components/settings/SettingsView.tsx:443-452` (the Execute finish row and its neighbours)
- Test: `test/settings.test.ts`, `test/settings-view.test.tsx`

**Interfaces:**
- Produces on `Settings`: `groomDefaultFinish: ExecuteFinish` (default `'in-place'`), `prAutoMergeDefault: boolean` (default `false`), `prFixDefault: boolean`
  (default `false`). New private helper `pickBool(value: unknown, fallback: boolean): boolean` — a boolean passes through, anything else is the fallback.

**Rows** (after Execute finish, same `SettingsRow`, cite DESIGN §8 in the comment like the neighbours do):
- **Groom finish** — `Select` with `EXECUTE_FINISH_OPTIONS`; hint `PR mode writes the spec and plan in its own worktree, commits, pushes and opens a PR. It
  never merges.`
- **Auto-merge PRs** — `Switch` (label `auto-merge PRs`); hint `Preselects Auto-merge on a PR launch. Armed only if the GitHub repo allows auto-merge — GitHub
  does the merge.`
- **Fix if it fails** — `Switch` (label `fix if it fails`), `disabled` with its `title`-style reason `Needs Auto-merge PRs on` while `prAutoMergeDefault` is
  off; hint `Preselects Fix on a PR launch: the session stays and fixes failing checks and base conflicts, up to 3 rounds in 45 minutes.`
- Turning Auto-merge PRs off does not rewrite `prFixDefault` (the stored value is inert while the row is disabled; the sheet seeds Fix off, Task 4).

- [ ] **Step 1: Write the failing tests.** `test/settings.test.ts`: defaults are `in-place`/`false`/`false`; `groomDefaultFinish: 'squash'` clamps to
  `in-place`, `'pr'` survives; `prAutoMergeDefault: 'true'`, `1`, `null` each clamp to `false`, `true` survives; same for `prFixDefault`; a stored
  `{prAutoMergeDefault:false, prFixDefault:true}` survives the clamp unchanged (the sheet, not the clamp, resolves it). `test/settings-view.test.tsx`: the
  three rows render with the hints above; toggling Auto-merge PRs calls `update({prAutoMergeDefault:true})`; the Fix switch is disabled while
  `prAutoMergeDefault` is false and enabled when true; picking PR in Groom finish calls `update({groomDefaultFinish:'pr'})`.
- [ ] **Step 2: Run** `pnpm exec jest --runInBand test/settings.test.ts test/settings-view.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement** the keys, helper, clamp lines and rows.
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** — `feat(settings): groom finish default and PR auto-merge/fix defaults`.

### Task 4: Launch sheet — Finish/Base for groom; Auto-merge and Fix toggles under PR

**Files:**
- Modify: `client/src/components/board/LaunchSheet.tsx:30-45` (header comment), `:66-97` (state, seeding, branch fetch), `:105-130` (request body), `:200-225`
  (clause line, Finish/Base row, new toggle row)
- Test: `test/launch-sheet.test.tsx`

**Interfaces:**
- Consumes: `finishClause(action, finish, base, flags)` (Task 1); `settings.groomDefaultFinish`, `prAutoMergeDefault`, `prFixDefault` (Task 3); dispatch's
  rules (Task 2).

**Behaviour:**
- `hasFinish` = plan action is execute, or groom on home. Finish/Base and the clause line draw for `hasFinish`; a remote groom draws the clause line only
  (it shows `COMMIT_RULE`, what the server appends) and no Finish.
- The Finish pick seeds once per fetched plan: `executeDefaultFinish` for execute, `groomDefaultFinish` for groom. Execute on a remote stays derived as `pr`
  (unchanged); a groom ignores `runOn.lock.prOnly`.
- Branches are fetched when the plan is execute or groom (still once per open).
- Toggle row, drawn only while the derived finish is `pr`: two `Switch`es, `auto-merge` (span text `auto-merge — GitHub merges the PR once its checks pass`)
  and `fix if it fails` (span text `fix if it fails — the session stays and fixes failing checks and base conflicts`), the second disabled until the first is
  on; under them a `sheet-note`: `Needs Allow auto-merge on the GitHub repo; checked when the PR opens.` Same §8 Switch row as remote control.
- Seeding: whenever the derived finish becomes `pr` (on open with a PR default, on a pick, on a switch to a remote execute), Auto-merge =
  `prAutoMergeDefault`, Fix = `prAutoMergeDefault && prFixDefault`. Leaving `pr` clears both. Turning Auto-merge off clears Fix.
- Request body: execute as today plus, under `pr`, `autoMerge` and `fix` as booleans (both keys present). Home groom: `finish` always, `base` only under
  `pr`, the two booleans only under `pr`. Remote groom: no `finish`, `base`, `autoMerge` or `fix` key.
- The clause line is `finishClause(action, finish, base, {autoMerge, fix})` — it changes as the toggles change.

- [ ] **Step 1: Write the failing tests** (extend the `describe` that holds :369–:530; reuse its render/plan/settings fixtures):
  - Replace `draws no Finish, no clause line and no finish or base key for a groom launch` (:446) with `a home groom draws Finish (seeded In place) and
    sends finish in-place with no base, autoMerge or fix`, and its clause line is `COMMIT_RULE`.
  - `a groom seeded PR from groomDefaultFinish offers branches and shows finishClause('groom','pr','main')`; `executeDefaultFinish: 'pr'` does not seed a
    groom (distinct values: `executeDefaultFinish:'pr'`, `groomDefaultFinish:'in-place'` → groom shows In place).
  - `no toggles under In place; both toggles under PR, Fix disabled until Auto-merge is on`.
  - `toggles seed from Settings when Finish is PR` — `{prAutoMergeDefault:true, prFixDefault:true}` → both on, clause line is the flag sentence, body carries
    `autoMerge:true, fix:true`.
  - `prFixDefault true with prAutoMergeDefault false seeds Fix off` → body `autoMerge:false, fix:false`.
  - `flipping Finish away from PR clears both and back re-seeds` — on/on → In place (no toggles, body has neither key) → PR (on/on again).
  - `turning Auto-merge off clears Fix` → body `autoMerge:false, fix:false`.
  - `a remote execute draws the toggles and sends them` (locked PR); the existing `sends a remote groom with the machine and no finish` (:515) keeps passing
    and additionally asserts no `autoMerge`/`fix` key and no Finish select.
- [ ] **Step 2: Run** `pnpm exec jest --runInBand test/launch-sheet.test.tsx` — expect the new cases to FAIL.
- [ ] **Step 3: Implement** the behaviour above; update the header comment and the request-body comment (groom now sends its finish; remote groom does not).
- [ ] **Step 4: Run** the same command plus `test/dispatch-button.test.tsx` and `pnpm run typecheck` — PASS.
- [ ] **Step 5: Commit** — `feat(board): groom PR finish and auto-merge/fix toggles on the launch sheet`.

### Task 5: `tick.mjs` ignores a pr-mode groom's tree and never re-grooms its item

**Files:**
- Modify: `skills/backlog-tick/tools/tick.mjs:502-504` (the `startedMarker` comment), `:531-536` (`isSkippedTree`), `:538` (beside `executeTaken`), `:450`
  (the groom call), `:583-610` (`filesGroomCandidate`, `trackerGroomCandidate`)
- Test: `skills/backlog-tick/tools/tick.test.mjs`

**Interfaces:**
- Produces: `groomTaken(root, id): boolean` — true when branch `groom/<executeId(id)>` exists or path `<root>/.worktrees/groom-<executeId(id)>` exists.
  `trackerGroomCandidate` takes the project context first, as `filesGroomCandidate` does: `trackerGroomCandidate({ root }, mine, state)`.
- `isSkippedTree` accepts `.worktrees/groom-<file id>` as well as `.worktrees/execute-<file id>` and `.worktrees/<file id>`; a tracker-shaped name
  (`groom-12`) is NOT skipped by `isSkippedTree` (same as today's `execute-12`, because `FILE_ITEM_ID` is the test) — only files items carry `started:` on disk.

- [ ] **Step 1: Write the failing tests** in `tick.test.mjs`, beside the cases at :444 and :520:
  - Extend the `for (const name of [...])` loop at :450 with `'groom-bug-2'`, and rename that test to say orchestrator, execute and groom trees.
  - `files: a groom/<id> branch or a .worktrees/groom-<id> tree takes the item out of the groom candidates` — two ungroomed bugs (`bug-1`, `bug-2`), no
    ready execute work: `groom/bug-1` branch → groom pick is `bug-2`; delete it → `bug-1`; `mkdir .worktrees/groom-bug-1` → `bug-2`.
  - `tracker: a groom/<n> branch or .worktrees/groom-<n> tree skips the issue for groom` — issues 12 (ungroomed bug) and 13 (refactor):
    `groom/#12` branch does not skip (`#12`), `groom/12` does (`#13`), `.worktrees/groom-12` does (`#13`).
  - Existing `execute-`/`<id>` cases unchanged.
- [ ] **Step 2: Run** `node --test skills/backlog-tick/tools/tick.test.mjs` — expect the new cases to FAIL.
- [ ] **Step 3: Implement**; update the `startedMarker` comment to name the third kind of skipped tree and why (a killed pr-mode groom).
- [ ] **Step 4: Run** the same command and `node --test skills/backlog-tick/tools/tick-lib.test.mjs` — PASS.
- [ ] **Step 5: Commit** — `fix(tick): skip a pr-mode groom's tree and never re-groom its item`.

### Task 6: The shared auto-merge/fix procedure and execute's hooks into it

**Files:**
- Create: `skills/backlog-execute/references/auto-merge.md`
- Modify: `skills/backlog-execute/SKILL.md:1-10` (description), `:73-87` (Finish mode section), `:377` (hard-limit line)
- Modify: `skills/backlog-execute/references/pr-mode.md` §1 (:17–40, the quoted sentence and token rules), §8 (:224–270, after the tracker label/comment/stop),
  §9 (:271–282, final message)
- Test: `test/agents-shared.test.ts` (the pr-mode quote describe at :840)

**Content `auto-merge.md` must carry** (wording is yours; every item below is a rule, not an option). Read in full by either skill when the trigger has
`--auto-merge`, after the PR is open and after any claim is released:
- **Arm** — spec "### Arm" steps 1–5: `gh api repos/{owner}/{repo} --jq .allow_auto_merge`; `gh repo view --json squashMergeAllowed,mergeCommitAllowed,
  rebaseMergeAllowed`; not `true` → exactly `auto-merge: not allowed on <owner>/<repo> — PR left open`, no wait, no fix; squash › merge › rebase;
  `gh pr merge <n> --auto --<method>`; any refusal → report, PR left open, no wait. Record what `gh pr merge --auto` does on an already-mergeable PR with the
  installed `gh` (`gh --version`, `gh pr merge --help`); if it cannot be settled offline, say so and write the line as "may merge at once".
- **Wait** — foreground only, never background; `gh pr view <n> --json state,mergeable,mergeStateStatus,statusCheckRollup` plus `gh pr checks <n> --watch`
  bounded per call under the 10-minute Bash cap; 45 minutes from arming; `MERGED` → done (groom tracker: `backlog.mjs plan-review <n> off`; execute: nothing on
  the issue, §9's hand steps when the body said `Refs`); `CLOSED` → stop and report; without `--fix`, a red check or `CONFLICTING` ends the wait at once;
  bound hit → stop, auto-merge left armed, report what is pending or red.
- **Fix** (only with `--fix`) — failing check: `gh run view <run> --log-failed`, fix in the tree, verify, commit `fix: <what>` with narrow staging, push;
  conflict: `git fetch origin <base>` + `git merge origin/<base>` in the tree, resolve, verify, commit, push; never rebase, never force-push; at most 3 rounds;
  a failure outside the PR's diff (the rule for judging it is yours to word — infra, a job failing identically on `<base>`, a missing secret, a flaky job red
  twice in a row) → stop and report; `backlog-reviewer` is not re-dispatched; every fix commit is listed in the final message.
- **Refusals** — a denied `git`/`gh` call ends the procedure, never retried another way (execute pr-mode §8 "When a step is refused").
- The merge-of-base into the PR branch is a merge INTO the item's branch, never into a base; GitHub performs the only merge into `<base>`.

**Execute hooks:**
- Finish mode section: `--auto-merge` and `--fix` are read with `--finish`; `--auto-merge` without `--finish pr`, or `--fix` without both → stop and name
  the rule; never a fallback. One line `finish mode: pr → PR into <base>, auto-merge, fix` (flags as present).
- pr-mode §1 quotes `finishClause('execute','pr','<base>')` (unchanged) and also `finishClause('execute','pr','<base>',{autoMerge:true,fix:true})`.
- pr-mode §8 ends: with `--auto-merge`, read `${CLAUDE_PLUGIN_ROOT}/skills/backlog-execute/references/auto-merge.md` in full and run it now.
- pr-mode §9 final message adds the auto-merge outcome line and any fix commits.
- Description and hard limit: "never merges" becomes "never merges; with `--auto-merge` it arms GitHub auto-merge on its own PR and GitHub merges".

- [ ] **Step 1: Write the failing tests** in `test/agents-shared.test.ts` beside :846: `pr-mode.md quotes the execute flag sentence` —
  `prMode` contains `finishClause('execute','pr','<base>',{autoMerge:true,fix:true})`; `auto-merge.md names the exact not-allowed line, the 45-minute and
  3-round bounds, and forbids force-push` — the file (whitespace-collapsed) contains `auto-merge: not allowed on <owner>/<repo> — PR left open`, `45 minutes`,
  `3`, `--auto --`, `never force` (case-insensitive for the last).
- [ ] **Step 2: Run** `pnpm exec jest --runInBand test/agents-shared.test.ts` — FAIL.
- [ ] **Step 3: Write** `auto-merge.md` and the execute edits.
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** — `feat(execute): arm GitHub auto-merge and fix the PR until it merges`.

### Task 7: The groom skill's `pr` finish

**Files:**
- Create: `skills/backlog-groom/references/pr-mode.md`
- Modify: `skills/backlog-groom/SKILL.md:1-20` (description + "never commits" paragraph), new `## Finish mode` section before `## Pick an item` (:33), `## Groomed
  on disk only` (:417) (not printed in `pr` mode), `## If the session ends without a verdict` (:438) (pointer to pr-mode §7)
- Test: `test/agents-shared.test.ts`

**Interfaces:**
- Consumes: `auto-merge.md` (Task 6), `finishClause('groom', …)` sentences (Task 1), the tree spelling `tick.mjs` depends on (Task 5).

**Content** — the spec's "The groom `pr` flow" steps 1–9, "The guard while the PR is open", "No reviewer" and "Refusals", as rules:
- Finish mode section mirrors execute's (Task 6 hook): tokens, the stop-on-violation rules, the one-line announcement, "read
  `${CLAUDE_PLUGIN_ROOT}/skills/backlog-groom/references/pr-mode.md` in full before Pick an item"; under a `[backlog-tick]` marker the section is skipped
  (ticks never pass a finish).
- pr-mode.md §1 resolves `<base>` by execute's pr-mode §1 read and quotes `finishClause('groom','pr','<base>')` and the flag sentence.
- §2 tree: exactly `<root>/.worktrees/groom-<id>` on `groom/<id>` (`#` stripped), cut from `<base>`; an existing branch or path → stop, never reuse or
  delete; no local `<base>` → stop; every later command is `cd <tree> && …`.
- §3–§6 the step order per source, verbatim from spec steps 3–6, including: files `stop` before the commit; tracker commit → push → `new`/`body
  --plan-review` with `blob/<sha>` → plain `stop` → `gh pr create` → auto-merge; commit `docs(groom): <item title>`; PR body `Refs #<n>`, never `Closes`.
- §7 nothing to commit, §8 auto-merge hook (read `auto-merge.md`; on `MERGED` run `plan-review <n> off` on a tracker project), §9 final message (PR URL or
  the `gh pr create` to run, branch, absolute tree path, auto-merge outcome; tracker: the `plan-review <n> off` command when the mark is still on; files: the
  "re-grooming from the board before the merge grooms it again" limitation).
- The "never commits" text gains the `pr` exception, worded as execute's is.

- [ ] **Step 1: Write the failing tests** in `test/agents-shared.test.ts`: `groom pr-mode.md quotes both groom sentences` — contains
  `finishClause('groom','pr','<base>')` and `finishClause('groom','pr','<base>',{autoMerge:true,fix:true})`; `groom pr-mode.md spells the tree tick.mjs
  skips` — contains `.worktrees/groom-<id>` and `groom/<id>`; `groom SKILL.md points at pr-mode.md and auto-merge.md is reached from it` — SKILL.md contains
  `skills/backlog-groom/references/pr-mode.md`, pr-mode.md contains `skills/backlog-execute/references/auto-merge.md`.
- [ ] **Step 2: Run** `pnpm exec jest --runInBand test/agents-shared.test.ts` — FAIL.
- [ ] **Step 3: Write** the files.
- [ ] **Step 4: Run** the same command — PASS. `pnpm run test:skills` only if a skill test reads groom's SKILL.md (`grep -rl "backlog-groom/SKILL.md"
  skills test` decides).
- [ ] **Step 5: Commit** — `feat(groom): a --finish pr mode that lands the spec and plan in a PR`.

### Task 8: Invariants and docs

**Files:**
- Modify: `CLAUDE.md:195` (headline), `.claude/rules/orchestrator.md:45-50` (headline byte-equal + mechanism body), `docs/subsystems/invariants.md:603` (section
  + heading) and every link to its anchor (`grep -rn "backlog-orchestrate-is-the-only-skill-that-merges" .`), `docs/subsystems/invariants.md:261` (tick
  paragraph wording if it restates the rule), `docs/overview.md:123`, `skills/backlog-orchestrate/SKILL.md:9`
- Modify: `docs/subsystems/skills.md` (groom finish mode; the shared auto-merge procedure), `docs/subsystems/board.md` (sheet controls, Settings rows),
  `docs/subsystems/api.md` (dispatch body: groom finish, `autoMerge`, `fix`, the new 400s)
- Test: `test/claude-rules.test.ts`

**New headline** (identical in CLAUDE.md and the rule file): `` **`backlog-orchestrate` is the only skill that merges into a base; `backlog-execute` and
`backlog-groom` commit and push their own branch only in `pr` mode, and may arm GitHub auto-merge on the PR they opened.** `` Mechanism body: the fix loop's
`git merge origin/<base>` is a merge into the item's branch; GitHub performs the merge into the base; the skill never runs `gh pr merge` without `--auto`.
Reasoning section in invariants.md: why auto-merge is not "the skill merging" (the person ticked it; GitHub's branch protection still gates it).

- [ ] **Step 1: Edit** the headline in both tiers and the heading; fix every anchor link the grep finds.
- [ ] **Step 2: Run** `pnpm exec jest --runInBand test/claude-rules.test.ts` — PASS (headlines byte-equal, anchors resolve once).
- [ ] **Step 3: Edit** the three subsystem docs and the orchestrate description.
- [ ] **Step 4: Run** `grep -rn "only skill that merges" CLAUDE.md docs skills .claude` — every hit is the new wording or a historical spec/plan.
- [ ] **Step 5: Commit** — `docs: groom pr finish and auto-merge in invariants and subsystem docs`.

### Task 9: Real-run verification (held — needs the user)

The spec asks for one real groom in `pr` mode against a scratch GitHub repo with auto-merge allowed and one with it disallowed, with the transcripts' outcome
lines recorded in the PR. That creates GitHub repositories and pushes — outside the machine — so under an unattended run it is **not** executed: list it in
the final report as unverified, with the steps (create the scratch repo, toggle "Allow auto-merge", register it, launch a groom from the board with PR +
Auto-merge + Fix, read the outcome line), for the user to run or release.
