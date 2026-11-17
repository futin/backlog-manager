# PR conflict resolution from the board — design

Status: draft, 2026-11-17, builder-checked. Approach B picked (a new skill the board triggers).

## Intent

A pull request on the board's GitHub page that shows `conflicts` today has no way forward from the page: Update branch is closed on it
([`client/src/lib/prs.ts`](../../../client/src/lib/prs.ts) `updateBlock` — "a person resolves it in a checkout, and nothing on this page can"), so somebody has
to stop, open a checkout, merge the base in and push. This feature makes that one click: **Resolve conflicts** on a conflicting PR starts a headless dashboard
session, on the default model and effort, that merges the base into the PR's branch, resolves the conflicts, proves the result, and pushes — and that stops
without pushing anything when a conflict needs a judgment call a person should make.

`backlog-execute --finish pr --auto-merge --fix` already fixes conflicts, but only on the PR its own session opened and only while that session waits for the
merge. A PR that went conflicting later, or one a person opened by hand, has nothing.

## Goals

- One click on a conflicting PR starts the fix. No launch sheet, no model or effort pick: the dashboard's default model (`DEFAULT_MODEL`) and default effort.
- The session runs unattended in dashboard (headless) mode and never asks a question.
- A conflict whose right resolution is not mechanical is never guessed at: the session aborts the merge, pushes nothing, and says on the PR which files and why.
- A resolution that is pushed has been proved by the project's own checks first.
- The PR branch's history is only ever appended to — a merge commit, a normal push.
- The procedure is a skill, runnable from a terminal as well as from the board, so a later change can point `backlog-execute --fix` at it.

## Non-goals

- Automatic start when a PR turns conflicting. The user picked one click; nothing spawns unasked.
- PRs from forks (`crossRepository`): the session usually cannot push to them.
- GitLab MRs and the Jira page's MRs. GitHub PRs on the GitHub page only.
- Remote machines (multi-dashboard). Home only, as the PR page's other writes are.
- Rewiring `backlog-execute --fix` to call the new skill. Named as possible, not done here.
- Fixing failing checks that are not caused by the merge. The session proves its merge; it does not repair a red base.

## Anti-goals (a failure even if it technically works)

- A pushed merge that compiles and passes but quietly drops or reshapes one side's behaviour.
- A rebase, a `--force` or `--force-with-lease` push, or any rewrite of the PR branch's existing commits.
- A change to the main checkout or to any local branch the user has: the session works in its own detached worktree and removes it.
- Two sessions resolving the same PR at once.
- The server writing git or posting to GitHub for this feature. The session does both; the server only spawns it.

## Constraints from the repo

- **The server never writes git** and never spawns git synchronously (CLAUDE.md invariants). The route only reads GitHub (one `readPull`) and spawns.
- **Dispatch derives the action; it never accepts one.** The route takes a repo and a PR number, re-reads the PR, and composes the trigger itself. No prompt
  text crosses the wire.
- **A repo whose sync is off refuses every write path.** A resolve pushes to the repo, so sync-off refuses it, the same as Merge and Update branch.
- **`agents/`, `tracker/`, `jira/`, `gitlab/` are the only outbound modules.** The route lives in `agents/` (it spawns) and reads the PR through the tracker
  module's existing `readPull`, not a new client.
- **`skills/` is the plugin skill root**, and editing it changes nothing until commit, push and `pnpm run plugin:sync`. The plugin now has ten skills; CLAUDE.md's
  "nine skills" line and [docs/subsystems/skills.md](../../subsystems/skills.md) say so.
- **A skill's tool is self-contained**: imports nothing from another skill's `tools/`, `server/` or `shared/` (`.claude/rules/skills.md`).
- Every server route lives under `/api`.
- **`backlog-orchestrate` is the only skill that merges INTO a base.** This skill merges the base into a PR's head branch, the direction `--fix` already takes;
  it never pushes to the base. The invariant's wording in CLAUDE.md and invariants.md gains `pr-resolve` beside execute and groom as a skill that pushes a
  branch it does not own the base of, so the rule stays exact.

## Approaches

