---
id: task-35
title: Path-scoped .claude/rules pointers into the invariant rationale
created: 2026-09-13
from: idea-11
---

## Goal

Put the invariant rationale one *zero* hops away from the session about to break a
rule, without adding a second copy of the prose and without raising any session's
context floor.

CLAUDE.md is a normative index: each invariant is the rule plus a `Why:` anchor into
`docs/subsystems/invariants.md`. A headless `backlog-execute` session or the reviewer
agent follows that anchor only if it chooses to. `.claude/rules/*.md` with a `paths:`
frontmatter glob is the mechanism that removes the choice: matching rules are injected
the moment the session touches a file under the glob.

Two things are load-bearing and are what the probe phase exists to nail down, because
building on the assumption would ship pointers that silently do nothing for the exact
sessions they are for:

- **A rule with no `paths:` is loaded at launch, in every session** — that is a context
  floor increase for all of them, which is the thing this task must not cause. Every
  file this task writes carries `paths:`, and a test pins that.
- **This repo's consumers are `claude -p` sessions in a linked worktree, and custom
  subagents.** The docs state path-scoped loading for interactive sessions and say
  nothing about either of those.

Grooming already ran the first probe case; see "Proven already" below. The remaining
cases decide scope, and one of them can still end this task with zero rule files and a
recorded negative — that is a real outcome, not a failure.

## Plan

### Proven already (2026-09-13, groom session, Claude Code 2.1.268)

The harness below is not a proposal — it was run, and its output is quoted. Re-run it
as written; treat any disagreement with these lines as a finding, not as a mistake to
correct silently.

The mechanism that makes every probe deterministic is the **`InstructionsLoaded` hook**,
not a session's self-report. It fires when a CLAUDE.md or `.claude/rules/*.md` file is
loaded and receives on stdin a JSON object with `session_id`, `load_reason` and
`file_path`. `load_reason` is one of `session_start`, `nested_traversal`,
`path_glob_match`, `include`, `compact`. The probe reads `path_glob_match` off the log;
it never asks a model whether it "felt" instructed.

Harness, in a throwaway directory outside this repo (`mktemp -d`), never in it:

1. A git-init'd probe project containing: a `CLAUDE.md`; `.claude/rules/control.md`
   with **no** frontmatter; `.claude/rules/scoped.md` with
   `paths: ["src/**/*.ts"]`; and `src/target.ts`.
2. `hook.sh`, executable, appending stdin to an absolute `loaded.jsonl` path.
   Do not use `$CLAUDE_PROJECT_DIR` inside it — hardcode the absolute path.
3. `probe-settings.json` registering `hook.sh` on `InstructionsLoaded` with no matcher
   (all load reasons).
4. The session, from the probe dir:

   `claude -p "Read src/target.ts, then reply with the single word DONE." --settings <abs>/probe-settings.json --allowedTools Read --permission-mode acceptEdits --output-format json < /dev/null`

   `< /dev/null` matters: without it the CLI waits 3s for stdin and warns. There is no
   `--max-turns` in this CLI build; bound cost with the narrow `--allowedTools` instead,
   and read `total_cost_usd` out of the `--output-format json` result.

Do not wait on the session to exit. In the groom run the rules had all loaded within
seconds while the session itself was still going at 8 minutes and had to be killed by its
recorded pid. The hook log is the evidence and it is complete long before the transcript
is; `--output-format json` is for the cost figure, not for the verdict.

**P1 — headless `claude -p`, plain checkout: PATH-SCOPED RULES LOAD.** Observed
`loaded.jsonl`, one line per load, all under one `session_id`:

```
session_start    <probe>/.claude/rules/control.md
session_start    <probe>/CLAUDE.md
session_start    ~/.claude/CLAUDE.md
path_glob_match  <probe>/.claude/rules/scoped.md
```

The `control.md` line is the **positive control** and every later case keeps one: it is
what separates "the rule did not load" from "the hook never ran". An empty or
control-less log is an inconclusive probe, never a negative result.

Also established, so no case needs to re-derive it: the dispatch path this repo uses is
`claude -p --session-id <id> --permission-mode <mode>` plus optional `--model`/`--effort`
(`claude-agents-dashboard/server/lib/spawn.ts` ~line 219). It passes no
`--setting-sources`, so project scope — and therefore `.claude/rules/` — is loaded.

### Phase 1 — finish the probe matrix

Four cases remain. Each reuses the P1 harness, each keeps the unscoped control file, and
each records its raw `load_reason | file_path` lines. Run them one at a time.

- **P2 — custom subagent.** The reviewer agent (`agents/backlog-reviewer.md`) is a
  subagent, and subagent startup documents CLAUDE.md but says nothing about path-scoped
  rules. Define a probe agent (`--agents` JSON is enough; no file needed), give the
  parent `--allowedTools "Read Task"`, and have the parent dispatch it with the
  instruction to Read `src/target.ts` — the *subagent* must be the one reading.
  Question: does a `path_glob_match` line appear, and under which `session_id` — the
  parent's or a distinct one? Record both the verdict and the id relationship.
