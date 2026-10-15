# Plan re-check — `backlog-orchestrate` PR mode, review 1 fixes

Scope: the lines commit `4c04c61` added to `docs/superpowers/plans/2026-10-15-orchestrate-pr-mode.md`. Spec and the rest of the plan read for context
only. Every code claim below was checked with a narrow read (`sed -n` / `grep`) in the `orchestrate-pr-mode` worktree. No document was edited.

## Verdict

**APPROVE WITH FIXES** — two Important findings, both one-line edits to Task 3; nothing Critical.

## Important

### I1 — plan:133 — `nextRunBranchName` unit case calls it with the arguments swapped

Task 3 *Produces* (plan:123) declares `nextRunBranchName(date: string, existing: string[])`. Case 3.4 (plan:133) then spells the unit case as
`([], '2026-10-15')` — `existing` first, `date` second. An implementer who writes the test from 3.4 and the helper from the interface line gets a
suite that is red for the wrong reason, or one of the two gets silently flipped to match the other.

**Fix:** write the case as `('2026-10-15', [])` → `backlog/run-2026-10-15-1` (and the "ref from another date" case the same way round).

### I2 — plan:140-141 — "an `origin` that exists but cannot be reached never gets this far" is false on the path 3.12 itself tests

The parenthetical says `pullBaseAtInit` runs first and refuses an unreachable `origin` with exit 1. That holds only when a tree holds `<target>`:
`pullBaseAtInit` (`skills/backlog-orchestrate/tools/orchestrate.mjs:2684-2696`) returns early at `:2686-2687` (`treeHoldingBranch(...) === null`)
without pulling, so `init --merge-mode pr --base feature/x` with `feature/x` checked out nowhere reaches the `ls-remote` mint with an `origin` that
exists and cannot be reached. The spec names exactly that case as a fallback, not a refusal — §2 step 3 (spec:70-71): "A failed `ls-remote` (offline,
no `origin`) falls back to local refs and prints one stderr line". As written, an implementer may key the fallback on "no `origin` configured"
(`remote get-url origin` failing, the check `pullBaseAtInit` uses) and let a present-but-dead `origin` surface `ls-remote`'s own `fatal:` and exit.

Review Focus 3 (plan:41-42) overstates the same way: "a hung remote → the spawn's timeout, never a hung `init`". The `git pull --ff-only` at `:2689`
carries no timeout, so a hung `origin` hangs `init` there today whenever a tree holds the target. That is pre-existing and out of scope; the claim
should just not be made.

**Fix:** (a) in 3.7 replace the parenthetical with: the fallback fires on ANY `ls-remote` that does not exit 0 — no `origin`, an unreachable one, or
the spawn's `timeout` — and `pullBaseAtInit`'s own refusal, when a tree holds the target, is today's behaviour and stays; (b) keep the no-`origin`
case as the one that runs, and add the unreachable-`origin` shape to the same case or to 3.12's fixture (`origin` set to a non-existent path, `--base`
a branch no tree holds) — it fails fast, so it costs no wall time; (c) in Review Focus 3, say "the mint never hangs: the `ls-remote` spawn carries a
timeout" and drop "never a hung `init`".

## Minor (do not block)

- plan:93 — `test/tracker-dispatch.test.ts`'s `beforeEach` is `:106-140`, not `:39-145`; the cited range spans the constants (`:39-41`) through
  `afterEach` (`:142-146`). Harmless, but the reader looking for `syncOffBlock` there will not find the word — the tracker project passes it because
  no `sync.json` says `off`, which is the default.
- plan:95-96 — the "one unit case for the new public source method" names no test file. Suggest `test/tracker-dispatch.test.ts` (it already builds
  both a files and a tracker project via `project(name, marker)`, so an `unsupported` marker is one more call) or `test/items-source.test.ts` if one
  exists; either way name it.
- plan:91 — `sourceOf` returning `'github'` for a tracker project: `resolveSource` (`server/src/items/sources/resolve.util.ts:39-43`) returns
  `{ kind: 'tracker', marker }`, so the method maps `marker.kind` (which is in `known`, so it IS a `SourceKind`), `'missing'` → `null`, and passes
  `'files'` / `'unsupported'` through. Worth one clause so the implementer does not return `'tracker'`.
