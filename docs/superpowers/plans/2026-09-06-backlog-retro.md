# backlog-retro Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sixth plugin skill, `backlog-retro`, whose tool sweeps every
orchestrator run on the machine into one deterministic JSON and whose prose
turns that JSON into a report, a pick-list of backlog items and a record the
next sweep is measured against.

**Architecture:** `skills/backlog-retro/tools/retro.mjs` is a thin CLI
(`sweep`, `record`, `last`) over small modules in `tools/lib/`: path
derivation, run files, session logs, reviews, a least-squares rate fit, the
driver transcript, totals and deltas, a text renderer. It reads the
run-state directory the way `orchestrator.service.ts` does — fresh per
call, never writing there — and owns exactly one directory,
`~/.backlog-manager/retro/`, written by `record` alone. `SKILL.md` carries
the five-step procedure; the labelling of fix-verdict reviews and the report
prose are the session's, never the tool's.

**Tech Stack:** Node ESM, zero dependencies, `node:test` +
`node:assert/strict` under `pnpm run test:skills` (glob
`skills/*/tools/*.test.mjs`), fixtures built in `os.tmpdir()` per test.

**Spec:** `docs/superpowers/specs/2026-09-06-backlog-retro-design.md` —
read it first; §-numbers below refer to it.

## How to read this plan — tests are authoritative, code is illustrative

This plan **deliberately overrides** writing-plans' "code blocks required"
rule. It specifies behaviour, names, exact expected values and edge cases;
it does not hand over implementation code or test scaffolding to
transcribe. Handed code gets copied verbatim, so a defect in a plan becomes
a defect on the branch with nobody positioned to catch it — seven such
defects were traced to plan text in each of two earlier projects, test
scaffolding being the worst offender because it reads as boilerplate. Where
a fragment appears below it is a shape to match, never a line to paste. You
may disagree with any line here that turns out wrong in the file; say so in
the item's `stage` note.

Every task ends green: `pnpm run test:skills`, and for Task 9 `pnpm test`
and `pnpm run typecheck` too. There are **no commit steps**:
`backlog-execute` never commits, and the orchestrator commits the worktree
once when the item finishes.

## Global Constraints

- **Zero dependencies, node built-ins only**, ESM, same node the other tools
  run under. No `npm install` anywhere in this task.
