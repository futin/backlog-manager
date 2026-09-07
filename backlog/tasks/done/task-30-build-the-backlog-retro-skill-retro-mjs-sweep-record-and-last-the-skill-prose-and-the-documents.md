---
id: task-30
title: Build the backlog-retro skill: retro.mjs sweep, record and last, the skill prose, and the documents
created: 2026-09-06
tags: skills, retro, stats, docs
updated: 2026-09-07T19:11:51Z
started: 2026-09-07T18:10:38Z
execute-elapsed: 3673
execute-tokens: 399000
---

## Goal

A sixth plugin skill, `backlog-retro`, per
`docs/superpowers/specs/2026-09-06-backlog-retro-design.md`: a
deterministic tool sweeps every orchestrator run on the machine into one
JSON (cost, turns, context, stage durations, fix loops, verdicts, park
reasons, driver spend by lease id, fitted rates, deltas since the previous
record); the skill labels the fix-verdict reviews, writes the report,
proposes items for a pick, and records the sweep under
`~/.backlog-manager/retro/`, that directory's single writer. The
2026-09-06 hand sweep (27 runs, 83 items, ≈$800) is the baseline the first
record is measured against.

## Plan

Follow `docs/superpowers/plans/2026-09-06-backlog-retro.md` task by task —
read its "How to read this plan" section first: tests are the contract,
code fragments are shapes, there are no commit steps. The nine tasks, one
line each:

1. CLI skeleton and paths — `tools/retro.mjs` (`RetroError`, `main`,
   usage, exit codes) and `tools/lib/paths.mjs` (the four homes,
   `projectDir`, `decodeProjectDir`, `claudeProjectKey`,
   `readRegistryNames`).
2. Run files — `tools/lib/run-files.mjs`: projects, runs, items, stage
   spans with `fixing` split out and `pending` as queue wait, verification
   failure extraction; `sweep` prints a partial `RetroSweep`.
3. Session logs — `tools/lib/sessions.mjs`: filename classification,
   `result` event, context floor/peak/messages, the latest-run join with
   `collision`, `killed` and `usage-mismatch` caveats.
4. Reviews, verify status, totals — `tools/lib/reviews.mjs`,
   `tools/lib/totals.mjs` with the exact key set and the median/p90
   conventions.
5. Rate fit and driver transcript — `tools/lib/rates.mjs` (OLS over ≥ 8
   measured sessions, `estimated: true` on every priced figure),
   `tools/lib/driver.mjs` (by `driver.sessionId`, `no-lease | not-found |
   unreadable`).
6. Deltas, `--text`, `--project` — `newestRecord`, `computePrevious`,
   `renderText`, the unknown-project exit `1`.
7. `record` and `last` — validation of the closed label and status sets,
   filesystem-safe stem, refuse-to-overwrite exit `2`, `last` exit `3`.
8. `SKILL.md` (five steps, six hard limits, labels file shape, kaizen line
   shape) and `references/rationale.md` (baseline table).
9. Documents — `CLAUDE.md` line 3, the Layout skills bullet, one new
   Invariants bullet; `README.md` skill count and list.

Global constraints in the plan apply to every task: zero dependencies, no
import across skills' `tools/`, reads only through the four env-overridable
homes, writes only under the retro home from `record`, tests never touch
the real home.

## Test cases

The plan carries the exact cases and expected values per task; the suite
is `skills/backlog-retro/tools/retro.test.mjs` plus
`skills/backlog-retro/tools/retro-lib.test.mjs`, picked up by
`pnpm run test:skills`'s glob. Headline cases: `claudeProjectKey` on the
two observed paths; `stageSpans` yielding seven from-stage keys and
`queueWaitMin: 2`; `readSession` on a seeded stream-json log giving
`costUsd 5.4632055`, `turns 66`, `denials 2`, `terminated ok`, `context
{floor 55000, peak 120000, messages 5}`; the collision caveat for an item
dispatched in two runs; the Task 4 fixture totals (`merged 2`,
`costUsd.measured 15`, `costPerMerged.measured 7.5`, `fixLoops {1, 1, 2,
22}`, `verdicts {approve 2, fix 1}`, `itemWallMin {45, 60, 60, 30}`); exact
rate recovery from eight synthetic sessions and `null` from seven; driver
sums from three seeded usages with `subagents {2, 150000, 1}`; deltas
against a record fixture; `record` refusing a second write with identical
bytes; `last` exit `3` on an empty home.

