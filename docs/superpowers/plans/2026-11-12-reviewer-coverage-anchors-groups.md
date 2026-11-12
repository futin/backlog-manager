# backlog-review: coverage, anchors, groups, incremental mode and a configurable reviewer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One review procedure — a new `/backlog-review` skill, also used by orchestrate §7 and execute pr-mode §7 — that splits a big diff into groups
reviewed in parallel, proves every changed file was covered, pins every finding to a quoted line, re-reviews incrementally, and runs on a reviewer
model/effort chosen in Settings or per launch.

**Architecture:** A deterministic node tool, `skills/backlog-review/tools/review.mjs` (`config`, `scope`, `merge`), does everything that can be computed:
the diff snapshot, the file list, the grouping, the per-group model, the state file, the coverage check, anchor resolution, de-duplication and the verdict.
The callers (the standalone skill, orchestrate, execute) only dispatch `backlog-reviewer` once per group in one message and feed the reports back to
`merge`. The server stores the reviewer config in `~/.backlog-manager/settings/review.json` and turns a launch override into trigger flags; the client edits
it in Settings → Shared and in the two launch sheets.

**Tech Stack:** Node ≥ the repo's floor (ESM, `node:test`), git CLI, NestJS, React + Vite, jest (+ jsdom), pnpm.

**Spec:** `docs/superpowers/specs/2026-11-12-reviewer-coverage-anchors-groups-design.md` (accepted after two review rounds; its §-numbers are cited below as
"spec §n").

**How to read this plan.** It gives behaviour, signatures, exact values and exact test cases — **not literal code**. Where a test is listed, its name and
assertions are the contract; write the body yourself. If the plan and the spec disagree, the spec wins and the disagreement is a plan defect to report. Size
budgets anywhere below are soft.

## Global Constraints

- `skills/` and `agents/` change nothing at runtime until commit, push and `pnpm run plugin:sync` (CLAUDE.md). Tests are the merge gate; the hand run is
  post-merge (Task 12).
- Skill tools import nothing from another skill's `tools/`, from `server/` or from `shared/`. Logic both sides need is a **twin** whose comment names the
  original (`.claude/rules/skills.md`). Here: the reviewer-config validator and defaults (`shared/agent.ts` ↔ `review.mjs`).
- A CLI ends with `process.exitCode = main(process.argv.slice(2))` behind the repo's `isMain` twin, and is listed in `CLI_SOURCES`
  (`skills/backlog/tools/backlog.test.mjs:3408`) **and** `ENTRY_SHAPES` (`:3447`, `'review.mjs': ['process.exitCode = main(']`);
  `scripts/run-as-main.test.mjs` gains a `ROWS` row `{ script: 'skills/backlog-review/tools/review.mjs', args: ['zzz-nope'], status: 1, output: 'unknown
  command: zzz-nope' }`, so its `exactly the nine scripts guard with isMain(import.meta.url)` count (derived from `ROWS`) becomes ten.
- `review.mjs` exit codes: **0** success (every verdict), **1** bad arguments, an unknown subcommand (`unknown command: <x>`) or an unreadable manifest —
  the same contract as `orchestrate.mjs`, which has no exit 2. Every "exit non-zero" below means exit 1.
- Every test that spawns `review.mjs` sets both `BM_REVIEW_HOME` and `BM_REVIEW_FILE` under its temp dir, so no test reads or writes the real
  `~/.backlog-manager`; temp-repo fixtures commit with `-c user.name=t -c user.email=t@t` (CI has no global git identity).
- Node tests sit flat beside the tool (`skills/backlog-review/tools/review.test.mjs`); jest tests flat in `test/`. A test that needs a git repo builds it in a
  temp dir under `os.tmpdir()` (the `scripts/test-tmpdir.mjs` runner gives each child its own root).
- The server never writes git; `review.mjs` is a skill tool and is allowed to write loose objects through a temporary `GIT_INDEX_FILE` — never a ref, never
  the real index, never the working tree.
- Closed lists, verbatim: models `opus`, `sonnet`, `haiku`, `fable` (plus unset = agent default); efforts `low`, `medium`, `high`, `xhigh`, `max` (plus unset
  = default). Skip reasons `lockfile`, `generated`, `binary`, `deleted`, `item`. Mode-fallback reasons `no earlier review`, `base changed`,
  `base moved — merged or rebased onto a newer base`, `history rewritten`, `earlier snapshot gone`. Verdicts `approve`, `fix`, `incomplete`.
- Thresholds (soft constants, one place each in `review.mjs`): split above **12** reviewable files or **1200** changed lines; cap **10** files / **800**
  lines per group; `smallMaxLines` default **300**, accepted range **1–10000**.
- Default reviewer config: `split`; big = agent default + default effort; small = `sonnet` + default effort; `smallMaxLines` 300.
- New prose wraps at 160 columns; commit bodies at 72. Comments explain why, at the repo's existing density.
- Inline styles in the client go through CSSOM, never a `style=` attribute or `<style>` element (CSP, CLAUDE.md).
- Run only the suites a task touches, plus every `test/` suite that `grep -l <symbol> test/` finds for a shared symbol the diff adds a caller of. CI runs the
  full suite.

## Review Focus

1. **A review run in a dirty main checkout with a file that is both staged and further modified.** The snapshot must contain the working-tree content, and
   the real index must still hold the staged content afterwards. → Task 2, test `snapshot keeps the real index's staged content`.
2. **Paths with spaces, renames and a file deleted in the work tree but present at HEAD.** A rename keeps `oldPath`; a working-tree deletion is `deleted`,
   not a crash. → Task 2, test `rename, space in path and work-tree deletion`.
3. **Two concurrent `/backlog-review` runs on one branch** (two terminals). The state file must never be half-written: `merge` writes it atomically
   (temp + rename), and a reader that finds an unparseable state file falls back to full with `no earlier review`. → Task 3, test
   `an unparseable state file is treated as no earlier review`; Task 4, test `state is rewritten with head and merge-base`.
4. **A reviewer that quotes an anchor line with surrounding spaces or CRLF.** Resolution trims whitespace (including `\r`) on both sides before comparing;
   a quote that still matches nothing is kept and marked, never dropped. → Task 5, test `anchor with CRLF and surrounding spaces resolves`.
5. **A reviewer config whose `smallMaxLines` arrives as a string (`"300"`) or a float (`300.5`).** Both are invalid at the settings route and the launch
   request (400) and as a typed flag value (`3.5`, exit 1), and fall back to defaults when read from `review.json`. → Task 9 and Task 1 tests named below.

---

## File structure