- **P3 — linked worktree.** The case that decides this task. From the probe repo:
  `git worktree add .worktrees/probe -b probe main` (the same literal
  `backlog-orchestrate` SKILL.md §4 uses), then run P1's session with the worktree as
  cwd. Question: does a glob written relative to the project root still match when the
  project root is a linked worktree?
- **P4 — trigger surface beyond Read.** The docs say rules "trigger when Claude reads
  files matching the pattern, not on every tool use". Check `Edit` and `Grep`/`Glob`
  separately: a session that greps `server/src/agents/` and edits one file without a
  standalone Read is an ordinary execute session, and if no rule fires for it the
  pointers cover less than they appear to.
- **P5 — source read through `codegraph_explore`.** Repo-specific and easy to miss:
  CLAUDE.md tells sessions to reach for CodeGraph *before* Read, and codegraph returns
  verbatim source without the Read tool ever touching the path. If that route fires no
  rule, the pointers miss exactly the sessions that follow this repo's own guidance —
  which is a finding worth recording either way. Run it in this repo rather than the
  probe dir (codegraph is indexed here), with the probe settings file still supplied by
  `--settings`; add no hook to this repo's own settings.

If a probe cannot be run at all — e.g. the auto-mode classifier denies the nested
`claude -p` — stop and report that. An unrun probe is not a negative result, and
recording it as one would bury the mechanism for good.

### Phase 2 — the gate

- **P3 positive** → do Phase 3. That is the executor's own path, and it is sufficient on
  its own: P2 negative only means the reviewer keeps using CLAUDE.md, which subagents do
  load, so nothing regresses.
- **P3 negative** → write no rule files. Record all five verdicts as Phase 4 describes
  and finish. The task is done; the mechanism was measured and declined.

### Phase 3 — the pointer files (only if the gate opens)

Four files under `.claude/rules/`. Each is **pointers only** — no restated rule text, no
summary of the reasoning. `docs/subsystems/invariants.md` keeps the single copy, which is
what stops a second place from drifting; `backlog-execute`'s contract sweep needs no
change because a pointer states no contract.

Shape, every file: `paths:` frontmatter, a one-line heading, then one line per anchor of
the form `- Before changing files here, read docs/subsystems/invariants.md#<anchor>`.
Target 15 lines or fewer per file — soft, and the test's bound is the hard one.

| File | `paths:` | Anchors (`docs/subsystems/invariants.md#…`) |
|---|---|---|
| `orchestrator.md` | `skills/backlog-orchestrate/**`, `server/src/orchestrator/**`, `shared/agent.ts` | `the-orchestrators-run-file-has-exactly-one-writer-one-reader--the-same-relationship-the-registry-has`, `a-runs-sidecars-are-archived-beside-its-run-file-task-31`, `orchestratemjs-is-always-invoked-from-the-project-root-never-from-inside-a-per-item-worktree`, `backlog-orchestrate-is-the-only-skill-that-commits-or-merges`, `merge-mode-is-run-scoped-and-a-malformed-one-is-a-400`, `question-mode-is-run-scoped-and-it-only-ever-takes-effect-in-a-headless-run`, `a-classifier-denial-degrades-the-run-every-other-merge-failure-parks`, `merged-is-not-the-only-success-exit--branched-is-its-branch-mode-sibling`, `a-runner-fix-item-is-hoisted-to-the-front-of-the-queue-and-the-marker-is-read-at-base`, `a-pause-request-is-a-file-the-server-writes-and-the-tool-reads` |
| `dispatch-watchdog.md` | `server/src/agents/**` | `dispatch-derives-the-action-it-never-accepts-one`, `the-orchestrate-spawn-prompt-is-composed-server-side`, `the-browser-never-talks-to-the-dashboard`, `every-agents-post-is-guarded-by-content-type-and-origin`, `one-run-per-project-checked-twice`, `a-resume-is-serialized-at-three-layers`, `the-watchdog-spawns-it-never-writes-the-run-file`, `armed-idle-off`, `grace-any-attempt-starts-the-clock-only-a-success-counts`, `a-board-started-run-is-visible-before-its-run-file-exists` |
| `board.md` | `client/src/**` | `board-versus-archive-is-derived-and-last-touched-has-three-rungs`, `environment-level-blocks-hide-the-dispatch-control-per-item-ones-disable-it`, `a-starting-entry-blocks-what-a-run-file-blocks-bug-21`, `a-crashed-run-renders-as-crashed-never-as-nothing`, `escape-has-one-owner-and-the-topmost-dialog-is-the-only-one-that-closes`, `queue-wait-is-not-work`, `launch-sheet-modeleffort-pickers-seed-from-settings-never-the-last-launch`, `the-resume-coupling-the-board-offers-a-hand-resume-exactly-when-the-sweeper-will-not` |
| `skills.md` | `skills/**`, `agents/**` | `editing-skills-changes-nothing-until-commit--push--pluginsync`, `agents-is-part-of-the-plugins-publish-surface`, `registryjson-has-exactly-one-writer-and-a-linked-worktree-registers-its-main-tree`, `backlog-managerretro-has-exactly-one-writer-and-the-retro-never-writes-run-state`, `started-and-phase-are-the-lifecycle-keys-in-frontmatter-and-neither-is-a-status`, `pnpm-test-is-the-union-of-both-runners` |

