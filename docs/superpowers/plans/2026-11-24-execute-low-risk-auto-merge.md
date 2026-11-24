# Execute low-risk auto-merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Plan convention (overrides the writing-plans template):** this plan specifies behaviour, signatures and exact test cases — never literal code. Where a
> test value or a copy string appears, it is exact and comes from the spec; everything else (bodies, helper names inside a file, test scaffolding) is the
> implementer's call, and an implementer who thinks a step is wrong should say so rather than transcribe it. Size is a soft budget, never a reason to drop a
> rule.

**Goal:** `backlog-execute --finish pr --low-risk-auto-merge` classifies its own PR diff and, when it is docs-only, tests-only or a small patch, runs the
existing auto-merge + fix flow; the board and the tick can turn it on.

**Architecture:** A deterministic node classifier (`skills/backlog-execute/tools/low-risk.mjs`) decides from `git diff --raw/--numstat` against
`origin/<base>`. The flag travels like `--auto-merge` does: dispatch body → `finishClause` → prompt → skill (pr-mode §8). The tick appends it from a new
`tick.json` boolean. Board switches seed from Settings.

**Tech Stack:** Node ESM CLIs with `node --test`; NestJS server + React client with jest; markdown skill procedures.

**Spec:** `docs/superpowers/specs/2026-11-24-execute-low-risk-auto-merge-design.md` — read it in full first; every string below is quoted from it, and
where this plan and the spec disagree, the spec wins and the disagreement is a bug to report.

## Global Constraints

- Flag spelling `--low-risk-auto-merge`; body / `FinishFlags` / `tick.json` key `lowRiskAutoMerge`; Settings key `prLowRiskAutoMergeDefault`. Never
  `--auto-merge-low-risk`.
- Default **off** everywhere (Settings, `tick.json`, absent body field).
- Explicit `autoMerge` / `--auto-merge` wins: with both, behaviour and clause are today's auto-merge ones.
- Every doubt in the classifier is **not low-risk**.
- Patch limits: ≤ 3 files, ≤ 40 changed lines (whole diff), no added file. Tick lock-TTL floor: 180 minutes.
- Comments explain *why*, at the repo's existing density. Authored prose wraps at 160 columns.
- Before editing a file under a `.claude/rules/` glob without `Read`ing it, read that rule file (repo CLAUDE.md, "Rule files").
- Jest suites live in `test/<feature>/`; node suites sit beside the tool (`skills/*/tools/*.test.mjs`, picked up by `pnpm run test:skills`).
- Skill edits take effect only after commit + push + `pnpm run plugin:sync` — not part of this plan's verification (held for the user).

## Review Focus

1. **A files-project PR whose only non-`backlog/` change is a README edit** — must classify `docs`, not fail on the item's `open/ → done/` rename.
   → Task 1 test "backlog/ entries are ignored".
2. **A diff where local `<base>` is ahead of `origin/<base>`** — the unpushed base commits are in the PR and must be judged. → Task 1 CLI test
   "judges against origin/<base>, not local <base>".
3. **An older tab / older client sending no `lowRiskAutoMerge`** — dispatch must behave exactly as today. → Task 3 test "absent field → today's clause".
4. **Toggling Auto-merge on then off in the sheet** — the low-risk switch must come back to its own previous value, not stick on or get cleared.
   → Task 4 launch-sheet test.
5. **A hand-edited `tick.json` with `"lowRiskAutoMerge": "true"`** — reads as `false` in both readers. → Task 5 and Task 6 tests.

---

### Task 1: The classifier CLI

**Files:**
- Create: `skills/backlog-execute/tools/low-risk.mjs`
- Create: `skills/backlog-execute/tools/low-risk.test.mjs`

**Interfaces:**
- Produces: `classify(entries) → { lowRisk: boolean, category: 'docs'|'tests'|'patch'|null, reason: string, files: number, lines: number }` (pure;
  exported), where each entry is `{ status: string, path: string, oldPath?: string, oldMode: string, newMode: string, added: number|null, deleted:
  number|null }` (`null` = binary). CLI `node low-risk.mjs --base <base>` run in a git tree: `git fetch origin <base>`, merge-base of `HEAD` and
  `origin/<base>`, `git diff --raw -M` + `--numstat -M` from it to `HEAD`, prints one JSON line of `classify`'s result, exit 0 for either verdict, non-zero
  only for usage (missing `--base`). Any git failure → `{ lowRisk: false, category: null, reason: 'git: <first stderr line>', files: 0, lines: 0 }`, exit 0.
