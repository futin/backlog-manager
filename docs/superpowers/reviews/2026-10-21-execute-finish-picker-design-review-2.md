# Review 2 — `docs/superpowers/specs/2026-10-21-execute-finish-picker-design.md`

Reviewer: fresh subagent (Fable), 2026-10-21. Checklist: facts vs code, internal consistency, edge cases, copy, scope, CLAUDE.md / `.claude/rules/` hard rules.
Every code claim below was read in this worktree (`feat/execute-finish-picker` at `f728c33`), not taken from the document. Review 1's findings (C1, I1–I7) were
checked against the revised text first: each is addressed (C1/I7 → lines 79–82; I1 → 109–110; I2 → 75–76; I3 → 127–129; I4 → 137–138; I5 → 123–124;
I6 → 85–86), so nothing below repeats them.

## Verdict

**APPROVE WITH FIXES** — no Critical. Two Important, both in the "left to the builder" section: the doc sweep still misses the wording that would ship a
stale instruction on the plugin's publish surface, and the byte-equal guard that keeps the skill text and the pr sentence in step is not told where it points
after the change. Nine Minor, mostly line citations and wording.

## Facts checked and found true

- Line 3: `959e1c1 feat(skills): backlog-execute pr finish mode (#326)` (`git log`).
- Line 29: the Jira `execute` built-in composes its own closing rule from `COMMIT_RULE` and never names `backlog-execute`
  (`server/src/jira/prompt.util.ts:81-91`, `:98-108`); replacing `PR_FINISH_RULE` does not touch it.
- Line 31: nine projects in `~/.backlog-manager/registry.json`, none with `backlog/config.json`.
- Lines 36–37: `OrchestrateSheet.tsx:219-232` — seeded to the literal `'main'`, not Settings, with the "temporary by construction" argument.
- Line 61: `dispatch` trims and forwards the typed prompt (`server/src/agents/agents.service.ts:430`, `:514-522`); `composePrompt` joins head, instruction
  and closing with a space (`server/src/agents/prompt.util.ts:33`).
- Line 65: `PR_FINISH_RULE` is `"Finish in this project's \`pr\` mode: the skill commits, reviews, pushes and opens the PR."` (`shared/agent.ts:865`);
  `COMMIT_RULE` ends "Do not push." (`:854-857`).
- Lines 73–76: `resolveBaseBranch` short-circuits `undefined`, `''` and `'main'` before any git call (`server/src/items/base-branch.util.ts:37`);
  `resolveBase`'s comment ties that to orchestrate appending nothing at `main` (`agents.service.ts:1803-1828`, `:811`).
- Lines 77–78: `resolveMergeMode` refuses `pr` off a non-`github` source (`agents.service.ts:1909-1911`).
- Lines 85–86: the controller rebuilds the body field by field and forwards `model`/`effort` unvalidated (`agents.controller.ts:64-91`).
- Line 98: `orchestrateDefaultMergeMode` is a `pickOne` clamp (`client/src/lib/settings.ts:328`, `pickOne` at `:215-217`).
- Line 100: `DispatchGroup` is `scope="this device"` with model/effort rows (`SettingsView.tsx:510-563`).
- Lines 103–104: `GET /api/agents/branches` (`agents.controller.ts:524-529`); the client's `fetchBranches` returns `[]` on a malformed payload and the
  sheet falls back to `['main']` (`client/src/lib/agents.ts:571-576`, `OrchestrateSheet.tsx:256-262`).
- Line 109: the Orchestrate sheet always sends `mergeMode` and `base` (`OrchestrateSheet.tsx:613`, `:628`).
- Lines 127–129: the exit-5 headline is byte-equal at `CLAUDE.md:127` and `.claude/rules/skills.md:19`, anchored at `invariants.md:3942`; the `config`
  paragraph is `invariants.md:3972-3978`; `test/claude-rules.test.ts` holds tier one and tier two to the same multiset of (anchor, headline).
