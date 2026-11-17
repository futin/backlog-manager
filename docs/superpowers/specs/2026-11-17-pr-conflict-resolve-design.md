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

Trigger: `/backlog-manager:pr-resolve <owner>/<repo>#<number> [--reclaim <sessionId>]`, run from the PR repo's main checkout (the board spawns it there).
Headless-safe: it never asks. `--reclaim` is added only by the route (below), never typed.

**Three kinds of stop**, and which of step 8's acts each runs:

- **Early stop** — before step 1's `gh` read succeeded (malformed argument, `origin` is another repo, `gh` failed or was denied): final line only. No
  outcome file (there is no PR to key it to, no head to record), no comment, no tree.
- **Lock stop** — step 2 found another resolve holding the PR: final line only. It removes nothing, writes no outcome file and posts no comment, because
  every one of those belongs to the resolve that holds the lock.
- **Stop** — everything after step 2: the full step 8.

Every exit after step 2 writes one **outcome file**, `~/.backlog-manager/pr-resolve/<owner>__<repo>__<N>.json` (`$BM_PR_RESOLVE_HOME` overrides the home,
as `$BM_TICK_HOME` does), through the tool, temp file plus `rename`: `{ sessionId, outcome, reason, fromSha, headSha, at }`. `outcome` is `pushed`,
`stopped` or `up-to-date`; `fromSha` is the head step 1 recorded; `headSha` is the pushed merge commit for `pushed` and equals `fromSha` otherwise;
`sessionId` is `$CLAUDE_CODE_SESSION_ID`, or `null` when it is unset (a terminal run outside Claude Code). A stop after step 1's read that is not a lock stop
(closed, not conflicting, a fork) writes `stopped` with the read's head as both SHAs. The session's final line repeats it: `pr-resolve: pushed`,
`pr-resolve: up to date — nothing pushed`, or `pr-resolve: stopped — <one-line reason>`. The file is how the board learns the outcome: the server has no
read of a session's text.

1. **Preflight.** Parse the argument; refuse anything not `owner/repo#N`. Confirm the checkout's `origin` is that repo. Read the PR with `gh pr view`:
   stop unless it is open, `CONFLICTING`, and not cross-repository. Record the head ref, the base ref and the head SHA.
2. **One at a time.** The worktree paths are fixed per PR: `.worktrees/pr-resolve-<N>` and, for step 6's base re-run, `.worktrees/pr-resolve-<N>-base`,
   under the main checkout. The lock lives OUTSIDE the trees, so nothing a merge stages can ever pick it up:
   `~/.backlog-manager/pr-resolve/locks/<owner>__<repo>__<N>.lock`, `{ sessionId, at }`, taken with an exclusive create (`open(…, 'wx')`) — of two
   sessions exactly one wins. A lock that already exists is stale when older than 3 hours, or when `--reclaim <sessionId>` names exactly the session it
   records. A stale lock is claimed atomically, the shape of `backlog-tick`'s `claimStaleLock` (a TWIN by the self-contained rule, its comment naming the
   original): rename it aside to a name unique to this process, re-read that it is still the lock that was judged stale, then remove both trees
   (`git worktree remove --force`, `git worktree prune`) and take the lock fresh. Of two sessions that both judge one lock stale, the rename lets exactly one
   through. A live lock, or a lost rename race, is a **lock stop**: `another resolve of #<N> is running`. Liveness is by age plus the server's `--reclaim`,
   not by process: a skill CLI's pid dies with each call, and a terminal run has no dashboard to ask. Every exit after the lock is taken releases it in
   step 8.