| Path | Action | Responsibility |
| --- | --- | --- |
| `skills/backlog-review/SKILL.md` | Create | `/backlog-review` entry: args, base, item, refusals, result display, fix offer (spec §5) |
| `skills/backlog-review/references/procedure.md` | Create | The one review procedure all three entry points follow (spec §1, §4 retry, §7 fallback) |
| `skills/backlog-review/tools/review.mjs` | Create | `config`, `scope`, `merge` subcommands (spec §2–§4, §7) |
| `skills/backlog-review/tools/review.test.mjs` | Create | node tests for the above |
| `agents/backlog-reviewer.md` | Modify | inputs, diff command, coverage/anchor/earlier-findings report sections (spec §4) |
| `skills/backlog/tools/backlog.test.mjs` | Modify | `CLI_SOURCES` and `ENTRY_SHAPES` entries; base-pairing test rewrite (3215–3238); prose pins for the new skill |
| `scripts/run-as-main.test.mjs` | Modify | `ROWS` row for `review.mjs`; nine → ten |
| `test/skills-plugin-root.test.ts` | Modify | `backlog-review` joins the non-vacuity `it.each` list (:40) |
| `skills/backlog-orchestrate/SKILL.md` | Modify | §7 (≈786–886) delegates to the procedure; driver records the reviewer config at `init`; trigger flags |
| `skills/backlog-orchestrate/references/check-failures.md` | Modify | the `incomplete` and empty-diff park branches |
| `skills/backlog-orchestrate/tools/orchestrate.mjs` | Modify | `init --review-config <json>`, run-file field `reviewConfig` |
| `skills/backlog-orchestrate/tools/orchestrate.test.mjs` | Modify | `init --review-config` cases |
| `skills/backlog-orchestrate/tools/orchestrate-prompts.test.mjs` | Modify | RULES pairs for the new SKILL.md statements and the check-failures triggers |
| `skills/backlog-execute/SKILL.md` | Modify | Finish-mode parse accepts `--review-*` beside `--finish pr` only |
| `skills/backlog-execute/references/pr-mode.md` | Modify | §1 flag list; §7 delegates to the procedure |
| `shared/types.ts` | Modify | `ReviewPair`, `ReviewConfig`, `ReviewSetting`; `review?` on `StartOrchestrateRequest` and `AgentDispatchRequest`; `reviewConfig?` on `OrchestratorRun` |
| `shared/agent.ts` | Modify | `REVIEW_MODELS`, `REVIEW_EFFORTS`, `DEFAULT_REVIEW_CONFIG`, `parseReviewConfig`, `reviewFlags`, `reviewerLabel`, `REVIEW_FLAG`; `finishClause` takes review flags |
| `server/src/settings/review-config.util.ts` | Create | `reviewFile`, `readReview`, `writeReview` |
| `server/src/settings/review.controller.ts` | Create | `GET`/`POST /api/settings/review` |
| `server/src/settings/settings.module.ts` | Modify | register the controller |
| `server/src/agents/agents.service.ts` | Modify | validate `review`; append flags to the orchestrate trigger and the execute finish clause; `REVIEW_FLAG` 400 |
| `server/src/agents/agents.controller.ts` | Modify | forward `review` when it rebuilds the dispatch (≈80–105) and orchestrate (≈170–215) bodies |
| `server/src/agents/prompt.util.ts`, `shared/agent.ts` (`defuseFinishFlags`) | Modify | a title spelling `--review-…` is defused like `--finish` |
| `server/src/orchestrator/orchestrator.service.ts` | Modify | `sanitizeMergeFields` (≈115) drops a `reviewConfig` that fails `parseReviewConfig` |
| `.claude/rules/dispatch-watchdog.md`, `docs/subsystems/invariants.md` | Modify | prompt composition order; review flags as a second caller-derived value; the refused `--review-` flag |
| `test/server-write-paths.test.ts` | Modify | `WRITERS` row for `settings/review-config.util.ts` |
| `client/src/components/settings/ReviewerGroup.tsx` | Create | Settings → Shared → Reviewer |
| `client/src/components/settings/ReviewerFields.tsx` | Create | the rows shared by the Settings group and both sheet pickers |
| `client/src/components/settings/SettingsView.tsx` | Modify | mount `ReviewerGroup` after `TimeZoneGroup` (≈186) |
| `client/src/hooks/useReviewSetting.ts` | Create | fetch/save `/api/settings/review` |
| `client/src/lib/orchestrate-draft.ts`, `client/src/hooks/useOrchestrateDraft.ts`, `client/src/components/board/orchestrate/ModesStep.tsx` | Modify | Orchestrate sheet Reviewer picker; `buildStartRequest` carries `review` |
| `client/src/components/board/LaunchSheet.tsx` | Modify | execute `pr` finish: Reviewer picker; clause preview shows the flags |
| `client/src/lib/run-detail.ts`, `client/src/components/runs/RunDetail.tsx` | Modify | `Reviewer: …` line |
| `test/review-config.test.ts`, `test/review.controller.test.ts`, `test/review-shared.test.ts`, `test/settings-reviewer.test.tsx` | Create | jest |
| `test/agents-dispatch.test.ts`, `test/agents-dispatch-remote.test.ts`, `test/agents-prompt.test.ts`, `test/agents-shared.test.ts`, `test/run-detail-model.test.ts`, `test/orchestrate-draft.test.ts`, `test/launch-sheet.test.tsx` | Modify | jest |
| `.claude-plugin/plugin.json`, `CLAUDE.md`, `docs/subsystems/skills.md`, `docs/overview.md` | Modify | nine skills; the new skill and tool described |

---

### Task 1: `review.mjs` skeleton and `config`

**Files:** Create `skills/backlog-review/tools/review.mjs`, `skills/backlog-review/tools/review.test.mjs`. Modify `skills/backlog/tools/backlog.test.mjs`
(`CLI_SOURCES`, `ENTRY_SHAPES`), `scripts/run-as-main.test.mjs` (`ROWS` row; the nine → ten count and its test name).

**Interfaces — Produces:**
- `resolveConfig({ flags, reviewConfigJson, file, warn }) → ReviewConfig` (exported for tests): `--review-config` JSON and flags are mutually exclusive
  (both → error naming both); either one, else `review.json`, else defaults. A `--review-config` value that is not valid JSON or fails validation → error
  naming `--review-config`.
- `ReviewConfig` shape (twin of `shared/agent.ts`, Task 9): `{ mode: 'same'|'split', same: Pair, big: Pair, small: Pair, smallMaxLines: integer }`, `Pair =
  { model: <closed model>|null, effort: <closed effort>|null }`, `null` = agent default / default. All five keys always present, so switching mode keeps the
  other pairs.
- Flag spelling (the one place it is decided; Tasks 7–10 use it verbatim): `--review-mode same|split`, `--review-model`, `--review-effort` (same),
  `--review-big-model`, `--review-big-effort`, `--review-small-model`, `--review-small-effort`, `--review-small-max-lines` (split). Value `default` means
  `null`. Any `--review-*` flag requires `--review-mode`; a flag of the other mode → error. A flag-built config fills unnamed members from the defaults.
- File: `BM_REVIEW_FILE` env, else `~/.backlog-manager/settings/review.json`.
- `review.mjs config [flags]` prints the resolved config as one JSON line, exit 0; an invalid flag → stderr names the flag, exit 1, nothing on stdout.

- [ ] **Step 1: Write the failing tests** in `review.test.mjs` (spawn the CLI with `BM_REVIEW_FILE` pointing into a temp dir):
  - `config with no flags and no file prints the default config` → `{"mode":"split","same":{"model":null,"effort":null},"big":{"model":null,"effort":null},
    "small":{"model":"sonnet","effort":null},"smallMaxLines":300}`.
  - `config reads review.json` — file `same` / `fable` / `high` with distinct non-default `big` and `small` pairs → that config, all five keys as written.
  - `config flags override the file` — file says `same opus`, flags `--review-mode split --review-big-model fable --review-small-max-lines 120` → split, big
    `fable`/null, small `sonnet`/null (default), 120.
  - `config with an unparseable file warns once and prints defaults` — stderr has exactly one line containing `review.json`; stdout the defaults.
  - `config with an invalid file value warns once and prints defaults` — `smallMaxLines: "300"`, and separately `smallMaxLines: 300.5` and `model: "gpt"`.
  - `an invalid flag exits 1 naming it` — `--review-model gpt`, `--review-small-max-lines 0`, `--review-small-max-lines 10001`,
    `--review-small-max-lines 3.5`, `--review-model opus` without `--review-mode`, `--review-mode same --review-big-model opus`: each exit 1, stderr contains
    the flag's name, stdout empty.
  - `--review-config and flags together are an error` — both given → exit 1 naming both.
  - `an invalid --review-config exits 1 naming it` — `{bad`, `[]`, and `{"mode":"split"}` (missing members) → exit 1, stderr contains `--review-config`.
  - `an unknown subcommand exits 1` — `zzz-nope` → exit 1, stderr `unknown command: zzz-nope`.
  - In `backlog.test.mjs`: `CLI_SOURCES` and `ENTRY_SHAPES` gain `review.mjs` (their existing assertions apply unchanged); in `run-as-main.test.mjs`: the
    `ROWS` row from Global Constraints.
