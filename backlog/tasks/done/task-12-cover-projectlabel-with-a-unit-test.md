---
id: task-12
title: Cover projectLabel with a unit test
created: 2026-09-04
updated: 2026-09-04T20:16:19Z
started: 2026-09-04T20:13:05Z
execute-elapsed: 194
---

## Goal

`client/src/lib/project-label.ts` is the only pure `lib/` module with three
production callers and no test file of its own. `test/` currently holds a
`*.test.ts` for every other pure helper in that directory (`item-age`,
`item-month`, `item-stale`, `item-touched`, `run-range`, `run-stage`,
`run-stats`, `run-time`, `project-hue`); `projectLabel` is exercised only
incidentally, through the component suites that render `RunStrip`,
`RunDrawer` and `RunsView`. That is coverage of the callers, not of the
contract.

Close the hole: one flat `test/project-label.test.ts` pinning the function's
stated behaviour, including the two fallbacks its implementation has but
nothing currently asserts.

**This item is also the deliberate smoke test for `backlog-orchestrate`.** It
was filed to be small enough that a full unattended run — worktree, headless
`backlog-execute`, commit, review, verify, branch — can be judged on the
pipeline rather than on the difficulty of the work. That does not make the
work fake: the coverage gap is real and the test earns its place whether or
not the run that produces it behaves.

## Plan

**On the format of this plan.** Behaviour and exact expected values below, no
literal code blocks — this overrides `superpowers:writing-plans`' "code blocks
required" rule for the reason this repo already states on task-11: handed code
gets transcribed verbatim, so a bug in the plan becomes a bug in the branch
with nobody positioned to catch it. `## Test cases` is authoritative.

### Scope

**Test-only. Do not change `client/src/lib/project-label.ts`.** The function's
current behaviour is the specification; if a case below looks wrong, the case
is what to argue with, not the implementation. Adding a guard, a trim, or a
Windows-separator branch is out of scope for this item — none of the three
callers can produce such a path (they all pass `OrchestratorRun.project`,
which is a registry absolute path written on a POSIX host), and speculative
hardening in a smoke-test item is exactly the churn that makes a review round
longer than the work.

### Where the test goes

`test/project-label.test.ts`, flat in `test/`, per the repo convention. No
jsdom docblock — this is a pure function with no DOM, so it runs under the
default environment like `run-time.test.ts` and `item-touched.test.ts` do.
Import `projectLabel` from `'../client/src/lib/project-label'`, matching how
`test/item-age.test.ts` reaches into `client/src/lib/`.

Match the surrounding suites' shape: one `describe('projectLabel')`, `it.each`
for the table-shaped cases, plain `it` with a comment for the two fallback
cases where the *reason* is the point and a table row would hide it.

### What the comments must carry

The repo's comment density is deliberate. Two facts belong in the file and
nowhere else, because neither is visible from the assertions alone:

- The empty-string case returns `''` and not some placeholder, and that is the
  `?? path` fallback firing, not a coincidence of `split`.
- The three callers all pass a registry absolute path, which is why no case
  covers a Windows separator or a relative path — state the omission on
  purpose so the next reader does not read it as an oversight and "fix" it.

## Test cases

Authoritative. Jest, flat in `test/project-label.test.ts`.

1. `'/Users/dev/code/example-app'` → `'example-app'` (the doc comment's own
   example, asserted verbatim so the comment cannot drift from the behaviour).
2. `'/Users/dev/code/example-app/'` → `'example-app'` — a trailing slash is
   dropped by the `filter(Boolean)`, it does not produce an empty tail.
3. `'/Users/dev/code/example-app//'` → `'example-app'` — repeated separators
   are dropped by the same filter.
4. `'example-app'` → `'example-app'` — a path with no separator at all is its
   own tail.
5. `'/single'` → `'single'`.
6. `''` → `''`. This is the `?? path` fallback: `''.split('/')` is `['']`,
   which the filter empties, so `pop()` is `undefined`. Assert the empty
   string, not `undefined` and not a placeholder.
7. `'/'` → `'/'`. Same fallback, and the one case where the returned value is
   the input path rather than a tail of it — worth its own assertion because
   it is the only input for which this function is an identity.
8. `'/Users/dev/code/my app (2)'` → `'my app (2)'` — spaces and parentheses
   are not separators and must survive.

No test for a `null`/`undefined` argument: the signature is `string`, every
caller passes `OrchestratorRun.project`, and asserting a TypeScript-impossible
input would need a cast that documents nothing.

## Done when

- `test/project-label.test.ts` exists and all eight cases pass.
- `pnpm test` is green, run in full — not just the new file.
- `pnpm run typecheck` is green.
- `client/src/lib/project-label.ts` is byte-for-byte unchanged, and the branch
  diff touches exactly one file.

## Outcome

2026-09-04 — Added `test/project-label.test.ts`, flat in `test/` with no jsdom
docblock, covering all eight cases from `## Test cases`: the six table-shaped
ones under one `it.each` and the two `?? path` fallbacks (`''` and `'/'`) as
plain `it`s, each carrying the reason a table row would have hidden. The file
header states on purpose why no Windows-separator or relative-path case
exists. `client/src/lib/project-label.ts` is byte-for-byte unchanged; the
branch diff is that one new file plus this item's own frontmatter markers.

One thing worth recording for the orchestrator smoke test this item doubles
as: the worktree had no `node_modules`, so the first `pnpm test` failed with
`sh: jest: command not found`. `pnpm install --frozen-lockfile` fixed it — a
fresh per-item worktree needs an install before any verification command will
run.

New file, all eight cases:

```
$ pnpm test -- test/project-label.test.ts
 PASS  test/project-label.test.ts (5.29 s)
  projectLabel
    ✓ reads /Users/dev/code/example-app as example-app (1 ms)
    ✓ reads /Users/dev/code/example-app/ as example-app
    ✓ reads /Users/dev/code/example-app// as example-app
    ✓ reads example-app as example-app
    ✓ reads /single as single (1 ms)
    ✓ reads /Users/dev/code/my app (2) as my app (2)
    ✓ returns the empty string for an empty path, via the ?? fallback
    ✓ returns the path unchanged for a bare separator (1 ms)

Test Suites: 1 passed, 1 total
Tests:       8 passed, 8 total
```

Full suite, per `## Done when`:

```
$ pnpm test
 PASS  test/project-label.test.ts

Test Suites: 58 passed, 58 total
Tests:       960 passed, 960 total
Snapshots:   0 total
Time:        80.053 s
Ran all test suites.
```

Types:

```
$ pnpm run typecheck
$ tsc --noEmit
(no output)
```

Diff scope:

```
$ git status --short
 M backlog/tasks/open/task-12-cover-projectlabel-with-a-unit-test.md
?? test/project-label.test.ts
```
