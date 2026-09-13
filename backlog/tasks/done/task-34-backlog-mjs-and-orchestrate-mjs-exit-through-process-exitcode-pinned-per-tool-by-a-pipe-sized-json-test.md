---
id: task-34
title: backlog.mjs and orchestrate.mjs exit through process.exitCode, pinned per tool by a pipe-sized --json test
created: 2026-09-13
from: ref-3
runner-fix: true
updated: 2026-09-13T09:16:56Z
started: 2026-09-13T08:53:27Z
execute-elapsed: 1409
execute-tokens: 92021
---

## Goal

Both remaining skill CLIs end the way `retro.mjs` already does — `process.exitCode =
main(...)`, letting node drain stdout and exit on its own — so a `--json` payload larger
than the 64KB pipe buffer arrives whole instead of being silently cut at exactly 65,536
bytes. Each tool carries its own short note on why exiting naturally is safe *for that
file*, one behaviour test per tool proves the payload survives a real pipe, and one
source guard keeps the rule from being undone by a future entry point.

## Plan

### What grooming already verified — do not re-derive these

Measured on 2026-09-13 against the current tree. Re-run the greps before editing (the
claims are about the files as they stand), but the conclusions are settled:

1. **Each tool has exactly one `process.exit(`, in its entry guard.**
   `skills/backlog/tools/backlog.mjs:1853` and
   `skills/backlog-orchestrate/tools/orchestrate.mjs:3390`. Nothing else in either file
   calls it, and nothing anywhere imports `main` from either module, so the entry guard
   is the whole surface.
2. **`backlog.mjs` holds nothing open.** A grep for
   `setTimeout|setInterval|setImmediate|async |await |spawn|exec|createServer|readline|process.stdin`
   over that file returns **zero** hits: every read is synchronous `fs`. It is the same
   shape `retro.mjs` documents for itself.
3. **`orchestrate.mjs` also holds nothing open, despite looking like it might** — this
   was ref-3's one genuinely open question and it is now answered. Every child process
   is `spawnSync` (reaped before the call returns: lines 1160, 1171, 1174, 1441, 2389,
   2925, 3231, 3261), and `watch`'s polling sleep is `sleepSync` (~:2331), an
   `Atomics.wait` on a throwaway `SharedArrayBuffer` — it *blocks the thread*, it does
   not schedule a timer. There is no `setTimeout`, no `setInterval`, no `async`/`await`,
   no server and no stdin read in the file. So `watch` and `verify`, the two commands
   ref-3 flagged, leave no live handle when `main` returns either. **No explicit drain
   is needed for either tool.**
4. **No exit code changes value.** Every command path returns an integer, and
   `process.exitCode = undefined` and `process.exit(undefined)` both exit `0`, so even a
   path that returned nothing would behave identically.
5. **What is genuinely given up:** `process.exit()` forced the process down even if
   something *were* holding the loop open. After this change, a future edit that opens a
   timer, a server or an async child would hang instead. That is the trade, and the rule
   for whoever makes that edit is to close the handle — not to bring `process.exit()`
   back, which would restore this bug.

### The change

- `backlog.mjs` entry guard → `process.exitCode = main(process.argv.slice(2))`, with a
  comment that states the rule, names the incident in one sentence (a real
  `retro.mjs sweep --json` was 442,757 bytes and arrived through `| jq` as exactly
  65,536 and a parse error, while `> file.json` — a synchronous write on POSIX — was
  always fine, which is why every hand check passed), and says why *this* file is safe:
  every read is synchronous `fs`, no timer, no child process, no server.
- `orchestrate.mjs` entry guard → the same line, with its own comment naming its own two
  constructs: every child is `spawnSync`, and `watch` sleeps by blocking on
  `Atomics.wait` rather than on a timer, so neither leaves a handle behind.
- Both comments should be short and point at `retro.mjs`'s existing long-form note
  (`retro.mjs:396-407`) as the full record rather than copying it a third time. Match
  this repo's comment density — explain *why*, don't just label the line.
- **Do not touch `retro.mjs`.** It is already correct and is the reference copy.
- `skills/backlog-orchestrate/tools/orchestrate.test.mjs` (~:2604) carries a comment on
  the E2BIG verify test explaining that it reads rows back from `run.json` rather than
  stdout because "main()'s `process.exit(...)` truncates a pipe write that large (a
  pre-existing property of the CLI…)". After this change that reason is **false**.
  Correct the comment to its remaining true reason — `run.json` is written before
  anything is printed, so the file is the whole and honest record either way — and drop
  the truncation clause. Leave the test's assertions alone; do not repurpose it as the
  pipe test.

### Docs

