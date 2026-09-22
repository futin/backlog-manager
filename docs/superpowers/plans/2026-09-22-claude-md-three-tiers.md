# CLAUDE.md as a three-tier index — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (chosen — this session, inline, in a worktree) or
> superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template, deliberate and load-bearing:** this plan specifies BEHAVIOUR and EXACT TEST CASES — function names, signatures,
> expected values, edge cases, refusal messages — and never literal code. Handed code gets transcribed verbatim, so a bug in the plan becomes a bug in the
> branch with nobody positioned to catch it; test scaffolding is the worst offender. The implementer writes the code and is expected to disagree with the plan
> where the code says otherwise. Every size in this plan (line counts, word budgets) is a soft target, never a rule.

**Goal:** Cut the project CLAUDE.md from ~28k to ~9k tokens per session by moving each rule's mechanism into exactly one path-scoped `.claude/rules/*.md`
file, keeping the headline in CLAUDE.md and the reasoning in `invariants.md`, with source-reading tests pinning the seams.

**Architecture:** A throwaway script in the session scratchpad performs the split from one homes table (anchor → rule file), moving bullets as verbatim
lines. Three new jest guards in `test/claude-rules.test.ts`, backed by pure parsing helpers in `test/helpers/rule-tiers.ts`, are written first and shown red
against today's tree, then go green when the split lands. Hand edits update the seven prose sites that describe or consume the old pointer design.

**Tech Stack:** Node 20+ ESM (script), jest + ts-jest (guards, source-reading, no YAML/glob deps — same as the existing suite), node:test (skill prose
guards, unchanged), git worktree.

**Spec:** [docs/superpowers/specs/2026-09-22-claude-md-three-tiers-design.md](../specs/2026-09-22-claude-md-three-tiers-design.md) — the homes table,
the tier shapes and the consumer list live there; this plan argues from it and does not restate the reasoning.

## Global Constraints

- Work happens in a git worktree created through `superpowers:using-git-worktrees` at execution start, branch `claude-md-three-tiers`, based on `main` at
  `b3014cb` or later. Nothing in this plan touches `main` directly.
- Tier 1 line, exact: `- **<headline>** Why: [invariants.md](docs/subsystems/invariants.md#<anchor>)`. Longer than 160 columns → break before `Why:` onto a
  line indented two spaces.
- Headline = the bullet's FIRST bold span after joining continuation lines and collapsing whitespace. Byte-equal in tier 1 and tier 2 — the guard checks it.
- Tier 2 bullet = the original CLAUDE.md bullet as verbatim lines. Nothing is reworded in the move except the rules-about-rules bullet (Task 4).
- Rule-file frontmatter is one inline array with double quotes — `paths: ["a/**", "b.ts"]` — because that is the only shape `pathsOf` parses.
- No secondary pointer lines in rule files. One line shape: bullets.
- An unlinked bold-led CLAUDE.md bullet is ≤ 80 whitespace-separated words.
- New authored prose wraps at 160 columns; commit bodies at 72. Never reflow existing prose to widen it.
- `invariants.md` headings are anchors: none renamed, none removed.
- The migration script and its output logs live in the scratchpad directory and are never committed.
- Skill CLIs are untouched, so the `process.exitCode` rule does not arise; the script is not a skill CLI.
- Run one jest file with `pnpm exec jest --runInBand <file>`; the whole union with `pnpm test`.

---

## File structure

