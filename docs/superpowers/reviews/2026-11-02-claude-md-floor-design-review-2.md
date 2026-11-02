# Review 2 — `docs/superpowers/specs/2026-11-02-claude-md-floor-design.md`

Date: 2026-11-02. Reviewer: fresh subagent (Fable), checklist review, no edits made. Measured against the worktree at `a196a316` (that commit touched only
the spec and review 1; `CLAUDE.md`, `.claude/rules/` and the tests are byte-identical to what review 1 measured at `0687dd2c`).

## Verdict: APPROVE WITH FIXES

Round 1's Critical and all seven Important findings are resolved. One new Important (the spec's own byte arithmetic contradicts its ~9 KB target and leaves
the suggested 12 KB budget almost no headroom), eight Minor — four of them round-1 Minors still open.

## Round-1 findings — status

| Round 1 | Status | Where |
| --- | --- | --- |
| [C] `## Layout` rules sent to `docs/overview.md` | Resolved | spec:107-114 routes each embedded rule through the criterion; spec:93 adds Layout to the fence audit; spec:181 extends token-survival to `## Layout` and `## Conventions` |
| [I] Conventions test-location bullet exempt from the fence audit | Resolved | spec:118-121 names `scripts/test-all.mjs:33` and the two globs; widen or keep |
| [I] #75 homed in `security.md`, `env.util.ts` fenced by `jira.md` only | Resolved | spec:86 states it; spec:93 puts the five new homes through the audit |
| [I] "Other surfaces" missing the same-set statements | Resolved | spec:156-158 lists `tests.md:8-12`, `invariants.md`, `overview.md`, `rule-tiers.ts`, `claude-rules.test.ts` — every line re-checked below |
| [I] option 2 leaves one-home unguarded | Resolved | spec:144-145 adds one-home-per-headline |
| [I] subagent gap overstated | Resolved | spec:127-128 states it by tool route; `tests.md:11-12` does say headless `claude -p` and a custom subagent's read fire |
| [I] four vs five homeless | Resolved | spec:93 "85 … five"; 104 − 14 = 90 = 85 + 5 |
| [I] incomplete test-comment list | Resolved | spec:154 defers to the grep (but see Minor on the count and the command) |
| Minor: #18 counting rule | Open | spec:68, 173 still say 479 B with no rule (479 is with continuation indentation; 71 words) |
| Minor: `security.md` fence | Open | spec:72 still says "top-level `server/src/*.ts` only"; `security.md:2` is `server/src/*.ts`, `vite.config.ts`, `docker-compose.yml` |
| Minor: cheaper fix for the #13 example | Open | spec:97-98 |
| Minor: soft vs hard budget | Resolved | spec:142-143 |
| Minor: table placement vs `tierOne` | Open | spec:115-117 |
| Minor: mid-day commits | Harmless, unchanged | spec:17-18 |
| Minor: only two suites named at done | Open | spec:183 |

## What checked out this round

- Sizes and ratios: `CLAUDE.md` 37,952 B; `~/.claude/CLAUDE.md` 7,448 B (5.1×); 37,952 / 3.0 = 12,650 tokens; `## Invariants` 24,197 B (63.8%); `Why:` links
  11,428 B (30.1%); `## Layout` 8,442 B; `## Commands` 3,042 B. `/preload-audit` uses a 3.0 bytes-per-token default (`~/.claude/skills/preload-audit/SKILL.md:42`).
