# CI gate

Every PR into `main` runs `.github/workflows/ci.yml`, a thin caller of release-kit's reusable `ci-node.yml` (`futin/release-kit`, referenced at `@v1`).
Design: `claude-agents-dashboard`'s `docs/superpowers/specs/2026-10-15-release-pipeline-design.md` §Phase A — this repo adopts the same gate the dashboard
did, by release-kit's README §Adopting it in an app.

## What runs

| Context         | What it does                                                                                                              | When it is green without running anything |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `ci / checks`   | `pnpm install --frozen-lockfile`, then `node scripts/ci-scope.mjs`: `pnpm typecheck`, `pnpm build`, `pnpm test`, or a scoped subset (below) | never                                     |
| `ci / pr-title` | the PR title must match the Conventional Commits rule in release-kit's `scripts/pr-title.mjs`; a `feat`/`fix`/`perf` PR also needs its What's new notes (§Releases) | on `push` (no title)                      |
| `ci / skills`   | nothing here — no `skills-command` is passed, because `ci-scope.mjs` already runs the node skills suite whenever skills change | always                                    |

The full run is the three checks an orchestrated item's verification step resolves to off `package.json`, so a code PR is held to the same bar an orchestrator
merge is. `ci / skills` still reports: the ruleset in release-kit requires all three contexts in every app, so the job runs and passes rather than being absent.

## Scoped checks

`scripts/ci-scope.mjs` is the one check command. It reads the PR's changed files and runs only what they can break. Why: the full gate is ~6 min (366 s on
2026-10-24), and 9 of the 30 PRs merged before this landed touched only docs or only skills — files typecheck and build never see (`tsconfig.json` covers
`server/ shared/ client/ test/` only) and most suites never read.

| The PR changes only…                                                                  | Runs                                                                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| docs — `docs/**` and any other `*.md`                                                 | the jest and node suites whose code names a changed file or its parent directory; no typecheck, no build |
| skills — `skills/**`, `agents/**` (docs may ride along)                               | `pnpm run test:skills`, plus the jest suites whose code names `skills/`/`agents/` or a path under them; no typecheck, no build |
| anything else — `server/`, `client/`, `shared/`, configs, the lockfile, and always `scripts/**`, `test/**`, `.github/**` | everything: `pnpm typecheck`, `pnpm build`, `pnpm test`                                               |

- **Docs are not test-free here.** `claude-rules.test.ts` and `dialog-count-docs.test.ts` hold `CLAUDE.md`, `.claude/rules/` and `invariants.md` to each
  other, and `backlog.test.mjs` / `orchestrate-prompts.test.mjs` read the repo's own `CLAUDE.md` and `invariants.md`. A docs-only PR still runs those, so a
  doc that breaks a guard is red on the PR, not on `main`.
- **Which suites "name" a file** is found by scanning the suites' source at run time — no hand-kept list to drift. A path piece counts when it is bounded
  by quotes or slashes on code lines (comment lines are dropped, so a header citing `.claude/DESIGN.md` reads nothing). It is a heuristic, generous on
  purpose: a suite picked wrongly costs seconds.
- **Every doubt runs the full suite**: a push to `main`, a PR merge commit that is not two-parented, a failed fetch, an empty diff, and any path the table
  does not name. `scripts/**`, `test/**` and `.github/**` are full even when they are markdown, because they change how the suites run.
- **The push run on `main` is the backstop.** A suite the scan misses — one that reaches a doc through a helper or a computed path — passes the PR and fails
  the push run after the merge. That is the price of the scoped run; it shows up as a red `main` and is fixed by the next PR.
- **How the diff is read.** The PR checkout is the merge ref at depth 1; the script fetches that merge commit's first parent (the base tip) and diffs the two
  with `--no-renames`, so a file moved from `server/` into `docs/` lists both paths and runs full.
- **The job is never skipped.** release-kit's rule — a skipped job reports success for the same head sha — is why the scope is decided inside the step,
  from the diff alone: a title edit's re-run reaches the same verdict, red stays red.
- The scope is posted as a `ci scope` notice on the run's summary page. To check one by hand:
  `node scripts/ci-scope.mjs --dry-run --files docs/overview.md` prints the plan without running it.

Local `pnpm test` and an orchestrated item's verification are unchanged — they always run both runners in full.