- [ ] **Step 2: Run** `node --test skills/backlog-review/tools/review.test.mjs` — expected FAIL (module missing).
- [ ] **Step 3: Implement** the CLI frame (subcommand dispatch, usage line, `main(argv) → exit code`) and `resolveConfig`; the validator and defaults carry a
  comment naming their twin in `shared/agent.ts`.
- [ ] **Step 4: Run** the same command plus `node --test skills/backlog/tools/backlog.test.mjs scripts/run-as-main.test.mjs` — PASS.
- [ ] **Step 5: Commit** — `feat(review): review.mjs config resolves the reviewer config`.

### Task 2: `scope` — snapshot, files, skip reasons, grouping, per-group model

**Files:** Modify `review.mjs`, `review.test.mjs`.

**Interfaces — Consumes:** `resolveConfig` (Task 1). **Produces:**
- `scope --tree <W> --base <B> [--item <path>] [--mode full|incremental] [--state <file>] [--review-config <json> | review flags] [--previous <manifest>]
  --out <manifest.json>`. This task implements `full` only; Task 3 adds `incremental`, `--state` and `--previous`.
- Manifest JSON (Tasks 3–7 read it): `{ tree, base, mode, modeReason|null, from, to, mergeBase, head, item|null, config, files: [{ path, oldPath|null,
  status, added, deleted, decision, reason|null }], groups: [{ n, label, files: [path], lines, model, effort, rerun, earlier: [finding] }] }`. Group `n`
  counts from 1; `label` is the bucket key of its first file (`all files` for a single ungrouped group). `earlier` is `[]` in this task.
- Stdout one line: `{"mode":…,"files":n,"review":r,"skip":s,"groups":g}`.
- Snapshot: copy nothing; set `GIT_INDEX_FILE` to a temp file outside the repo, `git read-tree HEAD`, `git add -A` (honours `.gitignore`), `git write-tree`,
  delete the temp index. A clean tree's snapshot equals `HEAD^{tree}`. `from` (full) = `git merge-base <B> HEAD`. Diff = `git diff --numstat -M -z <from>
  <to>` plus `--name-status` for status/oldPath. Gitlink entries (mode `160000` — a nested checkout `git add -A` picked up) are dropped from the file list
  entirely: no reviewer can cover them, and the skip-reason set is closed.
- Skip rules: `item` (the `--item` path, relative to the tree), `deleted` (absent in `to`), `binary` (numstat `-`), `lockfile` (`pnpm-lock.yaml`,
  `package-lock.json`, `yarn.lock`, `Cargo.lock`, `poetry.lock`, `go.sum`, `Gemfile.lock`, `composer.lock`), `generated` (a path segment `dist`, `build`,
  `coverage`, `node_modules`, or a `*.min.js`/`*.map` file). First matching rule wins in that order. Lists may grow; the reason set may not.
- Grouping algorithm (deterministic; implement exactly in this order):
  1. Reviewable files sorted by path; if count ≤ 12 and `added+deleted` total ≤ 1200 → one group.
  2. Pair: `x.test.<ext>`/`x.spec.<ext>` with `x.<ext>` in the same directory; `test/<name>.test.ts(x)` with the one reviewable file named `<name>.ts(x)`
     anywhere in scope (zero or several → unpaired). A pair is one unit.
  3. Bucket each unit by key: `server/src/<module>/`, `client/src/<area>/`, `skills/<skill>/`, `test/` pairs go to their source's bucket, otherwise the
     first two path segments.
  4. Split a bucket over 10 files / 800 lines into consecutive chunks by path order, never breaking a unit; a unit alone over the cap is its own group.
  5. Fold a one-file bucket into the alphabetically nearest bucket (previous, else next) while the result stays within the cap.
  6. Order groups by first path; the group holding the item-checks duty is group 1 = the first group.
- Model/effort per group: `same` → `same` pair for all; `split` → group 1 `big`, others `small` when `lines ≤ smallMaxLines` else `big`. `rerun` is `true`
  for every group in a fresh scope.
- Edge inputs: empty diff → `"files":0`, `groups: []`, exit 0 (callers interpret it); every file skipped → group 1 with `files: []` when `--item` is given,
  else `groups: []` (Task 3 adds "or an open earlier finding").

- [ ] **Step 1: Write the failing tests** (each builds a temp repo with a `main` and a feature branch):
  - `each skip reason` — one file per reason (a `pnpm-lock.yaml`, `dist/a.js`, a PNG, a deleted file, the `--item` file) → each `skip` with that reason; a
    plain `.mjs` → `review`.
  - `snapshot of a dirty tree` — modified tracked file, new untracked file, ignored file → first two in `files`, ignored absent; `git status --porcelain`
    and the bytes of `.git/index` and of every work-tree file identical before and after (read the index bytes before any test-side `git status`, or run
    the test's own git calls with `GIT_OPTIONAL_LOCKS=0`, so a racy-git refresh cannot flake it).
  - `snapshot keeps the real index's staged content` (Review Focus 1) — stage version A, modify to B in the work tree → manifest diff shows B;
    `git diff --cached` after the run still shows A.
  - `rename, space in path and work-tree deletion` (Review Focus 2) — `git mv a.mjs "b c.mjs"`, and `rm` of a tracked file without `git rm` → rename has
    `oldPath: 'a.mjs'`, `path: 'b c.mjs'`; the removed file is `skip`/`deleted`.
  - `clean tree to equals HEAD's tree` — `to === git rev-parse HEAD^{tree}`.
  - `full from is the merge base with the given base` — branches `main` ← `develop` ← `feat`; `--base develop` → `from` = `merge-base develop HEAD`, which
    differs from `merge-base main HEAD` in the fixture.
  - `no grouping at both thresholds` — 12 files totalling 1200 lines → one group.
  - `grouping above either threshold` — 13 one-line files → >1 group; 2 unpaired files of 700 and 501 lines → exactly 2 groups.
  - `a test/source pair is never split` — 14 files in one bucket where `x.mjs` and `x.test.mjs` sort across the 10-file boundary → same group.
  - `same input gives the same groups` — two runs, identical `groups`.
  - `a bucket over the cap is split` — 25 files under `server/src/items/` → ≥3 groups, each ≤10 files.
  - `one file over the cap is its own group` — a 900-line file plus 13 small files → that file alone in a group; likewise a pair totalling 900 lines → the
    pair alone in a group.
  - `empty diff` — `"files":0`, no groups.
  - `every file skipped` — only a lockfile changed: with `--item` → one group, `files: []`; without → no groups.
  - `per-group model and effort` — `same fable/high` → every group `fable`/`high`; `split` with `smallMaxLines 50` → group 1 `big` even when small, a 30-line
    group `small`, a 60-line group `big`; with `--review-config` JSON → that config; with flags over a `review.json` → the flags win; with a broken
    `review.json` → defaults.
  - `an invalid scope flag exits 1 naming it` — `--review-effort extreme`, and separately `--review-config '{bad'` → exit 1 naming the flag, no manifest
    written.
