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
  it never pushes to the base. The invariant's HEADLINE stays byte-identical — it is copied byte-equal into `.claude/rules/orchestrator.md` and pinned by
  `test/guards/claude-rules.test.ts`, and its heading is the anchor both `Why:` links use. Only the BODY sentence that says "Execute and groom are the two
  other skills that write git", in `.claude/rules/orchestrator.md` and in the matching section of `docs/subsystems/invariants.md`, gains `pr-resolve`: it
  writes git too, merging a PR's base into that PR's head and pushing the head, never forced.
- **`~/.backlog-manager/pr-resolve/` is a new directory with exactly one writer**, the skill's tool (`pr-resolve.mjs`), the way `tick/` and `retro/` each have
  one. The server reads it and writes none of it. The rule goes into `.claude/rules/skills.md` beside the `tick/` and `retro/` rules.

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
Each stop below jumps to step 8 (report) — never through step 7's commit and push; the ones after step 1's `gh` read also comment on the PR.

Every exit writes one **outcome file**, `~/.backlog-manager/pr-resolve/<owner>__<repo>__<N>.json` (`$BM_PR_RESOLVE_HOME` overrides the home, as
`$BM_TICK_HOME` does), through the tool, temp file plus `rename`: `{ sessionId, outcome, reason, headSha, at }`. `outcome` is `pushed`, `stopped` or
`up-to-date`; `headSha` is the head the outcome is about — the pushed merge commit for `pushed`, the head step 1 recorded otherwise; `sessionId` is
`$CLAUDE_CODE_SESSION_ID`. The session's final line repeats it: `pr-resolve: pushed`, `pr-resolve: up to date — nothing pushed`, or
`pr-resolve: stopped — <one-line reason>`. This file is how the board learns the outcome: the server has no read of a session's text.

1. **Preflight.** Parse the argument; refuse anything not `owner/repo#N`. Confirm the checkout's `origin` is that repo. Read the PR with `gh pr view`:
   stop unless it is open, `CONFLICTING`, and not cross-repository. Record the head ref, the base ref and the head SHA.
2. **One at a time.** The worktree paths are fixed per PR: `.worktrees/pr-resolve-<N>` and, for step 6's base re-run, `.worktrees/pr-resolve-<N>-base`,
   under the main checkout. The tool writes a lock file `.pr-resolve.lock` into the first tree as soon as it exists: `{ sessionId, at }`. If either path
   already exists: a lock older than 3 hours, or no lock with the directory's mtime older than 3 hours, is stale — the tool removes both trees
   (`git worktree remove --force`, then `git worktree prune`) and goes on; anything younger is a stop, `another resolve of #<N> is running (<path>)`.
   Liveness is by age, not by asking whether a process lives, because the session's own pid is not visible to a skill CLI (each tool call is a fresh process)
   and a terminal run has no dashboard to ask. The server's guard (below) is the fast one for board clicks; this one survives a restart and covers a terminal.