- **One skill's `tools/` never imports another's.** `retro.mjs` carries its
  own copies of `orchHome()` and `projectDir()`; it does not import
  `orchestrate.mjs` or `backlog.mjs` (CLAUDE.md Invariants, and
  `orchestrate.mjs`'s own comment on the same duplication).
- **Reads:** `$BM_ORCH_HOME` else `~/.backlog-manager/orchestrator/`;
  `$BM_REGISTRY_FILE` else `~/.backlog-manager/registry.json` (read-only);
  `$BM_CLAUDE_PROJECTS` else `~/.claude/projects/` (driver transcript only);
  `$BM_RETRO_HOME` else `~/.backlog-manager/retro/` (read by `sweep` for
  `previous`, written by `record` alone).
- **Writes:** only `record`, only under the retro home. Nothing under the
  run-state directory, ever (spec §3.6).
- **Exit codes:** `sweep` `0` on any readable home (empty included), `1`
  usage or unreadable home or unknown `--project`; `record` `0` written,
  `1` bad input, `2` refuses to overwrite; `last` `0`, `3` no record yet.
  Every non-zero exit prints one line on stderr and writes nothing.
- **Tests never touch the real home**: every test mkdtemps its own orch
  home, retro home, registry file and claude-projects root, passes them
  through the four env variables to `spawnSync`, and removes them in
  `t.after` (the `orchFixture` pattern in `orchestrate.test.mjs`).
- **Every number printed by `--text` or placed in `totals` comes from the
  sweep's own rows**, never a literal.
- **Estimated figures are marked**: any dollar figure computed from fitted
  rates carries `estimated: true` in JSON and the word `est.` in text.

---

## File structure

Create:

- `skills/backlog-retro/tools/retro.mjs` — CLI: `RetroError`, usage,
  `main(argv)` dispatch, the three commands wired to the modules.
- `skills/backlog-retro/tools/lib/paths.mjs` — the four homes,
  `projectDir`, `decodeProjectDir`, `claudeProjectKey`, `readRegistryNames`.
- `skills/backlog-retro/tools/lib/run-files.mjs` — run files → `projects`,
  `runs`, `items` (stage durations, queue wait, verification failures).
- `skills/backlog-retro/tools/lib/sessions.mjs` — `logs/*.jsonl` →
  `sessions`, the item join, the `usage` cross-check.
- `skills/backlog-retro/tools/lib/reviews.mjs` — `reviews/*.md` and
  `verify/*.status`.
- `skills/backlog-retro/tools/lib/rates.mjs` — the least-squares fit and
  pricing.
- `skills/backlog-retro/tools/lib/driver.mjs` — the driver transcript.
- `skills/backlog-retro/tools/lib/totals.mjs` — `totals`, `previous`
  deltas, `caveats` assembly.
- `skills/backlog-retro/tools/lib/text.mjs` — the `--text` renderer.
- `skills/backlog-retro/tools/retro.test.mjs` — CLI end-to-end cases.
- `skills/backlog-retro/tools/retro-lib.test.mjs` — module-level cases (the
  glob is `tools/*.test.mjs`, so tests stay at the `tools/` level and import
  from `./lib/`).
- `skills/backlog-retro/SKILL.md`, `skills/backlog-retro/references/rationale.md`.

Modify:

- `CLAUDE.md` — line 3 (skill count and list), the Layout bullet that lists
  `skills/…`, one new Invariants bullet.
- `README.md` — the skill count and list.

## Shared vocabulary for every task

The sweep's JSON is one `RetroSweep` object. Field names below are the
contract every later task and the skill read; keep them exactly.

- `generatedAt` (ISO, `new Date().toISOString()`), `home`, `retroHome`.
- `projects[]`: `{ path, name, dir, runs, items }` — `name` from the
  registry or `null`; `dir` the encoded directory name; two counts.
- `runs[]`: `{ runId, project, status, startedAt, updatedAt, mergeMode,
  mergeModeEffective, questionMode, driverSessionId, file, current,
  attention, itemCount }` — `attention` verbatim from the file,
  `driverSessionId` from `driver.sessionId` or `null`, `current` true for
  `run.json`, false for `runs/*.json`.
- `items[]`: `{ runId, project, id, title, stage, fixLoops, note,
  permissionMode, stages, queueWaitMin, verification, usage, sessionKeys }`
  — `stages` maps a **from**-stage name to minutes spent before the next
  stamp; `queueWaitMin` is the `pending` span alone; `verification` is
  `[{ cmd, ok, failures }]` with `failures` present only when `ok` is false,
  as `{ files, tests, errors }`; `usage` verbatim from the file or `null`;
  `sessionKeys` filled by the join.
- `sessions[]`: `{ key, project, itemId, runId, kind, loop, file, sessionId,
  result, context, joinedBy }` — `key` is `<project dir>/<file basename>`;
  `kind` ∈ `execute | fix | retry`; `loop` integer or `null`; `result` is
  `null` or `{ costUsd, turns, durationMs, input, output, cacheRead,
  cacheCreation, denials, terminated, model }` with `terminated` ∈ `ok |
  spend-limit | error`; `context` is `null` or `{ floor, peak, messages }`;
  `joinedBy` ∈ `usage | item | none`.
- `reviews[]`: `{ file, project, itemId, pass, verdict, critical,
  important }` — the two excerpts are strings, present only when `verdict`
  is `fix`, empty string for a section reading `None.`; `verify` status
  rides on the item as `verifyStatus` (`0`, `1`, or `null`).
- `drivers[]`: one per run: `{ runId, project, sessionId, transcript, turns,
  context: { avg, max }, tokens: { input, output, cacheRead, cacheCreation },
  subagents: { count, tokens, unmeasured }, estimatedCostUsd, estimated:
  true }` or `{ runId, project, driver: null, reason }` with `reason` ∈
  `no-lease | not-found | unreadable`.
- `rates`: `null` or `{ cacheRead, cacheCreation, output, input, sessions,
  maxResidualUsd }` — dollars per token, not per million.
- `totals`: see Task 4 for the exact keys.
- `previous`: `null` or `{ generatedAt, file, deltas, labelRates,
  candidates }` — see Task 6.
- `caveats[]`: `{ kind, detail }` with `kind` ∈ `collision | no-lease |
  rates | killed | usage-mismatch | long-context`.

---

### Task 1: CLI skeleton and paths

**Files:**
- Create: `skills/backlog-retro/tools/retro.mjs`
- Create: `skills/backlog-retro/tools/lib/paths.mjs`
- Test: `skills/backlog-retro/tools/retro.test.mjs`,
  `skills/backlog-retro/tools/retro-lib.test.mjs`

**Interfaces:**
- Produces `RetroError(message, code)` (exported from `retro.mjs`, same
  shape as `OrchestrateError`: the message goes to stderr, the code becomes
  the exit status) and `main(argv) → number`, guarded by the same
  `process.argv[1]` check `orchestrate.mjs` ends with so tests can import
  without running.
- Produces from `lib/paths.mjs`: `orchHome()`, `retroHome()`,
  `registryFile()`, `claudeProjectsRoot()` (each `$ENV` else the default
  under `os.homedir()`), `projectDir(root, project)` (=
  `path.join(root, encodeURIComponent(project))`), `decodeProjectDir(name)`
  (`decodeURIComponent`), `claudeProjectKey(absPath)` (every `/` and `.`
  replaced by `-`), `readRegistryNames(file) → Map<path, name>` (empty map
  when the file is absent or unparsable — a broken registry must not stop a
  sweep).

- [ ] **Step 1: Write the failing tests.** In `retro-lib.test.mjs`:
  `claudeProjectKey('/Users/a/Documents/custom-projects/backlog-manager')`
  is exactly `-Users-a-Documents-custom-projects-backlog-manager`;
  `claudeProjectKey('/Users/a/x/.worktrees/bug-26')` is exactly
  `-Users-a-x--worktrees-bug-26`; `projectDir('/h', '/Users/a/p')` ends with
  `%2FUsers%2Fa%2Fp` and `decodeProjectDir` of that basename gives
  `/Users/a/p` back; `retroHome()` returns `$BM_RETRO_HOME` when set and
  `<homedir>/.backlog-manager/retro` when not (set and delete the variable
  inside the test, restore in `t.after`); `readRegistryNames` on a file
  holding the real registry shape (`{ "projects": [{ name, path, createdAt
  }] }`) maps two paths to two names, and on a missing path returns an empty
  Map. In `retro.test.mjs`: spawning `retro.mjs` with no arguments exits
  `1` and stderr starts with `usage: retro.mjs`; with `bogus` exits `1` and
  stderr contains `unknown command: bogus`.
- [ ] **Step 2: Run** `node --test skills/backlog-retro/tools/*.test.mjs`
  — every case fails on missing modules.
- [ ] **Step 3: Implement** the two files: `RetroError`, the `USAGE`
  constant listing the three commands with their flags as spec §2 prints
  them, `main` dispatching `sweep | record | last` to functions that for now
  throw `RetroError('not implemented', 1)`, the try/catch that turns a
  `RetroError` into stderr + code and rethrows anything else. Every path
  helper a one-liner with a comment saying which other file holds the twin
  and why it is not imported.
- [ ] **Step 4: Run** the suites — green.

### Task 2: Run files — projects, runs, items

**Files:**
- Create: `skills/backlog-retro/tools/lib/run-files.mjs`
- Modify: `skills/backlog-retro/tools/retro.mjs` (`sweep` calls it, prints
  a partial `RetroSweep` with `runs`, `items`, `projects`, the rest empty)
- Test: both test files

**Interfaces:**
- Produces `readRunFiles(home, names) → { projects, runs, items }` with the
  shapes in the shared vocabulary. `names` is the registry map.
- Produces `stageSpans(stageAt) → { stages, queueWaitMin }`: entries
  sorted by timestamp, each consecutive pair differenced into minutes
  (two decimals) keyed by the **earlier** stage's name; the `pending` span
  goes to `queueWaitMin` and never into `stages`.
- Produces `verificationFailures(tail) → { files, tests, errors }`: ANSI
  escapes (`\x1b[…m`) stripped first; `files` = every capture of
  `FAIL <non-space>`; `tests` = the text after each `●` up to end of line,
  trimmed, capped at 120 characters; `errors` = the first three lines
  matching any of `error`, `Error`, `Cannot`, `ENOENT`, `not found`,
  `Timeout`, `timed out`, `exceeded`.
- Test helper `seedRun(home, project, run, { archived })` writes the JSON to
  `run.json` or `runs/<runId>.json` under `projectDir(home, project)`,
  creating directories. Build runs from the real key set:
  `test/fixtures/orchestrator-run.json` is the authority `orchestrate.test.mjs`
  already reads — load it, then override fields.

- [ ] **Step 1: Write the failing tests.** Module cases: `stageSpans` on
  `{pending: T0, preflight: T0+2m, dispatched: T0+2.5m, inspecting:
  T0+22.5m, reviewing: T0+23m, fixing: T0+29m, verifying: T0+51m, merging:
  T0+53m, merged: T0+53.2m}` yields `queueWaitMin: 2` and a `stages` key
  set of exactly the seven from-stages `{preflight, dispatched, inspecting,
  reviewing, fixing, verifying, merging}` — the terminal `merged` stamp
  opens no span — with `stages.dispatched === 20`, `stages.fixing === 22`,
  `stages.merging === 0.2`; `stageSpans` with stamps given out of key order
  still sorts by time; `verificationFailures` on a tail containing
  `\x1b[31mFAIL\x1b[0m test/agents-origin-guard.test.ts`, a line
  `  ● the agents POST guard › 403s an Origin: null POST to plan`, and
  `sh: jest: command not found` yields `files:
  ['test/agents-origin-guard.test.ts']`, `tests: ['the agents POST guard ›
  403s an Origin: null POST to plan']`, `errors: ['sh: jest: command not
  found']`. CLI cases: two projects, project A with a current `run.json`
  (2 items) and one archived run (1 item), project B with a current run (1
  item) → `projects.length === 2`, `runs.length === 3`, `items.length ===
  4`, the archived run has `current: false`, project A's `name` comes from
  a registry fixture and project B (unregistered) has `name: null` and
  `path` equal to the decoded dir; a run file with `driver: { sessionId:
  'abc', at }` yields `driverSessionId: 'abc'` and one without yields
  `null`; an item whose `verification` holds `[{cmd:'pnpm run test', ok:
  false, tail: <the tail above>}, {cmd:'pnpm run test', ok: true, tail:
  ''}]` yields `failures` on the first entry only; an empty home (directory
  exists, nothing inside) exits `0` with `runs: []`; a home path that is a
  regular file exits `1` with stderr containing `unreadable`.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement** `run-files.mjs` and wire `sweep`. A project
  directory with no `run.json` but a `runs/` directory is swept; one with
  neither is skipped silently. An unparsable run file adds nothing to
  `caveats`: print one stderr line naming the file and continue, because a
  corrupt archive must not stop the sweep.
- [ ] **Step 4: Run** — green.

### Task 3: Session logs and the item join

**Files:**
- Create: `skills/backlog-retro/tools/lib/sessions.mjs`
- Modify: `retro.mjs` (`sweep` fills `sessions`, `items[].sessionKeys`,
  `items[].usage`, the `collision`, `killed` and `usage-mismatch` caveats)
- Test: both test files

**Interfaces:**
- Produces `classifyLog(basename) → { itemId, kind, loop } | null`: matches
  `^([a-z]+-\d+)(?:-(fix|retry)-(\d+))?\.jsonl$`; anything else (`.err`,
  `.pid`, other names) → `null`.
- Produces `readSession(file, meta) → session` reading the file line by
  line: the last `type: "result"` event → `result` (see vocabulary;
  `denials` = length of `permission_denials` or `0`; `model` = the one key
  of `modelUsage`, or the keys joined by `,`, or `null`; `terminated` =
  `spend-limit` when `is_error` and the `result` text matches `/spend
  limit/i`, `error` for any other `is_error`, else `ok`); every
  `type: "assistant"` event carrying `message.usage` → one context sample
  `cache_read_input_tokens + cache_creation_input_tokens + input_tokens`;
  `context.floor` = min of the first three samples, `peak` = max,
  `messages` = count; `sessionId` from the result event's `session_id`,
  else the `system`/`init` event's, else `null`. A malformed line is
  skipped.
- Produces `attachSessions(items, sessions) → caveats`: a session attaches
  to the item with its `itemId` in the **latest** run (by `startedAt`) whose
  item carries a `dispatched` stamp; if more than one run dispatched that
  item, one `collision` caveat naming the item and the run ids. If the
  chosen item has `usage` entries and one of them has the session's
  `sessionId`, `joinedBy = 'usage'` and the log's `costUsd`/`turns` are
  compared to the entry's: a difference is a `usage-mismatch` caveat and
  the item's values are kept as the run file's; otherwise `joinedBy =
  'item'`; a session whose item exists in no run is `joinedBy: 'none'`,
  `runId: null`. Each session with `result: null` adds one `killed` caveat.
- Test helper `seedLog(home, project, basename, { assistantContexts,
  result })` writes a stream-json file: one `system`/`init` line with a
  `session_id`, one `assistant` line per context sample with `message.usage`
  split so `cache_read + cache_creation + input` equals the sample, and a
  final `result` line built from `result` (or no result line when `null`),
  mirroring the real shape seen in `logs/bug-26.jsonl` (`total_cost_usd`,
  `num_turns`, `duration_ms`, `usage`, `modelUsage`, `permission_denials`,
  `is_error`, `session_id`, `result`).

- [ ] **Step 1: Write the failing tests.** `classifyLog('bug-26.jsonl')` →
  `{itemId:'bug-26', kind:'execute', loop:null}`; `'task-6-fix-2.jsonl'` →
  `fix`, `2`; `'bug-4-retry-1.jsonl'` → `retry`, `1`; `'bug-26.err'` and
  `'bug-26.pid'` → `null`. `readSession` on a seeded log with contexts
  `[60000, 55000, 70000, 90000, 120000]` and a result of `total_cost_usd:
  5.4632055, num_turns: 66, duration_ms: 824747, usage: {input 126,
  cache_creation 129875, cache_read 6880201, output 28949}, modelUsage:
  {'claude-opus-5[1m]': …}, permission_denials: [{},{}], is_error: false`
  → `result.costUsd === 5.4632055`, `turns 66`, `denials 2`, `model
  'claude-opus-5[1m]'`, `terminated 'ok'`, `context: {floor: 55000, peak:
  120000, messages: 5}`, `sessionId` equal to the seeded id. A result with
  `is_error: true` and text `You've hit your individual spend limit …` →
  `terminated: 'spend-limit'`; `is_error: true` with other text → `error`.
  No result line → `result: null`, `context` still computed. A garbage line
  before the result → still parsed. CLI cases: project with items `bug-1`
  in run R1 (dispatched) and `bug-1` again in later run R2 (dispatched),
  one `bug-1.jsonl` → the session's `runId` is R2 and `caveats` holds one
  `collision` naming `bug-1`, `R1`, `R2`; an item with `usage:
  [{sessionId:'s1', costUsd: 5.0, turns: 60}]` and a log whose result has
  `session_id 's1'`, cost `5.0`, turns `66` → `joinedBy: 'usage'`, one
  `usage-mismatch` caveat whose detail contains `turns`; a log for an item
  no run holds → `joinedBy: 'none'`; a log with no result → one `killed`
  caveat naming the file.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement** `sessions.mjs`; wire into `sweep`.
- [ ] **Step 4: Run** — green.

### Task 4: Reviews, verify status, totals

**Files:**
- Create: `skills/backlog-retro/tools/lib/reviews.mjs`,
  `skills/backlog-retro/tools/lib/totals.mjs`
- Modify: `retro.mjs` (`sweep` fills `reviews`, `items[].verifyStatus`,
  `totals`)
- Test: both test files

**Interfaces:**
- Produces `readReviews(projectDirPath, project) → reviews[]`: file name
  `^([a-z]+-\d+)-(\d+)\.md$` gives `itemId` and `pass`; `verdict` is the
  first `^verdict:\s*(\S+)` match lower-cased, `null` when absent; for
  `verdict === 'fix'` only, `critical` and `important` are the text between
  `## Critical` / `## Important` (any heading level, case-insensitive) and
  the next `##` heading or end of file, trimmed, with a body that is only
  `None.`/`None`/`—`/`-`/`n/a` (case-insensitive, optional markdown
  emphasis) normalised to the empty string.
- Produces `readVerifyStatus(projectDirPath, itemId) → 0 | 1 | null`.
- Produces `computeTotals(sweep) → totals` with exactly these keys:
  `runs: { total, byStatus }`, `items: { total, byStage, dispatched }`
  (`dispatched` = items carrying a `dispatched` stamp), `sessions: {
  byKind, byTerminated, killed }`, `costUsd: { measured, driverEstimated,
  allIn }` (`measured` = Σ `result.costUsd`; the other two `null` until
  Task 5 fills `drivers`), `merged` (items with stage `merged` or
  `branched`), `costPerMerged: { measured, allIn }` (`null` when `merged`
  is 0), `stageMinutes` (Σ per from-stage across items), `queueWaitMin: {
  total, median, p90 }`, `fixLoops: { count, itemsAffected, costUsd,
  minutes }` (`count` = Σ `fixLoops`; `costUsd` = Σ cost of `fix` and
  `retry` sessions; `minutes` = Σ `stages.fixing`), `verdicts: { approve,
  fix, byPass }` (`byPass` keyed by pass number, each `{ approve, fix }`),
  `context: { byProject }` (per project path `{ floorMedian, peakMedian }`
  over `execute` sessions), `firstVerifyFailures[]` (`{ project, itemId,
  cmd, tests, errors }` for every failing verification entry), `itemWallMin:
  { median, p90, withFix, withoutFix }` (preflight → `merged|branched`
  stamp, minutes; the last two are medians over items with `fixLoops > 0`
  and `=== 0`). Conventions, used everywhere a median or p90 appears: the
  median of an even-length list is the mean of its two middle values; p90
  is the nearest-rank value at index `ceil(0.9 · n) − 1` of the sorted
  list; both are `null` for an empty list, never `0`.

- [ ] **Step 1: Write the failing tests.** Module: a review file with
  `verdict: fix`, `## Critical\n\nNone.\n\n## Important\n\n- x:1 — the
  comment says the opposite\n\n## Minor\n\n- y` → `critical: ''`,
  `important: '- x:1 — the comment says the opposite'`, `pass` from
  `bug-21-2.md` is `2`; `verdict: approve` → no `critical`/`important`
  keys at all; a file with no verdict line → `verdict: null`. CLI fixture
  for totals (build it once as a helper, reuse in Tasks 5–7): project P,
  run R1 (current) with items A (`merged`, fixLoops 0, stamps giving
  `dispatched` 20 min and preflight→merged 30 min), B (`merged`, fixLoops
  1, `fixing` 22 min, preflight→merged 60 min), C (`parked`, fixLoops 0,
  dispatched, no terminal stamp); logs `A.jsonl` cost 4, `B.jsonl` cost 6,
  `B-fix-1.jsonl` cost 2, `C.jsonl` cost 3, all `terminated ok`; reviews
  `A-1` approve, `B-1` fix, `B-2` approve; `verify/A.status` = `0`. Assert:
  `totals.merged === 2`, `costUsd.measured === 15`,
  `costPerMerged.measured === 7.5`, `fixLoops` deep-equals `{ count: 1,
  itemsAffected: 1, costUsd: 2, minutes: 22 }`, `verdicts` deep-equals `{
  approve: 2, fix: 1, byPass: { 1: { approve: 1, fix: 1 }, 2: { approve: 1,
  fix: 0 } } }`, `items.byStage` deep-equals `{ merged: 2, parked: 1 }`,
  `sessions.byKind` deep-equals `{ execute: 3, fix: 1 }`, `itemWallMin`
  deep-equals `{ median: 45, p90: 60, withFix: 60, withoutFix: 30 }`, item
  A's `verifyStatus === 0` and B's `null`; with the fixture's B
  verification `[test false with a FAIL tail, test true]`,
  `firstVerifyFailures` has one entry for B with the extracted test name.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement** the two modules; wire into `sweep`.
- [ ] **Step 4: Run** — green.

### Task 5: Rate fit and the driver transcript

**Files:**
- Create: `skills/backlog-retro/tools/lib/rates.mjs`,
  `skills/backlog-retro/tools/lib/driver.mjs`
- Modify: `retro.mjs` (`sweep` fills `rates`, `drivers`,
  `totals.costUsd.driverEstimated/allIn`, `costPerMerged.allIn`, the
  `no-lease`, `rates` and `long-context` caveats)
- Test: both test files

**Interfaces:**
- Produces `fitRates(sessions) → rates | null`: over sessions with
  `result && result.costUsd > 0`, regressors in the fixed order `[cacheRead,
  cacheCreation, output, input]`, ordinary least squares by solving the
  four normal equations with Gaussian elimination (partial pivoting; a
  singular system → `null`); requires at least **8** such sessions, else
  `null`; returns dollars per token plus `sessions` (the count used) and
  `maxResidualUsd` (max |predicted − actual|).
- Produces `priceTokens(tokens, rates) → number` = Σ tokens × rate over the
  four keys.
- Produces `readDriver(run, projectsRoot, rates) → driver`: when
  `run.driverSessionId` is `null` → `{ driver: null, reason: 'no-lease' }`;
  else the path `<projectsRoot>/<claudeProjectKey(run.project)>/<sessionId>.jsonl`;
  missing → `not-found`; unreadable/unparsable → `unreadable`; else:
  `turns` = assistant events with `message.usage`; `context.avg`/`max` over
  the same samples as Task 3; `tokens` = sums of the four usage fields;
  `subagents.count` = tool_use blocks named `Agent`; `subagents.tokens` = Σ
  of every `<subagent_tokens>(\d+)</subagent_tokens>` match in the file;
  `subagents.unmeasured` = max(0, count − number of matches);
  `estimatedCostUsd` = `priceTokens(tokens, rates)` or `null` when
  `rates` is `null`; `estimated: true` always present on a measured
  driver.
- Caveats added in `sweep`: one `no-lease` caveat with the count of runs
  lacking a lease (not one per run); one `rates` caveat when `rates` is
  `null` (fewer than 8 measured sessions) or when present (naming
  `maxResidualUsd`); one `long-context` caveat when any session's
  `context.peak` exceeds `200000`, naming the sessions.

- [ ] **Step 1: Write the failing tests.** `fitRates` on eight synthetic
  sessions whose `costUsd` is computed exactly from rates `[0.5e-6, 10e-6,
  24.8e-6, 82e-6]` over token mixes `cacheRead = 1e6·(i+1)`, `cacheCreation
  = 1e5·((i % 3)+1)`, `output = 1e4·((i % 5)+1)`, `input = 100·((i % 4)+1)`
  for `i = 0..7` (four columns with no two proportional — `input` must not
  follow `i+1`, or it duplicates the `cacheRead` column and the system is
  singular) recovers each rate within a relative `1e-6` and reports
  `sessions: 8`, `maxResidualUsd < 1e-6`; seven sessions → `null`; eight
  sessions all with identical token mixes (singular) → `null`.
  `priceTokens({cacheRead: 2e6, cacheCreation: 0, output: 0, input: 0},
  rates)` → `1.0` with the rates above. `readDriver`: a run with lease
  `'d1'` and a seeded transcript at
  `<root>/<claudeProjectKey(project)>/d1.jsonl` holding three assistant
  usages — per sample `(cache_read, cache_creation, input, output)` of
  `(90000, 9990, 10, 1000)`, `(100000, 19990, 10, 1000)`, `(110000, 29990,
  10, 1000)`, so the contexts are 100000, 120000, 140000 and the sums are
  `input 30, output 3000, cacheRead 300000, cacheCreation 59970` — two
  `Agent` tool_use blocks and one user line containing
  `<subagent_tokens>150000</subagent_tokens>` → `turns 3`, `context {avg:
  120000, max: 140000}`, `tokens` as listed, `subagents {count: 2, tokens:
  150000, unmeasured: 1}`, `estimatedCostUsd` equal to `priceTokens` of
  those tokens under the test rates, `estimated: true`; no lease →
  `reason: 'no-lease'`; lease with no file → `not-found`; lease with a
  directory in place of the file → `unreadable`. CLI: the Task 4 fixture
  plus enough sessions for a fit (extend the fixture helper with a flag
  that adds five more `execute` logs on extra merged items) → `rates` non-
  null, `totals.costUsd.driverEstimated` equals the sum of measured drivers'
  estimates, `allIn = measured + driverEstimated`, `costPerMerged.allIn =
  allIn / merged`; with only the four-session fixture → `rates: null`,
  `driverEstimated: null`, `allIn: null`, one `rates` caveat; one
  `no-lease` caveat whose detail contains the count `1` when one run
  lacks a lease; a session seeded with a `250000` context sample → one
  `long-context` caveat naming it.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement**; wire into `sweep`.
- [ ] **Step 4: Run** — green.

### Task 6: Deltas, `--text`, `--project`

**Files:**
- Create: `skills/backlog-retro/tools/lib/text.mjs`
- Modify: `skills/backlog-retro/tools/lib/totals.mjs` (`previous`),
  `retro.mjs` (flags)
- Test: both test files

**Interfaces:**
- Produces `newestRecord(retroHome) → { file, record } | null`: the
  `*.json` whose basename sorts last (stems are filesystem-safe ISO stamps,
  Task 7, so lexical order is time order); absent directory → `null`.
- Produces `computePrevious(sweep, newest) → previous | null`: `deltas`
  has exactly these keys, each `{ then, now, delta }` with `delta = now −
  then` (or `null` when either side is `null`): `runs`, `items`, `merged`,
  `costMeasured`, `costPerMergedMeasured`, `fixLoopRate` (=
  `fixLoops.itemsAffected / items.dispatched`), `fixVerdictRate` (=
  `verdicts.byPass[1].fix / (byPass[1].approve + byPass[1].fix)`),
  `itemWallMedianMin`, `queueWaitMedianMin`; `labelRates` = for each of
  the four labels the share of the record's `labels.reviews` values (or
  `null` when the record has none); `candidates` = the record's
  `labels.candidates` verbatim.
