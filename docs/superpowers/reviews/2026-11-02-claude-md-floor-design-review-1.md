# Review 1 — `docs/superpowers/specs/2026-11-02-claude-md-floor-design.md`

Date: 2026-11-02. Reviewer: fresh subagent (Fable), checklist review, no edits made. Every number below was re-measured against the worktree at `0687dd2c`.

## Verdict: REVISE

One Critical (the trimmed `## Layout` sends normative rules to a doc no session loads, which is the spec's own anti-goal), seven Important, seven Minor.

## What checked out

- Sizes: `CLAUDE.md` 37,952 B; 108 bold-led bullets (104 in `## Invariants`, 4 in `## Conventions`); `## Invariants` 24,197 B; the `Why:` links 11,428 B;
  `## Layout` 8,442 B; `## Commands` 3,042 B; `~/.claude/CLAUDE.md` 7,448 B. The history table matches commits 298706ed, 54cb75f3, 959e1c1d, 35becf95.
  The 2026-09-22 split was 71,333 → 24,698 B (4684e522 → cdf2c9ab).
- Bullet numbers (#1, 2, 13, 15, 18, 20, 25, 26, 42, 46, 47, 51, 60, 64, 74–76, 78–80, 101) all land on the bullets the spec names; the 12 unlinked
  bullets are exactly the seven kept plus the five re-homed.
- Rule-file homes: #2 `skills.md`, #20 `tracker.md`, #46 `items.md`, #47 `security.md`, #51 `orchestrator.md`, #13 and #15 `board.md`. Fences as stated
  (`.claude/rules/*.md:2`). `server/src/registry/` and `client/index.html` are fenced by nothing.
- `#25`: no `setGlobalPrefix`; 17 `@Controller(...)` files, every prefix starts with `api`.
- `#46`: `runGit` is imported in `agents/`, `items/`, `jira/`, `releases/`, `tracker/` — "every server module can run git" holds.
- `test/claude-rules.test.ts:340` is the same-set assertion; `:44` the 80-word cap; `:287/:310` the `paths:` guards; `:323` "anchored exactly once".
  `test/helpers/rule-tiers.ts:96-100` reads `## Invariants` to EOF and throws without it. `agents/backlog-reviewer.md:129` names the section.
  `tests.md:16,22,30` hold the three Conventions bullets. `test/dialog-count-docs.test.ts:76` is `CLAUDE.md keeps the headline`.
- `~/.claude/skills/preload-audit/references/three-tier.md` exists (5,257 B).

## Critical

- **[C] spec:106-108 — `## Layout` carries normative rules, and the spec sends its "per-module detail" to `docs/overview.md`, which no session loads.**
  The sentences at `CLAUDE.md:45` ("the ONLY writes this server makes to anybody's items"), `:55` ("the outbound-calling modules, and the ONLY three"),
  `:62` ("`runGit`, the one way this server runs git"), `:71` ("Every derivation has one home in `lib/`, and every look more than one surface draws has
  one home in `components/ui/`"), `:79` ("every component must cite its subsection in a header comment"), `:84-85` (the registry's and the run file's
  only writer), `:91` ("**Start orchestrator runs from the board, not by typing the trigger into a terminal.**") and `:97` (the rule-file contract)
  are rules, not layout. `test/runs-view.test.tsx:2653,2679` already cite "CLAUDE.md's `lib/` rule". Moving them "without loss" into `docs/overview.md`
  is the anti-goal at spec:47 — a rule with no loaded tier. → Route each embedded rule through the cross-cutting criterion like an Invariants bullet:
  `board.md` for `lib/`, `components/ui/` and the DESIGN.md header citation; `items.md`/`security.md` for the only-writes and only-three-outbound rules;
  `skills.md` (or the keep-list) for start-from-the-board; only descriptive detail goes to `overview.md`. Extend the token-survival check at spec:167-168
  to the old `## Layout`, not only `## Invariants`.

## Important

- **[I] spec:112-113 vs spec:93 — the Conventions test-location bullet is exempted from the fence audit, and it fails criterion (b).** "Tests are flat
  in `test/` under jest and beside the tool they cover under node; the node globs do not descend" (`CLAUDE.md:308+`) governs files under
  `skills/*/tools/` and `scripts/` (`scripts/test-all.mjs:33`, the glob pair `skills/*/tools/*.test.mjs scripts/*.test.mjs`). `tests.md:2` fences
  `test/**` and `.claude/rules/**` only, so a session adding `skills/x/tools/lib/foo.test.mjs` never loads it. → Run the three Conventions bullets through
  the fence audit like every other leaving rule; this one keeps, or `tests.md` gains `skills/*/tools/*.test.mjs` and `scripts/*.test.mjs`.
- **[I] spec:86 — #75 (container mounts) is homed in `security.md`, whose fence misses the code that reads it.** `BM_REPO_ROOTS` is read in
  `server/src/jira/env.util.ts` (fenced by `jira.md:2` only) and set in `docker-compose.yml` (`security.md`). The new home fails the spec's own
  criterion (b) on day one. → Say the fence audit covers the four new homes too, and pick: `jira.md`, or `security.md` plus a
  `server/src/jira/env.util.ts` glob.
- **[I] spec:142-152 — "Other surfaces" lists only the header line; the surfaces that STATE the same-set contract are missing.** `.claude/rules/tests.md:8-12`
  (bullet #104's mechanism: "one multiset with one home per anchor", "the headline in CLAUDE.md is what covers that gap" — both false after the split),
  `docs/subsystems/invariants.md:3093,3103-3105,3215-3216,3223`, `docs/overview.md:16,30-32` ("one headline per rule", "a headline that no longer matches
  CLAUDE.md's"), `test/helpers/rule-tiers.ts:4-9,124`, `test/claude-rules.test.ts:12-17`. `tests.md` is itself guarded (bullets only, anchored once,
  ≤ 80 words unlinked), so its reword is not free. → List them in "Other surfaces" with the new wording for #104.
- **[I] spec:157-159 — option 2 (an unlinked rule-file bullet) leaves "exactly one rule file" (spec:34, 167) unguarded.** One-home-per-rule is enforced
  only through anchors (`test/helpers/rule-tiers.ts:124`, `test/claude-rules.test.ts:323-346`); an anchorless bullet can be homed twice or nowhere and
  nothing goes red. → If option 2 stays on the table, require the guard to key uniqueness on the joined headline for anchorless bullets; otherwise mandate
  option 1.
- **[I] spec:119-120 — "edited by a subagent that inherits none of the parent's context" overstates the gap.** `tests.md:11-12` measured (Claude Code
  2.1.268) that a glob DOES fire for a custom subagent's `Read`; it does not fire for `Write`, `Grep`/`Glob` or `codegraph_explore`. A subagent that reads
  before editing is covered. → State the gap by tool route, not by who holds the tool.
- **[I] spec:93, 157 — "four" homeless bullets; there are five.** The table at spec:84-89 holds #75, #79, #26, #78, #101 (the first row is two bullets),
  so "~84 with an existing home" is 85. → Fix both counts.
- **[I] spec:144 — the list of test comments citing `CLAUDE.md` is incomplete.** Also `test/agents-origin-guard.test.ts:142`,
  `test/dispatch-button.test.tsx:178`, `test/tracker-board.test.tsx:200,469`, `test/jira-board.test.tsx:485`, `test/run-detail.test.tsx:921`,
  `test/run-on.test.tsx:13`, `test/helpers/offers.ts:6`, `test/runs-view.test.tsx:2215,2653,2679`. → Say "every hit of `grep -ln CLAUDE.md test/`" and
  let the builder enumerate at build time.

## Minor

- spec:68, 160 — #18 is 479 B as written (continuation indentation counted); state the counting rule or drop the number.
- spec:72 — `security.md:2` fences `server/src/*.ts`, `vite.config.ts` and `docker-compose.yml`, not "top-level `server/src/*.ts` only".
- spec:96 — a third fix for a fence failure exists and is cheaper for the example given: move the bullet to a rule file that already fences the governed
  paths (`dispatch-watchdog.md:2` fences `server/src/agents/**` and `shared/agent.ts`). Widening `board.md` (23,370 B) loads it into every `agents/` session.
- spec:134, 162 — "soft budget" and "test's failure message" pull apart: a jest assertion is hard. Say "a failing assertion whose number may be raised
  deliberately, never met by compressing".
- spec:109-111 — where the path → rule-file table sits relative to `## Invariants` is unsaid; `tierOne` (`rule-tiers.ts:96-100`) parses everything after
  that heading, so a bulleted "read before editing" line placed after it is a plain bullet under the cap. Fine either way; say which.
- spec:14-19 — the 10-15 and 10-21 rows are mid-day commits (54cb75f3, 959e1c1d), not end-of-day (27,065 B / 86 and 32,553 B / 98). Harmless.
- spec:169 — far more suites than `claude-rules` and `dialog-count-docs` read `CLAUDE.md` (`scripts/ci-scope.mjs:66` selects them on a docs PR); say "the
  scoped run `ci-scope` picks" rather than naming two.
