# `backlog-orchestrate` PR mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template, deliberately:** this plan specifies **behaviour, signatures, exact values and exact test cases — never literal
> code.** Handed code gets transcribed verbatim, so a bug in the plan becomes a bug in the branch with nobody placed to catch it (the user's global
> CLAUDE.md, §Learnings). Where a step says "write the failing test", the case list IS the test spec: names, inputs, expected values. Write the code
> yourself, match the surrounding comment density, and disagree with this plan in your report when the code says it is wrong. Size budgets here are soft.

**Goal:** a third merge mode, `pr`, in which an orchestrator run on a tracker project drains onto its own `backlog/run-<date>-<n>` branch, pushes it after
every merge, and ends by opening one pull request into the base it was started against — so runs keep working once `main-pr-only` makes `main` PR-only.

**Architecture:** `pr` joins `MergeMode`, so it rides the existing Settings → sheet → `POST /api/agents/orchestrate` → spawn prompt → `init` → run file →
claim route. `init` mints and creates the run branch and records it as the run's `base`, with the PR target in a new `prTarget`; every downstream reader of
`base` then works unchanged. Two new tool commands (`pr-draft`, `pr`) compose the PR and record its URL; the driver runs `gh pr create` between them.

**Tech Stack:** Node ESM tool (`orchestrate.mjs`, `node --test`), NestJS server and React client (jest), Markdown skill docs.

**Spec:** [docs/superpowers/specs/2026-10-15-orchestrate-pr-mode-design.md](../specs/2026-10-15-orchestrate-pr-mode-design.md) — read it in full first; the
plan argues from it and cites it as `spec §N`.

## Global Constraints

