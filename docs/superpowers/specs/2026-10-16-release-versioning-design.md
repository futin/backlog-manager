# Release versioning — PR-only main, release tags, version chip and "What's new"

Status: design approved in conversation 2026-10-16; this file awaits review.

## Intent

Bring `claude-agents-dashboard`'s release pipeline here, as that repo's design already schedules (its
`docs/superpowers/specs/2026-10-15-release-pipeline-design.md` §Rollout step 6: "Other apps adopt A + C from the README, each building its own chip and
panel"). That spec is the parent: its decisions D1–D9, its tag-message contract and its release-workflow behaviour are adopted **unchanged** and are not
restated here. This document covers only what is specific to backlog-manager.

The point is a durable **release record** for this app: what shipped, when, under which version. The unseen-release dot is a convenience on top.

## Starting state (measured 2026-10-16)

- Phase A is done: `.github/workflows/ci.yml` calls release-kit's `ci-node.yml@v1` ([docs/workflows/ci.md](../../workflows/ci.md)). `ci / pr-title` already
  runs on every PR.
- The `main-pr-only` ruleset and squash-only merge settings are **not applied** (ci.md §The ruleset, "deliberately", waiting on PR mode). The repo allows
  merge, squash and rebase merges today.
- Since 2026-10-01, 79 first-parent commits reached `main`: **5 via a PR, 18 `Merge backlog/<id>` orchestrator merges, 56 direct pushes.** A
  PR-only release pipeline would miss ~94% of changes unless PRs become the only way in — which is why this design applies the ruleset (decision R1).
- `backlog-orchestrate`'s `pr` merge mode has shipped, and its `pr-draft` already composes a Conventional PR title and a body whose first section is
  `## What's new` (merged items, queue order) — the section release-kit's tag message takes verbatim (`orchestrate.mjs` around `pr-draft`).
- No `.github/pull_request_template.md`. No git tags except a stray lightweight `backup/tracker-pre-rebase` (ignored by every filter below).
- `package.json` `version` is `0.1.0`; `.claude-plugin/plugin.json` is `0.1.1`, bumped by hand.
- release-kit is at `v1.1.0` with the floating `v1` pointing at it; its root export carries the pure helpers `parseTagMessage`, `parseVersion`,
  `checkTitle`, `nextVersion`, and the git-launching `readReleases`.

## Decisions

| #  | Decision | Rejected alternatives |
| -- | -------- | --------------------- |
| R1 | **Apply the ruleset as part of this work**, so every change reaches `main` as a PR and every `feat`/`fix`/`perf` PR becomes a release. Applying it (the `apply-repo-settings.sh` run) stays the user's step. | PRs-only with direct pushes left alone (history ~94% empty); cutting releases from `Merge backlog/<id>` commits too (diverges from release-kit) |
| R2 | **Full Phase C**: release workflow, baseline tag, PR template, `GET /api/releases`, version chip, What's new drawer. | Workflow only, no UI |
| R3 | **`plugin.json` keeps its own hand-bumped version.** The tag is the app's version; nothing reads `package.json` `version`. Same as the parent spec. | The release tag stamped into the plugin version by `plugin:sync` |
| R4 | **The server runs git through `runGit` and imports only release-kit's pure parsers**, not `readReleases`. `readReleases` launches `git` through its own `execFile` with no timeout, which breaks this repo's invariant that every server git read is `runGit`, async, bounded at 10 s. | Importing `readReleases` as the dashboard does; adding a timeout option to release-kit first |
| R5 | **Copy the dashboard's chip and drawer look**, translated into this board's DESIGN.md §8 language. No mockup round. | Mockups first |

## Part 1 — PR-only `main`

The ruleset itself is release-kit's; this part is the repo's adaptation to it.

- **The user runs** `scripts/apply-repo-settings.sh futin/backlog-manager` from release-kit, dry run first. Ruleset contents and merge settings are the
  parent spec's (PR required, the three CI contexts, linear history, no force push or deletion, no bypass, squash-only, squash commit = PR title + body).
  The plan says exactly when in the rollout this happens (below) and dictates the command; the session never runs it. **ci.md's precondition stands**
  (user, 2026-10-16): the ruleset goes on only after this machine's Settings default merge mode is `pr` and one real `pr`-mode run has opened its PR here —
  the last cheap moment to find a broken PR mode, since the ruleset has no bypass (D9).
- **Orchestrator runs on this repo use `pr` merge mode.** A `merge`-mode run here would merge locally and then park at the push. The guidance goes where a
  person starting a run reads it (the Orchestrate sheet's merge-mode default comes from Settings, so the doc tells the user to set this machine's default to
  `pr` — whether the board should *also* refuse or warn on `merge` mode for a project whose `main` is protected is out of scope; see §Out of scope).
  `branch` mode is unaffected.
- **Docs and flows that assume a direct push are updated:** `docs/workflows/publishing.md` (commit on a branch → PR → merge, then `pnpm run plugin:sync`,
  which installs from the pushed `main`), `docs/workflows/ci.md` §The ruleset (state becomes "applied on <date>"), `CLAUDE.md` where it says
  `feat`/`fix`/`perf` "cut a release once Phase C lands", and the project memory note on how this repo is pushed. Specs and plans, committed straight
  to `main` by habit today, also go through PRs (type `docs`, so they cut no release).
- `git-sync`'s trunk push failing here is the dashboard's concern (its Phase B), not this repo's.

## Part 2 — cutting releases

Both workflow-side files are **written and committed by the session** in PR A (user, 2026-10-16), and reviewed in that PR — unlike the parent spec, which
dictated workflow files for the user to type. The ruleset apply and the baseline tag stay the user's steps.

- **`.github/workflows/release.yml`**: a byte-for-byte copy of the dashboard's caller (`uses: futin/release-kit/.github/workflows/release.yml@v1`,
  `kit-ref: v1`, `push` to `main` plus `workflow_dispatch` with `sha`, `permissions: contents: write, pull-requests: read`, `concurrency: release`,
  `cancel-in-progress: false`), header comment adapted to point at this repo's ci.md.