- Produces `renderText(sweep) → string`: a headline block (runs, items,
  merged, measured spend, per merged item, fix-loop items and share,
  median item wall), a stage table (from-stage, total minutes, share of
  the non-queue total), an outcomes table, a caveats list, and a
  `previous` block or the line `first record — no previous sweep`. Every
  estimated dollar figure carries the suffix `est.`; the word `estimated`
  never appears next to a measured one.
- `sweep --project <abs path>`: restricts every array to that project;
  when no run-state directory exists for it, exit `1` with stderr `no run
  state for <path>`.

- [ ] **Step 1: Write the failing tests.** With a retro home holding a
  record fixture (`{ sweep: { generatedAt, totals: {...} }, labels: {
  reviews: { 'P/reviews/B-1.md': 'drift' }, candidates: [{ title: 'x',
  kind: 'bug', project: 'P', status: 'declined' }] }, recordedBy: 't' }`
  whose totals give `merged 1`, `costMeasured 10`, `fixLoopRate 0.5`) and
  the Task 4 fixture → `previous.deltas.merged` deep-equals `{ then: 1,
  now: 2, delta: 1 }`, `previous.deltas.costMeasured.delta === 5`,
  `previous.labelRates.drift === 1`, `previous.candidates[0].status ===
  'declined'`; an empty retro home → `previous: null`. `renderText` on the
  Task 4 fixture sweep contains `merged 2 of 3`, a line starting with
  `fixing` containing `22`, the string `first record`, and does not
  contain `est.`; on the Task 5 fitted fixture it contains `est.` on the
  driver line. CLI: `--project <A's path>` → only A's runs and items,
  `projects.length === 1`; `--project /nowhere` → exit `1`, stderr `no run
  state for /nowhere`; `--text` prints no `{` on its first line and
  `--json` (and no flag) prints parsable JSON.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement**; wire flags.
