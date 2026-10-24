# backlog-groom gets a PR finish; groom and execute PRs can auto-merge and fix themselves

Date: 2026-10-24. Status: draft, awaiting approval.

## Why

A groom that brainstorms to "a project with a written design" writes a spec under `docs/superpowers/specs/` and a plan into the item. Where those bytes land
today is the shared checkout, usually `main`: brainstorming says the spec is "committed in a software repo", and a board-dispatched groom's prompt ends in
`COMMIT_RULE` ("commit the work … Do not push."), while the groom SKILL.md says it never commits. Whichever wins, the result is useless on most projects: their
`main` does not accept pushes, so a spec committed there is stranded, and one left uncommitted is invisible to everything downstream. Two more costs follow from
the same gap:

- on a **tracker** project `## Plan` cites the spec by a `blob/<sha>` permalink, which is dead until that commit is pushed;
- on a **files** project the groomed item is "on disk only", and an orchestrator run skips it until somebody commits it by hand.

`backlog-execute` already solved the shape for its own work — `--finish pr`: a worktree cut from the base, a branch, a push, a PR that is never merged by the
skill. A groom needs the same exit.

The second half is what happens after the PR opens. Today both skills stop there, and a person has to watch CI, merge base back in when it moves, and press
merge. GitHub already has auto-merge; the user wants a launch to be able to arm it and to keep the PR mergeable while it waits.

### Context: can a `claude -p` groom reach the spec/plan phase at all?

Settled during brainstorming, recorded so the builder does not re-ask it:

- **Board-dispatched groom** — the dashboard spawns `claude -p --session-id`, and every reply is `claude -p --resume`. Brainstorming's questions end a turn,
  the person answers in the dashboard, and the next process continues; `AskUserQuestion` works too, because the dashboard's PreToolUse hook holds the call
  until the panel or phone answers (`claude-agents-dashboard/server/lib/pending.ts`). So yes: it reaches the project size, writes a spec, runs writing-plans.
- **Bare `claude -p "/backlog-groom …"`** (no dashboard, no resume) stalls at the first question. Not changed by this work.
- **Tick groom** (`[backlog-tick]`) never brainstorms and never writes a spec, and that is correct, not a gap: nobody is there to answer. A brainstorm in a
  tick would ask in prose and end the turn, the `-p` process would exit before `record`, a later tick's `recover` (`tick.mjs`) would abandon the item and
  bench it, and the failure would count toward the halt breaker — so every design-sized groom would become a failed tick. Not changed by this work.

The line that matters is **attended vs unattended**, not "headless": a board-dispatched groom is `claude -p` but attended (a person replies through the
dashboard), so it brainstorms; a tick is unattended, so it never does. This design keeps that line exactly where it is. It does **not** need tick grooms to
produce a spec — `--finish pr` is a board launch's choice, and `tick.mjs` never passes it to a groom. A future "brainstorm from assumptions" mode for ticks
would be a separate design.