- **`.github/pull_request_template.md`**: copy the dashboard's, keeping its uncommented `## What's new` section with the placeholder in an HTML comment.
  The orchestrator's `pr-draft` body does not use the template and already has the section.
- **Baseline tag**: after the PR that adds `release.yml` merges (type `ci`, so it cuts nothing and the "no baseline tag" warning is harmless), the user tags
  `v0.1.0` on that merge commit — annotated, subject `Baseline — versioning starts here`, no trailers — and pushes it. Dictated in the plan, not run by
  the session.
- **ci.md gains a §Releases section** mirroring the dashboard's (what cuts a release, the bump table by reference to release-kit, the baseline, a re-run
  with `workflow_dispatch`).

## Part 3 — showing it on the board

### API

- **`shared/types.ts`**: `Release` and `ReleasesResponse`, field for field the dashboard's (`version`, `date`, `title`, `type` incl. `baseline`, `scope?`,
  `pr?`, `breaking`, `notes`, `url?`; `current: { version, ahead } | null`, `releases` newest first). Same shape, so a later shared consumer (a Lookout
  widget, say) reads both apps alike.
- **`GET /api/releases`**, in a new Nest module (`server/src/releases/`), read-only, no outbound call. It reads **this app's own checkout** — found by
  walking up from the server's own files to the directory holding `.git`, never `process.cwd()` — which is `/app` in the compose stack (`.:/app` mounts the
  checkout with its `.git`, in both `docker:up` and `docker:run`).
- **Git through `runGit` (R4)**: tag names and messages via one `for-each-ref` over `refs/tags/v*` sorted newest first, keeping annotated tags whose name is
  exactly `vX.Y.Z`; `current` via `git describe` with release-kit's filter, mirrored exactly (`--match 'v[0-9]*.[0-9]*.[0-9]*' --exclude 'v*[!0-9.]*'`, no `--tags`;
`DESCRIBE_FILTER`, `VERSION_TAG` and the GitHub-URL regex are not exported, so the server reproduces them from release-kit's `dist/` — my call: parity wins). Each message goes through
  release-kit's `parseTagMessage`; the PR `url` is built from the `origin` remote when it is a GitHub URL. The output must equal what `readReleases` would
  return for the same repo — the test asserts that against `readReleases` itself, so drift in release-kit shows up here.
- **Empty shape, never an error**: not a checkout, git missing, a `runGit` timeout or failure, or no `v*` tags → `200 { current: null, releases: [] }`.
- **Memo** keyed on HEAD plus the mtimes of `packed-refs` and `refs/tags` under `--git-common-dir`, exactly as the dashboard's (its releases.md §The memo
  has the reasoning); a key git cannot produce is never memoised; concurrent requests under one key share one read. This memo is unrelated to the items
  memo and must not share code with the `uncommitted` read.
- **Dependency**: `release-kit` added as `github:futin/release-kit#v1.1.0` beside `lookout-widgets`, imported only for its pure helpers. Its `dist/cjs` has a `require` condition, so the CommonJS server and jest load it; a local `.d.ts` shim
like `server/src/hub/lookout-widgets.d.ts` is fine if the types do not resolve.
- **CLAUDE.md Layout** gains the module in the `server/src/` line; it is not an outbound-calling module, so "the ONLY three" stays three.

### UI

The dashboard's releases.md §The chip and §The drawer are the behaviour spec; deltas for this board:

