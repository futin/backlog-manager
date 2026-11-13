# CLAUDE.md floor: cross-cutting rules only — design

Date: 2026-11-02. Status: draft, awaiting approval.

## Intent

Every session in this repo pays for `CLAUDE.md` on every turn, before the first prompt is typed. `/preload-audit` (uncalibrated, 3.0 B/tok) ranks it
the single largest item on the floor: 37,952 bytes, ~12.6k tokens, about five times the next one (`~/.claude/CLAUDE.md`, 7,448 bytes). The user's
concern is cost per turn — a brainstorm, a quick question and a full implementation session all pay the same ~12k.

The repo already did a three-tier split once (2026-09-22: 71 KB → 25 KB — headline in `CLAUDE.md`, mechanism in `.claude/rules/<subsystem>.md`,
reasoning in `docs/subsystems/invariants.md`). It has regrown to 38 KB in five weeks:

| Date       | Bytes  | Bold-led bullets |
| ---------- | -----: | ---------------: |
| 2026-09-23 | 23,962 | 79               |
| 2026-10-15 | 26,220 | 83               |
| 2026-10-21 | 32,578 | 98               |
| 2026-10-29 | 37,952 | 108              |

The cause is structural, not editorial: `test/guards/claude-rules.test.ts` requires the set of `CLAUDE.md` headlines to EQUAL the set of rule-file headlines,
so every new rule anywhere in the repo must add a line to the always-paid tier. Of today's file, `## Invariants` is 24,197 bytes (64%), and the
`Why: [invariants.md](...)` links alone are 11,428 bytes (30% of the whole file) — links the rule files already carry.

## The change, in one sentence

`CLAUDE.md` keeps only the rules that matter whichever file a session touches; every subsystem rule lives in its rule file alone, which already loads
the moment a session reads a file under its `paths:`.

## Goals

- Cut the `CLAUDE.md` floor to roughly 11 KB (soft target — never compress a load-bearing rule to hit a number). The arithmetic: intro 845 B +
  `## Commands` 3,042 B + Invariants preamble 476 B + the fourteen keep-list bullets ~3,200 B + Conventions heading and PR-title bullet 428 B ≈ 8.0 KB,
  plus a trimmed `## Layout` (~1.5-2 KB) and the path → rule-file table (~1 KB).
- Stop the regrowth mechanically: a new subsystem rule must not need a `CLAUDE.md` edit, and a guard must notice tier one creeping back up.
- Lose no rule. Every bullet that leaves `CLAUDE.md` lands, byte-equal headline intact, in exactly one rule file.
- Close the gap the headline list was quietly covering (see "The CodeGraph/Write gap").

## Non-goals

- Per-session-type `CLAUDE.md` (a brainstorm file, an implementation file). Claude Code has no native mode switch; the nearest build is an env var plus
  a `SessionStart` hook, which needs the user to pick a mode at every launch. Considered and set aside; may be revisited after this lands.
- Shrinking the global `~/.claude/CLAUDE.md`, plugin skill descriptions, or hook-injected text. Separate levers, separate decisions.
- Rewriting rule mechanism or reasoning. Text moves between tiers; its wording does not change except where a move forces it.
- Calibrating `/preload-audit`. Nice to have for the before/after numbers, not part of this work.

## Anti-goals (would make this a failure even if the bytes drop)

- A rule that a session could break without ANY tier of it being in context. That is exactly what the cross-cutting criterion below exists to prevent.
- A guard test weakened to "anything goes" in tier one. The new contract must be at least as strict as the old one, just about a different set.
- `CLAUDE.md` back above ~15 KB within a month because nothing measured it.

## The cross-cutting criterion

A rule stays in `CLAUDE.md` when at least one holds:

- **(a) Process** — it is about what a session does, not which file it edits (undoing a merge, publishing a skill edit, the package manager).
- **(b) Wider than its fence** — the code it governs reaches beyond its rule file's `paths:` globs, so a session could violate it without the rule
  file ever loading.
- **(c) Shared vocabulary** — skills, server and client all speak in it.

## What stays in `CLAUDE.md` (decided with the user)

Fourteen rules, numbered by their position in today's `## Invariants` list:

| #  | Rule (headline, abbreviated)                                       | Criterion | Note                                                                       |
| -- | ------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------- |
| 1  | `skills/` is the plugin skill root                                 | c         | no rule-file home today                                                    |
| 2  | `registry.json` has exactly one writer                             | b         | home `skills.md`; `server/src/registry/` is fenced by no rule file          |
| 18 | Item files are read-only to the server and client (+ tracker exception) | c    | no home; long (479 B) — see "Left to the builder"                          |
| 20 | Claim protocol: one comment per session per issue, lowest id wins | b         | home `tracker.md`; `backlog.mjs` under `skills/` speaks it too             |
| 42 | Groomed is derived, never stored                                   | c         | no home                                                                    |
| 46 | The server never spawns git synchronously (`runGit`)               | b         | home `items.md`, fenced to `items/**`, `releases/**`, `git-run.util.ts`; every server module can run git |
| 47 | The server never writes git                                        | b         | home `security.md`, fenced to top-level `server/src/*.ts` only             |
| 51 | `backlog-orchestrate` is the only skill that merges into a base    | b         | home `orchestrator.md`; governs execute and groom, which don't load it     |
| 60 | Undo an orchestrator merge with `git revert -m 1`                  | a         |                                                                            |
| 64 | Editing `skills/` changes nothing until commit, push, `plugin:sync` | a        |                                                                            |
| 76 | pnpm only                                                          | a         | no home                                                                    |
| 80 | Backlog items move `open/` → `done/`; `out-of-scope/` is flat      | c         | no home                                                                    |
| 25 | Every server route lives under `/api`                              | b         | no home; each controller sets the prefix (no `setGlobalPrefix`), 17 files across subdirectories |
| 74 | The served build carries a CSP; the theme script's hash follows it | b         | no home; the script is in `client/index.html`, which no rule file fences    |

