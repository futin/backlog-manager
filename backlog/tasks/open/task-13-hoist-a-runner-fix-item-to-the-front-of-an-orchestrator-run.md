---
id: task-13
title: Hoist a runner-fix item to the front of an orchestrator run
created: 2026-09-04
from: idea-5
updated: 2026-09-05T11:09:39Z
groom-elapsed: 75
groom-tokens: 12757
---

## Goal

An item that repairs the machinery a run depends on — `backlog-orchestrate`'s own
SKILL.md, its CLI, the reviewer agent, the dispatch route — runs **first** in that run,
instead of sitting three items deep behind the very items it unblocks. Today ordering is
bugs-then-tasks oldest-first, overridden only by an explicit `--ids` list, and that
ordering cannot see the one property that matters here: *this item repairs the thing that
is about to execute the rest of the queue* (idea-5 records the run where it bit —
`run-20260901-112035` queued the permission-flag fix as item 3 of 5, and item 1's very
first dispatch was refused by exactly the flag item 3 exists to replace).

Two halves, and the second is the one idea-5 left open:

1. **Order.** A human marks the item; `buildGatedQueue` hoists it; `plan` shows that it
   did. Marking is a judgement, hoisting is mechanical.
2. **Effect.** A merged fix does **not** reach a run in flight on its own. Every skill
   body and every `orchestrate.mjs` invocation in a run resolves through
   `$CLAUDE_PLUGIN_ROOT` — the *installed plugin copy* — while the merge lands in this
   repo's `main`. So hoisting alone would buy nothing but ordering; the run has to be
   told, once, to follow the repo's copy for the remainder of the run. That is why the
   observed incident was recovered by a human retyping the dispatch flag by hand.

Non-goals: no client change (see `## Plan` step 6 for why the board needs none), no run
file schema change, no path heuristic.

## Plan

Written as behaviour and exact expected values, deliberately **not** as literal code —
`## Test cases` below is the authoritative half; treat any code shape implied here as
illustrative and disagree with it if the file reads otherwise.

### 1. The marker: a `runner-fix:` frontmatter key on a bug or task

Meaning: *executing this item repairs machinery a run depends on*. A judgement call, so a
human writes it — there is no path heuristic anywhere in this task. idea-5 lists the
mechanical option (`## Affects` or `## Fix` naming `skills/`, `agents/`,
`server/src/agents/`) and it is rejected on its own terms: most `skills/` edits do not
affect a running orchestrator, and a dispatch-route fix that does affect one need not name
any of those paths.

- Nothing in `skills/backlog/tools/backlog.mjs` changes. It already round-trips unknown
  frontmatter keys byte-for-byte (the same way `kind:` rides on a refactor), so the key
  costs the registry's single writer nothing and survives every `start`/`stop`.
- **Presence hoists; only the literal `false` opts out.** `runner-fix: true`,
  `runner-fix: yes`, and a bare `runner-fix:` all hoist. This is deliberate: a key that
  hoisted on `true` alone would let `runner-fix: yes` silently not hoist, which is the
  exact failure class this item exists to remove — a queue in the wrong order with nobody
  told. `false` is honoured because "considered, and it is not a runner fix" is a thing
  worth being able to write down.
- Keep the key name hyphenated (`runner-fix`), matching `promoted-to:` rather than
  camel-casing.

### 2. Read the marker off the same bytes the gate reads

`parseItemForGate` (`skills/backlog-orchestrate/tools/orchestrate.mjs`) currently returns
`{ title, body }`, pulling `title` out of the frontmatter fence with its own narrow
`key:` splitter. Extend that **one** function to also return the marker, so both callers
inherit it and cannot drift:

- `readItemForGate` (working copy) and the `git show <base>:<path>` blob path both funnel
  through `parseItemForGate`, so an item's marker is read from whatever bytes its gate
  verdict was read from. Consequence, and it is the intended one: a `runner-fix:` present
  only in the working copy does **not** reorder the run — identical rule to the gate's
  own, for the identical reason (the worktree this run creates from `<base>` would not
  contain it).
- The `committed === null` branch (item absent from `<base>`) must report **not hoisted**.
  That branch reads its `title` off the working copy because that is the only copy that
  exists; the marker must not follow it there. An item the run cannot see the content of
  is not an item whose frontmatter gets to reorder the queue.
- No git view at all (`readBlob === null`) falls back to the working copy, exactly as
  every other verdict in that function already does.

### 3. Hoist inside `buildGatedQueue`, before `--max` is counted

After `ordered` is resolved (either the default bugs-then-tasks walk or the `--ids`
sequence) and before the `readyCount`/`beyondMax` map, partition it into
`[…hoisted, …rest]` with a **stable** partition — every item keeps its relative position
inside its own half. So:

