#!/usr/bin/env node
// `pnpm test` — the union of this repo's TWO test runners, jest and node's own.
//
// It exists because they were never joined, and the gap was invisible: jest's
// `testMatch` (jest.config.ts) is `test/**/*.test.ts(x)`, which
// `skills/*/tools/*.test.mjs` can never match, so `pnpm test` said green while
// 4,711 LOC of single-writer tooling — orchestrate.mjs (the run file's only
// writer) and backlog.mjs (the registry's only writer) — went entirely
// unproven. `test:skills` covered them but was a separate word nobody typed:
// no SKILL.md, agent or tool names it, and an orchestrated run's own
// verification step resolves to `['test','typecheck','build']` off
// package.json. So a regression in either tool could pass every automated gate
// this repo has and merge to `main`.
//
// Joining them under `test` rather than under a `backlog/verify.json` is
// deliberate: verify.json would close the orchestrated-merge half and leave a
// human typing `pnpm test` with the same false green, and the human half is
// what the audit actually found. The cost is ~136s + ~74s ≈ 210s sequential,
// +54% on every orchestrated item's verification step. Judged worth it.
//
// This script has no test of its own, and that is a decision, not an
// omission: `scripts/*.test.mjs` is inside `test:skills`'s own glob, so
// `scripts/test-all.test.mjs` would spawn the whole suite from inside the
// suite. Its correctness was proved by hand — every runner broken in turn,
// singly and together — and the exit codes are pasted into task-22's
// `## Outcome`.
import { spawnSync } from 'node:child_process'

// Delegate to the two named scripts; never re-spell their commands here.
// That is what keeps `test:skills`'s glob pair
// (`skills/*/tools/*.test.mjs scripts/*.test.mjs`) a single copy — a second
// one in this file is exactly the thing that drifts, and losing the
// `scripts/*.test.mjs` half would silently stop testing sync-plugin.mjs.
//
// `pnpm` unqualified is safe: the repo is pnpm-only, pinned by
// `packageManager` and enforced via corepack in the image.
//
// Neither entry may ever be `test` — that is this script, and it would
// recurse until the machine gave up.
const RUNNERS = [
  // jest first so the top of a `pnpm test` log holds what a human's eye
  // already expects to find there.
  { name: 'jest', script: 'test:jest' },
  { name: 'node --test (skills)', script: 'test:skills' },
]

// Both runners always run, and neither short-circuits the other. `&&` would
// have hidden a skill-suite break behind any jest break — and a run where
// both are broken has to report both, or the second break surfaces only
// after someone fixes the first and runs again.
const results = RUNNERS.map(({ name, script }) => {
  // Inherited stdio: each runner's output reaches the terminal unbuffered and
  // unwrapped, which is why they run sequentially rather than concurrently —
  // jest is `--runInBand` on purpose, and interleaved output from two runners
  // makes "reports both" unreadable in a real failure log.
  const run = spawnSync('pnpm', ['run', script], { stdio: 'inherit', shell: process.platform === 'win32' })
  // A runner that could not be spawned at all (`error`) or died on a signal
  // has no exit code; both are failures, not passes.
  const ok = !run.error && run.status === 0
  if (run.error) console.error(`\n${name}: could not run \`pnpm run ${script}\` — ${run.error.message}`)
  return { name, ok }
})

// The summary. Without it "reports both" is true but unfindable: a failure
// that scrolled past 2,000 lines ago is a failure nobody acts on.
const failed = results.filter((r) => !r.ok)
console.log(`\n${'─'.repeat(60)}`)
for (const { name, ok } of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
console.log(
  failed.length === 0
    ? `\npnpm test: both runners passed.`
    : `\npnpm test: FAILED in ${failed.map((r) => r.name).join(' and ')}.`,
)

// `1` for any failure — not the sum, not the last runner's code. Callers of
// this (a human, `resolveVerifyCommands`, any future CI) only ever ask
// pass-or-not, and a composed code would be a number nobody can look up.
process.exit(failed.length === 0 ? 0 : 1)