- [ ] **Step 2: Run** `node --test skills/backlog-review/tools/review.test.mjs` — new cases FAIL.
- [ ] **Step 3: Implement** `scope` (full mode) per the interface above; every git call `execFileSync('git', ['-C', tree, …])`, no shell.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(review): scope snapshots the tree, lists and groups the files`.

### Task 3: state file, mode selection, earlier findings, `--previous`

**Files:** Modify `review.mjs`, `review.test.mjs`.

**Interfaces — Consumes:** Task 2 manifest. **Produces:**
- State path: `--state <file>` when given; else `BM_REVIEW_HOME` env or `~/.backlog-manager/reviews`, then `/<repo key>/<branch>.json`, repo key = the
  basename of `git rev-parse --path-format=absolute --git-common-dir`'s parent plus `-` plus the first 8 hex of sha1 of that absolute path; branch with `/` replaced by `__`. A
  detached HEAD has no state path: always full, reason `no earlier review`.
- State JSON (Task 4 writes it): `{ base, head, mergeBase, to, report, at, verdict, open: [finding] }`; `finding = { id, severity: 'Critical'|'Important',
  path|null, line|null, text, anchor|null }`.
- Mode selection exactly as spec §3; the reason is `modeReason` in the manifest and is printed on stderr as `full review: <reason>`. Order of checks:
  missing/unparseable state → `no earlier review`; different `base` → `base changed`; merge-base differs → `base moved — merged or rebased onto a newer
  base`; recorded head not an ancestor → `history rewritten`; `git cat-file -e <to>^{tree}` fails → `earlier snapshot gone`.
- Incremental `from` = state's `to`. Incremental with `from === to` → stdout `{"mode":"incremental","files":0,…,"noChange":true}` and stderr line
  `no changes since the last review (<report>) — its verdict stands: <verdict>`; no manifest groups. (The no-change sentence is printed by the tool so the
  three callers cannot word it differently.)
- Earlier findings: each `open` finding goes to the group holding its `path` when that file is a `review` file in this scope, else group 1. Null path, the
  item file, or a deleted file → group 1. If findings exist and there are no groups, create group 1 with `files: []`.
- `--previous <manifest>`: the **latest** round's manifest (round N passes round N−1's, not the first one's — its partition was already copied from the
  first, and only its `findings.json` holds round N−1's findings; spec §6 says "first manifest", this is a deliberate correction). Fresh snapshot `to`;
  partition, labels, model and effort copied from the previous manifest; files new to the diff appended to group 1; `rerun` = true for group 1 and for any
  group with a file whose blob differs between previous `to` and new `to`; earlier findings = the previous manifest's merged findings (read from the file
  Task 4 writes beside the manifest, `<manifest>.findings.json`: a JSON array of `finding`, the shape above), assigned as above but to a `rerun` group only
  (owner if it re-runs, else group 1). Mode `full`.

- [ ] **Step 1: Write the failing tests:**
  - `no state is full with no earlier review`.
  - `all conditions hold is incremental` — commit, write state (via Task 4's `merge`, or a hand-written state in the test), commit again → `mode:
    incremental`, `from` = recorded `to`, only the new commit's files listed.
  - `base ref changed`, `merge-base moved` (merge `main` into the branch after `main` advanced), `recorded head not an ancestor` (amend the reviewed commit),
    `snapshot gone` (state with a made-up tree id) → full with the exact reason string each.
  - `an unparseable state file is treated as no earlier review` (Review Focus 3).
  - `full forces full` even when incremental would apply; `modeReason` null.
  - `incremental with no change prints the no-change line` — exact stderr text with the recorded report path and verdict; stdout `noChange: true`; no groups.
  - `detached HEAD is always full`.
  - `earlier findings are assigned` — a finding on a file in the increment → its group; on a file outside it → group 1; unanchored → group 1; only a lockfile
    changed but one open finding → group 1 created with `files: []`.
  - `--previous keeps the partition` — first scope 3 groups; fix touches a group-3 file and adds a new file → same partition and models, new file in group 1,
    `rerun` = [true, false, true]; previous findings handed to their owners when they re-run, else group 1 (the test hand-writes `findings.json`).
  - `three rounds carry round-2 findings` — round 1 manifest M1, round 2 `--previous M1` → M2 whose `findings.json` holds a new finding F2; round 3
    `--previous M2` → F2 is among the earlier findings and the partition still equals M1's.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(review): incremental mode from the branch's review state`.

### Task 4: `merge` — coverage, verdict, merged report, state

**Files:** Modify `review.mjs`, `review.test.mjs`.

