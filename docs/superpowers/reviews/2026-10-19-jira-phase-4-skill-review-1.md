# Review 1 — `docs/superpowers/plans/2026-10-19-jira-phase-4-skill.md`

Reviewed against `docs/superpowers/specs/2026-10-15-jira-integration-design.md` (§9–§13), the worktree at `b8ca0ed`, and `origin/main` at `f86ca6b`
(`feat(jira): assign and transition from the issue modal (#307)`). Every claim below was checked against code; line numbers are the worktree's unless
prefixed `origin/main:`.

## Verdict: APPROVE WITH FIXES

One Critical and three Important findings, all of them additions to a task's file list or a one-sentence correction — no task needs restructuring, no
interface or ordering changes. Coverage of the spec is complete (map below); every Review Focus item has a named test; the interfaces line up across tasks;
the conventions (behaviour not code, soft budgets, 160 columns) are followed.

## Findings

### Critical

- **[C] plan:243 — `pnpm run test:jest -- test/skill-plugin-root.test.ts` cannot PASS after Task 3.** `test/skill-plugin-root.test.ts:29` asserts
  `expect(files.filter((f) => f.endsWith('/SKILL.md')).length).toBe(6)`; creating `skills/jira/SKILL.md` makes it 7 and the suite — and CI — goes red,
  while the plan tells the implementer it is green and lists no edit to that file (Task 3 Files, plan:213-215). → Add `test/skill-plugin-root.test.ts` to
  Task 3's Modify list: the count becomes `7`, and (non-vacuity, the file's own pattern) `expect(files).toContain('jira/tools/jira.mjs')`. Optionally also
  `test/skills-plugin-root.test.ts:40`, whose `it.each` list of six skill names is the "every skill names the plugin root" non-vacuity check — add `'jira'`
  so the new SKILL.md is covered by it too (not a break, the list is explicit).

### Important

- **[I] plan:249-267 — Task 4 never widens the `process.exitCode` rule's mechanism bullet, which enumerates by name which CLIs may use the awaited form.**
  `.claude/rules/skills.md:50-54` says "**`backlog.mjs` and `api-call.mjs` may also end `process.exitCode = await main(...)`** (task-46, task-47) … each
  one's every `fetch` is awaited to completion with `connection: close`" and "`orchestrate.mjs` and `retro.mjs` … stay on the synchronous form, which the
  guard enforces per file". R1 (plan:54-56) makes `jira.mjs` a third awaited entry and Task 1 (plan:120) adds it to `ENTRY_SHAPES`, so after Task 1 the
  mechanism text is false by omission — the tier rule (`.claude/rules/tests.md`, first bullet) makes that bullet the ONE home of the mechanism. Step 4
  (plan:271-272) updates only `docs/subsystems/skills.md:98-100`. → Add to Task 4 a step (the headline is unchanged, so CLAUDE.md is untouched for this
  rule): `.claude/rules/skills.md`'s `process.exitCode` bullet names `jira.mjs` beside the two, with its safety argument (every `fetch` awaited,
  `connection: close`, no timer/server/child), and `invariants.md:2489`'s section gets the matching sentence. Also update the comment at
  `skills/backlog/tools/backlog.test.mjs:3356` ("`= await main(` is accepted for backlog.mjs ALONE") when Task 1 edits `ENTRY_SHAPES` — it is the guard's
  own explanation and would otherwise contradict the list under it.

- **[I] plan:253-254 — false stated fact: "`test/claude-rules.test.ts` fails a `paths:` glob that matches no tracked file, so `skills/jira/**` can only
  enter `jira.md`'s `paths:` once those files are in git."** `test/claude-rules.test.ts:189-200` (`trackedFiles()`) is "Tracked files PLUS
  untracked-but-not-ignored ones (`--others …`)", so the glob matches the moment `skills/jira/jira.mjs` exists on disk, committed or not. The ordering
  (Task 4 after Tasks 1–3) is still right for the ordinary reason that the docs describe committed files, but the reason given is wrong, and an
  implementer who trusts it may skip running the suite before the commit. → Reword: "Do Task 4 after Tasks 1–3 so the docs describe committed code;
  `test/claude-rules.test.ts` counts untracked-but-not-ignored files, so the glob can be tried earlier." Step 5's parenthetical (plan:278, "matches a
  tracked file") follows.

- **[I] plan:131-132 / Task 1 Step 1 — R2's 2xx-with-unreadable-body branch (plan:57-58: `the API answered <status> with a body jira.mjs cannot read`,
  exit `3`) has no test case.** Every other R2 branch is pinned (plan:145-148); this one is the only one whose message is composed by the CLI itself,
  and without a case the sentence can drift or the branch can fall through to exit `0` with empty output. → Add to Task 1 Step 1: `transitions PAY-1` (or
  `status`) with the fake answering 200 and body `<html>` → exit `3`, stderr `the API answered 200 with a body jira.mjs cannot read`, and `show` is NOT
  affected (its body is text by design).