- [ ] **Step 4: Run** — green.

### Task 7: `record` and `last`

**Files:**
- Modify: `skills/backlog-retro/tools/retro.mjs`
- Test: `retro.test.mjs`

**Interfaces:**
- `record --sweep <json> --labels <json> --report <md>`: reads all three;
  validates that `labels.reviews` is an object whose every value is one of
  `drift | red-proof | defect | other` and `labels.candidates` an array
  whose entries carry `title` (string), `kind` ∈ `bug | task | idea`,
  `project` (string), `status` ∈ `filed | declined | deferred`, optional
  `filedAs`; any violation → exit `1` naming the first offending key,
  nothing written. Record stem = `sweep.generatedAt` with every `:` and `.`
  replaced by `-`. Writes `<retroHome>/<stem>.json` = `{ sweep, labels,
  recordedBy }` (`recordedBy` = `$CLAUDE_CODE_SESSION_ID` or `'unknown'`)
  via write-to-temp-then-rename, then copies the report to `<stem>.md`,
  creating the directory. If `<stem>.json` already exists → exit `2`,
  stderr `record exists: <path>`, both files byte-identical to before.
  Prints `{ "record": <json path>, "report": <md path> }` on success.
- `last`: prints the newest record's absolute path; empty or absent home →
  exit `3`, stderr `no record yet`.