| path                                                          | responsibility                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `test/helpers/rule-tiers.ts` (create)                         | pure text parsers for tier-1 and tier-2 bullets, and the tier comparison — no fs, no repo paths          |
| `test/claude-rules.test.ts` (modify)                          | the guards: four kept cases, two dropped, three added, each new one over the real tree AND over fixtures |
| `test/dialog-count-docs.test.ts` (modify)                     | retargets the Escape mechanism assertion at `board.md`, keeps a headline assertion on CLAUDE.md          |
| `CLAUDE.md` (modify: script, then hand)                       | tier 1 — headlines; plus the Layout line, the DESIGN.md aside and the Invariants intro                   |
| `.claude/rules/{orchestrator,dispatch-watchdog,board,items,tracker,skills}.md` (rewrite) | tier 2 for the existing scopes                                                |
| `.claude/rules/{security,scripts,tests}.md` (create)          | tier 2 for the scopes no glob reached                                                                   |
| `docs/subsystems/invariants.md` (modify one section)          | tier 3's statement of the rules mechanism, plus the dated measurement                                   |
| `docs/overview.md` (modify three sites)                       | the doc map's description of CLAUDE.md and the rule files                                               |
| `agents/backlog-reviewer.md`, `skills/backlog-execute/SKILL.md`, `skills/backlog-orchestrate/SKILL.md` (one phrase each) | consumers told where tier 2 is        |
| `<scratchpad>/CLAUDE.original.md`, `<scratchpad>/split-claude-md.mjs` (uncommitted) | the pre-split source and the script that splits it                            |

---

### Task 1: Tier parsers and the three guards, red against today's tree

**Files:**
- Create: `test/helpers/rule-tiers.ts`
- Modify: `test/claude-rules.test.ts` (header comment lines 5–24; cases at 177–236)
- Modify: `docs/superpowers/specs/2026-09-22-claude-md-three-tiers-design.md` (one parenthetical, see step 6)

**Interfaces:**
- Produces, in `test/helpers/rule-tiers.ts` (all pure, all over strings, all exported):
  - `type TierBullet = { raw: string; joined: string; headline: string | null; anchors: string[]; words: number; line: number }`
  - `joinWrapped(raw: string): string` — continuation breaks become single spaces, whitespace runs collapse, ends trimmed.
  - `splitBullets(body: string, firstLine?: number): TierBullet[]` — a bullet starts at a column-0 `- `; continuation lines are the following lines that
    start with two or more spaces; a blank line, a heading or the next column-0 `- ` ends it. Lines that are not part of any bullet are ignored here
    (`freeProse` is where they matter). `line` is 1-based within `body`, offset by `firstLine` (default 1).
  - `headlineOf(joined: string): string | null` — the text between a leading `- **` and the first `**` after it; `null` when the bullet is not bold-led or
    the span never closes.
  - `anchorsOf(text: string): string[]` — every `docs/subsystems/invariants.md#<anchor>` in order, anchor part only (`[\w-]+`).
  - `wordCount(joined: string): number` — whitespace-separated tokens of the joined bullet with the leading `- ` marker removed.
  - `tierOne(claudeMd: string): { linked: TierBullet[]; unlinked: TierBullet[]; plain: TierBullet[] }` — bullets from the `## Invariants` heading to end of
    file; `linked` = bold-led with ≥ 1 anchor, `unlinked` = bold-led with none, `plain` = not bold-led. Throws with the message `CLAUDE.md has no ## Invariants
    heading` when the heading is absent.
  - `tierTwo(ruleBody: string, firstLine?: number): TierBullet[]` — every bullet of a rule file's body (the text after the closing `---`).
  - `freeProse(ruleBody: string, firstLine?: number): { line: number; text: string }[]` — every non-blank line that does not start with `#`, is not a column-0
    `- ` bullet start, and is not indented by two or more spaces.
  - `compareTiers(one: TierBullet[], two: { file: string; bullets: TierBullet[] }[]): { missingInRules: string[]; missingInClaude: string[]; multiHomed: string[] }`
    — keys are `${anchor}\t${headline}`; `missingInRules` = tier-1 keys with no tier-2 counterpart (multiset: a key present twice in tier 1 and once in tier 2 is
    missing once); `missingInClaude` the reverse; `multiHomed` = `${anchor} → file-a, file-b` for an anchor whose tier-2 bullets sit in more than one file.