The superpowers 7.0.0 size-name break that briefly made grooms skip the spec is already fixed (#358) and is not part of this.

## Goals

1. `backlog-groom` accepts `--finish pr --base <ref>`, exactly as execute does, and in that mode writes everything it writes in a worktree of its own, then
   commits, pushes and opens one PR into the base.
2. The launch sheet offers Finish (In place | PR) and Base for a groom, as it does for an execute.
3. For any launch whose finish is PR — groom or execute — the sheet offers two checkboxes: **Auto-merge** and **Fix if it fails**.
4. Auto-merge: after opening the PR, the session arms GitHub auto-merge — only when the repository allows it, checked at runtime with `gh`. Not allowed → one
   line says so and the PR stays open. Once armed, the session stays alive and waits for the merge, bounded in wall clock ("### Wait" below).
5. Fix if it fails: while it waits, the session also fixes a failing check or a conflict with the base — commits and pushes again — bounded in rounds, until
   the PR merges or a bound is hit.

## Non-goals

- Review comments (CodeRabbit or human) are not something the fix loop acts on. Failing checks and base conflicts only.
- A separate "fix session" dispatched later by the board or the dashboard. The fixing session is the one that opened the PR.
- Ticks: neither tick's groom nor tick's execute gains auto-merge or fix. The one tick change is defensive: `tick.mjs` learns to skip a groom's pr-mode tree
  and branch ("The guard while the PR is open").
- The orchestrator: its merge modes are untouched; it still owns its own merges.
- A groom on a remote machine. Today a remote execute is forced to PR; a groom has no finish on any machine. This work gives a groom a finish on THIS machine
  only — a groom body naming a remote machine and a finish is a 400, exactly as a finish on a groom is today.
- Jira's Run and its **Open MR when done** switch.
- A per-project board setting for auto-merge. "Allowed by the project" means GitHub's own repository setting.
- Bare `claude -p` grooms becoming able to brainstorm.

## Anti-goals (failure even if it technically works)

- **A merge nobody asked for.** Auto-merge is armed only when the trigger carries the flag, composed server-side from the checkbox; generic "merge" wording in
  a prompt arms nothing, and a typed `--auto-merge` in the editable body is refused the way a typed `--finish` is.
- **A force-push, a rebase of a pushed branch, or a merge of the PR by the skill itself.** The fix loop only ever adds commits on top; GitHub does the merge.
- **A loop that never ends.** A session that sits forever on a PR that will never go green is worse than one that stops and says so.
- **The in-place groom changing.** A groom launched In place must produce the same prompt and the same behaviour as today.
- **A fix that lands unverified.** A fix commit runs the same verification the original work did before it is pushed.

## Decided by the user

- Groom gets a PR finish in the skill and on the launch sheet, modelled on execute's.
- Auto-merge and fix apply to **both** groom and execute PR finishes.
- Fix covers **failing CI checks** and **merge conflicts with the base**. Not review comments.
- **The same session waits** and fixes; no separate later session.
- "If allowed by the project" means **GitHub's repository setting** ("Allow auto-merge"), checked by the skill with `gh` at runtime.
- Whether Auto-merge and Fix start on is **configurable in Settings**, as two defaults the sheet's toggles seed from.

## The trigger

One signal per behaviour, all composed server-side by `finishClause` from validated fields, never from the editable text:

| Token          | Meaning                                                                     | Legal beside                    |
| -------------- | --------------------------------------------------------------------------- | ------------------------------- |
| `--finish pr`  | worktree, commit, push, PR (existing for execute; new for groom)            | groom, execute                  |
| `--base <ref>` | the PR's base (existing)                                                    | `--finish pr` only              |
| `--auto-merge` | arm GitHub auto-merge on the PR this session opened                         | `--finish pr` only              |
| `--fix`        | stay, watch the PR, fix failing checks and base conflicts within the bounds | `--finish pr --auto-merge` only |

A skill that sees `--auto-merge` or `--fix` without `--finish pr`, or `--fix` without `--auto-merge`, stops and names the rule — never a quiet fallback, the
same stance execute takes on a doubled or unknown `--finish`.

**Why `--fix` requires `--auto-merge` (my call):** fixing a PR that nothing will merge keeps a session alive to make a PR green for a person who has to come
back anyway; the user described fix as a companion of auto-merge. The sheet disables the Fix checkbox until Auto-merge is ticked.

## The groom `pr` flow

The groom's own steps are unchanged — pick, claim, brainstorm, plan, write the item, `stop`. What `pr` mode changes is **where** every write lands and what
happens after the last one. It lives in a new reference file, `skills/backlog-groom/references/pr-mode.md`, read in full once when the trigger carries
`--finish pr`; SKILL.md gains one short "Finish mode" section pointing at it, mirroring execute's.

1. **Resolve the mode** — `<base>` as execute's pr-mode §1 resolves it. Say `finish mode: pr → PR into <base>` (plus `, auto-merge` / `, fix` when present) in
   one line and ask nothing about it.
2. **Pick the tree** — a new worktree cut from `<base>`, on branch `groom/<id>`, set up the way execute's pr-mode §2 sets one up (same location rules, same
   "no local `<base>` → stop" check, same refusal-leaves-nothing rule). `show`, `start --as groom`, every item write and `stop` run in that tree. *My call:*
   no reuse-the-starting-tree branch — a groom has no prior commits to continue, and one rule is easier to keep true than two.
