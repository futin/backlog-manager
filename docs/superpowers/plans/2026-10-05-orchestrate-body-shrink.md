# Shrink the orchestrator's skill body — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** implemented 2026-10-06, Tasks 1-8 landed; `SKILL.md` is 105,465 bytes / 104,745 chars (from 151,246 bytes / 150,227 chars; the 2026-09-01
trim was 60,168 chars). The acceptance measurement is the next real run's injected skill size, off its transcript, still to be recorded here.
Originally: draft 2026-10-05, awaiting review. Bounded change — no spec document; this plan is the whole written record, as with
[2026-09-01-orchestrate-skill-floor-trim.md](2026-09-01-orchestrate-skill-floor-trim.md), which it continues.

**Note on this plan's form — read before writing any code.** It specifies _behaviour_, _interfaces_ and _exact test cases_, never literal implementation
code; that overrides the writing-plans template's "code blocks required" rule. Where an interface below looks wrong once you are in the code, say so and
propose the better one rather than transcribing it. **Every size target is soft.** The one failure this change can have is compressing away a rule that
encodes a failure that already happened; a hard byte budget is how that happens. When a target and a rule disagree, the rule wins and the target moves.

**Goal:** cut `skills/backlog-orchestrate/SKILL.md` from 151,246 chars back to roughly its 2026-09-01 size (~60k) without losing a rule, and stop it growing back.

**Architecture:** three levers, in this order. (1) Deterministic multi-command check sequences in §3/§4/§9 move into new `orchestrate.mjs` subcommands; the
body shrinks to "run X, act on its verdict". (2) Branches a clean run never takes move to `references/` files, each read on an observable trigger.
(3) Inline backstories move to `references/rationale.md`, leaving each rule as one statement. Then a convention plus an informational size report keep it there.

**Tech stack:** Node ESM CLI (`orchestrate.mjs`), `node --test` (`pnpm run test:skills`), real temp git repos in tests.

**Line references:** `S:` = `skills/backlog-orchestrate/SKILL.md`, `O:` = `tools/orchestrate.mjs`, `T:` = `tools/orchestrate.test.mjs`, all as of commit
`19a33fe`. Earlier tasks move text, so re-locate by content before trusting a number in a later task.

## Why

`SKILL.md` is resident for every turn of a run, and a run is ~270 turns: at 151k chars (~38k tokens) the body alone is ~10M cache-read tokens per run. The
2026-09-01 trim took it to ~60k chars; it has since grown 2.5×, because each new rule landed with its backstory inline. Size by section today (chars):
§9 merge 29.7k (of which the two preconditions 20.0k), §4 loop 31.0k (dispatch 16.5k, create worktree 10.5k), §3 pre-flight 12.4k, §7 review 12.0k,
§10 finish 11.8k, §8 verify 10.5k, §2 start 9.4k, §5 inspect 7.5k.

**Why not one reference per phase:** a reference the orchestrator reads stays in its context for the rest of the session. By item 2 every phase file would
be resident, plus the tool-call overhead — no saving. Only text a clean run *never* reads, or prose replaced by a tool call, actually leaves the floor.

## Global constraints

- **Move, never delete.** Every rule that leaves the body keeps a one-statement version in the body, unless a subcommand now enforces it — and then the
  subcommand's test pins it.
- **The merge, the merge-mode probe and every push stay literal `git` Bash calls in the body, each its own call** (S:1327-1331). The auto-mode classifier
  judges the call it sees, and the §2 probe exists to be byte-identical to the real merge. No subcommand may run `git merge` into the base or `git push`.
- **All three `exec claude -p` launch lines and the §8 verify launcher stay in the body** (T:3148, T:3334, T:3925/3939, `test/default-model.test.ts`).
- **A pinned test is retired only when a behaviour test covering the same failure replaces it, in the same commit.** The commit message names both.
  A pinned test may be *re-pointed* (body → body + references) when its text moves, with needles and counts unchanged.
