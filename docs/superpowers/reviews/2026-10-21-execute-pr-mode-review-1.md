# Plan review 1 — backlog-execute `pr` finish mode

Plan: `docs/superpowers/plans/2026-10-21-execute-pr-mode.md` (205 lines). Spec: `docs/superpowers/specs/2026-10-21-execute-pr-mode-design.md` (199 lines).
Reviewer: a fresh subagent on Fable 5.1, 2026-10-21. Every code claim below was read in this worktree
(`.claude/worktrees/migrate-timify-26150-branch-d3a62c`); the CodeGraph index is the main checkout's, so line numbers were re-checked with grep here.

## Verdict: APPROVE WITH FIXES

No Critical finding. Eight Important ones, all local: three wrong values (a copy string, a status code, a reason string), one test placed in a suite that
cannot build its fixture, one gate value left to a guess, two Review Focus items with no test although the repo already pins skill prose in node tests, and
two false citations. Coverage, interfaces and order are sound.

## 1. Coverage — spec section → task

| Spec section | Task(s) |
| --- | --- |
| Goals (both entry points, `in-place` default, override phrase) | 1, 2, 6 |
| Non-goals — the prompt change, its five test cases, the "known seam" comment | 2 |
| The config (reader/setter, local-file in both modes, rules bullet amended) | 1, 7 |
| The `pr` flow, steps 1–9 | 6 (reviewer inputs 5, `review` verb 4) |
| Invariants this changes (every listed site, the final grep) | 7 |
| `agents/backlog-reviewer.md` widened | 5 |
| execute description / hard limits / `:32` kept / `:257` clause | 6 |
| `docs/subsystems/skills.md` documents the config | 7 |
| Settled after builder check (starting tree, `cd`, permission denied, reviewer outside a run) | 1, 6 |
| D8 tracker never archives in `pr` mode | 6 |
| D9 label, route, verb, count, writer, readers, removal, `Refs #<n>` | 3, 4, 6, 7 |
| Spec test cases (`test/agents-prompt.test.ts`: no file / in-place / pr / malformed / unknown) | 2 |

Nothing in the spec lacks a task.

## 2–7. Findings

### Important

- **[I] plan:30 — `PR_FINISH_RULE` is not the spec's string.** Spec:33 writes ``"Finish in this project's `pr` mode: …"`` with backticks around `pr`; the
  plan's Global Constraint drops them. `COMMIT_RULE` itself carries backticks in the sent prompt (`shared/agent.ts:829`), so the backticks are plausibly part
  of the string, not markdown. → Make the constant byte-equal to spec:33 (keep the backticks), or state the deviation in the plan so Task 2's "exactly"
  assertions (plan:85–86) pin the intended text.

- **[I] plan:106, plan:110 — the route answers `201`, not `200`.** Nest's POST default is 201 and the sibling route's suite pins it:
  `test/tracker-write.test.ts:515` `post('queue', …).expect(201)`, `:527`, `:540`, `:548`. An implementer who follows the plan's `200` either writes a failing
  test or adds an `@HttpCode(200)` the other nine routes do not carry. → `201 { id, inReview }`, and "a removal answered 404 is `201`".

- **[I] plan:135 — the disabled reason diverges from the spec and from the ladder's wording.** Spec:182–184 gives the reason as "a PR is open for this item"
  and says the two ladders disable Run "with that reason". The plan's `In review — a PR is open for this item` adds a capitalised prefix, while every
  sibling reason on both ladders is a lowercase fragment (`shared/agent.ts:460` "an orchestrator run is working this item (…)", `:465`,
  `client/src/lib/item-progress.ts:106` "a session is already working this item (…)"), and plan:126 gives the orchestrator a third spelling
  (`in review — a PR is open`). → One string, the spec's: `a PR is open for this item`, used by `inReviewBlock`, the orchestrator gate reason and execute's
  refusal gate (plan:181 already has it).