3. **Worktree.** First the excludes `backlog-execute` sets up for its trees (`skills/backlog-execute/references/pr-mode.md`, "`.worktrees/` and
   `node_modules` go into the COMMON git dir's `info/exclude`"), so the main checkout never shows the trees as untracked. Then `git fetch origin <head>
   <base>` and a **detached** worktree at `origin/<head>`. Detached so a local branch of the same name — checked out elsewhere, or ahead or behind origin — is
   never touched. Dependencies: a `node_modules` symlink to the main tree's, exactly as execute's trees get — except in the lockfile case of step 5. A failed
   fetch or `worktree add` is a stop (the reason names the git error). Step 7 stages only the paths the merge itself touched (`git add <path>…`), never
   `-A`, so no untracked file can ride into the commit.
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
   never forced. A rejected or denied push (the head moved since step 1, or the permission check refused it) is a stop: nothing is retried, the note says
   to click again.
8. **Report**, in this order, each act attempted even when an earlier one failed: (a) `git merge --abort` if a merge is still in progress — every stop
   after step 4, the install and cannot-run stops included, leaves nothing half-merged; (b) remove the trees THIS session created, and only those;
   (c) release the lock; (d) write the outcome file; (e) post one `gh pr comment`: on `pushed`, what was resolved and which checks ran; on `stopped`,
   which files and hunks were judgment calls (or which checks failed) and that nothing was pushed; on `up-to-date`, that the branch already had the base;
   (f) the final message, mirroring the comment and ending with the final line above. A failure in (b), (d) or (e) — a tree that will not go, an outcome
   file that cannot be written, a comment that fails or is denied — never changes the outcome: a push that landed is still `pushed`. The final message
   names each failed act, and a tree left behind is named by path.

A `tools/pr-resolve.mjs` CLI owns the deterministic parts — parse, worktree paths, lock take, stale claim and release, and the outcome file (the one writer
of `~/.backlog-manager/pr-resolve/`); the classification and resolution are the model's. Builder's call on any further split. It follows every skill CLI's
obligations in `.claude/rules/skills.md`: `process.exitCode = main(…)`, never `process.exit`; an entry in `CLI_SOURCES`
(`skills/backlog/tools/backlog.test.mjs`); called from SKILL.md as `node "${CLAUDE_PLUGIN_ROOT}/skills/pr-resolve/tools/pr-resolve.mjs"`.

### The route — `POST /api/agents/dispatch-pr-resolve`

In `agents/`, beside `dispatch-jira`, under `@UseGuards(SameOriginPostGuard)` like every agents POST (`.claude/rules/dispatch-watchdog.md`), and added to the
route list in `test/agents/agents-origin-guard.test.ts`. Body: `{ repo: string /* owner/name */, number: number }`. Nothing else is read — no model, effort,
prompt or mode.

The ladder, in order. Every refusal's text is shown on the PR row's outcome line (`PrOutcomeLine`), the way a refused Update branch's is — there is no sheet.

1. Malformed body → 400 `body must be { repo: "owner/name", number }`.
2. Registry unreadable → `registryProjectsOr503`'s 503. Repo not a registered GitHub project → 404 `<repo> is not the repo of a registered GitHub project`
   (the PR writes' own sentence, `pulls.service.ts`).
3. Sync off → 409 with `syncOffBlock`'s sentence unchanged: `sync is off for <repo> — turn it on in GitHub › Settings`.
4. `projectDispatchGate` for the project path: any `hidden` verdict (agents off, dashboard unreachable, no Claude binary, remote answers off —
   `shared/agent.ts`) or its one `disabled` verdict (the project not visible to the dashboard) → 409 with the gate's own reason text, except dispatch on
   with the dashboard unreachable, which is 502 as `dispatch-jira` answers.
5. Fresh one-PR read, through `PullRequestsService` (a new public method over its existing private single-PR read, so the token, the pools' sleeps and the
   cache splice stay that service's): no token → 503 with its `NO_TOKEN` text; a sleeping `graphql` pool → 429 with the sleep's own detail; a failed read →
   502 `could not read <repo>#<n> from GitHub`; not found, merged or closed → 409 `<repo>#<n> is not open`; cross-repository → 409
   `<repo>#<n> is from a fork — the session cannot push to it`; `mergeable: unknown` → 409 `GitHub is still computing mergeability — try again in a
   moment`; `mergeable: mergeable` → 409 `<repo>#<n> has no conflicts`.
6. **Reserve**, synchronously, after the last `await` above and before the spawn's: if the live map holds a live entry for `<repo>#<n>` → 409
   `a resolve of <repo>#<n> is already running`; otherwise the entry is written now, in the same tick, with `sessionId: null` — so of two clicks that both
   cleared rung 5, exactly one passes (the Jira dispatch's `live.reserve` pattern). A spawn that then fails drops the reservation before its error returns.
7. **Leftover lock.** The route reads (never writes) the PR's lock file. None → plain trigger. One whose `sessionId` the dashboard reports `processLive`, or
   one younger than the 120 s grace → drop the reservation, 409 `a resolve of <repo>#<n> is already running`. Otherwise its owner is dead (killed,
   stopped, crashed) → the trigger carries `--reclaim <thatSessionId>`, so the new session clears the leftover trees at once instead of waiting out the
   3-hour age. An unreachable dashboard here is the 409, never a reclaim.

Then spawn through `AgentsService.spawnInProject` in the repo's FIRST registered project's path, in registry order — the path the PR writes already resolve
a repo to (`PullRequestsService.registeredRepos`, made public or mirrored by the new method). Prompt: exactly the derived trigger. Model and effort are not
passed, so the spawn body carries `model: DEFAULT_MODEL` (`launchInProject`'s home default) and no `effort` key. `permissionMode` the same clamped default
item dispatch uses, `remoteControl: false`. The reservation takes the minted `sessionId`. 201 `{ sessionId }`.

**Where the state lives.** The live map and the outcome-file reader both live in `agents/` (a `PrResolveService`), because the edge already runs agents →
tracker (`agents.module.ts` imports `TrackerModule`) and never back — `GET /api/prs` in `TrackerModule` cannot read them without a cycle. The client reads
them from a sibling route, `GET /api/agents/pr-resolve` → `{ resolves: PrResolveState[] }`, one entry per PR with a live entry or an outcome file:
`{ repo, number, live: { sessionId | null } | null, outcome: { outcome, reason, fromSha, headSha, sessionId } | null }`. The client's PR reader fetches it
beside `GET /api/prs` on the same 60 s tick; the two are joined on the client by `repo#number` and head SHA.

**Live rule.** An entry is live while ANY of: younger than 120 s (a just-spawned session has no dashboard row yet, the grace `JIRA_LIVE_GRACE_MS` exists
for); the dashboard is unreachable or its lookup throws (unknown is treated as live, so a second click cannot slip through); or
`dashboardSessionRow(cfg, sessionId)` returns a row whose `processLive` is true. It is dropped when an outcome file carries its `sessionId`, or when past
the grace the dashboard answers with no row or a row that is not `processLive`. A single-row lookup, not the session list, so a truncated list
(`full: false`) can never read as "gone". The lookups for all entries run in parallel; each is bounded by `dashboardSessionRow`'s own budget, so the
sibling route answers within that budget however many entries there are. No timer — read on demand, the way the PR cache has none.

**Last outcome.** Matched to the PR's current head SHA as the PR list reports it: `stopped` and `up-to-date` show while the head equals `headSha` (which
equals `fromSha` for them) — they stay until somebody pushes. `pushed` shows while the head equals `fromSha` (the list has not re-read since the push —
up to the PR cache's TTL, an accepted gap) or equals `headSha` while GitHub reads the PR `unknown`. `conflicting` at the pushed head means the base moved
again, so the row is enabled for another try. Any other head shows nothing.
Restart loses only the live map; the outcome file and the PR comment survive it.

### The board

- A **Resolve conflicts** row in the PR's merge menu (`PrActions.tsx`): label `Resolve conflicts`, sub `merge <base> in with a headless session`
  (`<base>` the PR's base ref). On every PR — the strip's own rule is that an action that cannot be used stays in its place, marked, and says why. The one
  exception is the environment-level block: when `projectDispatchGate` answers `hidden` (agents off, dashboard unreachable, no Claude binary, remote answers
  off) the row is not drawn, per `.claude/rules/board.md` ("An environment-level block hides the dispatch control; the per-item ones disable it").
- Otherwise the row is disabled with the first of these that holds — the subset of the route's ladder the row can know from what the page already has,
  in the ladder's order, plus one board-only reason last. A blocked row draws its reason in place of the sub (`block ?? sub`, as every row does):

  | Reason (exact) | When | New or existing |
  | --- | --- | --- |
  | `sync off` | `repo.syncOff !== null` | existing (also in `REPO_REASONS`) |
  | the gate's own `disabled` reason text | project not visible to the dashboard | existing (`projectDispatchGate`) |
  | `fork — cannot push` | `pr.crossRepository` | new |
  | `mergeability pending` | `pr.mergeable === 'unknown'` | existing chip label |
  | `no conflicts` | `pr.mergeable === 'mergeable'` | new |
  | `resolving…` | a live entry for this PR | new |
  | `resolved — waiting for GitHub` | a `pushed` outcome showing (rule above) | new |
  | `pr-run.ts`'s warning text for this PR, unchanged | `prRunWarning(pr, ctx, now)` is non-null | existing (read as a block here) |

  No new string joins `REPO_REASONS`: all are per-PR, so `whyLine` keeps saying only repo-wide reasons. `PrActions` gains the `PrRunContext` and `now` it
  needs for the last row — the same context the Merge and Update rows' warning already reads (builder threads it). What the route alone can refuse (not
  open, no token, rate-limited, a leftover live lock) reaches the person as the POST's error on the outcome line.
- While the PR has a live entry, the row shows a `resolving…` chip linking to the session the way other board-started sessions are linked (no link while
  the reservation's `sessionId` is still `null`).
- Last outcome on the row: `stopped` → a note `resolve stopped: <reason>` with a `session ↗` link (no link when the outcome's `sessionId` is `null`), and
  the menu row is enabled again for another try; `pushed` (while it shows) → chip `resolved — waiting for GitHub`; `up-to-date` → nothing. When the PR next
  reads mergeable the `conflicts` chip goes on its own.
- No mock round: one menu row and one chip in the existing vocabulary (`.claude/DESIGN.md`). The plan's last task is still `/ui-verify` against a
  seeded conflicting PR.

### Tests

- Route: each ladder rung in order with its exact text; the derived trigger string, with and without `--reclaim <id>`; the spawn body carries
  `model: DEFAULT_MODEL` and no `effort` key; the spawn's project path is the first registered one for a repo two projects share; a second click while
  live is refused; **two concurrent POSTs for one PR spawn exactly once** (both cleared rung 5, the reservation lets one through); a failed spawn drops the
  reservation; a leftover lock whose session is `processLive` → 409, one whose session is gone → `--reclaim`, an unreachable dashboard → 409; inside the
  120 s grace a missing row stays live; past it, a row that is not `processLive` drops the entry; an unreachable dashboard keeps it; an outcome file with
  the session id drops it; the route is in the origin-guard list.
- `GET /api/agents/pr-resolve`: a live entry and an outcome file both listed; a slow dashboard lookup does not serialise the others.
- Client: the row hidden on every `hidden` gate verdict; each disabled reason in table order with its exact text; the `resolving…` chip with and without
  a session link; the outcome renderings, including `pushed` at `fromSha` (shows), at `headSha` while `unknown` (shows), at `headSha` while
  `conflicting` (gone, row enabled), at `headSha` while `mergeable` (gone), and a `stopped` file for another head (gone).
- Skill tool (node, beside the tool): argument parsing (with and without `--reclaim`); the two worktree paths; an exclusive lock take where a second take
  fails; a stale lock (by age, and by a matching `--reclaim`) claimed by exactly one of two claimers; a `--reclaim` naming another session not honoured;
  the outcome file's shape (`fromSha`, `headSha`, `sessionId: null` when the env var is unset) and its temp-plus-rename write under `$BM_PR_RESOLVE_HOME`.
- Guard lists: `CLI_SOURCES` gains `pr-resolve.mjs`; `test/guards/skills-plugin-root.test.ts`'s nine-skill list gains `pr-resolve` (and its comment's
  count becomes ten).
- Source guards: `grep -l` `test/` for every shared hook or helper the change adds a caller of (CLAUDE.md), and run those suites.

### Docs

`docs/subsystems/skills.md` (the new skill), `docs/subsystems/api.md` (the route), `docs/subsystems/board.md` (the row and chip), CLAUDE.md's skill count and
Layout line, `prs.ts`'s `updateBlock` comment, which today says nothing on the page can resolve a conflict, the body sentence about which skills write git
in `.claude/rules/orchestrator.md` and `docs/subsystems/invariants.md` (headline untouched), and the `pr-resolve/` one-writer rule in
`.claude/rules/skills.md` with its `Why:` section in `invariants.md`. Also `.claude/rules/tracker.md` and the PR-cache section of `invariants.md`: the
sentence that says a PR read happens only inside `GET /api/prs`, a write's re-read or `refreshNow` gains a fourth — the resolve route's one-PR read,
spliced into the cache like a write's re-read. And `.claude/rules/dispatch-watchdog.md`: the new derived-dispatch route beside `dispatch-jira`, its
`SameOriginPostGuard`, its reservation, and that its trigger is composed from the PR read and the lock file, never from the body.

## Calls made while writing this (author's, not the user's)

- **A PR whose head our own pipeline holds is disabled on the board.** `client/src/lib/pr-run.ts` already decides it (head `backlog/<id>`, `execute/<id>` or
  `backlog/run-*` with a run, item or launch holding it) and already words it for Merge and Update branch; the Resolve row reads the same function and shows
  ITS existing warning text as the disabled reason, no new copy. An `execute --fix` session waiting on that PR fixes its own conflicts. The route does NOT
  repeat the check: the rule lives only client-side, and the race it would close is already harmless — both writers push without force, so whichever
  pushes second is rejected, and for a resolve that is a stop with a note.
- **Stale-tree recovery** (step 2) is by lock age for a terminal run, and by the server's `--reclaim` for a board click: the route proves the lock's
  session dead on the dashboard and names it, so a click after a killed or stopped session clears the leftover trees and proceeds at once. No Stop control
  on the board: the dashboard's own session Stop exists.
- **Dependencies.** A `node_modules` symlink, as execute's trees have (`pr-mode.md`); a tree's own install only when a lockfile must be regenerated. An
  install that fails or is denied is a stop with a note. Pushes and `gh pr comment` are calls a `pr`-mode execute session already makes under the same
  clamped permission mode.

## Left to the builder

- The tool/SKILL.md split inside the skill.
- How the chip links to the session (the route that carries the live map is decided above: `GET /api/agents/pr-resolve`).
- Exact HTTP codes where an existing convention already decides them.
- Glyph for the menu row.