- New subcommands follow the file's conventions: `cmdX(rest)` wired into `main()` (O:5374), an `X_USAGE` constant plus a line in `USAGE` (O:5278), hand-rolled
  argv loop, `OrchestrateError(message, code)`, one JSON line on stdout, **no new exit codes** — a subcommand's own refusals use 1/3/7, and a step it
  composes keeps that step's code (a stop request makes `stage` exit `10`, O:3190-3194; a tracker `attention` can exit `8`/`9` via the API, O:3487), with
  nothing written after the refusing step. `readRun` →
  `assertDriver` → `findQueueItem` before any write, `writeRunAtomic` for every run-file write, `process.exitCode = main(...)` untouched.
- Git via inline `spawnSync('git', ['-C', <tree>, …])` like the rest of the file; reuse `treeHoldingBranch` (O:2574), `branchExists` (O:2475),
  `isUnbornHead` (O:2553). No new dependencies.
- Any new run-file field is optional, and is added to the run type in `shared/types.ts` in the same commit.
- Every `--detail`/`--note` template that moves into a subcommand keeps its exact wording; every new references file that holds templates is added to
  T:4321's `FILES` list, and its placeholders to `NOTE_PLACEHOLDERS`.
- Every new `references/*.md` is named in the body (T:3660) with an instruction saying *when* to read it, phrased on an observable predicate:
  "If the project's committed `backlog/source.json` says `github`…" (S:106 — the run file has no `source` field), "When `merge-check` prints
  `verdict: overlap`…" — never "see also".
- A placeholder (`<message>`, `<ref>`, `<paths>`, `<path>`, …) whose last `--detail` value moves into a subcommand is removed from `NOTE_PLACEHOLDERS` in the
  same commit, or T:4352-4356's `unused` assertion goes red. Check after each of Tasks 1–3.
- The mechanism prose that `.claude/rules/orchestrator.md` (:49-60, the ONE home per CLAUDE.md:59-60) and `docs/subsystems/invariants.md` (:446-471) carry for
  §3/§4/§9 is rewritten to name the subcommand that now does it, in the same task that builds the subcommand. Rules and reasons stay; only "the run
  types these commands" becomes "`merge-check` / `worktree` / `cleanup` does this".
- Prose wraps at 160 columns (`.prettierrc.yaml`).
- `skills/` changes reach no installed plugin until committed, pushed and `pnpm run plugin:sync` runs. Pushing and syncing are the user's call, at the end.

## Review focus

Inputs no task's happy path exercises that are most likely to bite a real run, most likely first. Each one has its test in the owning task.

1. **A base branch whose name needs sanitising** (`feature/tracker-backed`) when no tree holds it — the created path must be `.worktrees/_base-feature-tracker-backed`
   and a second `merge-check` on the same run must reuse it, not create another. → Task 1, cases 2 and 10.
2. **A staged-only change in the base tree that overlaps the branch** — a `git diff`-only probe reads clean over it. → Task 1, case 7.
3. **A `.git/info/exclude` already containing `node_modules_old`** — a substring match would skip the `node_modules` append. → Task 2, case 6.
4. **A resumed run (`--resume`) after `merge-check` created a base tree** — the cleanup in §10 must find it from the run file, not from session memory.
   → Task 1, case 11, and Task 1's recovery.md edit.
5. **A merge commit that touches `orchestrate.mjs` but not `SKILL.md`** — the runner-fix switch must still fire for the CLI. → Task 3, case 7.

## Execution order, and why it differs from the A/B/C framing

Tool tasks first (1–3): they delete prose outright, so doing rationale extraction first would move paragraphs that are about to disappear. Then the
reference splits (4–6), then the conditional Task 7, then the guard (8). Measure the body after each task and write the number in the commit message.

Expected sizes (soft): after 1–3 ≈ 125k; after 4–6 ≈ 65k; Task 7 only if still > 65k; final ≈ 55–65k.

