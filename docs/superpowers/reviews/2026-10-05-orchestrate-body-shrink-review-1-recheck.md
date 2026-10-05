# Review 1 re-check — `docs/superpowers/plans/2026-10-05-orchestrate-body-shrink.md`

Reviewer: fresh subagent (Fable 5.1), 2026-10-05. Inputs: the revised plan (untracked, no diff), review 1, the repo at `19a33fe` (unchanged; `wc -c SKILL.md`
still 151,246), `test/claude-rules.test.ts`, `.claude/rules/skills.md`, `.claude/rules/orchestrator.md`, `docs/subsystems/invariants.md`, the cited `O:`/`T:`/`S:`
ranges, and one temp-repo probe of git 2.50.1 (plain detach vs. mid-rebase, below). Scope: the text that answers each review-1 finding, and nothing else.

**Verdict: APPROVE WITH FIXES.** The Critical and all eight Important findings from review 1 are addressed in the text. Two new Important problems came in with
the changed text — both in Task 1 — and four of review 1's Minors were not picked up. Nothing Critical.

## Previous findings → status

| # | Review-1 finding | Plan text now | Status |
| --- | --- | --- | --- |
| C1 | Task 8's CLAUDE.md `Why:` link would fail `test/claude-rules.test.ts` | plan:309-318 — three tiers named: headline-only bullet in `## Invariants`, section in `invariants.md`, mechanism bullet in `.claude/rules/skills.md` (`paths: ["skills/**", "agents/**"]` confirmed, `.claude/rules/skills.md:2`), plain link in `docs/subsystems/skills.md:126-133`, `pnpm run test:jest -- claude-rules` before commit | **Resolved.** `HEADLINE_ONLY` (`test/claude-rules.test.ts:42`) accepts the proposed bullet; `compareTiers` needs the tier-3 bullet to carry the same anchor — see Minor 1. |
| I1 | "0/1/3/7 only" contradicted composed steps | plan:44-48 — no new codes; composed steps keep theirs (`10` from `stage`, O:3190-3194 confirmed; `8`/`9` via `trackerAttention`, O:3487 confirmed); case 13 at plan:124 | **Resolved**, but the step checklist was not updated — see new I-A. |
| I2 | Trigger named a `source` field the run file lacks | plan:54-56 phrases it on `backlog/source.json` and says why (S:106 confirmed; `OrchestratorRun` at `shared/types.ts:1204` has no `source`); plan:228 matches | **Resolved.** |
| I3a | Outcome 3 (create refuses) had no case; T:6629 retired unpinned | case 12 at plan:122-123; the refusal string `is already used by worktree at` matches git 2.50.1 (probe below) and `invariants.md:441` | **Resolved**, with two caveats: plan:126 still says T:6629 moves to "tests 1–8" (it moves to case 12), and the fixture wording "mid-rebase / detached" is half wrong — see new I-A and Minor 2. |
| I3b | `<ref>` on a detached HEAD undefined | plan:112-113 defines the fill as `a detached HEAD`, derivable from the S:1276 template | **Resolved as stated**, but the state cases 4 and 5 expect cannot be reached through the flow plan:96-98 specifies — see new I-B. |
| I4 | Orphaned `NOTE_PLACEHOLDERS` entries turn T:4321 red | plan:57-58 — remove in the same commit, check after each of Tasks 1–3 (T:4352-4356 `unused` assertion confirmed) | **Resolved.** `<message>`/`<ref>`/`<paths>` sites are S:1247/1276/1302 only; `<path>` also at S:1452 (Task 3); `<base tree>` appears in `--detail` only at S:1276/1302, so it is orphaned after Task 1 too — covered by the constraint's "…". |
| I5 | `archived` undefined for the all-three shape | plan:140-149 — `archived`/`reattach` are branch-only; `resume-or-park` skips the archive check; precedence stated; case 4 at plan:164 pins the all-three shape | **Resolved.** Matches S:348-366 and S:537-562. |
| I6 | `cleanup` had no source for the base tree | plan:192-193 — `run.baseTree.path`, exit 1 when absent in merge mode, no fallback to the root; case 9 at plan:210 | **Resolved.** See Minor 3 on what "merge mode" keys on. |
| I7 | T:7838's 1600-char window vs moving S:1424-1437 | plan:235-237 — push line plus one-line outcomes stay in the body, T:7838 unchanged | **Resolved.** T:7838-7850 confirmed: needles `denied by the auto-mode classifier`, `park`, `branch mode|branched` after `push origin <base>`. |
| I8 | Rule file and invariants.md keep §9 mechanism prose | plan:59-61 global constraint; Task 1 Files plan:90-92; Task 3 Files plan:183-184 | **Resolved.** `.claude/rules/orchestrator.md:49-60` is a single bullet whose headline stays true; it carries no §3/§4 mechanism (only the `show-ref`/`worktree` allowlist mention at :59, which stays true), so Task 2 needs no Files line. |
| m1 | `.prettierrc` is `.prettierrc.yaml` | plan:62 still says `.prettierrc` | **Not resolved** (Minor). |
| m2 | `treeHoldingBranch` is at O:2574 | plan:49 still says O:2575 | **Not resolved** (Minor). |
| m3 | Task 1 size label "~20k → ~4k" | plan:88 "~7.6k chars; the body keeps ~2k" | Resolved. |
| m4 | Review focus 4 named Task 5's recovery.md edit | plan:73-74 names Task 1's | Resolved. |
| m5 | "T:3328" is a comment line | plan:259 names the test and T:3317 | Resolved. |
| m6 | Case 7 path spelled short | plan:208 spells `skills/backlog-orchestrate/tools/orchestrate.mjs` | Resolved. |
| m7 | `reattach` goes to §5, not dispatch | plan:155-156 | Resolved. |
| m8 | `worktree` exit code on a failed probe | plan:154-155 "exit 0, as `merge-check` does" | Resolved. |
| m9 | §10 pointers must say `stopping.md` | plan:257-258 | Resolved. |
| m10 | Keep T:6369's second assertion | plan:214-215 | Resolved. |
| m11 | Say which spelling §10 uses for T:6663's needle | plan:127-128 "keep their needles" only | **Not resolved** (Minor). |
| m12 | Say nothing needs allowlisting today | plan:290-291 "Allowlist any that are genuinely instructions" | **Not resolved** (Minor). |
| m13 | Pin the (status, stderr) pair for case 3 | plan:215-216 (exit 255, `Directory not empty`); T:6303-6312 confirms the "2 of 2" comment | Resolved. |

