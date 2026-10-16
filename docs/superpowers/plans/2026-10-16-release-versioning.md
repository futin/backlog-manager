# Release versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Plan convention (overrides writing-plans' "code blocks required"):** this plan specifies behaviour, signatures, exact values and exact test cases —
> never literal implementation code. Where a step names a function, the implementer writes the body; disagree with the plan when the code says otherwise
> and record why in the task's commit body. Size targets are soft.

**Goal:** Every merged `feat`/`fix`/`perf` PR into `main` becomes a `vX.Y.Z` release, and the board shows its running version plus a What's new drawer.

**Architecture:** A thin `release.yml` caller of release-kit `@v1` cuts annotated tags (the record); `GET /api/releases` reads this checkout's tags through
`runGit` and release-kit's pure `parseTagMessage`; the client shows a rail chip and a right-hand drawer built on a new `ui/Drawer` shell.

**Tech Stack:** GitHub Actions (release-kit `v1`), NestJS 11 + `runGit`, React 18, jest (+ jsdom, supertest), release-kit `v1.1.0`.

**Spec:** `docs/superpowers/specs/2026-10-16-release-versioning-design.md` — read it whole before Task 1. The parent design is
`claude-agents-dashboard/docs/superpowers/specs/2026-10-15-release-pipeline-design.md`; the dashboard's `docs/subsystems/releases.md` is the behaviour
reference for the chip and drawer.

## Global Constraints

- Three PRs, each on its own branch in its own worktree (`superpowers:using-git-worktrees`): **PR A** `ci/release-workflow` (Task 1), **PR B**
  `docs/pr-only-main` (Task 2), **PR C** `feat/releases` (Tasks 3–7). The main checkout may hold another session's uncommitted work: never touch it.
- PR titles pass `ci / pr-title`: PR A `ci(release): add release workflow`, PR B `docs: make main PR-only`, PR C `feat(releases): version chip and What's new drawer`.
  PR A and PR B are squash-merged.
- Every PR body has a `## What's new` section (PR C: 1–3 user-facing lines; PR A, PR B: section deleted — nothing user-visible).
- The user's steps — the `v0.1.0` baseline tag, the PR-mode proof run, applying the ruleset — are never run by the session; the plan dictates them (§User
  checkpoints).
- Wrap authored prose and comments at 160 columns. Comments explain _why_, matching the repo's density. Every new client component's header cites its
  `.claude/DESIGN.md` subsection.
- **CI is the full-suite gate:** locally run only the suites a task names, plus `pnpm run typecheck`. Never `pnpm test` whole before a push.
- `server/src` imports from `release-kit` ONLY `parseTagMessage` (and types). No `readReleases`, no `runRelease` under `server/src`; no git outside `runGit`.
- Storage key: `backlog-manager.releases-last-seen` (raw version string, not JSON). Route: `GET /api/releases`. Test seam env var: `BM_RELEASES_ROOT`.
- Copy, exact: drawer title `What's new`; badges `Feature`, `Fix`, `Performance`, `Breaking`; baseline divider `Versioning starts here · v<version>`; PR
  link `PR #<n>`; baseline tag subject `Baseline — versioning starts here`.
- Reading any file under a `.claude/rules/*.md` `paths:` glob loads that rule; open the rule by hand before editing through `Write` or codegraph.

## Review Focus

1. **A worktree checkout of this repo** (server started from `.claude/worktrees/<x>`): the walk-up must accept a `.git` *file* and read tags from the common
   dir — pinned by Task 4's "linked worktree" case.
2. **Tags cut in the same second** (the release workflow can tag several commits in one run): order is version-descending among ties — Task 4.
3. **A transient git timeout**: the chip must come back on the next request, not stay hidden until HEAD moves — Task 4's "timeout then recovery" case.
4. **Storage blocked or holding junk** (private window, an old non-version value): no dot, no crash, junk reseeded — Task 5 and Task 7.
5. **Drawer opened over another dialog** (item modal open, chip clicked from the phone menu): Escape closes only the drawer — Task 6.

