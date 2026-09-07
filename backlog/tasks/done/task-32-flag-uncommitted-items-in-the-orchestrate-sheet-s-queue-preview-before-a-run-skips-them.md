---
id: task-32
title: Flag uncommitted items in the Orchestrate sheet's queue preview before a run skips them
created: 2026-09-07
from: idea-9
updated: 2026-09-07T08:54:59Z
started: 2026-09-07T08:10:53Z
execute-elapsed: 2646
execute-tokens: 224718
---

## Goal

The Orchestrate sheet's step 1 previews the queue from the board's item scan, which
reads the **working tree**. The run that follows gates each item at `<base>` — `main`,
`BASE_REF_DEFAULT` in `orchestrate.mjs`, and the board never passes `--base`, so `main`
is the ref for every board-started run there will ever be. The two disagree exactly
when an item was groomed and not committed, and then the sheet shows a ready bug, the
run's verdict is `not committed on main — the worktree this run creates from main would
not contain <path>`, and the item is skipped after the person has walked away. Five such
skips across three projects in the 2026-09-06 sweep (bug-12 twice here, bug-13 and bug-7
in claude-agents-dashboard, bug-16 in ixray).

Close that gap on the launch surface: the sheet marks the rows the run will not be able
to see, in the run's own words, and offers to deselect them — while leaving the run's own
gate the only authority and leaving an untouched sheet's request byte-identical to what
it sends today.

task-29 is the other half, said at groom time by the skill that creates the state. This
one is for the person who groomed yesterday and is launching today.

## Decisions

The idea carried three open questions. All three are answered here; an implementer may
disagree with any of them, but must say so rather than quietly changing course.

1. **Not memoised, and it must not join the `lastCommit` memo.** That memo
   (`server/src/items/git-dates.util.ts`) is keyed on the mtimes of `index` and
   `logs/HEAD` — the files git rewrites when the answer to *its* question can change.
   Editing an item file in the working tree, which is the exact event this feature
   reports, moves neither. A memo on that key would serve "clean" forever after its
   first hit, i.e. it would reintroduce the false negative the feature exists to remove.
   The cost is affordable without one: measured 2026-09-07 over the five projects in
   this machine's registry, both spawns together took 50–270ms per project, and this
   runs for **one** project **once per sheet open**, never on the board's poll path.
2. **The question is "does the working copy differ from `main`", not "differs from
   `HEAD`".** `git status --porcelain` — the idea's own suggestion — compares against
   `HEAD`, which is the wrong ref whenever the main tree is not sitting on `main`, and
   an item committed on a branch but absent from `main` is precisely one of the cases
   that gets skipped. Comparing against `main` also covers the sibling case the gate's
   own comment describes: an item committed while ungroomed and groomed only in the
   working copy is *present* at `main`, so it never earns the "not committed" reason —
   the run gates the stale bytes and reports plain `ungroomed`. Diffing against `main`
   catches both with one question.
3. **No chip on the Board card, and nothing derived reads this.** It is a launch-time
   fact about a ref, not a lifecycle state: `isStale`/`leavesBoard`/`lastTouched`/
   `deriveGroomed` are all untouched, and the flag reaches no persisted setting and no
   run file. The sheet is the only place missing it costs a run slot, which is the
   idea's own reasoning; a chip on every card would also fire during ordinary grooming,
   when it is not news.

Two more decisions the idea's rough shape did not anticipate, both departures from it:

4. **A sibling endpoint, not a `BacklogItem` field.** A field would put an
   un-memoisable git read inside `scanProject`, which runs for **every** registered
   project on both `/api/items` and `/api/projects`, both of which the board fetches on
   mount and focus — paying five projects' git cost to answer a question about one, at a
   cadence nothing needs. It would also make a new required field ripple through
   `BacklogItem`'s constructors and fixtures. `GET /api/agents/merge-check` is the exact
   precedent: a read-only local answer the same sheet already fetches on open and already
   degrades silently.
5. **The default selection is NOT changed.** The idea asked for uncommitted rows to be
   excluded from it; that is refused, and replaced with an explicit control. `selected
   === null` is load-bearing — it is the difference between "drain the queue" and "run
   exactly these ids", and an auto-exclusion would force an explicit `ids` list into
   every launch, freezing the queue snapshot (an item committed while the sheet sat open
   would be dropped from a run the person believes is draining everything) and having the
   board overrule the orchestrator's own gate on the strength of a preview that says
   outright it is not authoritative — the same reasoning `emptySelection`'s comment
   already gives for not refusing an empty queue. It also buys almost nothing: the run
   skips these items at the cost of a gate verdict, with no dispatch and no worktree.
   So: mark them, say so in the run's words, and add a `deselect uncommitted (N)` button
   that narrows the selection the same way unticking rows by hand does — the person's
   act, not the sheet's.

## Plan

### 1. `server/src/items/uncommitted.util.ts` (new)

Exports the base ref as a named constant and one pure-ish read:

```ts
export const UNCOMMITTED_BASE_REF = 'main';
export interface UncommittedItems { paths: string[]; known: boolean }
export function uncommittedItemPaths(projectPath: string): UncommittedItems
```

Steps, in order, every failure degrading to `{ paths: [], known: false }` and **never**
throwing (an unreadable repo must not 500 a launch surface):

1. `git -C <projectPath> rev-parse --show-toplevel`; `realpathSync` both sides and
   compare. Not the toplevel → `known: false`. This **mirrors `blobReaderAt`'s own
   precondition** (`orchestrate.mjs`): when the project root is not the repo root the
   tool has no blob view and gates the working copy, so there is no divergence to warn
   about and a chip would be a false positive.
2. `git -C <projectPath> rev-parse --verify --quiet main^{commit}`. Unresolvable →
   `known: false`, for the same reason at the same seam: no base ref, no blob view,
   working copy gated.
3. `git -C <projectPath> -c core.quotePath=false diff --name-only --no-renames main --
   backlog` — tracked files whose working-tree content differs from `main`.
4. `git -C <projectPath> -c core.quotePath=false ls-files --others --exclude-standard --
   backlog` — files git has never tracked. **Both reads are required**: `diff` does not
   list untracked files, and a brand-new never-committed item file is untracked. Verified
   against this machine on 2026-09-07 — in `ixray`, step 3 printed nothing and step 4
   printed `backlog/bugs/open/bug-16-…md`, which is one of the five items the sweep
   recorded as skipped.
5. Union the two, deduped, and map each relative POSIX path to an absolute one with
   `join(projectPath, ...rel.split('/'))` — built from `project.path` verbatim, the same
   construction `scanProject` uses for `BacklogItem.path`, so the two strings compare
   equal without either side calling `realpath`.

`-c core.quotePath=false` on both spawns for `lastCommitDates`' reason: the default
octal-escapes non-ASCII filenames. Spawn options copied from that module's own `run` —
`timeout: 5000`, a bounded `maxBuffer`, `stdio: ['ignore', 'pipe', 'ignore']` — because
this also runs synchronously inside a request. Carry a file header comment stating
Decision 1 (no memo, and why the neighbouring memo's key is wrong here) and Decision 2
(why `main`, not `HEAD`): both are things a later reader will otherwise "fix".

### 2. `server/src/items/items.service.ts`

Add `uncommitted(project: string): UncommittedItems`, gated exactly like
`AgentsService.mergeCheck`: find the entry by **raw string compare** against the
registry's own `path` field — deliberately not `realpath`, matching the rule CLAUDE.md
pins on `dispatchGate`'s membership check — and throw `HttpException 404` when there is
no such entry, **before** anything touches the filesystem.

### 3. `server/src/items/items.controller.ts`

`@Get('items/uncommitted')`, taking `@Query('project')`. Trim; blank or absent → 400
`{ error: 'project is required' }`. No guard, for the reason `merge-check`'s controller
comment gives verbatim: `SameOriginPostGuard` answers "may this caller POST at all", and
this route starts nothing and reads no caller-supplied path — it discloses strictly less
than `/api/projects` already does to any same-origin reader.

### 4. `client/src/lib/agents.ts`

`fetchUncommitted(project)`, beside `fetchMergeCheck` and modelled on it: the client-side
`UncommittedItems` interface declared here rather than promoted to `shared/types.ts` (the
same call `MergeCheckResult` already makes — promotion waits for a second consumer), a
shape guard, and a **throw** on a malformed 200 so the caller's `.catch` is the single
place a missing answer is handled. The guard is not optional here for the identical
reason it was added to `isMergeCheckResult`: this response feeds a render that asserts a
fact about someone's repo, and a 200 whose body lacks `paths` must read as "no answer",
never as "nothing is uncommitted". The endpoint is not under `/api/agents`; the module is
still the right home — it is the board's same-origin fetch layer, it already owns
`unwrap`/`ApiError`, and it already holds this same sheet's other on-open read.

### 5. `client/src/components/board/OrchestrateSheet.tsx`

- One `useState<UncommittedItems | null>(null)` and one effect, copying the
  `mergeCoverage` effect's shape exactly — `alive` guard, silent `.catch(() =>
  setUncommitted(null))`. Keyed on `[project]` **only**: fetched once per sheet open,
  never re-fetched when a mode or a step changes.
- Derive `uncommittedPaths = new Set(uncommitted?.known ? uncommitted.paths : [])` and
  `uncommittedIds = queue.filter(({ item }) => uncommittedPaths.has(item.path)).map(…id)`.
  Matching on `item.path` rather than an id parsed out of a filename keeps a single
  identity rule — the server's `id` comes from frontmatter, and deriving one from a
  filename would be a second one.
- Row chip: `<span className="orchestrate-preview-flag">uncommitted</span>` beside the
  existing action label, for rows in the set. The checkbox stays enabled and the row stays
  in the list, for the reason the file already gives for ungroomed rows: the run really
  will queue it, gate it and report it.
- Step 1 note gains one line when `uncommittedIds.length > 0`, quoting the run's own
  verdict so the two surfaces share words — e.g. `N item(s) groomed on disk only: the run
  reads them at main, so its gate will report "not committed on main" and skip them.` The
  literal `not committed on main` is the shared string; `Groomed on disk only` is
  task-29's, and using both is deliberate.
- `deselect uncommitted (N)` button in the existing `orchestrate-select-actions` row,
  rendered only when `uncommittedIds.length > 0`. It sets `selected` to `new Set(selectedIds
  minus uncommittedIds)` — starting from `selected ?? queueIds`, the same "the first tick
  starts from everything" step `toggle` already takes. Nothing else about selection
  changes: `selected` stays `null` until a person acts (Decision 5).
- Step 2's rows are deliberately left alone; the chip is a step 1 fact. Say so in a
  comment so the omission reads as a decision.

### 6. `client/src/styles.css`

`.orchestrate-preview-flag` beside `.orchestrate-preview-action` — a warning-toned chip,
readable in all five theme palettes (`shared/theme.css` variables only, no literal
colours).

### 7. Docs

- **CLAUDE.md Invariants**: a new entry for "the sheet's uncommitted flag is read from
  git per request and is never memoised", carrying Decisions 1, 2 and 4 in short form,
  plus the long version in `docs/invariants.md`. Decision 1 is the one that has to be
  written down: the neighbouring memo is a visible, apparently-identical optimisation
  whose key is exactly wrong for this question.
- **CLAUDE.md Layout**: `GET /api/items/uncommitted` on the `items/` line, and the sheet's
  chip / hint / deselect control on the `OrchestrateSheet` description.
- **README**: the endpoint in the `server/src/items/` paragraph (line ~218), which lists
  the full HTTP surface.

## Test cases

Jest, flat in `test/`, matching the two existing precedents:
`test/git-dates.test.ts` for the real-git fixtures (`git init -q`, local `user.email`/
`user.name`, `commit.gpgsign false`) and `test/merge-check.test.ts` for the
registry-gating cases. The fixture must **create or rename its branch to `main`
explicitly** — `git init`'s default branch name is machine configuration, and one case
below depends on `main` being genuinely absent.

**`test/uncommitted.test.ts` (new) — `uncommittedItemPaths`**

1. Item committed on `main`, working tree untouched → `{ paths: [], known: true }`.
2. Item committed on `main` and then edited in the working tree → its absolute path is
   the only entry; `known: true`.
3. **Item that exists on disk and was never committed at all** → its absolute path is
   returned. Prove this case can fail: with step 4 of the util (`ls-files --others`)
   removed, this test must go red while cases 1, 2 and 4 stay green. That is the
   asymmetry the whole two-read design rests on, and it is the case a `git diff`-only
   implementation silently loses.
4. Item committed on a branch that `main` does not contain, with that branch checked out
   → returned. Pins Decision 2; a `git status --porcelain` implementation reports this
   file as clean.
5. Item whose content is identical to `main` but which is staged (`git add`, no commit)
   → **not** returned. `diff main` compares the working tree, and a staged-identical file
   is byte-identical to what the worktree will hold.
6. `projectPath` is a subdirectory of the repo, not its toplevel →
   `{ paths: [], known: false }`. Mirrors `blobReaderAt`.
7. Repo has no `main` ref (branch named `master`) → `{ paths: [], known: false }`.
8. `projectPath` is not inside any git repo → `{ paths: [], known: false }`, no throw.
9. Non-ASCII item filename → returned as raw UTF-8, not octal-escaped.
10. **No caching**: call, edit a committed item file, call again → the second call
    reports the file and the first does not. Guards Decision 1 against a future memo.
11. An item outside `backlog/` that is uncommitted (a dirty `README.md`) → not returned;
    the pathspec is scoped.

**`test/uncommitted-route.test.ts` (new, or appended to the file above) — the route**

12. Registered project → 200 with `{ paths, known }`.
13. Unregistered project path → 404, and **no filesystem touch**: assert the ordering the
    way `test/merge-check.test.ts`'s unregistered case does, so "gate first" is the
    guarantee rather than "eventually degrades".
14. Absent or blank `project` → 400.
15. `test/vite-proxy.test.ts` stays green unchanged — the route is under `/api`.

**`test/orchestrate-uncommitted.test.tsx` (new, jsdom docblock) — the sheet**

16. Payload naming one queue row's path → that row renders the `uncommitted` chip and the
    other rows do not.
17. The step 1 note contains the count and the literal `not committed on main`.
18. **An untouched sheet's request is unchanged**: with an uncommitted row present, press
    through to Start without touching anything → the posted body has **no `ids` key** at
    all. This is Decision 5's pin, and it must be an assertion about the absent key, not
    about its value.
19. `deselect uncommitted` → the posted `ids` are exactly the committed queue ids, in
    queue order; the uncommitted row's checkbox reads unchecked; `select all` restores the
    no-`ids` request.
20. Every row uncommitted, then `deselect uncommitted` → `emptySelection` refuses `next`
    with the existing wording; no new empty-selection path is introduced.
21. `{ paths: [...], known: false }` → no chip, no hint. Pins that `known` gates the
    render rather than being a decorative field.
22. Fetch rejects (500, network error) → no chip, no hint, no error banner, and Start
    still works. Same posture as the merge-check hint.
23. Malformed 200 (body missing `paths`) → treated identically to case 22, via the shape
    guard rather than a render-time `?.`.
24. Exactly one fetch per sheet open: flip the merge-mode picker and step forward and
    back, and assert the `/api/items/uncommitted` fetch count is still 1.
25. `test/orchestrator-start-ui.test.tsx` stays green — whatever stub it needs for the
    new fetch must return a well-formed payload, not a catch-all (the trap review round 1
    of the merge-check hint already caught once).

**Mirror test (append to `test/agents-shared.test.ts` or its own file)**

26. `UNCOMMITTED_BASE_REF` equals the `BASE_REF_DEFAULT` value read out of
    `skills/backlog-orchestrate/tools/orchestrate.mjs`'s **source** (regex over the file,
    the way `test/server-bind.test.ts` reads `main.ts`). Two copies of `'main'` in two
    languages is the drift this pins; the `.mjs` tool is not importable into the Nest
    build.

**Browser check**

27. `In the browser (playwright MCP tools):` prove the chip and the hint render against a
    real project, using a throwaway repo so no real item is dirtied:
    1. `mkdir` a temp directory, `git init -q`, set `user.email`/`user.name`/
       `commit.gpgsign false`, and `git branch -m main` (or `git checkout -b main`).
    2. From inside it, `node <plugin root>/skills/backlog/tools/backlog.mjs init` to
       scaffold and register the store, then `… new tasks "temp probe"` and fill its
       `## Plan` with a real sentence so it gates as groomed.
    3. `git add -A && git commit -q -m store` — the task is now committed on `main`, so
       the sheet must NOT flag it.
    4. Start the API and the client (`pnpm run dev` and `pnpm run dev:web`, recording
       each pid; kill by that pid at the end, never by pattern).
    5. Open `http://127.0.0.1:5177`, filter the board to the temp project, press
       `Orchestrate`. Expect step 1 to list the task with **no** `uncommitted` chip and
       no hint line.
    6. Append a line to the task file (still committed content plus one working-tree edit),
       reload, reopen the sheet. Expect the `uncommitted` chip on that row, the hint line
       containing `not committed on main`, and a `deselect uncommitted (1)` button.
    7. Press `deselect uncommitted` and screenshot: the row's checkbox unchecked,
       `0 of 1 selected`, and the existing `pick at least one item` note. Do **not** press
       Start.
    8. Teardown: `backlog.mjs unregister` for the temp project (the registry's one removal
       path), kill the two recorded pids, `rm -rf` the temp directory.

