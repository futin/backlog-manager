# Final review — CLAUDE.md floor (0687dd2c..28d92da6)

Reviewed read-only in the worktree. Ran `pnpm run test:jest -- claude-rules dialog-count-docs` (28 passed) and `node --test scripts/ci-scope.test.mjs`
(15 passed). Walked the audit record row by row for the rules that left CLAUDE.md, the five Review Focus failure modes, the helper parsers, and the reworded
contract text in `.claude/rules/tests.md`, `docs/subsystems/invariants.md`, `docs/overview.md` and the rule-file headers.

## Verdict: Ready to merge — With fixes (all Minor; one Important docs-accuracy line)

## Strengths

- The five Review Focus modes are each really guarded: (2) `compareTiers sees a headline that drifted by one character` keys on `${anchor}\t${headline}` and
  the fixture uses `'Rule A.'` vs `'Rule A'`; (3) `compareTiers sees an unlinked headline homed in two rule files` keys an anchorless bullet by headline;
  (4) `compareTable` is fixtured in both directions plus an ordered-globs mismatch, and the real-tree case calls the same function; (1) and (5) are
  recorded in the audit (`## Survival check`, 1,146 tokens, three misses all explained as link-only). Review-1's three Important plan gaps (I1–I3) were all
  applied: the old `missingInClaude` case is rewritten, `one` is `tierOne(CLAUDE_MD).linked` only, and the table guard has a pure `compareTable`.
- `pathTableOf` reads only the `## Rule files` section (anchored on `\n## Rule files\n`, ends at the next `\n## `) and only rows whose first cell is a
  bare backticked `*.md`, so the header row and the Commands table fall out — fixture `pathTableOf reads the Rule files table and nothing outside it` has a
  decoy `` `z.md` `` row above and a `` `b.md` `` row below. Matches the real table (the first cell is a bare name, per the Task 3 ruling).
- `ruleBulletOffenders` is a pure function fixtured on 80 / 81 words and a two-anchor bullet; the real-tree case runs the same function. The old
  `:323` inline check could not have been fixtured.
