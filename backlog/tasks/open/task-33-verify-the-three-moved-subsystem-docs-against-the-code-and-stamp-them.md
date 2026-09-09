---
id: task-33
title: Verify the three moved subsystem docs against the code and stamp them
created: 2026-09-07
updated: 2026-09-08T11:14:07Z
groom-elapsed: 119
groom-tokens: 22089
---

## Goal

`docs/subsystems/api.md`, `board.md` and `skills.md` carry `sources:` and `kind:` but no
`verified:` baseline, so `docs-sync` reports all three `unstamped`. That is accurate
rather than an oversight: their prose was moved out of `README.md`'s Architecture section
and `CLAUDE.md`'s Layout section in a5f2eb5, and a stamp asserts someone read a doc's
claims against the code at that commit — moving a sentence is not reading it.

Close that: read each doc against the tree it names, correct whatever the move left stale
or mis-registered, and stamp it. Three `unstamped` lines that nobody ever clears become a
report people learn to skim, which is the failure mode the whole mechanism exists to
avoid.

Regroomed 2026-09-08. The `backlog-retro` skill landed between the filing and now
(73d4349, efef8f6) and the invariant rationale moved wholesale into `invariants.md`
(df008f8, d7463d2). Four things in the original plan were true on 2026-09-07 and are not
true now; each is corrected below and marked *(regroomed)*, so the change is visible to
whoever executes this rather than reading as if it had always been worded that way.

## Plan

Work one doc at a time; each is its own read, its own correction and its own stamp
commit, because a batch of three stamped after one reading is three chances to have been
confidently wrong in the same way.

1. **`docs/subsystems/api.md`** — sources `server/src`. Read every module it describes:
   `items/` (including `git-dates.util.ts` and `uncommitted.util.ts`, whose opposite
   caching postures the doc asserts), `agents/` (the route list, the `BM_AGENTS` gate,
   which routes never call the dashboard, `origin.guard.ts`), `orchestrator/` (the three
   endpoints, the two in-memory services, the two files the server writes), `registry/`,
   `health/`, `static.ts`, `security.ts`. Check the route paths and the claims about what
   is cached, since those are the sentences most likely to have drifted before the move.
   Untouched since a5f2eb5 — still pure moved prose, premise intact.
2. **`docs/subsystems/board.md`** — sources `client/src`, `shared/types.ts`. Read the four
   section components, the `OrchestrateSheet` three-step description, `RunStrip` /
   `RunDrawer` / `RunControls`, the hook cadences it lists, and the `lib/` derivations it
   claims have one home each. The staleness prose came from README and describes behaviour
   the tests pin, so `test/item-stale.test.ts` and friends are the better source for it
   than the components. Untouched since a5f2eb5 — premise intact.
3. **`docs/subsystems/skills.md`** — sources `skills`, `agents`. *(regroomed)* Read the
   **six** `SKILL.md` files, not five: `backlog-retro` landed in 73d4349 after this item
   was filed. Read `agents/backlog-reviewer.md` too. The table of what each skill does,
   the "three CLIs" section and the "only orchestrate touches git" claim are the
   load-bearing ones.

   This doc is **no longer purely moved prose**, which changes what the pass is for.
   73d4349 added its retro rows and its third CLI, and efef8f6 corrected one of those CLI
   sentences against the code. So part of the reading this step exists to do has already
   happened — but without a stamp, which is exactly the state the mechanism cannot
   distinguish from never having been read. Do not treat the already-corrected sentences
   as verified; re-read them like the rest. What this changes is the expected finding
   rate, not the work.
4. **The three docs' own disclaimer.** Each of the three carries a blockquote saying
   "nobody has yet read it back against the code — this doc is deliberately `unstamped`
   until that pass happens". Remove it from each doc in the same commit as that doc's
   prose corrections. A stamped doc still carrying it contradicts its own frontmatter.
5. For each of the three: fix what is wrong, then
   `node ~/.claude/skills/docs-sync/tools/provenance.mjs --repo . --stamp <doc>`, then
   commit the prose and the stamp per the skill's own ordering rule (prose committed
   first, so the baseline is a real ancestor of `HEAD`).
