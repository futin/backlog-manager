---
id: task-22
title: Gate the node-runner skill suite so orchestrate.mjs and backlog.mjs cannot regress into a merge
created: 2026-09-06
tags: tests, audit-2026-09-06
runner-fix: true
updated: 2026-09-06T18:28:20Z
groom-elapsed: 107
groom-tokens: 20179
---

## Goal

Make it impossible for a regression in `orchestrate.mjs` (2,858 LOC, the run file's only
writer) or `backlog.mjs` (1,853 LOC, the registry's only writer) to pass every automated
gate this repo has and merge to `main`.

Today it can. `pnpm test` is `jest --runInBand`, and `jest.config.ts:11`'s `testMatch` is
`['<rootDir>/test/**/*.test.ts', '<rootDir>/test/**/*.test.tsx']`, which
`skills/*/tools/*.test.mjs` can never match. `test:skills` is a separate manual script.
There is no CI config (`.github/workflows`, `.gitlab-ci.yml`, `.circleci` all absent) and
`.git/hooks` holds only `*.sample` files. An orchestrated run's own unattended verification
resolves to `['test','typecheck','build']` from `package.json`
(`resolveVerifyCommands`, `orchestrate.mjs:2525` — literally that array) with no
`backlog/verify.json` present to widen it.

No rescuing mechanism holds: the `## Done when` union extracts only *fenced* commands, and
exactly one of ~45 backlog items ever fenced `pnpm run test:skills`. `test:skills` appears
in no SKILL.md, no agent and no tool, and no jest suite ever spawns either tool.

Raised as an **Important** finding of the 2026-09-06 audit, upheld — recorded there as an
undocumented gap rather than a stated design decision.

## Plan

Both halves of the gap close with one change: an orchestrated merge never runs the skill
suite, and a human typing `pnpm test` gets a false green.

**Make `test` the union of both runners.** `package.json`'s `test` runs jest *and* the node
runner, so the single word everything already reaches for — a human, the orchestrator's
`['test','typecheck','build']`, any future CI — covers both. `test:skills` keeps its exact
present meaning, so the fast inner loop on a skill tool stays ~74s rather than ~210s. No
`backlog/verify.json`, and no change to `orchestrate.mjs`.

### Decisions taken during grooming — settled, do not re-open

The item as filed deferred its central choice to a measurement nobody had made, and
contradicted itself on failure handling. Both are resolved here so a headless
`backlog-execute` session has nothing left to decide.

1. **Chained `test`, not `backlog/verify.json`.** Measured 2026-09-06 in the main tree with
   an orchestrator run in flight, so these are pessimistic:

   | command | wall clock | corpus |
   |---|---|---|
   | `pnpm test` (jest as it stands) | 136s | 76 suites, 1469 tests |
   | `pnpm run test:skills` | 74s | 406 tests |
   | union, sequential | ~210s | — |

   That is +54% on every orchestrated item's verification step, not once per run. Judged
   acceptable: the alternative is 4,711 LOC of single-writer tooling continuing to merge
   unproven. `backlog/verify.json` is explicitly **not** taken — it closes the
   orchestrated-merge half only and leaves `pnpm test` false-green for a human, and the
   human half is what the audit actually found.

2. **Both runners always run; neither short-circuits the other.** The item as filed
   contradicted itself: a Consequences bullet demanded "the second must not run as a bare
   `;`, and a non-zero exit from either must fail the whole script" (that is `&&`), while a
   test case demanded "a break in **both** exits non-zero and reports **both**, rather than
   stopping at the first runner". `&&` cannot satisfy both. Resolution: run both
   unconditionally, keep each exit code, exit non-zero if *either* was non-zero. That is the
   bullet's real intent — no swallowed failure — and the test case as written.

3. **Sequential, not concurrent.** Running the two in parallel would recover the 74s and is
   rejected anyway: jest is `--runInBand` on purpose, and interleaved output from two
   runners makes decision 2's "reports both" unreadable in a real failure log.

4. **A node script, not shell embedded in `package.json`.** The exit-code composition in
   decision 2 needs its reasoning recorded next to it, and `package.json` cannot hold a
   comment. This repo's comment density is a stated convention; a `; a=$?; ...; exit $((a||b))`
   one-liner in a JSON string is the opposite of it.

5. **`runner-fix: true` is set, despite touching none of the four paths the invariant
   names** (`backlog-orchestrate`'s SKILL.md, `orchestrate.mjs`, `agents/backlog-reviewer.md`,
   `server/src/agents/`). The reason is the marker's actual purpose: `resolveVerifyCommands`
   reads `package.json`'s `test` at every item's verification step, so an unhoisted landing
   splits one run into items verified under the weak gate and items verified under the strong
   one. Hoisting makes the run internally consistent and applies the new gate to the rest of
   its own queue.

### Implementation

1. **Add `test:jest` to `package.json`**, carrying today's `jest --runInBand` verbatim. The
   jest flags stay in `package.json` where they are greppable, rather than migrating into a
   script's argv.

2. **Add `scripts/test-all.mjs`.** Behaviour, not code:
   - Runs `pnpm run test:jest`, then `pnpm run test:skills`, in that order, sequentially,
     each with inherited stdio so their output reaches the terminal unbuffered and
     unwrapped. jest first so the top of a `pnpm test` log looks exactly where a human's eye
     already expects it to.
   - **Delegates to the two named scripts rather than re-spelling their commands.** This is
     what structurally removes the item's original "the chained command must keep both
     globs" hazard: `test:skills` still owns `skills/*/tools/*.test.mjs scripts/*.test.mjs`,
     and there is no second copy of that glob pair to drift.
   - Runs the second command even when the first exited non-zero (decision 2).
   - Exits `0` only if both exited `0`; otherwise exits `1`. Not the sum, not the last
     runner's code — `1` for any failure.
   - Prints a final summary line naming which runner(s) failed, after both have run.
     Without it "reports both" is true but unfindable in a 2,000-line log.
   - Invokes `pnpm`, unqualified. The repo is pnpm-only, pinned by `packageManager` and
     enforced via corepack in the image, so that is an existing invariant rather than a new
     assumption.
   - Must never invoke `pnpm test` — that is itself, and would recurse.

3. **Point `test` at it**: `"test": "node scripts/test-all.mjs"`.

4. **Do not add `scripts/test-all.test.mjs`.** That filename matches `test:skills`'s own
   `scripts/*.test.mjs` glob, so a test that spawned the runner would spawn the entire suite
   from inside the suite. This script's correctness is proved by the hand-run cases below and
   nowhere else; say so in the script's own header comment, or the next reader will file its
   missing test as a gap.

5. **Update CLAUDE.md**, in three places:
   - The Commands table: `Tests` becomes the union under `pnpm test`; add a row for
     `pnpm run test:jest` (jest only) alongside the existing `pnpm run test:skills` row, so
     both fast inner loops are documented.
   - Conventions: the sentence describing the two-runner split still holds — skill tests do
     still run under node's runner and not jest — but must now say that `pnpm test` runs both
     via `scripts/test-all.mjs`.
   - Invariants: add a short entry that `pnpm test` is the union and why. A future
     contributor "simplifying" `test` back to bare jest reopens this exact gap silently, and
     that is precisely the class of failure the Invariants section exists to hold.

**Do not add CI config as part of this item.** Which host, which triggers, what it costs is a
bigger call, and this gap closes without it.

## Test cases

The first five are the point of the item. A suite cannot assert its own gate, and decision 4
above bans the script that would try, so these are run by hand and their exit codes pasted
into `## Outcome`.

- Break one assertion in `skills/backlog/tools/backlog.test.mjs`. `pnpm test` exits `1`, the
  failure text names that file, and the jest run above it still reports its own pass.
- Break one assertion in any `test/*.test.ts`. `pnpm test` exits `1`.
- Break one assertion in **both** at once. `pnpm test` exits `1`, both failures appear in the
  output, and the summary line names both runners. Specifically: the node runner must still
  have run despite jest having already failed.
- Break one assertion in `scripts/sync-plugin.test.mjs`. `pnpm test` exits `1` — this is the
  glob most easily lost, and delegating to `test:skills` is what should make it safe.
- Restore every break. `pnpm test` exits `0` and the summary line reports both runners
  passing.
- `pnpm run test:skills` on a clean tree still runs the node runner alone, 406 tests, and
  does not invoke jest.
- `pnpm run test:jest` on a clean tree runs jest alone, 76 suites / 1469 tests, and does not
  invoke the node runner.

## Done when

```
pnpm test
```

```
pnpm run typecheck
```

- The five hand-run break cases above have been run and their exit codes recorded in
  `## Outcome`, including the both-broken case showing both runners reported.
- `## Outcome` records the union's measured wall clock on the executing machine, next to the
  136s / 74s baseline in the Plan, so the +54% estimate is either confirmed or corrected.
- CLAUDE.md's Commands table, Conventions section and Invariants section all describe what
  `test` now means.
