# Review 1 — plan `2026-10-20-jira-repo-branch.md` against spec `2026-10-20-jira-repo-branch-design.md`

Reviewer: a fresh Fable session, 2026-10-20, given only the two document paths and the checklist. Every claim about the code below was checked against the
checkout on `docs/jira-repo-branch-spec` (code byte-identical to `main` — the branch differs only in `docs/`). Nothing was edited.

**Verdict: REVISE.** One Critical (an exit-4 path that leaves a created worktree behind, contradicting spec §6's "Nothing was changed" and the plan's own
SKILL.md row), seven Important. All are local fixes to the plan text; none changes the design.

## Checklist results

1. **Coverage.** Every spec section maps to a task: §4 roots/unavailable → T3; §4 probe → T11; §4 duplication ruling → T2 (own `ensureExcludeLines`, Table
   A/B copies); §5.1 → T4 + T9; §5.2 → T1 (matcher) + T3 (listing, worktrees); §5.3 modes/refusals/fields → T6 + T7 + T8; §5.4 tool → T2, block → T5,
   placeholders → T5, budget → T5; §5.5 → T9; §5.6 → T5 + T6 + T8; §6 all six bullets → T10; §7 test cases → T1/T2 (matcher, pattern), T8 (modes, refusals,
   not-mounted), T5 (prompt per mode, placeholders), T9 (5.5 disabled). No spec section or §7 test case lacks a task.
2. **Values.** Copy strings match the spec where the spec fixes them: `branches unavailable — <path> <reason>`, `will work in <path>`, `branch must carry
   <KEY>`, `exists — Start again with Continue`, `behind origin by N, not fast-forwarded: uncommitted changes`, `fetch failed: … — using refs as of last fetch`,
   `Open MR when done`, the three unavailability reasons in §4's order, `{key}-{slug}`, `ABC-1`/`sample-slug`, 200 chars, 40-char slug, exit codes 0/1/4.
   Table C's long-summary case computes correctly (the `-` before `pipeline` is character 33). Table E's rows all follow from Tables A+B. Deviations the plan
   marks as its own call (Table D's `{slug}-{key}` rule) are flagged as such.
3. **Reality.** Every Create path is absent (`shared/jira-branch.ts`, `server/src/jira/refs.util.ts`, `server/src/jira/branch-choice.util.ts`,
   `client/src/components/jira/JiraBranchSection.tsx`, `test/jira-branch.test.ts`, `test/jira-refs.test.ts`, `test/jira-branch-choice.test.ts`); every Modify
   path and test file exists. Named symbols verified: `composeJiraPrompt(detail, action, repo, nonce?)` (`server/src/jira/prompt.util.ts:112`), `COMMIT_RULE`
   ends `Do not push.` (`shared/agent.ts:827-830`), `executeText` holds `create a branch for it, ` verbatim (`prompt.util.ts:53`), `PLACEHOLDER_RE`
   (`prompt.util.ts:66`), `JIRA_PROMPT_MAX = 4000` (`:40`), `normaliseRepoPath(raw, home)` (`config.util.ts:347`), `readRawForWrite`/`writeRawAtomic`
   (`:396`, `:416`, module-private — fine, the new writer lives in the same file), `JiraConfigUnreadableError`'s 409 sentence (`:237`),
   `parseReposWrite(body, home)` (`:365`), `jiraEnv` in `env.util.ts:34`, `runGit` (`git-run.util.ts:70`), `normaliseKey` (`jira.mjs:135`), `USAGE` (`:22`),
   `COMMANDS` (`:289`), the file ends `process.exitCode = await main(` and `backlog.test.mjs`'s `CLI_SOURCES` lists `jira.mjs` (`backlog.test.mjs:3348`),
   `ensureExcludeLines(commonDir, patterns)` (`orchestrate.mjs:4029`), `BM_PROJECT_ROOT` mount (`docker-compose.yml`, server `volumes`), `postJson` exported
   from `JiraBoardSheet.tsx:82`, `fetchJiraPrompt(key, action, repo)` (`client/src/lib/jira.ts:837`), `dispatchJira(req: JiraDispatchRequest)` posts `req`
   verbatim (`:852`), `.claude/rules/security.md`'s glob `server/src/*.ts` covers `git-run.util.ts`, `.claude/rules/skills.md:23-24` holds "every command is
   an API call", CLAUDE.md:74 holds "API-only and writes no file", `listenLoopback` and `daysAgoDate`/`daysAgoStamp` exist in `test/helpers/`.
   Two factual gaps: the skills hint lives in `JiraSkillsGroup.tsx` (I-5), and `rev-parse --show-toplevel` returns a realpath (I-3).
4. **Interfaces.** Produced-before-consumed holds across T1→T2..T9 with one spelling/shape conflict: `JiraDispatchRequest` (I-6).
5. **Order.** No task consumes a later one. T11's post-merge steps (`plugin:sync`, `docker:sync`) are the right prerequisites for the live probe.
6. **Tests.** Each task's suite is written first and would fail on the missing module/route/field. Review Focus 1–5 each have a named test (T2, T2+T3, T3,
   T1+T7, T5+T9). Two test cases as written would not exercise what they claim (I-1 lock case; I-3 toplevel compare under macOS tmp dirs).