- **A. Server-composed prompt** (the Jira launches' pattern): the route builds the whole procedure as prompt text. Smallest, ships without a plugin release, but
  the procedure lives in a TypeScript string, cannot run from a terminal, and `--fix` keeps its own copy. Not picked.
- **B. A new skill the board triggers — picked.** `skills/pr-resolve/` owns the procedure; the route spawns `/backlog-manager:pr-resolve <owner>/<repo>#<n>`.
  One procedure for board, terminal and later `--fix`; matches how execute, groom and tick are launched. Costs a plugin sync to ship and one more skill.
- **C. Reuse `backlog-execute --fix`.** Dropped: execute is bound to a groomed backlog item and refuses anything else; a PR has no item.

## Decided with the user

- Trigger: one click, no sheet, default model/effort, dashboard mode.
- Hard cases: if any conflict is a judgment call, abort, push nothing, leave a note on the PR and in the session's final message.
- Red base: a failing check that also fails on the base is not the merge's; push, and name it in the note. Abort only on failures the merge introduced.
- After a stopped resolve the board shows the last outcome (reason + session link) until the PR changes or the next click.
- Approach B.

## Design

### The skill — `skills/pr-resolve/`

Trigger: `/backlog-manager:pr-resolve <owner>/<repo>#<number>`, run from the PR repo's main checkout (the board spawns it there). Headless-safe: it never asks.
Each stop below ends the session with a final message naming the stop; the ones after a `gh` read also comment on the PR (step 7).

1. **Preflight.** Parse the argument; refuse anything not `owner/repo#N`. Confirm the checkout's `origin` is that repo. Read the PR with `gh pr view`:
   stop unless it is open, `CONFLICTING`, and not cross-repository. Record the head ref, the base ref and the head SHA.
2. **One at a time.** The worktree path is fixed per PR (`.worktrees/pr-resolve-<N>` under the main checkout). If it already exists, stop: another resolve is
   running or one died and left it — the message says which path to remove. This is the guard that survives a server restart; the server's own guard
   (below) is the fast one.
3. **Worktree.** `git fetch origin <head> <base>`, then a **detached** worktree at `origin/<head>`. Detached so a local branch of the same name — checked out
   elsewhere, or ahead or behind origin — is never touched.
4. **Merge.** `git merge --no-ff origin/<base>`. If it merges clean (GitHub's mergeable flag was stale), skip to step 6.
5. **Classify every conflicted hunk** as mechanical or judgment. Mechanical, resolved by the session: both sides added independent entries to the same list,
   import block or registry; non-overlapping edits that git could not align; a rename on one side and an unrelated edit on the other; formatting-only
   differences; a lockfile or generated file (regenerated with the project's own package manager or generator, never hand-merged). Anything else is a judgment
   call: both sides changed the same logic, a deletion on one side and an edit on the other, a semantic choice between two behaviours, or any hunk the session
   is not confident about. **One judgment hunk aborts the whole resolve**: `git merge --abort`, remove the worktree, go to step 7 with the list. The skill's
   text gives worked examples of each class; the line between them is the skill's main content.
6. **Prove it.** Run the project's checks that cover the files the merge touched, as the repo's own CLAUDE.md or `package.json` defines them (typecheck plus
   the affected test suites at minimum). A check that fails is re-run on `origin/<base>` in a second detached tree: a failure the base has too is not the
   merge's — the session goes on and the note names it. A failure only the merged tree has aborts exactly as a judgment stop does, with the failing output
   summarised in the note. A check that cannot run (no test command found) is said in the note, never treated as green silently; the session still pushes a
   mechanical-only resolution in that case. (User's pick: push when the merge added no failure.)
7. **Commit, push, report.** The session's final line is machine-readable: `pr-resolve: pushed` or `pr-resolve: stopped — <one-line reason>`. Commit the merge with git's default merge subject and a body listing each resolved file and how. `git push origin HEAD:<head>` —
   never forced. A rejected push (the head moved since step 1) is a stop: nothing is retried, the note says to click again. Remove the worktree. Post one
   `gh pr comment`: on success, what was resolved and which checks ran; on a stop, which files and hunks were judgment calls (or which checks failed) and
   that nothing was pushed. Final message mirrors the comment.

A small `tools/` CLI may own the deterministic parts (parse, preflight read, worktree path, conflicted-file listing); the classification and resolution are the
model's. Builder's call on the split.

### The route — `POST /api/agents/dispatch-pr-resolve`

In `agents/`, beside `dispatch-jira`. Body: `{ repo: string /* owner/name */, number: number }`. Nothing else is read — no model, effort, prompt or mode.

Refusal order (each a 4xx with a reason the client draws, the existing dispatch conventions for codes):

1. Malformed body → 400.
2. Repo not a registered GitHub-tracked project → 404/400 as the existing PR writes answer it.
3. Sync off for the repo → 409, `sync is off`.
4. Home dashboard not reachable or agents off → the existing `projectDispatchGate` refusal.
5. A resolve this server started for the same PR still live on the dashboard → 409, `resolving…` (the in-memory map below).
6. Fresh `readPull`: not open, not conflicting, or cross-repository → 409 with which.

Then spawn through `AgentsService.spawnInProject` on the project's main checkout: prompt is exactly the derived trigger, model and effort absent (the home
default path — `DEFAULT_MODEL` and the CLI's default effort), `permissionMode` the same clamped default item dispatch uses, `remoteControl: false`. Record
`{ repo, number } → { sessionId, state }` in memory, never on disk. `state` is `live` while the dashboard reports the session live; once it ends, the entry
becomes `ended` with an outcome (`pushed`, `stopped` plus the reason from the skill's final line, or `unknown` when that line cannot be read) and is kept
until the PR's head SHA changes or a new resolve replaces it. Only a `live` entry refuses a click. Lost on restart, which is accepted: the PR comment is the
durable record. 201 `{ sessionId }`.

### The board

- A **Resolve conflicts** row in the PR's merge menu (`PrActions.tsx`), present only on a PR whose `mergeable` is `conflicting`. Disabled-with-reason in the
  order of the route's refusals: `sync off`, `fork`, `agents off`, `resolving…`.
- After a 201, and while the server says the resolve is live, the PR row shows a `resolving…` chip linking to the session the way other board-started
  sessions are linked. The server exposes the live map on the PR list read (a field on `PullRequestRow`, or a sibling list) — builder's call.
- When the PR next reads mergeable the `conflicts` chip goes on its own. When the session stopped instead, the row keeps a `resolve stopped` note with the
  one-line reason and the session link (user's pick: show the last outcome), and the menu row is enabled again for another try.
- No mock round: one menu row and one chip in the existing vocabulary (`.claude/DESIGN.md`). The plan's last task is still `/ui-verify` against a
  seeded conflicting PR.

### Tests

- Route: each refusal in order, the derived trigger string, model/effort absent from the spawn body, the second click while live refused, the map entry dropped
  when the dashboard no longer reports the session.
- Client: the row shows only on a conflicting PR; each disabled reason; the chip while live.
- Skill tool (node, beside the tool): argument parsing, preflight refusals from canned `gh` JSON, the worktree path.
- Source guards: `grep -l` `test/` for every shared hook or helper the change adds a caller of (CLAUDE.md), and run those suites.

### Docs

`docs/subsystems/skills.md` (the new skill), `docs/subsystems/api.md` (the route), `docs/subsystems/board.md` (the row and chip), CLAUDE.md's skill count and
Layout line, and `prs.ts`'s `updateBlock` comment, which today says nothing on the page can resolve a conflict.

## Calls made while writing this (author's, not the user's)

- **A PR whose head our own pipeline holds is refused.** `client/src/lib/pr-run.ts` already names the case: head `backlog/<id>`, `execute/<id>` or
  `backlog/run-*` with a run, item or launch holding it. An `execute --fix` session waiting on that PR fixes its own conflicts, and two writers on one branch is
  the anti-goal above. The menu row is disabled with `run holds branch`; the route repeats the check from the server's own run, item and launch state (a new
  rung after rung 5), so a stale tab cannot slip past it.
- **Stale-tree recovery.** The tool writes a lock file into the worktree naming the owning process. Step 2 removes a tree whose owner is dead and proceeds; a
  tree whose owner is alive is the stop it already is. No Stop control on the board: the dashboard's own session Stop exists, and a stopped session's tree is
  then a dead owner's.
- **Dependencies.** The worktree installs dependencies the way `backlog-execute`'s worktrees already do (frozen lockfile). An install that fails or is denied
  is a stop with a note — never "checks could not run, push anyway". Pushes and `gh pr comment` are calls a `pr`-mode execute session already makes under
  the same clamped permission mode.

## Left to the builder

- The tool/SKILL.md split inside the skill.
- How the live map reaches the client (row field vs sibling list) and how the chip links to the session.
- Exact HTTP codes where an existing convention already decides them.
- Glyph for the menu row.
