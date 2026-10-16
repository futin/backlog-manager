# CI gate

Every PR into `main` runs `.github/workflows/ci.yml`, a thin caller of release-kit's reusable `ci-node.yml` (`futin/release-kit`, referenced at `@v1`).
Design: `claude-agents-dashboard`'s `docs/superpowers/specs/2026-10-15-release-pipeline-design.md` §Phase A — this repo adopts the same gate the dashboard
did, by release-kit's README §Adopting it in an app.

## What runs

| Context         | What it does                                                                                                              | When it is green without running anything |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `ci / checks`   | `pnpm install --frozen-lockfile`, then `pnpm typecheck`, `pnpm build`, `pnpm test`, each reported on its own              | never                                     |
| `ci / pr-title` | the PR title must match the Conventional Commits rule in release-kit's `scripts/pr-title.mjs`                             | on `push` (no title)                      |
| `ci / skills`   | nothing here — no `skills-command` is passed, because `pnpm test` already runs the node skills suite (`scripts/test-all.mjs`) | always                                    |

The three checks are the ones an orchestrated item's verification step resolves to off `package.json`, so a PR is held to the same bar an orchestrator merge
is. `ci / skills` still reports: the ruleset in release-kit requires all three contexts in every app, so the job runs and passes rather than being absent.

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
are applied by release-kit's `scripts/apply-repo-settings.sh futin/backlog-manager`, dry run first. **State on 2026-10-15: not applied, deliberately** — unlike the
dashboard, it waits for Phase B, the `pr` merge mode, rather than for the first green PR, because of the first bullet below. Until then CI is a signal on
every PR, not a gate on `main`. The `pr` merge mode has now landed (`docs/superpowers/specs/2026-10-15-orchestrate-pr-mode-design.md`); once this machine's
Settings default merge mode is `pr` and one PR-mode run has opened its PR here, the ruleset can be applied. Applying it stays the user's step.

Once it is applied, every direct push to `main` is refused, and in this repo that is more than habit:

- **`backlog-orchestrate` opens a PR instead of pushing `main`, but only in `pr` merge mode.** This repo's own backlog is tracker-backed, and a `merge`-mode run
  here pushes `main` after every merge, so under the ruleset it would merge locally and then park at the push. A `pr`-mode run drains onto its own
  `backlog/run-<date>-<n>` branch, pushes that, and ends by opening one PR into `main` for CI to gate and a person to squash-merge. There is no `--pr` flag: it
  is the third value of the merge mode, picked in the Orchestrate sheet or defaulted from Settings.
- **[publishing.md](publishing.md)'s "commit, on main" then `git push`** becomes a PR; `pnpm run plugin:sync` still installs from the pushed `main`, so it runs
  after the merge, not after the push.
- `git-sync`'s trunk push is gated per repo by the dashboard's Phase B; until then it fails here like any other direct push.

<!-- docs-sync:
  sources:
    - .github/workflows
  kind: workflow
-->