- `docs/subsystems/skills.md`, `### The three CLIs`: that section already enumerates what
  the three tools do and do not share ("No helper is shared by all three, and the two
  pairs are different pairs…"). Add that all three now end the same way, and why — one
  rule, three files, with the incident named once.
- `CLAUDE.md` Invariants: one bullet, in the established shape, with a `Why:` link, plus
  the matching `##` section in `docs/subsystems/invariants.md` for the anchor to resolve.

### Two calls made during grooming, stated so they can be overridden rather than found

- **`runner-fix: true` is set on this item.** It edits
  `skills/backlog-orchestrate/tools/orchestrate.mjs`, one of the four paths
  `backlog-groom`'s SKILL.md names, so the orchestrator hoists it to the front of the
  queue and the rest of the run is not executed by the un-fixed version. Per
  `backlog-orchestrate` SKILL.md §9, after this merges the runner rule applies: follow
  the repo's SKILL.md **and** `orchestrate.mjs`, both or neither. Note that the fix is
  inert for the *next* run until push + `pnpm run plugin:sync`.
- **The rule is documented as an invariant, not only as a sentence in `skills.md`.** It
  is a one-rule-three-files agreement with a shipped incident behind it, which is the
  shape of every other entry in that list. If a reviewer disagrees with spending a
  CLAUDE.md bullet on it, the `skills.md` sentence is the floor and must stay.

## Test cases

Four. Both behaviour tests must be **observed red before the fix** — revert the one-line
entry-guard change, re-run, and confirm the failure is ~65,536 bytes and a JSON parse
error. A green-on-both-sides test here is worth nothing: this is precisely the bug that
survives every small fixture.

1. **`skills/backlog/tools/backlog.test.mjs` — "a board larger than the pipe buffer
   arrives whole".** Seed a fixture store (`backlogFixture()` + `init()`) with enough
   open items via `writeItem` that `board --json` exceeds the pipe buffer, then call the
   file's existing `run(cwd, 'board', '--json')` helper — `spawnSync`, i.e. a real pipe,
   which is the entire point; a test that redirects to a file cannot fail on this bug.
   Sizing: this repo's own board measured **2,745 bytes for 8 items** on 2026-09-13
   (~343 bytes each, with long absolute paths); a tmpdir fixture's paths are shorter, so
   seed ~250 items with ~120-character titles and **assert the measured byte count
   rather than trusting that estimate** — if the fixture lands under 65,536 the test is
   vacuous, so raise the count until it doesn't. Assert: `status === 0`; the captured
   output exceeds 65,536 bytes, with the actual count in the failure message (the
   existing retro case's `only ${n} bytes reached the pipe` shape); `JSON.parse` of it
   succeeds; the parsed array's length equals the number seeded. `run()` decodes with
   `encoding: 'utf8'`, so `.length` counts characters — keep the titles ASCII, or assert
   on `Buffer.byteLength`, so the number being compared to 65,536 is really bytes.
2. **`skills/backlog-orchestrate/tools/orchestrate.test.mjs` — "a status --json larger
   than the pipe buffer arrives whole".** `cmdStatus`'s `--json` branch prints the run
   file verbatim (~:2286), so either queue length or title length inflates it. Build it
   with `orchFixture(t)`, N `seedReadyTask(project, …)` items, then
   `commitEverything(project, …)` — **the commit is load-bearing**: the gate reads each
   item at `<base>` through `git show`, so uncommitted items are skipped as ungroomed and
   would never reach the queue — then `init --project <project>`, then
   `status --json`. ~40 items with ~2,000-character titles is roughly 80KB and costs 40
   git reads; ~250 ordinary items costs 250. Either is fine; if a 2,000-character title
   turns out to be truncated or refused by the frontmatter parser, fall back to more
   items with ordinary titles — the byte assertion is the contract, the fixture's shape
   is not. Assert: `init` exits 0; `status` exits 0; captured bytes exceed 65,536;
   `JSON.parse` succeeds; `queue.length` equals the number seeded.
3. **`skills/backlog/tools/backlog.test.mjs` — source guard over all three CLIs.** Read
   the sources of `backlog.mjs`, `orchestrate.mjs` and `retro.mjs` (read, never import —
   the same shape as this suite's existing `GROOM_SKILL_MD` / `EXECUTE_SKILL_MD` /
   `ORCHESTRATE_SKILL_MD` cross-skill cases, which is where this repo puts assertions
   that span two skills). Assert each contains `process.exitCode = main(` and that **no
   non-comment line** calls `process.exit(`. **Trap:** `retro.mjs`'s own comment
   (`:396-407`) contains the literal `process.exit()` twice, so a naive whole-file
   substring assertion goes red on the correct file — strip lines whose first
   non-whitespace characters are `//` before matching. This guard is why case 1 and 2 are
   not enough on their own: they cover only the two surfaces they drive, and a new CLI or
   a second entry point would reintroduce the bug green.
4. **The stale comment at `orchestrate.test.mjs` ~:2604 is corrected** (see the change
   section). Not a test case in its own right — listed here so the pass that touches
   these files cannot miss it.

Full suite: `pnpm test` — both runners. `pnpm run test:skills` alone exercises all four
cases above; run the union anyway, since the docs and CLAUDE.md edits are covered on the
jest side.

No browser check: this task touches no client code, so the Playwright rule does not
apply.

## Done when

- both entry guards read `process.exitCode = main(process.argv.slice(2))`, each with a
  comment naming the incident and stating why its own file leaves no handle open
- `retro.mjs` is byte-for-byte unchanged
- `grep -rn "process\.exit(" skills/*/tools/*.mjs` returns comment lines only
- the two behaviour tests were each **observed failing** with the change reverted — cite
  the byte count seen — and pass with it applied
- the source guard passes, and passes for the right reason (it rejects a hand-reverted
  `process.exit(main(...))` in either tool)
- the false comment at `orchestrate.test.mjs` is corrected
- `docs/subsystems/skills.md` states the shared exit rule under `### The three CLIs`;
  `CLAUDE.md` carries the invariant bullet with a working `Why:` anchor into
  `docs/subsystems/invariants.md`
- `pnpm test` is green — both runners, per the union rule

## Outcome

2026-09-13 — done. Both entry guards now read `process.exitCode =
main(process.argv.slice(2))`, each with its own comment naming the incident and stating
why *that* file leaves no handle open; `retro.mjs` is byte-for-byte unchanged (it never
appears in `git status`). The grooming claims were re-verified against the tree before
editing: `backlog.mjs` has no async, no child process, no timer and no server (its only
grep hits are `RegExp.prototype.exec` calls and the word "execute" in prose), and
`orchestrate.mjs`'s only `setTimeout` mention is the comment at :2325 explaining why
`sleepSync` blocks on `Atomics.wait` instead.

Three tests added — two behaviour, one source guard — plus the stale comment correction
the plan called for.

**Red proof, observed before the fix:**

```
not ok 212 - a board larger than the pipe buffer arrives whole
  error: 'only 65536 bytes reached the pipe'

not ok 1 - a status --json larger than the pipe buffer arrives whole
  error: 'only 65536 bytes reached the pipe'
```

Both landed on exactly 65,536 — the pipe buffer, to the byte. The source guard was
observed red twice, once per tool, by hand-reverting each guard to
`process.exit(main(...))` (file copied aside, restored from the copy — never `git
stash`, which is shared with every other worktree of this repo):

```
not ok 213 - all three skill CLIs end through process.exitCode, never process.exit
  error: 'backlog.mjs no longer sets process.exitCode from main() in its entry guard'

not ok 1 - all three skill CLIs end through process.exitCode, never process.exit
  error: 'orchestrate.mjs no longer sets process.exitCode from main() in its entry guard'
```

**One thing the plan did not predict, and it is the interesting part.** With stdout no
longer truncated, `verify`'s existing E2BIG case started failing — `status: null`, a
child killed by SIGTERM rather than the exit `1` the case asserts. Cause: that fixture
builds a deliberately 3MB-long command string, `verify`'s human-readable output echoes it
back, and the output is now *whole* — 3,145,805 bytes measured — which overruns
`spawnSync`'s 1MB default `maxBuffer` in the test helper. The tool is correct; the
harness was the narrower pipe of the two. `run()` in `orchestrate.test.mjs` now passes
`maxBuffer: 64MB`, with a comment recording why the default could never be reached
before this change. Worth noting for the same reason the original bug is: `process.exit()`
had been hiding how much this command really prints.

**Verification — `pnpm test`, both runners:**

```
Test Suites: 84 passed, 84 total
Tests:       1615 passed, 1615 total

1..538
# tests 538
# pass 538
# fail 0

────────────────────────────────────────────────────────────
PASS  jest
PASS  node --test (skills)

pnpm test: both runners passed.
```

`pnpm run typecheck` (`tsc --noEmit`) exits 0. `grep -rn "process\.exit(" skills/*/tools/*.mjs`
returns comment lines only across the three tools; the remaining hits in the two `.test.mjs`
files are `node -e "process.exit(0)"` fixture *commands* handed to child processes, which is
a different thing entirely and none of the guard's business.

Contract sweep: 4 sites updated (docs/subsystems/skills.md `### The three CLIs`, CLAUDE.md
Invariants, docs/subsystems/invariants.md, skills/backlog-orchestrate/tools/orchestrate.test.mjs)

Two sites left standing on purpose:

- `backlog/refactors/done/ref-3-*.md` and `backlog/tasks/done/task-30-*.md:244` both say
  `backlog.mjs` and `orchestrate.mjs` still carry the truncation. Both are archived
  items — evidence of what was true when they were written, and ref-3 is the very item
  this task came from. A record that is edited to agree with the present stops being a
  record.
- `docs/subsystems/skills.md`'s `docs-sync: verified:` sha is now stale against `skills/`.
  It cannot be set from here: the value is the commit this work lands in, and the
  orchestrator commits after this session exits. `docs-sync` owns that stamp.

Red proof: 3 tests went red with the change reverted (the source guard twice, once per tool)