- `MergeMode` is exactly `'merge' | 'branch' | 'pr'`, in that order, in `shared/types.ts` `MERGE_MODES` **and** `orchestrate.mjs`'s own `MERGE_MODES` copy.
- Run branch name: `backlog/run-<YYYY-MM-DD>-<n>`, local date, `n` ≥ 1, parsed only from refs matching `^backlog/run-<date>-\d+$`.
- PR URL pattern, identical in tool and server: `^https://github\.com/[\w.-]+/[\w.-]+/pull/\d+$`.
- PR title: `<type>(backlog)<!?>: <N> item` / `<N> items`; `<type>` ∈ `feat | fix | perf | chore`, ranked in that order; `!` only on `feat|fix|perf`.
- Sheet option copy: `Open a PR into <base>`; base-less: `Open a PR into the base branch`. RunDetail pill: `PR mode`. Link label: `PR #<n>`.
- `pr` is refused for any project whose resolved source is not `github`: server 400, tool exit `1`, nothing written.
- New run-file fields `prTarget: string | null` and `prUrl: string | null` are **required** on `OrchestratorRun`; `null` under `merge`/`branch`.
- Every tool error path writes nothing (the file's existing contract); every tool CLI still ends with `process.exitCode = main(...)`.
- Wrap new prose at 160 columns; comments explain why, at the file's existing density.
- Tests: jest suites flat in `test/`; node cases in `skills/backlog-orchestrate/tools/orchestrate.test.mjs` (the node glob does not descend).
- `pnpm test`, `pnpm typecheck`, `pnpm build` green at the end of every task that touches TypeScript, and `pnpm run test:skills` for every tool task.

## Review Focus

1. **Midnight and time zones.** The mint's date is the machine's local date, not UTC. Pinned in Task 3 (case 3.6).
2. **An item title with a newline, backtick or leading `#`.** A `## What's new` line must stay one line, must not open a heading, and keeps backticks. Pinned in Task 4 (4.9).
3. **`ls-remote` with no usable `origin`.** No remote, a dead path, or a timeout → fall back to local refs with one stderr line; the mint itself never
   hangs (the earlier `pullBaseAtInit` pull is today's code and out of this plan's scope). Pinned in Task 3 (3.7).
4. **A resumed PR run.** `claim` and `reconcile` must keep `base`, `prTarget` and `prUrl` as written. Pinned in Task 3 (3.11).
5. **`merge-check` on a run branch nobody has checked out.** It must take outcome 2 (create `_base-backlog-run-…`), not park. Pinned in Task 3 (3.12).

---

### Task 1: Shared vocabulary and the run-file fields

**Files:**
- Modify: `shared/types.ts` (`MergeMode`, `MERGE_MODES` and their doc comments; `OrchestratorRun` gains two fields), `shared/agent.ts` (a `PR_URL_PATTERN`
  constant and an `isPrUrl` guard beside `isMergeMode`)
- Modify: `server/src/orchestrator/orchestrator.service.ts` (`sanitizeMergeFields`), `server/src/orchestrator/remote-runs.util.ts` (the run literal)
- Modify: `client/src/lib/merge-mode.ts` (`mergeModeOptionLabels` gains `pr` — its `Record<MergeMode, string>` fails typecheck the moment `MERGE_MODES`
  grows, so the label lands here rather than in Task 6), `client/src/components/settings/SettingsView.tsx` (`:383-391` hand-builds two options and a hint
  naming two modes: build the options from `MERGE_MODES`, and the hint names all three)
- Modify: every TypeScript literal of `OrchestratorRun` that typecheck then flags (fixtures in `test/` included) — set both new fields to `null`
- Test: `test/agents-shared.test.ts`, `test/orchestrator-runs.test.ts`, `test/remote-runs.test.ts`, `test/merge-mode-labels.test.ts`,
  `test/settings-view.test.tsx`

**Interfaces:**
- Produces: `MergeMode` with `'pr'`; `MERGE_MODES = ['merge', 'branch', 'pr']`; `OrchestratorRun.prTarget: string | null`; `OrchestratorRun.prUrl: string |
  null`; `PR_URL_PATTERN: RegExp`; `isPrUrl(value: unknown): value is string`.

- [ ] **Step 1: Write the failing tests**
  - 1.1 `agents-shared`: `MERGE_MODES` equals `['merge', 'branch', 'pr']` (the existing `toEqual(['merge', 'branch'])` at `:152` is updated, never loosened).
  - 1.2 `agents-shared`: `isMergeMode('pr')` is true; `isMergeMode('PR')` and `isMergeMode('pull')` are false.
  - 1.3 `agents-shared`: `isPrUrl` accepts `https://github.com/futin/backlog-manager/pull/275`; refuses `http://github.com/a/b/pull/1`,
    `https://github.com.evil.io/a/b/pull/1`, `https://github.com/a/b/issues/1`, `https://github.com/a/b/pull/1/files`, `javascript:alert(1)`, `''`, `null`, `42`.
  - 1.4 `orchestrator-runs`: a run file with no `prTarget`/`prUrl` keys reads back with both `null`; one with `prTarget: 'main'` and a valid `prUrl` reads back
    unchanged; one with `prUrl: 'https://example.com/x'` reads back with `prUrl: null` and everything else intact; `prTarget: 7` reads back `null`.
  - 1.5 `orchestrator-runs`: `mergeMode: 'pr'` and `mergeModeEffective: 'pr'` survive the sanitiser (today they would degrade to `'merge'`).
  - 1.6 `remote-runs`: a derived remote run carries `prTarget: null` and `prUrl: null`, and a claim whose `run.mergeMode` is `'pr'` derives `mergeMode: 'pr'`.
  - 1.7 `merge-mode-labels`: `mergeModeOptionLabels('main').pr` is `Open a PR into main`; `mergeModeOptionLabels(null).pr` is `Open a PR into the base branch`.
  - 1.8 `settings-view` (`:459`): the default-merge-mode picker lists three options in `MERGE_MODES` order, the third labelled `Open a PR into the base
    branch`; a stored `pr` survives the clamp; a stored `'pull'` falls back to `merge`.
- [ ] **Step 2:** `pnpm run test:jest -- agents-shared orchestrator-runs remote-runs merge-mode-labels settings-view` — expect 1.1–1.8 red.
- [ ] **Step 3: Implement.** Extend the type and list and rewrite their doc comments to describe three modes (spec §1). Add the two fields to
  `OrchestratorRun` with comments citing spec P4/P5. `sanitizeMergeFields` resolves each once: `prTarget` a non-empty string or `null`, `prUrl` through
  `isPrUrl` or `null`. Then run `pnpm typecheck` and set both fields to `null` at every literal it flags.
- [ ] **Step 4:** the five suites green; `pnpm typecheck` green; full `pnpm run test:jest` green (any other assertion that lists the modes is updated to
  the three-mode list — classified, never weakened). Two interim gaps, both closed by later tasks: the sheet offers `pr` to every project until Task 6 filters it, and the server accepts `pr` but spawns
  it as a plain `merge` run until Task 2 adds its prompt literal.
- [ ] **Step 5: Commit** `feat(orchestrate): add the pr merge mode to the shared vocabulary`.

### Task 2: Server — refuse `pr` off a tracker project, and spawn it

**Files:**
- Modify: `server/src/agents/agents.service.ts` (`resolveMergeMode`, the `prompt:` composition around `:749`)
- Modify: `server/src/items/items.service.ts` — it holds the `known` kind set privately (`:41`) and already calls `resolveSource(project.path, this.known)`;
  expose that as one public method (e.g. `sourceOf(projectPath): SourceKind | 'unsupported' | null`). `AgentsService` already injects `ItemsService`
  (`agents.service.ts:311`). `resolveSource` is imported in `agents.service.ts:12` but never called there; do not hand it a second, hand-built `known` set —
  one set of honoured kinds per build.
- Test: tracker cases (2.1, 2.5) in `test/tracker-dispatch.test.ts`, whose `beforeEach` (`:39-145`) builds a tracker project that passes `syncOffBlock`;
  files and malformed cases (2.2, 2.3, 2.4) beside the existing `--merge-mode branch` prompt cases in `test/merge-mode.test.ts:168-179`. Plus one unit case
  for the new public source method: tracker project → `'github'`, files → `'files'`, an unknown `kind` → `'unsupported'`.

**Interfaces:**
- Consumes: `MERGE_MODES`, `isMergeMode` (Task 1); the public source method this task adds.
- Produces: `resolveMergeMode(mergeMode: string | undefined, project: string): MergeMode` (or an equivalent that sees the project).

- [ ] **Step 1: Write the failing tests**
  - 2.1 `mergeMode: 'pr'` on a tracker project spawns a prompt ending `… --merge-mode pr` (ids, if any, before it; `--question-mode`/`--base` after, in the
    existing order).
  - 2.2 `mergeMode: 'pr'` on a files project, and on one whose source is `unsupported` → 400 whose error names `pr` and says it needs a tracker project; nothing spawned.
  - 2.3 `mergeMode: 'nonsense'` → 400 whose text lists `merge, branch, pr` (built from `MERGE_MODES`).
  - 2.4 absent / `''` → no `--merge-mode` token, byte-identical to today's prompt (an existing case; keep it).
  - 2.5 the `RUN_IN_PROGRESS_CODE` 409 still wins over a `pr`-on-files request (lock before content, as the existing ordering comment says).
- [ ] **Step 2:** run the suite — 2.1–2.3 red.
- [ ] **Step 3: Implement** a second guarded literal beside the `'branch'` one and the source check in `resolveMergeMode`; update both comments (spec §1).
- [ ] **Step 4:** suite green; `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(agents): spawn pr-mode runs, refused off a tracker project`.

### Task 3: Tool — `init` mints the run branch

**Files:**
- Modify: `skills/backlog-orchestrate/tools/orchestrate.mjs` (`MERGE_MODES` copy at `:1052` and its comment at `:1039-1051`, `INIT_USAGE`,
  `cmdInit`, `cmdMergeMode`, the run skeleton at `:2991-3013`)
- Test: `skills/backlog-orchestrate/tools/orchestrate.test.mjs` (tracker cases use `trackerFixture`, `:7262`, with `fakeApi`, `:7192`)

**Interfaces:**
- Consumes: `projectSource`, `pullBaseAtInit`, `treeHoldingBranch`, `assertUsableBase` (existing).
- Produces: run file fields `base` (= run branch under `pr`), `prTarget`, `prUrl: null`; a pure helper `nextRunBranchName(date: string, existing: string[]):
  string` exported for tests, plus a local-date formatter it is fed from.

- [ ] **Step 1: Write the failing tests**
  - 3.1 The tool's `MERGE_MODES` equals `shared/types.ts`'s, read from source text (the tool imports nothing from `shared/`; pin by parsing both files).
  - 3.2 `init --merge-mode pr` on a tracker fixture: exit 0; branch `backlog/run-<today>-1` exists at the target's tip; run file has `mergeMode` and
    `mergeModeEffective` `'pr'`, `base: 'backlog/run-<today>-1'`, `prTarget: 'main'`, `prUrl: null`.
  - 3.3 `init --merge-mode pr --base feature/x` → `prTarget: 'feature/x'`, branch cut at `feature/x`'s tip.
  - 3.4 A local `backlog/run-<today>-1` already present → mints `-2`. Present only on a bare `origin` the case adds → also `-2` (push `main` into that
    bare origin first, or `pullBaseAtInit`'s `pull --ff-only origin main` fails before the mint). Refs `-1`, `-3` and
    `-wip` present → mints `-4` (the highest + 1, `-wip` ignored). `nextRunBranchName` unit cases: `('2026-10-15', [])` → `…-1`; a ref from another date
    is ignored.
  - 3.5 `init --merge-mode pr` on a files fixture: exit 1, message names the tracker requirement, no branch created, no run file, a pre-existing done run
    NOT archived.
  - 3.6 With `TZ` set in the child env to a zone whose local date differs from UTC at the test's instant (pick the zone at test time so the case is
    deterministic, e.g. `Pacific/Kiritimati` or `Etc/GMT+12` — whichever differs), the minted date equals the date formatted in that zone.
  - 3.7 No `origin` remote (the bare `trackerFixture`, `orchestrate.test.mjs:7262`): `init --merge-mode pr` exits 0, mints from local refs, and prints
    exactly one stderr line naming the fallback. Second shape: `origin` set to a non-existent path **and** `--base feature/x` held by no tree, so `pullBaseAtInit` returns before
    pulling (`orchestrate.mjs:2686-2687`) and the mint's `ls-remote` is the first call to fail — `init` still exits 0 with the same one stderr line. (When a
    tree does hold the target, an unreachable `origin` is refused earlier by the pull, exit 1 — today's behaviour, unchanged.) The fallback keys on any
    non-zero or timed-out `ls-remote`, never on "no origin configured". The `ls-remote` spawn carries a `timeout` option; pin it with a unit case on the
    mint helper's argument builder, or by reading the spawn options in source, not by waiting on a network.
  - 3.8 `init` refused after the mint would have run (an exit-4 existing running run) leaves **no** new `backlog/run-*` branch.
  - 3.9 `init --merge-mode merge` and `branch` write `prTarget: null`, `prUrl: null`; the "key set unchanged from the contract fixture" case (`:971`) is
    updated to the new key set, deliberately.
  - 3.10 `merge-mode branch --note x` on a `pr` run: `mergeMode` stays `'pr'`, `mergeModeEffective` becomes `'branch'`; a second call exits 1.
    `stage <id> merged` on a `pr` run is accepted.
  - 3.11 `claim` on a `pr` run (the resume path) and `reconcile` leave `base`, `prTarget`, `prUrl` byte-identical.
  - 3.12 `merge-check <id>` on a `pr` run with no tree holding the run branch records `baseTree.created: true` at
    `.worktrees/_base-<sanitised backlog/run-…>` (outcome 2, `orchestrate.mjs:3673-3705`), not a park — build it from an existing `merge-check` fixture.
- [ ] **Step 2:** `pnpm run test:skills` — the new cases red.
- [ ] **Step 3: Implement** per spec §2: validate (files refusal in the pre-write block, after `--merge-mode`), pull the target, build the queue at the
  target, run the exit-4 check, then mint (`git ls-remote --heads origin 'backlog/run-<date>-*'` with a timeout, local `for-each-ref`, the `^…-\d+$` filter)
  and `git branch <run> <target>` as the last git write before the run file. `cmdMergeMode` accepts `merge|pr → branch`. Update `INIT_USAGE` and the `MERGE_MODES` comment.
- [ ] **Step 4:** `pnpm run test:skills` green.
- [ ] **Step 5: Commit** `feat(orchestrate): mint a run branch for pr-mode runs`.

### Task 4: Tool — `pr-draft` and `pr --url`

**Files:**
- Modify: `skills/backlog-orchestrate/tools/orchestrate.mjs` (two commands, `USAGE`, `main`'s dispatch, the tool's copy of the PR URL pattern)
- Test: `skills/backlog-orchestrate/tools/orchestrate.test.mjs`

**Interfaces:**
- Consumes: run fields from Task 3.
- Produces: `pr-draft` → stdout one JSON line `{ "title", "bodyFile", "head", "target" }`, body at `<dir>/pr/body.md`; `pr --url <url>` → writes `prUrl`.
  Pure helpers exported for tests: `prTitle(items: {subject: string|null}[]): string`, `prBody(run, subjects): string`.

- [ ] **Step 1: Write the failing tests** (fixture: a `pr` run with real merge commits made the way SKILL.md §9 makes them — `Merge backlog/<id>: <title>`
  over a §6 commit and optionally a later fix-loop commit)
  - 4.1 Title ranking: subjects `fix(a): x` + `feat(b): y` → `feat(backlog): 2 items`; `fix` + `chore` → `fix(backlog): 2 items`; `perf` + `chore` →
    `perf(backlog): 2 items`; `refactor` + `docs` → `chore(backlog): 2 items`; one `fix` → `fix(backlog): 1 item`.
  - 4.2 Breaking: `feat(b)!: y` + `fix(a): x` → `feat(backlog)!: 2 items`; `refactor!: y` alone → `chore(backlog): 1 item` (no `!`).
  - 4.3 The §6 commit wins over a later fix-loop commit: §6 `chore(x): a`, fix loop `fix(x): b` → `chore(backlog): 1 item`.
  - 4.4 An item staged `merged` with no `Merge backlog/<id>: ` commit ranks `chore` and still has its `## What's new` line; `pr-draft` exits 0.
  - 4.5 Body: `## What's new` lists merged items in queue order as `- <title> (#<id>)`; then `## Run` with `` `<runId>` drained onto `<head>` from `<target>`: ``
    and the counts in the order merged, branched, parked, failed, skipped, ungroomed, needs-answers, zeros omitted.
  - 4.6 A run with branched items adds one line naming those branches and saying they merge only after this PR lands.
  - 4.7 Refusals, exit 1, nothing written under `<dir>/pr/`: `mergeMode` not `'pr'`; no item `merged`; `prUrl` already set.
  - 4.8 `pr --url https://github.com/futin/backlog-manager/pull/275` writes `prUrl`; the six bad URLs of case 1.3 each exit 1 with the run unchanged.
  - 4.9 Titles render as one list line each: `a\nb` → `- a b (#7)`; `` use `x` `` → `` - use `x` (#7) `` (backticks kept verbatim — they are Markdown the
    reader wants); `## heading` → `- ## heading (#7)` (the `- ` prefix already stops it being a heading, so nothing is escaped).
  - 4.10 The tool's PR URL pattern source equals `shared/agent.ts`'s `PR_URL_PATTERN` source (parsed from both files, as 3.1 does).
- [ ] **Step 2:** `pnpm run test:skills` — red.
- [ ] **Step 3: Implement** per spec §4 (*Title*, *Body*). Merge commit lookup: first-parent commits in `<prTarget>..<base>`; the item's subject is the
  first line `git rev-list --reverse --topo-order M^1..M^2` yields. The body file is written atomically under `<dir>/pr/`.
- [ ] **Step 4:** green.
- [ ] **Step 5: Commit** `feat(orchestrate): compose a run's pull request and record its url`.

### Task 5: Tool — `finish` removes an empty run branch

**Files:**
- Modify: `skills/backlog-orchestrate/tools/orchestrate.mjs` (`cmdFinish`; and `cmdAbort`'s comment at `:5786`, which describes `cmdFinish` as a pure status write)
- Test: `skills/backlog-orchestrate/tools/orchestrate.test.mjs`

**Interfaces:**
- Consumes: `treeHoldingBranch`; run fields from Task 3.

- [ ] **Step 1: Write the failing tests**
  - 5.1 `pr` run, no item merged, run branch equal to target, no tree holds it → `finish --status done` exits 0 and the branch is gone.
  - 5.2 Same, but the run branch has a commit beyond the target (a merge that landed but was never staged) → branch kept, one stderr line naming it.
  - 5.3 Same as 5.1 but a `_base-` worktree still has it checked out → branch kept, one stderr line, exit 0.
  - 5.4 `finish --status paused` never deletes; `--status aborted` and `failed` do (via `abort` too: `cmdAbort` ends through `cmdFinish`).
  - 5.5 A `pr` run with an item `merged` → branch kept whatever the status.
  - 5.6 `merge`/`branch` runs: `finish` touches no branch (existing behaviour; assert refs unchanged).
  - 5.7 The project root has a different branch checked out than the target → 5.1 still deletes (the delete is HEAD-independent).
- [ ] **Step 2:** red.
- [ ] **Step 3: Implement** spec §4 *Nothing merged*: read the run branch sha, check `rev-list --count <prTarget>..<base>` is 0 and no tree holds it,
  then `git update-ref -d refs/heads/<base> <sha>`. Any failure is one stderr line and never changes the exit code. Rewrite `cmdAbort`'s `:5786` comment about `cmdFinish`.
- [ ] **Step 4:** green.
- [ ] **Step 5: Commit** `feat(orchestrate): finish removes a pr run's empty branch`.

### Task 6: Client — Settings, the sheet, RunDetail

**Files:**
- Modify: `client/src/lib/run-stage.ts` (`mergeModeLabel`), `client/src/lib/settings.ts` (clamp —
  automatic through `MERGE_MODES`; check its comment), `client/src/components/board/OrchestrateSheet.tsx` (new `source` prop, option filter, fallback,
  coverage-hint guard at `:329` and `:1184`; the prop is typed `ProjectSummary['source']`, i.e. `SourceKind | 'unsupported' | null`, and `pr` is offered
  iff it is `'github'`), the `BoardView` call site that renders the sheet (passes `source` from the registered project's
  `ProjectSummary.source`), `client/src/components/runs/RunDetail.tsx` (pill, link), `client/src/styles.css` only if the link needs a class the head does not have
- Test: `test/orchestrator-start-ui.test.tsx`, `test/run-detail.test.tsx`, `test/runs-view.test.tsx` (if it asserts the pill)

**Interfaces:**
- Consumes: `MERGE_MODES`, `isPrUrl` (Task 1); `OrchestratorRun.prUrl`.

- [ ] **Step 1: Write the failing tests**
  - 6.1 `mergeModeLabel('pr', 'pr')` is `PR mode`; `('pr', 'branch')` is `branch mode (downgraded)`; `('merge', 'merge')` stays `null`.
  - 6.2 Sheet, tracker project: three options, `Open a PR into <base>` among them; launching with it posts `mergeMode: 'pr'`.
  - 6.3 Sheet, files project: two options, no `pr`; a Settings default of `pr` opens the sheet on `merge` and posts `mergeMode: 'merge'`. The same two
    outcomes for `source: null` and `source: 'unsupported'`.
  - 6.4 Sheet: the no-allow-rule hint shows for `merge` and `pr`, not for `branch` (fetch mocked uncovered).
  - 6.5 RunDetail: `prUrl` set → a link labelled `PR #275` with that href, `target="_blank"` and `rel="noopener noreferrer"`; `prUrl: null` → no link.
    A run that reached the client with a bad `prUrl` is impossible after Task 1's sanitiser, but RunDetail also renders no link unless `isPrUrl` holds.
  - 6.6 RunDetail: a `pr` run draws the `PR mode` pill.
- [ ] **Step 2:** red.
- [ ] **Step 3: Implement** spec §5. Cite `.claude/DESIGN.md`'s subsection in any new component header comment (the repo's rule).
- [ ] **Step 4:** the suites green; `pnpm typecheck`; `pnpm build`.
- [ ] **Step 5: Commit** `feat(board): launch and show pr-mode runs`.

### Task 7: Skill text, rules and docs

**Files:**
- Modify: `skills/backlog-orchestrate/SKILL.md` (trigger line; §2 mode list and probe sentence; §4 pull skip; §5's "Stopping the run is `finish --status
  failed`" routed through §10; §10's three PR steps, the aborted line, the kept-local-branch line, the merge-list target rule; hard-limit bullet),
  `skills/backlog-orchestrate/references/tracker.md` (§4 pull skip reason, §9 push now naming the run branch, *Hard limits — the three pushes*, the
  `ls-remote` fallback, a denied `gh`, the collision recovery, the nothing-merged delete), `skills/backlog-orchestrate/references/recovery.md` (abort
  summary line; resume never re-opens a PR when `prUrl` is set; the `--abort` section at `:184-186` notes that `abort` ends through `finish`, which in PR
  mode may delete an empty run branch with `update-ref -d` — no new step for the session, but the text must not claim abort touches no ref)
- Modify: `.claude/rules/orchestrator.md` (merge-mode bullet gains `pr`; push bullet names `gh pr create`; **a new bullet** for the new anchor),
  `docs/subsystems/invariants.md` (new section *PR mode drains onto a run branch and opens one PR per run*), `CLAUDE.md` (new headline, byte-equal with the
  new rules bullet's), `docs/subsystems/board.md`, `docs/workflows/ci.md` §The ruleset, `docs/subsystems/skills.md` if it lists merge modes
- Test: `test/claude-rules.test.ts` (existing guard — must stay green), `pnpm run test:skills` (SKILL.md text guards in `orchestrate.test.mjs`, the §9
  fenced-command guards at `orchestrate.test.mjs:3916-3958`)

- [ ] **Step 1:** Write the SKILL.md changes, each new rule entering as **one statement** with its story in `references/` (the repo's invariant). Every
  command added is fenced and literal, with `<target>`/`<head>` placeholders spelled as `pr-draft` prints them.
- [ ] **Step 2:** Rules, invariants, CLAUDE.md headline. Run `pnpm run test:jest -- claude-rules` — green (anchor exists once, one home, headline byte-equal).
- [ ] **Step 3:** board.md, ci.md (its "Phase B's `--pr` mode" wording becomes the `pr` merge mode — there is no `--pr` flag;the ruleset may be applied once the Settings default is `pr`; first bullet says a run opens a PR instead of pushing
  `main`; release-kit's `apply-repo-settings.sh` stays the user's step), skills.md.
- [ ] **Step 4:** `pnpm test` (both runners), `pnpm typecheck`, `pnpm build` — all green; paste the summary lines into the task report.
- [ ] **Step 5: Commit** `docs(orchestrate): document pr mode in the skill, rules and invariants`.

## Not in this plan (held for the user)

- Pushing the branch and opening this feature's own PR; the post-merge `pnpm run docker:sync` **before** `pnpm run plugin:sync` (spec *Rollout* 2).
- Setting the Settings default to `pr`, the first live PR-mode run (spec *Unproven*), and applying the ruleset.