The overlap is deliberate: an edit under `skills/backlog-orchestrate/` matches both
`skills.md` and `orchestrator.md`, and loading both is the correct outcome.

`.gitignore` scopes its `.claude/` entries to `worktrees/` and `settings.local.json`
rather than ignoring the directory, so these files are tracked with no change to it —
confirm that rather than assuming it.

### Phase 4 — the record and the guard

- `docs/subsystems/invariants.md` gains one section holding the probe matrix: the
  Claude Code version (`claude --version`, `2.1.268` at grooming), the five verdicts, and
  the quoted `load_reason | file_path` evidence for each. This is the permanent home of
  the answer — the next person asking "do rules reach a headless run" must not have to
  re-run anything. Write this section in **both** gate outcomes.
- If rule files were written: CLAUDE.md gains a `.claude/rules/` line in Layout and one
  Invariants bullet, in the existing shape (rule + `Why:` anchor to the new section). The
  rule to state: *every rule file carries `paths:` and is a pointer, never a second copy
  of the reasoning.*
- A jest suite, `test/claude-rules.test.ts`, reading `.claude/rules/*.md` as source. It
  must pass vacuously on an empty/absent directory, so the negative-gate outcome stays
  green. Cases are enumerated under "Test cases" below.

## Test cases

All of these are runnable by a headless session; none needs a browser. Nothing rendered
changes, so there is deliberately no `In the browser (playwright MCP tools):` case here.

`test/claude-rules.test.ts` (new):

1. **Every rule file declares `paths:`.** For each `.md` under `.claude/rules/`, parse the
   frontmatter; fail naming any file whose frontmatter is absent, or present without a
   non-empty `paths` list. This is the context-floor guard — an always-loaded rule is the
   one failure mode this task must never introduce.
2. **Every anchor resolves.** Collect every `docs/subsystems/invariants.md#<anchor>` in
   every rule file; slugify every `##`/`###` heading of that file the way GitHub does
   (lowercase, strip anything but word chars/spaces/hyphens, spaces → `-`); fail naming
   any anchor with no matching heading. Verify the slugifier against a heading known to
   round-trip — `## Queue wait is not work` → `queue-wait-is-not-work` — so a broken
   slugifier cannot pass this case by matching nothing against nothing.
3. **Every glob matches something today.** For each pattern in each `paths:` list, assert
   at least one tracked file matches (`git ls-files` plus the repo's existing glob
   matcher). A pattern that matches nothing is a rule that never fires, and it fails
   silently forever otherwise.
4. **Pointers only.** Every non-blank, non-frontmatter, non-heading line of a rule file
   must mention `docs/subsystems/invariants.md` or `CLAUDE.md`. This is what mechanically
   keeps a rule file from growing a second copy of the prose.
5. **Bounded size.** No rule file exceeds 25 lines. A long rule file is prose in
   disguise.
6. **Vacuous pass.** With no `.claude/rules/` directory, or an empty one, the suite passes
   and reports zero files — so the "P3 negative, no files written" outcome is green.

Plus, unchanged and expected green: `pnpm test` (both runners) and `pnpm run typecheck`.

## Done when

- All five probe cases have a recorded verdict — `path_glob_match` observed or not, each
  with its control line — written into the new `docs/subsystems/invariants.md` section
  together with the Claude Code version they were measured on.
- Either: `.claude/rules/` holds the four pointer files of Phase 3, CLAUDE.md carries the
  Layout line and the Invariants bullet, and `test/claude-rules.test.ts` passes all six
  cases against them; **or** P3 came back negative, no rule file exists, and the same
  suite passes vacuously.
- If the files were written, one end-to-end check in this repo proves it live rather than
  by construction: a `claude -p` session with the probe's `--settings` hook, cwd this
  repo, told to read `server/src/orchestrator/orchestrator.service.ts`, produces a
  `path_glob_match` line for `.claude/rules/orchestrator.md`. Quote that line in the item's
  `## Outcome`.
- No hook, settings key or probe artefact is left behind in this repo: `git status` shows
  only the intended files, and `.claude/settings.local.json` is untouched.
- `pnpm test` and `pnpm run typecheck` are green, with output quoted in `## Outcome`.
