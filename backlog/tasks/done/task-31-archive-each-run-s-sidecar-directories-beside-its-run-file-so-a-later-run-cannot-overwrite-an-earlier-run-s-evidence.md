---
id: task-31
title: Archive each run's sidecar directories beside its run file, so a later run cannot overwrite an earlier run's evidence
created: 2026-09-07
from: idea-8
runner-fix: true
updated: 2026-09-07T07:40:58Z
started: 2026-09-07T05:51:17Z
execute-elapsed: 6581
execute-tokens: 157119
---

## Goal

`cmdInit` archives the superseded `run.json` to `runs/<runId>.json` and nothing else. Every
other artefact a run produced stays in flat, project-scoped directories keyed by item id —
`<dir>/logs/`, `<dir>/reviews/`, `<dir>/verify/`, `<dir>/questions/`, and the
`<dir>/prompts/` one driver invented. An item dispatched again in a later run overwrites
the transcript, the reviewer report and the verify output of its first attempt, silently.
It has already happened: bug-2 here ran in three runs and task-9 in claude-agents-dashboard
in two; only the last log of each survives.

Make the archive whole. At `init`, when the previous `run.json` moves to
`runs/<stem>.json`, move that run's sidecar directories with it, into `runs/<stem>/`. The
live run keeps writing to the flat paths SKILL.md already names, so no step of the run
loop changes and no `<dir>/...` path in SKILL.md is rewritten.

`runner-fix: true` because this edits `orchestrate.mjs`'s `cmdInit` — the run file's only
writer — and `SKILL.md`. A run must not execute this item using the version of the tool
this item exists to change.

### Three decisions, taken here as assumptions

`AskUserQuestion` was not available in the groom session, so these were decided rather
than asked. Any of them is cheap to reverse before implementation starts.

1. **Move only. No new endpoint, no client UI.** idea-8 floated a sibling read-only
   endpoint serving one archived sidecar file so the Runs view could show a reviewer
   report next to its verdict, and called it optional itself — "the move alone fixes the
   loss." It needs its own path-safety design and its own Runs-view work; it belongs in
   its own item, filed after this one lands and the files are actually there to serve.
2. **Move everything under `<dir>` except `run.json` and `runs/` — a denylist of two, not
   an allowlist of five.** The sidecar directories are created by *drivers following
   prose* (`mkdir -p "<dir>/logs"`), not by the tool, so the set is open by construction:
   `prompts/` exists on this machine in exactly one project because one driver invented it
   unprompted, and **bug-31 is open and will add `prompts/<id>-fix-<n>.txt` to SKILL.md
   §7 as the documented way findings reach a fix session.** An allowlist minted today
   would silently drop it — which is precisely the evidence loss this item exists to
   close. `runs/` is already off limits to drivers by SKILL.md §2's "stay out of
   `<dir>/runs/`", so excluding it is enforcing a rule that already exists rather than
   inventing one.
3. **Nothing inside the archived run file is rewritten, and no new field records where the
   evidence went.** SKILL.md §7 does put an absolute `report at <dir>/reviews/<id>-2.md`
   into a `fix-exhausted` attention detail, but `attention[].detail` is free text rendered
   verbatim (`RunDrawer.tsx:555`, `RunDetail.tsx:828`) and parsed by nothing; a regex
   sweep over it would risk mangling verification tails that happen to contain similar
   text, for no consumer's benefit. The location is instead **derived from the filename**:
   `runs/<stem>.json` and `runs/<stem>/` are siblings minted from one stem by one
   function. That is the same posture as "Groomed is derived", "Board-versus-Archive is
   derived" and "`exhausted` is DERIVED" — a stored `sidecarDir` would be a second copy of
   a fact the archive path already carries.

### Non-goals

- The sidecar-serving endpoint and any Runs-view rendering of a report (decision 1).
- **Orphaned sidecars, when `run.json` is absent but flat sidecars are present.** `init`
  archives inside `if (existing)`; with no run file there is no run to name, so nothing
  moves and those files can still be overwritten. Deliberate: inventing a name
  (`runs/orphan-<newRunId>/`) would file evidence under a run id that never produced it,
  and the run that left them left no record of itself either. State it in the invariant
  rather than paper over it.
