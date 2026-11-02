# CLAUDE.md floor: cross-cutting rules only — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Plan convention (overrides the writing-plans template):** this plan specifies behaviour, signatures, exact test cases and expected values — never
> literal implementation code. Write the bodies yourself, and disagree with the plan where the code says otherwise; record the disagreement in the commit
> body. Size numbers here are soft unless a test asserts them.

**Goal:** Cut the every-session `CLAUDE.md` floor from 37,952 B to roughly 11 KB by keeping only cross-cutting rules there and homing every subsystem
rule in exactly one path-fenced `.claude/rules/*.md`, with guards that stop it regrowing.

**Architecture:** The three-tier layout stays (headline / mechanism / reasoning). What changes is tier one's contract: from "the same set as tier two"
to "a declared subset of tier two, plus a path → rule-file table". A fence audit makes sure no rule leaves `CLAUDE.md` unless its rule file's `paths:`
covers everything it governs. Guards live in `test/claude-rules.test.ts` over the pure parsers in `test/helpers/rule-tiers.ts`.

**Tech Stack:** Markdown, TypeScript, jest (`pnpm run test:jest`).

**Spec:** `docs/superpowers/specs/2026-11-02-claude-md-floor-design.md` — read it in full before Task 1; its tables (keep-list, new homes, surfaces) are
the source of every rule number below.

## Global Constraints

- Headlines move byte-equal (compared on the joined text, `joinWrapped`). Never reword a headline while moving it.
- New prose wraps at 160 columns; never reflow untouched existing text (it rewrites blame).
- Comments explain why, at the repo's existing density.
- `CLAUDE.md` keeps an `## Invariants` heading (`tierOne` throws without it; `agents/backlog-reviewer.md:129` names it). Everything from that heading to
  end of file is tier one, so the path → rule-file table and `## Layout` sit ABOVE it.