7. **Own conventions.** "Behaviour, never literal code" is kept throughout — signatures, tables and case lists only. The ≤ 600 block budget is stated as a
   test, not a rule to drop. 160-column wrap kept.

## Findings

### Critical

- **C-1 — plan:157-158 — a `diverged` verdict after `worktree add` leaves the created tree in place, but exit 4 is specified as "Nothing was changed".**
  Spec §6 (spec:300): "`4`, a new code: git refused, or a 5.4 re-check stopped the Run. **Nothing was changed**". The plan's own T10 row (plan:465) repeats
  it: `4 — git refused, or a re-check stopped the Run; nothing changed`. Yet T2 step 7 says "diverged → exit 4 … (on a created tree the tree is left in
  place, the message says so)" — a `continue` on a local branch that has diverged from `origin/<branch>` first gets a worktree (`attached`, step 6), then
  exits 4 with that tree registered. The next Start then hits step 5's "`<path>` already exists (holds …)" or enters a tree the previous Run abandoned.
  → Compute ahead/behind for `continue` in step 4 (right after the fetch, with `rev-list --left-right --count <branch>...origin/<branch>`, no tree needed)
  and refuse diverged there, before any `worktree add`; keep step 7's divergence check only for the `entered` path, where the tree pre-existed and
  "nothing was changed" is true. Delete the parenthetical.

### Important

- **I-1 — plan:182 — the lock test cannot fail the fetch as written.** Verified on this machine: a clone whose `origin/main` is already up to date fetches
  with exit 0 even with `.git/refs/remotes/origin/main.lock` present (git takes no ref lock for an unchanged ref); only when `origin` is ahead does it print
  `error: cannot lock ref 'refs/remotes/origin/main': Unable to create '…/main.lock': File exists.` The case as listed never produces the `fetch failed:`
  note, so the retry path is untested and the implementer debugs a green-for-the-wrong-reason fixture. → State that the fixture advances `origin/main` one
  commit beyond the clone's `origin/main` before placing the lock file, and that the expected note names `cannot lock ref`.
- **I-2 — plan:204-206, 155-157 — the server's `sync` and the tool's fast-forward disagree on what a branch is compared with.** T3: `sync` is set "only when
  … the local branch's upstream is `origin/<name>` (read from `%(upstream:track)`)". T2 step 6 creates every `new` branch with `--no-track` (and the T2
  test at plan:169-170 asserts "branch has no upstream"), while T2 step 7 compares "the branch with `origin/<branch>` when that exists" by name. So every
  branch this feature creates, once pushed, shows `sync: null` on the board for ever (a plain `git push` sets no upstream), and the sheet's
  "behind/diverged marker" (plan:400) never fires for it — while the tool will happily fast-forward it. Spec §5.2 (spec:142-143) wants "a local branch and
  its `origin/` twin are one entry, carrying whether the local copy is behind, ahead or diverged", with no upstream condition. → Define `sync` by name:
  when both `<name>` and `origin/<name>` exist, `rev-list --left-right --count` (or `%(objectname)` equality for `same`, then one `rev-list` per differing
  ticket branch), and drop the upstream condition; the T3 test "local 1 behind, upstream set" should then also cover a branch with NO upstream.
- **I-3 — plan:143, 222, 229 — `rev-parse --show-toplevel` is compared to the given path by string, but git prints the realpath.** Verified:
  `mktemp -d` gives `/var/folders/…/tmp.X`, `git rev-parse --show-toplevel` answers `/private/var/folders/…/tmp.X`. Every T3 fixture (jest `tmp-root`
  under `os.tmpdir()`) and every T2 fixture (`scripts/test-tmpdir.mjs` under `os.tmpdir()`, not realpath'd) would be judged `not a git repository` /
  `<repo> is not a git repository` on macOS, and so would any mapped path that passes through a symlink. → Compare realpaths on both sides
  (`fs.realpath` of the given path against the printed one), and say so in both tasks; or use `rev-parse --show-cdup` answering `''` from inside the path.
- **I-4 — plan:404 — defaults are said to recompute "when action or repo changes, not on every refs reload", but refs arrive AFTER the repo change.**
  `branchSheetDefaults(action, refs, …)` needs the chosen repo's refs to pick Continue on a ticket branch; at the moment the repo changes, refs for it are
  still loading (`null`), so a defaults computation triggered by the repo change alone always lands on `new` with `defaults?.base ?? ''`, and T8's own
  first case ("execute + a ticket branch → Continue pre-selected") cannot pass. → State the rule as: recompute on action change, and once per repo when
  that repo's refs first arrive (keyed by the refs' `repo`), never on a later reload of the same repo.