- Any change to what a *live* run writes, or to any `<dir>/logs|reviews|verify|questions`
  path in SKILL.md §3–§9. The whole point of archiving at `init` rather than at `finish`
  is that the run loop is untouched.

## Plan

### 1. `skills/backlog-orchestrate/tools/orchestrate.mjs` — one stem, one mover

**1a. Replace `archivePath` with `archiveStem(archiveDir, runId)`** (currently at ~line
251, called once from `cmdInit`). It returns the bare stem, not a path; the caller joins
`.json` onto it for the run file and joins it bare for the sidecar directory. Same
collision loop as today — bump to `<runId>-2`, `-3`, … while `<stem>.json` exists — for the
same documented reason (second-precision run ids, `finish` then `init` inside one wall
clock second). Returning the stem rather than the path is what keeps "which name is free"
in one function while two artefacts now need that answer; deriving the directory name by
stripping `.json` off a returned path at the call site would be a second, weaker copy of
the same rule.

Keep the collision check on `<stem>.json` **alone** — deliberately not "`<stem>.json` or
`<stem>/` is free". The only way to reach a free `.json` beside an existing directory is an
archive interrupted between step 1c's two moves, and in that state reusing the stem is the
*repair* (see 1c). Widening the check would instead split one run's evidence across
`<stem>/` and `<stem>-2.json` permanently. Say that in the comment.

Export it, so the collision case can be unit-tested directly rather than by racing two
inits into the same second — the test file already imports from this module (`RUN_STALE_MS`,
`pauseRequestEffective`, …), so this adds no new coupling.

**1b. Add `archiveSidecars(dir, destDir)`.** Reads `<dir>` with `withFileTypes: true`,
skips exactly `run.json` and `runs`, and `fs.renameSync`es every remaining entry into
`destDir`. Rules it must follow, each of which is a case a reviewer should be able to point
at:

- **Create `destDir` only if there is at least one entry to move.** An unconditional
  `mkdirSync` would litter an empty `runs/<stem>/` on every init and break the existing
  `assert.deepEqual(archived, ['<runId>.json'])` cases in the suite — which are right to
  fail on it: an empty directory claims evidence exists.
- **Best-effort, never fatal.** Each rename in its own `try`; on failure warn to stderr,
  naming the entry, and continue. `init`'s contract is that a bad call writes nothing and a
  good call ends with a valid `run.json`; failing the whole command over evidence
  bookkeeping would trade a real run for a filing error. The unreadable-`<dir>` case
  returns early the same way.
- **A name already present in `destDir` is skipped with a stderr warning, never
  overwritten.** `renameSync` onto an existing directory is an error on some platforms and
  a silent replace of an empty one on others; neither is a thing to do to archived
  evidence. Reachable only through the interrupted-archive path below.
- **Transient files count as entries.** `.run.json.<pid>.<rand>.tmp` left by a crashed
  `writeRunAtomic` is moved like anything else. Harmless, and one fewer special case than
  filtering it out.

**1c. Rewire `cmdInit`'s archive block** (currently ~line 1586). Today:

```
if (existing) { mkdir runs/; rename run.json -> runs/<runId>.json }
```

New order, and the order is the design: resolve the stem, **move the sidecars first**, then
rename `run.json` last. A crash between the two leaves the sidecars under `runs/<stem>/`
with `run.json` still flat and still `done` — and the next `init` resolves the *same* stem
(1a checks the `.json`, which is still free), merges whatever sidecars remain into the
directory that already exists, and completes the rename. Fully self-repairing. The other
order is not: renaming `run.json` first and crashing leaves `existing === null` on the next
init, so the `if (existing)` block never runs, and the sidecars are overwritten by the very
run that was supposed to preserve them.

