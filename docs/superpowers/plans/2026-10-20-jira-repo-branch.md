# Jira Run — repository and branch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template, on purpose:** this plan gives behaviour, signatures, exact values and exact test cases — **never literal code**.
> Handed code gets transcribed verbatim, and a bug in it becomes a bug in the branch with nobody positioned to catch it. Where a test is described as a case
> list, write it in the suite's own style. Disagree with the plan where the code says otherwise, and say so in the task's report. Any size figure here is a
> soft target, never a reason to drop a rule.

**Goal:** a Jira Run names a repository and a branch (new off a base, or an existing one), and the spawned session works in its own git worktree of that
branch; the board derives a ticket's branches and worktrees from git and shows them.

**Architecture:** the server only *reads* git (refs, worktrees, `FETCH_HEAD`) through `runGit` and validates the branch choice; the composed prompt gains a
workspace block telling the session to run a new `jira.mjs worktree` command, which does every git write (fetch, worktree add, fast-forward, exclude lines,
`node_modules` link). Pure naming rules (matcher, name checks, slug, pattern) live in one shared TS module used by server and client, and are duplicated —
with the same case table — into `jira.mjs`, because a skill's `tools/` may never import from elsewhere.

**Tech Stack:** NestJS (server), React + Vite (client), node ESM skill tool, jest (`test/`), `node --test` (`skills/*/tools/*.test.mjs`), git ≥ 2.40.

**Spec:** [docs/superpowers/specs/2026-10-20-jira-repo-branch-design.md](../specs/2026-10-20-jira-repo-branch-design.md) — read it with this plan. §4 was
amended alongside this plan: the worktree code is **duplicated** into `jira.mjs`, not extracted (the user's ruling, 2026-10-20), and `orchestrate.mjs` is not
touched at all.

## Global Constraints

- Text wraps at 160 columns (code comments, docs); commit bodies at 72. Comments explain *why*, matching the existing density.
- Every server git read is `runGit` (`server/src/git-run.util.ts`): async, 10 s bound, a timeout lands in the call site's failure branch. No `spawnSync`/`execSync`.
- The server never writes git: no fetch, no worktree add/remove, no checkout, no branch write — anywhere, ever.
- No skill's `tools/` imports another skill's, the server's, or `shared/`. `jira.mjs` carries its own copies; `orchestrate.mjs` is unchanged by this plan.
- Every skill CLI ends `process.exitCode = await main(...)`.
- `jira.mjs worktree` exits `0` (JSON on stdout), `1` (usage), `4` (git refused or a re-check stopped); never `2`, `3`, `5`; it makes no HTTP request.
- Branch, base and target names: at most **200** characters, characters only from `[A-Za-z0-9._/-]`, plus `git check-ref-format --branch` rules (Table A).
- Default name pattern `{key}-{slug}`; placeholders `{key}` (lower-cased key), `{KEY}` (as Jira writes it), `{slug}`. Sample render: key `ABC-1`, slug
  `sample-slug`.
- Slug: 40 characters maximum (Table C rules).
- Worktree location: `<mapped repo>/.worktrees/<branch with every / replaced by ->`; exclude lines `.worktrees/` and `node_modules`, appended to
  `<common dir>/info/exclude`, never `.gitignore`.
- The workspace block's fixed text — the block rendered with repo, branch, base, worktree all empty — is **≤ 600 characters** (spec §5.4's budget).
  `JIRA_PROMPT_MAX` stays `4000`.
- Fetch retry: one retry after a **1000 ms** pause (overridable in tests by `BM_JIRA_FETCH_RETRY_MS`), only when git's message names a lock.
- New routes are under `/api/jira`; the one write route is `SameOriginPostGuard`-guarded, refuses while `jira.json` is unreadable, and goes through
  `config.util.ts`'s `readRawForWrite`/`writeRawAtomic`.
- A supertest suite listens via `listenLoopback`; jsdom fixture dates via `daysAgoDate`/`daysAgoStamp`.
- UI follows `.claude/DESIGN.md`; every new component cites its subsection in a header comment. Mocks, if any, are light theme.
- PR title passes `ci / pr-title`, e.g. `feat(jira): pick a repo and a branch, work in a worktree`.
- Locally run only the suites a task touches; CI runs the full `pnpm test`.

## Shared tables (referenced by several tasks)

**Table A — `branchNameProblem(name)`; `null` means valid.** Checked in this order, first hit wins, exact strings:

| input | result |
| --- | --- |
| `feature/timify-123-x`, `TIMIFY-123`, `release/1.2`, `a_b.c` | `null` |
| `` | `is empty` |
| 201 × `a` | `is longer than 200 characters` |
| `feat ure`, `feat~1`, `a:b`, `a@b`, `ä` | `may hold only A-Z a-z 0-9 . _ / -` |
| `-x` | `may not start with -` |
| `a..b` | `may not contain ..` |
| `/a`, `a/`, `a//b` | `may not start or end with /, or contain //` |
| `a/.b`, `.a` | `may not have a part starting with .` |
| `a.lock`, `a.lock/b` | `may not have a part ending in .lock` |
| `a.` | `may not end with .` |

**Table B — `branchCarriesKey(branch, key)`**, key `TIMIFY-123`, case-insensitive, both sides bounded by a non-alphanumeric character or the string's end:
true for `TIMIFY-123-fix-login`, `feature/timify-123-x`, `hotfix/timify-123`, `TIMIFY-123`, `feature/timify-123_x`; false for `timify-1234-x`,
`xtimify-123`, `1timify-123`, `feature/timify-12-x`, `develop`.

