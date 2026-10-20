# Review 2 — `2026-10-20-jira-repo-branch-design.md`

**Verdict: REVISE.** No Critical finding. Round 1's eleven Important findings are all addressed, and nine of the eleven resolutions check out against the
code. Two of them introduced a new false fact each (the orchestrator's `node_modules` symlink, and `jira.mjs`'s exit vocabulary), and six further gaps
remain where an implementer has to guess: the default mode for `context`, the routes' field list against §5.6, the MR toggle on a skill prompt, key
containment on the server, the pattern's save-time check, and what `{worktree}` means when the tool enters a worktree the server did not name.

Reviewer: Fable 5.1, fresh session, paths and checklist only. Code read through `codegraph_explore` and narrow greps; nothing in the document — or in
round 1's report — was taken on trust. Round 1's findings that the document now resolves are not re-reported; the resolutions I checked are listed at
the end.

## Important

### I1 — line 97 and line 109: `orchestrate.mjs worktree` does not symlink `node_modules`, so there is nothing to extract

Line 97 lists, among what `orchestrate.mjs worktree <id>` does, "symlinks the main tree's `node_modules` into the new worktree"; line 109 moves "`git
worktree add` …, plus the `node_modules` symlink" into the shared module. `cmdWorktree` (`skills/backlog-orchestrate/tools/orchestrate.mjs:4045-4108`)
runs `worktree add`, the `backlog.mjs show` probe and `ensureExcludeLines`, and nothing else; no `ln -s` or `symlinkSync` exists anywhere under `skills/`
(grep, test files excluded). The exclude list's bare `node_modules` entry (`orchestrate.mjs:3945`, `SKILL.md:544`) is there because the *runner* is
expected to link the directory in (`references/rationale.md:394-396`), but no step in `SKILL.md` or the tool spells that out. Round 1's I6 is thus
resolved by a sentence that describes code that does not exist: the implementer either extracts nothing or writes the symlink fresh and calls it borrowed.
→ Say that `jira.mjs worktree` creates the symlink itself, as new code: `<worktree>/node_modules → <mapped repo>/node_modules` when the main tree has
one, silently skipped when it has none (a non-Node repo), never overwriting a real directory in the worktree. Correct line 97 to say the orchestrator's
command does not do this today.

### I2 — lines 282-285: `1` is already `jira.mjs`'s usage code, and `2` is a 4xx, not "a usage error"

The spec gives `worktree` exit `1` for "git refused, or a 5.4 re-check stopped the Run" and `2` for "a usage error, like the other commands". In
`jira.mjs`, usage is `1` — `expectArgs` (`skills/jira/tools/jira.mjs:173`), a bad key (`:142`), an unknown command (`:301`), a `--flag` (`:305`) — and
the skill's table documents `1` as "Usage … Nothing was sent" (`skills/jira/SKILL.md:71`); `2` is "The server refused the request (a 4xx)"
(`SKILL.md:72`, `jira.mjs:114,118`; `.claude/rules/skills.md:25`). So line 284's stated fact is false, and line 283's `1` makes the table's one row mean
two things ("nothing was sent" and "git refused after a fetch").
→ Keep `1` for usage, as every other command has it, and give git refusals and the 5.4 re-check stops a code the table does not hold yet (for example
`4`), or state that the `1` row is rewritten. Strike "like the other commands" from the `2` line and say the `2` row stays a 4xx, which `worktree`
never exits.

### I3 — line 157 vs line 173: two defaults for `context` on a ticket that already has a branch

Line 157: Continue "is the default when the ticket has at least one branch in the chosen repo". Line 173: No branch "is the default for `context`". For
`context` on a ticket whose branch exists both sentences apply and they disagree; the rationale on line 173 (a branch for `context` is clutter) says
the second one is meant.
→ Qualify lines 157 and 172 with "for `execute` and for a skill", and say `context` defaults to No branch whether or not the ticket has a branch.

### I4 — line 187-189 vs lines 250-255: the routes gain five fields, not three

Line 188 says `GET /api/jira/prompt` and `POST /api/agents/dispatch-jira` "gain the same three fields: `mode`, `branch` and `base`". §5.6 then adds an
**Open MR when done** toggle and, for `continue`, a target branch "the sheet asks for" — both change the composed prompt (the commit rule's last
sentence, the MR target), and the prompt is composed server-side from validated fields (CLAUDE.md invariant; `jira.controller.ts:131-157` takes only
`key`, `action`, `repo` today; `JiraDispatchRequest`, `shared/types.ts:844`). §6's validation list (lines 287-291) names only `branch` and `base`, so the
target has no stated check even though it is pasted into a shell line the same way.
→ List the five fields on both routes (`mode`, `branch`, `base`, `openMr`, `target`), say `target` is accepted only with `openMr` + `continue` and refused
otherwise, and put it under the same `check-ref-format` / 200-character / charset rule as `base`.

### I5 — line 250 and line 254: a skill's prompt has no commit rule to replace

The toggle is "offered only with a branch and the `execute` action **or a skill**", and under On "the commit rule's last sentence is replaced". A skill's
prompt is "its template and the ticket's key, nothing else" (`server/src/jira/prompt.util.ts:6-11`, `:118-120`); `COMMIT_RULE` is appended to the
`execute` instruction alone (`prompt.util.ts:57`). For a skill there is no sentence to replace under On and nothing to "keep" under Off (line 253).
→ Say what a skill prompt carries under each state — the natural home is the workspace block of §5.4: under On it gains one sentence ("when done, push
`<branch>` and open a merge request into `<target>`"), under Off it says nothing — or restrict the toggle to `execute`.

### I6 — line 162 vs line 291: key containment is checked on the sheet only, and nothing on the server or in the tool enforces it

Line 162: a Name "that no longer carries the key (5.2's rule) is refused" — on the sheet. Line 291: the editable Name "is accepted only after these
checks", and "these" (lines 287-289) are `check-ref-format`, length and charset; the key is not among them. A Copy-prompt caller, a hand-built request
or a client bug can send `mode: new, branch: feature/export` and the server composes it, the tool cuts it, and 5.2 never finds it again — which is the
success criterion on line 22 and the anti-goal on line 63 ("a branch link … that drifts from git"). Round 1's I3 asked for the key check to run "on the
validated string"; the document moved the string checks to §6 and left the key check on the sheet.
→ Add to §6: under `new`, both routes refuse (400) a `branch` that fails 5.2's matcher for `key`; say whether `jira.mjs worktree` re-checks it (it has
the key in its arguments) or trusts the server.

### I7 — line 130: the pattern's save-time check does not guarantee what it claims

The only refusal is "a pattern without `{key}` or `{KEY}`", stated to be "because 5.2 would never find its branches again". A pattern that contains the
placeholder but glues a letter or digit to it — `x{key}-{slug}`, `{key}1-{slug}` — renders `xtimify-123-…` / `timify-1231-…`, which 5.2 rejects by its own
examples (lines 141-142), so every Start on that repo hits line 162's refusal and the person's only way out is to hand-edit the name each time. The same
holds for a literal character outside line 289's `[A-Za-z0-9._/-]` (`{key}@{slug}`) or a leading `-` or `/`, which `check-ref-format --branch` refuses.
→ Validate the pattern at save time by rendering it with a sample key and slug and running the Start-time checks on the result (5.2 match, §6's
charset and `check-ref-format`), refusing with the failing check's sentence. Also state what an empty slug does to a pattern that *starts* with `{slug}`
(see Minor below).

### I8 — lines 193, 223 and 232: `{worktree}` and the block's path are composed from the branch, but the tool may enter a different path

The server composes the workspace block, "the worktree path" included, and fills `{worktree}` (line 223) — necessarily from the rule on line 230,
`<mapped repo>/.worktrees/<branch with / → ->`, because that is all it has when the repo is not mounted (§4). But `continue` "enters that worktree" when
one already holds the branch (line 204), "an existing worktree found by 5.2 is used where it is" (line 232), and the hand-made sibling
`microservice-21969` lives *beside* the repo. The prompt then names one path and the tool prints another; a skill template using `{worktree}` literally
(`cd {worktree} && …`) runs in a directory that may not exist. Line 103 ("the session then works inside the printed path") covers the built-ins' prose
but not a placeholder a skill author pasted.
→ Define `{worktree}` and the block's path as the *expected* path: the existing worktree's path when the server could read the repo and found one, else
the derived one; say the tool's printed path is authoritative and that the block tells the session so; and tell skill authors (the Setup hint) that
`{worktree}` is the expected path, not a promise.

## Minor

- Line 170: with the empty-slug rule, a pattern that begins with `{slug}` (`{slug}-{key}`) has no separator "in front of" `{slug}` and renders
  `-timify-123`, which `check-ref-format --branch` refuses (leading `-`). Say the separator on *either* side goes, or refuse such patterns at save (I7).
- Line 230: `feature/x` and `feature-x` map to the same directory under "`/` replaced by `-`". Rare, but the leftover probe would then refuse the
  second one with a confusing sentence; say so, or keep `/` as a path separator (git accepts nested worktree paths).
- Line 280: "`jira.mjs` always needs the stack up, and says so with exit `5`" is introduced as "a CLAUDE.md headline"; the headline is "`backlog.mjs` in
  a tracker project — and `jira.mjs` always — needs the stack up, and says so with exit `5`." (`CLAUDE.md:123`, byte-equal in `.claude/rules/skills.md:19`,
  guarded by `test/claude-rules.test.ts`). Quote it whole so the plan edits the right string.
- Line 135 / §6 line 279: the new defaults route makes a sixth `jira.json` writer; `.claude/rules/jira.md:13` ("The five writers are … and by nothing
  else"), `config.util.ts:224` and `CLAUDE.md:44` ("five guarded write routes") all count to five. Name them as places the plan touches.
- Line 146: `microservice-21969` is a hand-made worktree on `hotfix-release-10` (`git worktree list` today), not on a ticket branch; the sentence reads as
  though 5.2 would find it for a ticket. Fine as an example of "a worktree outside `.worktrees/`", but say that.
- Line 118: the §4 probe is partly answered by the tool's own contract. `EnterWorktree` takes `path` to "switch the session into a worktree that already
  exists"; on first entry from the launch directory the path only has to appear in `git worktree list` for the repo, which `.worktrees/<…>` and a
  sibling both do; a *second* switch, or an agent whose cwd was pinned at launch, is limited to `.claude/worktrees/` of the same repo; and `ExitWorktree`
  never removes a worktree entered by `path`, which matches "the worktree stays". Worth recording in the plan before the spike.
- Line 154: `FETCH_HEAD` is per-worktree. The age shown is the mapped checkout's own; a fetch someone ran inside `microservice-21969` does not move it,
  and the tool's fetch from the mapped root (line 194) does. Say "the mapped checkout's last fetch".
- Line 58 vs lines 105-114: "Any change to … the orchestrator" is a non-goal while §4 extracts three functions out of `orchestrate.mjs`. Line 114 makes
  the intent clear ("behaviour must not change"); say "any behaviour change to the orchestrator" on line 58.
- Line 162: the preview is re-fetched on every change of its inputs (`JiraLaunchSheet.tsx:91`, `useFetched`); with `branch` as an input each keystroke in
  Name is a `GET /api/jira/prompt`. Still unaddressed from round 1; debounce or fetch on blur.
- Line 223: `JiraSkillsGroup.tsx:14` hard-codes `PLACEHOLDERS = ['{key}', '{url}', '{repo}']` for the Setup hint, beside `PLACEHOLDER_RE`
  (`prompt.util.ts:66`); still unnamed as a place the three new ones go.
- Line 80: `test/compose-env.test.ts` pins the compose env spellings (`:119-133`); the new root variable needs an entry, whatever its name.
- Line 241: the live map is memory only (`live.service.ts`); after a server restart Remove re-enables while the session may still run. Line 245 covers
  it in spirit, but the disabled state should not read as a guarantee.
- Line 259: "when that skill is installed" still has no observable trigger (the skill listing the session sees at start).

## Round-1 resolutions checked (no finding)

- I1: `.worktrees/` is now the one directory (lines 146, 230); `.claude/worktrees/` is no longer named.
- I2: line 225-228 states the built-in trim and the skill `prompt too long` path correctly (`prompt.util.ts:118-121`, `:122-146`) and asks for a stated
  block budget.
- I3: lines 287-291 validate `branch` and `base` unconditionally with a charset tighter than `check-ref-format` — but see I6 for the key check.
- I4: the exit-`5` headline is in §6 (line 280) — but see I2 for the codes.
- I5: lines 208-211 add both re-checks after the fetch.
- I6: lines 97/109 add dependencies — but see I1.
- I7: lines 217-219 give the fetch retry and the exclude race.
- I8: lines 82-90 split the degraded state into three ordered reasons with one copy string.
- I9: lines 164-170 give an exact slug rule and the empty-slug case — but see the first Minor.
- I10: lines 105-114 constrain the module to `skills/`, relative import, and name the extraction (`PUBLISHED_PATHS`, `scripts/sync-plugin.mjs:44`).
- I11: lines 204-206 give the existing-worktree fast-forward rule.

## Verified as stated (no finding)

- Line 12: `execute` says "create a branch for it" (`prompt.util.ts:53`).
- Line 36 / 93-99 otherwise: `cmdWorktree` re-probes, cuts from `run.base`, reattaches, writes `info/exclude` whole-line, prints `{ worktree, branch,
  created }` (`orchestrate.mjs:4055-4106`); `WORKTREE_EXCLUDES = ['.worktrees/', 'node_modules']` (`:3945`).
- Line 101: `git -C`, `--cwd`, `( cd <worktree> && … )` (`skills/backlog-orchestrate/SKILL.md:68-74`).
- Line 105: `cmdWorktree` reads the run file (`readRun`, `assertDriver`, `findQueueItem`, `:4049-4051`) and names `backlog/<id>` (`:3964`, `:4053`).
- Line 112-113: `PUBLISHED_PATHS = ['skills', '.claude-plugin', 'agents']` (`scripts/sync-plugin.mjs:44`).
- Line 116-117: the executor is `cd "$PWD/.worktrees/<id>" && … exec claude -p …` (`SKILL.md:577`).
- Line 133: `repos` is a top-level map of project key → paths (`config.util.ts:151-173`, `:504-510`); paths are normalised by `normaliseRepoPath`
  (`:347-362`), which is the "normalised path" a `repoDefaults` key can use.
- Line 135: `check-ref-format --branch` precedent (`base-branch.util.ts:46`); same-origin guard and 409-on-unreadable (`.claude/rules/jira.md:17-19`).
- Line 148: `runGit` async, bounded (`git-run.util.ts`); invariant anchor exists (`invariants.md:3931`).
- Line 183: one session per key, `reserve` (`.claude/rules/jira.md:77-78`).
- Line 187-189: both routes normalise and check `repo` (`jira.controller.ts:148-151`, `jira-dispatch.service.ts:75-78`).
- Line 223: `PLACEHOLDER_RE` is `{key|url|repo}` (`prompt.util.ts:66`); `JIRA_PROMPT_MAX = 4000` (`:40`).
- Line 253: `COMMIT_RULE` ends "Do not push." (`shared/agent.ts:827-830`).
- Line 259: `mr-review-loop` is a GitLab-only skill installed on this machine (`timify-experimental:mr-review-loop`).
- Line 263: the orchestrator reports a pushed branch and the hand command on a failed `gh pr create` (`SKILL.md:1155-1156`).
- Lines 268, 271, 275, 286: the quoted CLAUDE.md headlines exist (`CLAUDE.md:74`, the orchestrate rule, "Container mounts", "composed server-side"
  with its anchor at `invariants.md:1325`); anchors on lines 54 and 149 resolve (`invariants.md:3183`, `:3931`); `docs/subsystems/jira.md#run-phase-5a`
  resolves (`jira.md:324`).
- Line 23: the microservice repo's convention is `feature/timify-<n>-<slug>` (local branches `feature/timify-26090-…`, `feature/timify-26150-…`); its
  remote is GitLab.
- Line 146: `microservice-21969` is a registered worktree of `microservice` (`git worktree list`).
- Scope (checklist 5): the non-goals are named; nothing in scope depends on them; the §4 probe remains the one acknowledged open dependency.