- [ ] **Step 1: Write the failing tests.** A valid sweep file (any
  `RetroSweep`, `generatedAt: '2026-09-06T21:03:30.697Z'`), a valid labels
  file and a report file → exit `0`, `<retroHome>/2026-09-06T21-03-30-697Z.json`
  exists with keys exactly `sweep, labels, recordedBy`, `recordedBy ===
  'sess-1'` when the env carries it and `'unknown'` when it does not, the
  `.md` is byte-identical to the report; running `record` again with a
  changed report → exit `2`, both files unchanged (compare bytes); a
  labels file with `'nit'` as a label → exit `1`, stderr contains `nit`,
  no file written; a candidate with `status: 'maybe'` → exit `1`; a
  missing `--labels` path → exit `1`. `last` on the home with that record →
  prints its path; on an empty home → exit `3`, stderr `no record yet`;
  with two records → the later stem.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole `pnpm run test:skills` — green.

### Task 8: The skill and its rationale

**Files:**
- Create: `skills/backlog-retro/SKILL.md`,
  `skills/backlog-retro/references/rationale.md`

**Interfaces:**
- `SKILL.md` frontmatter in the house shape (`name: backlog-retro`, a
  `description: >` block that names the triggers — `/backlog-retro`,
  "retro the orchestrator", "how did the runs do", "sweep the runs",
  "what did the pipeline cost" — and ends `Trigger: /backlog-retro`;
  `trigger: /backlog-retro`).