**Suite**

28. `pnpm test` (both runners), `pnpm run typecheck` and `pnpm run build` green. No skill
    or tool file changes, so `pnpm run test:skills` should be untouched except for case 26
    if it is placed in a node-runner file.

## Done when

- `GET /api/items/uncommitted?project=<registered path>` answers `{ paths, known }`,
  degrades to `known: false` for every git failure, 404s an unregistered project before
  touching disk, and caches nothing.
- The Orchestrate sheet's step 1 marks uncommitted rows with a chip, states the count in
  the run's own words, and offers `deselect uncommitted (N)`.
- An untouched sheet still posts no `ids`, pinned by test case 18.
- Nothing derived — `isStale`, `leavesBoard`, `lastTouched`, `deriveGroomed`,
  `runClaimBlock` — reads the new flag, and no Board card renders it.
- `pnpm test`, `pnpm run typecheck` and `pnpm run build` all green.
- CLAUDE.md (Invariants + Layout), `docs/invariants.md` and README describe the endpoint
  and the no-memo rule.
- The next cross-run sweep can attribute any remaining "not committed on main" verdict to
  a run started outside the board, not to a launch surface that failed to say so.

## Outcome

2026-09-07 — done as planned. `GET /api/items/uncommitted` answers `{ paths, known }`
from two git reads against `main`, memoised nowhere; the Orchestrate sheet's step 1
chips the flagged rows, states the count in the run's own words and offers
`deselect uncommitted (N)`; no default selection changed and an untouched sheet still
posts no `ids`.

