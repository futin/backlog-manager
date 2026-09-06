---
id: task-22
title: Gate the node-runner skill suite so orchestrate.mjs and backlog.mjs cannot regress into a merge
created: 2026-09-06
tags: tests, audit-2026-09-06
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
resolves to `['test','typecheck','build']` from `package.json` (`orchestrate.mjs:2292`,
literally that array) with no `backlog/verify.json` present to widen it.

No rescuing mechanism holds: the `## Done when` union extracts only *fenced* commands, and
exactly one of ~45 backlog items ever fenced `pnpm run test:skills`. `test:skills` appears
in no SKILL.md, no agent and no tool, and no jest suite ever spawns either tool.

Raised as an **Important** finding of the 2026-09-06 audit, upheld — recorded there as an
undocumented gap rather than a stated design decision.

## Plan

Two halves are broken and both should close, because they fail differently: an orchestrated
merge never runs the suite, and a human typing `pnpm test` gets a false green.

**Preferred: make `test` the whole suite.** Change `package.json`'s `test` script to run
jest *and* the node runner, so the single word everything already reaches for — a human, the
orchestrator's `['test','typecheck','build']`, any future CI — covers both. `test:skills`
stays as-is, so the fast inner loop on a skill tool is unchanged. This needs no
`backlog/verify.json` and no change to `orchestrate.mjs`.

Consequences to handle rather than discover:

- `test:skills` currently covers `skills/*/tools/*.test.mjs` **and** `scripts/*.test.mjs`;
  the chained command must keep both globs.
- The two runners must not silently swallow each other's failure — the second must not run
  as a bare `;`, and a non-zero exit from either must fail the whole script. Verify by
  breaking one suite at a time and checking `echo $?`.
- Wall-clock cost lands on every orchestrated item's verification step, not just once per
  run. Measure it and record the number in this item before closing; if it is large enough
  to matter, that is the argument for the alternative below, not a reason to skip the gate.
- CLAUDE.md's Commands table documents `pnpm test` and `pnpm run test:skills` as separate
  things, and the Conventions section describes the two-runner split. Both need updating to
  say `test` is now the union.

**Alternative, if the cost measurement says the chained `test` is too slow for a per-item
verification step:** add `backlog/verify.json` naming all four commands explicitly. That
closes the orchestrated-merge half only and leaves `pnpm test` false-green for humans, so it
is second choice — and if it is taken, say so in the file's own comment, because a future
reader will otherwise read the omission as an oversight.

Do not add CI config as part of this item. It is a bigger call (which host, which triggers,
what it costs) and this gap closes without it.

## Test cases

- `pnpm test` with a deliberately broken assertion in a `skills/*/tools/*.test.mjs` file
  exits non-zero, and the failure text names that file.
- `pnpm test` with a deliberately broken assertion in a `test/*.test.ts` file exits non-zero.
- `pnpm test` with a break in **both** exits non-zero and reports both, rather than stopping
  at the first runner.
- `pnpm test` with a break in `scripts/*.test.mjs` exits non-zero — the second glob is easy
  to drop while rewriting the script.
- `pnpm run test:skills` alone still runs only the node runner, unchanged.
- On a clean tree, `pnpm test` exits `0`.

The first four are the point of the item; run them by hand and paste the exit codes into the
outcome, because a test suite cannot assert its own gate.

## Done when

```
pnpm test
```

```
pnpm run typecheck
```

- A broken skill-tool test has been shown to fail `pnpm test`, with the exit code recorded.
- CLAUDE.md's Commands table and Conventions section describe whatever `test` now means.
