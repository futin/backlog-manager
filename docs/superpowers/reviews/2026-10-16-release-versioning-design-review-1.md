# Review 1 — `docs/superpowers/specs/2026-10-16-release-versioning-design.md`

Reviewer: Fable 5.1, fresh session, 2026-10-16. Inputs: the spec, the parent spec and `docs/subsystems/releases.md` in `claude-agents-dashboard`, release-kit
v1.1.0 as installed under the dashboard's `node_modules/.pnpm/release-kit@…18af40f…/node_modules/release-kit/dist/` and as tagged in
`/Users/andrejajevtic/Documents/custom-projects/release-kit`, this repo's `CLAUDE.md`, `.claude/rules/*.md`, `.claude/DESIGN.md`, `docs/workflows/ci.md`,
`server/src/git-run.util.ts`, `server/src/security.ts`, `test/git-run.test.ts`, `test/daylight-contrast.test.ts`, `orchestrate.mjs`'s `pr-draft`, and a
scratch git repo for the two behaviours under finding I-1 and I-2.

## Verdict: APPROVE WITH FIXES

No Critical findings. Seven Important: two statements about release-kit's reader are incomplete in a way that breaks the parity the spec itself demands,
one test seam and one rollout precondition are left to guesswork, two mechanism homes the repo's hard rules require (`.claude/rules/board.md`,
`.claude/rules/items.md`) are not named, and the PR template "copy" would ship false instructions into every PR here.

## What checked out