**Table C — `slugOf(summary)`:** `Export contacts to CSV` → `export-contacts-to-csv`; `Ünïcödé — Fix: Löğin!!` → `unicode-fix-login`; `--Fix--` → `fix`;
`   ` → ``; `日本語` → ``; `Implement the new contact export pipeline for enterprise customers` → `implement-the-new-contact-export` (cut at the `-`
at character 33); 45 × `a` → 40 × `a`.

**Table D — `renderBranchPattern(pattern, key, slug)`**, key `TIMIFY-123`: `{key}-{slug}` + `export-contacts` → `timify-123-export-contacts`;
`feature/{key}-{slug}` + `x` → `feature/timify-123-x`; `{KEY}_{slug}` + `x` → `TIMIFY-123_x`; `{key}-{slug}` + `` → `timify-123`;
`feature/{key}_{slug}` + `` → `feature/timify-123`; `{slug}-{key}` + `` → `timify-123` (*my call, beyond the spec:* when nothing precedes `{slug}`, the
separator after it goes instead). The separators are `-`, `_`, `/`, `.`.

**Table E — `patternProblem(pattern)`; `null` means valid.** Renders the sample (`ABC-1`, `sample-slug`), then runs Table A, then Table B for `ABC-1`:
`{key}-{slug}` → `null`; `feature/{key}-{slug}` → `null`; `{KEY}-{slug}` → `null`; `{slug}` → `renders as sample-slug, which does not carry ABC-1`;
`x{key}` → `renders as xabc-1, which does not carry ABC-1`; `{key}1` → `renders as abc-11, which does not carry ABC-1`; `-{key}` →
`renders as -abc-1, which may not start with -`; `{key} {slug}` → `renders as abc-1 sample-slug, which may hold only A-Z a-z 0-9 . _ / -`;
`{foo}-{key}` → `renders as {foo}-abc-1, which may hold only A-Z a-z 0-9 . _ / -`.

## Review Focus

1. **Two branch names that flatten to one worktree directory** (`feature/a-TIMIFY-1` and `feature-a/TIMIFY-1` both map to `.worktrees/feature-a-TIMIFY-1`):
   the tool must stop with exit 4 naming the branch that holds the directory, never enter another branch's tree. Test in Task 2.
2. **A repo with no `origin` remote** (local-only checkout): fetch fails without a lock message → the tool continues with the `fetch failed` note, cuts from
   the local base; the listing shows local branches only, `fetchedAt: null` → `never fetched`. Tests in Tasks 2 and 3.
3. **A mapped checkout on a detached HEAD** (mid-rebase, a tag checkout): `mainBranch` is `null`, no Continue refusal fires, the listing still works, the base
   default skips "current branch". Test in Task 3.
4. **A summary that slugs to nothing** (empty, emoji-only, all CJK): the pre-filled name is the pattern without the slug and its separator, never ending in
   `-`. Tests in Tasks 1 and 7.
5. **A mapped repo path holding a space or a `'`**: the prompt's `jira.mjs worktree` command and the Remove command both single-quote paths (`'` written as
   `'\''`), so pasting either into a shell runs the intended command. Tests in Tasks 5 and 9.

---

### Task 1: Shared naming rules

**Files:**
- Create: `shared/jira-branch.ts`
- Test: `test/jira-branch.test.ts`

**Interfaces:**
- Produces (all pure, no I/O):
  - `BRANCH_NAME_MAX = 200`, `DEFAULT_NAME_PATTERN = '{key}-{slug}'`, `SLUG_MAX = 40`, `PATTERN_SAMPLE = { key: 'ABC-1', slug: 'sample-slug' }`
  - `branchNameProblem(name: string): string | null` — Table A
  - `branchCarriesKey(branch: string, key: string): boolean` — Table B
  - `slugOf(summary: string): string` — Table C (spec §5.3's five steps; diacritics stripped via NFKD + removal of combining marks)
  - `renderBranchPattern(pattern: string, key: string, slug: string): string` — Table D
  - `patternProblem(pattern: string): string | null` — Table E
  - `worktreePathFor(repo: string, branch: string): string` — `/r` + `feature/timify-123-x` → `/r/.worktrees/feature-timify-123-x`
  - `shellQuote(value: string): string` — always single-quoted: `/a b` → `'/a b'`; `/it's` → `'/it'\''s'`; `/plain` → `'/plain'`

- [ ] **Step 1:** write `test/jira-branch.test.ts` with one `it` per row of Tables A–E plus the `worktreePathFor` and `shellQuote` cases above.
- [ ] **Step 2:** run `pnpm run test:jest -- test/jira-branch.test.ts` — FAIL (module missing).
- [ ] **Step 3:** implement `shared/jira-branch.ts` to the signatures above. Header comment: why the char allowlist is narrower than git's (the value is
  pasted into a shell command in a prompt, spec §6).
- [ ] **Step 4:** run the suite — PASS. `pnpm run typecheck` clean.
- [ ] **Step 5:** commit `feat(jira): shared branch naming rules`.

### Task 2: `jira.mjs worktree`

**Files:**
- Modify: `skills/jira/tools/jira.mjs` (USAGE, a new `worktree` command beside `COMMANDS`, its own copies of the Table A/B checks, `ensureExcludeLines`, the
  lock-retry fetch)
- Test: `skills/jira/tools/jira.test.mjs`

