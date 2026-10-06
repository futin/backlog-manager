# Final whole-branch review: refactor/orchestrate-body-shrink (0f8e83a..5b96f99)

Reviewed in three passes: (1) tool + tests (`orchestrate.mjs` diff, `shared/types.ts`, the new and retired cases in `orchestrate.test.mjs`);
(2) SKILL.md + `references/` (full read of the new body, the four new references and the recovery.md diff, and a sentence-survival sweep of every
paragraph of the old body against body + references + tool source: 424 lines of "not found verbatim", each triaged by hand); (3) docs/rules
(CLAUDE.md, `.claude/rules/{orchestrator,skills}.md`, invariants.md, skills.md). No suite re-run, per the dispatch.

## Strengths

- **The tool work is careful and composes rather than copies.** `merge-check`, `inspect` call `cmdStage`/`cmdAttention` with a no-op printer, so a stop
  request still exits `10` from the same code path, and nothing is written before the refusing step. `applyUsageEntry`, `writeSnapshot` and
  `transcriptSlotOrThrow` are clean extractions; `usage`/`snapshot` output is byte-identical.
- **`cleanup` refuses rather than defaults** when a merged item has no `baseTree` (orchestrate.mjs:3912ff) — the bug-38 fallback cannot come back by
  accident, and case 9/9b pin it. Case 10 proves the base tree is used by giving the root a `main` that lacks the merge.
- **Command-line safety was thought through at the seam:** leftover's park detail is fixed words with git's line in a separate `gitError` (e4defd9);
  merge-check's and cleanup's git-quoting details are written by the tool itself, never handed back to a `--detail` the body types; the body never places
  `refused`, `gitError`, `branchError` or merge-check's `detail` on a command line.
- **Reference triggers are observable and reachable on both entry paths.** tracker.md is named in recovery.md after `claim`/before `reconcile` (0688b1c
  caught a real gap); stopping/merge-failures/check-failures/questions are all triggered by exit codes or verdicts inside the loop. The
  trigger-in-the-same-sentence tests are good guards.
- **The plan's gap fix landed:** the worktree-side resolve now aborts the worktree merge before parking (merge-failures.md), with a counting test.
- **Test discipline:** every retirement in a commit message names its replacing behaviour case; re-pointed tests kept needles; the size diagnostic
  is a `t.diagnostic` with no assertion and cannot fail; leftover/worktree 8 was hardened to fail against the wrong cwd.
- Literal `git merge`, the probe, every push and all launch lines stayed in the body; no tool path runs `merge`/`push`; no new exit codes;
  `process.exitCode = main(...)` untouched.

## Issues

### Critical

None. The sentence sweep found no rule deleted outright: every removed paragraph is a one-statement body line, a references section, or a
subcommand whose cases pin it. The Important items below are rules that survived but became unreachable or ambiguous on one path.

### Important

**I1. SKILL.md:694, 702, 732-733 — the retry path never tells the driver to re-run `inspect` on the retry's transcript.**
What: old §5 said "Run it once per transcript: again on the retry line below with `--jsonl` pointed at `<id>-retry-<n>.jsonl`" and "re-run [denials]
against the _retry's_ transcript". New §5 says `--jsonl` "names another transcript, as on the retry line below" (the retry line contains no `inspect`),
and the retry ends "come back to this step when it exits". A driver that comes back and runs the fenced `inspect <id>` reads `<dir>/logs/<id>.jsonl` —
the FIRST session's transcript.
Why: the retry session's permission denials are never counted (the one signal that a "successful" session was refused something), so a denied retry
can be committed, reviewed and merged; and the retry's cost is never recorded. This is the T7 "known" item, and it weakens a rule rather than polishing
wording.
Fix: after "come back to this step", give the literal call:
`inspect <id> --jsonl "<dir>/logs/<id>-retry-1.jsonl"` (and say the fenced default is for the first dispatch only).

**I2. orchestrate.mjs:4053-4064 (cmdInspect) vs SKILL.md:470-472, 483-489, 539-540 — §4's `reattach` and resume-onto-leftover paths go to Inspect
with no transcript in this run's `<dir>/logs/`, so `inspect` always exits `1` there and writes nothing.**
What: both paths handle a branch/worktree left by an EARLIER run, and `init` swept that run's sidecars (its `logs/<id>.jsonl`) into
`<dir>/runs/<runId>/` (SKILL.md:213-215). `inspect` defaults to `<dir>/logs/<id>.jsonl`, `readSessionUsage` throws ENOENT, and the command refuses
before `stage inspecting` (by design, inspect 7). The old body ran `stage inspecting` and read the item file itself whatever `usage`/`denials` said; the
new body's only item reading comes from `inspect`'s output, and its exit-1 guidance is "look at it before deciding anything".
Why: a cross-run seam the per-task reviews could not see. Every reattach and every "resume onto it" now dead-ends at an error with the stage left at
`dispatched` and no defined next step — on exactly the paths most likely after a crash.
Fix (either): (a) when `--jsonl` was NOT given and the default file is absent, report `transcript: "absent"`, `usage: "no-result"`, `denials: null`, and
still stage and read the item; body: `denials: null` means unknown, never clean — treat it like a non-zero count (ask/park) or point `--jsonl` at
`<dir>/runs/<runId>/logs/<id>.jsonl` when it exists; or (b) a body line on both paths saying what to run instead. Add a case either way.