- Body, in this order: what it is and is not (one paragraph; kaizen named
  as the per-session tool and the sink); **§1 Sweep** (`node
  "$CLAUDE_PLUGIN_ROOT/skills/backlog-retro/tools/retro.mjs" sweep --json
  > <scratch>/sweep.json`, read it, never recompute); **§2 Label** (the four
  labels with one-sentence definitions from spec §1, the labels file shape
  from spec §3.2 verbatim, the instruction to label only `verdict: fix`
  reviews from their excerpts); **§3 Report** (the fixed section order from
  spec §3.3, written to the scratch directory, `estimated` marked wherever
  printed, artifact optional); **§4 Propose** (candidate criteria from spec
  §3.4, one multi-select `AskUserQuestion`, capture procedure by reference
  to `backlog-capture` — `init`, then `new` → write, one at a time — in the
  target project's root, the pipeline-versus-project routing rule, and the
  prose-only fallback when the tool is unavailable); **§5 Record and bank**
  (`record` with the three paths, the kaizen line shape from spec §3.5
  verbatim, shell append, grep back, skip silently when the log is
  absent); **Hard limits** (the six from spec §3.6, as bullets).
- `references/rationale.md`: why a tool computes and a session labels
  (spec "Why this exists", condensed); the closed label set and why a typo
  is refused; and the **2026-09-06 baseline** table the first record will
  be compared against: 27 runs, 83 items, 58 merged, $540.71 measured over
  92 sessions, ≈$249 estimated drivers, 26 fix loops on 83 items, 27 fix
  verdicts of 91 reviews, 19 of 29 fix verdicts `drift` or `red-proof`,
  median merged item 37 min (28 without a fix loop, 61 with), fitted rates
  cache read $0.50/M, cache creation $10.0/M, output $24.8/M.