**Interfaces — Consumes:** manifest (Tasks 2–3). **Produces:**
- `merge --manifest <M> [--reports <g…>] [--carried <g…>] [--retry <r>] [--fallback <n>:<model|effort>]… --out <report.md> [--state <file>]`
  (`--reports` may be absent when the manifest has no groups). A report is mapped to its group by its file name suffix `.g<n>.md`; `--retry` by
  `.retry.md` (both replace the merged report's `.md`: `<id>-<k>.g2.md`, `<id>-<k>.retry.md`). Each repeatable `--fallback 3:model` records that group 3 was
  re-dispatched without its `model` (spec §7 fallback); the merged report lists each one as `group <n> ran without its <field>`.
- Report grammar it parses (the agent writes it, Task 6): `verdict: <word>` line; `## Coverage` with `- <path> — clean|findings|not reviewed: <reason>`;
  `## Critical`, `## Important`, `## Minor` sections whose entries start `- ` and may carry an indented `anchor: <path> | <line>` and a leading `<path>:<line>
  — `; `## Earlier findings` with `- <id> — resolved|open — <why>`.
- Coverage: a `review` file is covered when its own group's report (or `--carried`, or `--retry` for any file) lists it as `clean` or `findings`. Missing
  report file → all its files uncovered.
- Verdict: `incomplete` if anything uncovered; else `fix` if any re-run group's verdict is `fix`, any new Critical/Important exists, or any earlier finding is
  open (marked `open` or unmarked); else `approve`.
- Writes `--out` with: `verdict: <v>` line near the top; mode with `from`/`to` and `modeReason`; a groups table (n, label, files, model, effort, rerun);
  `## Coverage` (the uncovered list, or `all <n> files covered`; skipped files with reasons); `## Critical`, `## Important`, `## Minor`; `## Earlier
  findings`. Writes `<manifest>.findings.json` (the merged open findings, for Task 3's `--previous`).
- State (when coverage is complete and a state path resolves): written via temp file + `rename`, `open` = new Critical/Important plus still-open earlier
  ones, `head`/`mergeBase`/`to` from the manifest. Incomplete coverage → state untouched.
- Stdout: line 1 `{"verdict","mode","uncovered":[paths],"unanchored":n,"stillOpen":n,"minor":n}`; then one line per Critical/Important
  `<path>:<line> — <Severity>: <text>`, earlier still-open ones suffixed ` (earlier)`. No Minor line ever.
- Exit 0 for every verdict; non-zero only for bad arguments or an unreadable manifest.

- [ ] **Step 1: Write the failing tests** (hand-written group reports in a temp dir):
  - `coverage complete gives an empty uncovered list`.
  - `missing line, not reviewed, and missing report file are uncovered` — three groups, one defect each → all three paths listed, verdict `incomplete`,
    and the state file's bytes unchanged.
  - `a retry report's coverage counts for any file`.
  - `a carried report counts for coverage only` — carried report says `verdict: fix` with a Critical → verdict `approve` when re-run groups are clean and no
    earlier finding is open.
  - `earlier finding marks` — `resolved` → closed; `open` → `stillOpen: 1`, verdict `fix`; unmarked → open.
  - `verdict fix on a re-run group's fix`, `on a new Important`, `approve otherwise`.
  - `minor is counted, never printed` — two Minor entries → `"minor":2`, no stdout line contains either text.
  - `merged report keeps the retro shape` — `--out` matches `/^verdict:\s*(\S+)\s*$/im` with the computed verdict and has `## Critical` / `## Important`
    headings; the group files' names do not match retro's `/^((?:[a-z]+-)?\d+)-(\d+)\.md$/`.
  - `state is rewritten with head and merge-base` and is valid JSON after the write, with no temp file left beside it.
  - `fallbacks are listed` — `--fallback 2:model --fallback 3:effort` → the report contains `group 2 ran without its model` and `group 3 ran without its
    effort`.
  - `no groups and no reports` (all skipped, no item) → `approve`, report lists the skips, state written.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (anchor resolution and de-dup are Task 5; here a finding keeps its claimed `path:line`). **Step 4: Run** —
  PASS.
- [ ] **Step 5: Commit** — `feat(review): merge checks coverage and computes the verdict`.

### Task 5: anchors and de-duplication

**Files:** Modify `review.mjs`, `review.test.mjs`.

**Interfaces — Consumes:** Task 4's parsed findings. **Produces:** each finding gets `line` resolved from its `anchor:` against the file's content in `to`
(`git show <to>:<path>`); `unanchored` count on stdout; de-dup as spec §4.

- Resolution: compare `line.trim()` (which drops `\r`) to the quote trimmed; one match → it; several → the one nearest the claimed line (ties → lower line);
  none → claimed line kept, entry text suffixed ` (unanchored)`. A path not present in `to` → resolve against `from`, and the entry says ` (removed code)`.
  A finding is never dropped or downgraded.
- De-dup key: resolved `path:line`; entries sharing it merge into one at the highest severity, keeping every distinct text (joined ` / `). Unanchored entries
  are never merged.

- [ ] **Step 1: Write the failing tests:**
  - `exact anchor resolves to its line`; `anchor with CRLF and surrounding spaces resolves` (Review Focus 4); `nearest of several` (quote `});` at lines 10,
    40, 90, claimed 42 → 40); `no match is kept and marked unanchored` (stdout `unanchored: 1`, line printed with the claimed number);
    `anchor on a removed file resolves against from`.
  - `de-dup keeps the highest severity and both texts`; `identical quoted text on different lines stays two findings`; `unanchored findings are never
    merged` (two unanchored at the same claimed line → two entries).
- [ ] **Step 2–4:** run FAIL → implement → run PASS.
- [ ] **Step 5: Commit** — `feat(review): resolve finding anchors and de-duplicate by line`.

### Task 6: reviewer agent, procedure and the `/backlog-review` skill

**Files:** Modify `agents/backlog-reviewer.md`, `skills/backlog/tools/backlog.test.mjs` (3215–3238 and new cases), `.claude-plugin/plugin.json`,
`CLAUDE.md`, `docs/subsystems/skills.md`, `docs/overview.md`. Create `skills/backlog-review/SKILL.md`, `skills/backlog-review/references/procedure.md`.

**Interfaces — Consumes:** Tasks 1–5 CLI. **Produces:** the reviewer input contract and report grammar Task 4 parses; `procedure.md` with named parameters
`tree`, `base`, `item`, `mode`, `report` (merged path), `group report pattern`, `manifest path`, `config` (flags or `--review-config` JSON), `outcome`
(`present`|`none`), which Tasks 7 and 8 fill in.

Agent edits (spec §4): the five required fields become `worktree`, `base`, `from`, `to`, `report path` — keep the sentences `Five fields, always` and `If any
of the five is missing`, and keep `**\`base\`** —`; the diff becomes `git -C <worktree> diff <from> <to>` (the `<base>...<branch>` line and its "three dots"
paragraph go; no `main...` and no `log --oneline main..` anywhere); optional inputs `item file path`, `manifest path`, `group`, `item checks`, `earlier
findings`, `outcome: none`; item checks against `git -C <worktree> diff <merge-base> <to>` (merge-base from the manifest) when `item checks: yes`; with
`outcome: none`, check 4 is recorded `not checked: no Outcome` and is not a finding — the existing `missing or half-present pair is an Important finding**`
sentence stays for the case where an Outcome exists; report gains `## Coverage`, an `anchor:` line on every Critical/Important, `## Earlier findings`;
"never review the main tree" becomes "never read a tree other than the one given" — and every other `<base>`/`<branch>` site goes with it: the helper
block's `log --oneline <base>..<branch>` and `diff <base>...<branch> -- <path>` (≈109–111) become `log --oneline <from>..HEAD` and `diff <from> <to> --
<path>`, and the `worktree` bullet's "The main tree is not yours" sentence (≈66) becomes the same "other tree" wording; a **Scope of a group** paragraph
(spec §4): the `## Coverage` duty is the group's own files, while the reviewer may read any file in the tree and the manifest and raise a finding at full
severity about any file; the tracker snapshot sentence (`SNAPSHOT under the run-state directory`,
`<dir>/items/<n>.md`) stays; `model: opus` frontmatter stays (`test/default-model.test.ts`).

Procedure (one file, the only description of dispatch): it calls the tool as `node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-review/tools/review.mjs"` and,
because a file read with the Read tool never has `${CLAUDE_PLUGIN_ROOT}` filled in, carries `skills/backlog-execute/references/pr-mode.md:14–15`'s
sentence on resolving the root. Run `review.mjs scope`; on `"files":0` or `noChange` return that to the caller; dispatch one
`backlog-manager:backlog-reviewer` per `rerun` group **in one message**, each with the five fields, its `group` line, `item checks: yes` for group 1 only,
its `earlier findings`, `manifest path`, `item file path` when the caller has an item, `outcome: none` when that item has no `## Outcome`, and the group's
`model`/`effort` as the Agent tool's own parameters (omitted when null); a dispatch refused for its model or effort is re-sent once without that field and
`merge` gets `--fallback <n>:<field>`; run `merge`; when `uncovered` is non-empty, one retry dispatch on the big pair for all uncovered files →
`<id>-<k>.retry.md`, `merge` again with `--retry`; read only `merge`'s stdout into context. **Re-review branch** (both callers' fix loops and the standalone
re-review after a fix): `scope --previous <the latest manifest>`, dispatch only the `rerun` groups, and pass the other groups' earlier reports to `merge`
as `--carried`.

SKILL.md (spec §5): args `[<id>] [full] [--base <ref>] [review flags]`; tree, base and item resolution; reports under `<os tmpdir>/backlog-review/<repo
key>/<branch>-<n>.md` (branch `/` → `__` as in the state path, detached HEAD → `detached`; `<n>` the next free integer from 1); the three refusals, each
one sentence (base not a local branch; id not found; tracker stack down — plus that a review without an id still works); on `"files":0` in full mode it
prints `nothing to review — no changes against <base>`, dispatches nothing and writes no state; display (mode and fallback reason, verdict, resolved
lines, earlier resolved/still open, report path — never the body); `incomplete` said plainly with uncovered files; the fix offer (verdict `fix` or `minor`
> 0): `Fix Critical and Important (Recommended)` / `Fix all, including Minor` / `Don't fix`, and when AskUserQuestion is unavailable or denied the
Recommended option is taken; this session fixes, runs the repo's verification, commits nothing, offers an incremental re-review (the procedure's re-review
branch); at most two fix rounds.

- [ ] **Step 1: Write the failing tests** in `backlog.test.mjs`:
  - Rewrite exactly one assertion of `backlog-orchestrate hands the reviewer a base and the reviewer diffs against it`: `git -C <worktree> diff
    <base>...<branch>` → `git -C <worktree> diff <from> <to>`. Every other assertion in it unchanged.
  - `backlog-reviewer reports coverage, anchors and earlier findings` — the agent text contains `## Coverage`, `anchor:`, `## Earlier findings`,
    `not checked: no Outcome`, `never read a tree other than the one given`, and the Scope-of-a-group sentence (`any file`, `full severity`); it no longer
    contains `<base>...<branch>`, `<base>..<branch>` or `The main tree is not yours`.
  - `the review procedure dispatches every group in one message and retries coverage once` — `procedure.md` contains `in one message`, `review.mjs scope`,
    `review.mjs merge`, `--retry`, `--fallback`, `item file path`, `outcome: none`, `--previous`, `--carried`, and names `model` and `effort` as Agent tool
    parameters.
  - `backlog-review offers to fix and commits nothing` — SKILL.md contains the three option labels above verbatim, `commits nothing`, `at most two`,
    `unavailable or denied`.
  - `backlog-review says when there is nothing to review` — SKILL.md contains `nothing to review — no changes against <base>`.
  - `test/skills-plugin-root.test.ts`: `backlog-review` added to the non-vacuity list, so its SKILL.md must call `review.mjs` through
    `${CLAUDE_PLUGIN_ROOT}`.
  - The pairing the rewritten diff-string assertion stood for is pinned by Task 2's `full from is the merge base with the given base`.