- Anti-goal spot checks of fenced rows hold: `--main-gap` appears only in `client/src/styles.css`, `client/src/App.tsx` and `test/design-guards.test.ts`
  (board.md / tests.md); `stale-plans`/`planStale`/`plan-stale` do not occur outside `skills/backlog-orchestrate/`; `BM_RETRO_HOME` outside
  `skills/backlog-retro/` is only `skills/backlog-tick/tools/tick-lib.mjs` (under skills.md, which homes #5); `isItemId` is defined at `shared/agent.ts:782`
  (now in dispatch-watchdog.md's fence). The widen rulings (#65 to skills.md rather than scripts.md, L3 as a new `security.md` bullet) are the right
  calls for the reasons the record gives.
- The `## Rule files` section of CLAUDE.md states the route gap explicitly (`codegraph_explore`, `Write`, `Grep`, `Glob`, a subagent's brief) and tells the
  session to open the rule file first; `agents/backlog-reviewer.md:129-131` already opens the rule files covering each diffed file, and
  `backlog-execute`'s contract sweep (SKILL.md:308) visits `.claude/rules/*.md`. So a rule that left CLAUDE.md is reachable on every route by name.
- `scripts/ci-scope.test.mjs` follows the real read set: `dialog-count-docs.test.ts` no longer reads CLAUDE.md, so the expectation was dropped rather
  than kept stale.
- All relative links in `docs/overview.md` resolve from `docs/` (checked every `](path)` against the filesystem; zero missing), and the
  `#every-seam-in-detail` anchor exists at `docs/overview.md:148`.

## Issues

### Critical

None.

### Important

- `.claude/rules/tests.md:8` — "Every rule has exactly one rule-file home, and CLAUDE.md keeps a headline only for a rule that matters whichever file is
  touched — byte-equal with its rule-file copy". The first clause is false for the ten unlinked bullets that stay in CLAUDE.md alone (`skills/` is the plugin
  skill root; Item files are read-only…; Every server route lives under `/api`; Groomed is derived; The served build carries a CSP; pnpm only; Backlog items
  move…; the outbound-calling modules; Start orchestrator runs from the board; A PR title must pass): none has a rule-file bullet (grep over
  `.claude/rules/*.md` returns nothing for any of them), and the guard does not require one — `compareTiers` is fed `tierOne(CLAUDE_MD).linked` only
  (`test/claude-rules.test.ts:411`), as spec:140 and review-1 I2 intended. Why it matters: this bullet is the mechanism-tier statement of the contract,
  loaded on every `test/**` and `.claude/rules/**` read; a session that believes it will go looking for `pnpm only` in scripts.md, or add a rule-file copy
  of an unlinked bullet and then wonder why the subset guard did not check it. Fix: "Every LINKED rule has exactly one rule-file home; an unlinked CLAUDE.md
  bullet is governed by the 80-word cap alone and may have no rule-file copy" — one clause, same bullet.

### Minor

- `docs/subsystems/invariants.md:3104` — "a rule file is bullets and nothing else, each anchored into this file exactly once" is the old contract; the
  paragraph at :3214-3216 (same section) correctly says "at most one anchor, an unanchored one at most 80 words". Change "exactly once" → "at most once".
- `docs/subsystems/invariants.md:3210` — "Six guards run over the real tree." The real-tree `describe('.claude/rules')` now has eight (paths non-empty,
  anchors resolve, globs match, bullets-only, subset/one-home, table, budget, tier-one shape). Say "the guards below" or update the count.
- `docs/subsystems/invariants.md:3214` and `test/claude-rules.test.ts:166-167` — "the three shapes the files use (`dir/**`, `dir/*.ts`, a literal path)"
  is no longer the whole grammar: the widened fences add a mid-filename star (`server/src/orchestrator/watchdog-*.ts`, `server/src/agents/agents.*.ts`,
  `server/src/agents/items-abort.*.ts`, `docker-compose*.yml`). The hand-rolled matcher handles it (`*` → `[^/]*`), but the 2.1.268 measurement that a
  glob "fires for a headless `claude -p`…" covered only the three shapes. Parked with autopilot (#2): measure once by reading
  `watchdog-state.service.ts` in a fresh session and checking dispatch-watchdog.md was injected; if not, list the files literally. Until then the doc
  sentence should say "four shapes".
- `docs/overview.md:150-153` — the moved preamble was carried verbatim: "the reasoning behind the rules in the next section lives in invariants.md" (the
  next section of overview.md is not CLAUDE.md's Invariants) and "The doc map is [docs/overview.md](overview.md)" links the file to itself. Drop the two
  sentences or reword them for their new home.
- `test/jira-board.test.tsx:485-487` and `test/run-on.test.tsx:12-14` — the pointer rewrite (CLAUDE.md → `.claude/rules/*.md`) rewrapped each comment
  by breaking a line mid-sentence ("drawn\n// through the\n// real", "relative\n * to the clock\n * the assertion"). Rejoin to one wrapped line.
- `test/helpers/rule-tiers.ts:152-160` (`compareTiers` one-home key) — a linked bullet is homed by its anchor and an unlinked one by its headline, so the
  same headline written once WITH a `Why:` link in file x and once WITHOUT in file y is two different homes and passes. Low likelihood (the subset guard
  would still catch the linked copy drifting), but the plan's "one home per headline" reads as if headline were always the key. Either key the home on
  `${anchor}` AND report a headline seen under two different anchors/none, or note the gap in the doc comment.
- `test/claude-rules.test.ts:96-100` — `CLAUDE_MD_BUDGET = 19 * 1024` leaves 1,064 B of headroom over today's 18,392 B: roughly four more kept headlines.
  That is the intent of the ruling (the next rule goes down a tier), but the error message says "move a rule down a tier" while the Task 2 ruling also
  says "24 audit keeps accepted unverified" — a second pass over those keeps is the cheaper lever and worth naming in the comment, so the first person to hit
  the budget does not reach for a new rule's demotion before the unverified keeps.
- Fence cost shift, for the record rather than a fix: `shared/agent.ts` now injects board.md + dispatch-watchdog.md + orchestrator.md (~72 KB) on one
  Read, where it used to inject the latter two (~49 KB) — about what the CLAUDE.md cut saves, on that one file. `docker-compose.yml` goes from security.md
  alone (~3 KB) to security + jira + dispatch-watchdog + scripts (~39 KB). Both are correct per criterion (b); the audit record could state the per-read
  cost so the next fence widening weighs it.

## Declined to judge

- Whether 38+2 kept rules (vs the spec's ~14) is the right floor — the executor's ruling, logged and parked for the user; keep is the error-safe
  direction and the budget comment records why.
- Whether Claude Code's loader fires on a mid-filename `*` glob — outside the spec, unmeasurable read-only here; parked (see Minor).
- Whether an unlinked CLAUDE.md bullet should ALSO require a rule-file home — the spec (:140) says only linked ones do; judged the docs against the spec.
- The pre-existing "ten guarded write routes" (overview.md, moved verbatim) vs "the eleven `/api/items/*` write routes" (CLAUDE.md) wording — ten plus
  `abort`; not introduced by this change.
- Stale comments about rules that never moved (StartingStrip, compose-env history) left alone per the Task 4 ruling — out of scope.
- The `docs-sync:` `verified:` stamp on CLAUDE.md was not advanced — this change touches no source the stamp tracks.
- Whether the reviewer agent and the execute sweep should be told the subset contract by name — both already open the rule files per diffed file, which is
  what the change relies on; no text there states the old same-set contract.

## Assessment

Ready to merge? **With fixes** — none blocking. The guard contract, its fixtures and the real-tree cases match the plan and the spec; the fence audit's
fenced rows survive spot checks and the widen rulings are sound; links in the moved text resolve. The one Important item is a single stale clause in the
mechanism-tier bullet that describes this very guard, which a session reading `test/**` will take as the contract. The rest is wording left over from the
same-set era and two rewrapped comments.