- **Chip**: the rail's last element on desktop (below Settings' tree, sunk to the rail foot), the last row of the phone menu. `v0.2.0`, or `v0.2.0+3`;
  absent when `current` is null. Unseen dot as the dashboard's, under `localStorage` key `backlog-manager.releases.lastSeen` (raw version string,
  first visit seeds without a dot, a throwing storage means no dot).
- **Drawer**: newest first; version, Feature / Fix / Performance badge, separate Breaking badge, date, title without its `type(scope)!: ` prefix, notes
  through the board's existing markdown renderer (`lib/markdown.ts`), `PR #N` link. The baseline renders as a divider, `Versioning starts here · v0.1.0`.
  Full screen below the board's narrow breakpoint, a 400 px right panel over a scrim above it.
- **Escape**: the drawer joins `useDialogEscape`'s stack while drawn — the topmost dialog is the only one that closes (CLAUDE.md invariant).
- **Fetch**: once on load and again when the chip opens the drawer; no poll.
- **Code homes**: every decision (chip label, dot, version compare `0.10.0 > 0.9.0`, title prefix strip) in `client/src/lib/releases.ts`, no React; the
  hook in `hooks/`; the drawer in `components/`. Header comments cite the new DESIGN.md subsection.
- **DESIGN.md** §8.7 Overlays' count of dialogs and overlay shapes is updated for the drawer, and DESIGN.md gains a §8.10 Releases subsection (chip, drawer, badge tints) in the board's tokens; the badges use status tokens on their own tint, and
  any contrast guard the board already runs over theme pairs covers them.
- **Docs**: a new `docs/subsystems/releases.md` (with a docs-sync stamp, like its siblings), linked from `docs/overview.md` and the CLAUDE.md `client/src/`
  line.

## Rollout

1. **PR A — `ci(release): add release workflow`**: `release.yml`, the PR template, ci.md §Releases. Merged by hand (the ruleset is not on yet).
2. **User**: tag `v0.1.0` on PR A's merge commit and push it.
3. **User**: set this machine's Settings default merge mode to `pr`, and drain at least one groomed item of this repo in a `pr`-mode run; its PR
   (`feat|fix(backlog): N items`) is merged by squash. That merge cuts the first real release — **the first end-to-end proof of Part 2**. If no groomed
   item is ready, grooming one is part of this step.
4. **User**: apply the ruleset (dry run, then for real). From here every change is a PR.
5. **PR B — the docs half of Part 1** (`docs: …`): publishing.md, ci.md §The ruleset, CLAUDE.md, the orchestrator-mode guidance.
6. **PR C — `feat(releases): version chip and What's new drawer`**: Part 3. Its merge cuts the next minor release.

No step names a fixed version past the baseline: step 3's run decides what the first release is. Steps 4–5 may swap if the user prefers the docs to land
before the switch; PR B is `docs`, so either order cuts no release. Whether PR B folds into PR A, and whether PR C is built while step 3 waits, is the
planner's call.

## Testing

- `/api/releases` over a tmpdir git repo through the real Nest app (`listenLoopback`): no git dir → empty shape; no tags → empty shape; only a lightweight
  `v9.9.9` and a lightweight `v1` → empty shape; baseline + two releases → newest first, baseline typed `baseline`; HEAD exactly on a tag → `ahead: 0`; a
  commit after the first read → `ahead: 1` (the memo key moved); a tag cut without moving HEAD → appears (common-dir mtimes); non-GitHub origin → no `url`;
  a `runGit` timeout (the existing test seam for `GIT_TIMEOUT_MS`) → empty shape, 200.
- Parity: for the populated fixture, the route's `releases`/`current` deep-equal release-kit's own `readReleases` on the same repo.
- Client lib (jest): dot decision, first-visit seed, invalid stored value, version comparison, chip label with and without `ahead`, title prefix strip.
- Drawer (jsdom): renders entries and the baseline divider; Escape closes only the drawer when another dialog is under it.
- Workflows are proved by real runs: PR A's merge (no release, "no baseline tag" warning), the step-3 run PR's merge (first tag + GitHub Release, notes
  from its `## What's new`), PR C's merge (a minor bump). The plan records which run
  proved which behaviour.

## Left to the builder

File names inside the new module and components, the exact `for-each-ref` format string, the hook's shape, how the drawer's markup maps onto existing
`components/ui/` pieces, and whether PR B merges into PR A.

## Out of scope

`plugin.json` versioning (R3); a `CHANGELOG.md`; a Lookout releases widget; the board refusing or warning on `merge` mode for a protected `main` (worth a
backlog item once the ruleset is on); releases for other projects registered on the board — this chip is the app's own version, not a per-project one;
editing release notes after a tag (fix forward).

## Unproven

- That the server container's git reads the host checkout's tags without a `safe.directory` or ownership issue beyond the `'*'` the Dockerfile already sets.
- That the parity test stays meaningful if release-kit later changes `readReleases`'s filters — it pins `v1.1.0`, so a bump re-runs it.