- **[I] plan:129, plan:139 — the server refusal test is placed in a suite that cannot build its fixture.** `inReview` only ever exists on a tracker item (it
  is set from the label in `server/src/tracker/map-issue.ts:148/:249`'s pattern), but `test/agents-dispatch.test.ts` is a files-project suite — zero
  occurrences of `github`/`Github`, items come from `bugPath('bug-1-…')` (`:192`, `:239`). The tracker dispatch suite with a `FakeGithub` already exists:
  `test/tracker-dispatch.test.ts:13,48,111`, with `describe('dispatch')` at `:205` and 409 cases at `:216–237`. → Name `test/tracker-dispatch.test.ts` for
  the 409 and the plan's `blocked` case (and in Step 2/4's suite list).

- **[I] plan:126 — the orchestrator gate's `gate` value is left to a guess.** The queue vocabulary is `ready | ungroomed | needs-answers`
  (`skills/backlog-orchestrate/tools/orchestrate.mjs:1523–1529`); the one precedent for "gate an otherwise-ready item with a reason" is the stale mark,
  which reuses `gate: 'ungroomed'` and prepends its reason (`:1760`, `applyStaleMarks`). A new value would ride into `RunStage` (`shared/types.ts:1180`) and
  every consumer (`client/src/components/runs/StageTrack.tsx:259`, `RunRowTime.tsx:57`). → State it: reuse `'ungroomed'` with the reason prepended, the
  way `applyStaleMarks` does — or name the new value and the consumers it touches.

- **[I] plan:38–40, plan:153 — Review Focus 1 and 2 have no test, although the node suite already pins execute's skill prose.**
  `skills/backlog/tools/backlog.test.mjs:3064–3070` defines `executeSection(heading)` over `backlog-execute/SKILL.md` and uses it at `:3095`, `:3116`;
  `:4842` pins "SKILL.md documents exit `5`". The checklist asks every Review Focus item to have a test; "manual check" (plan:38) is not one. → Task 6 gains
  two node cases in `backlog.test.mjs` reading `references/pr-mode.md`: the reuse rule names "named branch", "detached" and `<base>` as non-reusable; the
  cleanup rule says only the tree/branch this session made is removed and a reused tree never is.

- **[I] plan:100 — "the files source's refusal for it" does not exist.** `FilesSource implements ItemSource` only (`server/src/items/sources/files.source.ts:23`);
  `ItemWriter` has one implementation, `GithubSource` (`github.source.ts:63`). The files-project refusal is the controller's, before any writer is resolved
  (`server/src/items/items-write.controller.ts:29` "files project (400)", pinned at `test/tracker-write.test.ts:143`). → Drop the files-source item; the
  test at plan:111 is already right (400, same as `queue`).