- Default ordering: hoisted items first, still bugs-before-tasks and oldest-first among
  themselves; then everything else in the order it already had.
- `--max N`: the cap is counted over the hoisted order, which is the point. A runner fix
  that was going to fall outside the cap now lands inside it.
- The gate is untouched. Membership and verdicts are decided exactly as before; this step
  only reorders. An **ungroomed** flagged item therefore hoists too, appears first in the
  preview labelled `ungroomed`, and is skipped at pre-flight like any other ungroomed
  item — "the thing that would fix your runner is not groomed" is information, printed at
  the top where it will be read.

**`--ids` is hoisted too, and that is a deliberate narrowing of a documented contract.**
§1 of SKILL.md currently promises `--ids a,b,c` runs "in the order given"; after this
change it runs in the order given *after* any runner-fix item is hoisted. The reason is
the board: `OrchestrateSheet` sends `ids` for any strict subset of its checkbox list, so
that list is a **selection**, not an ordering — nobody chose the order it arrives in.
Exempting `--ids` would defeat the hoist on the one surface CLAUDE.md tells you to start
runs from. It also makes the client change unnecessary (step 6).

### 4. `plan` shows that it hoisted

`cmdPlan` prints one line per item today, `gate.padEnd(13) id  title` plus a
`  (beyond --max)` suffix.

- Human-readable: add a suffix naming the hoist on a hoisted row. Both suffixes may
  appear on one row (`--max 0` puts even the hoisted item beyond the cap) — that is fine,
  they concatenate.
- `--json`: add a boolean per row for whether the item was hoisted. Additive only —
  SKILL.md §3's per-item `plan --ids <id> --json` reads `gate`/`reasons`/`questions` and
  is unaffected.
- `plan`'s "writes nothing at all" guarantee is unchanged: no new git call, no new file
  read beyond the frontmatter already being parsed.

### 5. SKILL.md — `skills/backlog-orchestrate/SKILL.md`, plus the resume reference

Two edits to SKILL.md and one to `references/recovery.md`, all small, all in sections that
already exist. Keep both files' habit of explaining *why* inline; a run re-reads SKILL.md's
body on every one of its several hundred turns, so what goes there is prose in the sections
already listed — and nothing here creates a new reference file, it adds a step to the one
`--resume` already reads.

- **§1 (Preview the queue).** Document the key, that presence hoists and only `false` opts
  out, that the marker is read at `<base>` like the gate, and amend the `--ids` bullet to
  "in the order given, after any runner-fix item is hoisted to the front". Add a hoisted
  row to the sample output block so the marker is visible in the example a reader copies.