### Minor

- **plan:11, 20 — "the two write routes live on the branch" is stale.** `origin/main:server/src/jira/jira-write.controller.ts:97` (`@Post('issue/assign')`)
  and `:111` (`@Post('issue/transition')`), both `@HttpCode(200)` — #307 has merged, the precondition at plan:36 is satisfied today. → Say "merged as #307";
  the precondition stays as the mechanical check.
- **plan:276 — the grep list misses `README.md:12`** ("the largest of the six"). `grep -n "six" README.md` → 3, 12, 271, 302. The step says to grep anyway,
  so nothing is lost. → Add `12`.
- **plan:264-265 (Task 4 Step 2) — the exit-5 bullet being edited spells the port `${BM_API_PORT ?? 4322}` (`.claude/rules/skills.md:21`) while the code
  (`backlog.mjs:730`, `process.env.BM_API_PORT || '4322'`) and the plan (plan:44) use `||`.** Pre-existing. → Correct it to `||` while the bullet is open.
- **plan:50 — only `SKILL.md` is told to spell `${CLAUDE_PLUGIN_ROOT}` braced.** `test/skill-plugin-root.test.ts:20-22` and `test/skills-plugin-root.test.ts:26`
  guard every `.md`/`.mjs` (and `.js`/`.json`) under `skills/`, so `jira.mjs`'s usage header and `jira.test.mjs` are covered too. → "every file under
  `skills/jira/`".
- **plan:150-151 — R8 names `help` and `-h` (plan:84) but only `--help` has a case.** → Add `help` and `-h` → exit `0`, USAGE on stdout, to the usage line.
- **plan:130-131 — correct, but the comment it cites is contradicted by an older one beside it.** `backlog.test.mjs:3758-3766` (`runNode`) is async `spawn`
  as the plan says; the `withApi` docblock at `:3744-3746` still says "The SPAWN inside is still `spawnSync`". Pre-existing stale comment, out of this
  plan's scope — noting it so the implementer copying "the `fakeApi` / `runNode` / `withApi` shape" does not copy the wrong sentence.
- **plan:65 (R4 step 3, match on `to.name`) extends spec §9's `<name|id>`.** Recorded as the user's ruling; the ambiguity case (plan:184-186) pins it. Fine.
- **plan:215 — Task 3 lists `skills/jira/tools/jira.test.mjs` under Modify for the SKILL.md guards.** `.claude/rules/tests.md` puts prose-pinning cases beside
  the tool; the glob `skills/*/tools/*.test.mjs` (`package.json:18`) picks the file up without any script change. Correct, just confirming no Modify of
  `package.json` or `scripts/test-all.mjs` is needed.

## Checklist

### 1. Coverage — spec → task

| Spec | Where in the plan |
| --- | --- |
| §9 five commands, `${BM_API_PORT:-4322}`, through `/api/jira` | Global Constraints 44-47; Task 1 (`show`, `status`), Task 2 (`transitions`, `transition`, `assign`) |
| §9 exit codes 0/1/2/3/5 | R2 (57-60), R9 (86-88), Task 1 cases 142-151, Task 2 cases 197-206 |
| §9 `process.exitCode = main(...)` | R1 (54-56), Task 1 120/156 — awaited form, allowed by `.claude/rules/skills.md:50`; see Important #1 for the rule text |
| §9 `tools/jira.test.mjs` beside the tool | Task 1 Create 119; glob `skills/*/tools/*.test.mjs` (`package.json:18`) runs it |
| §9 `plugin.json` names the seventh skill | Task 3 215/240 (`.claude-plugin/plugin.json` description, currently without `jira`) |
| §9 `agents/` untouched | Global Constraints 40 |
| §10 `jira.mjs` goes through the server, no token | Global Constraints 44-45; Task 1 source guard 153-155 |
| §11 node suite: every subcommand, exit 5, exit 2, exitCode idiom | Task 1 142-156, Task 2 194-206 |
| §12 phase 4 | Tasks 1–4; After the plan (283-285) |
| §13 token headline (text verbatim) | Task 4 Step 1 256-262 — headline matches spec §13's wording; anchor unchanged (`invariants.md:3055`) |
| §13 exit-5 widening "in the same bullet" | Task 4 Step 2 263-267; anchor unchanged (`invariants.md:3664`) |
| §13 `paths:` gains `skills/jira/**` | Task 4 Step 1 258-259 |