Files: `server/src/items/uncommitted.util.ts` (new), `items.service.ts`,
`items.controller.ts`, `client/src/lib/agents.ts`,
`client/src/components/board/OrchestrateSheet.tsx`, `client/src/styles.css`,
`test/uncommitted.test.ts` (new), `test/orchestrate-uncommitted.test.tsx` (new),
`test/orchestrator-start-ui.test.tsx` (stubs), CLAUDE.md, docs/invariants.md, README.md.

All five Decisions implemented as written; no course changed. Three departures from the
plan's letter, none from its intent:

1. **Plan case 7 (no `main` ref) is an outcome pin, not a red proof of the
   `rev-parse --verify main` precondition.** With that precondition deleted, `diff main`
   and `ls-files` both fail against a repo with no `main`, the util's own "either read
   failed" clause catches it, and the case stays green. The precondition still earns its
   place (it mirrors `blobReaderAt`'s own seam, and costs one cheap spawn instead of two
   doomed ones), but neither reason is observable from outside. Said so in the test.
2. **Plan case 6's fixture was strengthened.** As specified — a subdirectory with an
   uncommitted item and no commits at all — it passed with the toplevel check removed,
   for the wrong reason (no `main`, so both reads failed anyway). It now commits an
   anchor on `main` first, so the naive implementation really does report a path and the
   check is what turns that into `known: false`.