Every other bullet in `## Invariants` (~90) leaves `CLAUDE.md` and lives only in its rule file. Those that already have a home need nothing but the
deletion. The ones with no home today get one:

| #              | Rule                                                        | New home       |
| -------------- | ----------------------------------------------------------- | -------------- |
| 75, 79         | container mounts; vite restart                              | `security.md` — #75 also governs `BM_REPO_ROOTS` in `server/src/jira/env.util.ts`, fenced only by `jira.md`: the fence audit settles it |
| 26             | Item bodies served through the registry-built allowlist     | `items.md`     |
| 78             | `allowBuilds` lists `esbuild`                               | `scripts.md`   |
| 101            | `linkBase` becomes an href                                  | `board.md`     |

## The fence audit (decided with the user)

Every rule leaving `CLAUDE.md` — the 85 with an existing home as well as the five getting one, the rules embedded in `## Layout`, and the Conventions
bullets — is checked against criterion (b): does its rule
file's `paths:` cover every file the rule governs? A failure is fixed narrowly:

- **One or two specific files outside the fence** → add those globs to that rule file's `paths:`. Example: #13 "A starting entry blocks what a run
  file blocks" lives in `board.md` (`client/src/**`) but also governs `POST /api/agents/orchestrate` and `shared/agent.ts`.
- **A rule that spans several subsystems** → it joins the `CLAUDE.md` keep-list, criterion (b).

Each widening adds that rule file's bytes to every session touching the new glob, so prefer the narrowest glob that names the governed file. The plan
records each failure and which way it was fixed; the final keep-list may therefore grow past fourteen (~230 B each), and the ~11 KB target stays soft.

## The rest of `CLAUDE.md`

- **Intro and `## Commands`** — unchanged (the commands table is ~3 KB and every session uses it).
- **`## Layout`** (8.4 KB today) — one line per top-level seam (`server/src/`, `client/src/`, `shared/`, `skills/`, `agents/`, `.claude/rules/`,
  `backlog/`, `scripts/`, `docs/`), each pointing at its subsystem doc. The `.claude/DESIGN.md` pointer stays. Today's Layout is not only description:
  it embeds normative rules — the ten item-write routes plus `abort` are the ONLY writes to items (CLAUDE.md:45), the three outbound-calling modules are
  the ONLY three (:55), `runGit` is the one way the server runs git (:62), every derivation has one home in `lib/` and every shared look one in
  `components/ui/` (:71-72), every component cites its DESIGN.md subsection (:79), `backlog.mjs` / `orchestrate.mjs` are the only writers of the
  registry / run file (:84-85), start orchestrator runs from the board (:91), the `.claude/rules/` contract (:97). Each embedded rule goes through the
  cross-cutting criterion like any `## Invariants` bullet — keep-list, or a rule file whose fence covers what it governs — and only purely descriptive
  detail moves to `docs/overview.md`. `test/runs/runs-view.test.tsx:2653,2679` cite "CLAUDE.md's `lib/` rule"; they follow wherever that rule lands.
- **A path → rule-file table** (new) — the eleven rule files and their `paths:` globs, plus one rule: before editing a file under a glob through any route
  that does not `Read` it first (`codegraph_explore`, `Write`, a subagent), read that rule file. This replaces the sentence in today's `## Invariants`
  preamble that says the same thing in prose.
- **`## Conventions`** — the PR-title rule stays. The supertest, jsdom-fixture-date and test-location bullets are already in `tests.md` (lines 16, 22,
  30), but they go through the fence audit like everything else before being deleted from `CLAUDE.md`: the test-location rule governs
  `skills/*/tools/*.test.mjs` and `scripts/*.test.mjs` too (`scripts/test-all.mjs:33`), which `tests.md`'s fence (`test/**`, `.claude/rules/**`) does
  not cover — widen the fence by those two globs or keep the bullet.
- **The `## Invariants` heading stays**, holding the keep-list: `tierOne` in `test/helpers/rule-tiers.ts` reads from it to end of file and throws
  without it, and `agents/backlog-reviewer.md:129` names the section.

## The CodeGraph/Write gap

