# Jira Run — pick a repository and a branch, work in a worktree (amends the Jira design)

**Amends:** [2026-10-15-jira-integration-design.md](2026-10-15-jira-integration-design.md), the Run sections (phase 5: the launch sheet, `GET /api/jira/prompt`,
`POST /api/agents/dispatch-jira`, the prompt composer) and Setup → Repositories. Where the two disagree, this document wins. Mechanism today:
[docs/subsystems/jira.md § Run](../../subsystems/jira.md#run-phase-5a).

## 1. Intent

More repositories are about to be mapped to the Jira projects on this board, and starting a ticket has to say **which repo and which branch** the work
happens on. The repo half already exists. Setup → Repositories maps one Jira project to up to ten local checkouts, and the launch sheet asks for one when
there is more than one. The branch half does not exist. Today the session is spawned in the mapped checkout and works on whatever branch happens to be
checked out there, and the built-in `execute` instruction tells it to branch on its own.

The user's words, which this design keeps: sometimes a ticket starts a **fresh branch off a base**, and sometimes it **continues an existing branch**. The
base is usually the repo's usual one, but "sometimes we start from a feature branch, so it's not always develop or main".

**Success:**

- Starting a ticket names the repo and the branch explicitly, and the session works on exactly that branch.
- The main checkout's branch never moves because of a Run.
- Two tickets can run in one repo at the same time.
- A second Start on the same ticket finds its branch without anyone having written it down.
- A new branch's pre-filled name already follows the repo's own convention, e.g. `feature/timify-26090-export-contacts` in the Timify microservice repo.

## 2. Decisions (the user's)

| question | picked | rejected |
| --- | --- | --- |
| what the chosen branch is | **both, per Start**: either *new* (cut from a chosen base) or *continue* (an existing branch) | base-only; existing-only |
| where the session works | **its own git worktree**, never the mapped checkout itself | `git checkout` in the mapped path; a per-Start toggle |
| how the board knows a ticket's branch later | **derived from the branch name**: the board finds every branch carrying the key | stored in `jira.json`; not remembered at all |
| where a new branch's base comes from | **a per-repo default set in Setup, changeable on every Start to any branch**, a feature branch included | the repo's own `origin/HEAD` only; no default |
| which branches the picker lists | **local and `origin/*`**, and the base is fetched before the branch is cut | local only, no fetch |
| who runs git that writes | **the session.** The server mounts the Jira repos **read-only** and only reads them. It never fetches and never removes a worktree | read-write mount plus SSH forwarding so the server writes; host-run server only |
| a new branch's pre-filled name | **a per-repo name pattern set in Setup**, e.g. `feature/{key}-{slug}` with the key lower-cased | a fixed `feature/{key}-{slug}`; a prefix select on the sheet |
| how a Jira Run relates to the orchestrator | **a one-ticket Run that borrows the orchestrator's worktree mechanism**: a tool command run by the session cuts the worktree, as `orchestrate.mjs worktree` does (§4) | Jira as a new orchestrator item source, drained like GitHub issues with one MR per run; both, staged |
| what happens after the session | **the worktree stays; the board offers Remove.** Opening an MR is an **opt-in toggle per Start** (§5.6). When it is off, the session commits and does not push, as today | the session always pushes and opens an MR; the board never manages cleanup |

## 3. Goals, non-goals, anti-goals

**Goals:** the decisions above, for the built-in actions (`execute`, `context`) and for skills, through both of the launch sheet's exits (Start and Copy prompt).

**Non-goals:**

- Deleting a branch. Remove removes the worktree only, and the branch survives it.
- Draining Jira tickets through `backlog-orchestrate`. The user considered this on 2026-10-20 and chose the lighter path, for these reasons:
  - The orchestrator drains a registered project's backlog items (files or GitHub issues), and Jira is not one of its sources.
  - Its PR mode is for tracker projects only, and opens the PR with `gh pr create` (GitHub), while the Timify repos are on GitLab.
  - Its branch names are `backlog/<id>` and `backlog/run-<date>-<n>`, which Jira's development panel cannot link.
  - It is built to run a queue unattended, with a review and merge gate per item, while a Jira Run is one interactive session on one ticket.

  A later "Jira as an orchestrator source" project can reuse what this one builds.
- Writing the branch link into Jira. The board's Jira writes stay assign and transition
  ([invariant](../../subsystems/invariants.md#the-boards-jira-writes-are-assign-and-transition-nothing-else)). Jira's own GitHub/GitLab development panel picks
  the link up from the key in the branch name, at no cost to us.
- One session spanning several repos.
- Any git write by the server.
- Any change to backlog items, dispatch of backlog items, or the orchestrator. This is the Jira Run path only.

**Anti-goals (what would make this a failure even if it works):**

- A Run that switches the branch of the mapped checkout, or of any tree the person is standing in.
- A branch link that has to be maintained by hand, or that drifts from git.
- A Start that silently lands on the wrong branch. For example, it continues `timify-12-x` for `TIMIFY-123`, or it cuts from a stale local base without saying
  so.
- Removing a worktree that holds uncommitted work.

## 4. Constraints that shape the how

**The dashboard spawns only into projects it already lists** (`spawnInProject` → `projectMap`, and `projectDispatchGate`'s `status.projectPaths`). A worktree
created a moment before the spawn is not in that list. So the session is spawned in the mapped repo, as today, and **the worktree step is the session's first
instruction**, carried in the composed prompt. Consequences:

- Copy prompt works unchanged without the dashboard, because the workspace setup is inside the prompt.
- The preview shows exactly what the session will do.

**The server runs in Docker and can see only what compose mounts.** Today that is `~/Documents/custom-projects`, mounted read-only, and the Timify repos live
under `~/Documents/timify-projects/`, which the container cannot see. The container also has no SSH credentials. So:

- Compose gains a **second read-only project root** for Jira repos, at the same host path inside the container, the way `BM_PROJECT_ROOT` is mounted today.
  The variable name is the builder's call, for example `BM_JIRA_REPO_ROOT`, defaulting to `~/Documents/timify-projects`.
- A mapped path whose branches the server cannot list does not break the sheet. The reason is named exactly, in this order of checks:
  - "not mounted into the board": only when the path is outside every configured root;
  - "does not exist";
  - "not a git repository".

  The same three apply on a host-run API, minus the first. In every case the Branch section says "branches unavailable — `<path>` <reason>".
  It still lets the person type a branch name for Continue and a base for New. The prompt carries the choice unchanged, and `jira.mjs worktree` re-checks it
  (5.4).
- Setup → Repositories shows the same warning, with the same reason, on the row, so the gap is visible before a Start.

**The orchestrator is the precedent, and this borrows its mechanism.** In an orchestrator run, a session in the project root runs
`orchestrate.mjs worktree <id>`. That command does the following:

- re-checks for a leftover worktree or branch;
- creates `.worktrees/<id>` on a new branch cut from the run's `--base`, or reattaches the existing branch;
- adds `.worktrees/` and a bare `node_modules` line to the common git dir's `info/exclude`, never `.gitignore`;
- prints `{ worktree, branch, created }`.

The session never touches the main tree, and every later command takes the worktree path explicitly (`git -C`, `--cwd`, a `( cd <worktree> && … )` subshell).
The Jira Run does the same. A new **`jira.mjs worktree`** command does the fetch and the create-or-enter of §5.4, built on the same worktree code as
`orchestrate.mjs`, shared rather than copied. The session then works inside the printed path.

Sharing means **extracting**, because `cmdWorktree` is bound to the run file and to `backlog/<id>` naming (`orchestrate.mjs` `cmdWorktree`). Three pieces
move into one module:

- the leftover probe;
- `git worktree add` (new branch from a base, or an existing branch);
- `ensureExcludeLines`.

`orchestrate.mjs` and `jira.mjs` both import that module. It must live under `skills/` and be imported by a relative path, because `scripts/sync-plugin.mjs`
publishes only `PUBLISHED_PATHS = ['skills', '.claude-plugin', 'agents']`, and a module anywhere else would be missing from the installed plugin. The exact
file is the builder's call. `orchestrate.mjs`'s behaviour must not change; its existing tests are the guard.

**`node_modules` is new code, not extracted.** `orchestrate.mjs` excludes a `node_modules` symlink, but no tool creates one: no code under `skills/` does.
`jira.mjs worktree` creates it itself, so the repo's tests can run in the new worktree. It links the main tree's `node_modules` only when the main tree has
one. It never replaces a real directory or an existing link in the worktree.

**Builder: the one thing still to probe.** The orchestrator never needs a session to *move into* a worktree. It starts a fresh headless child already inside
one (`cd <worktree> && claude -p …`), which the dashboard's spawn cannot do (above). So check whether an interactive session can switch its working directory
into an existing worktree path, through Claude Code's `EnterWorktree` tool or another way. If it can, the session switches. If it cannot, the session works by
absolute path and `git -C`, under the orchestrator's own "path is always explicit" rule, and the prompt says so. Only if neither works reliably, stop and come
back. The fallback (teaching the dashboard a `cwd` override) is a cross-repo change and the user's call.

## 5. Behaviour

### 5.1 Setup → Repositories: per-repo defaults

Each mapped path gets two optional settings, shown and edited on its row:

- **Default base branch**, e.g. `develop`. When it is unset, the base falls back to the repo's `origin/HEAD`, and then to the checkout's current branch.
- **Branch name pattern**, made of literal text plus `{key}` (the key lower-cased, e.g. `timify-123`), `{KEY}` (as Jira writes it) and `{slug}`. When it is
  unset, the pattern is `{key}-{slug}`. A pattern is validated at save time by rendering a sample, the key `ABC-1` and the slug `sample-slug`, and then running every Start-time check on the
  result: §6's name checks and 5.2's matcher. A pattern whose sample fails is refused with the failing check named. This catches a missing key, `x{key}`, `{key}1`,
  an illegal literal and a leading `-`.

Both are stored **per path, not per project**, because one checkout can be mapped to two Jira projects and has one convention. The storage is a new top-level
`repoDefaults: { "<normalised path>": { "base"?: "<branch>", "namePattern"?: "<pattern>" } }` in `jira.json`, beside `repos`, so the existing `repos` shape
and its reader stay untouched *(my call)*. It is written through a new guarded route under the existing config-write rules: same-origin guard, an unreadable
file is never replaced, and the server is the only writer. The base is validated as a branch name (`git check-ref-format --branch` semantics). Whether that
branch exists is not checked, because it may exist only on `origin`.

### 5.2 Ticket branches: derived, never stored

A branch **belongs to** ticket `KEY` when its name contains `KEY` with a non-alphanumeric character or the end of the name on both sides, compared
case-insensitively. `TIMIFY-123` matches `TIMIFY-123-fix-login`, `feature/timify-123-x`, `hotfix/timify-123` and `TIMIFY-123`. It does not match
`timify-1234-x` or `xtimify-123`. The board looks across local branches and `origin/*`, in every path mapped to the key's project. A local branch and its
`origin/` twin are one entry, carrying whether the local copy is behind, ahead or diverged as of the last fetch.

For each such branch the board also reports whether a worktree has it checked out (`git worktree list --porcelain`), and where. This includes worktrees made
by hand outside `.worktrees/` (5.4), like the sibling `microservice-21969` that exists today.

The reads go through `runGit` (async, bounded,
[invariant](../../subsystems/invariants.md#the-server-never-spawns-git-synchronously-in-a-request-path)) against the read-only mount. Their caching is the
builder's call.

### 5.3 The launch sheet

A **Branch** section sits under the repo picker and is enabled once a repo is chosen. It shows "as of last fetch, `<age>`" (from `FETCH_HEAD`'s mtime, or
"never fetched"), because the server does not fetch. It has three modes:

- **Continue a branch.** A select whose first group is this ticket's branches in the chosen repo (5.2), followed by every other local and `origin/*` branch.
  For `execute` and skills, this mode is the default when the ticket has at least one branch in the chosen repo, with the most recently committed one
  pre-selected. A behind or
  diverged local copy is shown beside the choice.
- **New branch.** It has two fields:
  - **Base:** a select over local and `origin/*` branches, pre-selected from the repo's default (5.1).
  - **Name:** a text field pre-filled from the repo's pattern (5.1). The field is editable, but a name that no longer carries the key (5.2's rule) is
    refused. The slug is built from the summary in five steps *(my call)*:
    1. Lower-case it, and strip diacritics to ASCII.
    2. Collapse every run of characters outside `[a-z0-9]` into one `-`.
    3. Trim `-` from both ends.
    4. If the result is longer than 40 characters, cut it at the last `-` at or before character 40. If there is no such `-`, cut hard at 40.
    5. Trim `-` again.

    An empty slug renders the pattern with `{slug}` and the separator in front of it removed: `{key}-{slug}` gives `timify-123`, never `timify-123-`.

  For `execute` and skills, this mode is the default when the ticket has no branch in the chosen repo.
- **No branch.** The session works in the mapped checkout, as Runs do today, with no worktree. It is offered only for `context` and for skills, and is the
  default for `context` *(my call: `context` promises to change nothing, so a branch and a worktree for it would be clutter that 5.2 would later find and
  pre-select)*, whether or not the ticket has branches. It is never offered for `execute`.

**Refusals the sheet shows before Start, with the server re-checking each on Start when it can read the repo:**

- A new branch's name already exists, locally or on `origin`. The sheet offers to switch to Continue on it.
- The branch to continue is checked out **in the mapped checkout itself**. A worktree cannot take a branch another tree holds, and moving the main checkout is
  the anti-goal. The refusal names the tree.

A branch to continue that is already checked out in some **other** worktree is not a refusal. The session enters that worktree, and the sheet says so ("will
work in `<path>`") *(my call: refusing would block the second Start on the user's own hand-made worktrees; the one-session-per-key live map already prevents
two Runs of the same ticket)*.

The prompt preview, Start and Copy prompt all carry the branch choice. `GET /api/jira/prompt` and `POST /api/agents/dispatch-jira` gain the same five
fields:

- `mode`: `new`, `continue` or `none`;
- `branch`;
- `base`, for `new` only;
- `openMr`, a boolean (5.6);
- `target`, accepted only with `openMr` and `continue` (5.6).

Both routes validate these fields identically, as they validate `repo` today, and both refuse `none` with `execute`. `branch`, `base` and `target` all pass §6's
name checks. A `new` `branch` that fails 5.2's matcher for the key is refused with 400 `branch must carry <KEY>`, so a Copy-prompt or API caller cannot
create a branch the board will never find. `jira.mjs worktree` re-checks the same rule and exits `4`.

### 5.4 The prompt

Every Run prompt with a branch gains a **workspace block** ahead of the instruction. It names the repo, the mode, the branch, the base and the worktree path,
and tells the session to run `jira.mjs worktree` with those values from the mapped repo's root. The tool does steps 1–3 below and prints the worktree path,
or exits non-zero with git's sentence:

1. `git fetch origin`.
2. Create the worktree, or enter the existing one:
   - `new`: the new branch is cut from `origin/<base>` when that exists after the fetch, and otherwise from the local `<base>` *(my call: "fetch first"
     means the fresh remote copy wins)*.
   - `continue`, local branch exists: fast-forward it to `origin/<branch>` when it is strictly behind. If it has diverged, stop and report — never reset, never
     merge.
   - `continue`, only `origin/<branch>` exists: create a local branch tracking it.
   - `continue`, a worktree already holds the branch: enter that worktree, and apply the same fast-forward rule inside it. A strictly-behind branch is
     fast-forwarded, but only when that worktree is clean. If it is dirty, the tool enters it as it is and reports "behind origin by N, not fast-forwarded:
     uncommitted changes". A diverged branch stops the Run, as above.

   Before step 2, right after the fetch, the tool re-checks the two refusals of 5.3 itself, because the server may not have been able to check them (an
   unmounted repo, §4):
   - `continue` on the branch the mapped checkout itself holds: stop with exit `4` and name the tree.
   - `new` on a name that exists locally or on `origin`: stop with exit `4` and say "exists — Start again with Continue".
3. Confirm with `git rev-parse --abbrev-ref HEAD` inside it.
4. Do all further work inside that worktree, and never check out anything in the mapped checkout.

If any step fails, the session stops and reports. It does not improvise another branch.

**Two Starts in one repo at once** (a success criterion) can collide inside git: `git fetch` takes a ref lock, and `info/exclude` is read and then appended to.
The tool retries a fetch that failed on a lock once, after a short pause. If the second attempt also fails, the tool goes on without a fetch and prints
"fetch failed: <git's sentence> — using refs as of last fetch". It does not exit. A duplicate line in `info/exclude` from a race is harmless, and
`ensureExcludeLines` stays as it is.

The built-in `execute` instruction loses its own "branch" step, which the workspace block now owns. Skills get the same block, plus three new placeholders,
`{branch}`, `{base}` and `{worktree}`, beside `{key}`, `{url}` and `{repo}`; under `none` all three are empty.

`{worktree}` and the block's path are the **expected** path. That is the existing worktree that 5.2 found holding the branch, when the server could read the
repo, and `.worktrees/<branch with / replaced by ->` otherwise. **The path `jira.mjs worktree` prints is authoritative.** The block tells the session to use
the printed path and to ignore the expected one wherever they differ. Skill authors are told the same in the Setup hint for skills.

The block counts toward `JIRA_PROMPT_MAX`.

- **Built-ins:** the description-trimming already in place absorbs the block.
- **Skills:** a skill over the cap is `prompt too long` today (`composeJiraPrompt`), and stays so. The block must fit in a fixed budget, which the builder
  sets and states in the plan (for example ≤ 600 characters at the maximum branch, base and path lengths), so that a skill which fits today stops fitting
  only by that known amount.

**Worktree location** *(my call)*: `<mapped repo>/.worktrees/<branch with / replaced by ->`, the orchestrator's directory, kept out of `git status` the
orchestrator's way (`info/exclude`, never a tracked `.gitignore`). If the probe in §4 shows that `EnterWorktree` dictates a different location, use that
location and say so in the plan. An existing worktree found by 5.2 is used where it is.

### 5.5 After the session: the worktree on the board

A ticket's worktrees (5.2) show in the issue modal, and as a small branch chip on the card *(the card chip is my call, from the playback the user
confirmed)*. Each one has a **Remove** control. Because the server does not write git, Remove **copies a command**,
`git -C <mapped repo> worktree remove <path>`, which the person runs *(my call)*. The command has no `--force`, so git's own refusal for a dirty tree stands.
The control:

- is disabled, with the reason shown, while the live map holds a session for this key;
- is not offered for the mapped checkout itself;
- never touches the branch.

Sessions the board does not know about, such as Copy-prompt sessions or a terminal opened in the worktree, cannot be detected. The copied command's tooltip
says so; the person running it is the check.

### 5.6 Opening an MR (opt-in, per Start)

The launch sheet gains one toggle, **Open MR when done**, off by default, and offered only with a branch (`new` or `continue`) and the `execute` action
*(my call: a skill's prompt is its template and the key, with no `COMMIT_RULE` to amend; a skill that wants an MR says so in its own template)*.

- **Off:** the prompt keeps today's `COMMIT_RULE` ("commit … Do not push").
- **On:** the commit rule's last sentence is replaced. The session commits, pushes its branch, and opens one merge request from it into the base. For `new`,
  the base is the base the sheet chose. For `continue`, the sheet asks for a target, pre-filled from the repo's default base.

How the MR gets opened depends on the host:

- **GitLab:** the session hands off to the `mr-review-loop` skill when that skill is installed, and otherwise uses `glab mr create`.
- **GitHub:** the session uses `gh pr create`.
- **Neither:** the session pushes and reports the exact command to run by hand.

An MR that fails to open is not a session failure. The session says that the branch is pushed and gives the command, the way the orchestrator's §10 does. The
board does not watch the MR.

## 6. Invariant changes this needs (name them in the plan and in `invariants.md`)

- **`jira.mjs` gains its first git-writing command, `worktree`.** Today it is API-only and writes no file. The headline in CLAUDE.md
  (`skills/jira/tools/jira.mjs` "is API-only and writes no file") and its subsystem doc change with it. The worktree code it shares with `orchestrate.mjs`
  keeps that tool's rule: it creates only the tree it was asked for, and never prunes, `-D`s or `--force`s.
- **Who pushes.** "`backlog-orchestrate` is the only skill that commits or merges — and, for a TRACKER project only, the only one that pushes." That rule is
  about this plugin's skills operating on backlog items. A Jira Run's push is the spawned session following its prompt, in a foreign repo, only when the
  person ticked §5.6. The invariant entry gains a sentence saying so, so the two do not read as a contradiction.

- **Container mounts land on host paths, read-only.** This still holds, and gains a second root for Jira repos. The compose comment and the invariant entry say
  why: the server reads these repos' refs, and it never writes them.
- **The server never writes git.** This was true but unstated. Make it a stated rule now that the server reads foreign repos: fetch, worktree add/remove and
  checkout are the session's.
- **`jira.json` gains `repoDefaults`.** It has the same single writer and the same never-replace-an-unreadable-file rule.
- **`jira.mjs` always needs the stack up, and says so with exit `5`.** This is a CLAUDE.md headline, and the rest of `jira.mjs` keeps it. `worktree` makes no
  API call, so it is the exception, and the headline and `.claude/rules/skills.md` ("every command is an API call") say so. `worktree` exits like this:
  - `0`: the worktree is ready, with its path printed as JSON.
  - `1`: a usage error, with the same meaning as for every other `jira.mjs` command (skills/jira/SKILL.md, Exit codes).
  - `4`, a new code: git refused, or a 5.4 re-check stopped the Run. Nothing was changed, and the sentence comes from git or from the re-check. The SKILL.md
    exit-code table gains this row.
  - Never `2`, `3` or `5`, since no request is made.
- **The spawn prompts are composed server-side.** That stays true. The workspace block is composed there too, from fields the server has validated:
  - `branch` and `base` are checked against `git check-ref-format --branch` rules, with no repo needed, on both routes and whether or not the repo is mounted.
  - Each is at most 200 characters.
  - A name containing a character outside `[A-Za-z0-9._/-]` is refused, even though git allows more. The value is pasted into a shell command in the prompt,
    so quoting is not left to the session.
  - The editable Name is a client-sent string; it is accepted only after these checks.

## 7. Left to the builder

- The route names and exact response shapes for the branch listing and the defaults write.
- Caching of the ref listing.
- The probe in §4, and whether it needs a spike before the plan.
- The compose variable name for the second root, and how Setup learns which roots are mounted.
- The UI layout inside the launch sheet, Setup row and modal, following `.claude/DESIGN.md`. Mocks can go over the live page if the user wants them, in the
  light theme.
- Test cases:
  - the 5.2 matcher: key boundaries, case, `feature/` and `hotfix/` prefixes, `origin/` dedupe;
  - pattern rendering and the refusal for a pattern without a key;
  - the 5.3 modes and refusals, and the "not mounted" degraded path;
  - the 5.4 prompt for each mode, and for a skill with each new placeholder;
  - the 5.5 disabled state.