3. **Plan case 13's spy moved from `realpathSync` to `execFileSync`, and plan case 23
   gained a sibling.** `uncommittedItemPaths` spawns FIRST and only calls `realpathSync`
   on that spawn's success, so a realpath spy stayed green with the registry gate moved
   after the util — while the server shelled out to git about an arbitrary
   caller-supplied path. Same shape for the shape guard: a 200 with no `paths` key is
   also absorbed by the render's own `known === true` gate, so case 23 pins the outcome
   and new **case 23b** (`paths: 5`, which reaches `new Set(...)` and throws) is the
   guard's actual red proof.

Deliberately not done: **the browser check (plan case 27)**, and not because it does not
matter. It needs the API on 4322 and Vite on 5177 — both almost certainly held by the
live app that started this very run, since a board click is what spawns an orchestrator
session — and it needs a throwaway project registered into the real
`~/.backlog-manager/registry.json`, i.e. a write to shared machine state that this
user's live board would render mid-run, with a teardown whose failure mode is precisely
bug-17's phantom entry. In an unattended session with nobody to confirm either, that
trade is wrong. What it would have covered beyond the suites: the visual layer alone —
the route itself is exercised over real HTTP against a real git repo by cases 12-14, and
the chip/note/button by 16-24. In its place: `.orchestrate-preview-flag` was verified
present in the built CSS (`client/dist/assets/index-*.css`) and to reference only
`--mono`/`--amber`/`--hairline`/`--steel`, all four of which `shared/theme.css` defines
in all five palettes.