---

### Task 1: `merge-check <id>` — base tree and both merge preconditions

Replaces S:1207-1303 (find the base tree, precondition 1, precondition 2, their park commands) with one call. That range is ~7.6k chars; the body keeps ~2k.

**Files:** modify `skills/backlog-orchestrate/tools/orchestrate.mjs`, `skills/backlog-orchestrate/tools/orchestrate.test.mjs`, `skills/backlog-orchestrate/SKILL.md`
§9 and §10 Finishing, `skills/backlog-orchestrate/references/recovery.md` (base-tree cleanup on resume), `shared/types.ts`,
`.claude/rules/orchestrator.md` and `docs/subsystems/invariants.md` (mechanism sentence only, per Global constraints).

**Interface:**
- `merge-check <id> [--park-on-overlap]`. Requires a run, the driver lease, a known item, and `refs/heads/backlog/<id>` (missing → exit 1, nothing written).
- Does, in order: `stage <id> merging` (same effect as the CLI call); find the tree holding `<base>`; if none, create `.worktrees/_base-<sanitised>` exactly
  as S:1232-1233 does; precondition 1 (`symbolic-ref HEAD` in the base tree must exit 0 and print `refs/heads/<base>`); precondition 2 (branch paths
  `<base>...backlog/<id>` ∩ base-tree dirty paths, unstaged **and** `--cached`). Writes the two scratch files under `<dir>/verify/` as today.
- Records `baseTree: { path, created }` on the run (new optional field). `created` is true only if this run created it, and once true stays true.
- Prints one JSON line `{ verdict, baseTree, created, paths?, detail? }`, exit 0, for every verdict:
  - `merge` — both preconditions hold.
  - `park` — tool already wrote `attention --kind parked` with the exact S:1247/S:1276 template and `stage parked`. `detail` echoes what it wrote.
  - `overlap` — paths overlap; **nothing parked**, so the body can try the worktree-side resolve. `paths` lists them. With `--park-on-overlap` the tool
    parks with the S:1302 template instead and prints `verdict: park`.
- The body keeps: the call, a three-row verdict table, the literal merge lines, the worktree-side resolve pointer, and the one-line rules "never check out
  `<base>` in the user's tree" and "never stash, commit or check out on their behalf".

**Test cases** (all in temp git repos via `orchFixture`/`basedFixture`/`addWorktree`):
1. Base `main` checked out in the project root, clean → `merge`; `baseTree.path` = project root; `created: false`; item stage is `merging`.
2. Base `feature/tracker-backed` held by no tree → creates `.worktrees/_base-feature-tracker-backed` holding it; `created: true` in stdout and run file; `merge`.
3. `.worktrees/_base-x` exists holding another branch → `park`; detail names that path; stage `parked`; no new worktree.
   **Cases 4–5 are not reachable through the full command:** `treeHoldingBranch` (O:2574-2583) only matches `branch refs/heads/<base>`, so a detached or
   switched tree is never chosen, and the tool creates `_base-<base>` instead, as the body does today. That behaviour is unchanged. Precondition 1 now
   guards only the window inside one process. Test it as an exported function run on a prepared tree, and say so in the test name.
4. Precondition-1 function, given a tree on detached HEAD → `park`; detail is the S:1276 template with `<ref>` filled as `a detached HEAD` (the template has no detached wording of
   its own; this is the defined fill), so it contains `is on a detached HEAD, not refs/heads/<base>` and `kept for a manual merge`.
5. Precondition-1 function, given a tree on `refs/heads/other` → `park`; detail contains `refs/heads/other`, not `refs/heads/<base>`.
6. Unstaged edit to `src/a.ts`, which the branch also touches → `overlap`, `paths: ["src/a.ts"]`, stage still `merging`, no attention entry.
   Same state with `--park-on-overlap` → `park`, detail equals the S:1302 template with `src/a.ts` substituted.