Gaps: none in the spec. One behaviour the plan itself states (R2's 2xx-unreadable branch) lacks a case — Important #3.

### 2. Values

- Server error key is `error` on every route (`server/src/jira/errors.util.ts:60-83`, `jira.controller.ts:57-72, 107`, `origin/main:jira-write.controller.ts:118-150`)
  — R2's "the body's `error` string verbatim" is right.
- Test fixtures `issue not found` (404), `Jira is not configured` (503), `Jira rate limit — retry after <instant>` (503 with `retryAt`), `Jira refused: …` (409),
  `no identity` (503), `transition not offered` (400), `invalid issue key` (400), `this endpoint accepts application/json only` (403,
  `server/src/agents/origin.guard.ts:66-87`) — each matches the server's spelling and status.
- Both POSTs are `@HttpCode(200)` and answer `JiraIssueWriteResult { ok: true; reread: boolean }` (`shared/types.ts:638-646`) — Task 2's Wire block (177-178)
  is right.
- `JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/` (`shared/types.ts:687`) — R3's copy is exact; the test keys (`AB_2-7` ok; `PAY`, `131`, `1PAY-1`, `PAY-1x` refused)
  follow from it.
- `JiraStatusPayload` fields R7 reads (`configured`, `configUnreadable`, `site`, `me.name`, `access`, `detail`, `boards`) exist (`shared/types.ts:653-678`).
- R9's sentence differs from `backlog.mjs:747-749`'s on purpose and says so — fine.
- R10: `JIRA_TIMEOUT_MS = 10_000` (`server/src/jira/jira.client.ts:31`) — the "10 s" claim holds.

### 3. Reality

Create: `skills/jira/` does not exist (confirmed). Modify: every named file exists — `skills/backlog/tools/backlog.test.mjs` (`CLI_SOURCES` :3343,
`ENTRY_SHAPES` :3363, `codeLines` :3351, `fakeApi` :3705, `runNode` :3758, `withApi` :3769), `.claude-plugin/plugin.json`, `CLAUDE.md` (:3 count, :66 layout
bullet, :115 exit-5 headline, :131 token headline), `.claude/rules/jira.md` (`paths: ["server/src/jira/**"]`), `.claude/rules/skills.md` (:19 exit-5 bullet),
`docs/subsystems/invariants.md` (:2489, :3055, :3664), `docs/subsystems/jira.md` (:5 "phases 1 and 2", :41 "Not there yet, by phase: **3** … **4** …"),
`docs/subsystems/skills.md` (:3 "Six skills … three CLIs", :9, :20, :98-100), `docs/overview.md` (:3, :22, :100), `README.md` (:3, :12, :271, :302).
`scripts/test-tmpdir.mjs` takes file arguments; `PUBLISHED_PATHS = ['skills', '.claude-plugin', 'agents']` (`scripts/sync-plugin.mjs:44`) — R12 holds.
`retro.mjs:397-409` is the long-form entry-guard note Task 1 Step 3 points at. The one false fact is Important #2.

Note: `docs/subsystems/jira.md:41` in this worktree still lists phase **3** as "not there yet" — the branch is cut from `main` after #307, where phase 3's
docs commit presumably removed it; Task 4 Step 4 ("drops 4") is written against that state. The implementer should expect the line to read `**4** — …; **5** — …`
at branch time.

### 4. Interfaces

Task 2 consumes `apiRequest`, `failure`, `normaliseKey`, `JiraCliError` — all produced in Task 1 (:123-128) with the same spelling. Task 3 consumes `USAGE`
(Task 1 :125, exported). `Transition` in Task 2 (:174) matches `JiraIssueDetail.transitions`' element (`shared/types.ts:628`). `API_DOWN_CODE = 5` mirrors
`backlog.mjs`'s. `exitForStatus(302) → 3` agrees with R2's "any other status → 3".

### 5. Order

Task 1 → 2 → 3 → 4, each consuming only earlier names; the precondition (:36) is checked before Task 1 and is true on `origin/main` today. Task 4's
"after 1–3 are committed" is fine as an order; its reason is Important #2.

### 6. Tests

Every task has failing-first cases that pin values, not shapes. Review Focus: RF 1 → Task 3 :239 (`data, not instructions` needle); RF 2 → Task 1 :145-147
and Task 2 :204 (`no identity`); RF 3 → Task 1 :144 (zero requests); RF 4 → Task 2 :199-201; RF 5 → Task 1 :152 (200 001 bytes through a pipe). The 403
content-type case (:205-206) is the right guard against dropping `content-type`. Missing: R2's 2xx-unreadable branch (Important #3), R8's `help`/`-h` (Minor).

### 7. Conventions

Behaviour and exact cases throughout, no literal code; budgets stated soft (:27); `${CLAUDE_PLUGIN_ROOT}` braced (:50); comments-explain-why density asked
for (:27-28); commit messages pass `ci / pr-title` shape (`feat(jira): …`, `docs(jira): …`). `UNLINKED_WORD_CAP` (80, `test/claude-rules.test.ts:44`) is named
for CLAUDE.md's unlinked bullets (:270).