- 108 bold-led bullets: 104 under `## Invariants`, 4 under `## Conventions`. 12 unlinked in Invariants = the seven kept (#1, 18, 25, 42, 74, 76, 80) plus the
  five re-homed (#26, 75, 78, 79, 101); the PR-title Conventions bullet is the thirteenth unlinked bullet and stays (spec:118).
- Keep-list homes: #2 and #64 `skills.md`; #20 `tracker.md`; #46 `items.md` (fence exactly as spec:71); #47 `security.md`; #51 `orchestrator.md`
  (`skills/backlog-orchestrate/**`, `server/src/orchestrator/**`, `shared/agent.ts` — execute and groom never load it); #60 `orchestrator.md`; #13 and #15
  `board.md`. `server/src/registry/` and `client/index.html` are fenced by nothing. No `setGlobalPrefix`; 17 `@Controller(` files.
- New homes' fences: `scripts.md:2` fences `pnpm-workspace.yaml` (#78); `security.md:2` fences `vite.config.ts` (#79) and `docker-compose.yml` (#75);
  `allow.util.ts` is under `server/src/items/` (#26); `clampSettings` lives in `client/src/` (#101). `BM_REPO_ROOTS` is read at `server/src/jira/env.util.ts:59-62`
  and set at `docker-compose.yml:128`, as spec:86 says. `backlog.mjs` mentions the claim 82 times (spec:69).
- Layout citations `CLAUDE.md:45, 55, 62, 71-72, 79, 84-85, 91, 97` all land on the quoted sentences; the preamble sentence spec:116 replaces is `CLAUDE.md:108`.
- `scripts/test-all.mjs:32-33` holds the glob pair; `tests.md:2` fences `test/**` and `.claude/rules/**`; `tests.md:16, 22, 30` are the three Conventions bullets.
- Guard sources: `claude-rules.test.ts:44` (`UNLINKED_WORD_CAP = 80`), `:287` (non-empty `paths:`), `:310` (every glob matches a tracked file), `:323-336`
  (bullets only, exactly one anchor), `:340-346` (same set, one home per anchor); `rule-tiers.ts:96-100` (`tierOne` throws without `## Invariants`),
  `:121-124` (`multiHomed` keyed on anchor); `:4-5` says every comparison is on the JOINED bullet, which is what spec:138 means.
- `dialog-count-docs.test.ts:76` is `CLAUDE.md keeps the headline`; `agents/backlog-reviewer.md:129` reads Invariants plus each touched file's rule file;
  `questions.md:12` and `backlog-execute/SKILL.md:308` name both tiers; every `.claude/rules/*.md:5` carries "the headline is in CLAUDE.md" verbatim.
- `invariants.md:3093, 3103-3105, 3215-3216, 3223`, `overview.md:16, 30-32`, `rule-tiers.ts:4-9`, `claude-rules.test.ts:12-17` all state the same-set contract.
- `~/.claude/skills/preload-audit/references/three-tier.md` exists.

## Critical

None.

## Important

- **[I] spec:32, 142, 179 — the ~9 KB target is below what the spec itself keeps, and the suggested 12 KB budget has about 1 KB of headroom.** Measured on
  today's file: intro 845 B + `## Commands` 3,042 B (spec:106 "unchanged") + the Invariants preamble 476 B + the fourteen keep-list bullets 3,197 B (with
  their `Why:` links) + `## Conventions` heading and PR-title bullet 428 B = 7,988 B before a single byte of the trimmed `## Layout` (nine seam lines plus the
  DESIGN.md pointer, ~1.5-2 KB at this file's line length) or the new path → rule-file table (eleven rows plus a rule, ~1 KB). The realistic floor is
  ~10.5-11.5 KB, and each fence-audit addition to the keep-list (spec:102) adds ~230 B. "Roughly 9 KB" at spec:179 is therefore unreachable without the
  compression spec:32 forbids, and a 12 KB hard assertion (spec:142) can go red on the first keep-list growth. → State the arithmetic in the spec, set the
  target to what the kept sections add up to (~11 KB) and the budget with real headroom over that (14-15 KB, still under the spec:49 anti-goal), or drop the
  target and keep only the budget.

## Minor

- spec:154 — "21 files today": `grep -rl CLAUDE.md test/` finds 19 (`test/helpers/` is inside `test/`, so listing it twice adds nothing). The command as
  written, `grep -ln CLAUDE.md test/ test/helpers/`, is non-recursive on stock grep and prints "Is a directory". → `grep -rl CLAUDE.md test/`, and drop the count
  or make it 19.
- spec:114 — `test/runs-view.test.tsx:2679` does not cite the `lib/` rule; it cites "the four CLAUDE.md names outright as single implementations" (the
  resume-coupling rule, #~70). Only `:2653` cites "CLAUDE.md's `lib/` rule". → Cite `:2653` alone, or say `:2679` follows a different rule.
- spec:72 (round-1 Minor, still open) — `security.md:2` fences `server/src/*.ts`, `vite.config.ts` and `docker-compose.yml`, not "top-level `server/src/*.ts`
  only". The conclusion (wider than its fence) still holds. → Fix the Note cell.
- spec:68, 173 (round-1 Minor, still open) — "479 B" is the bullet with its two-space continuation indentation; it is 71 words, so it passes today's cap
  either way. → Say "479 B as laid out in the file" or drop the number.
- spec:97-98 (round-1 Minor, still open) — the #13 example's cheaper fix is a move to `dispatch-watchdog.md`, which already fences `server/src/agents/**` and
  `shared/agent.ts`; widening `board.md` (23,370 B) loads it into every `agents/` session. The fence audit as written lets the builder pick, so this is only
  the example being the expensive one. → Name the move as the first option for a rule whose governed files are already fenced by another rule file.
- spec:140-141 — the table guard is stated one way ("names every file in `.claude/rules/`"); a rule file deleted while its row stays is unstated. → "the
  table's rows and the directory's files are the same set".
- spec:115-117 (round-1 Minor, still open) — where the table sits relative to `## Invariants` decides whether `tierOne` (`rule-tiers.ts:96-100`) sees the
  "read before editing" line: as a bullet after the heading it is a plain bullet under the 80-word cap; as a paragraph or a table row it is invisible to the
  parser. Either is fine; say which, since spec:138-139 describes the guard as covering "every unlinked `CLAUDE.md` bullet".
- spec:159-160 — the `CLAUDE.md` Invariants preamble (`CLAUDE.md:107-109`: "Each entry is a rule's HEADLINE. Its mechanism lives in the `.claude/rules/*.md`
  file scoped to the files it governs") is itself one of the "three tiers" statements, and after the split seven keep-list entries have no rule file at all.
  spec:116 replaces only its second sentence. → Add the preamble to the reword list.
- spec:183 (round-1 Minor, still open) — far more suites read `CLAUDE.md` (19 files; `scripts/ci-scope.mjs` picks them on a docs PR). "CI green on the PR" in
  the same line already covers it. → Say "the scoped run `ci-scope` picks" or leave as is.
- spec:109, when the builder moves `CLAUDE.md:45` ("the ten guarded write routes … with `abort` … the ONLY writes"): `items-write.controller.ts` has ten
  `@Post` routes (`:77-300`) and `abort` is the eleventh, which is what Invariants #18/#19 call "the eleven routes". The two phrasings agree only if the reader
  adds `abort`; not the spec's defect, but the move is the moment to say "ten plus `abort`, the eleven" once.
