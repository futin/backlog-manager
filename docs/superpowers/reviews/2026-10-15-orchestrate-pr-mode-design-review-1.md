# Review 1 — `backlog-orchestrate` PR mode design

Document: `docs/superpowers/specs/2026-10-15-orchestrate-pr-mode-design.md` — read at commit `b9bb4a2` on `ci/phase-a-gate` (the file is not on `main`;
nothing was checked out). Outside source: `claude-agents-dashboard` `ci/phase-a-gate:docs/superpowers/specs/2026-10-15-release-pipeline-design.md`.
Reviewer: Fable 5.1, fresh session, checklist as dispatched. Code references are to `main` (`e262c59`), which is what the spec's claims about existing code
describe; the branch touches only `ci.yml`, `ci.md`, CLAUDE.md, `overview.md` and seven test lines.

## Verdict

**APPROVE WITH FIXES.** No Critical findings. The design is sound and P4 does carry most of the weight it claims — `base` is read by the gate
(`orchestrate.mjs:2871`), `merge-check` (`:3666-3708`), `cleanup` (`:4077-4093`), the worktree cut (`:3893`), the claim (`:1918`) and the remote derivation
(`remote-runs.util.ts:365`), and every one of them works with a branch that no tree has checked out. The fixes below are facts the spec gets wrong about the
code and the machine, two edge cases the loop can reach and the spec does not resolve, and one copy decision resting on a false premise.

Verified true (no finding): `main-pr-only` is the ruleset's name (`release-kit/rulesets/main.json:2`) and it is `active` on `futin/claude-agents-dashboard`
(`gh api …/rulesets`, 2026-10-15); the `pr-title` regex allows `!` only on `feat|fix|perf` (release spec L51); the claim route's 400 text is exactly
`run.mergeMode must be one of merge, branch` (`items-write.controller.ts:412`); `sanitizeMergeFields` resolves an absent `base` to `'main'` once
(`orchestrator.service.ts:115`); the §9 push is `git -C "<base tree>" push origin <base>` (`SKILL.md:1052`) with the three outcomes the spec lists
(`tracker.md:163-174`); the tracker merge subject is `Merge backlog/<n>: <title>` (`SKILL.md:1020`); outcome 2 creates `.worktrees/_base-<sanitised>`
(`orchestrate.mjs:3676`) and §10 removes it only when `created` (`SKILL.md:1104-1108`); `stage merged` is refused only on `mergeModeEffective === 'branch'`
(`:3197`); `merge-mode` allows only `merge → branch` today (`:3432`); the Settings clamp (`settings.ts:305`) and `init` (`:2784`) check `MERGE_MODES`;
`archiveSidecars` moves every entry but `run.json` and `runs/` (`:474-484`), so `<dir>/pr/body.md` is archived with no new code; `references/recovery.md`
and `references/tracker.md` exist; the example commit `fix(orchestrate): re-claim a tracker item's issue when it leaves parked` is real (`2611d63`).

## Important

**[I] L11, L25 — "Every backlog registered on this machine — this repo, `claude-agents-dashboard`, `lookout`, `guide-manager` — is tracker-backed" and
P3's "every registered backlog is tracker-backed" are false.** `~/.backlog-manager/registry.json` holds seven projects: the four named plus `ixray` and
`brickwright` (both `github`) and `finance-manager`, which has no `backlog/source.json` and is therefore a files project. The design survives (P3 refuses
`pr` there) but the "no current user" rationale for rejecting files support is wrong, and the sheet fallback in §5 is exercised today, not hypothetically.
→ Name the real set and say a files project exists, so the §5 fallback and the §6 row 1 refusal are live paths that need their tests.

**[I] L43-44 — "Every surface … accepts `pr` without further change" and "the server appends `--merge-mode pr` … from a compile-time literal, behind
its guard" are listed as rules that "hold unchanged", but the server has no such literal.** `server/src/agents/agents.service.ts:749` is
`...(mergeMode === 'branch' ? ['--merge-mode', 'branch'] : [])` — a `pr` request would spawn a plain `merge` run — and `:1805`'s 400 is the hand-written
`mergeMode must be merge or branch — … is not one`, which goes stale. → List both as edits in §1: a second guarded literal for `pr`, and the message
rebuilt from `MERGE_MODES` (or re-literalled). §7's jest line already implies the first; §1's prose contradicts it.