7. **Staged-only** edit to `src/a.ts` → `overlap` (review focus 2).
8. Dirty `README.md` the branch does not touch → `merge`.
9. No run → exit 3; foreign lease → exit 7; unknown id → exit 1; missing `backlog/<id>` → exit 1; none of them writes the run file.
10. Second `merge-check` (different item) on the run from case 2 → reuses the same path, `created` still `true`, no second worktree (review focus 1).
11. `status --json` after case 2 shows `baseTree.created: true` (review focus 4).
12. Base held only by a worktree mid-rebase / detached (invisible to the porcelain scan), so `worktree add` refuses with `is already used by worktree at` →
    `park` with the S:1247 template, `<message>` = git's stderr line; no worktree created; `created` not set. (Outcome 3 — T:6629 is its only current pin.)
13. A stop requested on the run → exit `10` from the `stage merging` step, no `baseTree` written, no worktree created.

**Pinned tests:** T:3300 (diff/cached/comm), T:6618 (`symbolic-ref`, `worktree list --porcelain`), and T:6641 move to cases 1–8, and T:6629 moves to case 12 — retire
each in the commit that replaces it. T:6650/T:6663 (remove only a base worktree this run created) are re-pointed: §10 now reads `baseTree.created` from
`status --json`; keep their needles. T:6618's merge-line needle stays (the merge stays in the body). T:6847's allowlist still passes, with fewer sites.

- [ ] Write cases 1–13; run `pnpm run test:skills` — all fail (unknown command).
- [ ] Implement `cmdMergeCheck`; cases pass. Add `baseTree` to `shared/types.ts`; `pnpm run typecheck` passes.
- [ ] Rewrite §9 / §10 / recovery.md to call it; retire or re-point the pinned tests listed above; full `pnpm test` passes.
- [ ] Commit; message records body size before/after.

### Task 2: `leftover <id>` and `worktree <id>` — §3 probe and §4 creation

Replaces the three-probe block run twice (S:333-366, S:528-577) and the creation, post-checkout probe and exclude block (S:580-640).

**Interface:**
- `leftover <id>` is read-only. Runs the three probes plus the archived check (S:342-353) and prints
  `{ branch, worktree, dir, archived, verdict }`, exit 0. `verdict` is one of:
  - `none` (no branch, no worktree, no dir);
  - `archived` (branch **only** — no worktree, no dir — and its `<base>...backlog/<id>` diff archives the item; body runs `stage <id> branched`, as
    S:348-360 does today);
  - `resume-or-park` (all three exist — the archive check is **not** applied, as today);
  - `reattach` (branch only, diff does not archive the item);
  - The archive check runs only for the branch-only shape, so `archived` and `reattach` are the two outcomes of that one shape, and no other verdict
    depends on it.
  - `park` (any other combination; `detail` names what each probe found).
- `worktree <id>` requires `leftover` to say `none` or `reattach`; anything else is exit 1 with nothing changed. It:
  - creates the worktree (`-b backlog/<id> <base>` for `none`, existing branch for `reattach`);
  - runs the post-checkout presence probe with cwd = the worktree (skipped when the project source is github);
  - appends `.worktrees/` and `node_modules` to the **common** git dir's `info/exclude`, whole-line, fixed-string, only if absent.
  - It prints `{ worktree, branch, created: "new" | "reattached" }`, with `worktree` absolute. On a failed presence probe it parks with the exact S:604 template
    and prints `verdict: park`, exit 0, as `merge-check` does. For `reattach` the body then goes to §5 Inspect, not to dispatch, as S:567-574 does today.
    That fork stays in the body.
- The body keeps the judgement: the ask-or-park on `resume-or-park`, writing a pre-flight answer into the worktree item, `stage dispatched`, and the
  one-line rules "never prune, `-D` or `--force` a leftover" and "the exclude entries are written to make verification possible and are never committed".