## Important (new, in the changed text)

**I-A — plan:130 and plan:126 (Task 1 step list / pinned tests).** The test-case list now runs to 13 (cases 12 and 13 were added for I3a and I1), but the first
checkbox still says "Write cases 1–11", and the pinned-tests paragraph still says T:6629 "move[s] to behaviour tests 1–8". Cases 1–8 contain no outcome-3
scenario; case 12 is T:6629's only replacement. An implementer following the checkboxes writes 1–11, retires T:6629 against 1–8 per plan:126, and outcome 3
(S:1240-1249) ends up pinned nowhere — the exact gap I3a was opened for.
→ Fix: plan:130 "Write cases 1–13"; plan:126 "T:6629 moves to case 12; T:3300/T:6618/T:6641 move to cases 1–8".

**I-B — plan:112-114 (Task 1 cases 4 and 5) vs plan:96-98 (interface).** The interface runs, in one process, "find the tree holding `<base>`; if none, create
`.worktrees/_base-<sanitised>`; precondition 1 (`symbolic-ref HEAD` …)". `treeHoldingBranch` (O:2574-2580) matches only `branch refs/heads/<base>` lines, so a
base tree that is on a detached HEAD (case 4) or on `refs/heads/other` (case 5) is never *found*: the scan returns null, the tool creates `_base-<base>`, and
precondition 1 passes in the new tree. Measured in a temp repo with git 2.50.1: after `checkout --detach` in the root, `worktree add ../wt main` **succeeds** (a
plain detach releases the branch). So neither case can reach the `park` verdict the plan expects; S:1259's "the seconds in between" race is the only path to
precondition 1 failing, and a test cannot induce it inside one tool call. Case 10 does not rescue this either: a re-scan finds the run-created `_base-` tree
(S:1243-1244, outcome 1 reuses it), so "reuses the same path" passes without the tool ever reading `run.baseTree.path`.
→ Fix, pick one and say it in the interface: (a) `merge-check` prefers `run.baseTree.path` when the field is set and runs precondition 1 there without
re-scanning — then cases 4 and 5 become "run `merge-check` once (records the path), detach / switch that tree, run it for a second item → `park`", and case 10
pins the preference; or (b) keep the rescan and test precondition 1 as a function on a prepared tree, stating that in cases 4 and 5. Without one of these the
implementer has to guess, and the honest implementation of plan:96-98 makes both cases unwritable as described.