- [ ] **Step 1: Write the helper module's unit cases in `test/claude-rules.test.ts`** (a `describe('rule-tiers helpers')` block — they are the guard's parsers,
  and a parser that produced nothing would pass every guard while asserting zero). Exact cases:
  - `joinWrapped('- **A\n  b** c\n  d')` → `'- **A b** c d'`.
  - `splitBullets('intro\n- one\n  cont\n- two\n\n- three\n# h\n- four')` → four bullets with `raw` `'- one\n  cont'`, `'- two'`, `'- three'`, `'- four'`
    and `line` 2, 4, 6, 8.
  - `headlineOf('- **A** rest')` → `'A'`; `headlineOf('- **A** and **B**')` → `'A'`; `headlineOf('- plain')` → `null`; `headlineOf('- **open')` → `null`;
    `headlineOf('- **\`code\` and text** x')` → `` '`code` and text' ``.
  - `anchorsOf('x docs/subsystems/invariants.md#a-b y docs/subsystems/invariants.md#c_d')` → `['a-b', 'c_d']`; `anchorsOf('none')` → `[]`.
  - `wordCount('- **A b** c d')` → `4`.
  - `tierOne` over a fixture with a `## Layout` bullet before `## Invariants`, then one linked, one unlinked bold-led, one plain bullet → the Layout bullet is
    excluded; `linked.length === 1`, `unlinked.length === 1`, `plain.length === 1`; `tierOne('no heading')` throws `/no ## Invariants heading/`.
  - `freeProse('# h\n\n- **A** x\n  cont\nStray sentence.\n- **B** y', 5)` → `[{ line: 9, text: 'Stray sentence.' }]`.
  - `compareTiers` with tier 1 `[X/H1, Y/H2, Y/H2]` and tier 2 `{ a: [X/H1, Y/H2] }` → `missingInRules: ['Y\tH2']`, `missingInClaude: []`,
    `multiHomed: []`; with tier 2 `{ a: [X/H1], b: [X/H1] }` → `multiHomed: ['X → a, b']` and `missingInClaude: ['X\tH1']` (the second copy has no tier-1
    twin); with tier 2 `{ a: [X/H1 with headline 'H1 '] }` (trailing space) → `missingInRules: ['X\tH1']`, `missingInClaude: ['X\tH1 ']`.

- [ ] **Step 2: Run the helper cases; expected: every one FAILS with "Cannot find module './helpers/rule-tiers'".**
  Run: `pnpm exec jest --runInBand test/claude-rules.test.ts`

- [ ] **Step 3: Create `test/helpers/rule-tiers.ts` implementing exactly the interfaces above.** No fs, no repo paths, no exports beyond those listed.
  The header comment says what a tier is and why the parsers are pure (fixtures are strings).

- [ ] **Step 4: Run the helper cases; expected: PASS, all of them.**