**Test cases:**
1. Fresh item → `leftover` prints `none`; `worktree` creates `.worktrees/<id>` on new branch `backlog/<id>` from base; `created: "new"`; path absolute.
2. Branch exists, no worktree or dir → `reattach`; `worktree` checks out the existing branch (its extra commit is present); `created: "reattached"`.
3. Branch, worktree and dir all exist → `resume-or-park`; `worktree` exits 1 and changes nothing.
4. Branch only, whose diff moves the item to `done/` → `archived`. Same branch **plus** its worktree and dir → `resume-or-park`, not `archived`.
5. Dir exists without branch → `park`, detail mentions the dir.
6. `info/exclude` already contains `node_modules_old` → after `worktree`, it contains a `node_modules` line and a `.worktrees/` line (review focus 3).
   A second `worktree` run on another item adds neither line again.
7. Exclude lines land in the main repo's `.git/info/exclude`, not in the worktree's gitdir.
8. Item file uncommitted on base → `worktree` parks with the S:604 template; stage `parked`.
9. Tracker fixture (`trackerFixture`) with an absent item → no presence probe, no park.
10. No run / foreign lease / unknown id → exit 3 / 7 / 1, no git changes.

**Pinned tests:** T:6693-6760 (execute the fenced exclude block) are retired in favour of cases 6–7. T:6731's two phrases stay in the body as the one-line rule.
T:3641's `grep -qxF` and `( cd ` needles: if their only body site moves into the tool, remove them from `RULES` in the same commit and point the commit
message at cases 6 and 8; if another body site still uses them, leave them.

- [ ] Cases 1–10 red → implement → green → rewrite §3/§4 → full `pnpm test` → commit with sizes.

### Task 3: `cleanup <id>` — after the merge

Replaces worktree removal and its exit-code handling (S:1413-1479), the `branch -d` check (S:1481-1499) and the runner-fix detection (S:1514-1516).

**Files:** `orchestrate.mjs`, `orchestrate.test.mjs`, SKILL.md §9 tail, `.claude/rules/orchestrator.md` and `docs/subsystems/invariants.md` (the bug-38
base-tree sentence now names `cleanup`, and the closed allowlist sentence stays true).

**Interface:**
- `cleanup <id>` requires stage `merged` or `branched`, else exit 1.
  - Runs `worktree remove` without `--force`.
  - On "contains modified or untracked files" it writes the exact S:1452 attention entry. The stage stays as it is.
  - On "failed to delete" it removes the directory and checks that it is gone. If it is gone, nothing is recorded. Otherwise it writes an attention entry
    quoting the error.
  - "The base tree" is `run.baseTree.path`, as Task 1 recorded it. In merge mode, if that field is absent (no `merge-check` ran for this run), it exits 1
    before removing anything. It never falls back to the project root, because that fallback is exactly bug-38.
  - In merge mode only, it runs `branch -d backlog/<id>` from the base tree. On refusal it reports `merged-into-base: true|false` from `branch --merged`.
  - In merge mode, it diffs `HEAD^1 HEAD` in the base tree.
  - It prints `{ removed: "ok" | "leftovers" | "deleted" | "failed", branchDeleted, branchMergedIntoBase?, runnerFix: { skill, cli } }`.