## Minor

1. **plan:315-316.** The tier-3 bullet must end with the same `Why: [invariants.md](docs/subsystems/invariants.md#<anchor>)` link as tier 1: `compareTiers`
   (`test/claude-rules.test.ts:308-314`) matches on (anchor, headline) pairs and the bullets-only guard (:290-305) requires exactly one anchor per bullet. The
   plan says "headline must match byte for byte" but not "and carry the same anchor". The existing bullets in `.claude/rules/skills.md` show the shape, so an
   implementer will probably copy it — say it anyway.
2. **plan:122.** "Base held only by a worktree mid-rebase / detached" — the "/ detached" alternative does not reproduce outcome 3: a plain `checkout --detach`
   releases the branch and `worktree add` succeeds (probe above). Only a *conflicted rebase* (or bisect) on the base in that tree keeps the branch owned
   while `--porcelain` prints `detached`; `worktree add` then refuses with exit 128 and the quoted message. Say "a conflicted `git rebase` on `<base>` in a
   second worktree, left mid-rebase".
3. **plan:192-194.** "In merge mode" — say whether this keys on `run.mergeMode` or on the item's stage. Case 5 (plan:206) keys on `stage branched`; a
   merge-mode run whose item was degraded to `branched` by a classifier denial would otherwise run `branch -d` and the `HEAD^1 HEAD` diff against an unrelated
   base commit. "Merge mode here means stage `merged`" resolves it in one clause.
4. **plan:259.** T:5182-5188 bounds its slice at `### \`--resume\` and \`--abort\``, which will not exist in `stopping.md`; `indexOf` returns -1 and `slice(start, -1)`
   silently drops the last character instead. Say the end bound becomes end-of-file when the test is re-pointed.
5. **plan:62.** `.prettierrc` → `.prettierrc.yaml` (unchanged from review 1).
6. **plan:49.** `treeHoldingBranch` is defined at O:2574 (unchanged from review 1).
7. **plan:127-128.** Still does not say which spelling §10 keeps for T:6663's needle `worktree remove "$PWD/.worktrees/_base-` now that the path comes from
   `baseTree.path` (unchanged from review 1).
8. **plan:290-291.** Still does not say that nothing in today's body needs allowlisting (S:141-146 is sample output, S:194/214/925 are fenced) — unchanged from
   review 1.
9. **plan:147-148.** This bullet restates what the `archived`/`reattach` definitions above it already say; harmless, but it reads as a sixth verdict in a
   five-verdict list.

## Probe record

Temp repo, git 2.50.1, scratchpad only:
- root on `main`, `git checkout --detach` → `worktree list --porcelain` prints `detached`; `git worktree add ../wt main` **succeeds**.
- root on `main`, `git rebase other` stopped on a conflict → porcelain prints `detached`; `git worktree add ../wt main` → `fatal: 'main' is already used by
  worktree at '<root>'`, exit 128; `git symbolic-ref HEAD` → `fatal: ref HEAD is not a symbolic ref`, exit 128.