**I3. references/recovery.md:266-268 — abort's preserved-item removal has lost its "failed to delete" instruction.**
What: the line now says `orchestrate.mjs cleanup` (`classifyWorktreeRemove`) "is the one home for telling them apart and for what to do about each".
But `cleanup` refuses any stage other than `merged`/`branched` (orchestrate.mjs:~3923), so an aborted, preserved item cannot use it, and a function name
is not an instruction a driver can run. The prose that licensed the guarded `rm -rf` (only after git's own "failed to delete", only the literal
`$PWD/.worktrees/<id>`, prove it gone) was deleted from SKILL.md §9 in b4a01ca and now lives only in tool code and rationale.md, which this path never
opens.
Why: a moved rule that is now unreachable on the one path that still runs the removal by hand. The likely improvisations are `--force`, `prune`
(both no-ops after a failed delete, per rationale.md) or an unguarded `rm -rf`.
Fix: one statement in recovery.md step 3: "on `error: failed to delete`, the worktree is already unregistered — `rm -rf "$PWD/.worktrees/<id>"` (that
literal path only) and confirm it is gone; never `--force` or `prune`; on `contains modified or untracked files`, stop and leave it." Or let `cleanup`
accept the abort-preserved case.

**I4. references/merge-failures.md:47-51 — the pre-merge refusal's fallback can loop when the refusal is about untracked files.**
What: the old text said "park with the paths named, or resolve worktree-side". The new text says "`merge-check <id> --park-on-overlap` to park with the
paths named". But precondition 2 sees only `git diff` and `git diff --cached` (orchestrate.mjs, `changedPaths` callers in cmdMergeCheck), and git also
refuses a merge with `error: The following untracked working tree files would be overwritten by merge`. In that case `--park-on-overlap` prints
`verdict: merge` and parks nothing, the body's table says "merge, below", the merge is refused again, and `<paths>` was dropped from
`NOTE_PLACEHOLDERS` (a0b274a), so no hand-park template remains.
Why: an unattended run with no exit from a loop on a plausible state (a file the person created locally that the item also adds).
Fix: one sentence in merge-failures.md: if `--park-on-overlap` prints `merge`, park by hand with fixed words
(`attention <id> --kind parked --detail "merge refused before it started: files in <base> tree's working copy would be overwritten — branch backlog/<id> kept for a manual merge"`, then `stage <id> parked`).
Or count `git ls-files --others --exclude-standard` as dirty paths in `merge-check` (and add a case).

### Minor

- **M1. SKILL.md:842-844** — "The second line is step 5's `usage` call again" and "`inspect` carries both up there" are stale after Task 7: §5 no longer
  has a `usage` line. Reword to "the same write `inspect` does in step 5" (known, T7).
- **M2. SKILL.md:703-706 / orchestrate.mjs cmdInspect** — `no-outcome` is glossed "neither: the session died", but a `done/` item with no Outcome also
  maps there (inspect 3 pins it). The mapping is the conservative one; add "or done with no Outcome" to the gloss (known, T7).
- **M3. merge-failures.md:72-74** — on `overlap` the file offers the worktree-side resolve first. That resolve cannot clear an overlap: the overlap is
  the person's *uncommitted* paths in the base tree, and merging `<base>` into the item worktree does not change them, so the merge out is refused again
  after a full re-verify (and possibly a fix loop). The old text hedged it ("if it applies"). Say: on `overlap`, park with `--park-on-overlap`; the
  resolve is for a refusal or conflict caused by `<base>` having moved.
- **M4. SKILL.md:1018-1019** — incident history (`run-20260923-154625 (claude-agents-dashboard)`) remains in the body; the no-history guard does not
  match run ids. Move the clause to rationale.md and consider adding `run-\d{8}-\d{6}` to the guard's pattern.
- **M5. SKILL.md:1069-1071** — "`true` says nothing about the merge" reads backwards: `branchMergedIntoBase: true` means the merge is real and the refusal
  had another cause. Say that.
- **M6. SKILL.md:1078-1081** — `cleanup` reports `runnerFixError` when the `HEAD^1 HEAD` diff fails, with `runnerFix` both false; the body says "Both
  false: nothing to do", so a failed read is silently a "no runner fix". One clause: "`runnerFixError` present means unknown — check the merge by hand."
- **M7. SKILL.md:531-533, 757-759** — "goes on that list too, locally" / "adds it to that list in the same edit": the in-run list is now the tool's
  `WORKTREE_EXCLUDES` constant, so a driver that writes a shim mid-run has no command for a whole-line, only-if-absent append (the fenced loop is gone).
  Name the check in one line, or give `worktree` an `--exclude <pattern>`.