**[I] L158-159 — "The merge-coverage hint stays `merge`-only: a PR run always merges in a fresh `_base-` worktree, so the dirty-tree hint has nothing to
say" rests on a false description of the hint.** `OrchestrateSheet.tsx:1184-1193` is not a dirty-tree hint: it says `settings.local.json` has no
`git merge` allow rule and pastes `MERGE_ALLOW_SNIPPET` — the auto-mode classifier coverage for the exact command §9 runs. A PR run runs that same merge,
so the hint matters to it exactly as much; hiding it under `pr` removes the one warning that predicts the degrade path. The guards are `:329`
(`mergeMode !== 'merge'` skips the fetch) and `:1184`. → Show the hint for `merge` and `pr`, and replace the sentence with the real reason the check
applies to both.

**[I] L94 vs L99 — the PR is to be opened on a `done` or `failed` finish, "in SKILL.md §10, after the existing base-worktree removal and before
`finish`", but the `failed` finish is not in §10.** `SKILL.md:746` ("Stopping the run is `finish --status failed` after parking this item") is in §5,
reached from the dispatch failure path, and never passes through §10's finishing sequence (nor its `_base-` removal). As written, a `failed` run with
merged items opens no PR. → Either state that every `finish --status failed` routes through §10's finishing steps first, or drop `failed` from L94 and
give it the aborted-run treatment (branch named, exact `gh` line).

**[I] L138, L143 — the `## Run` line's count vocabulary is incomplete and the rule "omits each zero count" cannot settle it.** The template lists merged,
parked, skipped, ungroomed and needs-answers; `RunStage` (`shared/types.ts` §RunStage) also has `failed` and `branched`, and a degraded PR run — the
case L174 says still gets a PR — ends with `branched` items that the body would then not mention. → State the full ordered list of counts (add
`branched` and `failed`), or say explicitly that those two are left out and why.

**[I] L116-120 — no outcome when an item's merge commit is not found.** The tool "finds the item's merge commit as the first-parent commit in
`<prTarget>..<base>` whose subject begins `Merge backlog/<id>: `"; an item merged by hand after a park and then `stage <id> merged` (the carry-forward
`tracker.md:24-25` allows) may carry a different subject, and L119's "unparseable subject ranks as `chore`" covers the work commit, not a missing merge.
→ Define it: no matching merge commit → the item ranks `chore` and still appears in `## What's new`; `pr-draft` never refuses on it.

**[I] L103-106, L108 — a second `gh pr create` for the same head is refused by `gh` ("a pull request for branch … already exists"), and the spec
treats that as the failure case with `prUrl` left `null` although a PR exists.** The path is real: a session that dies between step 2 and step 3 is
resumed by the watchdog, the resumed session reaches §10 and runs steps 1-2 again. → Make the sequence idempotent: `pr-draft` refuses when `prUrl` is
already set, and the driver runs `gh pr view <head> --json url` (or `gh pr list --head <head>`) before `create`, recording whichever URL it gets.

**[I] L173 with L80 — the two-machines collision has no recovery.** Row 3 says the second machine's first push is rejected and the item parks "as any
rejected push does", and `tracker.md:173` promises "`--resume` pulls and pushes again" — but §3 skips the §4 pull under `pr`, so a resume re-pushes the
same non-fast-forward ref and parks again, forever. → Name the recovery in §6 (abort and re-`init`, which mints the next number; or a hand rename of the
local run branch), and say in §3 that the `tracker.md:173` resume promise does not hold for the run branch.