- Do not edit `agents/backlog-reviewer.md`, anything under `~/.claude/`, or `skills/` behaviour.
- `git add <explicit files>`, never `-A`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Locally run only the touched suites: `pnpm run test:jest -- claude-rules dialog-count-docs` (plus any suite whose ASSERTIONS you edit). CI runs the rest.
- Decided in this plan (spec "Left to the builder"): the five homeless bullets (#26, #75, #78, #79, #101) move into rule files as **unlinked** bullets
  under the same 80-word cap `CLAUDE.md` uses — no invented reasoning entries. The guard changes to allow that (Task 1).

## Review Focus

1. A rule whose governed code sits outside its rule file's fence leaves `CLAUDE.md` anyway — the anti-goal. Pinned by the audit record (Task 2), reviewed
   row by row, not by a test.
2. A headline altered by a single byte during the move → the subset guard reports it as missing in rules (Task 1 fixture `subset-detects-drift`).
3. The same unlinked bullet pasted into two rule files → reported as multi-homed by headline (Task 1 fixture `headline-homed-twice`).
4. A rule file added or its `paths:` edited without updating the `CLAUDE.md` table → table guard red in both directions (Task 3 fixtures).
5. Rule text lost in the shuffle (Layout's embedded rules especially) → the token-survival check (Task 5) over old Invariants + Layout + Conventions.

---

### Task 1: Guard contract — subset, unlinked rule-file bullets, one home per headline

**Files:**
- Modify: `test/helpers/rule-tiers.ts` (`compareTiers`, header comment lines 4-9 and the `compareTiers` doc comment)
- Modify: `test/claude-rules.test.ts` (header comment lines 6-17; the existing `compareTiers` fixture at :267-284; the cases at :323 and :340)

**Interfaces:**
- Produces: `compareTiers(one: TierBullet[], two: { file: string; bullets: TierBullet[] }[]): { missingInRules: string[]; multiHomed: string[] }` —
  `missingInClaude` is removed (tier two may hold what tier one does not). Keys: a linked bullet keys on `${anchor}\t${headline}`; an unlinked bold-led
  bullet keys on `-\t${headline}`. `multiHomed` lists any key — anchor OR headline — whose tier-two bullets sit in more than one file, formatted
  `"<anchor or headline> → <file>, <file>"`.
- Produces: an exported `const UNLINKED_WORD_CAP = 80` moved into `rule-tiers.ts` (both the CLAUDE.md predicate and the rule-file case use it).

- [ ] **Step 1: Write failing fixture cases** in `describe('rule-tiers helpers')`:
  - `compareTiers treats tier one as a subset`: tier one `[A]`, tier two file `x` = `[A, B]` → `{ missingInRules: [], multiHomed: [] }`.
  - `subset-detects-drift`: tier one `[A']` where A' differs from A by one character in the headline, tier two `[A]` → `missingInRules` has exactly one
    entry, containing A's anchor.
  - `headline-homed-twice`: tier two files `x` and `y` each hold the same unlinked bullet `- **Same rule** text` → `multiHomed` is
    `['Same rule → x, y']`.
  - `anchor-homed-twice` (existing behaviour, kept): same anchor in files `x` and `y` → `multiHomed` names the anchor with both files.
  - Rewrite the existing fixture at `:267-284` to the new shape: drop every `missingInClaude`; its three subcases become `{ missingInRules: ['Y\tH2'],
    multiHomed: [] }`, `{ missingInRules: [], multiHomed: ['X → a, b'] }`, and (the `H1` / `H1 ` drift) `{ missingInRules: ['X\tH1'], multiHomed: [] }`.
- [ ] **Step 2: Run** `pnpm run test:jest -- claude-rules` — expected: four FAIL — the first three new fixtures and the rewritten `:267` fixture (the
  result still carries `missingInClaude`; unlinked bullets are keyed by `undefined`).
- [ ] **Step 3: Implement** the new `compareTiers` per the Interfaces block.
- [ ] **Step 4: Change the real-tree cases.** The `:323` case: a rule-file bullet has 0 or 1 anchors; 0 is allowed only when its joined text is at most
  `UNLINKED_WORD_CAP` words, more than 1 is always an offender. The `:340` case: renamed to state the subset contract, passes
  `one = tierOne(CLAUDE_MD).linked` ONLY (seven keep-list rules — #1, 18, 25, 42, 74, 76, 80 — are unlinked with no rule-file home, and must not be
  reported), and asserts `{ missingInRules: [], multiHomed: [] }`. The `-\t${headline}` key exists for tier-two multi-home detection alone. Add a fixture for the `:323` predicate: a 0-anchor bullet of 80 words passes, 81 words fails, 2 anchors fails.
- [ ] **Step 5: Rewrite the two header comments** to the subset contract (tier one is a declared subset; the table in Task 3 is what covers the routes
  that never `Read` a fenced file). Keep the rest of each comment.
- [ ] **Step 6: Run** `pnpm run test:jest -- claude-rules` — expected: PASS (today's same-set tree satisfies the subset).
- [ ] **Step 7: Commit** `test(rules): tier one is a subset of tier two, one home per headline`.

### Task 2: Fence audit and the new homes

**Files:**
- Create: `docs/superpowers/reviews/2026-11-02-claude-md-floor-fence-audit.md` (the audit record)
- Modify: `.claude/rules/*.md` (`paths:` widenings; the five new unlinked bullets; Layout's embedded rules routed here)
- Test: `test/claude-rules.test.ts` (existing guards — globs match a tracked file, one home)

**Interfaces:**
- Consumes: Task 1's guard (unlinked bullets allowed; one home per headline).
- Produces: the audit record's **keep-list** section — the final list of headlines that stay in `CLAUDE.md` (the spec's 14 plus every audit addition).
  Task 3 reads it.

- [ ] **Step 1: List the audit's subjects** in the record: every bullet in today's `## Invariants` except the 14 keep-list rules (spec table: #1, 2, 18,
  20, 25, 42, 46, 47, 51, 60, 64, 74, 76, 80); the three Conventions bullets on supertest, jsdom fixture dates, test location; and every normative
  sentence in today's `## Layout` (spec lists CLAUDE.md:45, :55, :62, :71-72, :79, :84-85, :91, :97 — re-find them by text, line numbers drift).
- [ ] **Step 2: For each subject**, name the files and symbols it governs (use `codegraph explore "<symbols>"` first, then `grep -rln`), match each
  against its home rule file's `paths:` (for the homeless five, the spec's proposed home), and record one row: `# | headline (first 60 chars) | home |
  governed paths outside the fence | resolution`. Resolution is one of: `fenced` (nothing outside), `widen: <glob>` (one or two specific files — use the
  narrowest glob naming them; it must match a tracked file today), `rehome: <file>` (another rule file already fences everything it governs — cheaper
  than widening), `keep` (spans several subsystems — joins the keep-list). Known rows to start from: #13 (`board.md`; also governs
  `server/src/agents/` orchestrate route and `shared/agent.ts`), #75 (`BM_REPO_ROOTS` in `server/src/jira/env.util.ts`), the test-location convention
  (`skills/*/tools/*.test.mjs`, `scripts/*.test.mjs` per `scripts/test-all.mjs:33`).
- [ ] **Step 3: Apply the resolutions**: widen the `paths:` arrays; move the five homeless bullets into their homes as unlinked bullets (verbatim text,
  ≤ 80 words; a bullet over the cap gets a short reasoning entry in `docs/subsystems/invariants.md` and links it, rather than being trimmed); turn each Layout normative sentence that resolved to a rule file into a bullet there (bold the rule
  sentence as its headline; unlinked unless an existing `invariants.md` heading is its reasoning — then link that anchor). Do not touch `CLAUDE.md` yet.
- [ ] **Step 4: Write the keep-list section** at the end of the record: the 14 plus every `keep` row, each as its full joined headline.
- [ ] **Step 5: Run** `pnpm run test:jest -- claude-rules` — expected: PASS. If the subset case reports `missingInRules`, a moved headline drifted;
  fix the rule-file copy, never `CLAUDE.md`.
- [ ] **Step 6: Commit** `docs(rules): fence audit — widen fences and home the homeless rules`.

### Task 3: The new CLAUDE.md, its table guard and its budget

**Files:**
- Modify: `CLAUDE.md`, `docs/overview.md`, `test/claude-rules.test.ts`, `test/dialog-count-docs.test.ts:76-78`

**Interfaces:**
- Consumes: the audit record's keep-list (Task 2).
- Produces: a `## Rule files` section in `CLAUDE.md` above `## Invariants` holding a markdown table `| Rule file | paths |`, one row per file in
  `.claude/rules/`, the `paths` cell being that file's globs in backticks, comma-separated, in frontmatter order. One sentence under it: before editing a
  file under a glob by any route that does not `Read` it (`codegraph_explore`, `Write`, `Grep`, `Glob`), read that rule file.
- Produces: `pathTableOf(claudeMd: string): Map<string, string[]>` exported from `test/helpers/rule-tiers.ts` — rule file name → globs, parsed from that
  section only.
- Produces: `compareTable(table: Map<string, string[]>, rules: Map<string, string[]>): { missingInTable: string[]; missingOnDisk: string[];
  mismatched: string[] }` exported from `test/helpers/rule-tiers.ts` — pure, so the guard is fixtured, not only run over the real tree. `mismatched`
  entries are the file name; globs compare as ordered lists.

- [ ] **Step 1: Write failing tests:**
  - fixture `pathTableOf` reads `| \`a.md\` | \`x/**\`, \`y.ts\` |` as `a.md → ['x/**', 'y.ts']` and ignores tables outside `## Rule files`.
  - fixture `compareTable`: table `{a.md: ['x/**'], b.md: ['y/**']}` against rules `{a.md: ['x/**', 'z.ts'], c.md: ['w/**']}` →
    `{ missingInTable: ['c.md'], missingOnDisk: ['b.md'], mismatched: ['a.md'] }`; identical maps → all three empty.
  - real tree, `the rule-file table and .claude/rules are the same set both ways, globs equal to paths:` — `compareTable(pathTableOf(CLAUDE_MD), <name →
    pathsOf>)` is all-empty.
  - real tree, `CLAUDE.md stays under its budget`: `Buffer.byteLength(CLAUDE_MD) <= 14_336`; failure message:
    `CLAUDE.md is <n> B, over its 14 KB budget — move a rule down a tier into its .claude/rules file; do not compress wording.`
  - `dialog-count-docs.test.ts`: `CLAUDE.md keeps the headline` becomes `board.md keeps the headline`, same string asserted against
    `.claude/rules/board.md` (unless the audit kept #15 — then leave it).
- [ ] **Step 2: Run** `pnpm run test:jest -- claude-rules dialog-count-docs` — expected: table and budget FAIL; dialog-count passes until the delete.
- [ ] **Step 3: Rewrite `CLAUDE.md`:** intro and `## Commands` untouched; `## Layout` cut to one line per top-level seam (spec list) with its pointer,
  the descriptive remainder moved verbatim to `docs/overview.md` under a heading of your choice; `## Rule files` table; `## Invariants` = the reworded
  preamble (tier one is cross-cutting rules only; subsystem rules live in the table's files) followed by exactly the keep-list bullets, unchanged; `##
  Conventions` = PR-title bullet only, plus any convention the audit kept.
- [ ] **Step 4: Run** the same command — expected: PASS, and print `wc -c CLAUDE.md` (target ~11 KB; over 14,336 is a fail).
- [ ] **Step 5: Commit** `docs: CLAUDE.md keeps only cross-cutting rules`.

### Task 4: Reword the surfaces that state the old contract

**Files:**
- Modify: `.claude/rules/tests.md:8-12` (#104's mechanism), `docs/subsystems/invariants.md` (three-tier entries — find by `grep -n "multiset\|same set\|headline is in CLAUDE"`), `docs/overview.md:16,30-32`, every `.claude/rules/*.md` header line ("the headline is in CLAUDE.md…"), and the "CLAUDE.md's …" comments in every hit of `grep -rln CLAUDE.md test/` whose cited rule moved.

- [ ] **Step 1:** Replace same-set wording with the subset contract and the table, in each listed place. Comments in tests: point at the rule file the rule
  now lives in; leave comments about rules still in `CLAUDE.md` alone.
- [ ] **Step 2: Run** `pnpm run test:jest -- claude-rules dialog-count-docs` — expected: PASS (`tests.md` is itself guarded; its #104 headline must not
  change, only its mechanism).
- [ ] **Step 3: Commit** `docs: state the subset contract wherever the same-set one was`.

### Task 5: Prove nothing was lost, re-measure

**Files:**
- Create: `scratchpad` script only (not committed); append results to the audit record.

- [ ] **Step 1: Token survival.** From `git show origin/main:CLAUDE.md`, take `## Layout`, `## Invariants`, `## Conventions`; split into words (backticked
  spans kept whole). Every word with ≥ 4 characters must appear somewhere in the union of the new `CLAUDE.md`, `.claude/rules/*.md` and
  `docs/overview.md`. Expected: zero missing, or each missing word listed in the record with why (e.g. a `Why:` link URL that now lives only in the rule
  file — it must still be found there).
- [ ] **Step 2: Re-measure.** `node ~/.claude/skills/preload-audit/tools/floor.mjs audit --project <worktree> --markdown`; record before (37,952 B) and
  after for `CLAUDE.md` and the Memory-files subtotal in the record.
- [ ] **Step 3: Commit** the record `docs: fence-audit record — survival check and floor before/after`.