Everything stays inside the existing `if (existing)` guard, and everything stays *after*
`buildGatedQueue` — the validate-before-mutate ordering that comment at ~line 1472 defends
is unchanged and must stay that way: a bad `--ids` must still touch nothing.

### 2. `server/src/orchestrator/orchestrator.service.ts` — two readers must stop counting directories

`runs/` gains non-`.json` entries for the first time. Both readers of that listing are
wrong the moment it does, and both are user-visible, so this is part of the same change,
not a follow-up:

- `countPastRuns` (~line 120) returns `readdirSync(runsDir).length`. Each archived run
  would now contribute a file *and* a directory, so `RunDrawer.tsx:348` starts printing
  "4 past runs" for two.
- `archive()` (~line 386) reads every entry and hands it to `readOneRun`, which
  `readFileSync`s it — `EISDIR` on a directory — and warns
  `runs/<runId> for "…" is unreadable or not valid JSON, skipping` once per archived run
  per request, on a route the Runs view fetches on mount and focus.

Fix both with **one** helper — `archivedRunFiles(runsDir): string[]`, `readdirSync` filtered
to `.endsWith('.json')`, `[]` on any throw — and have `countPastRuns` become its `.length`
and `archive()` iterate it. One implementation, for the reason `isStale`/`leavesBoard` are
one: two expressions that merely agree are two chances to disagree later. Fold the
"non-`.json` entries under `runs/` are a run's archived sidecars, not runs" reason into its
comment, so the next reader does not "simplify" the filter away.

`archivedRun()` needs no change and should get a one-line comment saying why: it probes the
exact path `runs/<runId>.json`, which a directory named `<runId>` cannot answer to, and
`RUN_ID_RE` is unchanged.

### 3. Prose — three files

- **`skills/backlog-orchestrate/SKILL.md` §2**, the "**Keep `dir`**" paragraph (~line
  259–266). It already ends with "stay out of `<dir>/runs/`". Add, in two sentences: the
  flat subdirectories are always *this* run's, because the next `init` sweeps them into
  `runs/<runId>/` beside that run's archived file — which is where a previous run's
  transcripts, reports and verify output now live. Do not touch any other `<dir>/...` path
  in the file; the run loop is unchanged and a prose edit there is a chance to break it.
- **`skills/backlog-orchestrate/references/recovery.md`.** `--resume` reads the flat paths,
  and this change is what its "starts from what is on disk" promise now rests on: `init`
  refuses any `status: "running"` run with exit `4`, fresh or stale, so a crashed run's
  sidecars — including a live child's `logs/<id>.pid` and `verify/<id>.pid` — can never be
  moved out from under a resume. Say that explicitly; it is the answer to two of idea-8's
  three open questions and the reason moving a pid file is safe at all.
- **`CLAUDE.md` Invariants** — a new bullet, not an extension of the run-file one; this
  rule is about the sidecars. It must carry: the sibling-name convention
  (`runs/<stem>.json` ↔ `runs/<stem>/`, derived, never stored); the denylist-of-two and
  bug-31 as the reason it is not an allowlist; the sidecars-then-run.json ordering and the
  interrupted-archive repair it buys; the exit-`4` lock as what makes moving a live child's
  pid file safe; that the move is best-effort and never fails an `init`; and the orphaned-
  sidecar non-goal. Consider a longer-form entry in `docs/subsystems/invariants.md` if the bullet runs
  past the length of its neighbours.

## Test cases

Tool cases go in `skills/backlog-orchestrate/tools/orchestrate.test.mjs` (node runner,
`pnpm run test:skills`), using the existing `orchFixture`/`run`/`runFile`/`runsDir`
helpers. Server cases go in `test/orchestrator-archive.test.ts` and
`test/orchestrator-runs.test.ts` (jest, `pnpm run test:jest`). `pnpm test` runs both.

Write each so it **fails against the current code first** — several of these pass trivially
today because nothing creates the fixture they inspect, so seed the sidecars before
asserting.

