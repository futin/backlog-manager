# Execute finish picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `backlog-execute`'s finish mode is chosen per run — `--finish pr [--base <ref>]` on a typed trigger, a Settings default plus a launch-sheet
picker on the board — and `backlog/config.json` is gone.

**Architecture:** One shared function, `finishClause`, renders the execute prompt's closing sentence on both sides. The sheet shows it read-only under an
editable body that no longer carries it; the server validates `finish`/`base`, refuses a body that spells either flag, proves the base, and appends the
clause. The skill keys pr mode on the `--finish pr` token alone.

**Tech Stack:** TypeScript (NestJS server, React client, `shared/`), jest + jsdom, plain `.mjs` skill CLI under `node --test`, markdown skill text.

**Spec:** [docs/superpowers/specs/2026-10-21-execute-finish-picker-design.md](../specs/2026-10-21-execute-finish-picker-design.md)

**This plan specifies behaviour, signatures, exact values and exact test cases — never literal code.** Write the bodies yourself; disagree with the plan
where the code proves it wrong, and say so in your report. Any size note is a soft target. (Overrides `writing-plans`' "code blocks required".)

## Global Constraints

- Finish vocabulary is exactly `'in-place' | 'pr'`; default `'in-place'` everywhere a value is absent.
- The pr clause, byte for byte (with `<base>` replaced by the real base): ``Finish with `--finish pr --base <base>`: the skill commits, reviews, pushes and opens the PR into <base>, and never merges.``
- The in-place clause is today's `COMMIT_RULE`, unchanged.
- The token-refusal message, byte for byte: `the finish mode and base are set by the sheet's pickers — remove --finish and --base from the prompt`
- Settings copy: row name `Execute finish`, option labels `In place` / `PR`, hint `PR mode works in its own worktree, reviews, pushes and opens a PR. It never merges.`
- A stored base is forbidden: the sheet's base select seeds to the literal `'main'` every open.
- pr finish is legal in files and tracker projects alike — no source gate.
- Comments explain *why*, at the density of the surrounding code; new prose wraps at 160 columns (CLAUDE.md conventions).
- CI runs the full suite. Locally run only the suites each task names (`CLAUDE.md`: "never re-run the whole `pnpm test` locally just before a push").
- `skills/` changes reach nobody until commit → push → `pnpm run plugin:sync` (invariant); nothing in this plan pushes.

## Review Focus

1. **An old client** (a tab open from before the deploy) sends no `finish` and a prompt that still ends with `COMMIT_RULE` from the old plan → dispatch
   treats it as in-place, appends `COMMIT_RULE` again (doubled sentence, harmless) and never 400s. Pinned in Task 3.
2. **The branch list fetch fails** → the base select holds `main` only and the launch still works. Pinned in Task 4.
3. **A token-like word that is not a flag** — a body mentioning `--finished` or `base64` → not refused. Pinned in Task 3.
4. **Flipping finish back to In place after picking a base** → no `base` is sent. Pinned in Task 4.
5. **A stored `executeDefaultFinish` that is junk** (`'merge'`, `7`, missing) → clamps to `'in-place'`. Pinned in Task 4.

---

### Task 1: Shared vocabulary and `finishClause`

**Files:**
- Modify: `shared/types.ts` (beside `MergeMode`/`MERGE_MODES` ~1093–1110; `AgentDispatchRequest` ~902–919)
- Modify: `shared/agent.ts` (beside `isMergeMode` ~47; beside `COMMIT_RULE` ~854)
- Test: `test/agents-shared.test.ts`

**Interfaces:**
- Produces: `type ExecuteFinish = 'in-place' | 'pr'` and `EXECUTE_FINISHES: readonly ExecuteFinish[]` (`['in-place', 'pr']`) in `shared/types.ts`;
  `isExecuteFinish(value: unknown): value is ExecuteFinish` and `finishClause(finish: ExecuteFinish, base: string): string` in `shared/agent.ts`;
  `AgentDispatchRequest.finish?: ExecuteFinish` and `AgentDispatchRequest.base?: string`.
- `PR_FINISH_RULE` stays for now (Task 3 removes it).

- [ ] **Step 1: Write failing tests** in `test/agents-shared.test.ts`, a new `describe('finishClause')`:
  - `finishClause('in-place', 'develop')` equals `COMMIT_RULE` exactly (base ignored).
  - `finishClause('pr', 'main')` equals the Global Constraints pr sentence with `main` in both places.
  - `finishClause('pr', 'release/1.x')` contains `--finish pr --base release/1.x` and `into release/1.x`.
  - `isExecuteFinish`: true for `'in-place'`, `'pr'`; false for `'merge'`, `''`, `undefined`, `7`, `'PR'`.
  - `EXECUTE_FINISHES` equals `['in-place', 'pr']`.
- [ ] **Step 2:** `pnpm run test:jest -- test/agents-shared.test.ts` → FAIL (not exported).
- [ ] **Step 3: Implement** the four exports and the two optional request fields, each with a doc comment saying why (the clause is shared so the sheet's
  preview and the sent prompt cannot drift; the request fields are optional so an older client reads as in-place).
- [ ] **Step 4:** same command → PASS; `pnpm run typecheck` → clean.
- [ ] **Step 5: Commit** `feat(agents): finishClause and the execute finish vocabulary`.

### Task 2: The skill reads `--finish` from the trigger; `backlog.mjs config` goes

**Files:**
- Modify: `skills/backlog-execute/SKILL.md` (description ~6; "Finish mode" ~65–82; hard-limits bullet ~369)
- Modify: `skills/backlog-execute/references/pr-mode.md` (intro before §1, and §1 "Resolve the mode")
- Modify: `skills/backlog/tools/backlog.mjs` — delete the `config` block (~2188–2361: `CONFIG_FILE`, `CONFIG_REL`, `CONFIG_USAGE`,
  `EXECUTE_FINISH_MODES`, `configRefusal`, `parseExecuteConfig`, `remoteDefaultBranch`, `remindToCommitConfig`, `CONFIG_SETTERS`, `runConfig`) and the
  dispatch line `if (cmd === 'config') …` (~3830), the `config` line of the usage listing (~2177), and the explanatory comment above the block (~2188–2192)
- Modify: `skills/backlog/tools/backlog.test.mjs` — delete the config block (its comment at ~6193 through end of file, ~6402) and `parseExecuteConfig`
  from the import line 8
- Modify: `skills/backlog/SKILL.md` (~107–118, the `config` paragraph)
- Modify: `agents/backlog-reviewer.md` (~6, ~54, ~73: "a project whose (committed) finish mode is `pr`" / "the project's configured base" → a session started with `--finish pr` / the run's `<base>`)
- Modify: `skills/backlog-orchestrate/SKILL.md` (~27, ~764: same rewording, only where they name the committed mode)
- Test: `test/agents-shared.test.ts` (the guard ~836–840)

**Interfaces:**
- Consumes: `finishClause` (Task 1) — the guard test renders `finishClause('pr', '<base>')`.

**Skill behaviour to write** (SKILL.md "Finish mode", replacing the `backlog.mjs config` call):
- Skip entirely under an `[orchestrator-run` marker (unchanged).
- Read the trigger once, before `show`: `--finish pr` → pr mode; `--finish in-place` or no `--finish` → in-place, unannounced; any other `--finish` value →
  stop naming the two legal values; both `--finish pr` and `--finish in-place` present → stop naming both; never fall back.
- `--base <ref>` → `<base>`. Absent → `git symbolic-ref --short refs/remotes/origin/HEAD` with the `origin/` prefix stripped, else `main` (a local git read,
  no `backlog.mjs` helper — so no exit-5 exception is needed). `--base` in in-place mode → ignored, with one line saying so.
- Announce `finish mode: pr → PR into <base>`; ask nothing.
- The `--finish pr` token is the one signal, typed or inside the board's clause. Quote the board's pr sentence as ``Finish with `--finish pr --base <base>`:
  the skill commits, reviews, pushes and opens the PR into <base>, and never merges.`` with the literal placeholder `<base>`, in **pr-mode.md §1** (the
  guard reads that file).
- Remove the `in place this time` override and every "committed config" / "config is not read" sentence. pr-mode.md §2 onward is unchanged.
- Description and hard-limits bullet: "unless the project's committed finish mode is pr" → "unless the trigger says `--finish pr`".

- [ ] **Step 1: Re-aim the guard** in `test/agents-shared.test.ts` ~836–840: keep the SKILL.md `IN_REVIEW_REASON` assertion; replace the
  `PR_FINISH_RULE` assertion with: `skills/backlog-execute/references/pr-mode.md`, whitespace-collapsed, contains `finishClause('pr', '<base>')`.
- [ ] **Step 2:** `pnpm run test:jest -- test/agents-shared.test.ts` → FAIL (pr-mode.md does not quote it yet).
- [ ] **Step 3:** Rewrite the skill text as above; delete the `config` code and its tests.
- [ ] **Step 4:** Same jest command → PASS. `pnpm run test:skills` → PASS (no `config` test left, no import of a removed name).
  `git grep -n "parseExecuteConfig\|remindToCommitConfig\|runConfig\|in place this time" -- skills agents` → empty.
- [ ] **Step 5: Commit** `feat(skills)!: backlog-execute takes --finish from the trigger, config verb removed`.

### Task 3: Server — the plan drops the clause, dispatch validates and appends it

**Files:**
- Modify: `server/src/agents/prompt.util.ts` — `composePrompt(item, action)` loses its `finish` parameter; for `execute` it returns head + instruction with
  **no** closing clause; groom/capture unchanged (`COMMIT_RULE` appended).
- Delete: `server/src/agents/finish-mode.util.ts`; remove its import and `readFinishMode(...)` call in `agents.service.ts` ~35 and ~391.
- Modify: `server/src/items/base-branch.util.ts` — add `proveBaseBranch(base: unknown, projectPath: string | undefined): Promise<string>`: the same checks and
  400 messages as `resolveBaseBranch` but with **no** `'main'` carve-out and no empty/undefined default (empty/undefined → the "not a valid branch name"
  400). `resolveBaseBranch` behaviour is unchanged (orchestrate and `uncommitted` still use it).
- Modify: `server/src/agents/agents.controller.ts` ~64–90 — forward `finish: body.finish` and `base: body.base`, unvalidated (comment: the service checks
  them, as `pickFrom` checks `model`).
- Modify: `server/src/agents/agents.service.ts` `dispatch` ~429 — validation and composition below.
- Modify: `shared/agent.ts` — delete `PR_FINISH_RULE` and update the `COMMIT_RULE` doc comment (~845–853) that names it.
- Modify: `shared/types.ts` — `AgentPlan.prompt` doc (~885): for execute, the body without its closing clause, which the sheet renders read-only.
- Test: `test/agents-dispatch.test.ts`, `test/agents-plan.test.ts`, `test/agents-prompt.test.ts` (rewrite the `describe('finish mode')` block ~316–413, its doc comment included, and drop the `readFinishMode` import line 4),
  `test/base-branch.test.ts`

**Interfaces:**
- Consumes: `isExecuteFinish`, `finishClause`, `AgentDispatchRequest.finish/base` (Task 1).
- Produces: `POST /api/agents/plan` execute prompt has no closing clause; `POST /api/agents/dispatch` accepts `finish`/`base` with the rules below.

**Dispatch rules, in this order** (after the existing prompt-required / `PROMPT_MAX` checks, which still run on the typed body):
1. `finish` present and not `isExecuteFinish` → 400 `finish must be in-place or pr`.
2. `finish` present and `req.action !== 'execute'` → 400 `finish applies only to execute`.
3. `base` present and effective finish is not `pr` → 400 `base applies only to finish pr`.
4. effective finish `pr` and `base` absent → 400 `base is required with finish pr`.
5. `req.action === 'execute'` and the body matches `/(^|\s)--(finish|base)(?=\s|=|$)/` → 400 with the Global Constraints refusal message.
6. Existing item lookup / derive / 409 checks as today.
7. Effective finish `pr` → `proveBaseBranch(req.base, item.projectPath)` (its 400s pass through).
8. Spawn with `prompt = body + ' ' + finishClause(finish, base)` for execute; groom/capture send the body unchanged.

- [ ] **Step 1: Failing tests.**
  - `agents-prompt.test.ts`: execute prompt ends with the instruction sentence ("…Report what you changed.") and contains neither `COMMIT_RULE` nor
    `--finish`; groom and capture still end with `COMMIT_RULE`; no test references `readFinishMode` or a third `composePrompt` argument.
  - `agents-plan.test.ts`: the plan for a groomed task returns that clause-less prompt.
  - `agents-dispatch.test.ts` (spy on the spawn the suite already stubs), one case per rule:
    - no `finish`, execute → spawned prompt ends with `COMMIT_RULE` (an old client's body that already ends with `COMMIT_RULE` → spawned prompt ends with
      it twice, status 200 — Review Focus 1).
    - `finish: 'in-place'` → ends with `COMMIT_RULE`, no `--finish` in the spawned prompt.
    - `finish: 'pr', base: 'main'` in a fixture repo whose `main` exists → ends with `finishClause('pr', 'main')`.
    - `finish: 'pr', base: 'develop'` with a real local `develop` → ends with `finishClause('pr', 'develop')`.
    - `finish: 'merge'` → 400 rule 1; `finish: 'pr'` on a groom item → 400 rule 2; `finish: 'in-place', base: 'main'` → 400 rule 3; `finish: 'pr'` no base
      → 400 rule 4.
    - body `"... --finish pr"`, `"--base=develop ..."`, `"--finish"` alone → 400 rule 5, exact message; body mentioning `--finished` or `base64` → 200
      (Review Focus 3); a groom body containing `--base x` → not refused by rule 5.
    - `finish: 'pr', base: 'main'` in a fixture repo whose trunk is `master` (no `main`) → 400 `base must be an existing local branch — "main" is not a branch
      in this project`; `base: 'nope'` → the same message with `"nope"`.
    - Every 400 above spawns nothing.
  - `base-branch.test.ts`: `proveBaseBranch('main', repoWithoutMain)` → 400; `proveBaseBranch('main', repoWithMain)` → `'main'`; `proveBaseBranch('', …)`
    and `proveBaseBranch(undefined, …)` → 400 "not a valid branch name"; `resolveBaseBranch('main', repoWithoutMain)` still → `'main'` (unchanged).
- [ ] **Step 2:** `pnpm run test:jest -- test/agents-prompt.test.ts test/agents-plan.test.ts test/agents-dispatch.test.ts test/base-branch.test.ts` → FAIL.
- [ ] **Step 3: Implement** as above. Comments: why the clause sits outside the editable body (an edit must not contradict the picker), why `main` is proved
  here but not in orchestrate (always appended vs. appended-only-when-not-main), why rule 5 exists.
- [ ] **Step 4:** Same command → PASS; also `test/agents-shared.test.ts test/tracker-dispatch.test.ts test/agents-client.test.ts`; `pnpm run typecheck`.
- [ ] **Step 5: Commit** `feat(agents): dispatch appends the execute finish clause from validated fields`.

### Task 4: Client — Settings default and the launch-sheet pickers

**Files:**
- Modify: `client/src/lib/settings.ts` — `Settings.executeDefaultFinish: ExecuteFinish` (doc comment beside `orchestrateDefaultMergeMode` ~116), default
  `'in-place'` in `DEFAULT_SETTINGS`, clamped in `clampSettings` via `pickOne(…, EXECUTE_FINISHES, …)`.
- Modify: `client/src/components/settings/SettingsView.tsx` `DispatchGroup` ~510 — one `SettingsRow` + `Select` with the Global Constraints copy.
- Modify: `client/src/components/board/LaunchSheet.tsx` — the pickers, clause line and request fields below.
- Test: `test/settings.test.ts`, `test/settings-view.test.tsx`, `test/launch-sheet.test.tsx`

**Interfaces:**
- Consumes: `ExecuteFinish`, `EXECUTE_FINISHES`, `finishClause` (Task 1); `fetchBranches(project)` (`client/src/lib/agents.ts:571`); `item.projectPath`;
  the clause-less execute plan prompt (Task 3).

**LaunchSheet behaviour:**
- Only when `plan.action === 'execute'`: a `Finish` select (`In place` / `PR`) seeded from `settings.executeDefaultFinish`; under PR, a `Base` select
  with options from `fetchBranches(item.projectPath)` via `useFetched` keyed on `[item.projectPath]`, seeded `'main'`, falling back to `['main']` on failure
  or empty, never blocking the launch (copy the Orchestrate sheet's base-picker comment reasoning, cite it).
- A read-only line under the prompt textarea showing `finishClause(finish, base)`; updates when either select changes; never re-fetches the plan or
  touches the typed prompt.
- Dispatch: execute sends `finish` always and `base` only when `finish === 'pr'`; groom/capture send neither key.
- Header comment cites the `.claude/DESIGN.md` subsection the existing selects use.

- [ ] **Step 1: Failing tests.**
  - `settings.test.ts`, new `describe('executeDefaultFinish')`: `{}` → `'in-place'`; `'pr'` → `'pr'`; `'merge'`, `7`, `'PR'` → `'in-place'` (Review Focus 5).
  - `settings-view.test.tsx`: the Dispatch group shows `Execute finish` with options `In place` and `PR`; picking `PR` stores
    `executeDefaultFinish: 'pr'` under `SETTINGS_STORAGE_KEY`.
  - `launch-sheet.test.tsx` (mock `fetchAgentPlan`, `dispatchAgent`, `fetchBranches` as the suite already mocks the first two):
    - execute plan, default settings → Finish shows `In place`, no Base select, clause line equals `COMMIT_RULE`; launch sends `finish: 'in-place'` and no
      `base` key.
    - stored `executeDefaultFinish: 'pr'`, branches `['main', 'develop']` → Finish shows `PR`, Base shows `main`, clause line equals
      `finishClause('pr', 'main')`; pick `develop` → line updates; launch sends `finish: 'pr', base: 'develop'`.
    - PR → pick `develop` → back to In place → launch sends `finish: 'in-place'` and no `base` (Review Focus 4).
    - `fetchBranches` rejects → Base offers only `main`, launch still sends `base: 'main'` (Review Focus 2).
    - typing in the prompt then flipping Finish keeps the typed text; `fetchAgentPlan` called once.
    - groom plan → no Finish select, no clause line; launch body has no `finish` and no `base` key.
- [ ] **Step 2:** `pnpm run test:jest -- test/settings.test.ts test/settings-view.test.tsx test/launch-sheet.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Same command → PASS; also `test/dialog-escape.test.tsx test/dispatch-button.test.tsx`; `pnpm run typecheck`.
- [ ] **Step 5: Commit** `feat(board): execute finish picker and Settings default`.

### Task 5: Docs, rules and invariants sweep

**Files:**
- Modify: `CLAUDE.md:127` and `.claude/rules/skills.md:19` — the exit-5 headline loses `backlog.mjs config` **in both, byte-equal**:
  "…say so with exit `5` — save `jira.mjs worktree`."; in `skills.md` drop "every command but `config`" (~21, → "every command") and the two `config`
  sentences (~23–24).
- Modify: `.claude/rules/orchestrator.md` ~35–36 — "only when the project's committed `backlog/config.json` says `execute.finish: pr`" → "only when its
  trigger says `--finish pr`".
- Modify: `.claude/rules/dispatch-watchdog.md` ~16 and ~54 — "taken outright" gains its one exception: an execute's finish clause is appended server-side from
  validated `finish`/`base`, and a body spelling either flag is a 400.
- Modify: `docs/subsystems/invariants.md` — **replace** the ~459–460 committed-file reasoning with the trigger-flag reasoning (spec "Invariants this
  changes"); rewrite ~3944 ("every command but `config`") and ~3972–3978 (the `config` verb) under the same anchor; ~1456 to match; the
  "orchestrate and Jira spawn prompts are composed server-side" entry notes execute's finish clause as a third server-composed piece.
- Modify: `docs/subsystems/skills.md` (~17, ~34–42, the `config` row ~113), `docs/overview.md` ~110, `docs/subsystems/api.md` ~180–181 (the plan's
  execute prompt has no closing clause; dispatch takes `finish`/`base`) and `docs/subsystems/board.md` ~130 (the launch sheet's Finish/Base pickers and clause line), plus ~143 if it lists the keys the sheet reads.
- Test: `test/claude-rules.test.ts`

- [ ] **Step 1:** Edit as above. Wrap new prose at 160; do not reflow untouched lines.
- [ ] **Step 2:** `pnpm run test:jest -- test/claude-rules.test.ts` → PASS (headlines byte-equal, one home per anchor).
- [ ] **Step 3: Sweep** — the spec's grep must be empty outside `docs/superpowers/`, except `tsconfig.json`/git-`config` hits:
  `git grep -n -i "config\.json\|execute\.finish\|execute\.base\|parseExecuteConfig\|readFinishMode\|in place this time\|backlog\.mjs config\|\"finish\":\"pr\"\|PR_FINISH_RULE\|committed config\|config is not read\|committed finish mode\|project's finish mode\|whose finish mode\|but \`config\`" -- ':!docs/superpowers'`
  Expected: only `docker-compose.yml`, `docs/workflows/development.md` and `tsconfig.build.json` (tsconfig mentions).
- [ ] **Step 4:** `pnpm run typecheck`; `pnpm run test:jest -- test/agents-shared.test.ts test/claude-rules.test.ts`.
- [ ] **Step 5: Commit** `docs: execute finish mode is a trigger flag and a picker`.