One neighbouring site left standing on purpose: `skills/backlog-groom/SKILL.md`'s "This
skill is what creates the uncommitted state, so it is the only place the sentence can be
said at the moment it becomes true." Still true as written — this task is the other half,
said later to a different reader — so it was not edited.

### Verification

`pnpm test` (both runners), `pnpm run typecheck` and `pnpm run build`, on the final tree:

```
Test Suites: 82 passed, 82 total
Tests:       1564 passed, 1564 total

# tests 450
# pass 450
# fail 0

────────────────────────────────────────────────────────────
PASS  jest
PASS  node --test (skills)

pnpm test: both runners passed.

$ tsc --noEmit
(no output)

vite v5.4.21 building for production...
✓ built in 1.26s
```

One earlier `jest` invocation reported `1 failed, 1562 passed` — `bug-33` exactly (a
lone supertest failure that does not reproduce); the same command passed on the next two
runs and `pnpm test` passed every time. Not caused by this diff, which touches no
server code the failing shape involves.

Contract sweep: 2 sites updated (client/src/components/board/OrchestrateSheet.tsx's
header claim that merge-check was "the one genuine exception" to "never a fetch";
test/orchestrator-start-ui.test.tsx, whose `stub`/`stubOrchestrate` catch-alls answered
the new endpoint with `/api/items`' shape and whose branch-mode case asserted
`not.toHaveBeenCalled()` on fetch outright)
Red proof: 13 production reverts run one at a time, each against the one suite it
affects: dropping `ls-files --others` reddened case 3 with 1/2/4 green; the toplevel
check → 6; `core.quotePath=false` → 9; `UNCOMMITTED_BASE_REF` → 'master' → 26 (+10);
a `lastCommitDates`-style memo → 10; the `-- backlog` pathspec → 11; the registry gate
moved after the util → 13; the blank-project 400 → 14; the `known` gate → 21; the shape
guard → 23b; the row chip → 16; the step 1 note → 17; the deselect button → 19/19b/20;
auto-excluding flagged rows by default → 18; `[project, mergeMode, step]` deps → 24;
the silent `.catch` → 22/23/23b; unscoping `uncommittedIds` from the queue → the
non-queued-path case. Every added test has a proof except case 7 (see departure 1) and
case 23 (see departure 3).