- [ ] **Step 5: Rewrite the guard cases in `test/claude-rules.test.ts`.**
  - Keep, verbatim in intent: `every rule file declares a non-empty paths: list`; `every invariants.md anchor a rule file cites resolves to a heading`;
    `every paths: glob matches at least one tracked file today`; `passes vacuously when there is no rules directory`.
  - Delete: `rule files are pointers only — no second copy of the reasoning`; `no rule file exceeds 25 lines`.
  - Add, each as a real-tree case plus fixture cases, with the exact expectations below. The real-tree cases read `CLAUDE.md` and every `RuleFile` through the
    existing `ruleFilesIn` / `bodyStart` helpers; the fixture cases call the helpers with strings.
    1. `a rule file is bullets and nothing else` — for each rule file: `freeProse(body, bodyStart+1)` is `[]`, and every `tierTwo` bullet has
       `anchors.length === 1`. Offenders reported as `<file>:<line>: <first 60 chars>` for prose and `<file>: <headline ?? first 60 chars> cites <n> anchors`
       for bullets; expect `[]`. Fixture: the `freeProse` and `anchorsOf` cases from Step 1 already cover the three failure shapes — reference them by
       name in the case's comment rather than duplicating.
    2. `CLAUDE.md headlines and rule-file bullets are the same set, one home per anchor` — `compareTiers(tierOne(CLAUDE).linked, RULES.map(f => ({ file:
       f.name, bullets: tierTwo(body(f)).filter(b => b.headline !== null) })))` has all three arrays empty. Expected TODAY: `missingInRules` has 66 entries
       (today's rule files carry pointer lines, which are not bold-led and so contribute no bullet), `missingInClaude` and `multiHomed` empty.
    3. `a linked CLAUDE.md bullet is a headline and a link, and an unlinked one is short` — every `linked` bullet's `joined` matches
       `^- \*\*(.+?)\*\* Why: \[invariants\.md\]\(docs\/subsystems\/invariants\.md#[\w-]+\)$`; every `unlinked` bullet has `words <= 80`. Offenders as
       `<line>: <first 80 chars of joined>`. Expected TODAY: 66 linked offenders, 0 unlinked. Fixtures, run through the same predicate extracted as a
       local function: `- **H** Why: [invariants.md](docs/subsystems/invariants.md#a)` → ok; the same followed by ` More text.` → offender;
       `- **H\n  tail** Why:\n  [invariants.md](docs/subsystems/invariants.md#a)` → ok after `joinWrapped`; an unlinked bullet of exactly 80 words → ok; of
       81 → offender.
  - Rewrite the header comment (lines 5–24) to describe the three tiers and what each guard catches silently in production: a rule with no `paths:` is loaded
    into every session; an anchor that no longer resolves lands the reader at the top of a 3,000-line file; a glob that matches nothing never fires; mechanism
    that creeps back into CLAUDE.md is paid for by every session; a headline edited on one side drifts the tiers apart. Keep the vacuous-pass paragraph.

- [ ] **Step 6: Run the file; expected: exactly two cases FAIL — guard 2 with 66 `missingInRules` entries, guard 3 with 66 linked offenders — and every
  other case PASSES.** Save the output to `<scratchpad>/task1-red.txt`; it is the red proof Task 3 refers back to. Then correct the spec's guard-2
  parenthetical ("goes red against today's tree, on eleven orphans") to "on all 66 — today's rule files carry pointers, not bullets; the eleven orphans are the
  subset that would still fail after a naive pointer-to-bullet upgrade". One sentence, nothing else in the spec changes.

- [ ] **Step 7: Run `pnpm run typecheck`; expected: clean.**

- [ ] **Step 8: Commit** — `test(claude-rules): guard the three tiers; red until the split lands` with a body stating that two cases are expected red on
  this commit and which task turns them green.

---

### Task 2: Retarget the Escape-count test at tier 2

**Files:**
- Modify: `test/dialog-count-docs.test.ts` (doc comment 4–18; `claudeBullet` 32–38; the second `it` 54–62)

**Interfaces:**
- Consumes: nothing from Task 1 — this file keeps its own `indexOf` approach on purpose (minimal change; it finds one bullet by a known prefix).
- Produces: nothing other tasks read.

- [ ] **Step 1: Change the assertions.**
  - Rename `claudeBullet()` to `mechanismBullet()`; it reads `.claude/rules/board.md` and slices from `- **Escape has one owner` to the next `\n- ` (or end).
    The `expect(at).toBeGreaterThan(-1)` guard stays inside it.
  - The second `it` becomes `the board rule file's bullet says the same three and points at the same reason`, asserting on `mechanismBullet()` exactly what
    it asserted before: `/three dialogs/`, not `/four dialogs/`, contains `LaunchSheet`, `OrchestrateSheet`, `/item modal/`, `/never a dialog/`.
  - Add a third `it`, `CLAUDE.md keeps the headline`: `CLAUDE` contains the exact string
    `- **Escape has one owner, and the topmost dialog is the only one that closes.**`.
  - Update the doc comment: the rule is stated at three depths — headline (CLAUDE.md), mechanism (`.claude/rules/board.md`), reasoning (`invariants.md`) —
    and the count lives in the second and third; the first is pinned only so a reader arriving from CLAUDE.md finds the rule.

- [ ] **Step 2: Run the file; expected: the new second case FAILS at `expect(at).toBeGreaterThan(-1)` (board.md has no such bullet yet); the first, third
  and fourth cases PASS.**
  Run: `pnpm exec jest --runInBand test/dialog-count-docs.test.ts`

- [ ] **Step 3: Commit** — `test(dialog-count): read the Escape mechanism from board.md; red until the split lands`.

---

### Task 3: The split — script, run, survival check, green

**Files:**
- Create (uncommitted): `<scratchpad>/CLAUDE.original.md`, `<scratchpad>/split-claude-md.mjs`
- Modify: `CLAUDE.md` (from the `## Invariants` heading to end of file; nothing above it)
- Rewrite: `.claude/rules/orchestrator.md`, `dispatch-watchdog.md`, `board.md`, `items.md`, `tracker.md`, `skills.md`
- Create: `.claude/rules/security.md`, `scripts.md`, `tests.md`

**Interfaces:**
- Consumes: the homes table and the `paths:` table from the spec's "Homes — the one table the migration reads" section, copied into the script as its two
  constants (62 anchor → file entries; 9 file → globs entries). `dispatch-watchdog`'s globs are `["server/src/agents/**", "shared/agent.ts"]`;
  `security`'s `["server/src/*.ts", "vite.config.ts", "docker-compose.yml"]`; `scripts`'s `["scripts/**", "package.json", "pnpm-workspace.yaml"]`;
  `tests`'s `["test/**", ".claude/rules/**"]`; the other five unchanged from today's files.
- Produces: the nine rule files and the tier-1 CLAUDE.md that Task 4's hand edits build on.

- [ ] **Step 1: Capture the docs-sync baseline BEFORE any tracked doc changes.** Invoke the `docs-sync` skill for a status report only — no rewrites, no
  re-baselining — and save the list of docs it reports as drifted to `<scratchpad>/docs-sync-before.txt`. If the skill offers only a rewrite flow, record
  what it proposes and decline every change.

- [ ] **Step 2: Copy the source.** `cp CLAUDE.md <scratchpad>/CLAUDE.original.md`. The script reads THIS file, never the working-tree CLAUDE.md, so it can be
  re-run after a failed attempt without a second split eating the headlines.

- [ ] **Step 3: Write `<scratchpad>/split-claude-md.mjs` with exactly this behaviour** (Node ESM, `node:fs` and `node:path` only, invoked as
  `node split-claude-md.mjs --source <CLAUDE.original.md> --repo <worktree root>`):
  1. Split the source at the line equal to `## Invariants`; the head is written back unchanged.
  2. Walk the tail line by line grouping bullets exactly as `splitBullets` does (column-0 `- ` starts; two-or-more-space continuations; a blank, heading or next
     start ends one). Every line that is not part of a bullet passes through verbatim, in place.
  3. Per bullet: join and take the first bold span. Not bold-led, or bold-led with no `invariants.md#` anchor → pass the original lines through verbatim.
     Two or more anchors → refuse: exit `1`, message `bullet cites two anchors: <headline>`. Bold span never closes → refuse: `unterminated headline at line
     <n>`. Anchor not in the homes table → refuse: `no home for anchor <anchor> (headline: <headline>)`. The script refuses BEFORE writing anything, so a
     refusal leaves the tree byte-identical.
  4. Dedupe: key `${anchor}\t${headline}`. A second bullet with a seen key is a candidate duplicate: every backtick span and every run of digits in its joined
     text must appear in the first bullet's joined text; if so, drop it and record `deduped: <headline> (kept <n1> words, dropped <n2>)`; otherwise refuse
     with `duplicate headline with unshared tokens: <headline>: <tokens>`. Expected: exactly one dedupe, the `exit 5` stack-up bullet, 110 kept / 71 dropped.
  5. Tier 1: emit `- **${headline}** Why: [invariants.md](docs/subsystems/invariants.md#${anchor})`; if that exceeds 160 characters, emit `- **${headline}**`
     and then `  Why: [invariants.md](docs/subsystems/invariants.md#${anchor})`; if the headline line alone exceeds 160, wrap it at the last space before
     column 160 with a two-space-indented continuation (expected to trigger for exactly one bullet, the resume-coupling headline).
  6. Tier 2: append the bullet's ORIGINAL raw lines, untouched, to the home file's list. Order within a file is encounter order — CLAUDE.md order — so
     `tests.md` reads: the rules-about-rules bullet, then the supertest bullet, then the fixture-date bullet.
  7. Write each of the nine rule files as: `---`, `paths: [<globs, double-quoted, comma-space separated>]`, `---`, blank,
     `# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md`, blank, the bullets
     each followed by a newline. A file with zero bullets is a refusal (`empty rule file: <name>`) — every entry in the paths table must receive at least one.
  8. Write `CLAUDE.md` = head + new tail.
  9. Survival check over the ORIGINAL tail versus the new CLAUDE.md plus all nine rule files: every backtick span, every run of digits, and every
     `bug-|task-|idea-|ref-` id present in the old tail must be present in the union. Print each missing token with the headline it came from; exit `1` if any.
  10. Print a summary: bullets seen, linked, unlinked, plain, deduped; per-file bullet counts; anchors; `CLAUDE.md` bytes before → after. Expected:
      linked 66, unlinked 12, plain 2, deduped 1, anchors 62, files `orchestrator 17 · dispatch-watchdog 13 · board 11 · items 5 · tracker 3 · skills 9 ·
      security 2 · scripts 2 · tests 3` (= 65), bytes 71,333 → somewhere in 24,000–27,000.

- [ ] **Step 4: Dry-run against a two-bullet fixture** (a temp file with a `## Invariants` heading, one linked bullet homed in the table, one unlinked) to check
  the emitted tier-1 line, the frontmatter shape and the header line by eye before touching the real file. Delete the fixture output.

- [ ] **Step 5: Run the script against the real source.** Expected: exit `0`, the summary above, and the one recorded dedupe. On any refusal, fix the homes
  table in the script (never the source) and re-run — the source copy makes this idempotent.

- [ ] **Step 6: Run the two guard files; expected: ALL cases PASS, including the two red since Task 1 and the one red since Task 2.**
  Run: `pnpm exec jest --runInBand test/claude-rules.test.ts test/dialog-count-docs.test.ts`

- [ ] **Step 7: Run the skill runner; expected: PASS** — `backlog.test.mjs`'s `CLAUDE.md carries the import invariant bullet` still finds exactly one bullet,
  because the headline carries both needles.
  Run: `pnpm run test:skills`

- [ ] **Step 8: Eyeball two rule files** (`tests.md` — the shortest with three distinct sources — and `orchestrator.md` — the longest) for: frontmatter on
  lines 1–3, the header on line 5, every bullet starting `- **`, continuation lines still indented two spaces, the `Why:` links intact.

- [ ] **Step 9: Commit** — `docs(claude): split every Why-linked invariant into headline (CLAUDE.md) and mechanism (.claude/rules)` with the summary numbers
  in the body.

---

### Task 4: Hand edits — the prose that described or consumed the pointer design

**Files:**
- Modify: `CLAUDE.md:48` (the DESIGN.md aside), `CLAUDE.md:58` (the Layout line), the two-sentence intro under `## Invariants`, the rules-about-rules
  headline
- Modify: `.claude/rules/tests.md` (the rules-about-rules bullet's headline and mechanism)
- Modify: `docs/subsystems/invariants.md`, section `## Path-scoped .claude/rules reach a headless run in a linked worktree (task-35)` (around line 2255–2290)
- Modify: `docs/overview.md:15`, `:24–26`, `:93` (the `### Where the rules live` paragraph)
- Modify: `agents/backlog-reviewer.md:109–110`, `skills/backlog-execute/SKILL.md:188`, `skills/backlog-orchestrate/SKILL.md:428`

**Interfaces:**
- Consumes: the tier-1 CLAUDE.md and `tests.md` from Task 3. Guard 2 (Task 1) enforces that the headline edit below lands in BOTH files byte-equal.
- Produces: the final prose; nothing later reads it programmatically beyond the guards already in place.

- [ ] **Step 1: The rules-about-rules bullet, both tiers.** New headline, exact, in `CLAUDE.md` and in `tests.md`:
  `` Every `.claude/rules/` file carries `paths:` and is the one home of its rules' mechanism — never the reasoning. ``
  In `tests.md`, rewrite the mechanism after the headline to state, in this order: `paths:` is mandatory because a rule with none loads at `session_start` in
  every session; each Why-linked CLAUDE.md rule has exactly one rule-file home and its headline is byte-equal across the two tiers, pinned by
  `test/claude-rules.test.ts`; a glob fires for a headless `claude -p`, inside a linked worktree and for a subagent's `Read`, and does NOT fire for `Write`,
  `Grep`/`Glob` or `codegraph_explore` (Claude Code 2.1.268, measured 2026-09-13) — the headline in CLAUDE.md is what covers that gap, and the reviewer reads
  the matching rule files by hand; `backlog-execute`'s contract sweep visits `.claude/rules/*.md` because tier 2 states contract. Keep the existing `Why:` link.
  Run guard 2 after this step; expected PASS (if it names `path-scoped-clauderules…`, one side of the headline was missed).

- [ ] **Step 2: CLAUDE.md's three descriptive sites.**
  - Line 58, the `.claude/rules/` Layout line: nine path-scoped files, each the ONE home of the mechanism for the rules scoped to its `paths:`, loaded the
    moment a session reads a file under them; CLAUDE.md keeps each rule's headline, `invariants.md` its reasoning; guarded by `test/claude-rules.test.ts`.
  - Line 48, the DESIGN.md aside: "Not a `.claude/rules/` file — those hold mechanism for a path scope, and every bullet in one is anchored into
    `invariants.md`."
  - The intro under `## Invariants`: each entry is a rule's headline; the mechanism lives in the `.claude/rules/*.md` file scoped to the files it governs,
    which loads when a session reads one of them and must be opened by hand when editing through any other route (`Write`, `codegraph_explore`); the `Why:`
    link is the reasoning. Read both before changing any of these — most encode a failure that already happened.

- [ ] **Step 3: `docs/subsystems/invariants.md`, the one section.** Heading unchanged. Edit: the opening paragraph's "is a **pointer** — one line per anchor
  into this file, never a second copy of the reasoning" → the one-home statement (tier 2 holds mechanism; this file the reasoning; CLAUDE.md the headline).
  Replace "**Why pointers only.**" with "**Why one home for the mechanism.**": three STATEMENTS of one rule was the drift the pointers avoided; three TIERS is
  not that — each tier says something the other two do not, the guards pin headline equality and one-home-per-anchor, and the contract sweep now visits
  `.claude/rules/` because tier 2 states contract. In P5's paragraph, "which is why no rule is moved out of it" → "which is why every rule's HEADLINE stays in
  it". Add `### The 2026-09-22 split` after the matrix: before — 540 lines, 71,333 bytes, ~28k tokens per session read off the desktop app's context panel,
  430 lines the Invariants section, 8,187 of its 8,456 words under a `Why:` link, after `fb00e7e`'s statement-plus-link pass; after — the line and byte counts
  from Step 6 below and the token estimate at the same ~2.55 bytes/token ratio, to be confirmed from the panel in a fresh session; the two plain Conventions
  bullets left in place and why.

- [ ] **Step 4: `docs/overview.md`, three sites.** Line 15: "one line per rule" → "one headline per rule; the mechanism is in `.claude/rules/`, the reasoning
  in `subsystems/invariants.md`". Lines 24–26: "six path-scoped pointer files" → nine path-scoped files holding the mechanism for their scope, loaded on a
  read of a matching file; their mechanical checks are `test/claude-rules.test.ts`'s. The `### Where the rules live` paragraph: state the three tiers in one
  sentence; keep the "if the two ever disagree, the code and its tests decide" sentence.

- [ ] **Step 5: The three consumers, one phrase each.**
  - `agents/backlog-reviewer.md` check 2: after "work through its **Invariants** section against the diff", add "— and, for each file the diff touches, read
    the `.claude/rules/*.md` whose `paths:` covers it: that is where each headline's mechanism is, and a rule file loads on a `Read` while you are reading a
    diff, so open them yourself"; keep the sentence about following into `invariants.md`.
  - `skills/backlog-execute/SKILL.md:188`: the site list becomes `` `CLAUDE.md`, `.claude/rules/*.md`, `docs/`, `README*`, … `` — one insertion, nothing
    else on the line changes.
  - `skills/backlog-orchestrate/SKILL.md:428`: "the repo's `CLAUDE.md`" → "the repo's `CLAUDE.md`, the `.claude/rules/` files scoped to the files in play".

- [ ] **Step 6: Measure and record.** `wc -lc CLAUDE.md` and `wc -lc .claude/rules/*.md`; write the CLAUDE.md line and byte counts and the derived token
  estimate into the `### The 2026-09-22 split` subsection from Step 3. Expected: CLAUDE.md 24,000–27,000 bytes.

- [ ] **Step 7: Run everything; expected: `pnpm test` green (both runners), `pnpm run typecheck` clean.** The `backlog.test.mjs` prose cases on
  `backlog-execute/SKILL.md` and `backlog-reviewer.md` pin needles this task did not touch (`Contract sweep`, `the sweep itself`, `Red proof`, the Important
  finding) — if one fails, the edit landed on the wrong line.

- [ ] **Step 8: Commit** — `docs: describe the three tiers where the pointer design was described, and point the consumers at tier 2`.

---

### Task 5: docs-sync, final verification, hand-off

**Files:**
- Possibly modify: the `<!-- docs-sync:` stamps in `docs/overview.md` (line ~96) and `docs/subsystems/invariants.md` (line ~2974), and whichever stamp
  `CLAUDE.md` carries as `kind: index` — through the skill only, never by hand.

- [ ] **Step 1: docs-sync after.** Invoke the `docs-sync` skill for status; save to `<scratchpad>/docs-sync-after.txt`; diff against `docs-sync-before.txt`.
  Expected: identical, OR the three edited docs (`CLAUDE.md`, `docs/overview.md`, `docs/subsystems/invariants.md`) reported as edited without a source
  change. In the second case re-baseline exactly those three through the skill's own flow and commit the result as `docs(sync): re-baseline the three docs the
  three-tier split edited`. Any OTHER doc appearing in the diff is a finding to investigate, not to re-baseline.

- [ ] **Step 2: Full run.** `pnpm test` and `pnpm run typecheck`; expected green and clean. `git status --short` in the worktree; expected: nothing
  uncommitted, nothing untracked (the script and its logs are in the scratchpad, not the tree).

- [ ] **Step 3: Read the diff once, whole.** `git diff main...HEAD --stat` and then the CLAUDE.md diff alone: every removed line from `## Invariants` onward
  should reappear verbatim in a rule file (the survival check proved the tokens; this is the eyeball on the lines). Spot-check two anchors by opening their
  rule-file bullets.

- [ ] **Step 4: Hand off.** Report to the user: the before/after bytes, the guard output, the docs-sync verdict, and the request to open a fresh session and
  read the context panel's "Memory files" line so the token figure in `invariants.md` can be confirmed or corrected. Then offer, through AskUserQuestion, the
  `superpowers:finishing-a-development-branch` choices — merge into `main` (`--no-ff`, the repo's convention), open a PR, or leave the branch. Do not merge
  without the answer.

---

## Self-review

**Spec coverage.** Tier shapes → Task 3 steps 5–7 and Global Constraints. Homes table and new files → Task 3 step 3 (tables) and step 10's expected counts.
Dedupe → Task 3 step 3.4. Guards 1–3 with their cases → Task 1 steps 1 and 5. `dialog-count-docs` → Task 2. `backlog.test.mjs` unchanged, verified → Task 3
step 7. Migration's own checks (refusals, survival) → Task 3 steps 3.3, 3.9. Every consumer in the spec's list → Task 4 steps 1–5. docs-sync → Task 3 step 1
and Task 5 step 1. Measurement → Task 4 step 6, Task 5 step 4. "Left in place" → recorded in Task 4 step 3's subsection. Non-goals are constraints, not
tasks. No gap found.

**Placeholder scan.** No TBD/TODO; every step names its file, its expected output and its exact case values. The one open number — post-split bytes — is
given as a range with the step that measures it.

**Type consistency.** `TierBullet`, `joinWrapped`, `splitBullets`, `headlineOf`, `anchorsOf`, `wordCount`, `tierOne`, `tierTwo`, `freeProse`,
`compareTiers` are named identically in Task 1's interface block, its cases and Task 1 step 5's guards; `mechanismBullet` is used only in Task 2. The homes
table's file names in Task 3 match the nine files in Task 4 and the spec.