- [ ] **Step 1: Write both files.**
- [ ] **Step 2: Check** with `grep`: `SKILL.md` contains `trigger:
  /backlog-retro`, the five `##` step headings, `Hard limits`, the string
  `drift | red-proof | defect | other`, and `Lesson:`; `rationale.md`
  contains `540.71` and `2026-09-06`.
- [ ] **Step 3: Run** `pnpm run test:skills` — unchanged and green.

### Task 9: Documents

**Files:**
- Modify: `CLAUDE.md:3` (the opening sentence), the Layout bullet
  beginning `` - `skills/backlog/`, `skills/backlog-capture/` ``, and the
  Invariants list (add one bullet after the run-file single-writer bullet)
- Modify: `README.md` (the skill count and list; if task-24's rewrite has
  landed, edit its list, otherwise the current one — the count word must
  match the list either way)

- [ ] **Step 1: Edit `CLAUDE.md`.** Line 3: `six backlog skills`, the list
  gaining `` `backlog-retro` `` with a parenthetical `(sweeps every
  orchestrator run on the machine into a report, a pick-list of items and a
  record the next sweep is measured against)`. Layout: extend the skills
  bullet with `skills/backlog-retro/` and one sentence: `retro.mjs` reads
  the run-state directory and the driver transcript by lease id, owns
  `~/.backlog-manager/retro/`, and the spec path. Invariants, new bullet:
  **`~/.backlog-manager/retro/` has exactly one writer, `retro.mjs
  record`, and `backlog-retro` never writes under the run-state
  directory** — two sentences on why (a record is evidence; the run file's
  single writer is unchanged; `sweep` opens the retro home read-only for
  deltas), pointing at the spec.
