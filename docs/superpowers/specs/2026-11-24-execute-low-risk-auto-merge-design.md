# backlog-execute arms auto-merge and fix by itself when its diff is low-risk

Date: 2026-11-24. Status: design, awaiting approval.

## Why

`backlog-execute --finish pr` can already arm GitHub auto-merge on the PR it opened and keep fixing failing checks and base conflicts until GitHub merges it
(`--auto-merge`, `--fix`; `skills/backlog-execute/references/auto-merge.md`, shipped in #361 from `2026-10-24-groom-pr-and-auto-merge-design.md`). Today
that is all-or-nothing per launch: the board's launch sheet seeds two switches from Settings (`prAutoMergeDefault`, `prFixDefault`), and a tick never
auto-merges at all. So either every PR merges itself — including a 600-line server change — or none does, and a person merges each docs typo by hand.

The user wants the middle: when the change execute actually made is a **patch, a documentation update or a test update**, the PR should arm auto-merge and
fix by itself; anything else stays open for review exactly as today.

## Decided in brainstorming

- **The verdict comes from the diff, not the item.** Nothing on an item says "patch", "docs" or "test" today (items are bug / task / idea / refactor; refactors
  carry `kind: chore|debt`; tags become labels), and a label would be trusted even when the work ended up touching server code. The diff is what GitHub would
  merge, so it is what gets judged — after the commit, on the branch against its base.
- **It applies to board PR launches and to ticks.** Not to the orchestrator (it owns its own merges and reads no finish mode), not to `backlog-groom`, not to
  in-place executes (no PR, nothing to merge).
- **Approach A** (below): execute classifies its own diff once the PR is open and, if it qualifies, runs the existing auto-merge flow with `--fix`.

## Goals

1. A new trigger flag, `--low-risk-auto-merge`, legal only beside `--finish pr`. With it, once the PR is open (and, on a tracker project, the claim released —
   the same point `pr-mode.md` §8 reaches `auto-merge.md` today), execute classifies the branch's diff against `<base>`:
   - **low-risk** → it proceeds exactly as if the trigger had carried `--auto-merge --fix`: reads `references/auto-merge.md` in full and runs it;
   - **not low-risk** → it prints one line naming the first reason and stops as a plain `--finish pr` run does, PR open.
2. A deterministic classifier, a node CLI under `skills/backlog-execute/tools/`, so the verdict is a function of the diff and not of the model's reading of it.
3. The board can turn it on: a Settings (Local) switch, a launch-sheet switch under a PR finish, a dispatch body field, and the flag inside the finish clause.
4. A tick can turn it on: a `tick.json` setting (Settings › Shared › Backlog tick) that `tick.mjs decide` reads and, when on, appends the flag to the execute
   unit it prints.

## Non-goals

- Changing what `--auto-merge` / `--fix` do once running: bounds (45 min, fix rounds), refusals, the not-allowed-on-repo path, the final message lines — all
  reused unchanged from `auto-merge.md`.
- Groom PRs, orchestrator runs, remote-machine semantics beyond "the flag rides wherever `autoMerge` already rides".
- Acting on review comments (still a non-goal of the fix loop).
- Re-classifying after a fix round. The verdict is taken once, before arming; a fix commit that grows the diff does not disarm (see "Rulings").

## Anti-goals

- A PR that changes runtime code beyond a small patch merging itself. Every doubt in the classifier resolves to **not low-risk** — an unreadable diff, an empty
  one, a binary file, a rename, a path the rules do not name.
- A silent decision. Either outcome prints its line, with the reason, in the session's final message.

## Approaches

- **A. Execute decides it after committing (picked).** The flag travels spawn → prompt → skill; the skill runs the classifier on the real diff at the moment
  it matters, and the session that opened the PR is the one that waits and fixes — the 10-24 spec's rule that the fixing session is the one that opened it.
  One flag serves board and tick. Cost: a new flag through the dispatch path and a plugin sync before it takes effect.
- **B. The server arms it after the fact.** The PR poller sees an `execute/` PR, classifies its diff, arms auto-merge through `/api/prs/*`. Rejected: nothing
  is left alive to fix — the session already exited — so the "auto-fix" half is lost, and it would add a write the server makes on its own initiative rather
  than on a person's click.
- **C. Decide from the item before launch** (tag/label/kind). Rejected by the user: trusts a label over what the diff actually touched.

## The classifier

`node ${CLAUDE_PLUGIN_ROOT}/skills/backlog-execute/tools/low-risk.mjs --base <base>` run in `<tree>`, after the push. It runs `git fetch origin <base>`,
then reads `git diff --numstat -M <merge-base>..HEAD` and `git diff --name-status -M <merge-base>..HEAD` with the merge-base of `HEAD` and **`origin/<base>`**
— not local `<base>`. pr-mode §2 cuts the tree from LOCAL `<base>`, which is often ahead of origin; those unpushed base commits ride along in the push and
are in the PR, so a diff against local base would judge less than GitHub will merge. Against `origin/<base>` the diff is the PR's. It prints one JSON line
`{ "lowRisk": bool, "category": "docs" | "tests" | "patch" | null, "reason": string, "files": n, "lines": n }`, and exits 0 for either verdict (non-zero
only for a usage error). A failed fetch or any git failure is a `lowRisk: false` verdict with the git error as its reason, not a crash.

**Ignored before classifying: every entry under the tree's top-level `backlog/`.** On a files project execute's own commit appends the Outcome and moves
`backlog/<type>/open/<x>.md` to `done/` (pr-mode §5–6) — a rename, which would otherwise make every files-project PR not low-risk and eat the patch budget.
That is the skill's own bookkeeping, not the change under review. Execute never edits another item's plan, so ignoring `backlog/` cannot let a plan skip
`plan-review` (a groom's concern, and groom has no low-risk path). A diff that is empty once `backlog/` is ignored is `empty diff`, not low-risk.

The rules must hold on **any registered project**, not only this repo — so this does not reuse `scripts/ci-scope.mjs`, whose prefixes are this repo's.

A diff is low-risk when it is non-empty, every entry is a plain modification or addition (`M` or `A` — see "patch" for `A`), no file is binary (`-` in
numstat), and it falls in one of three categories, checked in this order:

1. **docs** — every file is documentation, which means its extension is one of `.md`, `.mdx`, `.markdown`, `.rst`, `.txt` or `.adoc` — wherever it sits.
   There is no directory clause: `docs/conf.py` or `docs/.vitepress/config.ts` is code that builds a site, not documentation. No size limit. Two exceptions,
   markdown that is behaviour and therefore never docs:
   - a file under a top-level `agents/` (agent prompts) — not denied, so it can still be a **patch** if it fits that category's limits;
   - any file named `CLAUDE.md`, `AGENTS.md` or `GEMINI.md` at any depth (agent instructions) — likewise not denied, so likewise patch-eligible.

   (`.claude/`, `skills/` and `.github/` need no exception here: they are on the deny list below, which is checked first, so nothing under them is ever
   low-risk in any category.)
2. **tests** — every file is a test file: under a `test/`, `tests/`, `__tests__/` or `spec/` directory at any depth, or named `*.test.*`, `*.spec.*`,
   `*_test.*` or `test_*.*`. No size limit. Docs files may be mixed in (a test plus its README change is still tests). Exception: a test-runner config file
   (`jest.config.*`, `vitest.config.*`, `playwright.config.*`, `pytest.ini`, `conftest.py`, `setup*.ts` under a test dir) is not a test file — it changes
   how every suite runs.
3. **patch** — a small change of any kind, judged over the **whole** diff (after `backlog/` is ignored): at most **3 files** in total and at most **40
   changed lines** in total (added + deleted summed over every file's numstat), and no added file. Every file counts toward both limits, docs and test files
   included, and an added file of any kind — a new test included — fails patch. A diff that mixes code with docs or tests is only ever a patch, since it
   cannot be docs or tests. Worked example: `src/a.ts` 12+3, `src/b.ts` 4+1, `README.md` 10+0 → 3 files, 30 lines → patch. Add `test/a.test.ts` 5+0 as an
   added file → `test/a.test.ts added` (4 files would also exceed the limit; the first failing rule in the order added → files → lines is the reason).

Denied anywhere (any one makes the whole diff not low-risk, whichever category it would otherwise be): package manifests and lockfiles (`package.json`,
`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Cargo.toml`, `Cargo.lock`, `go.mod`, `go.sum`, `pyproject.toml`, `poetry.lock`, `requirements*.txt`,
`Gemfile*`, `composer.*`), CI and container config (`.github/**`, `.gitlab-ci.yml`, `Dockerfile*`, `docker-compose*.yml`), migrations (any path segment
`migrations` or `migrate`), env and secrets files (`.env*`), and the tree's `.claude/` and `skills/`. Depth: the file names match at any depth (a nested
`packages/x/package.json` is denied); `.github/`, `.claude/` and `skills/` match only at the top level of the tree; `migrations`/`migrate` and `.env*`
match as any path segment.

`requirements*.txt` being a `.txt` means the deny list is checked **before** the docs rule — that order is part of the contract.

The `reason` names the first failing rule. Rules checked in this order, first failure wins: `empty diff`; a binary file → `<path> is binary`; a delete or
rename → `<path> deleted` / `<old> renamed`; a denied file → `<path> is never low-risk`; then, when the diff is neither docs nor tests, the patch rules in
the order added → files → lines: `<path> added`, `<n> files, patch limit 3`, `<n> lines, patch limit 40`. The lines reason is the whole diff's total, never
one file's. A git failure → `git: <first line of git's stderr>`.

## The skill

- **SKILL.md, Finish mode section** — `--low-risk-auto-merge` is read in the same pass as `--auto-merge` / `--fix`, from the same place, and is refused the
  same way: without `--finish pr` → stop and name the rule. Beside `--auto-merge` it is redundant, not an error: the explicit flag wins, the classifier never
  runs, and the mode line says `auto-merge` as today. The mode line gains `, auto-merge if low-risk` when it is the one carried.
- **`references/pr-mode.md` §8, last** — a new branch before today's auto-merge step: with `--low-risk-auto-merge` (and no `--auto-merge`), run the classifier.
  Low-risk → print `low-risk: <category> (<files> files, <lines> lines) — arming auto-merge` and continue into `auto-merge.md` as if the trigger carried
  `--auto-merge --fix`. Not → print `low-risk: no — <reason> — PR left open for review` and finish as a plain PR run. Either line is also in the final message,
  **above** the PR URL: the PR URL stays the final message's last line, because `backlog-tick` records an execute `ok` only when the message ends with it.
- **Classifier failure paths, all resolving to not low-risk (no arming):**
  - no PR was opened (`gh` missing, a refused or rejected step — pr-mode §8's existing case): the classifier is not run; the line is
    `low-risk: not checked — no PR`, and the existing `auto-merge: not armed — no PR` line follows;
  - the permission layer denies the `node … low-risk.mjs` call: never retried another way; the line is `low-risk: not checked — classifier call denied —
    PR left open for review`;
  - the tool exits non-zero, or its stdout is not one JSON line with a boolean `lowRisk`: the line is `low-risk: not checked — classifier failed: <first
    line of its stderr, or "bad output"> — PR left open for review`.
- **`references/auto-merge.md`** — its first paragraph gains the third caller ("a low-risk verdict under `--low-risk-auto-merge`"); nothing else changes.
- Under an `[orchestrator-run` marker the flag is ignored like every finish flag is today.

## The board

- **Settings › Local** — a new switch "auto-merge low-risk PRs" (`prLowRiskAutoMergeDefault`, default **off**) beside the existing "auto-merge PRs" and
  "fix" rows. Clamped like its siblings.
- **Launch sheet** — under a PR finish for an **execute** only (groom has no low-risk path), a third switch "Auto-merge if low-risk", seeded from that setting
  each time the finish becomes PR and cleared when it leaves PR, the same render-time seeding `autoMerge`/`fix` use. While "Auto-merge" is on, the switch is
  drawn disabled and reads on (auto-merge already covers it) — what is sent is `lowRiskAutoMerge: false` then, because the explicit flag wins.
- **Dispatch body** — `lowRiskAutoMerge?: boolean` beside `autoMerge` / `fix` on the execute dispatch shape. Same validation rules, checked beside their
  siblings in `agents.service.ts`, each a 400 with exactly this `error`:
  - non-boolean → `lowRiskAutoMerge must be a boolean`;
  - `true` on a groom (any machine) → `lowRiskAutoMerge applies only to execute`;
  - `true` beside a derived finish other than `pr` → `lowRiskAutoMerge applies only to finish pr`.
- **`finishClause`** — `FinishFlags` gains `lowRiskAutoMerge`; when it is set and `autoMerge` is not, the clause is exactly (with `<base>` and the review
  flags filled as the other two forms fill them, `${reviewText}` after the flag inside the backticks):
  ``Finish with `--finish pr --base <base> --low-risk-auto-merge`: the skill commits, reviews, pushes and opens the PR into <base>, then arms GitHub auto-merge and fixes failing checks and conflicts with <base> only if the PR's diff is docs-only, tests-only or a small patch; the skill never merges itself.``
  `autoMerge: true` with `lowRiskAutoMerge: true` produces today's auto-merge clause unchanged (the explicit flag wins). `pr-mode.md` §1 quotes this third
  form byte-equal beside the two it quotes today, and the existing clause/pr-mode parity test extends to it.
- **`FINISH_FLAG`** (`shared/agent.ts:951`) gains `low-risk-auto-merge`. That one regex is both the title defuse `defuseFinishFlags` (it swaps the hyphens
  for U+2011, it does not strip) and dispatch's rule-8 refusal (`agents.service.ts`), so a title spelling the new flag is defused and refused like the others.
- **The name is `--low-risk-auto-merge`, deliberately not `--auto-merge-low-risk`.** A skill that predates this change (plugin not yet synced, a remote
  machine on an older install) reading a token that starts with `--auto-merge` could take it for `--auto-merge` and arm every PR — the anti-goal. A token
  that does not start with an existing flag cannot be misread as one; the old skill at worst ignores it and the PR stays open.

## The tick

- **`tick.json`** gains `lowRiskAutoMerge: boolean` (default `false`), settable through `POST /api/ticks/config` and shown in Settings › Shared › Backlog
  tick as a switch labelled "auto-merge low-risk PRs" beside the caps. `TickConfig` / `TickConfigPatch` grow the field. Edge cases, mirroring the caps:
  - in the **file**, anything but a boolean (missing, `"true"`, `1`) reads as `false` — in both readers, the server's (`tick.controller.ts` /
    `tick-breaker.util.ts`) and `tick.mjs`'s hand copy (`readTickSettings` in `tick-breaker.mjs`);
  - in a **POST body**, a present non-boolean is `400 lowRiskAutoMerge must be a boolean`; a body carrying only `lowRiskAutoMerge` is a valid non-empty
    subset (not `nothing to set`), so `CONFIG_KEYS` gains it and the 400 text for the numbers is unchanged;
  - a write that omits it carries the file's current value over, as `writeTickFile` already does for every omitted number;
  - an unreadable file shows it as `false` for display only and is never replaced (`409`, as today); `missing` reads it as `false`.
- **`tick.mjs decide`** reads it at the same step it reads `maxPrs` (3b) and, when true, appends `--low-risk-auto-merge` to the execute unit's args after
  `--finish pr [--base …]`. A `--low-risk-auto-merge` / `--no-low-risk-auto-merge` CLI flag is **not** added — the job's flags are caps, this is a policy.
- `tick.json` is one file per machine, so the switch covers every project this machine ticks — the same scope as `maxPrs` / `maxPlans`. A per-project
  override is not part of this.
- A ticked execute that arms auto-merge holds the tick lock while it waits: up to 45 min against a 180 min default lock TTL. That is intended — the project is
  not idle while its PR is merging. A job can pass a shorter `--lock-ttl`, though, and a lock that expires under a live wait gets the session "recovered"
  while it still runs. So `decide` appends the flag only when the effective lock TTL is **≥ 180 minutes** (the default); below that it omits it. The
  channel is the one JSON line `decide` already prints: it gains a field `lowRiskAutoMerge` — `true` when the flag was appended, `false` when the setting is
  off, or the string `"off: lock TTL <n> min < 180"` when the setting is on but the TTL vetoed it. `--dry-run` and `--peek` compute and print the same field
  (they already print the would-be verdict) and change nothing else.
- **Outcome:** an execute tick that opened its PR is `ok` whatever the auto-merge part did (merged, armed and waiting out the bound, not allowed on the repo,
  refused, fix rounds spent). The tick's unit is "open a PR", and counting an auto-merge shortfall as `failed` would let a repo with auto-merge disabled
  trip the halt breaker. The `low-risk:` and `auto-merge:` lines go in the tick's closing summary paragraph, not in `--reason`.
- **Accepted failure:** the 180-minute floor bounds the wait's share, not execute's own work time. A ticked execute that runs long and then waits up to 45
  minutes can still outlast the job's timeout; the dashboard kills it, no `record` runs, and the next `decide` recovers it as `failed — killed at timeout`,
  which counts toward the halt breaker — exactly what a long execute without this flag already does today. The PR, already open and possibly armed, is left
  as it is; the next tick's PR cap counts it. Accepted rather than bounded further: lowering the 45-minute bound for ticks would be a second copy of
  `auto-merge.md`'s bounds.
- `skills/backlog-execute/references/backlog-tick.md` describes the tick's args as exactly `<id> --finish pr [backlog-tick]`; it gains the optional flag.

## Rulings (my calls — check these)

- Default **off** everywhere; nothing changes for anyone who does not turn it on.
- Patch limits **≤ 3 files, ≤ 40 changed lines, no added file**. Adds are excluded from patch because a new file is new surface, not a patch; adds ARE allowed
  in docs and tests.
- Explicit `--auto-merge` wins over the low-risk flag; the low-risk flag only ever adds auto-merge, never removes it.
- Low-risk implies **both** auto-merge and fix, as the user asked — there is no "low-risk auto-merge without fix".
- Diff judged against `origin/<base>` after a fetch, not local `<base>`; `backlog/` ignored; `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` never docs.
- Flag named `--low-risk-auto-merge` (old skills cannot misread it as `--auto-merge`); `FINISH_FLAG` extended.
- Tick: one machine-wide switch; flag omitted when the lock TTL is under 180 min; a timeout kill during the wait is an accepted `failed`; an execute tick that opened a PR is `ok` whatever auto-merge did.
- Verdict taken once, before arming. A fix round that grows the diff past the limits does not disarm: the fix loop exists to make the same change land, and
  disarming mid-wait would strand a PR the person was told merges itself.
- Classifier rules are constants in the tool, not configurable per project. A per-project override is a later idea if the defaults prove wrong.

## Left to the builder

- File and function names, the exact JSON field order and the Settings row layout (follow `.claude/DESIGN.md` §8.6). Every user-facing string — switch
  labels, 400 messages, printed lines, the finish clause — is fixed by this document and is not the builder's.
- Where in the node test suite the classifier's table of cases lives (beside the tool, per the node-suite placement rule).

## Docs and rule files this change makes false (must be updated in the same branch)

- `.claude/rules/tick.md` — `tick.json`'s shape (`{ haltAfter, maxPlans, maxPrs, resetAt }`) and "any non-empty subset of the three" for the POST; the new
  boolean, its file/POST edge cases and both readers.
- `.claude/rules/skills.md` — the tick "never leaves anything running" sentence: a ticked execute may now leave GitHub auto-merge armed on its PR (GitHub
  merges, the tick does not), and its session may still be waiting when `record` would otherwise have run.
- `skills/backlog-execute/references/backlog-tick.md` — "never merges" stays true (GitHub merges), but its args line and limits gain the optional flag and
  the wait.
- `.claude/rules/dispatch-watchdog.md` and any rule or doc listing the finish flags or the dispatch body fields (`--finish`/`--base`/`--auto-merge`/`--fix`,
  `autoMerge`/`fix`) — gain `--low-risk-auto-merge` / `lowRiskAutoMerge`.
- `docs/subsystems/invariants.md` — the "execute and groom … may arm GitHub auto-merge" entry gains the low-risk path.
- `docs/subsystems/skills.md` (execute flags), the tick docs, and the board docs that describe the launch sheet and Settings.