- **M8. docs/subsystems/invariants.md:727** — "After a runner-fix item lands … print `git diff --name-only HEAD^1 HEAD` in the base tree" still says the
  driver runs it; `cleanup` does now. That line is also 211 columns.
- **M9. references/questions.md:26** — the moved sentence "this file is re-read on every one of a run's several hundred turns" is no longer true of a
  reference file read on a trigger; it should say SKILL.md.
- **M10. Transition: SKILL.md:1057-1058** — a run file written before `baseTree` existed, resumed under the new skill with an item already at `merged`,
  makes `cleanup` exit `1`. The body says "nothing was changed" but gives no next step. One sentence (remove the worktree by hand from the root, leave
  the branch) would close it. Rare, only at upgrade time.
- **M11. Over-160-column prose** (known): SKILL.md:92 (≈179), :369, :560, :850 (≈189), :1071 (≈174), :1108 (≈176); invariants.md:727; plus
  tracker.md's verbatim-moved lines and long test names. Real width counted in characters; several other awk hits at 161-165 were byte counts of em
  dashes, not real overruns.

## Rulings on "Already known"

| Item | Ruling |
| --- | --- |
| T7: §7 "step 5's usage call again" stale | Defer is safe; fix opportunistically with I1 (M1). |
| T7: `no-outcome` gloss omits done-without-Outcome | Defer is safe: the mapping is the conservative one (ask/park, never merge). M2. |
| T7: retry never says to re-run `inspect --jsonl` | **Fix now.** Raised to I1: the retry's denials go unchecked, so a refused retry can merge. |
| T7: recorded-worktree branch of `inspect` untested | Defer is safe: every body call records `"$PWD/.worktrees/<id>"`, which is the conventional path the fallback already uses. Fold into I2's new case if convenient. |
| T2: stop after `worktree` created the tree leaves `attention` + worktree | Defer is safe: `stage preflight` catches an earlier stop; a stop inside the window surfaces as exit `10` from the composed `stage parked`, the body goes to stopping.md → `abort`, which tears down an unmarked worktree. The orphan attention row is noise, not harm. |
| T2: failed presence probe skips the info/exclude append | Defer is safe: the item is parked and nothing is committed from that tree. The only effect is `.worktrees/` showing untracked in the main tree until the next item's `worktree` runs (or for good if it was the last item). |
| T1: `baseTree.created` is per-path, overwritten by a later `merge-check` | Accepted. It errs toward leaving a directory behind, never toward removing a tree the person made. |
| T6: guard misses single-digit `#N` and fences by backticks only | Accepted. None exist today. See M4 for the run-id gap, which matters more. |
| Lines over 160 columns | Defer is safe; not behavioural. M11. |

## Declined to judge (outside the plan, pre-existing, or soft)

- references/tracker.md:173 "Park, with the classifier's message quoted" and SKILL.md:956 "`attention <n> --kind parked` naming git's message" put
  model- or git-written text on a `--detail`, which contradicts the no-prose-in-argv rule. Both were moved verbatim from the old body, so they are
  pre-existing and out of this plan's scope. Worth its own backlog item.
- references/check-failures.md:70 "park the item with that row quoted in the detail": the same pre-existing contradiction, moved verbatim.
- Precondition 2 being blind to untracked files in itself: a pre-existing probe design. Only the lost fallback is in scope (I4).
- A `_base-*` worktree is left behind when a run ends `paused`, `failed` or aborted, and a later run reuses it with `created: false`: pre-existing
  §10 behaviour, unchanged by this branch.
- A tracker branch-mode item seen by a later run reads `reattach`, because no `done/` move exists for an issue: a pre-existing tracker/branch-mode
  interaction.
- The runner-fix note re-stamp `stage <n> merged --note …` in a tracker project, where `stage merged` requires `--outcome`: pre-existing.
- The body is still ≈105k characters against a ≈60k target: the target is explicitly soft.
- The acceptance measurement off the next real run's transcript: post-merge by the plan's own terms.

## Recommendations

1. Fix I1-I4 before merge. All four are a sentence or two of body/reference text, plus, for I2 (and optionally I4), a small tool change with one case.
2. Take M1, M3, M5 and M6 in the same pass. They are one clause each in paragraphs the I-fixes already touch.
3. File a backlog item for the pre-existing "quote git's/the classifier's message in `--detail`" sites (tracker.md:173, SKILL.md:956,
   check-failures.md:70). Their `--detail` placeholder should be "your words", like everywhere else.
4. Extend the history guard to run ids (M4).

## Assessment

**Ready to merge: With fixes.** No rule was deleted, and the tool is solid and well tested. Four seams still fail at runtime: the retry's transcript is
not re-inspected, `inspect` hard-fails on the cross-run reattach and resume-onto paths, abort lost its failed-delete instruction, and the pre-merge
refusal's fallback can loop on untracked files. All four are small, local fixes.