3. **Worktree.** First the excludes `backlog-execute` sets up for its trees (`skills/backlog-execute/references/pr-mode.md`, "`.worktrees/` and
   `node_modules` go into the COMMON git dir's `info/exclude`"), so the main checkout never shows the trees as untracked. Then `git fetch origin <head>
   <base>` and a **detached** worktree at `origin/<head>`. Detached so a local branch of the same name — checked out elsewhere, or ahead or behind origin — is
   never touched. Dependencies: a `node_modules` symlink to the main tree's, exactly as execute's trees get — except in the lockfile case of step 5.
4. **Merge.** `git merge --no-ff --no-commit origin/<base>`, so the commit is always step 7's. "Already up to date" → outcome `up-to-date`, nothing pushed,
   step 8. A merge with no conflicts (GitHub's flag was stale) → step 6.
5. **Classify every conflicted hunk** as mechanical or judgment. Mechanical, resolved by the session: both sides added independent entries to the same list,
   import block or registry; non-overlapping edits that git could not align; a rename on one side and an unrelated edit on the other; formatting-only
   differences; a lockfile or generated file (regenerated with the project's own package manager or generator, never hand-merged). A lockfile regeneration
   first REPLACES the tree's `node_modules` symlink with the tree's own install (`pnpm install`, or the project's manager), because through the symlink the
   install would rewrite the main checkout's dependencies — the anti-goal above; an install that fails or is denied is a stop. Anything else is a judgment
   call: both sides changed the same logic, a deletion on one side and an edit on the other, a semantic choice between two behaviours, or any hunk the session
   is not confident about. **One judgment hunk aborts the whole resolve**: `git merge --abort`, remove the trees, step 8 with the list. The skill's
   text gives worked examples of each class; the line between them is the skill's main content.
6. **Prove it.** Run the project's checks that cover the files the merge touched, as the repo's own CLAUDE.md or `package.json` defines them (typecheck plus
   the affected test suites at minimum). A check that fails is re-run, that check only, on `origin/<base>` in the second detached tree
   (`.worktrees/pr-resolve-<N>-base`, same `node_modules` symlink, removed as soon as the re-run ends): a failure the base has too is not the merge's — the
   session goes on and the note names it. A failure only the merged tree has aborts exactly as a judgment stop does, with the failing output summarised in the
   note. (User's pick: push when the merge added no failure.) Two cases that look alike and are not: **no check is defined** (no test or typecheck command in
   the repo's CLAUDE.md or `package.json`) → the note says so and the session still pushes a mechanical-only resolution; **a check is defined but cannot
   run** (an install failed or was denied, a command was refused) → a stop, never "push anyway".
7. **Commit and push.** Commit the merge with git's default merge subject and a body listing each resolved file and how. `git push origin HEAD:<head>` —
   never forced. A rejected push (the head moved since step 1) is a stop: nothing is retried, the note says to click again.
8. **Report.** Remove the trees. Write the outcome file. Post one `gh pr comment` (skipped only for a stop before step 1's read succeeded): on `pushed`,
   what was resolved and which checks ran; on `stopped`, which files and hunks were judgment calls (or which checks failed) and that nothing was pushed; on
   `up-to-date`, that the branch already had the base. Final message mirrors the comment and ends with the final line above.

A `tools/pr-resolve.mjs` CLI owns the deterministic parts — parse, worktree paths, lock and stale-tree recovery, and the outcome file (its one writer); the
classification and resolution are the model's. Builder's call on any further split.

### The route — `POST /api/agents/dispatch-pr-resolve`

In `agents/`, beside `dispatch-jira`, under `@UseGuards(SameOriginPostGuard)` like every agents POST (`.claude/rules/dispatch-watchdog.md`), and added to the
route list in `test/agents/agents-origin-guard.test.ts`. Body: `{ repo: string /* owner/name */, number: number }`. Nothing else is read — no model, effort,
prompt or mode.

The one ladder, in order — the client's disabled reasons (below) follow it rung for rung:

1. Malformed body → 400 `body must be { repo: "owner/name", number }`.
2. Registry unreadable → `registryProjectsOr503`'s 503. Repo not a registered GitHub project → 404 `<repo> is not the repo of a registered GitHub project`
   (the PR writes' own sentence, `pulls.service.ts`).
3. Sync off → 409 with `syncOffBlock`'s sentence unchanged: `sync is off for <repo> — turn it on in GitHub › Settings`.
4. Agents off, dashboard unreachable, or the project not visible to it → the existing `projectDispatchGate` refusal and its text.
5. A resolve this server started for the same PR still live (below) → 409 `a resolve of <repo>#<n> is already running`.
6. Fresh one-PR read, through `PullRequestsService` (a public method over its existing single-PR read, so the token, the pools' sleeps and the cache
   splice stay that service's): no token → 503 with its `NO_TOKEN` text; a sleeping `graphql` pool → 429 with the sleep's own detail; a failed read →
   502 `could not read <repo>#<n> from GitHub`; not found, merged or closed → 409 `<repo>#<n> is not open`; cross-repository → 409
   `<repo>#<n> is from a fork — the session cannot push to it`; `mergeable: unknown` → 409 `GitHub is still computing mergeability — try again in a
   moment`; `mergeable: mergeable` → 409 `<repo>#<n> has no conflicts`.

Then spawn through `AgentsService.spawnInProject` in the repo's FIRST registered project's path, in registry order — the path the PR writes already resolve
a repo to (`PullRequestsService.registeredRepos`). Prompt: exactly the derived trigger. Model and effort are not passed, so the spawn body carries
`model: DEFAULT_MODEL` (`launchInProject`'s home default) and no `effort` key. `permissionMode` the same clamped default item dispatch uses,
`remoteControl: false`. 201 `{ sessionId }`.

**Live map.** `{ repo#n } → { sessionId, startedAt }` in server memory, never on disk, read on demand (on this route and on the PR list read) — no timer,
the way the PR cache has none. An entry is live while ANY of: younger than 120 s (a just-spawned session has no dashboard row yet, the grace
`JIRA_LIVE_GRACE_MS` exists for); the dashboard is unreachable (unknown is treated as live, so a second click cannot slip through); or
`dashboardSessionRow(cfg, sessionId)` returns a row whose `processLive` is true. It is dropped when an outcome file carries its `sessionId`, or when past
the grace the dashboard answers with no row or a row that is not `processLive`. A single-row lookup, not the session list, so a truncated list
(`full: false`) can never read as "gone".

**Last outcome.** The PR list read joins each conflicting or freshly resolved PR with its outcome file, shown only while the file's `headSha` equals the
PR's current head SHA — so a stopped outcome stays until somebody pushes, and a pushed one stays only until GitHub has re-read the PR. No file, or one
for another head, shows nothing. Restart loses only the live map; the outcome file and the PR comment survive it.

### The board

- A **Resolve conflicts** row in the PR's merge menu (`PrActions.tsx`), on every PR — the strip's own rule is that an action that cannot be used stays in
  its place, marked, and says why. The one exception is the environment-level block: with agents off (`projectDispatchGate` → `hidden`) the row is not
  drawn, per `.claude/rules/board.md` ("An environment-level block hides the dispatch control; the per-item ones disable it"). Otherwise disabled with the
  first reason that holds, in the route's ladder order: `sync off`, the gate's own disabled reason (dashboard unreachable, project not visible),
  `resolving…`, `fork`, `mergeability pending`, `no conflicts`, then the pipeline-held reason below.
- While the live map holds the PR, the row shows a `resolving…` chip linking to the session the way other board-started sessions are linked. The server
  exposes the live map and the last outcome on the PR list read (a field on `PullRequestRow`, or a sibling list) — builder's call.
- Last outcome on the row: `stopped` → a note `resolve stopped: <reason>` with a `session ↗` link, and the menu row is enabled again for another try;
  `pushed` while GitHub still reads the PR conflicting or pending → chip `resolved — waiting for GitHub`; `up-to-date` → nothing. When the PR next reads
  mergeable the `conflicts` chip goes on its own.
- No mock round: one menu row and one chip in the existing vocabulary (`.claude/DESIGN.md`). The plan's last task is still `/ui-verify` against a
  seeded conflicting PR.

### Tests

- Route: each ladder rung in order with its exact text; the derived trigger string; the spawn body carries `model: DEFAULT_MODEL` and no `effort` key; the
  spawn's project path is the first registered one for a repo two projects share; a second click while live is refused; inside the 120 s grace a missing row
  stays live; past it, a row that is not `processLive` drops the entry; an unreachable dashboard keeps it; an outcome file with the session id drops it; the
  route is in the origin-guard list.
- PR list read: an outcome file whose `headSha` matches the head is joined, one for another head is not.
- Client: the row hidden with agents off; each disabled reason in ladder order; the `resolving…` chip; the three outcome renderings.
- Skill tool (node, beside the tool): argument parsing, the two worktree paths, a fresh lock refusing, a stale lock (and a lock-less old tree) recovered, the
  outcome file's shape and its temp-plus-rename write under `$BM_PR_RESOLVE_HOME`.
- Source guards: `grep -l` `test/` for every shared hook or helper the change adds a caller of (CLAUDE.md), and run those suites.

### Docs

`docs/subsystems/skills.md` (the new skill), `docs/subsystems/api.md` (the route), `docs/subsystems/board.md` (the row and chip), CLAUDE.md's skill count and
Layout line, `prs.ts`'s `updateBlock` comment, which today says nothing on the page can resolve a conflict, the body sentence about which skills write git
in `.claude/rules/orchestrator.md` and `docs/subsystems/invariants.md` (headline untouched), and the `pr-resolve/` one-writer rule in
`.claude/rules/skills.md` with its `Why:` section in `invariants.md`.

## Calls made while writing this (author's, not the user's)

- **A PR whose head our own pipeline holds is disabled on the board.** `client/src/lib/pr-run.ts` already decides it (head `backlog/<id>`, `execute/<id>` or
  `backlog/run-*` with a run, item or launch holding it) and already words it for Merge and Update branch; the Resolve row reads the same function and shows
  ITS existing warning text as the disabled reason, no new copy. An `execute --fix` session waiting on that PR fixes its own conflicts. The route does NOT
  repeat the check: the rule lives only client-side, and the race it would close is already harmless — both writers push without force, so whichever
  pushes second is rejected, and for a resolve that is a stop with a note.
- **Stale-tree recovery is by lock age** (step 2), not by process liveness: a skill CLI's pid dies with each call, and a terminal run has no dashboard. No
  Stop control on the board: the dashboard's own session Stop exists, and a stopped session's tree goes stale after 3 hours or is removed by hand.
- **Dependencies.** A `node_modules` symlink, as execute's trees have (`pr-mode.md`); a tree's own install only when a lockfile must be regenerated. An
  install that fails or is denied is a stop with a note. Pushes and `gh pr comment` are calls a `pr`-mode execute session already makes under the same
  clamped permission mode.

## Left to the builder

- The tool/SKILL.md split inside the skill.
- How the live map reaches the client (row field vs sibling list) and how the chip links to the session.
- Exact HTTP codes where an existing convention already decides them.
- Glyph for the menu row.