- The body keeps: the call, the runner-fix *switch* (re-read SKILL.md / switch CLI — judgement, and rare: moves to Task 5's reference), the `branch -d`
  refusal reading as one line, and "never `worktree remove --force`" (T:6351 stays).

**Test cases:**
1. Clean worktree after a merge → `removed: "ok"`, directory gone, `branchDeleted: true`.
2. Untracked file in the worktree → `removed: "leftovers"`, attention entry equals the S:1452 template, stage still `merged`, branch not deleted.
3. "Failed to delete" path — if it cannot be produced reliably in a temp repo, test the classification function on recorded git stderr/exit pairs (128 vs
   255) and the remove-then-verify step on a real directory; say which you did in the commit.
4. Branch with a commit not in base (simulated) → `branchDeleted: false`, `branchMergedIntoBase: false`.
5. Branch mode (`stage branched`) → worktree removed, no `branch -d` attempted, no runner-fix diff.
6. Merge commit touching `skills/backlog-orchestrate/SKILL.md` → `runnerFix.skill: true`, `cli: false`.
7. Merge commit touching only `skills/backlog-orchestrate/tools/orchestrate.mjs` → `skill: false`, `cli: true` (review focus 5).
8. Stage `inspecting` → exit 1, nothing removed.
9. Merge mode, stage `merged`, run file with no `baseTree` → exit 1, worktree and branch untouched.
10. `--base` run whose base tree is `.worktrees/_base-…` (not the project root) → `branch -d` and the runner-fix diff read that tree. A fixture where the
    project root's `main` lacks the merge proves it: `branchDeleted: true`.

**Pinned tests:** T:6303, T:6325, T:6341 (one fenced `rm -rf`) and T:6369's first assertion are retired against cases 1–3. T:6369's
second assertion (no `--kind parked` template offers `worktree prune`) is a body-wide guard and stays. For case 3, pin the recorded pair (exit 255,
stderr containing `Directory not empty`), the shape T:6303's comment says both real occurrences had. T:6775 and T:6801 (exactly one `branch -d` / `HEAD^1 HEAD` line
using `<base tree>`) are retired against cases 1 and 6–7, because the tool now runs both from the base tree by construction. T:6822's needles stay in the
one-line refusal rule if they still read naturally there; otherwise they are retired against case 4.

- [ ] Cases red → implement → green → rewrite §9 tail → full `pnpm test` → commit with sizes.

### Task 4: `references/tracker.md` — the github-source path

Move the tracker-only text (~15k chars across 17 sites, as mapped before this plan — S:86-87, 104-127, 293-301, 398-406,
443-446, 498-519, 613-615, 751-764, 867-882, 951-952, 1181-1190, 1316-1325, 1418-1439, 1567-1571, 1605-1606, 1685-1687, 1704-1706 — re-locate after Tasks 1–3)
into one file, with headings that name the SKILL.md step each part belongs to.

- **Body:** "In a tracker project" shrinks to a single instruction: if the committed `backlog/source.json` says `github`, read `references/tracker.md` in full
  before §1. Each former site gets a ≤ 1-line marker ("Tracker: tracker.md §4 pull"). A file-store run never opens the file. A tracker run reads it once,
  so its floor is unchanged plus the markers. That is accepted.
- **The tracker merge and push lines are the exception:** they are literal git calls (global constraint) and stay in the body, as does the
  `pull --ff-only` line. Only their surrounding explanation moves.
- **Tests:** add a `skillText()` helper to `orchestrate.test.mjs` = body + every `references/*.md`. Re-point T:7820, T:7838, T:7875, T:7885, T:7900 and
  `skills/backlog/tools/backlog.test.mjs:4954-4966` to it where their needle moved, with needles and counts unchanged. Add `tracker.md` to T:4321's `FILES`.
  T:7838 needs the denied / rejected / park outcomes within 1600 chars after `push origin <base>`, and the push line stays in the body. So the body keeps
  the push line **plus one-line versions of its three outcomes** (S:1422-1437). Only their explanatory prose moves to `tracker.md`, and T:7838 stays
  pointed at the body unchanged.
- **New case:** the body names `references/tracker.md` inside a sentence containing `github` (guards the trigger, not just the filename).

- [ ] New case red → move text → re-point tests → full `pnpm test` → commit with sizes.

### Task 5: rare-path references

Each file is read on its trigger, which is the first thing its stub says.

