# backlog-execute finish mode — chosen per run, like orchestrate's merge mode

Follows [2026-10-21-execute-pr-mode-design.md](2026-10-21-execute-pr-mode-design.md) (PR #326, merged as `959e1c1`). That design put the finish mode in a
committed per-project file, `backlog/config.json`. This one moves it to where orchestrate's merge mode already lives — a trigger flag, a Settings default and a
per-launch picker — and deletes the file.

## Why

After #326 shipped, the user looked for the feature on the board and found nothing: no Settings row, no picker, and no registered project had a
`backlog/config.json`. The only trace of pr mode was a sentence at the end of the launch sheet's prompt. Their words: "Can we do it the same as for
orchestrate, this is confusing with many config files."

Orchestrate already answers the same question — "how does this run finish?" — without a file: `--merge-mode` on the trigger, `orchestrateDefaultMergeMode` in
Settings, a picker on the Orchestrate sheet seeded from it, carried spawn → prompt. One mental model for both skills is the point.

## Goals

- A typed `/backlog-execute <id> --finish pr [--base <ref>]` runs pr mode; without `--finish` it is `in-place`, today's default, unannounced.
- Settings gets one row, **Execute finish: In place | PR**, the default the board's execute sheet is seeded with.
- The board's execute launch sheet gets a finish picker, overridable for that one launch, and — while PR is picked — a base picker.
- The pick reaches the spawned session through the server-composed prompt, the way `--merge-mode` does.
- `backlog/config.json`, `backlog.mjs config` and the server's `finish-mode.util.ts` are removed, with their tests, docs and rule text.

## Non-goals

- No change to what pr mode *does* once chosen: the worktree, checks, `backlog-reviewer`, fix loop, push, PR, the `in-review` label and every refusal #326
  built stay exactly as they are (`skills/backlog-execute/references/pr-mode.md` §2 onward).
- No per-project default. The Settings row is global, like `orchestrateDefaultMergeMode`.
- No change to Jira's **Run ▾** — it sends Jira's own prompt and never calls `backlog-execute`.
- No change under an `[orchestrator-run` marker: the run still owns every git step and execute reads no finish mode there.
- No migration of existing `backlog/config.json` files. None of the nine registered projects has one (checked 2026-10-21).

## Anti-goals (failure even if it technically works)

- A launch that pushes when the sheet showed in-place, or stays in place when it showed PR. What the sheet shows at click time is what the session does.
- A stored base. Orchestrate's sheet seeds its base to the literal `main` on purpose — a remembered feature branch silently outlives its experiment
  (`OrchestrateSheet.tsx`, the base picker's comment). Same rule here.
- Any new file a person has to know about or commit.
- A picker on the groom or capture sheet. Finish mode only means something to execute.

## Decided by the user

- Same shape as orchestrate: Settings default + per-run choice, no config file (this conversation, 2026-10-21).
- The written spec, then the plan (this conversation).

## The design

### 1. The trigger flag (skill)

`backlog-execute`'s "Finish mode" section stops calling `backlog.mjs config`. It reads the mode from the trigger instead:

- `--finish pr` → pr mode. `--finish in-place` or no `--finish` → `in-place`. Any other `--finish` value → stop and say the two legal values; never fall back.
- `--base <ref>` → that is `<base>`. Absent → the remote's default branch, else `main` — the same fallback chain `backlog.mjs config` used to compute, now done
  by the skill itself (or by a small `backlog.mjs` helper, builder's call). `--base` without pr mode is ignored, with a one-line note.
- The one-line announcement stays: `finish mode: pr → PR into <base>`.
- The `in place this time` override is removed: with no standing default to override, absence of the flag already means in-place.
- The skill's description and SKILL.md change "unless the project's committed finish mode is pr" to "unless the trigger says `--finish pr`".

### 2. The board prompt (server)

**The finish clause is never part of the editable prompt.** Today the sheet's textarea is spawned as typed, closing rule included. For an execute that would
let an edit contradict the picker — delete ` --finish pr` from the text and the sheet shows PR while the session stays in place, the first anti-goal. So, for
execute only (my call, builder check Q1):

- One shared function, `finishClause(finish, base)` in `shared/agent.ts`, returns the execute prompt's closing sentence: for `in-place` today's `COMMIT_RULE`;
  for `pr` one sentence carrying the literal flags, e.g. ``Finish with `--finish pr --base <base>`: the skill commits, reviews, pushes and opens the PR into
  <base>, and never merges.`` It replaces `PR_FINISH_RULE`. Both sides call it, so the sheet's preview and the sent prompt cannot drift.
- `plan()` for an execute returns the prompt **without** the closing clause; the sheet's textarea holds only that body. Groom and capture are unchanged: their
  `COMMIT_RULE` stays in the editable text as today.
- `AgentDispatchRequest` gains `finish?: 'in-place' | 'pr'` and `base?: string`. Validated in `AgentsService.dispatch`:
  - `finish` absent → `in-place` (a client written before this field). Present but not one of the two → 400. Present with an action other than `execute` → 400.
  - `base` required with `finish: 'pr'` and refused without it (400 either way); proved against the project's real local branches the way the orchestrate
    start's `base` is, through `resolveBaseBranch` (`server/src/items/base-branch.util.ts`; `resolveBase`'s doc comment in `agents.service.ts` explains why a
    base is *proved* and a mode is merely *recognised*). Unknown → 400. **`main` is proved too**: `resolveBaseBranch` answers `'main'` without asking git,
    which is right for orchestrate (it appends nothing at `main`) but wrong here, where `--base main` is always appended — a `master`-trunk repo must get the
    400 at click time, not a halt inside the spawned session. How the proof skips that carve-out is the builder's call.
  - No source gate: pr finish is legal in files and tracker projects alike (as #326 built it), unlike `--merge-mode pr`. Do not copy `resolveMergeMode`'s
    tracker-only refusal.
  - **An execute body that contains a `--finish` or `--base` token is a 400** (`the finish mode and base are set by the sheet's pickers — remove --finish and
    --base from the prompt`). The pickers are the only channel: without this, a typed `--finish pr` under an In place pick would reach the skill beside
    `COMMIT_RULE` (which carries no token) and push, and a typed `--base develop` beside the clause's `--base main` would leave two bases. Groom and capture
    bodies are not scanned.
  - The server then sends `req.prompt + ' ' + finishClause(finish, base)`. The clause comes from validated values only; nothing the person typed can change the
    mode. `PROMPT_MAX` keeps applying to the typed body, before the append; the clause is a bounded literal plus a proved branch name.
- `AgentsController.dispatch` rebuilds the body field by field (`.claude/rules/dispatch-watchdog.md`), so it must forward `finish` and `base` — unvalidated,
  as it forwards `model`/`effort`, because the service is where they are checked. Without that forward every launch would read as in-place.
- **`--base` is always spelled out under PR** (my call, builder check Q3), even when it is `main` — unlike orchestrate, which omits it at `main`. The board
  always knows the base it showed; letting the skill's own fallback (remote default → `main`) pick could open the PR into `develop` while the sheet said
  `main`. The fallback is for a typed trigger only.
- `readFinishMode` and its file read go; `plan()` no longer reads anything about finish mode.

**The skill's one pr signal is the `--finish pr` token** (my call, builder check Q2), wherever it appears in the trigger — typed by a person, or inside the
board's closing clause. The closing sentence is no longer a signal of its own; it is just where the board puts the token. SKILL.md:81 and `pr-mode.md` §1's
lines keyed on the old `PR_FINISH_RULE` sentence are rewritten to key on the token. A trigger with both `--finish pr` and `--finish in-place` stops with an
error naming both, rather than picking one.

### 3. Settings (client)

- `Settings.executeDefaultFinish: 'in-place' | 'pr'`, default `'in-place'`, clamped by `clampSettings` with `pickOne` like `orchestrateDefaultMergeMode`.
- One row in `DispatchGroup` on the Local page (beside the model/effort defaults the same sheet reads), labelled **Execute finish**, options **In place** and
  **PR**, with one hint line: "PR mode works in its own worktree, reviews, pushes and opens a PR. It never merges."

### 4. The launch sheet (client)

- Only when `plan.action === 'execute'`: a finish select seeded from `settings.executeDefaultFinish`, and — while it reads PR — a base select fed by
  `GET /api/agents/branches` and seeded to `'main'`, failing soft to `['main']` exactly as the Orchestrate sheet's does.
- Under the textarea, a read-only line shows `finishClause(finish, base)` for the current picks, so the person sees exactly what will be appended. Flipping
  either select updates that line only; it never re-fetches the plan or touches what was typed.
- The dispatch sends `finish` on every execute launch (even when untouched — the same reason the Orchestrate sheet always sends `mergeMode`) and `base` when
  PR. A groom or capture launch from the same `LaunchSheet` omits both, since the server 400s `finish` on any other action.

## What is removed

- `backlog.mjs`: the `config` verb, `parseExecuteConfig`, `remindToCommitConfig`, `CONFIG_FILE` and their tests in `backlog.test.mjs`.
- `skills/backlog/SKILL.md`'s `config` paragraph.
- `server/src/agents/finish-mode.util.ts` and its test.
- Every doc and rule line naming `backlog/config.json` or `execute.finish` (the grep in "Left to the builder" lists them), rewritten to the flag.

## Invariants this changes

- CLAUDE.md's "`backlog-orchestrate` is the only skill that merges; `backlog-execute` commits and pushes its own branch only in `pr` mode." — the headline
  holds; the mechanism in `.claude/rules/orchestrator.md` changes "a project's committed config" to "the trigger's `--finish pr`". In `invariants.md` the
  sentence at ~466–467 ("The mode is a committed file rather than a prompt switch so a project's set of committers is visible in its own history, and a
  malformed file stops execute…") argues against this design and is **replaced**, not word-swapped: the mode is a trigger flag, composed server-side from a
  validated field the way `--merge-mode` is, and an unknown or doubled `--finish` stops execute rather than falling back to either mode.
- The exit-5 headline — "**`backlog.mjs` in a tracker project and `jira.mjs` always need the stack up, and say so with exit `5` — save `backlog.mjs config`
  and `jira.mjs worktree`.**" — names the verb being deleted. Rewrite it to drop `backlog.mjs config` **in both homes at once** (CLAUDE.md:127 and
  `.claude/rules/skills.md:19`, which `test/claude-rules.test.ts` holds byte-equal), drop the two `config` sentences inside that bullet (skills.md:23–24,
  including "routes every command but `config`"), and rewrite `invariants.md` ~3972–3978 under the same anchor (~3942), plus its ~3944 "every command but `config`". The exit-5 rule itself stays.
- The prompt-composition invariant ("The orchestrate and Jira spawn prompts are composed server-side") gains execute's finish flag as a third
  server-composed piece; its reasoning entry should say so.

## Left to the builder

- Whether `<base>`'s fallback (remote default → `main`) lives in the skill's prose or in a small `backlog.mjs` helper.
- Exact copy of the Settings hint and the sheet's labels.
- The doc sweep: `git grep -n -i "config\.json\|execute\.finish\|execute\.base\|parseExecuteConfig\|readFinishMode\|in place this time\|backlog\.mjs config\|
  \"finish\":\"pr\"\|PR_FINISH_RULE\|committed config\|config is not read\|committed finish mode\|project's finish mode\|whose finish mode\|but \`config\`"`
  must come back empty outside `docs/superpowers/` (specs and plans are history and
  stay as written) — `tsconfig.json` and git `config` hits excepted. `pr-mode.md`'s intro (the paragraphs before §1, which open "when `backlog.mjs config`
  printed…" and say "the committed config already answered that") is rewritten along with §1; §2 onward is unchanged.
- Tests: for the server, the 400s above (bad `finish`, `finish` on groom, `base` without pr, pr without `base`, unknown base, an unproved `main`, an execute
  body containing `--finish` or `--base`), that an execute plan's prompt carries no closing clause, and that the spawned prompt ends with `finishClause` for
  each mode; for the client, the seed-from-Settings, the base select appearing only under PR, the read-only clause line tracking both selects, and that
  `finish` is sent on every execute launch and never on groom or capture.
- Notes that go stale: `AgentPlan.prompt`'s doc comment (`shared/types.ts`, "The composed default. The sheet may edit it…") and `test/agents-prompt.test.ts`'s
  per-action closing-rule assertion both describe the closing rule as part of every plan; execute's no longer is.
- If `<base>`'s fallback becomes a `backlog.mjs` helper, it is a local git read in both modes — no stack, never exit `5` — or the exit-5 headline needs a new
  exception in place of the one this removes.
- `pr-mode.md` §1 quotes `finishClause`'s pr sentence exactly as it ships (the skill text and the constant drifted once already, #326 review 2). The existing
  guard, `test/agents-shared.test.ts` ~836–840, asserts SKILL.md `toContain(PR_FINISH_RULE)`; re-aim it at whichever file quotes the sentence, asserting it
  contains `finishClause('pr', '<base>')` after whitespace collapse — the quote spells the base as the literal placeholder `<base>`.
- The execute sheet (body editable, clause read-only below) and the groom/capture sheets (closing rule inside the editable text) look different on purpose.
- The rule that item dispatch's prompt is "taken outright" (`.claude/rules/dispatch-watchdog.md` lines 16 and 54, reasoning at `invariants.md` ~1456) gains
  its one exception: an execute's finish clause is appended server-side from validated fields.