- Follow the repo's `isMain` main-guard twin (`skills/backlog/tools/backlog.mjs:3846`). `scripts/run-as-main.test.mjs:27-36` lists one row per tool and
  `:94` walks every `skills/*/tools` dir for files carrying the guard, so add a row: `script: 'skills/backlog-execute/tools/low-risk.mjs', args: [],
  status: 2, output: 'usage: low-risk.mjs'`. Missing `--base` → exit 2 with stderr `usage: low-risk.mjs --base <base>`.
- The CLI ends `process.exitCode = main(...)` (synchronous; `.claude/rules/skills.md` "Every skill CLI ends with…"), and `low-risk.mjs` joins both
  `CLI_SOURCES` (`skills/backlog/tools/backlog.test.mjs:3702`) and `ENTRY_SHAPES` (`:3745`, as `['process.exitCode = main(']`).

- [ ] **Step 1: Write the failing tests** (`classify` table, then two CLI tests in a temp git repo with an `origin` remote)

  `classify` cases — each asserts the exact `{lowRisk, category, reason}`:
  - `[]` → `false, null, 'empty diff'`.
  - only `backlog/bugs/open/x.md → backlog/bugs/done/x.md` (`R`) → `false, null, 'empty diff'` (backlog/ ignored).
  - `R backlog/...` + `M README.md` 3+1 → `true, 'docs'`, files 1, lines 4 ("backlog/ entries are ignored").
  - `M docs/guide.md` 500+200 → `true, 'docs'` (no size limit).
  - `M docs/conf.py` 1+1 → `true, 'patch'` (not docs: no directory clause).
  - `M CMakeLists.txt` 1+0 → `true, 'patch'`; `M LICENSE.txt` 900+0 → `true, 'docs'`; `M license` 900+0 → `true, 'docs'` (case-insensitive, no ext).
  - `M CLAUDE.md` 1+0 → `true, 'patch'`; `M sub/AGENTS.md` 80+0 → `false, null, '80 lines, patch limit 40'`; `M agents/x.md` 2+0 → `true, 'patch'`.
  - `M test/a.test.ts` 300+10 + `M README.md` 5+0 → `true, 'tests'`; `A src/foo.spec.ts` 50+0 → `true, 'tests'`; `A tests/test_x.py` → `tests`.
  - `M test/jest.config.ts` 1+0 → `true, 'patch'` (runner config is not a test file); `M test/setup-env.ts` 1+0 → `patch`; `M conftest.py` → `patch`.
  - `M src/a.ts` 12+3, `M src/b.ts` 4+1, `M README.md` 10+0 → `true, 'patch'`, files 3, lines 30.
  - same plus `A test/a.test.ts` 5+0 → `false, null, 'test/a.test.ts added'`.
  - 4 × `M src/*.ts` 1+0 → `false, null, '4 files, patch limit 3'`; `M src/a.ts` 30+11 → `false, null, '41 lines, patch limit 40'`; 30+10 → `patch`.
  - `M assets/logo.png` binary → `'assets/logo.png is binary'`; `D src/a.ts` → `'src/a.ts deleted'`; `R src/a.ts → src/b.ts` → `'src/a.ts renamed'`;
    `C` → `'<old> copied'`; `T` → `'<path> changed type'`; `U` → `'<path> unmerged'`; `X` → `'<path>: status X'`.
  - `M vendor/lib` modes `160000` → `'vendor/lib is a submodule'`; `A link` mode `120000` → `'link is a symlink'`; `M run.sh` `100644→100755` 0+0 →
    `'run.sh mode changed'`; `A new.md` `000000→100644` → `docs` (an add's `000000` old mode is regular).
  - deny list, each `'<path> is never low-risk'`: `package.json`, `packages/x/package.json`, `pnpm-lock.yaml`, `requirements-dev.txt`, `Gemfile.lock`,
    `composer.json`, `.github/workflows/ci.yml`, `.gitlab-ci.yml`, `Dockerfile.prod`, `docker-compose.dev.yml`, `db/migrations/001.sql`,
    `src/migrate/x.ts`, `.env.local`, `config/.env`, `.claude/rules/x.md`, `skills/foo/SKILL.md`. And `docs/skills/x.md` is **not** denied (top-level
    only) → `docs`; `.github` nested as `a/.github/x.md` → `docs`.
  - Order: binary beats deny (`package.json` binary → `is binary`); deny beats docs (`.github/x.md` → `never low-risk`); added beats files beats lines.
    The scan is rule-major, not file-major: `D src/a.ts` + binary `b.png` → `'b.png is binary'`; `D package.json` → `'package.json deleted'`;
    `M package.json` `100644→100755` → `'package.json mode changed'`.
  - `M src/backlog/x.ts` 50+0 → `'50 lines, patch limit 40'` (only the TOP-LEVEL `backlog/` is ignored).

  CLI cases:
  - "judges against origin/<base>, not local <base>": temp repo, `origin` a bare clone; commit `src/x.ts` (50 lines) on local `main` only (not pushed); cut
    a branch, edit `README.md`; run with `--base main` → `lowRisk: false`, reason `'src/x.ts added'`, `files: 2` (the unpushed `src/x.ts` is an add against
    `origin/main`, and added beats files and lines).
  - unknown base (`--base nope`) → exit 0, `lowRisk: false`, reason starts `git: `. Missing `--base` → non-zero exit.

- [ ] **Step 2: Run** `node --test skills/backlog-execute/tools/low-risk.test.mjs` — expected FAIL (module missing).
- [ ] **Step 3: Implement** `classify` and the CLI. Parse `--raw -z`/`--numstat -z` (paths with spaces/renames); join by path. Order of checks exactly as the
  spec's "The `reason` names the first failing rule" paragraph.
- [ ] **Step 4: Run** the same command — PASS; then `node --test` on `skills/backlog-execute/tools/low-risk.test.mjs`, `scripts/run-as-main.test.mjs` and
  `skills/backlog/tools/backlog.test.mjs` — PASS.
- [ ] **Step 5: Commit** `feat(skills): low-risk diff classifier for backlog-execute`.

### Task 2: Shared vocabulary — `FinishFlags`, `finishClause`, `FINISH_FLAG`, dispatch type, pr-mode §1 quote

**Files:**
- Modify: `shared/types.ts:1934-1939` (`FinishFlags`), `shared/types.ts:1564-1592` (`AgentDispatchRequest`: add `lowRiskAutoMerge?: boolean` beside `fix?`
  with a doc comment)
- Modify: `shared/agent.ts:951` (`FINISH_FLAG`), `shared/agent.ts:1030-1045` (`finishClause`)
- Modify: `skills/backlog-execute/references/pr-mode.md:35-47` (§1: mode line + third quoted sentence)
- Test: `test/agents/agents-shared.test.ts` (near `:860-875`)

**Interfaces:**
- Produces: `FinishFlags.lowRiskAutoMerge?: boolean`; `finishClause(action, 'pr', base, { lowRiskAutoMerge: true })` returns the spec's third sentence;
  `AgentDispatchRequest.lowRiskAutoMerge?: boolean`.

- [ ] **Step 1: Failing tests**
  - `finishClause('execute', 'pr', 'main', { lowRiskAutoMerge: true })` equals exactly: ``Finish with `--finish pr --base main --low-risk-auto-merge`: the
    skill commits, reviews, pushes and opens the PR into main, then arms GitHub auto-merge and fixes failing checks and conflicts with main only if the PR's
    diff is docs-only, tests-only or a small patch; the skill never merges itself.``
  - with a review override, the review flags follow `--low-risk-auto-merge` inside the backticks (same `reviewFlags` order as the auto-merge form).
  - `{ autoMerge: true, lowRiskAutoMerge: true }` → identical to `{ autoMerge: true }`; `{ autoMerge: true, fix: true, lowRiskAutoMerge: true }` → identical
    to `{ autoMerge: true, fix: true }`.
  - `finish: 'in-place'` with `lowRiskAutoMerge: true` → `COMMIT_RULE` (ignored, as `autoMerge` is).
  - `FINISH_FLAG.test('x --low-risk-auto-merge y')` true; `'x --low-risk-auto-merge-ish'` false; `'pre--low-risk-auto-merge'` false.
    `defuseFinishFlags('a --low-risk-auto-merge b')` contains no ASCII `--low-risk-auto-merge`.
  - pr-mode parity: `pr-mode.md` (whitespace-collapsed) contains `finishClause('execute', 'pr', '<base>', { lowRiskAutoMerge: true })`.
- [ ] **Step 2: Run** `pnpm run test:jest test/agents/agents-shared.test.ts` — FAIL.
- [ ] **Step 3: Implement.** `FINISH_FLAG` alternation gains `low-risk-auto-merge` (the existing lookarounds stay). pr-mode §1: mode line gains
  `, auto-merge if low-risk`; add the third ``Finish with …`` sentence beside the two existing ones, saying it is the sheet's "auto-merge if low-risk" form.
- [ ] **Step 4: Run** the suite — PASS. Then `grep -l "FINISH_FLAG\|finishClause\|defuseFinishFlags" test/` and run every hit (`agents-prompt`,
  `agents-dispatch*`, `launch-sheet`) — PASS.
- [ ] **Step 5: Commit** `feat(shared): low-risk auto-merge finish flag`.

### Task 3: Dispatch — validate, forward, rule-8 text

**Files:**
- Modify: `server/src/agents/agents.controller.ts:92-100` (forward `lowRiskAutoMerge: body.lowRiskAutoMerge`, comment beside `autoMerge`)
- Modify: `server/src/agents/agents.service.ts:449-490` (rules + numbered comment), `:520-524` (rule-8 text), `:655` (pass the flag into
  `appendFinishClause`)
- Modify: `.claude/rules/dispatch-watchdog.md` (wherever it lists the finish flags / `autoMerge`/`fix` body fields)
- Test: `test/agents/agents-dispatch.test.ts`, `test/agents/agents-dispatch-remote.test.ts`

**Interfaces:**
- Consumes: Task 2's `FinishFlags.lowRiskAutoMerge`, the dispatch type field.

- [ ] **Step 1: Failing tests** (exact `error` strings from the spec):
  - `lowRiskAutoMerge: 'yes'` → 400 `lowRiskAutoMerge must be a boolean`.
  - groom (home machine, finish pr) with `lowRiskAutoMerge: true` → 400 `lowRiskAutoMerge applies only to execute`.
  - execute `finish: 'in-place'` (or none) with `lowRiskAutoMerge: true` → 400 `lowRiskAutoMerge applies only to finish pr`.
  - `lowRiskAutoMerge: false` anywhere (groom, in-place) → accepted, as an untouched toggle.
  - execute `finish: 'pr', base: 'main', lowRiskAutoMerge: true` → 201, spawned prompt ends with the Task 2 sentence.
  - same with `autoMerge: true, fix: true` too → prompt ends with today's auto-merge-and-fix sentence.
  - "absent field → today's clause": execute pr with no `lowRiskAutoMerge` → prompt ends with today's plain pr sentence.
  - remote execute (Pro) with `lowRiskAutoMerge: true` → 201 and the sent prompt ends with the Task 2 sentence.
  - a prompt containing `--low-risk-auto-merge` → 400 with exactly `the finish mode, base, auto-merge and fix are set by the sheet's pickers — remove
    --finish, --base, --auto-merge, --fix and --low-risk-auto-merge from the prompt`; update any existing test pinning the old four-flag text.
- [ ] **Step 2: Run** `pnpm run test:jest test/agents/agents-dispatch.test.ts test/agents/agents-dispatch-remote.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Order of the new checks: the non-boolean check beside rules 4; "only to execute" before "only to finish pr" (a groom hears the
  action rule first).
- [ ] **Step 4: Run** the two suites plus `test/agents/agents-dispatch-desktop.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(server): dispatch carries lowRiskAutoMerge`.

### Task 4: Board — Settings row and launch-sheet switch

**Files:**
- Modify: `client/src/lib/settings.ts:~144-160` (field + doc), `:~218` (default `false`), `:~410` (`pickBool` clamp)
- Modify: `client/src/components/settings/SettingsView.tsx:476-495` (new row after "Fix if it fails")
- Modify: `client/src/components/board/LaunchSheet.tsx:129-146` (state + seeding), `:198` (body), `:303` (clause preview), `:330-350` (third row)
- Test: `test/settings/settings.test.ts`, `test/settings/settings-view.test.tsx`, `test/agents/launch-sheet.test.tsx`

**Interfaces:**
- Consumes: Task 2's `finishClause` third form; the body field from Task 2/3.

- [ ] **Step 1: Failing tests**
  - settings: default `prLowRiskAutoMergeDefault === false`; a stored `"true"` string clamps to `false`; stored `true` survives.
  - settings view: row `name` "Auto-merge low-risk PRs", hint "preselects Auto-merge if low-risk on an execute PR launch", `more` "Only when the PR is
    docs-only, tests-only or a patch of at most 3 files and 40 lines — then the session arms auto-merge and fixes failures.", switch label "auto-merge
    low-risk PRs"; never disabled, whatever `prAutoMergeDefault` is; toggling writes the key.
  - launch sheet, execute, PR finish, setting on: switch "auto-merge if low-risk" checked; visible text `auto-merge if low-risk — only a docs-only,
    tests-only or small-patch PR arms auto-merge and fix`; clause preview shows the Task 2 sentence; dispatch body has `lowRiskAutoMerge: true`,
    `autoMerge: false`.
  - setting off → unchecked, body `lowRiskAutoMerge: false`.
  - Auto-merge on → low-risk switch disabled, checked, `title` "Auto-merge is on: every PR arms it", body `lowRiskAutoMerge: false`, `autoMerge: true`.
  - Review Focus 4: low-risk off → Auto-merge on → Auto-merge off → low-risk unchecked; low-risk on → Auto-merge on → off → low-risk checked and body true.
  - finish In place → no low-risk row, body has no `lowRiskAutoMerge` key (or `false` — match how `autoMerge` is sent today); back to PR → re-seeded from
    Settings.
  - groom launch with PR finish → no low-risk row.
- [ ] **Step 2: Run** `pnpm run test:jest test/settings/settings.test.ts test/settings/settings-view.test.tsx test/agents/launch-sheet.test.tsx` — FAIL.
- [ ] **Step 3: Implement**, following `.claude/rules/board.md` and `.claude/DESIGN.md` §8.2/§8.6; seed during render keyed on `isPr` like `autoMerge`/`fix`.
- [ ] **Step 4: Run** the three suites — PASS; `grep -l "prAutoMergeDefault\|LaunchSheet" test/` and run every hit — PASS; `pnpm run typecheck` — clean.
- [ ] **Step 5: Commit** `feat(board): auto-merge if low-risk switch and setting`.

### Task 5: Tick settings on the server and in Settings › Shared

**Files:**
- Modify: `shared/types.ts:3199-3205` (`TickConfig.lowRiskAutoMerge: boolean`)
- Modify: `server/src/tick/tick-breaker.util.ts:93-185` (`TickFileRead` ok shape, `readTickFile`, `writeTickFile` patch + carry-over)
- Modify: `server/src/tick/tick.service.ts:21-22` (`TickConfigPatch` gains it), `:119-131` (payload config)
- Modify: `server/src/tick/tick.controller.ts:21-45` (`CONFIG_KEYS` handling: numbers stay integer-checked, the boolean is boolean-checked)
- Modify: `client/src/lib/ticks.ts:14` (`TickConfigPatch` gains it), `:22-28` (`isTicksPayload` also requires `typeof config.lowRiskAutoMerge ===
  'boolean'` — the server always sends it), `client/src/components/settings/TickGroup.tsx` (row after "Open execute PRs")
- Modify: `.claude/rules/tick.md` (file shape, "any non-empty subset of the four", boolean edge cases, both readers)
- Test: `test/tick/tick-breaker.test.ts`, `test/tick/tick-routes.test.ts`, `test/settings/settings-tick.test.tsx`

- [ ] **Step 1: Failing tests**
  - read: missing file → `lowRiskAutoMerge: false`; file `{ "lowRiskAutoMerge": true }` → `true`; `"true"`, `1`, absent → `false` (Review Focus 5).
  - write: patch `{ lowRiskAutoMerge: true }` on a file with `maxPrs: 5` → file has both; a later patch `{ maxPrs: 4 }` keeps `lowRiskAutoMerge: true`;
    then patch `{ lowRiskAutoMerge: false }` → file has `false` (a truthiness carry-over would keep `true`).
  - POST `{ lowRiskAutoMerge: false }` alone over a `true` file → 200 and the payload's `config.lowRiskAutoMerge === false`.
  - `ticks-lib`: `isTicksPayload` rejects a payload whose `config` lacks `lowRiskAutoMerge` or carries `"true"` (`test/tick/ticks-lib.test.ts`).
  - unreadable file → GET `config.lowRiskAutoMerge === false`, `source: 'unreadable'`; POST `{ lowRiskAutoMerge: true }` → 409, file byte-identical.
  - POST `{ lowRiskAutoMerge: true }` alone → 200 (not `nothing to set`); `{ lowRiskAutoMerge: 'true' }` → 400 `lowRiskAutoMerge must be a boolean`;
    `{ maxPrs: 1.5 }` → 400 `maxPrs must be an integer` (unchanged); `{}` → 400 `nothing to set` (unchanged).
  - TickGroup: row name "Auto-merge low-risk PRs", hint "ticked executes arm auto-merge and fix when the PR is docs-only, tests-only or a small patch",
    switch label "Auto-merge low-risk PRs"; toggling POSTs exactly `{ lowRiskAutoMerge: <new> }`; unreadable source → switch disabled like the caps.
- [ ] **Step 2: Run** `pnpm run test:jest test/tick test/settings/settings-tick.test.tsx` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same — PASS; `pnpm run typecheck` — clean. The stricter `isTicksPayload` rejects fixtures without the field:
  `grep -ln "maxPlans\|useTicks" test/` (today also `test/board/poll-coalescing.test.tsx`, `test/agents/plan-review-chip.test.tsx`,
  `test/agents/plan-review-lib.test.ts`), give each `TicksPayload` fixture `lowRiskAutoMerge: false`, and run every hit — PASS.
- [ ] **Step 5: Commit** `feat(tick): lowRiskAutoMerge in tick.json and Settings`.

### Task 6: `tick.mjs` — read the setting, append the flag, report it

**Files:**
- Modify: `skills/backlog-tick/tools/tick-breaker.mjs:60-92` (`readTickSettings` returns `lowRiskAutoMerge`, boolean-only)
- Modify: `skills/backlog-tick/tools/tick.mjs:425-431` (read), `:486-488` (execute args + `say` extra field)
- Modify: `skills/backlog-tick/SKILL.md` (step 1's `decide` field list; step 4's closing paragraph carries the execute's `low-risk:` / `auto-merge:` lines)
- Modify: `skills/backlog-execute/references/backlog-tick.md:8-9` (args line gains the optional flag; the wait; "never merges" stays — GitHub merges)
- Modify: `.claude/rules/skills.md:~52` (tick "never leaves anything running" → states the armed-auto-merge and waiting-session exception)
- Test: `skills/backlog-tick/tools/tick-breaker.test.mjs`, `skills/backlog-tick/tools/tick.test.mjs`

- [ ] **Step 1: Failing tests**
  - `readTickSettings`: missing → `false`; `true` → `true`; `"true"` / `1` → `false` (twin of Task 5).
  - `decide`, setting on, default TTL, execute pick → args end `<id> --finish pr --low-risk-auto-merge [backlog-tick]` (marker last; with `--base x` →
    `--finish pr --base x --low-risk-auto-merge`), JSON line `lowRiskAutoMerge: true`.
  - setting off → args unchanged from today, field `false`.
  - setting on, `--lock-ttl 120` → args without the flag, field `"off: lock TTL 120 min < 180"`; `--lock-ttl 180` → flag present.
  - a `groom` verdict and an `idle` verdict with the setting on → no `lowRiskAutoMerge` key on the line.
  - `--dry-run` and `--peek` with an execute pick and the setting on → field `true`, nothing else changes vs today's dry-run output.
- [ ] **Step 2: Run** `node --test skills/backlog-tick/tools/tick-breaker.test.mjs skills/backlog-tick/tools/tick.test.mjs` — FAIL.
- [ ] **Step 3: Implement**; marker stays the last arg. Update the two skill docs and the rule file.
- [ ] **Step 4: Run** the same — PASS.
- [ ] **Step 5: Commit** `feat(tick): append --low-risk-auto-merge to ticked executes`.

### Task 7: The execute skill procedure

**Files:**
- Modify: `skills/backlog-execute/SKILL.md:80-92` (Finish mode: read the flag in the same pass; refused without `--finish pr` naming the rule; redundant
  beside `--auto-merge`; mode line `, auto-merge if low-risk`; ignored under `[orchestrator-run`), `:~414` (summary line)
- Modify: `skills/backlog-execute/references/pr-mode.md:288-330` (§8: new low-risk branch before "Last, with `--auto-merge`"; failure lines; final
  message — `low-risk:` line above the PR URL, URL last), `:350-352` (provenance: cite this spec)
- Modify: `skills/backlog-execute/references/auto-merge.md:1-5` (third caller)
- Modify: `docs/subsystems/skills.md` (backlog-execute's flags and the backlog-tick section's `tick.json` keys), `docs/subsystems/board.md` (launch sheet
  and Settings rows), `docs/subsystems/api.md` (dispatch body and `/api/ticks/config`), `docs/subsystems/invariants.md` (the auto-merge invariant entry),
  There is no separate tick doc: `grep -n "maxPrs\|auto-merge" docs/subsystems/` is the edit map.
- Modify: `.claude/rules/orchestrator.md:52-53` ("With `--auto-merge` either may then arm…" gains the low-risk route)
- Test: `test/agents/agents-shared.test.ts` (extend, beside the pr-mode pins at `:863-899`); `test/guards/claude-rules.test.ts` (run)

- [ ] **Step 1: Failing tests** (text guards, whitespace-collapsed):
  - `pr-mode.md` contains `node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-execute/tools/low-risk.mjs" --base <base>` (or the exact invocation form the file
    already uses for its other tools — match it), and each of the lines: `low-risk: no — <reason> — PR left open for review`,
    `low-risk: not checked — no PR`, `low-risk: not checked — classifier call denied — PR left open for review`,
    `low-risk: not checked — classifier failed:`, and the success line `low-risk: <category> (<files> files, <lines> lines) — arming auto-merge`.
  - `SKILL.md` contains `--low-risk-auto-merge` and `, auto-merge if low-risk`.
  - `auto-merge.md`'s first paragraph names `--low-risk-auto-merge`.
- [ ] **Step 2: Run** the guard suite — FAIL.
- [ ] **Step 3: Write the procedure.** §8 branch: only when the trigger carries `--low-risk-auto-merge` and not `--auto-merge`, after the PR is open and the
  tracker claim sequence ran; run the classifier in `<tree>`; low-risk → print the success line, then read `auto-merge.md` in full and run it as with
  `--auto-merge --fix`; otherwise print the matching line and finish as plain pr. Never re-run the classifier after a fix round. A tick-run execute is `ok`
  whatever auto-merge did. Docs: describe the flag where each doc lists `--auto-merge`/`--fix`.
- [ ] **Step 4: Run** the guard suite, `test/guards/claude-rules.test.ts`, and `pnpm run test:skills` scoped to `skills/backlog-execute/tools/*.test.mjs skills/backlog/tools/backlog.test.mjs`
  (the latter reads pr-mode.md) — PASS.
- [ ] **Step 5: Commit** `feat(skills): backlog-execute --low-risk-auto-merge`.

### Task 8: Visual check

- [ ] **Step 1:** Run `/ui-verify` on the launch sheet (execute, PR finish: low-risk on, Auto-merge on → disabled-on, In place → hidden) and the two
  Settings rows (Local › Auto-merge low-risk PRs; Shared › Backlog tick › Auto-merge low-risk PRs). No mocks: compare against the sibling rows' styling
  (`.claude/DESIGN.md` §8.2/§8.6) and check 375 px width for wrap/overflow.
- [ ] **Step 2:** Fix defects on the branch; commit `fix(board): …` per defect.