- **I-5 — plan:418, 429-430 — the skills hint the plan amends is not in any file T9 modifies.** The placeholder hint is `JiraSkillsGroup.tsx` (`PLACEHOLDERS =
  ['{key}', '{url}', '{repo}']`, `client/src/components/jira/JiraSkillsGroup.tsx:14`, drawn by that card's hint), not `JiraReposGroup.tsx`. → Add
  `client/src/components/jira/JiraSkillsGroup.tsx` to T9's Modify list (the hint line and the three new placeholders in `PLACEHOLDERS`), and name which
  jsdom suite pins the hint's new text.
- **I-6 — plan:321, 395 — `JiraDispatchRequest` is used as both the wire body and the service input, with different shapes.** T6 makes
  `JiraDispatchRequest` gain `choice: JiraBranchChoice`, "built by the controller from the body's five flat fields"; T8 says the sheet "sends it as the five
  flat fields on Start". But the client's `dispatchJira(req: JiraDispatchRequest)` (`client/src/lib/jira.ts:852`) posts `req` verbatim, and the sheet builds
  that object literally (`JiraLaunchSheet.tsx:148-160`). Once the shared type carries `choice`, the client must either post `{ choice }` (which the
  controller would not read) or cast around the type. → Split the two: keep `JiraDispatchRequest` as the WIRE shape (add `mode`, `branch?`, `base?`,
  `openMr?`, `target?` to it, posted flat) and give the service its own input type (`JiraDispatchRequest & { choice: JiraBranchChoice }`, or a separate
  name) built by the controller. State which one `test/agents-dispatch-jira.test.ts` sends.
- **I-7 — plan:150-151 vs spec:214-216 — `entered` reuses a tree holding the branch, but T2 step 5 looks only at linked worktrees, while step 4's
  "mapped checkout" refusal is also a worktree match.** Fine as far as it goes; the ambiguity is `created: "entered"` for a tree whose checkout is DETACHED
  mid-rebase on that branch (`worktree list --porcelain` reports `detached`, so step 5 misses it, `worktree add` then fails with git's "already used by
  worktree at …" — `orchestrate.mjs:3861-3867` documents exactly this). The plan's step 6 "any `worktree add` failure → exit 4 with git's `fatal:` line"
  covers it by accident, but the message would say `fatal: '<branch>' is already used by worktree at '<path>'` rather than naming the tree as the spec's
  refusal does. → One sentence in step 6: a `worktree add` refusal matching `already (?:used by worktree|checked out) at '…'` is reported as "`<branch>` is
  held by `<path>` but not cleanly — fix that tree first", as the orchestrator words it; nothing else changes.

### Minor

- plan:127-128 — T2 says USAGE gains the command, but not that USAGE's footer line (`every command needs the backlog-manager API running …`,
  `jira.mjs:31`) and `apiDownMessage` (`:57`, "every jira.mjs command needs it") now overstate: `worktree` makes no request. Say both lines gain the
  `worktree` exception alongside SKILL.md (T10).
- plan:132, 166 — the names of `jira.mjs`'s own Table A/B copies are not given, although T2's tests call them. Name them (`branchNameProblem`,
  `branchCarriesKey`, same spelling as `shared/jira-branch.ts`) so the duplication pair T10 documents (plan:464) has two symbols to name.
- plan:204 — `committedAt` for a branch that is both local and remote: which side's commit date? Say "the newer of the two" (or the local one), since the
  sort and the Continue pre-selection depend on it.
- plan:241-242 — `test/compose-env.test.ts` pins every variable "through the server's own spellings" (`JIRA_ENV`; `.claude/rules/jira.md:31-32`). Say that
  `BM_REPO_ROOTS` is spelled once in `refs.util.ts` (or `env.util.ts`) as an exported constant and the compose test imports it.
- plan:262-264 — `.claude/rules/jira.md:19` fixes the config-write handler order as guard → validate (400) → configured (503) → write. T4 lists the 400s and
  the 409 but not the 503 for an unconfigured server; add it so the sixth route follows the same order as the five.
- plan:31 — "Every skill CLI ends `process.exitCode = await main(...)`" — the rule's form (CLAUDE.md, `.claude/rules/skills.md:50-57`) is the synchronous
  one, with `jira.mjs` among the three allowed to `await`. Word it as "`jira.mjs` keeps `process.exitCode = await main(…)`".
- plan:217-218 — `/refs`'s `<repo> is not mapped` is a different sentence from `/prompt`'s `<repo> is not mapped to <PROJECT>` for the same condition. Fine
  (no project is implied by a path), but say it is deliberate so a reviewer does not "fix" it.
- plan:303 — the T5 case asserts the command line contains `--repo '/r'`; also assert the block holds `--base develop` only for `new` and no `--base` for
  `continue` is listed at plan:305 — fine; add that under `continue` the block names no base line at all (spec:203 "the base" is new-only).
- plan:367-368 — `fetchAgeLine`'s thresholds (`< 60 min`, `< 48 h`) are the plan's own; the spec says only "`<age>`". Mark them *my call* like the others.
- plan:477 — the live-probe command `git -C ~/Documents/timify-projects/microservice branch --show-current` assumes the mapped checkout's path; say "the
  mapped path" so the step survives a different mapping.