| File | Content (re-locate after Tasks 1–4) | Trigger stated in the body |
| --- | --- | --- |
| `references/questions.md` | §3 "With questions" `decide` part (S:448-479); keep the S:490-494 answer-writing rule in the body, §4 uses it | the open-questions hunt finds one |
| `references/stopping.md` | §10 Pausing + Stopping (S:1608-1659) | a CLI call exits `6` or `10` |
| `references/merge-failures.md` | classifier denial of the merge (S:1333-1360), pre-merge refusal, conflict + the one fenced `merge --abort`, worktree-side resolve (S:1384-1403), runner-fix switch (S:1518-1544), `--base` outcomes 2/3 left after Task 1 | the merge call does not succeed, `merge-check` prints `overlap`, or `cleanup` prints `runnerFix` true |
| `references/check-failures.md` | §8 verify failures (S:1128-1170), §7 loop-2 and exhaustion (S:1034-1056) | `verify` exits non-zero, or a second review says fix |

- **Gap to fix while moving:** the worktree-side resolve says "on conflicts, park per the conflict branch". That branch's `merge --abort` targets the
  *base* tree, so the worktree-side merge is never aborted. `merge-failures.md` must say to abort it in the worktree
  (`git -C "$PWD/.worktrees/<id>" merge --abort`) before parking. T:3273's "exactly one fenced `merge --abort`" then becomes two. Re-point it to count
  base-tree aborts (`-C "<base tree>" merge --abort`) = 1 and add a case asserting the worktree abort exists in `merge-failures.md`.
- Every body line that today says "go to §10 Pausing / Stopping" (S:84, S:88, S:395, S:654, S:829-830) becomes "read `references/stopping.md`". Those
  lines are where the trigger is actually read.
- **Tests:** re-point T:3273, the test 'step 9 documents resolving on the branch side before parking' (T:3317), T:4364 and T:5182 (its slice now runs from `### Stopping` within `stopping.md`) to `skillText()` / the new file,
  with needles unchanged. Add the four files to T:4321's `FILES`. New case per file: the body names it in the same sentence as its trigger word (`exits`,
  `overlap`, `verify`, `question`).
- `references/recovery.md`'s pointer to "SKILL.md §2's merge probe" (T:7900) must still resolve: the probe stays in the body.

- [ ] New cases red → move → re-point → full `pnpm test` → commit with sizes.

### Task 6: re-extract inline rationale

Move the backstories left after Tasks 1–5 into `references/rationale.md` under headings matching the SKILL.md step. The ranked list below comes from the
pre-plan map; re-locate each item first, because earlier tasks will have moved or deleted some of them:
- `branch -d` tree reasoning
- §8 `BM_RUN_DIR` history (bug-31)
- exclude details (bug-37)
- Stopping's bug-43/52/54 bullets
- marker constraints
- why a denial gets no attention entry
- `BM_ORCH_RUN` and the Stop hook
- the four walls / `auto` vs `dontAsk`
- retry details (bug-31)
- prose-in-argv
- `--settings` POSIX vs zsh splitting
- the bug-39/43 pid copy
- the probe-note paragraph
- every `(#NNN)` / `bug-N` / `task-N` history clause

- **Rule per paragraph:** the body keeps the instruction as one statement in imperative form. The evidence moves. A paragraph that changes what you type is
  not rationale and stays.
- **Tests:** for each rule extracted, add one `[needle, rule]` pair to T:3641's `RULES`. The needle is a phrase from the kept one-line statement. Existing
  pinned phrases (`never rides a shell command line`, `never a verbatim quote of text this run did not compose`, `git revert -m 1`, …) stay in the body
  verbatim.
- **New case:** the body contains no `bug-[0-9]+`, `task-[0-9]+` or `(#[0-9]+)` reference outside fenced blocks. History belongs in rationale. Allowlist
  any that are genuinely instructions, with a comment saying why.

- [ ] New case red → move paragraphs and add `RULES` pairs → full `pnpm test` → commit with sizes.

