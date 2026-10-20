# Review 1 — `2026-10-20-jira-repo-branch-design.md`

**Verdict: REVISE.** No Critical finding. Eleven Important ones: three stated facts are false or contradicted inside the document (the worktree directory,
the skill-prompt cap, "never from a client-sent string"), §6 misses one CLAUDE.md headline the new `jira.mjs worktree` command breaks, and the tool's own
refusal set, the fresh worktree's dependencies, concurrent Starts in one repo, the unmounted/non-repo path, the slug rule and the shared-code location each
leave the implementer guessing. Every other stated fact about the code checked out; the list of what was verified is at the end.

Reviewer: Fable 5.1, fresh session, paths and checklist only. Code read through `codegraph_explore` and narrow greps; nothing in the document was taken
on trust.

## Important

### I1 — `.claude/worktrees/` (line 130) contradicts `.worktrees/` (line 191)

Line 130: "worktrees made by hand outside `.claude/worktrees/`". Line 191: the worktree location is "`<mapped repo>/.worktrees/<branch…>`, the
orchestrator's directory". Two different directories are named as *the* directory. The orchestrator's is `.worktrees/`
(`skills/backlog-orchestrate/tools/orchestrate.mjs:4064`, `WORKTREE_EXCLUDES` at `:3945`); `.claude/worktrees/` is where Claude Code's `EnterWorktree`
puts its own (`~/Documents/timify-projects/microservice/.claude/worktrees/peaceful-haibt-5f63c7`, detached HEAD, exists today). Line 192 even says the
probe may move the location, so line 130 is pre-empting §4's open question.
→ Pick one spelling in 5.2 and 5.4, or make 5.2 say "outside the directory 5.4 chooses". If the probe lands on `.claude/worktrees/`, note that the
orchestrator's `info/exclude` line (`.worktrees/`) does not cover it and a second exclude line is needed.

### I2 — line 188: "the description-trimming already in place absorbs it" is false for skills

`composeJiraPrompt` trims only a built-in's description (`server/src/jira/prompt.util.ts:122-146`). A skill's prompt is the filled template, and over
`JIRA_PROMPT_MAX` it is `prompt too long` with no trimming (`prompt.util.ts:118-121`). The workspace block added to a skill prompt is therefore absorbed
by nothing. In practice the risk is small — a skill template is capped at 2 000 characters (`.claude/rules/jira.md`, "a prompt of at most 2 000") and the
cap is 4 000 — but the sentence states a mechanism that does not exist on that path.
→ Say: built-ins absorb the block through the description trim; a skill's prompt is refused as `prompt too long` when the block pushes it over, and the
block's size is bounded (state the bound, or that `{worktree}` is the only free-length field in it).

### I3 — line 241 "never from a client-sent string" vs. line 147's editable Name, and no validation rule for `branch`