## Done when

- `pnpm run test:skills`, `pnpm test` and `pnpm run typecheck` green.
- `node skills/backlog-retro/tools/retro.mjs sweep --text` against this
  machine's real run state prints a headline block whose measured spend
  agrees with the 2026-09-06 baseline ($540.71 over 92 sessions) and
  marks the driver figure `est.`; `--json` is parsable.
- `CLAUDE.md` says six skills and carries the new invariant; `README.md`
  lists `backlog-retro`.
- Published after merge: push and `pnpm run plugin:sync`; the first
  `/backlog-retro` run then produces the first record.

## Outcome

2026-09-07 — built, tested and documented. `backlog-retro` is a sixth plugin
skill: `skills/backlog-retro/tools/retro.mjs` (`sweep`, `record`, `last`) over
eight modules in `tools/lib/`, `SKILL.md`'s five steps and six hard limits,
`references/rationale.md`'s baseline table, and the document edits.

All nine plan tasks landed, each TDD (tests written and run red before the
module existed). 508 skill tests (up from 505 — 53 new across
`retro.test.mjs` and `retro-lib.test.mjs`), 1566 jest tests, typecheck clean.

Verification, `pnpm test` and `pnpm run typecheck` on the finished branch:

```
$ pnpm run typecheck
$ tsc --noEmit
(no output — clean)

$ pnpm test
Test Suites: 82 passed, 82 total
Tests:       1566 passed, 1566 total
# tests 508
# pass 508
# fail 0
────────────────────────────────────────────────────────────
PASS  jest
PASS  node --test (skills)

pnpm test: both runners passed.
```

The "Done when" check against this machine's real run state. Scoped to runs
started at or before `2026-09-06T21:03:30Z` — the moment of the hand sweep —
the tool reproduces its baseline exactly:

```
as of the 2026-09-06 baseline cutoff:
  runs 27  items 83  sessions 92  measured $540.71
baseline claimed: 27 runs, 83 items, 92 sessions, $540.71
```

Unscoped (five more runs have landed since), `sweep --text` prints:

```
runs                  32 (running 2, done 27, failed 2, aborted 1)
items                 99 queued, 82 dispatched, merged 73 of 99
sessions              116 (execute 78, fix 33, retry 5); killed 2
measured spend        $644.28
driver spend          $56.16 est.
all-in spend          $700.44 est.
per merged item       $8.83 measured, $9.60 est. all-in
fix loops             31 item(s) of 82 dispatched (38%), 36 loop(s), $140.23, 638.32 min
median item wall      37.37 min (p90 84.12 min; 29.58 without a fix loop, 59.12 with)
queue wait            median 40.68 min, p90 316.29 min (not pipeline time)
```

`--json` parses (442,159 bytes through a pipe), the driver figure carries
`est.`, `last` exits `3` with no record yet, an unknown `--project` exits `1`,
and nothing under `~/.backlog-manager/` was written by any of it.

