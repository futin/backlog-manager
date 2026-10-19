# Review 2 — `docs/superpowers/plans/2026-10-19-jira-phase-4-skill.md` (re-check of commit dd3cb73)

Scope: only the hunks in `git diff dd3cb73~1 dd3cb73 -- docs/superpowers/plans/2026-10-19-jira-phase-4-skill.md`. Surrounding text read only where a
changed line depends on it. Every repo claim below was checked against the worktree at dd3cb73.

## Verdict: APPROVE

No Critical or Important findings. Every file path, line number (within a couple of lines), exported name and count the changed hunks cite exists and says
what the plan says it says; the new test case, the new usage forms and the new exit-code sentence match the plan's own rulings R2, R8 and R9 verbatim.

## What was verified

| Plan line | Claim | Checked against | Result |
| --- | --- | --- | --- |
| 20, 29 | #307 is merged to `main` | `git log main`: `f86ca6b feat(jira): assign and transition from the issue modal (#307)` | true |
| 50 | both plugin-root guards cover every file under `skills/` | `test/skill-plugin-root.test.ts:11-24` (`filesUnder`, `.md`/`.mjs`), `test/skills-plugin-root.test.ts:10-26` | true |
| 118-119 | a comment in `backlog.test.mjs` says the awaited form is accepted "for backlog.mjs ALONE" | `skills/backlog/tools/backlog.test.mjs:3354` | true (line 3354, not 3356 — see M1) |
| 133-134 | the `withApi` docblock at 3744-3746 says `spawnSync` while the code spawns async | `backlog.test.mjs:3745` says `spawnSync`; `runNode` at 3758-3760 uses `spawn` | true |
| 149-150 | the new 2xx-unreadable case's sentence | plan R2, line 58: `the API answered <status> with a body jira.mjs cannot read` | byte-equal |
| 153 | `--help`, `-h`, `help` → exit 0 | plan R8, line 85 | consistent (see M5 for a pre-existing ambiguity on "no command") |
| 218-221 | `skill-plugin-root.test.ts:29` is `toBe(6)`; `skills-plugin-root.test.ts:40` is the six-name `it.each` | both files, those lines | true |
| 221 | the `it.each` regex accepts `jira/tools/jira.mjs` | `skills-plugin-root.test.ts:44`: `/node "\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/[a-z-]+\/tools\/[a-z]+\.mjs"/` | matches the command form Task 3 line 231 fixes |
| 249-250 | `pnpm run test:jest -- a b` runs both files | `package.json:17` `jest --runInBand` | fine |
| 260-261 | `trackedFiles()` is tracked + untracked-not-ignored | `test/claude-rules.test.ts:184-208` (`ls-files` and `ls-files --others --exclude-standard`) | true; `skills/` is not ignored (`.gitignore`) |
| 273 | `.claude/rules/skills.md:21` spells `${BM_API_PORT ?? 4322}` and the code uses `\|\|` | `skills.md:21`; `skills/backlog/tools/backlog.mjs:731`, `api-call.mjs:68` both `\|\|` | true (see M2) |
| 276-278 | the `skills.md` bullet names `backlog.mjs` and `api-call.mjs` as the awaited CLIs; `invariants.md`'s section lists them | `.claude/rules/skills.md:50-51`; `docs/subsystems/invariants.md:2510-2515` | true (see M3) |
| 287 | `README.md:3,12,271,302`, `docs/overview.md:3,22,100` are the "six"/"three CLIs" spots | grep `six\|three CLIs` | exactly those lines |

## Minor

- **M1 — plan:118.** The "backlog.mjs ALONE" comment begins at `backlog.test.mjs:3354` (its block runs 3354-3362), not 3356. Harmless — 3356 is inside
  the block — but the number is off by two. Also note the block's "The other two CLIs hold no asynchronous work" (3357) stays true after `jira.mjs` joins
  (those two are `orchestrate.mjs` and `retro.mjs`), so only the ALONE sentence and the `api-call.mjs` paragraph need the third name.
- **M2 — plan:273.** The `??` → `||` port-spelling fix names only `.claude/rules/skills.md:21`, but `docs/subsystems/skills.md:61` carries the identical
  `${BM_API_PORT ?? 4322}`, and Task 4 Step 4 (plan:284) already opens that file. Suggest: "and the same spelling at `docs/subsystems/skills.md:61`", so the
  task does not leave one of two homes contradicting the code.
- **M3 — plan:276-278 (Step 2b).** The "awaited CLIs" list the step points at is the `api-call.mjs` bullet at `invariants.md:2510-2515`, which is in the
  named section — fine. But a second, already-stale list sits at `invariants.md:3682-3683` ("accepts `= await main(` for this file alone and still requires
  the synchronous form of the other two"), in the task-46 section, and it will be wrong twice over once `jira.mjs` lands. Pre-existing drift (it missed
  `api-call.mjs` too), so not this plan's defect, but one line in 2b naming 3682 would close it while the file is open.
- **M4 — plan:219.** "`toContain('jira/tools/jira.mjs')` beside the other CLIs" — `test/skill-plugin-root.test.ts:30-31` lists one CLI
  (`backlog/tools/backlog.mjs`) and one reference file, not several CLIs. Wording only.
- **M5 — plan:220 (and :153).** `test/skills-plugin-root.test.ts:38` says "every one of the six skills" in the non-vacuity comment; adding `'jira'` to
  the list at :40 without touching :38 leaves a stale count. Add "and its comment at line 38 says seven".
- **M6 — plan:85 vs :153 (pre-existing, unchanged text).** R8 puts "No command" in the "USAGE on stdout, exit `0` when asked for" group and `(none)` in the
  exit-`1` group; the test at :153 resolves it as exit `1` + `unknown command: (none)`, matching `backlog.mjs`'s shape. Reads fine once you reach the test,
  but R8's first clause could drop "No command," so the ruling and the test say the same thing in one place.
- **M7 — plan:133-134.** Beyond the `withApi` docblock, `backlog.test.mjs:3700` ("Every case below is a `spawnSync` that has to return") makes the same
  false claim two paragraphs up. The plan's "do not copy as is" still covers it; just noting there are two such lines, not one.
- **M8 — plan:249-250 (ordering).** The `toBe(6)` → `7` edit and the `it.each` `'jira'` entry are tests that fail before `SKILL.md` exists; the plan
  schedules them in Step 4, after the write in Step 3. Moving them into Step 1 would keep the task's red-then-green shape; as written nothing is wrong,
  just out of the plan's own TDD order.
- **M9 — plan:261.** `trackedFiles()` is at `test/claude-rules.test.ts:200-208` with its docblock at 184-198; the cited `185-200` lands on the docblock.
  Close enough to find; noting for precision.