Allowed title types: `feat`, `fix`, `perf` (these may carry `!`), and `docs`, `chore`, `test`, `refactor`, `ci`, `build` (these may not). The scope, if any, is
lowercase `[a-z0-9-]`. A GitHub "Revert …" title fails until it is retitled.

## Why the names look like `ci / …`

A reusable workflow's jobs report as `<caller job id> / <called job id>`. The caller job id here is `ci`, so the contexts are `ci / checks`, `ci / pr-title`
and `ci / skills`. Renaming the caller job, or giving any job a `name:`, changes the reported context — and a ruleset that requires a context which never
reports leaves every PR pending, with no bypass. Read the names off a real PR (`gh pr checks <n>`) before the ruleset requires them.

## Why a title edit re-runs everything

`edited` is one of the trigger types so fixing a title clears `ci / pr-title`. GitHub re-runs the whole caller workflow on that event, so `checks` runs again.
That is deliberate: if `checks` were skipped on `edited`, the skipped job would report success for the same head sha and a red PR would turn green.

## Running the Linux suite locally

CI runs on `ubuntu-latest`. To reproduce it on this machine, in a clean copy of the tree as the non-root `node` user, from the repo root:

```bash
docker run --rm --name ci-linux-bm --user root -v "$PWD":/src-ro:ro node:22 bash -c 'apt-get update -qq >/dev/null && apt-get install -y -qq git jq >/dev/null && rm -f /.dockerenv && runuser -u node -- bash -c "set -e; mkdir -p ~/app ~/.local/bin && cd ~/app && tar -C /src-ro --exclude=./node_modules --exclude=\"./*/node_modules\" --exclude=./client/dist --exclude=./dist --exclude=./.claude/worktrees --exclude=./.codegraph --exclude=./.git -cf - . | tar -xf - && git init -q -b main && git add -A && git -c user.name=ci -c user.email=ci@example.com commit -qm snapshot && corepack enable --install-directory ~/.local/bin && export PATH=~/.local/bin:\$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && pnpm install --frozen-lockfile && pnpm typecheck && pnpm build && pnpm test"'
```

The local `node:22` image has no `git`, which the orchestrate and backlog suites spawn, so the command installs it; `/.dockerenv` is removed so the copy looks
like the runner rather than a container. `.claude/worktrees` is excluded because a linked worktree's tree would be copied in whole, `.codegraph` because its
daemon socket vanishes mid-copy. Debian's git is 2.39, older than the runner's: the one case that quotes git's own "already checked out" refusal accepts both
the pre-2.42 and the current wording, so the container and the runner agree. Typecheck, build, jest (2,719 cases) and 945 of the node suite's 946 were green this
way on 2026-10-15; the 946th is that git-wording case, re-run alone in the container after its fix.

## The ruleset

The `main-pr-only` ruleset (PR required, the three contexts above, linear history, no force push or deletion, no bypass) and the squash-only merge settings
are applied by release-kit's `scripts/apply-repo-settings.sh futin/backlog-manager`, dry run first. **Applied 2026-10-19, enforcement `active`** — unlike the
dashboard, it waited for Phase B, the `pr` merge mode (`docs/superpowers/specs/2026-10-15-orchestrate-pr-mode-design.md`), rather than for the first green PR,
because of the first bullet below. CI is now a gate on `main`, not only a signal on every PR.

Every direct push to `main` is refused, and in this repo that is more than habit:

- **`backlog-orchestrate` opens a PR instead of pushing `main`, but only in `pr` merge mode.** This repo's own backlog is tracker-backed, and a `merge`-mode run
  here pushes `main` after every merge, so under the ruleset it would merge locally and then park at the push. A `pr`-mode run drains onto its own
  `backlog/run-<date>-<n>` branch, pushes that, and ends by opening one PR into `main` for CI to gate and a person to squash-merge. There is no `--pr` flag: it
  is the third value of the merge mode, picked in the Orchestrate sheet or defaulted from Settings.
- **[publishing.md](publishing.md)'s "commit, on main" then `git push`** becomes a PR; `pnpm run plugin:sync` still installs from the pushed `main`, so it runs
  after the merge, not after the push.
- `git-sync`'s trunk push is gated per repo by the dashboard's Phase B; until then it fails here like any other direct push.

## Releases