- **[I] plan:171 — "dependencies as orchestrate SKILL.md §541-544 does" cites the wrong place.** `skills/backlog-orchestrate/SKILL.md:541–544` is the
  `info/exclude` paragraph only. The dependency mechanism — a `node_modules` symlink into the main tree — is `orchestrate.mjs:4174–4176` and
  `references/rationale.md:98`. → Cite those for the dependency half, and say the reference instructs the symlink (or the repo's install command) explicitly.

### Minor

- plan:126 vs plan:135 vs plan:181 — three spellings of one reason (see the Important above); also `in review — a PR is open` loses "for this item".
- plan:142, plan:144 — "the four suites": Task 4's Test line names five files.
- plan:113 — Task 3's Step 2 omits `test/agents-origin-guard.test.ts`, which Step 1 modifies.
- plan:96 — the `nine` wording also lives in `server/src/tracker/labels.ts:63` ("The nine, in the order…"), `:95` ("The nine names alone") and the title at
  `test/tracker-poll.test.ts:467` ("creates none when the repo already has all nine"); Task 7's grep (`nine .*write routes`) will not catch them.
- plan:87, plan:114 — `test/agents-prompt.test.ts:108–113`'s comment "The commit rule rides on EVERY action" becomes false for execute in a `pr` project;
  rewrite it with Task 2 (the `it.each` itself stays green because the default is `in-place`).
- plan:166–182 — spec sentences Task 6's pinned list does not name, covered only by "every 'my call'" (plan:164): "not authenticated" (spec:122), "a
  rejected push stops there and is reported" (spec:123), "a failed label write undoes nothing; the final message says the guard is missing" (spec:180), the PR
  body carries "the findings' one-line summaries" (spec:157), the refusal names the PR "when it can" (spec:182), the subject "must satisfy the target repo's
  PR-title rule" (spec:110), and the heartbeat/15-minute window left to the builder (spec:197). Listing them keeps the reference from losing one.
- plan:170–171 — spec:96 asks to reuse `ensureExcludeLines` "where the builder can"; it is an export (`orchestrate.mjs:4260`) of a tool that refuses every
  verb but `init` inside a linked worktree (execute `SKILL.md:31`), so prose instructions are the honest answer — say that is the decision.
- plan:61 — no case for `config set execute.base <branch>`; one `set`/read round trip would pin it.
- plan:56 — the "commit the file" reminder is specified for a git repo only; say what happens outside one (likely: no reminder, exit 0).
- plan:41 — Review Focus 3 says "no 500" but Task 2's cases are util-level (`readFinishMode`/`composePrompt`); a 500 would come from the route. Either say
  the util test is the guard (reader never throws) or add one `POST /api/agents/plan` case with a malformed file.
- plan:158–182 — Task 6 has no Interfaces block; it consumes `backlog.mjs config` (Task 1), `PR_FINISH_RULE` (Task 2) and `review <id> on` (Task 4) — stating
  them makes the dependency explicit for a subagent-driven run.
- plan:191–197 — the tenth route and the label are documented nowhere but `skills.md` and the counts; `docs/subsystems/api.md` (route list) and the tracker
  doc likely state the nine too. Spec:143 names only `skills.md`, so this is taste.

## Checklist notes

- **Values:** config shape, label name, route path/body, branch/worktree names, override phrase, `Closes`/`Refs`, fix-round cap, report path — all match the
  spec. The three mismatches are the Important items above.
- **Reality:** every Modify path/line exists (`backlog.mjs main` :2245, `resolveRoot` :325, `apiPost` :794 → `/api/items/<route>`; `prompt.util.ts:26–30`;
  `agents.service.ts:389/414/451–491`; `shared/agent.ts:819–830`; `labels.ts:61–74`; `map-issue.ts:148–249`; `source.ts:223`; `github.source.ts:902`;
  `items-write.controller.ts:254`; `item-progress.ts:95`; `orchestrate.mjs:1627/1918/2327/4260/6127`; `orchestrate.test.mjs:7372`; `backlog-reviewer.md:3–7,
  58–75`; execute `SKILL.md:6/32/257/343–345`; `CLAUDE.md:121–122/175`; `.claude/rules/orchestrator.md:33–37`, `items.md:7,27`, `skills.md:19–22`;
  `invariants.md` §434, §3404, §3908; orchestrate `SKILL.md:9,26`; `skills.md:34`; groom `:18`; backlog `SKILL.md:138`; `recovery.md:253`). Both Create
  paths are absent (`server/src/agents/finish-mode.util.ts`, `skills/backlog-execute/references/`). The `#the-nine-item-write…` anchor has exactly two
  link sites (`CLAUDE.md:122`, `.claude/rules/items.md:27`).
- **Interfaces:** Task 4 consumes `BacklogItem.inReview` and `POST /api/items/review` as Task 3 produces them; `ItemReviewRequest` mirrors
  `ItemQueueRequest` (`shared/types.ts:2669–2672`).
- **Order:** 1 → 2 (independent) → 3 → 4 → 5 → 6 → 7; no forward dependency.
- **Fixtures discriminate:** `#3` vs `#4`, `trunk` vs `main`, labelled vs unlabelled, `inReview` vs `inReview+started` — yes.
- **Conventions:** the plan keeps its own "behaviour, not code" override throughout; wraps at 160.