- [ ] **Step 2: Edit `README.md`** so the count word and the list agree and
  include `backlog-retro` with one clause.
- [ ] **Step 3: Check**: `grep -c backlog-retro CLAUDE.md` ≥ 3, `grep -c
  backlog-retro README.md` ≥ 1, `grep -n 'five backlog skills' CLAUDE.md`
  prints nothing.
- [ ] **Step 4: Run** `pnpm test`, `pnpm run test:skills`, `pnpm run
  typecheck` — all green.

---

## Self-review against the spec

- §2.1 sweep inputs: run files (Task 2), logs (Task 3), reviews and verify
  (Task 4), driver (Task 5), joins and collision caveat (Task 3), rates
  (Task 5), output object (vocabulary + Tasks 2–6), `--text`/`--project`
  and exit codes (Tasks 2, 6). §2.2 record and §2.3 last (Task 7). §3 skill
  (Task 8). §4 documents (Task 9). §5 test list: every bullet has a case
  above. §7 decisions: no task contradicts one.
- Names used across tasks: `RetroError`, `main`, `orchHome`, `retroHome`,
  `registryFile`, `claudeProjectsRoot`, `projectDir`, `decodeProjectDir`,
  `claudeProjectKey`, `readRegistryNames`, `readRunFiles`, `stageSpans`,
  `verificationFailures`, `classifyLog`, `readSession`, `attachSessions`,
  `readReviews`, `readVerifyStatus`, `computeTotals`, `fitRates`,
  `priceTokens`, `readDriver`, `newestRecord`, `computePrevious`,
  `renderText` — each defined once, in the task that produces it, and
  referred to by that name afterwards.