- Starting state (L16–27): `ci.yml` calls `ci-node.yml@v1` (`.github/workflows/ci.yml:21`); ruleset not applied (`docs/workflows/ci.md:49`); 79 first-parent
  commits since 2026-10-01 at measurement (80 now — the spec's own commit `f4bffdb` landed after), 5 `Merge pull request`, 18 `Merge backlog/`, the remaining
  56 direct (3 of them `Merge branch 'main'` pull-merges, which are direct pushes too); no PR template; one lightweight tag `backup/tracker-pre-rebase`;
  `package.json` 0.1.0, `plugin.json` 0.1.1; release-kit `v1` and `v1.1.0^{commit}` both resolve to `18af40f`.
- R4's premise (L36): release-kit's `git()` is `execFile` with `maxBuffer` and no `timeout` (`dist/cjs/git.js:18`); this repo's rule is
  `.claude/rules/items.md:66`.
- The describe filter (L85) is byte-equal to `DESCRIBE_FILTER` (`dist/cjs/git.js:13`); `DESCRIBE_FILTER`/`VERSION_TAG` are module exports of `git.js` but
  the package `exports` map exposes only `.` and `index.js` does not re-export them, and the GitHub regex is local to `read-releases.js:10` — so "not exported"
  holds.
- `release.yml` (L63–65) matches the dashboard's file line for line; the PR template's `## What's new` is uncommented with an HTML-comment placeholder;
  `extractWhatsNew` strips comments first (`conventional.js:61–71`).
- "no baseline tag" is a warning and `[]`, never a failure (`release.js:126–130`); baseline parse: no trailer paragraph → `baseline` (`conventional.js:99`).
- Memo key (L90) is exactly the dashboard's (`server/lib/releases.ts:47–55`); the Host allowlist is applied `forRoutes('{*splat}')` (`security.ts:75`), so a
  new module is gated without doing anything.
- `pr-draft`'s body opens with `## What's new` (`orchestrate.mjs:6404`); `.:/app` is mounted in both compose modes; `safe.directory '*'` is set in the
  Dockerfile; `useDialogEscape`, `lib/markdown.ts` (`renderMarkdown`), `hooks/`, `components/` all exist; the board's fold is 700 px; DESIGN.md ends at §8.9
  so §8.10 is the next number; `release-kit`'s `exports` has a `require` condition into `dist/cjs`.
- Rollout arithmetic: baseline `v0.1.0` → a `feat(backlog)` run PR → `v0.2.0` (the chip example) → PR C `feat(releases)` → `v0.3.0`, "the next minor" (L125).
  Consistent.

## Important

**I-1 — L85: the `describe` invocation omits `--long`, so it is not "mirrored exactly".**
release-kit's `current()` runs `describe --long` plus the filter and parses `^v(\d+\.\d+\.\d+)-(\d+)-g[0-9a-f]+$` (`dist/cjs/read-releases.js:11,23`).
Without `--long`, HEAD sitting on a tag prints `v0.1.0` alone (checked in a scratch repo: `v0.1.0` vs `v0.1.0-0-g931d2a8`), so an implementer copying the
spec's flag list either parses two shapes or fails the "HEAD exactly on a tag → `ahead: 0`" case (L134). → Add `--long` to the flag list and say the parse is
the `-N-g<sha>` shape.

**I-2 — L84: "sorted newest first" has no tie-break, and the spec's own fixture will tie.**
`--sort=-creatordate` has one-second resolution and git breaks ties by *ascending refname*; four tags cut in one second came back `v0.1.0, v0.10.0, v0.2.0,
v0.9.0`. release-kit re-sorts in JS by date desc, then version desc (`dist/cjs/git.js:33–47`). The fixture "baseline + two releases → newest first" (L134)
cuts three tags inside a second, so a server that trusts git's order answers oldest-first and fails parity (L137). → State the tie-break: creatordate desc,
then numeric version desc, as release-kit does.

**I-3 — L82 / L133: no seam points the route at a tmpdir repo.**
The root is "walking up from the server's own files… never `process.cwd()`", and the tests run "over a tmpdir git repo through the real Nest app". Nothing
says how the route is pointed at that tmpdir; the server's own checkout always has `.git`, so "no git dir → empty shape" cannot be produced without one.
Siblings use env vars (`BM_ORCH_HOME`, `BM_REGISTRY_FILE`); the dashboard used a test-only `overrideReleasesRoot` (`server/lib/releases.ts:17`). → Name the
seam (env var in the siblings' shape, or an exported override), and whether it also clears the memo — the "commit after the first read" case needs a cold key.

**I-4 — L107 / L111: the Escape dialog count has four homes the spec does not name, and the drawer breaks the "shells call it" mechanism.**
`.claude/rules/board.md:11–21` says five dialogs are on the stack, "none binds its own", and since task-40 "the hook is called by the two overlay shells
(`ui/Modal.tsx`, `ui/FormSheet.tsx`)"; the same count is in `docs/subsystems/invariants.md:1689–1702`, the hook's header (`useDialogEscape.ts`), and
`test/dialog-escape.test.tsx` mounts the dialogs together. A 400 px right-hand drawer is a third overlay shape — neither shell — so either a new `ui/` shell
calls the hook or the drawer calls it directly, and either way the board.md bullet changes. CLAUDE.md: each rules file "is the ONE home of the mechanism text"
(`test/claude-rules.test.ts` guards headline/anchor parity). → Decide shell-vs-direct, and list board.md, invariants.md, the hook header and the escape suite
as updated alongside DESIGN.md §8.7.

**I-5 — L84 / L95: a new `runGit` call site is added without updating the rule that enumerates them.**
`.claude/rules/items.md:66–75` lists every call site and what `null` means to each (`lastCommitDates`, `uncommittedItemPaths`, `originRepo`,
`resolveBaseBranch`, `AgentsService.branches`) and says "No call site grew a new branch for a timeout and none may". Its `paths:` are
`server/src/items/**` and `server/src/git-run.util.ts`, so a session editing `server/src/releases/**` never loads it. The spec updates only the CLAUDE.md
Layout line. → Add the releases reads (`for-each-ref`, `describe`, `remote get-url`, `rev-parse`) → empty shape to that bullet, and widen `paths:` to include
`server/src/releases/**` (or say why the rule should not reach it).

**I-6 — L66: "copy the dashboard's" PR template ships statements that are false here.**
The dashboard's `.github/pull_request_template.md` says "this repo has no HTTP harness and no component renderer, so endpoints and UI are checked live" (this
repo has `listenLoopback`/supertest and jsdom suites), "what someone using the dashboard can now do", scope examples `(spawn, api, dev, origin…)`, and a
security section naming `refuseWrite` and `ANSWER_TOKEN`. → Say "adapted", name what changes (verification line, scope examples, the security block), and
pin the one line that must stay byte-equal: `## What's new`, which `extractWhatsNew` matches exactly (`conventional.js:65`).

**I-7 — L120–121: step 3 "cuts the first real release" only if the run PR's type is `feat|fix|perf`.**
`prTitle` (`orchestrate.mjs:6357–6385`) ranks the merged items' commit subjects over `['feat','fix','perf','chore']` and falls to `chore(backlog): N items`
when no subject carries one of the first three — a `refactor:`/`docs:` subject, or none. `chore` cuts nothing (`release.js:90–93`), so the step proves no
tag. → Require the drained item to be a bug (→ `fix`) or a task whose commit subject is `feat`, and say what happens if the PR comes out `chore` (retitle
before merging, or repeat with another item).

## Minor

- L26–27: the root export also carries `extractWhatsNew`, `formatTagMessage`, `isBreaking`, `writeReleasesJson` and the git-launching `runRelease`
  (`dist/cjs/index.js`). Not false, but "the pure helpers … and the git-launching `readReleases`" reads as the whole list.
- L82: "the directory holding `.git`" — in a linked worktree `.git` is a file; say "a `.git` entry, file or directory" so the walk-up does not test
  `isDirectory()`.
- L93–94: the `.d.ts` shim is required, not "fine if the types do not resolve": release-kit's `package.json` has no root `main`/`types`, only `exports`, which
  `moduleResolution: "node"` ignores (`tsconfig.json`, and `hub/lookout-widgets.d.ts`'s header says why `paths` is not the alternative). State it as a fact.
- L102: every existing key is one kebab segment — `backlog-manager.jira-board`, `runs-mode`, `sort-dir`, `settings` — so `backlog-manager.releases.lastSeen`
  breaks the convention; `backlog-manager.releases-last-seen` fits it.
- L136: the seam is `__setGitTimeoutMs` (`git-run.util.ts:46`), not `GIT_TIMEOUT_MS`, which is the constant.
- L113–114: `docs/subsystems/api.md` §Modules describes every server module (its docs-sync source is all of `server/src`) and `board.md` the client surfaces;
  neither is named among the docs that change.
- L54: name the memory note (`worktree-session-cannot-touch-main-checkout.md`) so PR B's author does not have to find it.
- L112: the contrast guard covers a new badge only if its rule uses the `color-mix(in srgb, var(--X) N%, <surface>)` background `tintSites()` parses
  (`daylight-contrast.test.ts:125–167`) — say so; the pinned "ten tint sites" case looks up by selector, so new sites do not break it, but its title goes
  stale.
- L146 vs L88: deep-equal parity pins the date field to `%(creatordate:iso-strict)` and the records to NUL-separated fields, so "the exact `for-each-ref`
  format string" is not really the builder's to choose — say "parity constrains it" or drop it from Left to the builder.
- L102: `current` is null whenever `describe` finds no release tag reachable from HEAD even when `releases` is non-empty (a worktree on a branch cut before
  the baseline), so the chip — and with it the drawer — disappears there. Adopted from the dashboard; one line saying it is deliberate would save a bug report.
- L20: say the 56 includes the three `Merge branch 'main'` pull-merges, and that the count predates the spec's own commit.