- Line 151: `.claude/rules/dispatch-watchdog.md:16` ("The prompt is the only client field taken outright") and `:54` ("Item `dispatch` is the exception to
  both … taken outright"); reasoning at `invariants.md:1455-1456`.
- Lines 145–146: `shared/types.ts:885` ("The composed default. The sheet may edit it before dispatching.") and `test/agents-prompt.test.ts:112-131`
  (`it.each(['groom','execute','capture'])` asserting `do not push` on every action).

## Important

### I1 — lines 137–138: the sweep still misses the prose that would ship stale on the publish surface

The sweep regex matches `config.json`, the two `execute.*` keys, the two function names, `in place this time`, `backlog.mjs config`, `"finish":"pr"`,
`PR_FINISH_RULE`, `committed config` and `config is not read`. It does not match **"committed finish mode"** or **"project's finish mode"**, and those are
the words the rest of the repo uses:

- `agents/backlog-reviewer.md:6` ("in a project whose finish mode is pr") and `:54` ("in a project whose committed finish mode is `pr`") — `agents/` is part of
  the plugin's publish surface (CLAUDE.md invariant), so a reviewer dispatched by `backlog-execute` is told to look for a committed mode that no longer
  exists.
- `docs/subsystems/skills.md:17` ("in a project whose committed finish mode is `pr`") — the table row; `:34-42` is caught by `config.json`, this row is not.
- `skills/backlog-orchestrate/SKILL.md:27` ("under which a project's `pr` finish mode is ignored") and `:764` ("whatever the project's finish mode") — the
  marker rule stays true but names a per-project mode.
- `docs/subsystems/invariants.md:3944` ("every command but `config` (below) routes through the backlog-manager …") — the first paragraph under the
  `#backlog-mjs-in-a-tracker-project-needs-the-stack-up` anchor, **outside** the ~3972–3978 range line 129 rewrites, and matched by no sweep term. The spec
  catches the sibling sentence in `.claude/rules/skills.md` (line 128) but not this one.

Fix: add `committed finish mode`, `project's finish mode`, `whose finish mode` and ``but `config` `` to the regex at line 137, and name `invariants.md:3944` in
the rewrite list at line 129 beside ~3972–3978.

### I2 — line 149 with 92–96: the byte-equal guard is not told where it points after the change

Line 149 says `pr-mode.md` §1 quotes `finishClause`'s pr sentence "exactly as it ships" because "the skill text and the constant drifted once already". The
guard that exists for that today is `test/agents-shared.test.ts:836-840`: it reads **`skills/backlog-execute/SKILL.md`** (not `pr-mode.md`), collapses
whitespace, and asserts `toContain(PR_FINISH_RULE)` — a plain containment of a constant string. After this spec: the constant is gone (line 66), the sentence
is a function of `base` (line 65, `--base <base>` … `into <base>`), and line 94 moves the keyed lines from SKILL.md:81 to the token. A containment check
cannot hold against a templated sentence unless the test renders it (`finishClause('pr', '<base>')` against a literal `<base>` placeholder, or any other
convention), and the spec says neither which file the quote lives in for the test's purposes (SKILL.md:81, which line 94 rewrites, or pr-mode.md §1, which
line 149 names) nor what the rendering convention is. The sweep's `PR_FINISH_RULE` term will make the builder hit the import at `agents-shared.test.ts:20`,
but the spec leaves them to guess whether to delete the assertion or re-aim it — and deleting it is the drift line 149 says already happened once.

Fix: one sentence under "Left to the builder": `test/agents-shared.test.ts`'s `toContain(PR_FINISH_RULE)` becomes an assertion that `<file>` contains
`finishClause('pr', '<base>')` (or whatever placeholder pr-mode.md uses) after whitespace collapse — naming the file.

## Minor

- Line 74: "`base` required with `finish: 'pr'` and refused without it (400 either way)" reads at first pass as one rule about `finish`; line 141 lists the
  two cases plainly (`base` without pr, pr without `base`). Reword line 74 to those two clauses.
- Line 83: `req.prompt + ' ' + finishClause(...)` — `dispatch` works on the **trimmed** prompt (`agents.service.ts:430`) and `PROMPT_MAX` runs on that
  (`:432`); say "the trimmed body", or the preview line (line 106) and the sent prompt differ by trailing whitespace.
- Lines 79–80: "contains a `--finish` or `--base` token" — say whether that is a whitespace-delimited token or a substring (`--finish-line`, `--based`), and
  whether it is case-sensitive. The 400 message names tokens; the check should match its wording.
- Line 96 vs 124: line 96 stops a trigger carrying both `--finish pr` **and** `--finish in-place`; line 124 says "an unknown or **doubled** `--finish` stops".
  `--finish pr --finish pr` is doubled but not both. Pick one rule and use it in both places (doubled is the simpler one to implement and to test).
- Lines 103–104 with 75–76: seeding to `'main'` and unioning `main` into the list (as `OrchestrateSheet.tsx:251-262` does) means a `master`-trunk repo's
  default pick is the one value the server will 400 (line 76), every time, until the person re-picks. That is the designed behaviour, but the spec should say
  whether `main` is unioned in when the fetch does not return it — Orchestrate unions it because `main` costs nothing there; here it costs a 400 — or
  whether the select shows only fetched branches and seeds to `main` only when present. Edge case, not a defect.
- Line 128: "routes every command but `config`" is `.claude/rules/skills.md:21`, not :23–24; the two `config` sentences span :23–25. Line numbers only.
- Line 122: `.claude/rules/orchestrator.md:35-36` reads "the project's committed `backlog/config.json` says `execute.finish: pr`", not "a project's committed
  config" — the sweep's `config.json` term catches it, so no behaviour risk; quote it as written so the builder finds the string.
- Lines 99–100: the row goes in `DispatchGroup`, whose own comment (`SettingsView.tsx:521-525`) records that the orchestrate merge-mode default was moved
  **out** of this card in task-19 because "it never answered this card's question". The execute finish default does answer it (the launch sheet reads this
  card), so the placement is right — one sentence saying so, and that the comment is amended rather than contradicted, saves the builder a detour.
- Lines 130–131: the prompt-composition headline names two pieces ("The orchestrate and Jira spawn prompts are composed server-side") and the spec adds a
  third while changing only the reasoning entry. That is fine — the anchor is linked from `dispatch-watchdog.md:55` and elsewhere — but say explicitly that
  the headline and anchor are deliberately left as they are, so a builder reading `test/claude-rules.test.ts` does not "fix" the headline in one home.

## Checked and found no issue

- Scope (checklist 5): every non-goal (lines 24–31) is named and nothing in §1–4 depends on one; the Jira Run ▾ (line 29) is untouched by construction.
- Hard rules (checklist 6): the two-home headline rewrite (lines 127–129) respects the byte-equal rule; the server composes from validated fields only, in
  line with "the orchestrate and Jira spawn prompts are composed server-side"; no new writer of any file; `finishClause` lives in `shared/agent.ts` beside
  `COMMIT_RULE`, where both sides already import from.
- Concurrency: `finish`/`base` are per-request and never stored server-side; two sheets open on one item cannot interfere.
- External calls: `GET /api/agents/branches` failure is soft (line 104); git failure inside `resolveBaseBranch` lands in its existing 400 path.