**[I] L174, L30 — the degrade path leaves the branched items on top of the run branch and the spec says nothing about them.** After `pr → branch`,
every later item's `backlog/<id>` is cut from `<base>` = the run branch at a point after the earlier merges, and pushed (`push -u origin backlog/<n>`,
`.claude/rules/orchestrator.md:28`). Once the PR squash-merges, those branches carry the pre-squash merge commits; §10's merge list
(`SKILL.md:1124-1130`, "say which branch to run it on when the base is not `main`") would name the run branch, which the ruleset's "delete head branch
on merge" removes. → One sentence in §4 or §6: for a degraded run the summary names the PR and tells the person to merge the branched items only after
the PR lands, rebased onto `<prTarget>` (or as PRs of their own).

**[I] L165 — "Remote runs need nothing" is false at the type level.** `server/src/orchestrator/remote-runs.util.ts:364-369` builds the `OrchestratorRun`
literal field by field; if `prTarget`/`prUrl` are required on `OrchestratorRun` as `base` is (`shared/types.ts:1273`) — and L67-68's "resolved once, like
`base`" posture implies they are — that literal, `cmdInit`'s skeleton (`orchestrate.mjs:2991-3013`) and every test fixture that spells a run out go red
until `null` is added. The compiler catches it, so the cost is small. → Say "needs only `prTarget: null, prUrl: null` in the derivation", or declare the
fields optional and say why that differs from `base`.

## Minor

- L73 — "an item id is a bare number, `bug-<n>` or `task-<n>`": `ITEM_ID_SHAPE` is `/^[a-z]+-\d+$/` (`shared/agent.ts:586`), so any lowercase prefix is an
  id shape; the no-collision argument holds because no backlog section is named `run`, which is the sentence to write.
- L101 — `pr-draft` prints `{ title, bodyFile, head, base }` where `base` means `prTarget`, while `<base>` in every SKILL.md command means the run branch.
  Call the key `target` to keep one meaning per word in the driver's vocabulary.
- L118 — "the **oldest** commit in `M^1..M^2`": say `git rev-list --reverse --topo-order` (parent before child) rather than leaving date order implied;
  a fix-loop commit authored on a machine with a skewed clock would otherwise win.
- L148-152 — `cmdFinish` is documented as "a pure status write" (`orchestrate.mjs:5786`) and §10's prose (`SKILL.md:1115`) says a failed `_base-`
  removal "does not fail the run"; adding a git write to `finish` is fine but the comment at `:5786` and `recovery.md`'s abort order (`:186`) should
  be named in §8 as docs that move.
- L148 — after a successful PR the local run branch is kept, and nothing ever deletes it (the ruleset deletes only the remote head). Say so, and that
  the mint's local-refs read is why numbers keep rising across runs on one machine.
- L197 — the forcing function is `test/agents-shared.test.ts:152` (`expect(MERGE_MODES).toEqual(['merge', 'branch'])`) and
  `test/settings-view.test.tsx:459`, plus the one `Record<MergeMode, string>` in `client/src/lib/merge-mode.ts:38`; that test file has no `Record<MergeMode>`
  literal. Name the lines so nobody "fixes" the loop at `:160` instead.
- L28 (P6) — "The tool makes no outbound call of its own": `orchestrate.mjs` already calls the local API (`apiCall`, `:122`). Say "no call to GitHub".
- L58-64 — between step 2 (pull) and step 4 (branch) `init` also runs the gate at `<base>` (`orchestrate.mjs:2871`, reading the target's tip, which
  equals the run branch's) and the exit-4 existing-run check (`:2934`). Say the branch is created after both, so the gate still reads `<target>`.
- L60 — say that `<n>` is parsed only from refs matching `backlog/run-<date>-\d+$`; a stray `backlog/run-<date>-wip` must not break the mint.
- L125 — a run whose only breaking item is `refactor!`/`chore!` ships a non-breaking `chore(backlog)` title by this rule; that is the intended consequence
  of `pr-title`, and it is worth one sentence so it is not read as an omission.
- L83, L89 — the release spec (L89-92) phrases D8 as "at the end pushes the branch and runs `gh pr create`"; this spec pushes after every merge. The
  deviation is deliberate (P2) — say so in one clause beside P2 so a reader of both specs does not report it as drift.
- L94 — `FINISH_STATUSES` (`orchestrate.mjs:4311`) is the right list; fine. L216's rollout note is exact (`items-write.controller.ts:412`); fine.