Line 147 makes the new branch's name an editable text field; line 164 sends `branch` and `base` to both routes; line 241 says the workspace block is composed
"from validated fields, and never from a client-sent string". The branch name IS a client-sent string that lands verbatim in the prompt and in the `jira.mjs
worktree` command line the session runs, and 5.3's only stated check on it is "carries the key". 5.1 validates the *default base* with
`git check-ref-format --branch` (precedent: `server/src/items/base-branch.util.ts:46`), but nothing says the per-Start `branch` and `base` get the same
check — and 5.3 says the server re-checks "when it can read the repo", which a string check does not need.
→ State that both routes validate `branch` and `base` with `check-ref-format --branch` semantics unconditionally (mount or no mount), bound their length,
and that the key-containment check runs on the validated string; then line 241 is true. Note that `check-ref-format` still admits `` ` ``, `$`, `;`, `(`,
`)`, `|` — say whether those are refused too, since the string becomes a shell line the session runs and a command the person copies (5.5).

### I4 — §6 misses the exit-`5` headline, and the new command's exit codes are unstated

CLAUDE.md: "**`backlog.mjs` in a tracker project — and `jira.mjs` always — needs the stack up, and says so with exit `5`.**" The mechanism text
(`.claude/rules/skills.md`: "`jira.mjs` has no files mode at all: every command is an API call … its other codes are `2` (a 4xx) and `3` (a 5xx)") and
the test string (`skills/jira/tools/jira.test.mjs:212`: "every jira.mjs command needs it") all become false the moment `worktree` runs git and no API.
§6 (lines 229-231) changes the "API-only and writes no file" headline but not this one. Line 172 says the tool "exits non-zero with git's sentence" with
no code, while the CLI has a fixed code vocabulary (`jira.mjs:14,68`).
→ Add the exit-`5` headline to §6 (the `worktree` command is the one that needs no stack), and give `worktree` its exit code(s) — e.g. a new `4` for a git
failure, distinct from `2`/`3`/`5` — so the test's "every command" sentence and the SKILL.md exit-code table can follow.

### I5 — 5.4 lists no refusal for the two 5.3 refusals when the server could not check them

5.3 (lines 154-158) has the sheet refuse (a) a new name that already exists and (b) a branch held by the mapped checkout, "with the server re-checking each
on Start **when it can read the repo**". Lines 82-84 say an unmounted repo still lets the person type both, "and the session finds out". But 5.4's step 2
(lines 175-181) has no branch for either case: `new` on an existing name would run `worktree add -b` and fail with git's sentence (acceptable), while
`continue` on the branch the main checkout holds is exactly anti-goal line 62 and the tool is the last guard. The existing microservice checkout is on
`feature/timify-26090-…` right now, so this is the first case a real second Start hits.
→ Add to step 2: `continue` and the branch is checked out in the mapped checkout → stop, name the tree, change nothing; `new` and the name exists locally
or on `origin` after the fetch → stop and say Continue is the mode to use. Both after step 1, since the fetch is what makes the check honest.

### I6 — a fresh worktree has no dependencies, and the spec is silent

`execute` tells the session to "verify the change with the repository's own tests" (`prompt.util.ts:53`). A new worktree holds only tracked files; the
orchestrator solves this by symlinking `node_modules` from the main tree and excluding it bare (`skills/backlog-orchestrate/SKILL.md:541-544`,
`orchestrate.mjs:3943-3945`). Line 93 quotes the orchestrator's exclude step as "`.worktrees/`" only, dropping `node_modules`, and 5.4 never says whether
`jira.mjs worktree` symlinks, installs, or leaves it to the session. For a Timify microservice worktree that decides whether verification can run at all.
→ State what the tool does about dependencies (symlink the main tree's `node_modules` like the orchestrator, or tell the session to install), and add
`node_modules` to line 93's list so the borrowed mechanism is described whole.

### I7 — two Starts in one repo race on `git fetch` and `info/exclude`

Line 21 makes "two tickets can run in one repo at the same time" a success criterion, and the orchestrator — the stated precedent — never runs two
worktree creations concurrently (one item at a time). Two sessions running `jira.mjs worktree` in the same repo at once both `git fetch origin` (git can
refuse the second with a ref-lock error) and both append to `info/exclude` (`ensureExcludeLines`, `orchestrate.mjs:4029-4043`, read-then-append, not
atomic). Line 185 "the session stops and reports" turns a race into a stopped Run.
→ Say so: either the tool retries a locked fetch once, or the stop is accepted and the prompt tells the session to re-run `jira.mjs worktree` once on a
fetch lock. Say the exclude append tolerates a duplicate line (it does — whole-line check — but only if the two reads do not interleave).

### I8 — "`<path>` is not mounted into the board" asserts a cause the server cannot know

Lines 82-86: an unreadable mapped path shows "branches unavailable — `<path>` is not mounted into the board", and "a host-run API sees every path, so it
never shows the warning". Inside the container an unmounted path and a mistyped path look identical (ENOENT); on the host a mistyped path, a deleted
checkout or a directory that is not a git repository all exist as cases the sentence does not fit and the spec does not name. Line 249 leaves "how Setup
learns which roots are mounted" to the builder, but the copy is fixed here.
→ Split the degraded state: "not mounted" only when the path is outside every configured root (the server knows the roots from env), otherwise
"branches unavailable — `<path>` is not a git repository" / "does not exist". State what the host-run API shows for the last two.

### I9 — the slug rule is "about 40 characters", and an empty slug is unhandled

Line 146: "cut at a word boundary to about 40 characters". A test case (line 254, "pattern rendering") needs an exact value. A summary that is all
non-alphanumerics (or non-Latin script, which the rule collapses to nothing) yields an empty slug and a name ending in `-`, which `check-ref-format`
accepts but which is a name nobody wants.
→ Give the exact rule: at most 40 characters, cut at the last `-` at or before 40, no leading or trailing `-`; when the slug is empty, the name is the
pattern with `-{slug}` dropped (or the field left for the person to fill — pick one).

### I10 — the shared worktree code must live on a published path

Lines 97-98: `jira.mjs worktree` is "built on the same worktree code as `orchestrate.mjs`, shared rather than copied. Where the shared code lives is the
builder's call." The installed plugin is a copy of `PUBLISHED_PATHS = ['skills', '.claude-plugin', 'agents']` (`scripts/sync-plugin.mjs:44`) and the
marketplace's `sparsePaths`; a module anywhere else is absent from the install and `jira.mjs` fails on import after `plugin:sync`. Today
`orchestrate.mjs` reaches `backlog.mjs` by a relative path inside `skills/` (`orchestrate.mjs:3947`). Also, `cmdWorktree` as it stands is bound to a run
file (`readRun`, `assertDriver`, `findQueueItem`, `orchestrate.mjs:4049-4051`) and to `backlog/<id>` naming (`probeLeftover`, `:3964`), so "shared" means
extracting the git half (probe, add, exclude) first.
→ Constrain the builder's call: the shared module lives under `skills/` (and `jira.mjs` imports it relatively), and name the extraction — the probe +
`worktree add` + `ensureExcludeLines` half, with the run-file and item-id halves staying in `orchestrate.mjs`.

### I11 — `continue` into a worktree that already holds the branch skips the fast-forward rule

Step 2 (lines 178-181) fast-forwards a local branch that is strictly behind, but the fourth bullet — "a worktree already holds the branch: enter that
worktree" — says nothing about that worktree being behind, which is the common case for a hand-made sibling like `microservice-21969`. A fast-forward of a
checked-out branch has to happen inside that worktree and needs a clean tree.
→ Say whether the tool fast-forwards inside the existing worktree (and stops on a dirty tree) or enters it as-is and tells the session the branch is
behind. The sheet's "behind/diverged" reading (line 142) should match whichever is chosen.

## Minor

- Line 94: the command also prints `{ verdict: 'park', … }` on the item-probe path (`orchestrate.mjs:4086`); the Jira tool has no item to probe, so this
  is fine, but "prints `{ worktree, branch, created }`" is the happy path only.
- Line 112: the base's last fallback, "the checkout's current branch", is a feature branch in the mapped microservice checkout today. The sheet pre-selects
  it visibly, so anti-goal line 64 holds, but say the select labels which fallback rung supplied the value.
- Line 126: `origin/HEAD` is a symbolic ref that `for-each-ref refs/remotes/origin` lists; say it is excluded from the picker and the matcher.
- Line 141: the picker lists "every other local and `origin/*` branch" with no ceiling; a long-lived repo has hundreds. Caching is the builder's call
  (line 134); a cap or a search field is not mentioned anywhere.
- Line 147: the preview is re-fetched on every change of its inputs (`JiraLaunchSheet.tsx:91`, `useFetched`); with `branch` as an input, each keystroke in
  Name is a `GET /api/jira/prompt`. Debounce or fetch on blur.
- Line 161: the live map prevents two *board-started* Runs; a Copy-prompt session is invisible to it. Line 206 says this for Remove; say it here too.
- Line 202: the live map is memory only (`live.service.ts:21-22`); after a server restart Remove re-enables while the session may still run. Covered in
  spirit by line 206's "the person running it is the check", but the disabled state should not read as a guarantee.
- Line 188: `JiraSkillsGroup.tsx:14` hard-codes `PLACEHOLDERS = ['{key}', '{url}', '{repo}']` for the Setup hint; name it as a place the three new ones
  must be added, beside `PLACEHOLDER_RE` (`prompt.util.ts:66`).
- Line 80: `test/compose-env.test.ts` pins the compose env spellings; the new root variable needs an entry there, whatever its name.
- Line 93 says the orchestrator keeps `.worktrees/` out of `git status` "never `.gitignore`"; correct, and the reason (`.gitignore` is tracked and would
  ride a merge) is worth one clause since the Jira repos are foreign and a stray tracked change there is worse than here.
- 5.6, line 220: "when that skill is installed" — say how the session tells (the skill listing it sees at start), so the GitLab branch has an observable
  trigger rather than a judgement, matching the orchestrate-rule convention in `.claude/rules/skills.md`.

## Verified as stated (no finding)

- Line 10: up to ten paths per project (`config.util.ts:263`, `JIRA_REPO_PATHS_MAX = 10`); the sheet auto-picks a single path and asks otherwise
  (`JiraLaunchSheet.tsx:77-81`).
- Line 12 / 187: `execute` says "create a branch for it" (`prompt.util.ts:53`).
- Line 48-49: PR mode is tracker-only and uses `gh pr create` (`skills/backlog-orchestrate/SKILL.md:271, 1146`); run branches are
  `backlog/run-<date>-<n>` (`orchestrate.mjs:2722`). The microservice remote is GitLab.
- Line 70: `spawnInProject` → `projectMap` (`agents.service.ts:527-539, 1426`); `projectDispatchGate` reads `status.projectPaths` (`shared/agent.ts:361`).
- Line 77-80: compose mounts `${BM_PROJECT_ROOT:-${HOME}/Documents/custom-projects}` read-only at the same path (`docker-compose.yml:175`); no SSH mount.
- Lines 88-94: `cmdWorktree` re-probes, cuts from `run.base`, reattaches, writes `info/exclude`, prints the JSON (`orchestrate.mjs:4045-4108`).
- Line 118-119: `SameOriginPostGuard` on every config write; unreadable file → `JiraConfigUnreadableError` → 409 (`jira-write.controller.ts:171-179`);
  `check-ref-format --branch` precedent at `base-branch.util.ts:46`.
- Line 130: `microservice-21969` is a registered worktree of `microservice` (`git worktree list`).
- Line 132: `runGit` is async, 10 s bound, failure as `null` (`server/src/git-run.util.ts:37, 70-91`).
- Line 161: `reserve` is the synchronous one-session-per-key gate (`live.service.ts:43-49`).
- Line 164-165: `/prompt` and `dispatch-jira` both normalise and check `repo` against the mapping (`jira.controller.ts:148-151`,
  `jira-dispatch.service.ts:75-78`).
- Line 188: `PLACEHOLDER_RE` is exactly `{key|url|repo}` (`prompt.util.ts:66`); `JIRA_PROMPT_MAX = 4000` (`:40`).
- Line 214-215: `COMMIT_RULE` ends "Do not push." (`shared/agent.ts:827-830`).
- Line 224: the orchestrator's §10 reports a pushed branch and the hand command on a failed `gh pr create` (`SKILL.md:1155-1156`).
- Line 229: CLAUDE.md:74-75 carries "is API-only and writes no file".
- Line 232: the quoted headline is byte-equal to CLAUDE.md's.
- Line 236: "Container mounts land on host paths, read-only" is CLAUDE.md's headline.
- Scope (checklist 5): the four non-goals are named and nothing in scope depends on them; the §4 probe is the one acknowledged open dependency.