- plan:217 — the `source` prop typed `ProjectSummary['source']` (= `SourceKind | 'unsupported' | null`, `shared/types.ts:388`) is RIGHT and the spec
  §5 (spec:183) still says `source: SourceKind`, which would not typecheck against what `BoardView` passes. Update the spec line when the plan lands.
- plan:55-56 — "the hint names all three" is a plan addition (spec §5 *Settings*, spec:188, only says the picker lists `pr`). Fine. Note
  `test/settings-view.test.tsx:459,464` pins the two-mode value and label lists; Task 1 Step 4's "classified, never weakened" already covers updating
  them.
- plan:258 — `flag;the` is missing a space.
- plan:94 — 2.5 (a `pr`-on-files request under a lock) is listed as a "tracker case" for `tracker-dispatch.test.ts`; it is a files-project request.
  `tracker-dispatch` does hold both projects (`alpha` files, `gamma` tracker, `:113-114`), so it can live there — just do not call it a tracker case.

## Checklist, item by item

2. **Values** — `- a b (#7)` matches spec `- <item title> (#<n>)` (spec:153); `PR mode`, `branch mode (downgraded)`, `Open a PR into <base>`, `PR #275`
   match spec §5 (spec:182,190-191); 2.2's `unsupported` → 400 matches spec:59 ("resolved source is not `github`"); 6.3's `null`/`unsupported` → no
   `pr` matches spec:183 ("only when … `github`"); the `_base-` prefix and outcome 2 match `orchestrate.mjs:3674-3677`. No value mismatches.
3. **Reality** — verified present: `SettingsView.tsx:383-391` (hint `:383`, two hand-built options `:386-391`); `items.service.ts:41` (`known`) and
   `resolveSource(project.path, this.known)` (`:80,:110,:213,:279,:308`); `agents.service.ts:12` imports `resolveSource` and nothing else in that file
   uses it; `agents.service.ts:311` `private readonly items: ItemsService`; `test/merge-mode.test.ts:168-179` are the `--merge-mode branch` prompt
   cases; `orchestrate.mjs:1039-1052` is the `MERGE_MODES` comment + const; `:3673-3705` outcome 2; `:5786` is `cmdAbort`'s comment calling
   `cmdFinish` "a pure status write" (`cmdAbort` at `:5713`, `cmdFinish` at `:4313`); `orchestrate.test.mjs:7192` `fakeApi`, `:7262` `trackerFixture`
   (built on `orchFixture`, which configures no remote), `:971` the key-set contract case, `:3916-3958` the fenced `git -C` / `merge --abort` guards;
   `references/recovery.md:184` `### --abort`; `docs/workflows/ci.md:50,56` "Phase B's `--pr` mode"; `OrchestrateSheet.tsx:329` effect guard and
   `:1184` render guard; `agents.service.ts:723,728` the lock-before-content ordering comments; all ten jest files in Task 1/2/6 exist.
   Wrong: the `tracker-dispatch` `beforeEach` range (Minor above). False in one path: the `pullBaseAtInit` claim (I2).
4. **Interfaces** — `nextRunBranchName` argument order (I1). `sourceOf`'s return union matches `ProjectSummary.source` and the sheet prop type
   (`shared/types.ts:388`). `mergeModeOptionLabels` is `Record<MergeMode, string>` (`client/src/lib/merge-mode.ts:38`), so Task 1's typecheck argument
   holds.
5. **Order** — Task 1 now owns the `SettingsView` change Task 6 used to hedge on, and Task 6's file list no longer names it; Task 2 consumes Task 1's
   `MERGE_MODES` and its own new source method; Task 1 Step 4 names both interim gaps and the tasks that close them. No forward dependency.
6. **Tests** — 3.7 as rewritten is red before the mint exists (no branch, no stderr line). 3.4's bare-`origin` note is correct: `orchFixture` has
   `main` checked out, so `pullBaseAtInit` does pull, and `pull --ff-only origin main` into an empty bare remote fails (`couldn't find remote ref`).
   4.9's three exact strings pin the sanitiser (collapse `\n`, keep backticks, no escaping of `#`). 3.12 points at the right outcome. The `ls-remote`
   timeout pin "by reading the spawn options in source" has repo precedent (3.1 parses `MERGE_MODES` from both files) and is acceptable.
7. **Conventions** — behaviour and test cases only; no literal code was added. Lines wrap at 160.