3. **Brainstorm and plan** — unchanged, every command run as `cd <tree> && …` (execute's pr-mode §2 "Every command runs in that tree"), so the code it reads
   is `<base>`'s. The spec, when the size is "a project with a written
   design", is written into the tree. Brainstorming's own "commit the spec" step is folded into step 5 — one commit for the groom, not one per document.
4. **Write the item** — unchanged in content. On a **files** project the item is a file in the tree and is written before the commit, as today. On a
   **tracker** project the `## Plan` permalink cannot carry the final sha before the commit exists, so the order is: commit the spec (step 5), push (step 6),
   then write the issue — `new … --from <id>` for a promote, `body` for a bug — with `blob/<sha>` of the pushed commit, then open the PR (step 6). GitHub keeps
   PR commits reachable through `refs/pull/<n>/head`, so the permalink survives a squash merge. **A tracker groom in `pr` mode writes its plan with the
   `plan-review` mark** (the tick's mark: `--plan-review` on `new`/`body`, the label on GitHub), whenever it opens a PR — see "The guard while the PR is open".
5. **Commit** — stage only the files this groom wrote (the spec, the plan document if any, and on a files project the item's new and removed files). Never
   `git add -A`. One commit, message `docs(groom): <item title>` (*my call* — it passes `ci / pr-title` when used as the PR title, and a groom is docs).
6. **Push and PR** — `git push -u origin groom/<id>`; on a tracker project the issue write of step 4 comes next; then `gh pr create --base <base>`. Body: what
   was groomed (verdict, item id), the spec path, the plan's first lines, and on a tracker project `Refs #<n>`, where `<n>` is the issue that now holds the
   plan — the new task's number on a promote (the idea it came from is closed by the promote, as today), the bug's own number on a bug. Never `Closes`: that
   issue is the item, and it stays open to be executed.
7. **Nothing to commit** — whatever the source, when step 5 would stage nothing: a tracker groom that wrote no spec (the groom already lives on GitHub), or any
   groom that ended without a verdict — a refusal, a stand-down on an item already in progress, no verdict reached — after §2 cut the tree. Say
   `nothing to commit — no PR` with the reason in one line, remove the worktree and branch it made, and end as today.
8. **Auto-merge / fix** — when flagged, the shared procedure below.
9. **Final message** — PR URL (or the exact `gh pr create` to run by hand and why), branch, absolute worktree path, and the auto-merge outcome. The
   "Groomed on disk only" line is not printed in `pr` mode — the commit exists; once the PR merges, an orchestrator run on `<base>` sees the item.

### The guard while the PR is open

*My call — the user was asked and did not pick; check this one.* The rule is: **the item becomes executable when its groom PR merges, not before.**

- **Files project:** no mark. `<base>` holds the un-groomed item until the PR merges, so no gate can execute it; the merge IS the approval. Known
  limitation, stated in the final message the way execute's pr-mode §9 states its own: until the PR merges, the main checkout shows the item un-groomed, so a
  second groom from the board would groom it again.
- **Ticks on a files project:** `tick.mjs` scans every linked worktree for a `started:` marker and skips only `.worktrees/<id>` and `.worktrees/execute-<id>`
  (`isSkippedTree`), and excludes an item from execute while `execute/<id>` or `.worktrees/execute-<id>` exists (`executeTaken`). A pr-mode groom's tree,
  `.worktrees/groom-<id>`, holds a `started:` marker while it works — and forever if the session is killed — which would block every tick on that project.
  So `isSkippedTree` also skips a `groom-` prefix, and a `groomTaken` twin of `executeTaken` (`groom/<id>` branch or `.worktrees/groom-<id>` tree) excludes
  the item from a tick's groom candidates. The pr-mode tree is therefore exactly `.worktrees/groom-<id>`, on branch `groom/<id>` — named here because
  `tick.mjs` depends on the spelling.
- **Tracker project:** the issue body is live the moment it is written, so the plan goes out carrying `plan-review` (step 4). Every gate already honours that
  mark (`planReviewBlock`, `shared/agent.ts`; the orchestrator; `tick.mjs`). It comes off in exactly one of two ways:
  - the session saw the PR merge — with `--auto-merge` armed, the session always waits ("### Wait" below) and on `MERGED` runs
    `backlog.mjs plan-review <id> off`;
  - otherwise a person approves it on the board, exactly as for a tick's groom — this covers no auto-merge, auto-merge not allowed or refused, and a wait
    that hit its bound or ended `CLOSED` before the merge. The final message says the mark is still on and gives the `plan-review <id> off` command.
- Side effect, expected: a tick counts its groom room off `plan-review` labels (`tick.mjs`, `--max-plans`), so a board pr-groom waiting on its PR takes one
  of those slots until it merges. Not a bug.
- A tracker groom that opened **no** PR (step 7: no spec written) writes no mark — there is no unreviewed document behind the plan, the same as an in-place
  groom today.

**No reviewer.** *My call:* execute's `backlog-reviewer` reviews code against invariants; a groom PR is a spec and a plan, which the person reads in the PR. Not
dispatching it keeps a groom PR cheap. (`/doc-review` is not run either — it is interactive and belongs to the person.)

**Refusals** follow execute's pr-mode §8 "When a step is refused" verbatim in spirit: a denied `git`/`gh` call stops the git steps, never retried another way;
a rejected push is reported with git's words; no `gh` → branch pushed, PR command printed.

## Auto-merge and fix (shared by groom and execute)

One procedure, one file: `skills/backlog-execute/references/auto-merge.md`, read by both skills' pr-mode files when the trigger carries `--auto-merge`.
(*My call* on the location: execute owns the existing PR machinery; groom already reaches into sibling skills by absolute path.) It runs after the PR is open,
and — for execute — after the tracker label/comment/stop sequence, so the issue's guard is in place before the session starts waiting.

### Arm

1. Read the repository's settings: `gh api repos/{owner}/{repo} --jq .allow_auto_merge` for the auto-merge switch (`gh repo view --json` has no such field
   in gh 2.102.0), and `gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed` for the methods.
2. `allow_auto_merge` not `true` → one line: `auto-merge: not allowed on <owner>/<repo> — PR left open`. No wait, no fix. End as a plain PR finish.
3. Merge method: squash if allowed, else merge commit, else rebase (*my call*: matches this repo's squash-only `main`, and every other method is a fallback).
4. `gh pr merge <n> --auto --<method>`. If GitHub reports nothing is pending (no required checks, PR already mergeable), `gh` merges directly — which is what
   the person ticked. The builder confirms `gh`'s actual behaviour here and records it in the reference file.
5. Any refusal (permission denial, GitHub error) → report it, leave the PR open, no wait, no fix.

### Wait (always, once armed)

A foreground loop in the PR's worktree. Nothing in the background — the foreground-only rule both skills already carry holds. It runs inside the turn that
opened the PR, because a `claude -p` process exits when its turn ends. The dashboard puts no cap on a turn's length (`claude-agents-dashboard/server/lib/
spawn.ts` times out only its version probe; a session ends by finishing or by Stop), so a 45-minute turn is allowed; a person's Stop ends the loop like any
other session.

- **Watch:** `gh pr view <n> --json state,mergeable,mergeStateStatus,statusCheckRollup` plus `gh pr checks <n> --watch` bounded per call (the Bash tool caps a
  call at 10 minutes, so the wait is a sequence of bounded calls, not one).
- **Merged** → done. Groom on a tracker project: `backlog.mjs plan-review <id> off`. Execute: changes nothing on the issue — with `Closes #<n>` GitHub closes
  it and `in-review` goes with it; with `Refs #<n>` the issue stays open with `in-review` on, and the final message lists pr-mode §9's hand steps as today.
- **Closed without merging** → stop, report.
- **Wall clock:** **45 minutes** from arming (*my call*, a soft default stated in the file). Hit without a merge → stop, leave auto-merge armed (a person's
  later push still merges it), and report what is pending or red. Without `--fix`, a red check or a conflict also ends the wait at once — nothing will
  change it — and is reported the same way.

### Fix (only with `--fix`, inside the wait)

- **A failing check** → read the failing job's log (`gh run view <run> --log-failed`), fix in the tree, run the item's verification (execute: the same command
  verification used; groom: whatever check the failing job runs, locally), commit (`fix: <what>`, narrow staging), push. One round.
- **Conflict with base** (`mergeable: CONFLICTING`) → `git fetch origin <base>` and `git merge origin/<base>` in the tree, resolve, verify, commit, push. One
  round. Never rebase, never force.
- **Rounds (my call, a soft default stated in the file):** at most **3** fix rounds, inside the wait's 45 minutes. A fourth red result → stop as the wall
  clock does: auto-merge left armed, what is red and why reported.
- **Not fixable** — a check failing for a reason outside the PR's diff (infra, a flaky job twice in a row, a secret missing) → stop and report rather than
  edit unrelated code. The test for "outside the diff" is the builder's to word.
- **Re-review (my call):** execute does not re-dispatch `backlog-reviewer` for a fix round; the fix is verified, and the commit is on a PR a person can read.
  The final message lists every fix commit.

### The claim while waiting

Execute on a tracker project already releases its claim after the push (`stop --keep-started`) and leaves `in-review` as the guard; the wait happens after
that, holding no claim. Execute on a files project and groom in both sources likewise release before the wait. A session waiting on CI holds nothing that
blocks another session.

## The server

`POST /api/agents/dispatch`, `server/src/agents/agents.service.ts`:

- `finish` and `base` become legal on a groom (rule 2 changes from "execute only" to "execute or groom"). On a remote machine a groom body with `finish` is a
  400 (non-goal above); a remote execute stays forced to `pr`.
- New optional booleans `autoMerge` and `fix` on `AgentDispatchRequest` (`shared/types.ts`). Rules, run with the shape rules before the item lookup: either one
  without finish `pr` → 400; `fix` without `autoMerge` → 400; a non-boolean → 400. Absent means false, so an old tab keeps working.
- Rule 5 (refuse `--finish`/`--base` typed into the body) extends to `--auto-merge` and `--fix`, and to groom bodies as well as execute ones.
- The groom prompt's closing clause moves out of the editable text the way execute's did: `composePrompt` stops appending `COMMIT_RULE` for groom, and dispatch
  appends `finishClause(action, finish, base, { autoMerge, fix })` for groom as for execute. For an in-place groom that clause IS `COMMIT_RULE`, so the final
  prompt of an In place groom is byte-identical to today's (anti-goal). Capture keeps `COMMIT_RULE` in its text, unchanged.
- **A groom body from a sheet opened before the deploy** already ends in `COMMIT_RULE`. *My call:* dispatch strips one exact trailing `COMMIT_RULE` from a
  groom body before appending the clause, so an old tab neither doubles the rule nor, under a PR pick, sends "Do not push." beside `--finish pr`.
- `finishClause` (`shared/agent.ts`) **takes the action** (*my call*, from the builder check): today's pr sentence says the skill "commits, reviews, pushes"
  (`shared/agent.ts:938`), and a groom PR has no reviewer, so the groom sentence drops "reviews". The execute sentence with no flags stays byte-identical to
  today's (its quote pin in `test/agents-shared.test.ts` keeps passing); the groom sentence gets a pin of its own. The two flags are spelled inside the
  existing backticks: ``Finish with `--finish pr --base main --auto-merge --fix`: …``, the sentence adding that GitHub merges once checks pass and the session
  fixes failing checks and conflicts until then. The sheet previews this same function, so preview and spawn cannot drift.

## The client

`client/src/components/board/LaunchSheet.tsx`:

- Finish and Base render for `groom` as well as `execute` (today: `isExecute`). Branches are fetched for both.
- Under finish = PR: two toggles in their own row — **Auto-merge** and **Fix if it fails** — the second disabled until the first is on, and cleared
  when Auto-merge is cleared or Finish leaves PR. A note under them: "Needs Allow auto-merge on the GitHub repo; checked when the PR opens." Visual language:
  the sheet's existing `Switch` (Remote control, `LaunchSheet.tsx`; Jira's "Open MR when done" is one too) under `.claude/DESIGN.md` §8 — "checkbox" in this
  document means that control. The builder cites the subsection.
- **Both toggles seed from Settings** (user's decision, after the first draft had them always start off): two new rows on the Settings page that holds
  Execute default finish — **Auto-merge PRs** (`prAutoMergeDefault`, boolean, default `false`) and **Fix if it fails** (`prFixDefault`, boolean, default
  `false`) — clamped in `clampSettings` by one new boolean helper shared by both keys (a non-boolean reads as `false`). One pair for both groom and execute, because the toggles mean the
  same thing for both. Seeded once per sheet open and from nowhere else — never from the last launch — the rule model/effort/finish already follow. In
  Settings the Fix row is disabled while Auto-merge is off, the sheet's own dependency; a stored `prFixDefault: true` beside `prAutoMergeDefault: false`
  seeds Fix off. The seed applies only when the sheet's Finish is PR; flipping Finish to PR mid-sheet re-applies it, and leaving PR clears both. The defaults
  never reach a launch on their own: the sheet shows the toggles' state before Launch, and only the request body's booleans, composed from what the sheet
  shows, set the flags — so the anti-goal "a merge nobody asked for" still holds.
- The groom finish seeds from a new Settings row, **Groom default finish** (`groomDefaultFinish`, `client/src/lib/settings.ts`, clamped like
  `executeDefaultFinish`, default `in-place`), shown next to Execute default finish in `SettingsView.tsx`. *My call*: projects with a protected `main` want
  PR every time, and a default is how execute already serves that.
- On a remote pick, the groom's Finish is not drawn (non-goal); execute's is locked to PR as today and its checkboxes are offered.

## Invariants this changes (deliberately)

- **"`backlog-orchestrate` is the only skill that merges; `backlog-execute` commits and pushes its own branch only in `pr` mode."** Becomes: orchestrate is the
  only skill that runs a merge into a base; execute and groom commit and push their own branch only in `pr` mode, and may **arm GitHub auto-merge** on the PR
  they opened when the trigger says `--auto-merge` — GitHub performs the merge. The fix loop's `git merge origin/<base>` into the PR branch is a merge INTO
  the item's branch, not into the base, and is named as such. Update the headline in CLAUDE.md, its `.claude/rules/` home (byte-equal headline, guarded by
  `test/claude-rules.test.ts`), its `invariants.md` section, `docs/overview.md`, and the description in `skills/backlog-orchestrate/SKILL.md` (line 9) together.
  The rule's home, `.claude/rules/orchestrator.md`, also needs its mechanism body updated ("Execute is the one other skill that writes git", "it never
  merges"), not only the headline.
- **Groom "never commits"** (SKILL.md header and hard limits) gains its `pr` exception, worded as execute's is.
- **"Dispatch derives the action; it never accepts one"** — untouched; finish is not an action.

## Docs to update

`docs/subsystems/skills.md` (groom's finish mode; the auto-merge procedure), `docs/subsystems/board.md` (the sheet's new controls, the Settings row),
`docs/subsystems/api.md` (the dispatch body and its new 400s), `docs/subsystems/invariants.md` (above), and the skills' own SKILL.md descriptions where they say
"never merges" / "never commits".

## Tests the builder owes

- `finishClause`: in-place unchanged byte for byte; execute pr with no flags unchanged byte for byte; groom pr says no "reviews"; each flag combination;
  flags only ever appear inside the backticks.
- Dispatch: a groom body ending in `COMMIT_RULE` (old tab) is sent with exactly one closing clause.
- Dispatch: groom with `finish: 'pr'` + base accepted; groom remote + finish → 400; `autoMerge`/`fix` without pr → 400; `fix` without `autoMerge` → 400;
  non-boolean → 400; typed `--auto-merge`/`--fix` in a groom or execute body → 400; an in-place groom's spawned prompt equals today's exactly.
- `composePrompt` for groom no longer ends in `COMMIT_RULE`, and dispatch's final in-place groom prompt still does.
- LaunchSheet: Finish/Base drawn for groom; checkboxes only under PR; Fix disabled until Auto-merge; leaving PR clears both; the request body carries the
  booleans only under PR.
- `tick.mjs`: a `started:` marker inside `.worktrees/groom-<id>` does not block a tick; an item with a `groom/<id>` branch or `.worktrees/groom-<id>` tree is
  not a groom candidate; `.worktrees/execute-<id>` and `.worktrees/<id>` behave as today.
- Settings: `groomDefaultFinish` clamps an unknown value to `in-place`; `prAutoMergeDefault` / `prFixDefault` clamp a non-boolean to `false`; the Fix row is
  disabled while Auto-merge is off.
- LaunchSheet: toggles seed from the two defaults when Finish is PR; `prFixDefault: true` with `prAutoMergeDefault: false` seeds Fix off; flipping Finish
  away from PR and back re-seeds.
- The skills' prose is not unit-tested; the builder runs one real groom in `pr` mode against a scratch GitHub repo with auto-merge allowed, and one with it
  disallowed, and records the transcripts' outcome lines in the PR.

## Left to the builder

- Exact wording of the reference files, the sheet's note, and the `finishClause` sentence.
- How "a failure outside the diff" is judged in the fix loop.
- Whether `gh pr merge --auto` on an already-mergeable PR merges directly or errors on the `gh` version installed, and the reference file's line for it.
- Worktree location and branch-name collision handling, following execute's pr-mode §2 conventions.