- **§9 (Merge), a short new subsection at the end: "After a runner-fix item lands".** This
  is the half idea-5 could not settle, and the rule is:

  Once a runner-fix item has merged, print the paths that merge brought in
  (`git -C "$PWD" diff --name-only HEAD^1 HEAD`). If they include
  `skills/backlog-orchestrate/SKILL.md`, **re-read that file from this repo's working tree
  and follow it for the rest of the run** — the body this session was handed came from the
  installed plugin copy and cannot know about the fix. If they *also* include
  `skills/backlog-orchestrate/tools/orchestrate.mjs`, switch the CLI invocation to the
  repo copy for the rest of the run as well.

  **Prose and tool move together or not at all.** Following freshly merged prose while
  still invoking the installed tool is the one genuinely dangerous combination: the new
  body may name a flag the old tool refuses. Both come from the same repo checkout, so
  taking both keeps them consistent with each other; taking neither keeps the run exactly
  as it was. Never one.

  Record it on the item that carried the fix, using the note channel that already exists
  rather than a new field: `stage <id> merged --note "runner fix — the remainder of this
  run follows the repo copy"` (or `merged`'s branch-mode sibling). No `attention` entry —
  `ATTENTION_KINDS` stays the closed set of three, and a run that successfully picked up
  its own fix needs nobody to look at anything.

  **A resumed session does not inherit the switch, and has to re-derive it.** The switch
  is session state; nothing on disk carries it. A run that crashes after picking up its
  own fix is continued by a *fresh* headless session — started by the board's Resume
  control, or by the server's watchdog, which resumes a crashed run unattended — and that
  session is handed the **installed** SKILL.md again, exactly as the first one was. Both
  halves revert together, so nothing becomes inconsistent; what lapses, silently, is the
  whole point of this item, at the one moment a broken runner makes a crash most likely.
  So say here that the switch is re-derivable, and from what: the note written just above
  is the durable record. A resumed session that finds any queue item staged `merged` (or
  `branched`) carrying that note takes the switch again before it works the rest of the
  queue. No new field and no second writer — the note is a string in one
  `orchestrate.mjs` already writes.

  Say plainly in this subsection that a merged runner fix is **inert for the next run
  either way** until the repo's HEAD is pushed and `pnpm run plugin:sync` has run: git is
  the publishing boundary, and this subsection is a within-run workaround for one run, not
  a substitute for the sync.

- **`references/recovery.md`, the `--resume` procedure.** One step, sitting with the other
  run-file reads that resume already makes and *before* the first item is taken over:
  re-derive the switch from the queue's notes exactly as §9 describes. It goes here rather
  than inline in SKILL.md because recovery.md is read in full before every `--resume` and
  by nothing else — precisely this step's audience — and because SKILL.md's own body is
  re-read on every one of a run's several hundred turns, which is the cost this file's
  two reference files exist to avoid paying for text only a resume needs.

### 6. What deliberately does not change

- **`backlog-capture`**: untouched. The marker is a grooming judgement — at capture time
  nobody knows yet whether the fix touches the runner — and the CLI round-trips the key
  regardless, so a human can add it to a captured item at any time.
- **The client.** No change to `shared/types.ts`, `server/src/items/`, `BacklogItem`, or
  `OrchestrateSheet`. The sheet is already documented as an approximation of the queue
  ("deliberately client-side and deliberately only an approximation" in its own comment),
  and because step 3 hoists `--ids` too, a subset launched from the board is reordered by
  the tool no matter what order the checkboxes were in. Mirroring the hoist in the sheet
  would mean a new typed field on `BacklogItem`, a server-side parse and a badge, to
  restate a decision the tool already makes correctly.
- **The run file.** No new field, no `RunStage` member, no `shared/types.ts` edit. The
  queue's *order* is the record of the hoist, and the item note in §9 is the record of the
  switch. This is what keeps `test/agents-shared.test.ts` and
  `test/fixtures/orchestrator-run.json` untouched.

### 7. `backlog-groom` writes it — `skills/backlog-groom/SKILL.md`

Add the question to both verdicts that produce an executable item, phrased as a judgement
the groomer answers rather than a box to tick:

- **Promote** (step 4, writing the new task's file): after the four headings, add a line
  saying that if executing this task would change `backlog-orchestrate`'s SKILL.md, its
  CLI, the reviewer agent or the dispatch route, add `runner-fix: true` to the
  frontmatter, and one sentence on what it buys (the orchestrator hoists it to the front
  of its queue so the rest of the run is not executed by the broken version).
- **Plan the fix** (step 2, editing `## Cause`/`## Fix` in place): the same line, for the
  bug's own frontmatter.

Name the exact key spelling in both places.

### 8. Invariants

Add the rule to `CLAUDE.md`'s Invariants list (one entry, in that file's voice, ~5 lines)
and the longer rationale to `docs/invariants.md`, following whatever structure that file
already uses. The two load-bearing halves are the ones a future reader will otherwise
undo: the marker is read **at `<base>`, not off the working copy**, and the hoist applies
to **`--ids` as well**, because the board's ids are a selection rather than an ordering.

## Test cases

`skills/backlog-orchestrate/tools/orchestrate.test.mjs`, node's own test runner
(`pnpm run test:skills`), new cases in the existing "plan / gate" neighbourhood. Reuse the
helpers already there — `orchFixture`, `seedReadyBug`, `seedReadyTask`, `plan`,
`planGitFixture`, `run`, `runFile` — and seed the marker by writing the frontmatter line
into a seeded item rather than adding a fourth seeder.

1. **Default order hoists.** Seed ready `bug-2`, ready `bug-3` marked `runner-fix: true`,
   ready `task-1`. `plan --json` → ids in order `['bug-3', 'bug-2', 'task-1']`, and the
   hoisted flag is `true` on `bug-3` only.
2. **Stable within each half.** Seed ready `bug-3` and `bug-5` both marked, plus ready
   `bug-2` and `task-1` unmarked. → `['bug-3', 'bug-5', 'bug-2', 'task-1']`: hoisted items
   keep bugs-before-tasks/oldest-first among themselves, and the rest keep the order they
   had.
3. **A marked task hoists ahead of an unmarked bug.** Seed ready `bug-2` unmarked and ready
   `task-1` marked → `['task-1', 'bug-2']`. Pins that the partition outranks the
   bugs-then-tasks rule rather than sorting inside it.
4. **`--ids` is hoisted too.** Same store as case 1, `plan --ids bug-2,bug-3,task-1 --json`
   → `['bug-3', 'bug-2', 'task-1']`. The caller's relative order survives among the
   unmarked items.
5. **Hoist precedes the `--max` cap.** Seed ready `bug-2`, ready `task-1`, ready `task-5`
   marked. `init --max 1` → the written `run.json` queue is exactly one item, `task-5`.
   (Assert on the run file, not on `plan`, so the cap's effect on real membership is
   pinned.)
6. **`runner-fix: false` does not hoist.** Marked `false` on `bug-3` in case 1's store →
   order `['bug-2', 'bug-3', 'task-1']` and hoisted `false` everywhere.
7. **Any non-`false` value hoists.** `runner-fix: yes` on `bug-3` → hoisted `true` and
   `bug-3` first. This is the typo case; it must not silently fall back to natural order.
8. **The marker is read at `<base>`, not off the working copy.** With `planGitFixture`:
   add `runner-fix: true` to a committed item's frontmatter **in the working copy only** →
   hoisted `false` and the order unchanged. Then commit that edit on `main` → hoisted
   `true` and the item first. One test may do both halves in sequence; the uncommitted half
   is the one that must not be dropped.
9. **An item absent from `<base>` never hoists.** With `planGitFixture`, write a new item
   file carrying `runner-fix: true` and do not commit it → `hoisted` is `false`, the gate is
   still `ungroomed`, and its reason still names the path the worktree would lack (the
   existing "not committed" assertions keep passing).
10. **An ungroomed marked item still hoists.** Seed `bug-3` marked with `## Fix` left as
    the `unknown` placeholder, plus a ready `bug-2` → `plan --json` puts `bug-3` first with
    gate `ungroomed`, and `init` (no `--max`) writes both items to the queue in that order.
11. **No git view falls back to the working copy.** `orchFixture`'s repo has no commits, so
    case 1 already covers this; add an assertion or a comment tying case 1 to that fallback
    rather than a separate test.
12. **Human-readable output names the hoist.** `plan` without `--json` on case 1's store →
    `bug-3`'s line carries the hoist marker and `bug-2`'s does not. With `--max 0`, the
    hoisted row carries both the hoist marker and `(beyond --max)`.
13. **`plan` still writes nothing.** Extend the existing byte-identical store/state-dir
    case (or add its twin) with a marked item present, so the new frontmatter read cannot
    have introduced a write.

No jest-side cases: nothing in `shared/`, `server/` or `client/` changes, and
`test/agents-shared.test.ts`'s `Record<RunStage, true>` literal is untouched because no
stage is added. `pnpm test` staying green is itself the assertion that nothing drifted.

No case covers §5's `--resume` re-derivation either, and that is a gap this plan states
rather than hides: it is prose in two skill bodies over a note string the tool already
writes, so there is no CLI behaviour to assert on. `## Done when` 4 and 5 are its only
check, and the failure mode if the prose is wrong is a resumed run quietly using the
installed copy — the state that exists today.

**No browser check.** The `In the browser (playwright MCP tools):` prefix is deliberately
absent from this task: nothing rendered changes. The whole diff is one CLI, three skill
bodies (`backlog-orchestrate`'s SKILL.md and its `references/recovery.md`,
`backlog-groom`'s SKILL.md) and the invariants docs, and every observable consequence is a
CLI stdout or a `run.json` the node suite reads directly.

## Done when

1. `pnpm run test:skills` is green, including every case above.
2. `pnpm test` and `pnpm run typecheck` are both green, unchanged — proof that no shared
   type, run-file fixture or client surface moved.
3. `node skills/backlog-orchestrate/tools/orchestrate.mjs plan --project "$PWD"` run in
   this repo, against an item temporarily stamped `runner-fix: true` **and committed on
   `main`**, prints that item first with the hoist marker; with the stamp uncommitted it
   prints the unchanged order. (The second half is the invariant that matters most; the
   temporary stamp is reverted before the item is archived.)
4. `skills/backlog-orchestrate/SKILL.md` §1 documents the key and the amended `--ids`
   sentence, and §9 carries the "After a runner-fix item lands" subsection including the
   prose-and-tool-move-together rule, the re-derive-on-resume rule and the `plugin:sync`
   caveat.
5. `skills/backlog-orchestrate/references/recovery.md`'s `--resume` procedure carries the
   step that re-derives the switch from the queue's notes, before the first item is taken
   over.
6. `skills/backlog-groom/SKILL.md` names the exact key in both the Promote and the
   Plan-the-fix verdicts.
7. `CLAUDE.md` and `docs/invariants.md` carry the new invariant.
8. Noted, not run: none of the skill edits change any real run until this repo's HEAD is
   pushed and `pnpm run plugin:sync` succeeds — `plugin:sync` refuses a dirty or unpushed
   tree, so it cannot be part of an orchestrated run's own verification.