6. **The five docs that went `stale` after this item was filed.** *(regroomed — new
   step.)* The checker on 2026-09-08 reports nine tracked docs as 3 `unstamped` + 5
   `stale` + 1 `current`, and the original "Done when" demanded all nine read `current`
   while no step went near the stale five. They are:

   | doc | baseline | drifted against |
   |---|---|---|
   | `CLAUDE.md` | bb20a03 | the `skills/backlog-retro/**` sources |
   | `README.md` | bb20a03 | the `skills/backlog-retro/**` sources |
   | `docs/overview.md` | 07169eb | the `skills/backlog-retro/**` sources |
   | `docs/subsystems/invariants.md` | bb20a03 | the `skills/backlog-retro/**` sources |
   | `docs/workflows/publishing.md` | c8a7bd8 | `.claude-plugin/plugin.json` |

   **Expect this to be mostly a re-baseline rather than a rewrite** — and prove that
   rather than assuming it. All four retro-stale docs already describe the skill (73d4349
   wrote those sections, efef8f6 corrected the invariant), and `publishing.md`'s entire
   drift is one word added to `plugin.json`'s `description` (`orchestrate, retro, board`),
   which its prose does not quote. So the pass is: read each doc's retro claims against
   `skills/backlog-retro/`, correct what is wrong, and stamp. If a doc needs no
   correction, stamp it anyway — a re-baseline with no prose change is the honest record
   of "read at this commit, found nothing", and is the state `stale` exists to be cleared
   into.
7. Re-run the checker and confirm nine tracked docs, every one `current` — no
   `unstamped`, no `stale`, no `baseline-missing`, no layout violation, no dead link.

Then answer the deferred structural question, in the same session but as a separate
decision:

8. **Should `docs/subsystems/invariants.md` stay one doc?** *(regroomed — the premise
   moved under it.)* When this was written, `invariants.md` held the rationale for the
   subset of invariants whose "why" ran long, and the case for leaving it alone was that
   splitting bought symmetry rather than fixing anything. Both halves of that changed:

   - df008f8 gave **every** `CLAUDE.md` invariant a long-form home here, and d7463d2 cut
     `CLAUDE.md` down to a normative index of rules plus anchored `Why:` links. The doc
     went 2079 → 2652 lines (~167 KB) and is now the single destination for those links,
     not a supplement to a section that also carried reasoning.
   - The reason for weighing this carefully got stronger, not weaker. `CLAUDE.md`'s
     Invariants section is auto-loaded context for every session and every headless
     orchestrator run in this repo, and it is now *only* an index — so what a run reads
     next is decided entirely by where those anchors point. A split rewrites ~89 link
     targets in the one file no run can avoid reading.

   **Decide it with idea-11 in view.** [idea-11](../../ideas/open/idea-11-path-scoped-claude-rules-pointers-into-the-invariant-rationale-once-headless-loading-is-proven.md)
   proposes `.claude/rules/*.md` pointers whose payload is "read `invariants.md` §A, §B,
   §C" — it consumes this doc's anchor shape. This decision therefore outranks idea-11 in
   ordering: splitting after those pointers exist rewrites every one of them. State that
   ordering explicitly in whatever record this decision lands in, so it is not
   rediscovered later.

   A defensible answer is still "leave it, and here is why" — the point of the step is
   that the answer is recorded, not that it is a split.

## Test cases

Prose has no unit tests; the checker is the gate, and these are the observable states.

- `node ~/.claude/skills/docs-sync/tools/provenance.mjs --repo .` reports **nine tracked
  docs, every one `current`**. *(regroomed)* Assert on the reported states, **not** on the
  exit code: the checker exits `0` today with 3 `unstamped` and 5 `stale`, verified on
  2026-09-08, so "exits 0" is a test that cannot fail and the original wording made it
  look like the gate. The nine summary lines are the gate.
- Each of the eight newly-stamped docs' `verified:` sha is an ancestor of `HEAD`
  (`git merge-base --is-ancestor <sha> HEAD`). An amend or rebase under a stamp reports
  `baseline-missing`, which is the one state worse than `unstamped`.
- `grep -l 'until that pass happens' docs/subsystems/{api,board,skills}.md` matches
  nothing — step 4's disclaimer blockquote is gone from all three. Match on that phrase,
  not on the word `deliberately`: that word legitimately appears elsewhere in
  `board.md` and `skills.md`, so the looser pattern would report a false failure.
- `pnpm test` still passes — no test reads these files, so a failure here means something
  other than the docs changed.
- Spot-check that no claim was invented: every corrected sentence traces to a file read
  during the pass, and anything the code did not settle is left out rather than guessed.

## Done when

All nine tracked docs report `current`, every stamp names a commit that is an ancestor of
`HEAD`, the three subsystem docs no longer carry their "deliberately unstamped"
blockquote, and the `invariants.md` split question has an answer recorded — either in
`docs/subsystems/invariants.md` itself or as its own backlog item, with its ordering
against idea-11 stated, not left implicit.