---

## Task 1: Release workflow, PR template, ci.md §Releases (PR A)

**Files:**
- Create: `.github/workflows/release.yml`, `.github/pull_request_template.md`
- Modify: `docs/workflows/ci.md` (new §Releases after §The ruleset; docs-sync stamp's `sources` already covers `.github/workflows`)

**Interfaces:** Produces the workflow that later tasks' merges exercise; no code interface.

- [ ] **Step 1:** Copy `claude-agents-dashboard/.github/workflows/release.yml` verbatim, then change only the header comment to point at this repo's
  `docs/workflows/ci.md` §Releases. Verify: `diff` against the dashboard file shows changed lines inside the leading comment block only.
- [ ] **Step 2:** Write the PR template, adapted from the dashboard's (spec §Part 2): keep its section order and its `## What's new` heading at column 0,
  uncommented, placeholder hint in an HTML comment; replace the dashboard-only text (the "someone using the dashboard" lead → the board; the "no HTTP
  harness and no component renderer" line → jest + supertest + jsdom suites; the scope list → this repo's scopes, taken from `git log --format=%s | grep -oE
  '^[a-z]+\([a-z-]+\)' | sort | uniq -c`; drop the `refuseWrite`/`ANSWER_TOKEN` example).
- [ ] **Step 3: Verify the template against release-kit's extractor** with a scratchpad script (not committed) that imports `extractWhatsNew` from
  `claude-agents-dashboard/node_modules/release-kit/dist/esm/index.js`: the untouched template → `''`; the template with the placeholder replaced by
  `- Shows the running version` → exactly `- Shows the running version`.
- [ ] **Step 4:** Write ci.md §Releases: what cuts a release (merged PR, title type `feat|fix|perf`), bump rules by reference to release-kit, the baseline tag
  and its subject, direct pushes and `Merge backlog/<id>` commits warned as `no PR for <sha>` and skipped, a re-run via `workflow_dispatch` with `sha`.
- [ ] **Step 5:** Commit, push, open PR A. Verify on the PR: `ci / checks`, `ci / pr-title`, `ci / skills` green. After the user squash-merges it, the
  `release` run on `main` is green with the annotation `no baseline tag` (record the run URL in PR C's body).

## User checkpoints (between PR A and PR B — dictated, not run)

1. `git pull` on `main`, then `git tag -a v0.1.0 <PR A squash sha> -m "Baseline — versioning starts here" --cleanup=verbatim && git push origin v0.1.0`.
2. Set this machine's Settings default merge mode to `pr`. Drain at least one groomed item of this repo — a bug, or a task whose commit subject is `feat` —
   in a `pr`-mode run, and squash-merge its PR. A `feat|fix(backlog)` title cuts the first release (check the tag and GitHub Release); a `chore(backlog)`
   title cuts nothing but still proves PR mode, and PR C becomes the first release proof.
3. `scripts/apply-repo-settings.sh futin/backlog-manager` from a release-kit checkout: dry run, read it, then for real.

The session resumes at Task 2 once the user says checkpoint 3 is done (or earlier, if they choose to land PR B first — it is `docs`, cuts nothing).

## Task 2: PR-only `main` docs (PR B)

**Files:**
- Modify: `docs/workflows/publishing.md`, `docs/workflows/ci.md` (§The ruleset), `CLAUDE.md` (the `pr-title` convention line ending "cut a release once
  Phase C lands"), memory `~/.claude/projects/-Users-andrejajevtic-Documents-custom-projects-backlog-manager/memory/worktree-session-cannot-touch-main-checkout.md`

- [ ] **Step 1:** publishing.md: "commit, on main, then `git push`" becomes branch → PR → squash-merge → `pnpm run plugin:sync` (installs from the pushed
  `main`, so it runs after the merge).
- [ ] **Step 2:** ci.md §The ruleset: state line becomes `applied on <date the user gives>`; keep the precondition sentence as history ("waited for one
  PR-mode run, #<that PR>"); the orchestrator guidance there says runs on this repo use `pr` merge mode, `merge` mode parks at the push.
- [ ] **Step 3:** CLAUDE.md: replace "cut a release once Phase C lands" with "cut a release (`docs/workflows/ci.md` §Releases)". `test/claude-rules.test.ts`
  compares headlines byte-for-byte with `.claude/rules/` — this line is in §Conventions, not a rules headline; run `pnpm run test:jest -- claude-rules` to
  confirm green.
- [ ] **Step 4:** Memory note: add that `main` is PR-only since <date>; specs and plans go through `docs:` PRs too.
- [ ] **Step 5:** Commit, PR B, green CI, user squash-merges.

## Task 3: Shared types and the release-kit dependency (PR C)

**Files:**
- Modify: `shared/types.ts` (append), `package.json` (+ `pnpm-lock.yaml`)
- Create: `server/src/releases/release-kit.d.ts` (ambient shim, header modelled on `server/src/hub/lookout-widgets.d.ts`, same reason)

**Interfaces — Produces:**
- `type ReleaseType = 'feat' | 'fix' | 'perf' | 'baseline'`
- `interface Release { version: string; date: string; title: string; type: ReleaseType; scope?: string; pr?: number; breaking: boolean; notes: string; url?: string }`
- `interface ReleasesResponse { current: { version: string; ahead: number } | null; releases: Release[] }`

- [ ] **Step 1:** `pnpm add release-kit@github:futin/release-kit#v1.1.0`. Verify `node -e "require('release-kit').parseTagMessage"` prints a function.
- [ ] **Step 2:** Add the types (field order and optionality exactly as above — the dashboard's `shared/types.ts` `Release` is the source) and the shim
  (`declare module 'release-kit'` re-exporting `release-kit/dist/esm/index`).
- [ ] **Step 3:** `pnpm run typecheck` green. Commit `chore(releases): add release-kit and the Release types` (inside PR C; the PR title is what releases).

## Task 4: `GET /api/releases` (PR C)

**Files:**
- Create: `server/src/releases/releases.module.ts`, `releases.controller.ts`, `releases.service.ts`; `test/api-releases.test.ts`
- Modify: `server/src/app.module.ts` (import `ReleasesModule`), `.claude/rules/items.md` (`runGit` bullet + `paths:`), `docs/subsystems/invariants.md`
  (the `runGit` call-site count, around "none of the five has a reason"), `docs/subsystems/api.md` §Modules, `CLAUDE.md` Layout `server/src/` line

**Interfaces:**
- Consumes: Task 3's types; `runGit(args, { cwd })` and `__setGitTimeoutMs` from `server/src/git-run.util.ts`; `parseTagMessage` from `release-kit`.
- Produces: `releasesRoot(): string | null` (exported from `releases.service.ts`: `BM_RELEASES_ROOT` when set, else the first ancestor of `__dirname` holding a
  `.git` entry, file or directory; `null` when none); `ReleasesService.read(): Promise<ReleasesResponse>`; route `GET /api/releases` → 200 always.

Behaviour (spec §API is normative): for-each-ref `--sort=-creatordate` over `refs/tags/v*` with NUL-separated fields incl. `%(objecttype)`,
`%(creatordate:iso-strict)`, `%(contents)`; keep `objecttype === 'tag'` and name `^v\d+\.\d+\.\d+$`; re-sort date desc, then version desc. Each message →
`parseTagMessage`; `title`, `type`, `scope`, `pr`, `breaking`, `notes` from it; `url` = `https://github.com/<owner>/<repo>/pull/<pr>` when `remote get-url
origin` matches release-kit's GitHub regex (copy it from `dist/cjs/read-releases.js`, with a comment saying so). `current` only when `releases` is
non-empty: `describe --long --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude 'v*[!0-9.]*'` parsed by `^v(\d+\.\d+\.\d+)-(\d+)-g[0-9a-f]+$`. Per-read failure
meanings and the memo exactly per spec (key = root + HEAD + mtimes of `packed-refs` and `refs/tags` under `--git-common-dir`; any `null` read → answered, not
memoised; concurrent same-key calls share one promise).

- [ ] **Step 1: Write the failing tests** in `test/api-releases.test.ts`. One tmpdir root per suite (`claimTmpRoot`), the real `AppModule` via
  `listenLoopback`, `BM_RELEASES_ROOT` set per case; fixtures built with `git init -b main`, commits, and tags written with release-kit's `formatTagMessage`
  through `git tag -a … -F <file> --cleanup=verbatim`. Cases and exact expectations:
  - `BM_RELEASES_ROOT` → a plain empty directory → `200 {"current":null,"releases":[]}`
  - a repo with commits, no tags → the same empty shape
  - only a lightweight `v9.9.9` and a lightweight `v1` → the empty shape
  - baseline `v0.1.0` (subject `Baseline — versioning starts here`, no trailers), then `v0.2.0` from `feat(releases): version chip (#12)` with notes
    `- Shows the running version`, then `v0.2.1` from `fix(api)!: tighten (#13)` (breaking) on HEAD → `releases` versions `["0.2.1","0.2.0","0.1.0"]`;
    `0.1.0` has `type: "baseline"`, `breaking: false`, no `pr`; `0.2.0` has `title: "feat(releases): version chip"`, `type: "feat"`, `scope: "releases"`,
    `pr: 12`, `notes: "- Shows the running version"`; `0.2.1` has `breaking: true`; `current` is `{"version":"0.2.1","ahead":0}`
  - then one more commit, same server → `current.ahead === 1` (memo key moved)
  - then a new annotated tag on an older commit without moving HEAD → it appears in `releases`
  - origin `https://github.com/futin/backlog-manager.git` → `0.2.0.url === "https://github.com/futin/backlog-manager/pull/12"`; origin
    `git@gitlab.com:x/y.git` → no `url` key; no origin → no `url` key
  - three tags `v0.2.0`, `v0.10.0`, `v0.9.0` cut in one second (`GIT_COMMITTER_DATE` fixed) → order `["0.10.0","0.9.0","0.2.0"]`
  - tags only on a side branch, HEAD on a branch cut before them → `current: null`, `releases` non-empty
  - a linked worktree (`git worktree add`) as the root, tag cut from the main tree after the first read → appears on the next read
  - `__setGitTimeoutMs(1)` with a slow fake `git` on `PATH` (reuse `test/git-run.test.ts`'s technique) → empty shape, 200; restore the timeout → the next
    request is populated
  - parity: for the populated GitHub-origin fixture, the route body deep-equals `await readReleases(root)` (imported from `release-kit` in the test only)
  - concurrency: two `read()` calls started together → `runGit` (via `jest.spyOn` on the `git-run.util` module) saw `for-each-ref` once
- [ ] **Step 2:** `pnpm run test:jest -- api-releases` → FAIL (module missing).
- [ ] **Step 3:** Implement `releasesRoot`, `ReleasesService.read`, `ReleasesController` (`@Controller('api/releases')`, `@Get()`), `ReleasesModule`; register
  in `AppModule`. Header comment on the service: why `runGit` and not `readReleases` (spec R4), why the common dir, why failures are not memoised.
- [ ] **Step 4:** `pnpm run test:jest -- api-releases git-run vite-proxy csp` → PASS; `pnpm run typecheck` → PASS.
- [ ] **Step 5:** Docs: items.md `runGit` bullet gains the four releases meanings (`for-each-ref` → empty shape · `describe` → `current: null` ·
  `remote get-url` → no `url` · `rev-parse` → not memoised) and `paths:` gains `"server/src/releases/**"`; invariants.md's count follows; api.md and the
  CLAUDE.md Layout line gain `releases/` ("read-only, git only — not an outbound-calling module"). `pnpm run test:jest -- claude-rules` → PASS.
- [ ] **Step 6:** Commit `feat(releases): GET /api/releases from the checkout's tags`.

## Task 5: Client release logic (PR C)

**Files:** Create `client/src/lib/releases.ts`, `test/releases-lib.test.ts`

**Interfaces — Produces** (pure, no React):
- `LAST_SEEN_KEY = 'backlog-manager.releases-last-seen'`
- `isVersion(s: unknown): s is string` — `^\d+\.\d+\.\d+$`
- `compareVersions(a: string, b: string): number` — numeric per part
- `chipLabel(current: { version: string; ahead: number }): string`
- `displayTitle(title: string): string` — strips a leading `type(scope)!: `
- `TYPE_LABEL: Record<'feat' | 'fix' | 'perf', string>` — `Feature`, `Fix`, `Performance`
- `dotState(newest: string | null, stored: string | null): { dot: boolean; seed: string | null }`
- `readLastSeen(): string | null` and `writeLastSeen(v: string): void` — try/catch around `localStorage`, a throw reads as `null` / is swallowed

- [ ] **Step 1: Failing tests:** `compareVersions('0.10.0','0.9.0') > 0`, `('1.0.0','1.0.0') === 0`, `('0.2.0','0.2.1') < 0`; `chipLabel({version:'0.2.0',ahead:0})
  === 'v0.2.0'`, `ahead:3` → `'v0.2.0+3'`; `displayTitle('feat(releases)!: version chip') === 'version chip'`, `'fix: x' → 'x'`, `'Baseline — versioning
  starts here'` unchanged; `dotState('0.2.0', null)` → `{dot:false, seed:'0.2.0'}`; `('0.2.0','garbage')` → `{dot:false, seed:'0.2.0'}`; `('0.2.0','0.1.0')` →
  `{dot:true, seed:null}`; `('0.2.0','0.2.0')` → `{dot:false, seed:null}`; `('0.2.0','0.3.0')` → `{dot:false, seed:null}`; `(null,'0.1.0')` → `{dot:false,
  seed:null}`; `readLastSeen()` with `localStorage.getItem` throwing → `null`; `writeLastSeen` with `setItem` throwing → no throw.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `pnpm run test:jest -- releases-lib` → PASS. **Step 5:** commit.

## Task 6: `ui/Drawer` shell and `ReleasesDrawer`, six dialogs (PR C)

**Files:**
- Create: `client/src/components/ui/Drawer.tsx`, `client/src/components/ReleasesDrawer.tsx`, `test/releases-drawer.test.tsx`
- Modify: `client/src/styles.css` (`ui primitives` block gains the `.ui-drawer` family; drawer + badge rules), `test/design-guards.test.ts` (`FAMILIES` gains
  the drawer family), `.claude/DESIGN.md` (§8.7: three overlay shapes, six dialogs; new §8.10 Releases), the six-dialog homes — `.claude/rules/board.md`
  Escape bullet, `docs/subsystems/invariants.md` Escape entry, `client/src/hooks/useDialogEscape.ts` header, `docs/subsystems/board.md` (lines ~153 and ~404),
  `test/dialog-count-docs.test.ts` (five → six, names gain `ReleasesDrawer`), `test/dialog-escape.test.tsx` (stale "three" describe → six, plus the new case)

**Interfaces:**
- Produces: `Drawer({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode })` — scrim + right panel 400 px from the narrow
  breakpoint up, full screen below it; calls `useDialogEscape(onClose)`; scrim click and the ✕ (`aria-label="Close"`) call `onClose`.
- Produces: `ReleasesDrawer({ data, onClose }: { data: ReleasesResponse; onClose: () => void })`.

- [ ] **Step 1: Failing tests** (`releases-drawer.test.tsx`, jsdom), with Task 4's fixture values as data: heading `What's new`; entries in the given order;
  `0.2.0` shows `Feature` badge, title `version chip`, the notes rendered through `renderMarkdown` (a `### Sub` note line → an `h3`), link text `PR #12` with
  the given `href`; `0.2.1` shows `Fix` and a separate `Breaking`; an entry with empty notes renders no notes element; an entry without `url` shows no link;
  the baseline renders `Versioning starts here · v0.1.0` and no badge. `dialog-escape.test.tsx`: an item modal open, then the drawer → one Escape closes
  only the drawer, a second closes the modal.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement; badge tints in the `color-mix(in srgb, var(--X) N%, <surface>)` form with `color:` in the same rule (the
  only form `daylight-contrast.test.ts`'s `tintSites()` parses), one distinct status token per badge from `shared/theme.css`, Breaking on the red one.
- [ ] **Step 4:** update the six-dialog homes and DESIGN.md; `pnpm run test:jest -- releases-drawer dialog-escape dialog-count-docs design-guards
  daylight-contrast claude-rules` → PASS.
- [ ] **Step 5:** commit.

## Task 7: Hook, rail chip, wiring, docs (PR C)

**Files:**
- Create: `client/src/hooks/useReleases.ts`, `docs/subsystems/releases.md`
- Modify: `client/src/components/SideRail.tsx`, `client/src/App.tsx` (`AppShell`), `client/src/styles.css`, `test/rail.test.tsx`, `docs/overview.md`, `docs/subsystems/board.md` (the chip and drawer),
  `CLAUDE.md` Layout `client/src/` line

**Interfaces:**
- Consumes: Task 5's lib, Task 6's `ReleasesDrawer`.
- Produces: `useReleases(): { data: ReleasesResponse | null; refresh: () => void }` — one fetch on mount, one per `refresh()`, no timer; a failed fetch keeps
  the previous `data`.
- `SideRail` gains `releases?: { label: string; dot: boolean; onOpen: () => void }`; the chip renders only when it is set.

- [ ] **Step 1: Failing tests** (`rail.test.tsx`): no `releases` prop → no chip; label `v0.2.0+3` rendered as the rail's last element at desktop width and as
  the phone menu's last row (menu open); `dot: true` → the dot element present; clicking the chip calls `onOpen` and, on the phone, closes the menu. An
  `AppShell`-level case with `fetch` mocked to the Task 4 fixture: stored `0.1.0` → dot shown; click → drawer open, `localStorage` holds `0.2.1`, dot gone;
  `localStorage` throwing on every call → no dot, chip still opens the drawer; `current: null` → no chip.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement: `AppShell` owns `useReleases`, `dotState`/`readLastSeen`/`writeLastSeen` (seed written on load when
  `seed` is non-null), and renders `ReleasesDrawer` outside `.rail` (the dashboard's §The drawer reason: a transformed ancestor clips `position: fixed`).
- [ ] **Step 4:** `pnpm run test:jest -- rail releases rail-bar-style` → PASS; `pnpm run typecheck` → PASS; `pnpm run build` → PASS.
- [ ] **Step 5: Live check:** start the API and client on the host on free ports (record the pids; kill only those), with `BM_RELEASES_ROOT` unset in the
  worktree: chip shows `v0.1.0+N` (or the proof run's version), drawer opens, Escape closes; phone width 375 px: chip is the menu's last row.
- [ ] **Step 6:** Write `docs/subsystems/releases.md` (modelled on the dashboard's; sources list + docs-sync stamp like its siblings), link it from
  `docs/overview.md` and the CLAUDE.md `client/src/` line. Commit; open PR C with title `feat(releases): version chip and What's new drawer` and a `##
  What's new` of: `- The side rail shows the board's running version; tap it for every release, newest first.` After the merge: the `release` run tags the
  next minor and creates its GitHub Release — record the run URL in the PR.