- [ ] **Step 2: Run** `node --test skills/backlog/tools/backlog.test.mjs` — new cases FAIL, the rewritten one FAILS.
- [ ] **Step 3: Write** the agent edits, `procedure.md`, `SKILL.md` (frontmatter `name: backlog-review`, a description with its trigger phrases), and update
  the skill count and lists in `plugin.json`, `CLAUDE.md` (keep it under `test/claude-rules.test.ts`'s byte budget), `docs/subsystems/skills.md`,
  `docs/overview.md`.
- [ ] **Step 4: Run** `node --test skills/backlog/tools/backlog.test.mjs` and `pnpm exec jest test/default-model.test.ts test/claude-rules.test.ts
  test/skills-plugin-root.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat(review): backlog-review skill and the grouped reviewer contract`.

### Task 7: orchestrate — run-file config, §7 via the procedure, failure branches

**Files:** Modify `skills/backlog-orchestrate/SKILL.md` (§7 ≈786–886, trigger flags, `init` call), `references/check-failures.md`,
`tools/orchestrate.mjs` (`cmdInit` ≈3308, run object ≈3628), `tools/orchestrate.test.mjs`, `tools/orchestrate-prompts.test.mjs` (`RULES` ≈516–563,
`RARE_PATH_REFERENCES` ≈752, noteValues guard ≈1476–1530).

**Interfaces — Consumes:** `review.mjs config` (Task 1), the procedure's parameters (Task 6). **Produces:** run file key `reviewConfig` (object, or absent
on an older run file) — Task 11's Run detail reads it.

- `init --review-config <json>`: parse; not a JSON object (array, string, number, null, unparseable) → exit 1 naming `--review-config`, nothing written. No
  validation beyond "is an object" (`scope` validates it). Absent → key absent. Usage line gains `[--review-config <json>]`.
- SKILL.md: trigger accepts the review flags (Task 1 spelling); before `init`, the driver runs `review.mjs config` with them and passes its stdout line to
  `init --review-config` (`config` exiting 1 on a bad flag → the run is refused before `init`, naming the flag); every `scope` gets `--review-config` with
  the run file's value, read from `orchestrate.mjs status --json` (which prints the whole run). §7 states its own trigger: **when the run file has no
  `reviewConfig`** (written before this change) the review must use the default config, **not** the current `review.json`, so the driver runs
  `review.mjs config --defaults` (a flag this task adds; it prints the default config and reads no file) and passes that line as `--review-config`. §7 keeps
  the line `` - `base` — this run's base branch `` and replaces the dispatch text with the procedure's parameters, mode `full` (spec §6 Orchestrate row).
  Fix-loop re-review: the procedure's re-review branch (`scope --previous <the latest manifest>`, dispatch `rerun` groups, others `--carried`).
  `verdict: fix` → the fix prompt file holds `merge`'s resolved lines and the merged report path.
- check-failures.md, two new branches named by their observable trigger: `merge` prints `"verdict":"incomplete"` after the retry → `attention <id> --kind
  parked --detail "review incomplete — uncovered files are listed in the merged review report"`, then `stage <id> parked`; `scope` prints `"files":0` →
  `attention <id> --kind parked --detail "review not run — the item's committed diff is empty"`, then `stage <id> parked`. SKILL.md names the file on these
  triggers in one statement.

- [ ] **Step 1: Write the failing tests:**
  - `orchestrate.test.mjs`: `init records --review-config on the run file` (object round-trips byte-equal as JSON); `init without --review-config leaves the
    key absent`; `init refuses a non-object --review-config` — `[]`, `"x"`, `3`, `null`, `{bad` → exit 1, no run file.
  - `orchestrate-prompts.test.mjs` `RARE_PATH_REFERENCES`: add `/"verdict":"incomplete"/` and `/"files":0/` to the existing `check-failures.md` entry's
    trigger list, so the existing "names each rare-path reference in the sentence that states its trigger" test requires each in a SKILL.md sentence naming
    `references/check-failures.md`.
  - `orchestrate-prompts.test.mjs` `RULES`: one `[needle, rule]` pair per new SKILL.md statement — review flags accepted on the trigger; `review.mjs config`
    runs before `init`; every `scope` carries `--review-config`; a run file with no `reviewConfig` → `config --defaults`; the re-review uses
    `scope --previous` and `--carried`; the fix prompt file holds `merge`'s lines; §7 delegates dispatch to `skills/backlog-review/references/procedure.md`.
    The noteValues guard must pass with the two new `--detail` values (fixed words, no placeholder).
  - `review.test.mjs`: `config --defaults ignores review.json`.
- [ ] **Step 2: Run** `node --test skills/backlog-orchestrate/tools/orchestrate.test.mjs skills/backlog-orchestrate/tools/orchestrate-prompts.test.mjs
  skills/backlog-review/tools/review.test.mjs skills/backlog/tools/backlog.test.mjs` — new cases FAIL.
- [ ] **Step 3: Implement** `init`, `config --defaults`, and the prose edits (one statement per rule in SKILL.md; failure branches only in the reference).
- [ ] **Step 4: Run** the same — PASS (including the base-pairing test from Task 6).
- [ ] **Step 5: Commit** — `feat(orchestrate): review through the grouped procedure and record the reviewer config`.

### Task 8: execute pr-mode — finish-clause flags and §7 via the procedure

**Files:** Modify `skills/backlog-execute/SKILL.md` (Finish mode, ≈74–92), `skills/backlog-execute/references/pr-mode.md` (§1 ≈18–48, §7 ≈208–230),
`skills/backlog/tools/backlog.test.mjs`.

**Interfaces — Consumes:** procedure (Task 6), flag spelling (Task 1).

- Finish-mode parse: `--review-*` flags are read in the same pass and from the same place as `--auto-merge`/`--fix` (inside the clause's backticks on a board
  prompt), and only beside `--finish pr`; one without `--finish pr` → stop and name the rule (as `--auto-merge` does today).
- pr-mode §7: the procedure with tree `<tree>`, base `<base>`, item as today, mode `full`, reports `<tmp>/review-<k>.g<n>.md` merged to
  `<tmp>/review-<k>.md`, config from the session's flags (none → `review.json` via `scope`). Coverage failure or empty diff → do not push; report in §4's
  failure shape. Fix rounds use the procedure's re-review branch (`scope --previous <the latest manifest>`). The tracker `<tmp>/item.md` sentence is
  unchanged.

- [ ] **Step 1: Write the failing tests** in `backlog.test.mjs`: `backlog-execute reads review flags only beside --finish pr` (SKILL.md names
  `--review-mode` in the Finish-mode section and the beside-`--finish pr` rule); `pr-mode §7 follows the review procedure` (pr-mode.md contains
  `skills/backlog-review/references/procedure.md` and `scope --previous`, and no longer contains `it diffs \`<base>...<branch>\``); `pr-mode §7 does not
  push on incomplete coverage or an empty diff` (pr-mode.md §7 names `"verdict":"incomplete"` and `"files":0` beside "do not push").
- [ ] **Step 2–4:** FAIL → edit prose → PASS (`node --test skills/backlog/tools/backlog.test.mjs`).
- [ ] **Step 5: Commit** — `feat(execute): pr-mode reviews through the grouped procedure`.

### Task 9: shared reviewer-config helpers and the settings route

**Files:** Modify `shared/types.ts`, `shared/agent.ts`, `server/src/settings/settings.module.ts`, `test/server-write-paths.test.ts` (`WRITERS` ≈26–36).
Create `server/src/settings/review-config.util.ts`, `server/src/settings/review.controller.ts`, `test/review-shared.test.ts`, `test/review-config.test.ts`,
`test/review.controller.test.ts`.