Contract sweep: 8 sites updated (CLAUDE.md, README.md, docs/overview.md,
docs/subsystems/skills.md, docs/subsystems/invariants.md,
.claude-plugin/plugin.json, plus CLAUDE.md's Layout and Conventions entries)
Red proof: 19 tests went red with the change reverted

The red proof was a mutation pass rather than a revert, since the production
code is all new: each of 19 load-bearing rules was individually broken in the
source and the suite re-run — queue wait kept out of pipeline time, the median
and p90 conventions, the context floor over the first three samples, the
eight-session floor and the singular-system refusal in `fitRates`, ANSI
stripping, excerpts on a `fix` verdict only, the latest-dispatching-run join,
archived-sidecar discovery, `branched` as a success exit, the usage join by
kind+loop, `record`'s refusal to overwrite and its label validation,
`--project`'s refusal, the `est.` marker, `last`'s exit `3`, the unreadable
home's exit `1`, and the pipe-flush fix below. Every one went red; the tree
was restored from a file copy (never `git stash`) and verified byte-identical
afterwards.

Two of those probes came back GREEN on the first pass and were real gaps, both
fixed rather than noted:

- The `readSession` context fixture used samples where the minimum over the
  first three and the minimum over the whole session were the same number, so
  it would have passed with the floor rule removed. The fourth sample is now
  deliberately lower than all three (a compaction drops the window
  mid-session).
- The `usage` join test seeded one usage entry whose `sessionId` also matched,
  so a session-id join would have passed too. A second case now gives one item
  an `execute` and a `fix` entry sharing one session id — the real shape,
  since `claude -p --resume` keeps the id it was handed — and asserts each log
  matches its own slot.

### One bug found and fixed during verification

`sweep --json` was silently truncated at exactly 65,536 bytes whenever stdout
was a **pipe**. `process.stdout.write` to a pipe is asynchronous and
`process.exit()` tears the process down without draining it. `> file.json` (a
synchronous write on POSIX) was always fine, which is why every hand check and
every small test fixture passed: a real sweep of this machine is 442,757 bytes
and arrived as 65,536 and a parse error. The entry guard now sets
`process.exitCode` and lets node flush and exit on its own — safe here because
every read is synchronous `fs` with no server, timer or child process holding
the loop open. Pinned by a test that seeds 300 items and asserts the piped
stdout exceeds the pipe buffer and parses.

### Four deliberate departures from the plan

1. **Sidecars are discovered in `runs/<archiveStem>/` as well as flat.**
   task-31 landed between the spec and this build; the spec still describes
   the sidecar directories as flat. Reading only the project directory's own
   `logs/` would have seen 36 of this machine's 116 transcripts, and the
   baseline check could not have passed. `lib/paths.mjs`'s `sidecarRoots`
   reads both. An archive stem is treated as a STORAGE location and never as
   an attribution — the first archive after task-31 swept 74 transcripts
   belonging to a dozen runs into one stem — so the join is still
   `(project, itemId)` to the latest dispatching run, and the `collision`
   caveat is unchanged.
2. **A `usage` entry is matched by `kind` + `loop`, not by `sessionId`.** The
   plan (Task 3) says session id. `shared/types.ts`'s own
   `RunSessionUsage.sessionId` documentation says the opposite and explains
   why: `--resume` keeps the id, so an item's three transcripts all report one
   session. The session id now corroborates the match rather than making it.
3. **`items[]` carries `stageAt` verbatim, beyond the plan's field list.**
   `stages` keys a span by its *earlier* stage, so a terminal stamp opens no
   span — which means `stages` cannot answer "did this item reach
   `dispatched`" and cannot give preflight→terminal wall time. Both are inputs
   `totals` needs.
4. **A session's `key` is `<project>/<path relative to the project dir>`**,
   not `<project dir>/<basename>`. Two archives can each hold a `bug-1.jsonl`,
   and a bare basename collapses two real sessions into one row. Reviews use
   the same shape, which is exactly the `<project>/reviews/<file>` key spec
   §3.2 specifies for `labels.json`.

The plan's Task 9 named CLAUDE.md and README.md only; the contract sweep found
four more sites the skill count made false (`docs/overview.md` twice plus its
five-artefact data-plane table, `docs/subsystems/skills.md`'s "The five" and
"The two CLIs", and `.claude-plugin/plugin.json`'s own skill enumeration, which
is published). The new invariant was given a long-form home in
`docs/subsystems/invariants.md` and CLAUDE.md's bullet points there, matching
the convention the last three commits established, rather than linking the
spec directly.

### Left for the run and for later

- **`pnpm test` is flaky, in a suite this branch does not touch.** One of four
  post-install runs failed on `test/question-mode.test.ts` — "composes ids,
  then the merge-mode flag, then the question-mode flag", `expected 201
  "Created", got 400 "Bad Request"`. The suite passes 3/3 in isolation and the
  other three full runs were green. Nothing in this diff is read by jest (no
  test opens `CLAUDE.md`, `README.md` or `skills/`), so it is pre-existing.
  Worth its own bug.
- **`backlog.mjs` and `orchestrate.mjs` still use `process.exit(main(...))`**
  and so carry the same latent 64KB pipe truncation. Neither emits that much
  today (`board --json` is ~4.5KB here), so it is a latent bug rather than a
  live one, and fixing sibling tools is outside this item.
- Not committed and not pushed, per this skill's hard limits. Publishing is
  the usual `push` + `pnpm run plugin:sync`; `backlog-retro` becomes visible
  on the next Claude Code restart, and the first `/backlog-retro` run then
  produces the first record.
- `node_modules/` was installed in this worktree to run jest; it is gitignored.

### Review round 1 — both Important findings fixed

Both were accurate, and both were prose this branch wrote claiming more than
the code does. Verified against the code before rewriting; the code was right
in both cases, so only the sentences changed.

**1. `CLAUDE.md:111` — the exhaustive read clause was false.** It said `sweep`
"opens nothing else outside the run-state home but a run's driver transcript
by recorded session id", while `buildSweep` (`retro.mjs:184`) calls
`readRegistryNames(registryFile())` on every sweep. The bullet now states the
read surface positively and completely: four homes — run state, retro home,
`registry.json`, and one driver transcript per run by recorded lease id — and
writes to none of them. `docs/subsystems/invariants.md` gained a matching
paragraph naming all four with their env overrides, and the sentence above it
("that is the one crossing") was tightened to "the one crossing into the
directory `record` owns", which is what it meant and not what it said.
`CLAUDE.md:58`'s Layout line had the same omission one bullet away and now
names the registry too.

**2. `docs/subsystems/skills.md:49` — "all three carry ... the discriminator,
`orchHome()`, `projectDir()`" was false in both directions.** Measured:

```
                          orchHome()  projectDir()  commondir
backlog.mjs                        0             0          7
orchestrate.mjs                    1             1          7
backlog-retro/lib/paths.mjs        1             1          0
```

No helper is in all three, and the two pairs are different pairs. The sentence
now says exactly that: `backlog.mjs` + `orchestrate.mjs` share the
linked-worktree discriminator, `orchestrate.mjs` + `retro.mjs` share
`orchHome()` and `projectDir()`, `retro.mjs` has no discriminator (it needs no
git root — its subject is every project at once) and `backlog.mjs` has neither
path helper.

**A third instance of the same defect, found while checking the second.**
`lib/paths.mjs`'s own header claimed `orchHome()` and `projectDir()` exist
"here AND in `orchestrate.mjs` AND in `server/src/orchestrator/`". The server
has `orchHome()` but no `projectDir()` — it inlines `encodeURIComponent(project)`
(`orchestrator.service.ts:477`). The header now names each function's own twin
set and says outright that the sets differ, because "all of these exist in all
of those files" is the tidy summary a reader assumes and it is wrong both ways.

**One test added, so a claim the fix makes is mechanically true.** skills.md
now says each duplicated copy is "pinned by its own tool's suite", and
`retro-lib.test.mjs` pinned `retroHome()` alone by name — the other three
homes were only exercised indirectly through the CLI's environment. One case
now pins all four (`orchHome`, `retroHome`, `registryFile`,
`claudeProjectsRoot`), override and default, and it replaces the narrower
`retroHome` case it subsumes. Test count is unchanged at 508.

Contract sweep: 4 sites updated (CLAUDE.md:58, CLAUDE.md:111,
docs/subsystems/invariants.md, docs/subsystems/skills.md, plus
skills/backlog-retro/tools/lib/paths.mjs's header); swept the repo for
surviving copies of both claims and found none — every other "nothing else"
is a writer claim or unrelated.
Red proof: 4 tests went red with the change reverted

The four are the new pinning case, probed one home at a time by dropping each
`process.env.<KEY> ||` from `lib/paths.mjs`; all four went red and the tree was
restored from a file copy and diffed clean. The two prose fixes have no test
of their own — they are documentation corrections, and the code they describe
was already correct and already pinned.

Re-ran every check this Outcome lists: `pnpm run typecheck` clean; `pnpm test`
green both runners (82 jest suites, 1566 tests; 508 skill tests); the baseline
reconciliation still exact (`27 runs, 83 items, 92 sessions, $540.71`);
`--json` parses through a pipe (447,726 bytes); `--project /nowhere` exits `1`,
`last` exits `3`, an unknown command exits `1`; the driver line still carries
`est.`; nothing written under `~/.backlog-manager/` outside this run's own log.