**Interfaces:**
- Consumes: nothing at runtime (no imports from `shared/` or other skills). Tables A and B are re-implemented and re-tested here.
- Produces the CLI contract later tasks print into prompts:
  `jira.mjs worktree <KEY> --repo <path> --mode new|continue --branch <name> [--base <name>]`
  → stdout one JSON line `{ "worktree": <abs path>, "branch": <name>, "created": "new" | "tracked" | "attached" | "entered", "notes": string[] }`.
  `created`: `new` cut from a base; `tracked` a local branch made from `origin/<branch>`; `attached` an existing local branch given a new worktree; `entered`
  an existing worktree reused. Exported for tests: `isLockFailure(stderr: string): boolean`, `ensureExcludeLines(commonDir, patterns)` (same behaviour as
  `orchestrate.mjs`'s, copied with its comment, which now names the duplicate).

Behaviour, in order (spec §5.4):
1. Usage → exit 1 with the command's usage line: missing `--repo`/`--mode`/`--branch`, `--mode` not `new`/`continue`, `--base` missing with `new` or present
   with `continue`, a key failing `normaliseKey`, a `--branch`/`--base` with a Table A problem (`--branch may not contain ..`).
2. `--repo` not a git work tree's top level → exit 4 `<repo> is not a git repository`.
3. `git -C <repo> fetch origin`; on failure where `isLockFailure` is true, wait the retry pause and try once more; any final failure adds note
   `fetch failed: <git's fatal/error line> — using refs as of last fetch` and continues (exit is unaffected).
4. Re-checks, each exit 4 with nothing changed: `new` and the branch fails Table B → `branch must carry <KEY>`; `new` and the branch exists locally or as
   `origin/<branch>` → `<branch> exists — Start again with Continue`; `new` and neither `origin/<base>` nor local `<base>` exists → `no base <base> locally or
   on origin`; `continue` and the main worktree holds the branch → `<branch> is checked out in the mapped checkout <repo> — a worktree cannot take it`;
   `continue` and the branch exists neither locally nor on origin → `no branch <branch> locally or on origin`.
5. A linked worktree already holding the branch (`worktree list --porcelain`) → `entered`. Otherwise target `worktreePathFor(repo, branch)`; if that path
   exists (registered to another branch, or a plain directory) → exit 4 `<path> already exists (holds <other branch> | is not a worktree)`.
6. Create: `new` → `worktree add --no-track -b <branch> <target> <origin/<base> or <base>>` (origin wins when it exists after the fetch — note
   `cut from local <base>: no origin/<base>` otherwise); `continue`, local exists → `attached`; only `origin/<branch>` → `worktree add --track -b <branch>
   <target> origin/<branch>` → `tracked`. Any `worktree add` failure → exit 4 with git's `fatal:` line.
7. Fast-forward (continue paths and `entered`): compare the branch with `origin/<branch>` when that exists. Strictly behind and the tree clean →
   `merge --ff-only origin/<branch>` inside the worktree, note `fast-forwarded N commits`; strictly behind and dirty → note `behind origin by N, not
   fast-forwarded: uncommitted changes`; diverged → exit 4 `<branch> has diverged from origin/<branch> (A ahead, B behind) — never reset, never merged`
   (on a created tree the tree is left in place, the message says so).
8. Only for trees this command created: `ensureExcludeLines(<common dir>, ['.worktrees/', 'node_modules'])`; then, when `<repo>/node_modules` exists and
   `<target>/node_modules` does not exist (no file, no dir, no link), symlink it to `<repo>/node_modules`.
9. `rev-parse --abbrev-ref HEAD` inside the tree must equal the branch, else exit 4 `the worktree is on <other>, not <branch>`.
10. Print the JSON; exit 0.

- [ ] **Step 1:** add cases to `jira.test.mjs`. Fixture helper (in the suite): a bare `origin` repo with `main` and `develop`, a clone as the mapped repo
  with a `node_modules/` dir, tmp roots from the existing `test:skills` tmp convention. Cases:
  - Table A and Table B rows against the tool's own copies.
  - usage: no args → exit 1; `--mode new` without `--base` → exit 1; `--branch a..b` → exit 1 with `--branch may not contain ..`.
  - non-repo path → exit 4 `is not a git repository`.
  - new from `develop` with `origin/develop` one commit ahead of local `develop` → exit 0, `created: "new"`, worktree HEAD equals `origin/develop`'s commit,
    branch has no upstream, `info/exclude` holds both lines once, `node_modules` in the worktree is a symlink to the repo's.
  - new, run twice with two different branches → `info/exclude` still holds each line once.
  - new with a name that exists on origin only → exit 4 `exists — Start again with Continue`; `git worktree list` unchanged.
  - new with a name lacking the key → exit 4 `branch must carry TIMIFY-123`.
  - continue, origin-only branch → `created: "tracked"`, upstream `origin/<branch>`.
  - continue, local branch 2 behind origin → `attached`, note `fast-forwarded 2 commits`, HEAD equals origin's.
  - continue, diverged → exit 4 containing `has diverged`.
  - continue on the branch the clone itself has checked out → exit 4 containing `mapped checkout`.
  - continue, branch held by a hand-made sibling worktree outside `.worktrees/`, 1 behind, dirty → `entered`, `worktree` is the sibling's path, note
    `behind origin by 1, not fast-forwarded: uncommitted changes`, HEAD unchanged; same but clean → fast-forwarded.
  - Review Focus 1: `feature/a-TIMIFY-1` exists as a worktree; start `feature-a/TIMIFY-1` new → exit 4 naming `feature/a-TIMIFY-1`.
  - Review Focus 2: clone with its `origin` remote removed → new from local `main` exits 0, notes hold `fetch failed:` and `cut from local main`.
  - lock: a `<git dir>/refs/remotes/origin/main.lock` file present and `BM_JIRA_FETCH_RETRY_MS=10` → exit 0 with the `fetch failed:` note;
    `isLockFailure` true for `cannot lock ref 'refs/remotes/origin/main'` and `Unable to create '/r/.git/shallow.lock': File exists.`, false for
    `fatal: 'origin' does not appear to be a git repository`.
  - an existing real `node_modules` directory in a reattached worktree is left a directory.
  - the source still ends `process.exitCode = await main(` (the existing guard covers it; confirm it stays green).
- [ ] **Step 2:** `pnpm run test:skills` — the new cases FAIL.
- [ ] **Step 3:** implement. Synchronous `spawnSync` git is fine here (a CLI, not the server). Never `--force`, `-D`, `prune`, `reset`, plain `merge`.
- [ ] **Step 4:** `pnpm run test:skills` — PASS.
- [ ] **Step 5:** commit `feat(jira): jira.mjs worktree cuts or enters a ticket's worktree`.

### Task 3: Server ref reads, two read routes, the second compose root

**Files:**
- Create: `server/src/jira/refs.util.ts`
- Modify: `server/src/jira/jira.controller.ts` (two `@Get`s), `shared/types.ts` (shapes below), `docker-compose.yml`, `server/src/jira/env.util.ts` (or a sibling
  — the roots reader)
- Test: `test/jira-refs.test.ts` (new), `test/jira-routes.test.ts`, `test/compose-env.test.ts`

**Interfaces:**
- Consumes: `runGit`, `branchCarriesKey` (Task 1), `readJiraConfig().repos`.
- Produces (in `shared/types.ts`):
  - `JiraRepoUnavailable = 'not mounted into the board' | 'does not exist' | 'not a git repository'`
  - `JiraRefBranch = { name: string; local: boolean; remote: boolean; sync: 'same' | 'behind' | 'ahead' | 'diverged' | null; committedAt: string;
    worktree: string | null; ticket: boolean }` — `name` never carries `origin/`; `sync` only when both exist and the local branch's upstream is
    `origin/<name>` (read from `%(upstream:track)` in one `for-each-ref`), else `null`; `worktree` the absolute path of the tree holding it, the main tree
    included.
  - `JiraRepoRefs = { repo: string; available: true; fetchedAt: string | null; mainBranch: string | null; defaultBase: string | null; branches:
    JiraRefBranch[] } | { repo: string; available: false; reason: JiraRepoUnavailable }`. Branches sorted: `ticket` first by `committedAt` descending, then
    the rest by name. `defaultBase`: `storedBase` when non-null, else `origin/HEAD`'s target without `origin/`, else `mainBranch`, else `null`.
  - `JiraWorktree = { repo: string; path: string; branch: string | null; main: boolean }`;
    `JiraWorktreesPayload = { worktrees: JiraWorktree[]; unavailable: { repo: string; reason: JiraRepoUnavailable }[] }`.
  - `readRepoRefs(repo: string, key: string | null, roots: string[] | null, storedBase: string | null): Promise<JiraRepoRefs>` — the route passes `null`
    until Task 4 wires the stored base; `readWorktrees(repo, roots): Promise<JiraWorktree[] |
    JiraRepoUnavailable>`; `repoRoots(): string[] | null` from env `BM_REPO_ROOTS` (`:`-separated absolute paths, read per call; unset or empty → `null`,
    which skips the "not mounted" check — a host-run API).
  - `GET /api/jira/refs?repo=<path>&key=<KEY>` (key optional; `ticket` false everywhere without it) → `JiraRepoRefs`. 400 `repo is required`, 400
    `invalid issue key`, 400 `<repo> is not mapped` when the normalised path is in no project's list, 503/409 as `/prompt` does for unconfigured/unreadable.
  - `GET /api/jira/worktrees` → `JiraWorktreesPayload` over every distinct mapped path.

Checks for unavailability, in spec §4's order: outside every root (only when `repoRoots()` is non-null) → `not mounted into the board`; path missing →
`does not exist`; `rev-parse --show-toplevel` fails or differs from the path → `not a git repository`. `fetchedAt` is `<common dir>/FETCH_HEAD`'s mtime
as ISO, `null` when the file is absent. No caching (*my call*: per request, each read bounded by `runGit`; revisit only if the sheet feels slow).

Compose: a second read-only mount `${BM_JIRA_REPO_ROOT:-${HOME}/Documents/timify-projects}` at the same path, and on the server service `BM_REPO_ROOTS`
set to the two roots joined by `:`, each with the same default its mount uses. Comment: why read-only (the server reads refs, never writes them) and why the
roots are passed (so Setup can say "not mounted").

- [ ] **Step 1:** `test/jira-refs.test.ts` — real git fixtures in a tmp dir (bare origin + clone + a linked worktree), the function called directly:
  - key `TIMIFY-123`: branches `feature/timify-123-a` (local + origin, local 1 behind, upstream set) and `TIMIFY-123-b` (origin only) come first, newest
    commit first, `ticket: true`; `feature/timify-1234` is `ticket: false`; `develop` once, not twice; `sync` `behind` / `null` as set up.
  - `worktree` holds the linked tree's absolute path for its branch and the clone's path for the checked-out branch; `mainBranch` is that branch.
  - `defaultBase` = `develop` when `origin/HEAD` → `origin/develop` and `storedBase` is `null`; = `storedBase` when it is `release/2`.
  - Review Focus 2: no origin, no `FETCH_HEAD` → `fetchedAt: null`, branches all `remote: false`.
  - Review Focus 3: clone on a detached HEAD → `mainBranch: null`, listing intact, `defaultBase` falls past it to `null` when there is no `origin/HEAD`.
  - unavailable: roots `['/elsewhere']` → `not mounted into the board`; roots `null` and a missing path → `does not exist`; an empty dir → `not a git
    repository`; a subdirectory of a repo → `not a git repository`.
  - `repoRoots()`: unset → `null`; `'/a:/b'` → `['/a', '/b']`; `'/a::'` → `['/a']`.
- [ ] **Step 2:** route cases in `test/jira-routes.test.ts` (existing mocking style): the four 400s above; 200 shapes for both routes with `readRepoRefs`
  / `readWorktrees` stubbed; `/worktrees` lists a mapped path once even when two projects map it, and reports an unavailable one under `unavailable`.
- [ ] **Step 3:** `test/compose-env.test.ts`: the server service mounts `BM_JIRA_REPO_ROOT`'s default read-only at the same path, and `BM_REPO_ROOTS`
  names both roots with the mounts' defaults.
- [ ] **Step 4:** run the three suites — FAIL; implement; run — PASS; `pnpm run typecheck`.
- [ ] **Step 5:** commit `feat(jira): read a mapped repo's branches and worktrees`.

### Task 4: `repoDefaults` in `jira.json`

**Files:**
- Modify: `server/src/jira/config.util.ts`, `server/src/jira/jira-write.controller.ts`, `server/src/jira/jira.controller.ts` (status payload; `/refs` passes
  `repoDefaults[repo]?.base ?? null`), `shared/types.ts`
- Test: `test/jira-config.test.ts`, `test/jira-config-write.test.ts`, `test/jira-write-routes.test.ts`

**Interfaces:**
- Consumes: `branchNameProblem`, `patternProblem` (Task 1), `normaliseRepoPath`, `readRawForWrite`, `writeRawAtomic`.
- Produces: `JiraRepoDefaults = { base?: string; namePattern?: string }`; `readJiraConfig()` gains `repoDefaults: Record<string, JiraRepoDefaults>`;
  `JiraStatusPayload.repoDefaults` (same record, `{}` while unconfigured); `parseRepoDefaultsWrite(body, home)`;
  `writeRepoDefaults(path: string, value: JiraRepoDefaults, file?)`; `POST /api/jira/repo-defaults` with body `{ path: string, base: string | null,
  namePattern: string | null }` answering `{ path, base, namePattern }` as stored (normalised path, `null` for unset).

Rules: the reader drops an entry whose key is not an absolute normalised path or whose values fail Table A / Table E (a hand-edited bad value is ignored,
not fatal), and keeps the rest. A write with both `null` deletes the path's entry; every other key of `repoDefaults` and every other top-level key survive.
Refusals (400): `path is required`; `<path> is not mapped` (in no project's list); `base <Table A problem>`; `namePattern <Table E problem>`; a non-string,
non-null value → `base must be a string or null` / `namePattern must be a string or null`. The existing-base check is deliberately absent (spec §5.1).
Unreadable file → 409 with the existing sentence, file byte-identical.

- [ ] **Step 1:** cases: reader keeps `{ "/r": { base: "develop", namePattern: "feature/{key}-{slug}" } }`, drops `{ "relative": … }`, drops a
  `namePattern: "{slug}"` but keeps that entry's valid base; writer adds, updates, deletes-on-both-null, leaves `repos`/`boards`/`skills` byte-equal in
  value; `/api/jira/refs` passes the stored base to `readRepoRefs` (route case); route: each refusal sentence above,
  same-origin 403 for a cross-origin POST, 409 on an unreadable file with the file unchanged, 200 echo; status
  payload carries `repoDefaults`.
- [ ] **Step 2:** run — FAIL; implement; run — PASS.
- [ ] **Step 3:** commit `feat(jira): per-repo default base and branch name pattern`.

### Task 5: The composer's workspace block

**Files:**
- Modify: `server/src/jira/prompt.util.ts`, `shared/types.ts`
- Test: `test/jira-prompt.test.ts`

**Interfaces:**
- Consumes: `shellQuote` (Task 1).
- Produces: `JiraWorkspace = { mode: 'new' | 'continue'; branch: string; base: string | null; worktree: string; openMr: boolean; target: string | null }`
  (in `shared/types.ts`); `composeJiraPrompt(detail, action, repo, workspace: JiraWorkspace | null, nonce?)` — `null` is mode `none`;
  `workspaceBlock(key: string, repo: string, ws: JiraWorkspace): string` exported for the budget test.

Behaviour:
- With a workspace, the block comes first, then the existing instruction/ticket (built-ins) or the filled template (skills). It names repo, mode, branch,
  base (new only) and the expected worktree; tells the session to use the `backlog-manager:jira` skill to run
  `jira.mjs worktree <KEY> --repo <q(repo)> --mode <mode> --branch <branch>` plus ` --base <base>` for new (`q` = `shellQuote`; branch and base are
  unquoted — Table A makes them shell-safe); to treat the printed `worktree` path as authoritative over the expected one; to switch into it with
  `EnterWorktree` (`path`) and, if that tool is unavailable or refuses, to work by absolute path and `git -C`; to confirm the branch with `git rev-parse
  --abbrev-ref HEAD` there; to never check anything out in the mapped checkout; and, on any non-zero exit or mismatch, to stop and report without inventing
  another branch.
- `execute`'s instruction loses `create a branch for it, `. With `openMr` the closing rule is `COMMIT_RULE` with its last sentence (`Do not push.`) replaced
  by: push the branch and open one merge request from it into `<target or base>` — GitLab: the `mr-review-loop` skill if installed, else `glab mr create`;
  GitHub: `gh pr create`; neither: push and report the exact command — and an MR that fails to open is not a failure of the session: say the branch is
  pushed and give the command. Without `openMr`, `COMMIT_RULE` is byte-identical to today.
- Skills: `PLACEHOLDER_RE` gains `branch`, `base`, `worktree`; values are the workspace's (`base` empty for continue), all three empty under `none`; under
  `none` no block is added. The skill's cap check covers block + template.

- [ ] **Step 1:** cases:
  - `workspaceBlock` with repo, branch, base, worktree all `''` has length ≤ 600.
  - new: prompt starts with the block; contains `jira.mjs worktree TIMIFY-123 --repo '/r' --mode new --branch feature/timify-123-x --base develop`;
    contains `EnterWorktree`, `git -C`, `/r/.worktrees/feature-timify-123-x`; the instruction no longer contains `create a branch`.
  - continue: command has no `--base`; Review Focus 5: repo `/my repos/it's` appears as `'/my repos/it'\''s'`.
  - `none` (`null`) for `context`: byte-identical to today's composition for the same detail and nonce.
  - openMr off: contains `COMMIT_RULE` exactly; on with target `release/2` (continue): does not contain `Do not push.`, contains `release/2`,
    `mr-review-loop`, `glab mr create`, `gh pr create`; on with new and base `develop`: contains `into develop`.
  - skill template `B={branch} BASE={base} W={worktree} K={key}` → values filled under new; under continue `BASE=` empty; under `none` all three empty and
    no block.
  - a skill template that fits today at exactly `JIRA_PROMPT_MAX` stays ok under `none` and becomes `prompt too long` with a workspace.
  - a built-in with a long description still fits under a workspace (trimming absorbs the block): length ≤ 4000, `truncated` note present.
- [ ] **Step 2:** run — FAIL; implement; run — PASS (existing cases updated only where the signature gained `workspace`, passing `null`).
- [ ] **Step 3:** commit `feat(jira): the prompt's workspace block and the opt-in MR rule`.

### Task 6: The branch choice on `/prompt` and `dispatch-jira`

**Files:**
- Create: `server/src/jira/branch-choice.util.ts`
- Modify: `server/src/jira/jira.controller.ts` (`prompt`), `server/src/agents/jira-agents.controller.ts`, `server/src/agents/jira-dispatch.service.ts`,
  `shared/types.ts` (`JiraDispatchRequest` gains `choice: JiraBranchChoice`, built by the controller from the body's five flat fields)
- Test: `test/jira-branch-choice.test.ts` (new), `test/agents-dispatch-jira.test.ts`, `test/jira-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3 (`readRepoRefs`, `repoRoots`), 4, 5 (`JiraWorkspace`, `composeJiraPrompt`).
- Produces: `JiraBranchChoice = { mode: 'none' } | { mode: 'new'; branch: string; base: string; openMr: boolean } | { mode: 'continue'; branch: string;
  openMr: boolean; target: string | null }`;
  `parseBranchChoice(raw: { mode?, branch?, base?, openMr?, target? }, key: string, action: JiraAction): { ok: true; value: JiraBranchChoice } | { ok: false;
  error: string }` — `raw` is spec §5.3's five flat fields, on the query and in the body alike; the query (`openMr` as
  `'true'`/`'false'`, absent = false) and the JSON body (`openMr` boolean, absent = false) both reduce to it;
  `resolveWorkspace(choice, key, repo, refs: JiraRepoRefs): { ok: true; workspace: JiraWorkspace | null } | { ok: false; status: 409; error: string }`.

`parseBranchChoice` refusals (400), first hit wins, exact: `mode must be new, continue or none`; `execute needs a branch (mode new or continue)`;
`branch is not for mode none`; `branch is required`; `branch <Table A problem>`; `base is required for a new branch`; `base is only for a new branch`;
`base <Table A problem>`; `branch must carry <KEY>` (new only); `openMr must be true or false`; `openMr is only for execute with a branch`;
`target is only for openMr with continue`; `target is required`; `target <Table A problem>`.

`resolveWorkspace`, only when `refs.available` (spec §5.3, re-checked by the server): new and the name is a listed branch → 409 `<branch> exists — switch to
Continue`; continue and `refs.mainBranch === branch` → 409 `<branch> is checked out in the mapped checkout <repo>`. The expected worktree is the listed
branch's `worktree` when it is a linked tree, else `worktreePathFor(repo, branch)`; unavailable refs → always `worktreePathFor`, no refusals.

Both routes: shape checks (including `parseBranchChoice`) before the configured check, as today; refs are read after the repo mapping check; the composed
prompt gets the workspace. The dispatch service reads refs before reserving the live map key.

- [ ] **Step 1:** `test/jira-branch-choice.test.ts`: every refusal string above from a minimal failing input; `none` + `context` ok; `none` + skill ok;
  new + execute ok; continue + openMr + target ok; `resolveWorkspace` cases: exists → 409 sentence; main-checkout branch → 409 sentence; branch held by a
  linked worktree → that path; unavailable → `.worktrees/` path, no refusal.
- [ ] **Step 2:** route cases: `/prompt` with `mode=new&branch=…&base=develop` returns text containing the block; `/prompt` without `mode` → 400
  `mode must be new, continue or none`; `dispatch-jira` body without `mode` → 400 same sentence; `dispatch-jira` with a 409 refusal does not spawn, does
  not assign, does not transition, and leaves the live map empty; a valid dispatch's spawned prompt equals the preview but for the nonce (existing case,
  extended with a workspace). Update existing dispatch cases to send `mode: 'none'` with `context`, or `mode: 'new'` plus `branch`/`base` with `execute`.
- [ ] **Step 3:** run — FAIL; implement; run — PASS; `pnpm run typecheck`.
- [ ] **Step 4:** commit `feat(jira): /prompt and dispatch-jira take the branch choice`.

### Task 7: Client lib

**Files:**
- Modify: `client/src/lib/jira.ts`
- Test: `test/jira-lib.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 6 shapes.
- Produces:
  - `fetchJiraRefs(repo: string, key: string | null): Promise<JiraRepoRefs>`; `fetchJiraWorktrees(): Promise<JiraWorktreesPayload>`;
    `saveRepoDefaults(path, base: string | null, namePattern: string | null): Promise<…>` (or via the existing `postJson` the Setup group uses).
  - `fetchJiraPrompt(key, action, repo, branch: JiraBranchChoice)` — query adds `mode`, and `branch`/`base`/`openMr`/`target` only when set.
  - `fetchAgeLine(fetchedAt: string | null, now: number): string` — `never fetched`; under 1 min `as of last fetch, just now`; `… , 7 min ago` (< 60 min);
    `… , 3 h ago` (< 48 h); `… , 4 d ago`.
  - `branchSheetDefaults(action: JiraAction, refs: JiraRepoRefs | null, key: string, summary: string, defaults: JiraRepoDefaults | undefined):
    { mode: 'new' | 'continue' | 'none'; branch: string; base: string }` — `context` → `none`; otherwise the first `ticket` branch → `continue` on it;
    else `new` with `renderBranchPattern(defaults?.namePattern ?? DEFAULT_NAME_PATTERN, key, slugOf(summary))` and base `refs.defaultBase ?? ''`
    (unavailable refs: `defaults?.base ?? ''`).
  - `branchRefusal(mode, branch, key, refs): { text: string; offerContinue: boolean } | null` — the sheet's pre-Start checks: Table A problem →
    `branch <problem>`; new failing Table B → `branch must carry <KEY>`; new and listed → `<branch> exists`, `offerContinue: true`; continue and
    `mainBranch` → `<branch> is checked out in the mapped checkout <repo>`.
  - `ticketWorktrees(key: string, payload: JiraWorktreesPayload): JiraWorktree[]` — non-main trees whose branch carries the key, by repo then path.
  - `removeCommand(t: JiraWorktree): string` — `git -C <shellQuote(repo)> worktree remove <shellQuote(path)>`, never `--force`.

- [ ] **Step 1:** cases: each `fetchAgeLine` bucket with a fixed `now`; `branchSheetDefaults` — context → none; execute with ticket branches → continue on
  the newest; execute without → new `feature/timify-123-export-contacts` from pattern `feature/{key}-{slug}`, summary `Export contacts`, base `develop`;
  Review Focus 4: summary `🙂🙂` → `timify-123`; unavailable refs → base from stored defaults; `branchRefusal` each sentence; `ticketWorktrees` drops the
  main tree and `timify-1234` branches; `removeCommand` for `/my repos/it's`; `fetchJiraPrompt` URL for none/new/continue+openMr+target.
- [ ] **Step 2:** run — FAIL; implement; run — PASS.
- [ ] **Step 3:** commit `feat(jira): client helpers for the branch choice`.

### Task 8: Launch sheet Branch section and Open MR toggle

**Files:**
- Create: `client/src/components/jira/JiraBranchSection.tsx`
- Modify: `client/src/components/jira/JiraLaunchSheet.tsx`
- Test: `test/jira-launch.test.tsx`

**Interfaces:**
- Consumes: Task 7 helpers; `JiraStatusPayload.repoDefaults`.
- Produces: the sheet holds a `JiraBranchChoice`, sends it as the five flat fields on Start, and passes it to `fetchJiraPrompt` for the preview and Copy
  prompt.

Behaviour (spec §5.3, §5.6): the section sits under the repo picker, disabled until a repo is chosen, refetches refs when repo changes; shows
`fetchAgeLine`; a three-way control New / Continue / No branch, with No branch hidden for `execute`; Continue: a select whose first group is ticket
branches, then the rest, with a `behind`/`diverged` marker beside the chosen one and `will work in <path>` when a linked tree holds it; New: Base select
(names of all listed branches) and an editable Name; unavailable refs: `branches unavailable — <path> <reason>` and plain text fields for branch and base;
Open MR when done: a switch shown only for `execute` with New or Continue, off by default; with Continue on, a Target select pre-filled with
`refs.defaultBase`. A `branchRefusal` disables Start and Copy prompt and shows its text; `offerContinue` shows a button that switches to Continue on
that branch. Defaults recompute from `branchSheetDefaults` when action or repo changes, not on every refs reload.

- [ ] **Step 1:** jsdom cases (fetch mocked): execute + a ticket branch → Continue pre-selected on the newest; execute, none → New with the rendered name and
  `develop`; context → No branch selected; execute → no No-branch option; typing a name without the key → `branch must carry TIMIFY-123`, Start disabled;
  an existing name → `exists` + the button switches to Continue; Continue on the main checkout's branch → refusal, Start disabled; a branch in a linked
  tree → `will work in /r/.worktrees/x`; unavailable → the warning sentence and two text fields, Start enabled; never-fetched line; MR switch absent for
  context, present for execute + New, Target shown only with Continue; Start's POST body carries the five flat fields exactly; the preview request URL
  carries the fields.
- [ ] **Step 2:** run — FAIL; implement (header comment cites the `.claude/DESIGN.md` subsections used); run — PASS.
- [ ] **Step 3:** commit `feat(jira): the launch sheet's Branch section`.

### Task 9: Setup row defaults, the modal's worktrees, the card chip

**Files:**
- Modify: `client/src/components/jira/JiraReposGroup.tsx`, `client/src/components/jira/JiraIssueModal.tsx`, `client/src/components/jira/JiraCard.tsx`,
  `client/src/components/jira/JiraBoardView.tsx` (fetches worktrees once for the board)
- Test: `test/jira-setup.test.tsx`, `test/jira-modal.test.tsx`, `test/jira-board.test.tsx`

**Interfaces:**
- Consumes: Task 7 (`fetchJiraRefs(path, null)`, `fetchJiraWorktrees`, `ticketWorktrees`, `removeCommand`, `saveRepoDefaults`), `patternProblem` for an
  instant client-side hint (the server's sentence still wins on save).

Behaviour:
- Setup: each mapped path's row gains Default base and Branch name pattern fields (placeholders `origin/HEAD` and `{key}-{slug}`), saved through
  `/api/jira/repo-defaults`, server refusals shown in the group's existing error slot; the row fetches its refs once on mount and, when unavailable, shows
  `branches unavailable — <displayPath> <reason>`. The skills hint gains one line: `{branch}`, `{base}`, `{worktree}` — the worktree is the expected path;
  the one `jira.mjs worktree` prints wins.
- Board: fetches `/api/jira/worktrees` on mount and again whenever the set of live keys changes (not a poller; no timer). A card whose key has
  `ticketWorktrees` shows a small branch chip — the branch name when there is one tree, `N worktrees` otherwise.
- Modal: a Worktrees list (branch, path, repo) for the key; each row's Remove copies `removeCommand` to the clipboard; disabled with title `a session is
  running on <KEY>` while `live[key]` exists; enabled title `Copies the command. Sessions the board did not start — Copy prompt, a terminal — cannot be seen:
  make sure none is using this tree.`

- [ ] **Step 1:** cases: Setup saves `{ path, base: 'develop', namePattern: null }`; a `{slug}` pattern shows the hint and, on save, the server's sentence;
  an unavailable row shows the warning with `~` display; board fetches worktrees once on mount and once more when a live key appears, not on rerender; card
  chip text for one and two trees; modal Remove copies `git -C '/r' worktree remove '/r/.worktrees/x'` (Review Focus 5 path variant too), is disabled with
  the live title, is absent for the main tree.
- [ ] **Step 2:** run — FAIL; implement; run — PASS; `pnpm run typecheck`.
- [ ] **Step 3:** commit `feat(jira): repo defaults in Setup; worktrees on the card and in the modal`.

### Task 10: Docs, invariants, rules, SKILL.md

**Files:**
- Modify: `CLAUDE.md`, `docs/subsystems/invariants.md`, `.claude/rules/jira.md`, `.claude/rules/skills.md`, `.claude/rules/security.md`,
  `skills/jira/SKILL.md`, `docs/subsystems/jira.md`, `docs/subsystems/skills.md`, `docs/subsystems/api.md` (route list)
- Test: `test/claude-rules.test.ts` (existing guard), `skills/jira/tools/jira.test.mjs` if it pins SKILL.md text

What changes (spec §6, plus the duplication ruling):
- CLAUDE.md Layout: `jira/` gains the two read routes and the sixth write route; the `skills/jira/` sentence stops saying "API-only and writes no file" —
  `worktree` is git-only and writes no file of its own outside git.
- Headline `backlog.mjs in a tracker project — and jira.mjs always — needs the stack up …` gains the `worktree` exception; the byte-equal twin in its rule
  file changes in the same commit.
- New headline + rule bullet + `invariants.md` section: **The server never writes git** — fetch, worktree add/remove, checkout are the session's; its home
  rule file is `.claude/rules/security.md` (`git-run.util.ts` is in its glob).
- `invariants.md` "only skill that pushes" section gains the sentence that a Jira Run's push is the spawned session following its prompt, in a foreign repo,
  only when Open MR was ticked.
- "Container mounts land on host paths, read-only" names the second root and `BM_REPO_ROOTS`.
- `.claude/rules/jira.md`'s `jira.json` bullet names `repoDefaults` (same writer, never-replace rule); a bullet for the branch matcher and §6 name checks
  living in `shared/jira-branch.ts`, duplicated in `jira.mjs`.
- `.claude/rules/skills.md`: "every command is an API call" gains the `worktree` exception; `docs/subsystems/skills.md`'s duplication paragraph gains the
  `ensureExcludeLines` pair (`orchestrate.mjs`, `jira.mjs`) and the Table A/B pair (`shared/jira-branch.ts`, `jira.mjs`).
- `skills/jira/SKILL.md`: the `worktree` command, its JSON, and the exit-code table row `4 — git refused, or a re-check stopped the Run; nothing changed`.
- `docs/subsystems/jira.md`: Run section — branch choice, workspace block, refs/worktrees routes, Remove copy.

- [ ] **Step 1:** edit; run `pnpm run test:jest -- test/claude-rules.test.ts` and `pnpm run test:skills` — PASS.
- [ ] **Step 2:** commit `docs(jira): repo and branch — invariants, rules, skill`.

### Task 11: Live check and hand-off

- [ ] **Step 1:** push the branch; let CI run the full suite.
- [ ] **Step 2:** after merge, `pnpm run plugin:sync` (skills changes do nothing until then), `pnpm run docker:sync` (compose changed).
- [ ] **Step 3 — the spec §4 probe, live:** Start a real ticket on the Timify microservice with New from `develop`. Confirm in the session: `jira.mjs
  worktree` printed the path; `EnterWorktree` switched into it (or the session fell back to `git -C`, and said so); `git -C ~/Documents/timify-projects/microservice
  branch --show-current` is unchanged. Start a second ticket in the same repo while the first runs — both work. Report what the probe showed; if neither
  switch nor fallback held, stop and bring it to the user (the dashboard `cwd` override is their call).