**Interfaces — Produces** (Tasks 10–11 use these names):
- `shared/types.ts`: `ReviewPair { model: ReviewModel | null; effort: ReviewEffort | null }`, `ReviewModel = 'opus'|'sonnet'|'haiku'|'fable'`,
  `ReviewEffort = 'low'|'medium'|'high'|'xhigh'|'max'`, `ReviewConfig { mode: 'same'|'split'; same; big; small: ReviewPair; smallMaxLines: number }`,
  `ReviewSetting = ReviewConfig & { fileError?: true }`.
- `shared/agent.ts`: `REVIEW_MODELS`, `REVIEW_EFFORTS` (readonly tuples of the unions), `DEFAULT_REVIEW_CONFIG`, `parseReviewConfig(value: unknown):
  { ok: true; config: ReviewConfig } | { ok: false; member: string }` (exactly the five keys; pairs exactly `model`/`effort`; `smallMaxLines`
  `Number.isInteger` and 1–10000; `member` names the first failing one — `smallMaxLines`, `big.model`, `mode`, or `review` itself for a non-object or an
  extra/missing key),
  `reviewFlags(c: ReviewConfig): string[]` (Task 1 spelling; `same` → mode, model, effort; `split` → mode, four pair flags, max-lines; `null` → `default`),
  `reviewerLabel(c: ReviewConfig | null | undefined): string` (`Reviewer: <model> · <effort>`; `Reviewer: big <model> · <effort>, small <model> · <effort>
  up to <n> lines`; unset model `Agent default`, unset effort `Default`; capitalised model/effort words `Opus`, `XHigh` etc.; null/undefined → `Reviewer:
  default`), `REVIEW_FLAG = /(?<![\w-])--review-[a-z]/`. Comments name `review.mjs` as the twin of `parseReviewConfig`/`DEFAULT_REVIEW_CONFIG`.
- `review-config.util.ts`: `reviewFile(env)` (`BM_REVIEW_FILE` else `~/.backlog-manager/settings/review.json`), `readReview(file): ReviewSetting` (missing →
  defaults, no `fileError`; unparseable or invalid → defaults + `fileError: true`), `writeReview(config, file)` via `server/src/atomic-write.util.ts`.