Path-scoped rules load on a `Read` of a matching file — including a custom subagent's or a headless run's `Read` (measured, `tests.md:11-12`). They do
not load when code is reached by any route that never `Read`s the file: `codegraph_explore`, `Write` without a prior `Read`, `Grep`, `Glob`. Today the 108 headlines in `CLAUDE.md` are the safety net for those
routes. After the split, the net is the path → rule-file table plus its "read before editing" rule. A hook that injects the matching rule file on a
`codegraph_explore` or `Write` targeting a fenced path was considered and deferred: the user chose to start with the table and add enforcement only if
sessions are seen skipping it.

## Guard tests

`test/guards/claude-rules.test.ts` (with `test/helpers/rule-tiers.ts`) changes contract, not strictness:

- **Was:** `CLAUDE.md` headlines and rule-file headlines are the same set.
- **Becomes:** every linked `CLAUDE.md` headline appears byte-equal (on the joined text) as a rule-file headline — tier one is a SUBSET of tier two —
  and every unlinked `CLAUDE.md` bullet stays under the existing word cap.
- **New:** the path → rule-file table in `CLAUDE.md` and the files in `.claude/rules/` are the same set in both directions, and each row's globs match that file's `paths:` exactly, so adding a
  rule file without listing it, or changing a fence without updating the table, goes red.
- **New:** a size budget on `CLAUDE.md` (suggest 14 KB — real headroom over the ~11 KB target, still under the 15 KB anti-goal). The assertion is hard; "soft" means the number may be
  raised in a reviewed change, and the failure message says to move a rule down a tier, not to compress wording.
- **New:** one home per headline, not only per anchor — a joined headline appears in at most one rule file, so a bullet with no anchor cannot be
  homed twice unseen (today one-home is keyed on anchors only, `test/helpers/rule-tiers.ts:124`).
- **Kept:** one home per anchor; every rule file has a non-empty `paths:` whose globs each match a tracked file; the fixtures proving each guard bites
  (extend them for the subset and table assertions).

`test/guards/dialog-count-docs.test.ts` asserts `CLAUDE.md keeps the headline` for the Escape rule (#15), which is moving to `board.md` only. That assertion
moves with it: it should pin the headline in `board.md`.

## Other surfaces that cite `CLAUDE.md`

- Test comments refer to rules as "CLAUDE.md's …" in 19 files today — every hit of `grep -rln CLAUDE.md test/`. Where the rule moves,
  the comment should point at its rule file.
- The same-set contract is stated in prose, and each statement changes to the subset contract: `CLAUDE.md`'s own `## Invariants` preamble, `.claude/rules/tests.md:8-12` (bullet #104's mechanism —
  "one multiset", and itself guarded), `docs/subsystems/invariants.md` (the three-tier entries, around :3093, :3103-3105, :3215-3216, :3223),
  `docs/overview.md:16,30-32`, `test/helpers/rule-tiers.ts:4-9,124` and `test/guards/claude-rules.test.ts:12-17`.
- `docs/subsystems/invariants.md`, `docs/overview.md` and `.claude/rules/*.md` headers describe the three tiers ("the headline is in CLAUDE.md");
  the rule-file header line says so verbatim. These need rewording to "the headline is in CLAUDE.md for cross-cutting rules, here otherwise".
- `agents/backlog-reviewer.md` reads `CLAUDE.md`'s Invariants AND the rule file for every file a diff touches; it keeps working unchanged. It is
  published to other repos, so its wording stays generic — do not edit it for this repo's layout.
- `skills/backlog-orchestrate/references/questions.md` and `skills/backlog-execute/SKILL.md` already name both `CLAUDE.md` and the scoped rules. No change.
- `~/.claude/skills/preload-audit/references/three-tier.md` describes this repo's split as its worked example. It lives outside this repo; mention
  it to the user once this lands, do not edit it from here.

## Left to the builder

- The exact wording of the trimmed `## Layout` lines, and where in `docs/overview.md` the moved detail lands.
- Rule-file grammar for the five homeless bullets that move down: today a rule-file bullet must cite exactly one `invariants.md` anchor, and these
  have none. Either write a short reasoning entry for each, or allow an unlinked bullet in a rule file under the same 80-word cap `CLAUDE.md` uses.
  Builder's call; pick one and make the guard say so.
- Whether #18 (479 B, the longest bullet) stays whole or is split into a short headline in `CLAUDE.md` plus its tracker-write mechanism in `items.md`.
- Where in each rule file the moved and new bullets sit.
- The exact budget number, as long as it is soft and its message says "move a rule down a tier".

## Done looks like

- `CLAUDE.md` at roughly 11 KB, re-measured with `/preload-audit` and the before/after stated.
- The keep-list rules (fourteen, plus whatever the fence audit adds) in `CLAUDE.md`; every other former headline present in exactly one rule file; no
  rule text lost (a token-survival check over the old `## Invariants`, `## Layout` and `## Conventions` against the union of the new `CLAUDE.md`,
  `.claude/rules/` and `docs/overview.md` is the evidence).
- `pnpm run test:jest -- claude-rules dialog-count-docs` green; CI green on the PR.
- Confirmed in the context panel of a fresh session — the panel is ground truth, the audit is an estimate over disk.