1. **Sidecars move with the run file.** `init`; write `<dir>/logs/bug-1.jsonl` = `"first"`,
   `<dir>/reviews/bug-1-1.md`, `<dir>/verify/bug-1.out`, `<dir>/questions/bug-1.json`;
   `finish --status done`; `init` again. Assert: `runs/<firstRunId>/logs/bug-1.jsonl` reads
   `"first"`; the other three landed under `runs/<firstRunId>/` too; and
   `readdirSync(<dir>).sort()` is exactly `['run.json', 'runs']`.
2. **An invented sidecar name is archived too** (decision 2, bug-31's `prompts/`). Same
   shape, but seed `<dir>/prompts/bug-1-fix-1.txt` and a stray top-level file
   `<dir>/notes.txt`. Assert both are under `runs/<firstRunId>/` and neither remains flat.
   This case is the one that fails against any allowlist implementation.
3. **`runs/` and `run.json` are never swept into the archive.** Two done-then-init cycles,
   sidecars seeded before each. Assert `runs/<secondRunId>/runs` does not exist, no
   `run.json` exists inside either `runs/<runId>/`, and `runs/<firstRunId>.json` is still
   directly under `runs/`.
4. **The whole point: a second run cannot overwrite the first's evidence.** `init`; write
   `<dir>/logs/bug-2.jsonl` = `"first"`; `finish done`; `init`; write
   `<dir>/logs/bug-2.jsonl` = `"second"`; `finish done`; `init`. Assert
   `runs/<run1>/logs/bug-2.jsonl` is `"first"` **and** `runs/<run2>/logs/bug-2.jsonl` is
   `"second"`. Against today's tool the first is gone.
5. **No sidecars means no empty directory.** `init`; `finish done`; `init` with nothing
   seeded. Assert `readdirSync(runsDir)` is exactly `['<firstRunId>.json']` — no
   `<firstRunId>/`.
6. **A refused `init` moves nothing** (idea-8's open questions 2 and 3, pinned). `init`;
   write `<dir>/logs/bug-1.pid` and `<dir>/verify/bug-1.pid`; hand-edit `updatedAt` to
   `Date.now() - RUN_STALE_MS - 60_000` leaving `status: "running"`, exactly as the
   existing stale-lock test at ~line 297 does; `init` again. Assert exit `4`, both pid
   files still at their flat paths, and no `runs/` directory at all.
7. **The collision stem covers both artefacts.** Unit-test the exported `archiveStem`
   against a scratch directory: with `runs/run-20260101-000000.json` present it returns
   `run-20260101-000000-2`; with the directory `runs/run-20260101-000000/` present but no
   such `.json`, it returns the **unsuffixed** `run-20260101-000000` — that second half is
   the interrupted-archive repair, and a "bump if either exists" implementation fails it.
8. **An interrupted archive is repaired, not split.** Simulate the crash window: `init`;
   seed `<dir>/logs/a.jsonl` and `<dir>/reviews/a-1.md`; `finish done`; by hand create
   `runs/<runId>/` and move `<dir>/logs` into it (leaving `run.json` flat and `reviews/`
   flat); `init`. Assert `runs/<runId>.json` now exists, `runs/<runId>/logs/a.jsonl`
   survived untouched, and `runs/<runId>/reviews/a-1.md` joined it — one directory, not a
   `<runId>-2` sibling.
9. **A name collision inside the target is skipped, not overwritten.** Same setup as 8, but
   also recreate a flat `<dir>/logs/` containing a different `a.jsonl` before the second
   `init`. Assert the archived `runs/<runId>/logs/a.jsonl` still holds the *original*
   bytes, `init` still exits `0`, and stderr names the skipped entry.
10. **`pastRuns` counts run files only.** Server, `orchestrator-runs.test.ts`: fixture a
    project with `run.json` (status `running`, fresh `updatedAt`), `runs/run-A.json`, and a
    directory `runs/run-A/` holding a file. Assert the payload entry's `pastRuns` is `1`.
    It is `2` today.
11. **`archive()` ignores the sidecar directory.** Server,
    `orchestrator-archive.test.ts`: same on-disk fixture. Assert the payload holds exactly
    the two runs (current + archived) and that a `console.warn` spy recorded **no** call —
    the no-warning half is the point, since a stray warn per archived run per request is
    the regression.
12. **`GET /api/orchestrator/archive/run` still resolves an archived run** with a sidecar
    directory of the same name sitting beside it. Assert the run is returned, not a 404.
13. **In the browser (playwright MCP tools):** prove the count a user actually reads. Make
    a scratch orchestrator home — `mktemp -d` — holding one project directory keyed
    `encodeURIComponent(<any absolute path>)` with a `run.json` whose `status` is
    `running` and whose `updatedAt` is the current time (so the strip renders it), plus
    `runs/run-20260101-000000.json` and a sibling directory
    `runs/run-20260101-000000/logs/` containing a file. Start the API with
    `BM_ORCH_HOME=<that dir> pnpm run dev` and the client with `pnpm run dev:web`,
    **recording each pid** (`cmd & PID=$!`) — kill only those pids at the end, never by
    pattern. Open `http://127.0.0.1:5177/`, click the run strip's row to open the run
    drawer, and assert the drawer's status line reads `running · 1 past run` (singular).
    Before the fix it reads `2 past runs`.

## Done when

- `pnpm test` passes — **both** runners, jest and node; the tool half of this change is
  only reachable by `test:skills`.
- `pnpm run typecheck` and `pnpm run build` pass.
- Cases 1–9 are in `skills/backlog-orchestrate/tools/orchestrate.test.mjs`, cases 10–12 in
  the two server suites, and each of them was observed failing against the pre-change code
  before the change landed.
- `orchestrate.mjs` exports `archiveStem`; `archivePath` is gone rather than left beside
  it.
- `orchestrator.service.ts` has exactly one implementation of "which entries under `runs/`
  are run files", read by both `countPastRuns` and `archive()`.
- No `<dir>/logs|reviews|verify|questions|prompts` path anywhere in SKILL.md §3–§9 was
  edited — the live run's paths are unchanged.
- SKILL.md §2, `references/recovery.md` and a new `CLAUDE.md` Invariants bullet all say the
  rule, including the denylist reasoning and the exit-`4` lock that makes moving a live
  child's pid file safe.
- Case 13's browser check ran and showed the singular count, and every server process it
  started was killed by its recorded pid.

## Outcome

2026-09-07 — Implemented as planned, all three parts. `archivePath` is gone,
replaced by the exported `archiveStem(archiveDir, runId)` (returns the bare
stem; collision check on `<stem>.json` alone, so an interrupted archive
repairs rather than splits) and the new `archiveSidecars(dir, destDir)`
(denylist of `run.json` + `runs`, `destDir` created only when there is
something to move, best-effort with a stderr warning per failure, an existing
name skipped never overwritten). `cmdInit` moves sidecars first and renames
`run.json` last, inside the existing `if (existing)` guard and still after
`buildGatedQueue`. Server side, `archivedRunFiles(runsDir)` is the one
implementation of "which entries under `runs/` are run files", read by both
`countPastRuns` and `archive()`; `archivedRun()` is unchanged and carries a
comment saying why. Prose landed in SKILL.md §2, `references/recovery.md`,
a new CLAUDE.md Invariants bullet and a long-form `docs/subsystems/invariants.md`
section.

Two things worth recording that the plan did not anticipate:

- **Test cases 3 and 4 hit a real same-second runId collision.** Both drive
  two full init/finish cycles, and `makeRunId` is second-precision, so the
  two runs got the identical id and "run 2's archive" resolved to run 1's
  directory. The tool is right (that is exactly what `archiveStem`'s `-2`
  bump is for); the fixture was wrong. Both cases now wait out the second via
  a `sleepPastRunIdSecond()` helper and assert `notEqual` on the two ids, so
  they talk about two runs rather than one.
- **The worktree had no `node_modules`**, so `pnpm test` failed with
  `sh: jest: command not found` before any test ran. `pnpm install
  --frozen-lockfile` fixed it; nothing in the change is responsible.

Verification — `pnpm test` (both runners), `pnpm run typecheck`,
`pnpm run build`, all on the final tree:

```
Test Suites: 80 passed, 80 total
Tests:       1535 passed, 1535 total

# tests 450
# pass 450
# fail 0

PASS  jest
PASS  node --test (skills)
exit=0
```

```
$ pnpm run typecheck   ->  typecheck=0
$ pnpm run build       ->  build=0   (✓ built in 1.26s)
```

Case 13, the browser check, ran for real. A scratch `BM_ORCH_HOME` under
`mktemp -d` held one project keyed `encodeURIComponent('/tmp/task31-demo-project')`
with a fresh `running` `run.json`, `runs/run-20260101-000000.json` and the
sibling directory `runs/run-20260101-000000/logs/bug-1.jsonl`. Ports 4322 and
5177 were already held by Docker on this machine, so the API ran on `PORT=4399`
and Vite on `WEB_PORT=5199` — pids recorded at launch (`API_PID=83773`,
`WEB_PID=83776`) and both, plus their two recorded children, killed by pid at
the end; nothing was killed by pattern, and both ports were confirmed free
afterwards. `GET /api/orchestrator/runs` returned `pastRuns: 1`, and clicking
the run strip's row opened the drawer reading:

```
running · 1 past run
```

Singular, off a `runs/` holding one run file and one sidecar directory. Before
the fix it reads `2 past runs`.

Contract sweep: 6 sites updated (`docs/subsystems/invariants.md`,
`docs/superpowers/specs/2026-09-01-orchestration-archive-design.md`,
`shared/types.ts`, `README.md`, `skills/backlog-orchestrate/tools/orchestrate.mjs`,
`skills/backlog-orchestrate/tools/orchestrate.test.mjs`)

The removed identifier was `archivePath` (2 stale pointers outside the diff,
both repointed at `archiveStem`); the changed rule was "`pastRuns` is a plain
directory-listing count over `runs/`", which is now a listing filtered to
`.json` (4 sites restated). Two categories were deliberately left standing:
the dated design records under `docs/superpowers/plans/` and
`docs/superpowers/specs/*-design.md` that describe `pastRuns` as a dir-entry
count (`2026-08-31-backlog-orchestrate.md:133,260`,
`2026-09-01-orchestration-archive.md`, the archive design doc's body) — those
are records of what was decided on their date, not live contracts, and the one
edit made to that folder was a bare function-name pointer that would otherwise
resolve to nothing; and this item file's own Plan section, which quotes
`archivePath` because that is what the plan was written against.

Red proof: 8 tests went red with the change reverted

Run in three passes so each revert isolates one production change rather than
masking the others:

- Removing only the `archiveSidecars(...)` call from `cmdInit` (leaving
  `archiveStem` in place): 5 red — sidecars move, invented sidecar names,
  second run cannot overwrite, interrupted archive repaired, name collision
  skipped.
- Un-exporting `archiveStem`: 1 red — the `archiveStem` unit case, via
  `SyntaxError: The requested module './orchestrate.mjs' does not provide an
  export named 'archiveStem'`.
- Reverting `archivedRunFiles`' `.json` filter to a bare `readdirSync`:
  2 red — `pastRuns` counts run files only, and `archive()` ignores the
  sidecar directory silently.

Four of the twelve new cases cannot go red against the pre-change code and are
guards rather than proofs, which is deliberate and stated here rather than
left for a reviewer to notice: `runs/` and `run.json` are never swept, no
sidecars means no empty directory, and a refused `init` (exit 4) moves
nothing all pass trivially when nothing sweeps at all — they exist to fail if
a future edit widens the denylist, litters an empty directory, or moves the
archive outside the lock. The twelfth, `GET /api/orchestrator/archive/run`
still resolving an archived run beside a same-named directory, passes today
because `archivedRun()` correctly needed no change; the plan predicted exactly
that, and the case pins the reasoning.