- `GET /api/settings/review` → `ReviewSetting`; `POST /api/settings/review` body `ReviewConfig` → 200 + the written config, or 400 `{ error }` and nothing
  written. POST behind `SameOriginPostGuard`, `@HttpCode(200)`, like `timezone.controller.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `review-shared.test.ts`: `parseReviewConfig` accepts the default and a `same` config (`ok: true`); rejects `smallMaxLines` `"300"`, `300.5`, `0`,
    `10001` (Review Focus 5) with `member: 'smallMaxLines'`, a big model `gpt` with `member: 'big.model'`, an extra key, a missing pair; `reviewFlags` for the default config is exactly `['--review-mode','split','--review-big-model',
    'default','--review-big-effort','default','--review-small-model','sonnet','--review-small-effort','default','--review-small-max-lines','300']`;
    `reviewerLabel` of the default → `Reviewer: big Agent default · Default, small Sonnet · Default up to 300 lines`, of `same fable/xhigh` → `Reviewer:
    Fable · XHigh`, of `undefined` → `Reviewer: default`; `REVIEW_FLAG` matches `--review-model x`, `` `--review-mode` ``, not `--reviewed` or `--preview-x`.
  - Twin parity: `review.test.mjs` reads `shared/agent.ts` as text and asserts the default values and closed lists in `review.mjs` equal it (the
    skills.md twin rule's usual guard; follow the existing twin-parity test style in the repo).
  - `review-config.test.ts`: missing → defaults without `fileError`; unparseable → `fileError: true`; invalid → `fileError: true`; write then read round-trips.
  - `review.controller.test.ts` (supertest via `listenLoopback`): GET with no file → defaults; POST valid → 200, file contents equal; POST with
    `smallMaxLines` `"300"`, and separately `300.5` → 400 and file unchanged; POST without same-origin headers → refused by the guard; GET after a corrupt
    file → `fileError: true`, then a valid POST replaces it.
  - `server-write-paths.test.ts`: `WRITERS` gains `'settings/review-config.util.ts': [reviewFile({})]`.
- [ ] **Step 2: Run** `pnpm exec jest test/review-shared.test.ts test/review-config.test.ts test/review.controller.test.ts
  test/server-write-paths.test.ts` and `node --test
  skills/backlog-review/tools/review.test.mjs` — FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** the same plus `pnpm run typecheck` — PASS.
- [ ] **Step 5: Commit** — `feat(settings): reviewer config in review.json behind /api/settings/review`.

### Task 10: launch requests carry the override

**Files:** Modify `shared/types.ts` (`StartOrchestrateRequest`, `AgentDispatchRequest`, `OrchestratorRun`), `shared/agent.ts` (`finishClause`,
`defuseFinishFlags` ≈939), `server/src/agents/agents.service.ts` (finish validation ≈405–480, orchestrate prompt ≈1005–1045),
`server/src/agents/agents.controller.ts` (body rebuilds ≈80–105 and ≈170–215), `server/src/orchestrator/orchestrator.service.ts` (`sanitizeMergeFields`
≈115), `.claude/rules/dispatch-watchdog.md` (≈17–18, 39–46, 59–61) and its `docs/subsystems/invariants.md` paragraph, `test/agents-dispatch.test.ts`,
`test/agents-dispatch-remote.test.ts`, `test/agents-prompt.test.ts`, `test/agents-shared.test.ts`, and the orchestrator-run suite `grep -l
sanitizeMergeFields test/` finds.

**Interfaces — Consumes:** Task 9 helpers. **Produces:** `review?: ReviewConfig` on both requests; `reviewConfig?: ReviewConfig` on `OrchestratorRun`;
`FinishFlags` gains `review?: ReviewConfig`.

- Orchestrate: `review` present → `parseReviewConfig`; `ok: false` → 400 `{ error: "review: <member> is not a valid reviewer setting" }` with the
  returned `member`; flags from `reviewFlags` appended **after** ids, the mode flags and `--base`. Absent → nothing appended (the prompt stays
  byte-identical to today's).
- Execute: `review` allowed only when the **derived** finish is `pr` (the same derivation the base rules use — a remote execute derives `pr` with no
  `req.finish`, `agents.service.ts:438`); otherwise 400 "the reviewer override applies only to an execute that finishes with a PR". `finishClause` places
  the flags inside the backticks after `--base <base>` and after `--auto-merge [--fix]`. Groom: `review` → 400.
- Body guard: an execute or groom prompt matching `REVIEW_FLAG` → 400 "the reviewer is set by the sheet's Reviewer picker — remove --review- flags from the
  prompt", checked beside the `FINISH_FLAG` check. Titles: `defuseFinishFlags` also defuses a `REVIEW_FLAG` token (same U+2011 U+2011 swap), so an item
  titled with `--review-mode` cannot inject a flag through the prompt.
- `agents.controller.ts` forwards `review` on both rebuilt bodies (dispatch and orchestrate) — without it the field never reaches the service.
- Run file: `sanitizeMergeFields` keeps `reviewConfig` only when `parseReviewConfig` accepts it, else drops it, so the board renders `Reviewer: default`.
- Rule docs: `.claude/rules/dispatch-watchdog.md` and its invariants.md paragraph state the new composition order (… `--base`, then review flags), that
  the review flags are a second caller-derived value beside `base` (derived from a validated `ReviewConfig`, never caller text), and that `--review-` is
  refused in a body beside the four finish flags.
- Remote launches compose the same flags (the override travels as text; no override → nothing, the target's `review.json` applies).

- [ ] **Step 1: Write the failing tests:**
  - `agents-dispatch.test.ts`: orchestrate with `review` → prompt ends `… --base develop --review-mode same --review-model fable --review-effort high`;
    with ids and `mergeMode: 'branch'` the order is ids, `--merge-mode branch`, `--base`, review flags; without `review` → prompt byte-identical to the
    existing expectation; invalid `review` (`smallMaxLines: 0`) → 400 with body `{ error: "review: smallMaxLines is not a valid reviewer setting" }`,
    nothing spawned. Execute `finish: 'pr', autoMerge, fix, review` → clause contains
    `` `--finish pr --base main --auto-merge --fix --review-mode split … --review-small-max-lines 300` `` inside one pair of backticks; execute `in-place` +
    `review` → 400; groom + `review` → 400; execute prompt containing `--review-model opus` → 400; an execute of an item titled `try --review-mode same` →
    200 and the prompt's title carries the defused token, never `--review-mode`; the controller forwards `review` (a request through the HTTP route, not the
    service directly, still gets the flags).
  - Orchestrator-run suite: a run file with `reviewConfig: {}` → sanitized run has no `reviewConfig`; a valid one → kept byte-equal.
  - `agents-dispatch-remote.test.ts`: remote orchestrate with `review` → the forwarded prompt carries the flags; without → none.
  - `agents-prompt.test.ts`: `finishClause('execute','pr','main',{ review })` places the flags inside the backticks and the prose after the colon spells no
    `--review-`; `finishClause` without `review` is unchanged.
  - Run `grep -l "finishClause\|FINISH_FLAG\|defuseFinishFlags\|sanitizeMergeFields\|StartOrchestrateRequest" test/` and add every hit to the run
    (`test/claude-rules.test.ts` too, since the rule file changes).
- [ ] **Step 2: Run** `pnpm exec jest <the files above>` — FAIL. **Step 3: Implement.** **Step 4: Run** + `pnpm run typecheck` — PASS.
- [ ] **Step 5: Commit** — `feat(agents): launch requests carry a validated reviewer override`.

### Task 11: Settings Reviewer group, sheet pickers, Run detail — then `/ui-verify`

**Files:** Create `client/src/components/settings/ReviewerGroup.tsx`, `client/src/components/settings/ReviewerFields.tsx`,
`client/src/hooks/useReviewSetting.ts`, `test/settings-reviewer.test.tsx`. Modify `SettingsView.tsx` (≈186), `client/src/lib/orchestrate-draft.ts`
(`buildStartRequest` ≈262), `client/src/hooks/useOrchestrateDraft.ts`, `client/src/components/board/orchestrate/ModesStep.tsx`,
`client/src/components/board/LaunchSheet.tsx`, `client/src/lib/run-detail.ts`, `client/src/components/runs/RunDetail.tsx`, and the existing tests for the
sheets and run detail that `grep -l` finds.

**No mocks exist for this feature.** The rows follow `SettingsRow`/`SettingsGroup` (`client/src/components/ui/SettingsRow.tsx`) and `Segmented`
(`client/src/components/ui/Segmented.tsx`) as `TimeZoneGroup.tsx` and `WatchdogGroup.tsx` use them; the sheet pickers follow the 36 px select family the
LaunchSheet's model/effort selects use (`.claude/DESIGN.md` §8.2/§8.6). Read `.claude/rules/board.md` before editing.

**Copy, verbatim (spec §7):** group title `Reviewer`, pill `this machine`; row `Models` with segments `Same for all groups` / `Big and small groups`; same:
rows `Model`, `Effort`; split: `Big groups — model`, `Big groups — effort`, `Small groups — model`, `Small groups — effort`, `Small group limit` with hint
`Groups with at most this many changed lines use the small pair. The first group always uses the big pair.`; model options `Agent default (Opus)`, `Opus`,
`Sonnet`, `Haiku`, `Fable`; effort options `Default`, `Low`, `Medium`, `High`, `XHigh`, `Max`; on `fileError` a hint under the title `review.json could not be
read — showing defaults. Saving replaces it.`

- `ReviewerFields({ value: ReviewConfig, onChange })` renders the rows; the limit input accepts only integers 1–10000 (an out-of-range value is shown as
  invalid and not sent).
- `ReviewerGroup` loads via `useReviewSetting`, saves on change (the same save pattern as `TimeZoneGroup`), shows the `fileError` hint.
- Orchestrate sheet (`ModesStep`): a `Reviewer` section seeded once from `useReviewSetting`; `buildStartRequest` sends `review` only when the pick differs
  from the seed (so an untouched sheet leaves the target machine's `review.json` in charge, spec §7 item 5).
- LaunchSheet: under an execute `pr` finish, the same `Reviewer` section, seeded once from `useReviewSetting`; the request carries `review` only when the
  pick differs from the seed (same rule as the Orchestrate sheet); the clause preview line uses `finishClause` with that `review`, so it shows the flags
  exactly when they will be sent.
- Run detail: `runDetailModel` exposes `reviewerLine = reviewerLabel(source.reviewConfig)`; `RunDetail` renders it beside the merge-mode label.

- [ ] **Step 1: Write the failing tests** (`test/settings-reviewer.test.tsx`, jsdom; fetch mocked):
  - `the Reviewer group renders the default config` — `Big and small groups` selected, small model `Sonnet`, limit `300`, pill `this machine`.
  - `switching to Same for all groups shows Model and Effort only and saves` — POST body `mode: 'same'`, the split pairs preserved.
  - `the fileError hint shows` — GET answers `fileError: true` → the exact hint text.
  - `an out-of-range limit is not saved` — type `0` → no POST.
  - Orchestrate sheet: untouched → request has no `review`; changed small model → request `review` equals the edited config.
  - LaunchSheet: PR finish shows the Reviewer section; untouched → the request has no `review` and the clause preview has no `--review-`; changed small
    model → request `review` equals the edited config and the preview contains `--review-mode`; in-place finish shows no Reviewer section.
  - Run detail (`test/run-detail-model.test.ts`): a run with `reviewConfig` → `reviewerLine` is its label; an older run without it → `Reviewer: default`.
  - Orchestrate draft (`test/orchestrate-draft.test.ts`) and LaunchSheet (`test/launch-sheet.test.tsx`) carry the sheet cases above.
- [ ] **Step 2: Run** `pnpm exec jest test/settings-reviewer.test.tsx <grep hits>` — FAIL. **Step 3: Implement.** **Step 4: Run** + `pnpm run typecheck` —
  PASS.
- [ ] **Step 5: Commit** — `feat(board): Reviewer settings, launch-sheet pickers and run detail line`.
- [ ] **Step 6: `/ui-verify`** on Settings → Shared → Reviewer (both modes, `fileError`), the Orchestrate sheet's Reviewer section and the execute
  LaunchSheet's Reviewer section under a PR finish, at 1440 px and at phone width, light and dark. Fix every defect it reports on the branch and commit
  `fix(board): ui-verify findings` if any.

### Task 12: post-merge hand run (not a merge gate)

After merge: `pnpm run plugin:sync`, restart Claude Code, then in this repo: a small edit → `/backlog-review` → one dispatch, full; another edit → second
`/backlog-review` → incremental, earlier findings reported; a synthetic branch above 12 files → N concurrent dispatches with their configured models; `full`
→ full; the fix offer appears and its fix commits nothing. Record the outcome in the PR or a follow-up backlog item.

---

## Self-review notes

- Spec coverage: §1 → Tasks 1–6; §2 → Task 2; §3 → Task 3 (+ state write in Task 4); §4 → Tasks 4–6; §5 → Task 6; §6 → Tasks 7–8; §7 → Tasks 1, 7, 9–11;
  Acceptance → every task's tests, Task 11 Step 6, Task 12.
- Author calls made in this plan, beyond the spec: the exact flag spelling (`--review-mode` required with any review flag); the state-path and repo-key
  scheme; `config --defaults` for resuming an older run file; `<manifest>.findings.json` as `--previous`'s source of earlier findings; a `review` override on
  an in-place execute or a groom is a 400; both sheets send `review` only when the pick differs from the Settings seed; `--previous` takes the latest
  manifest, not the first (spec §6 wording corrected — the first loses round-2 findings); `review.mjs` bad-argument exits are 1, matching `orchestrate.mjs`.