### Task 7 (conditional): `inspect <id>`

**Do this only if the body is still > 65k chars after Task 6.** Folds §5's `stage inspecting` + `usage` + `denials` + the item-file location check into one
call printing `{ usage: "recorded" | "no-result", denials, item: "done" | "open-with-outcome" | "no-outcome", itemPath }`. Tracker projects also run
`snapshot` and read `<dir>/outcomes/<n>.md`. Unreadable transcript → exit 1, as `denials` does today. Judging whether an Outcome is real verification
output stays in the body.

Cases: done item with `## Outcome` → `done`; open item with Outcome → `open-with-outcome`; neither → `no-outcome`; `stream-denial.jsonl` → `denials: 1`;
`stream-no-result.jsonl` → `usage: "no-result"`, exit 0; malformed transcript → exit 1; tracker with empty outcome file → `no-outcome` and
`<dir>/items/<n>.md` written. Re-point T:3437/T:6022 so §5 accepts `orchestrate.mjs" inspect <id>` in place of the separate `denials`/`usage` lines.
§7 keeps its own lines and its assertion unchanged.

### Task 8: stop it growing back

- Follow the repo's three-tier rule layout, which `test/claude-rules.test.ts` guards:
  - **Tier 1, `CLAUDE.md` `## Invariants`:** one headline-only bullet, `- **A new orchestrate rule enters SKILL.md as one statement; its story and its rare branches go to references/.** Why: [invariants.md](docs/subsystems/invariants.md#<anchor>)`.
    The guard's `HEADLINE_ONLY` regex allows nothing after the link.
  - **Tier 2, `docs/subsystems/invariants.md`:** a new section at that anchor. It carries the reasoning: the body is resident for every turn, a reference
    stays resident once read, and so only never-read branches and tool-replaced prose actually leave the floor. Include the 2026-09-01 → 2026-10-05 growth
    numbers.
  - **Tier 3, `.claude/rules/skills.md`:** the mechanism bullet: where the story goes, how to state the trigger, and to add a `RULES` pair. First confirm its
    `paths:` covers `skills/**`. The headline must match tier 1 byte for byte, per the guard.
  - **`docs/subsystems/skills.md:126-133`:** gains a sentence naming the new references, with a plain link (not a `Why:` link).
  - Run `pnpm run test:jest -- claude-rules` before committing.
- **Informational size report:** one test in `orchestrate.test.mjs` emits `t.diagnostic` with the body's char count, the 2026-09-01 baseline (60,168) and
  this plan's final number. **It never fails.** Hard size budgets have compressed load-bearing rules away twice on this machine (recorded in the user's
  global CLAUDE.md). The report makes growth visible in every test run instead.
- Update this plan's Status line with the final measured size.

- [ ] Edit docs → add the diagnostic test → full `pnpm test` → commit.

## Verification at the end

- `pnpm test` and `pnpm run typecheck` green on the branch.
- `wc -c skills/backlog-orchestrate/SKILL.md` recorded per task (in commit messages) and in the Status line.
- Dry check: `node …/orchestrate.mjs` with no args lists `merge-check`, `leftover`, `worktree`, `cleanup` (and `inspect` if built) in `USAGE`.
- After the user pushes and runs `pnpm run plugin:sync`, the **next real run** is the acceptance test. Measure its injected skill size off the transcript,
  the same way the 2026-09-01 plan measured 60,168, and record it here. A run that parks or stops on something these tasks touched is a regression to fix
  before the next run, not a note.

## Out of scope

- The bedrock floor (system prompt, MCP servers, tool schemas). That is the dashboard's spawn argv, a cross-repo change, as in 2026-09-01.
- Per-item child sessions for the orchestrator. That is the larger architectural lever on the 34% per-item growth, and needs its own design.
- `backlog-groom` (436 lines) and `backlog-execute` (338 lines). Revisit after this lands, using the same levers.