`.github/workflows/release.yml` is a thin caller of release-kit's reusable `release.yml` (`@v1`, with `kit-ref: v1` kept equal to that ref) in
`mode: rollup`, run each night at 04:00 UTC (`schedule`, `0 4 * * *`) and on `workflow_dispatch` — the same caller the dashboard has, but for its header
comment. A merge into `main` releases nothing by itself. Design: this repo's
`docs/superpowers/specs/2026-10-16-release-versioning-design.md`, which adopts the dashboard's `2026-10-15-release-pipeline-design.md` §Phase C unchanged. It
needs both `contents: write` (the tag push and the Release) and `pull-requests: read` — setting `contents` alone drops `pull-requests` to none and the PR
lookup then fails on a private repo. The group is `release` with `cancel-in-progress: false`, so a dispatch and the nightly run never tag at once.

**One version per run.** A run gathers every releasing PR merged since the newest version tag into a single release: the bump is the largest among their
types (below), and the notes hold one `### <Scope>` section per title scope, oldest PR first, with unscoped PRs under `### Other`. A night with only `docs`,
`chore` and the like, or no merges at all, cuts nothing and ends green. Tags cut before the switch keep their one-PR shape; the reader handles both.

**The tag is the record.** The version exists only as an annotated `vX.Y.Z` tag whose message carries the grouped notes and `Release-*` trailers; a
`Release-Items` trailer lists each PR with its type, scope and breaking flag.
`package.json` `version` is not read and is not bumped, and `.claude-plugin/plugin.json` keeps its own hand-bumped version; the same tags feed the GitHub
Release.

**What cuts one.** Each PR's title decides its type; the run takes the largest, and the version is bumped from the newest `vX.Y.Z` tag reachable from
the run's target:

| Title | While major = 0 | From 1.0.0 |
|---|---|---|
| `feat` | minor | minor |
| `fix`, `perf` | patch | patch |
| `!` after the type or scope, or a `BREAKING CHANGE: ` line in the PR body | minor | major |

`docs`, `chore`, `test`, `refactor`, `ci` and `build` cut nothing, and a `BREAKING CHANGE:` line on one of them is ignored. A commit on `main` with no PR —
a direct push, or a `merge`-mode orchestrator run's `Merge backlog/<id>` — is skipped with the warning `no PR for <sha>`; the commits after it are still
released. A `pr`-mode orchestrator run's PR is titled `<type>(backlog): N items` with the highest type among its merged items' commit subjects, so a run
that merged a bug or a `feat` task releases, and a run of `chore`-only items does not.

**Where the notes come from.** The `## What's new` section of the PR body (`.github/pull_request_template.md` carries it above `## Why this shape`; a
`pr`-mode run's body opens with it, one line per merged item), up to the next `## ` heading, with HTML comments stripped first. A missing or empty section,
which is what the untouched template yields, means the title alone is the entry. `require-notes: true` in `ci.yml` makes `ci / pr-title` fail a
`feat`/`fix`/`perf` PR while that section is missing, empty or only the template comment; `ci.yml` triggers on `edited`, so filling in the body re-runs it.
A releasing PR with nothing worth saying writes `None` (any case, optionally `None — <reason>`) as the section's only content: the check passes and the
PR's entry falls back to its title, with the `None` never shown. `docs`, `chore` and the other silent types are never asked for notes.

**Baseline.** Until a `vX.Y.Z` tag exists the workflow releases nothing and ends green with the warning `no baseline tag — see Baseline`. `v0.1.0` is tagged
once, by hand, on the `main` commit that contains the workflow (`git pull`, then `git tag -a v0.1.0 <sha> -m "Baseline — versioning starts here"
--cleanup=verbatim` and `git push origin v0.1.0`); every later version is cut from it.

**Re-running.** `gh workflow run release.yml -f sha=<sha>` releases that commit and every unreleased commit before it; with no `sha` it uses the branch head.
It is idempotent: a commit with its tag and its Release is left alone, and a tag whose Release is missing only gets the Release. That is also how the
baseline gets its GitHub Release. A dispatch whose target has a later version tag fails with `a newer release exists: <tag>`, since versions are never
assigned out of order; a scheduled run in the same state ends green with `a newer release exists: <tag> — nothing to do`, because it can only be a superseded run.
A dispatch `sha` must be a commit on `main`; any other commit fails with `target <sha> is not on origin/main` and nothing is tagged.

<!-- docs-sync:
  sources:
    - .github/workflows
    - .github/pull_request_template.md
    - scripts/ci-scope.mjs
  kind: workflow
  verified: 9cbf5e1a207d009e9fcf01f9f1b79804ed1742da
-->
