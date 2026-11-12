# backlog-review: a standalone, incremental, grouped code review with file coverage and quoted-code anchors — design

Date: 2026-11-12. Branch: `feat/reviewer-coverage-anchors-groups`.

## Intent and why

`agents/backlog-reviewer.md` reviews a diff today only as a step inside two flows: orchestrate §7 (the gate before an unattended merge) and execute
`--finish pr` §7 (the review a PR's merger trusts). It is one Opus agent that reads `git diff <base>...<branch>` whole and returns a verdict. Nobody can run
it on its own — not after an `in-place` `/backlog-execute`, not on a branch a person wrote by hand.

The user inspected alibaba/open-code-review (OCR, Apache-2.0, a Go review CLI) and wants its engineering ideas carried into this reviewer, not to fix a known
failure but to harden what one language-driven agent cannot guarantee by itself — and wants the review usable on its own, CodeRabbit-style:

1. **Standalone.** A `/backlog-review` skill anyone can run in any checkout — typically right after `/backlog-execute` — with the same procedure the two
   flows use, so the three can never drift.
2. **Incremental by default, `full` on demand.** Like CodeRabbit on a second push: a re-review covers only what changed since the last review of this
   branch; `full` reviews the whole branch.
3. **Offer to fix.** After a standalone verdict, offer to fix the findings in the same session.
4. **Deterministic file coverage** (OCR). Code decides which files must be reviewed and proves each one was; a single agent on a large diff otherwise skims.
5. **Quoted-code anchors** (OCR's re-location). Each finding quotes its code; a tool resolves the real line, so the `path:line` a fixer reads cannot drift.
6. **Grouped review of big diffs** (OCR's bundling). Above a size threshold, related files are reviewed in separate dispatches with fresh contexts.
7. **Configurable reviewer model and effort**, from the board's Settings: one pair for every group, or a big-group pair and a small-group pair.

Not carried over (user's call): OCR's comment filter / self-verification pass. Also not carried over: OCR's per-language rule docs — this reviewer already
matches rules better, from the repo's own `CLAUDE.md` invariants and `.claude/rules/*.md` by `paths:`.

## Goals

- `/backlog-review [<id>] [full] [--base <ref>]` reviews the current checkout — committed branch work **and** uncommitted and untracked changes — and shows the
  verdict and findings, with the full report in a temp file.
- A second `/backlog-review` on the same branch reviews only what changed since the first, and says which earlier findings are now resolved.
- Orchestrate §7 and execute `--finish pr` §7 run the same procedure and the same tool.
- Every file in scope is either reviewed or skipped for a stated, mechanical reason, and a tool — not the reviewer's word — proves every reviewed file is in
  the report.
- Every Critical/Important finding carries the exact code it is about, resolved by a tool to the real line.
- Above a size threshold, the diff is reviewed in groups, each its own `backlog-reviewer` dispatch, merged into one report and one verdict.
- Reviewer model and effort per group come from a server-side Settings value, overridable per launch and per typed run.

## Non-goals

- No self-check / finding filter.
- No LLM in grouping, anchoring, incremental scoping or merging. All deterministic code, unit-tested.
- No change to severity definitions, the mechanical verdict rule, the fix-loop budget (two) in orchestrate and execute, or who commits in those flows.
- No change to what the reviewer checks or the order (correctness, invariants, tests, Outcome lines).
- No board button that launches `/backlog-review` (typed only in this change).
- No new language rule docs.

## Anti-goals — failures even if it "works"

- **A caller's context fills with review prose.** Each reviewer still returns only verdict + one line per Critical/Important; the merge tool prints a compact
  result; report bodies stay in files.
- **The canonical report path or shape moves.** Orchestrate's merge commit says `Reviewed: <verdict> (reviews/<id>-<k>.md)`; `references/recovery.md`
  sweeps the `<dir>/reviews/` directory; and `skills/backlog-retro/tools/lib/reviews.mjs` parses it — file names matching `^((?:[a-z]+-)?\d+)-(\d+)\.md$`,
  the first `verdict: <word>` line, and the `## Critical` / `## Important` sections. The merged report is written exactly at `<dir>/reviews/<id>-<k>.md` and
  keeps all three: a `verdict:` line of its own and those two headings. Group and retry reports (`<id>-<k>.g<n>.md`, `<id>-<k>.retry.md`) do not match
  retro's name pattern, so retro counts each review pass once.
- **The reviewer writes to the repo.** It stays read-only. The incremental snapshot (below) touches no ref, no index, no working-tree file.
- **Grouping loses cross-file review.** Every group reviewer sees the full file list, may read any file, and may raise a finding at full severity about any
  file.
- **A small diff gets slower or costlier.** Below the threshold: one reviewer dispatch, as today, with today's model.
- **A coverage gap is billed to the executor.** An uncovered file is a review failure and never spends a fix loop.
- **An incremental review approves a branch with a known open finding.** Earlier Critical/Important findings stay in the verdict until shown resolved.

## Constraints

- `agents/` and `skills/` reach a running Claude Code only after commit, push and `pnpm run plugin:sync` (CLAUDE.md invariant). `agents` and `skills` are
  both in `PUBLISHED_PATHS`.
- A sub-agent cannot dispatch sub-agents, so grouping and merging are done by whoever dispatches the reviewer — the standalone skill, orchestrate or
  execute — never by the reviewer.
- `~/.backlog-manager/settings/*.json` files have the server as their one writer (precedent: `settings/watchdog.json`, `settings/timezone.json`). Tools may
  read them.
- Node tools live beside their skill; tests are flat `skills/*/tools/*.test.mjs`, run with `pnpm test:skills`. Jest tests for server/client live in `test/`.
- New prose wraps at 160 columns.

## Design

### 1. Shape: one procedure, one tool, three entry points

New skill `skills/backlog-review/`:

- `SKILL.md` — the `/backlog-review` entry point (§5).
- `references/procedure.md` — **the** review procedure: scope → dispatch groups → merge → coverage retry → result. Orchestrate §7 and execute pr-mode §7
  replace their own dispatch text with "follow `skills/backlog-review/references/procedure.md`" plus their caller-specific parameters (§6). The two flows
  stop describing dispatch themselves, which is what keeps three entry points identical.
- `tools/review.mjs` — the deterministic tool (§2–§3), with `review.test.mjs` beside it.

```
entry point (/backlog-review | orchestrate §7 | execute pr §7)
  1. review.mjs scope      → manifest: diff source, every file review|skip+reason, groups with model+effort
  2. one backlog-reviewer per group, all in ONE message              → <report>.g<n>.md each
  3. review.mjs merge      → coverage, anchors, prior findings, verdict, merged report, compact stdout
  4. uncovered?            → one re-dispatch for just those files, merge again; still uncovered → review failure
  5. verdict               → caller acts (standalone: show + offer to fix; orchestrate/execute: as today)
```

### 2. `review.mjs scope`

`scope --tree <W> --base <B> [--item <path>] [--mode full|incremental] [--state <file>] [--review-config <json>] [--previous <manifest.json>] --out
<manifest.json>`

`--previous` is the fix-loop re-review (§6): `scope` takes a fresh `to` snapshot, keeps the previous manifest's partition and per-group model/effort,
assigns any file new to the diff to group 1, hands the previous round's open findings out as earlier findings (§3), and marks each group `rerun: true|false`
— true for group 1 and for every group with a file whose content differs between the previous `to` and the new one. `full` mode otherwise.

A separate subcommand, `review.mjs config [flags]`, resolves the reviewer config (flags, else `review.json`, else defaults, §7) and prints it as one JSON
line; it is how a driver learns the effective config to record before any `scope` runs.

**Diff source.** The tool decides what is being reviewed and records it in the manifest as a pair of git objects, `from` and `to`:

- `to` is a **snapshot of the tree as it is now**: HEAD plus every uncommitted and untracked change (gitignored files excluded), written as a git tree object
  through a temporary index file (`GIT_INDEX_FILE` pointing outside the repo). This writes loose objects only — no ref, no change to the real index or the
  working tree — so the read-only promise holds. In a clean checkout, `to` is simply HEAD's tree.
- `from`, **full** mode: the merge base of `<B>` and HEAD — the same thing `<B>...HEAD` diffs from today.
- `from`, **incremental** mode: the `to` snapshot of the last review of this branch, read from the state file (§3).

Every diff anyone takes — the tool, the reviewers — is `git -C <W> diff <from> <to>` (two tree-ish arguments; the order matters, three dots no longer apply).
In orchestrate and execute pr-mode the tree is clean and committed, so `to` is the branch tip's tree and full mode reproduces today's `<base>...<branch>`
exactly.

**Files.** Per file: `path`, `oldPath`, `status`, `added`, `deleted`, `decision` (`review` | `skip`), `reason`. Skip reasons, a closed set: `lockfile`,
`generated` (build output such as `dist/`), `binary`, `deleted` (gone in `to`; its removal stays visible as context), `item` (the item's own file —
read as the contract, not reviewed as code). Exact lists are the builder's call; the set is closed.

**Grouping.** If reviewable files exceed **12** or changed lines exceed **1200**, partition; otherwise one group. Cap each group at **10** files or **800**
lines. Deterministic: pair tests with their source (`foo.test.mjs` ↔ `foo.mjs`, `x.spec.ts` ↔ `x.ts`, `test/x.test.ts` ↔ the one `x.ts` in scope) and never
split a pair; bucket by directory prefix (`server/src/<module>/`, `client/src/<area>/`, `skills/<skill>/` stay together); split a bucket over the cap; fold a
one-file bucket into its nearest sibling while the cap allows; order everything by path so the same diff always gives the same groups. All numbers are soft
constants. Each group: `label`, `files`, `model`, `effort` (§7).

**Edge inputs.**

- **Empty diff** (`from` and `to` the same tree) in full mode. Standalone: print `nothing to review — no changes against <base>` and stop, no dispatch, no
  state written. Orchestrate and execute commit before they review, so an empty diff there means something upstream went wrong: a review failure with its
  own fixed words (§6).
- **Non-empty diff, zero reviewable files** (every file skipped). One group 1 with no own files, dispatched for the item checks and for any still-open
  earlier findings (§3). Only when there is neither an item nor an open earlier finding is nothing dispatched; `merge` still runs with no reports, writes the
  merged report (the skips listed, verdict `approve`) and rewrites the state file. Coverage is trivially complete.
- **One file, or one test/source pair, over the 10-file / 800-line cap.** It becomes a group of its own; a file is never split and a pair never broken, so the
  cap is exceeded rather than the rule.

Prints one line: `{"mode":…,"files":n,"review":r,"skip":s,"groups":g}`.

### 3. Reviewed-state memory and incremental mode

**State file**, outside the repo: `~/.backlog-manager/reviews/<repo key>/<branch>.json` (repo key and file name the builder's call; a detached HEAD has no
state and always reviews full). It holds the last review's `to` snapshot, the HEAD **commit** at that review, `base` and the **merge-base commit** of `base`
and that HEAD, the merged report's path, a timestamp, and the **open findings** — every Critical/Important from that review, with its anchor, not yet shown
resolved.

`merge` writes it at the end of every review, full or incremental, **whose coverage is complete**. A review that ends in a coverage failure leaves the state
file as it was, so the files it never covered are still in the next increment. Orchestrate and execute pr-mode reviews write it too (they review `backlog/<id>` and
`execute/<id>` branches, so a later `/backlog-review` on that branch is incremental from the gate's review).

**Mode selection** (in `scope`): `full` when asked; otherwise `incremental` when all of these hold — a state file exists for this branch; its `base` is the
same ref; the merge-base of `base` and the current HEAD is the recorded merge-base commit; the recorded HEAD commit is an ancestor of the current HEAD
(`git merge-base --is-ancestor`); and the recorded snapshot still resolves in this repo. Otherwise `full`, with the reason printed (`no earlier review`,
`base changed`, `base moved — merged or rebased onto a newer base`, `history rewritten`, `earlier snapshot gone`). The merge-base and ancestry checks keep a
rebase, a merge of the base, or a re-created branch of the same name from putting other people's work into the increment. An incremental scope with no
changes prints `no changes since the last review (<report path>) — its verdict stands: <verdict>` and stops without dispatching anyone.

**Earlier findings in an incremental review.** Every still-open earlier finding is handed to a dispatched group, which marks it `resolved` or `open` in its
report (format §4) — a fix often lands in a different file from the finding (a new test, a caller), so a finding is never closed or kept by which files the
increment touched. Owner: the group holding the finding's anchored file when that file is in this increment; otherwise group 1 (always dispatched).
Unanchored, item-level and deleted-file findings go to group 1. The verdict is computed by `merge` from those marks plus the new findings, never copied from
an earlier report's verdict line: an incremental review returns `approve` only when it finds nothing new at Critical/Important **and** every earlier one is
marked resolved. A finding no report marks (the reviewer skipped it) stays open.

**Item checks in incremental mode.** Group 1's item-level checks (§4) judge the item against the **whole** branch (`<merge-base>` → `to`), not the
increment — whether the change keeps the item's promise is a property of the branch, not of the last commit.

### 4. `review.mjs merge`, anchors, and the agent file

**`merge --manifest <M> --reports <g1.md> … [--carried <gN.md> …] --out <report.md> [--state <file>]`:**

- **Coverage.** Every `review` file must be listed in the `## Coverage` section of its group's report. Prints the uncovered list. A group named in
  `--reports` whose report file does not exist counts as every one of its files uncovered (the retry covers them). `--carried` reports — a fix-loop
  re-review's groups with `rerun: false` — count for coverage only: their verdict line and findings are ignored, because the previous round's findings
  reach this round as earlier findings.
- **Anchors.** Each Critical/Important entry carries `anchor: <path> | <one exact line of code copied from that file in to>`. Resolution against `to`,
  comparing whitespace-trimmed lines: one match → that line; several → nearest to the claimed line; none → keep the claimed line, mark `(unanchored)`. **Never
  dropped or downgraded by resolution.** Findings about removed code anchor to the nearest surviving line and say so (or the builder resolves them against
  `from`; never drop).
- **De-duplication.** Keyed on the **resolved** `path:line`, not the quoted text (identical lines such as `});` recur). Findings at one `path:line` become
  one entry at the highest of their severities; when their texts differ, the entry keeps every distinct text. Unanchored findings are never de-duplicated.
- **Coverage retry report.** `--retry <report.retry.md>` adds the one retry dispatch's report (§1 step 4); a `## Coverage` line in it counts for any file.
- **Earlier findings.** Applies the groups' `resolved`/`open` marks; a finding no report marks stays open.
- **Verdict.** `incomplete` when any file is still uncovered — printed as `"verdict":"incomplete"` and written as the merged report's `verdict:
  incomplete` line (retro's `VERDICT` pattern records any word and excerpts only `fix`). Otherwise `fix` if any re-run group says `fix`, any new
  Critical/Important exists, or any earlier finding is still open; otherwise `approve`.
- **Merged report** at `--out`, in the agent file's report structure, plus: mode (`full`/`incremental`, with `from`/`to`), the groups with their model and
  effort, a `## Earlier findings` section (resolved / still open). Group reports stay on disk beside it.
- **State file** rewritten (§3).
- **Stdout**, the only thing a caller reads into context: `{"verdict":…,"mode":…,"uncovered":[…],"unanchored":n,"stillOpen":n,"minor":n}`, then one line
  per Critical/Important in the agent file's message shape (`path:line — Severity: text`), lines resolved, earlier still-open ones marked `(earlier)`. Minor
  findings are counted, never printed; a caller reads the merged report's `## Minor` section only when the user chose to fix Minor findings (§5).
- **Coverage retry**, driven by the caller (§1 step 4): one `backlog-reviewer` dispatch for all uncovered files together, on the `big` pair, report
  `<report>.retry.md` beside the group reports, then `merge` again with `--retry`.

**`agents/backlog-reviewer.md` changes:**

- **Inputs.** Five required fields, still "Five fields, always": `worktree`, `base`, `from`, `to`, `report path`. The diff is `git -C <worktree> diff <from>
  <to>` (from the manifest) instead of `<base>...<branch>`; `branch` leaves the required set (the `to` snapshot replaces it); `base` stays for the item-level
  checks. `item file path` becomes optional: absent means no item — a pure code review, item checks skipped. New optional inputs: `manifest path`; `group`
  (`<n> of <N>` and its files); `item checks` (`yes` for group 1 only); `earlier findings` (the still-open findings handed to this group, §3); `outcome:
  none` when the item has no `## Outcome` to read (§5) — then check 4 (`Contract sweep:` / `Red proof:`) is recorded as `not checked: no Outcome` and is
  **not** an Important finding.
- **Scope of a group.** Its `## Coverage` duty is its own files. It may read any file in the tree and the full manifest, and may raise a finding at full
  severity about **any** file — another group's, one the diff never touched (a missed call site), the item file, `CLAUDE.md`. Severity follows the defect,
  never which group saw it.
- **Item checks** (`yes` only): the whole-change promise against `## Plan` / `## Fix`, `## Test cases` coverage, and the `Contract sweep:` / `Red proof:`
  lines. Every group still does correctness, invariants and test adequacy for its files.
- **Report additions:** `## Coverage` — `- <path> — clean | findings | not reviewed: <reason>` per own file (honest `not reviewed` is allowed and counts as
  uncovered); an `anchor:` line on every Critical/Important; `## Earlier findings` — each given earlier finding marked `resolved` or `open` with one line of
  why.
- **"Never review the main tree" becomes "never read a tree other than the one given".** A standalone review legitimately runs in the main checkout; the
  rule's point — do not review work outside the change under review — is unchanged.
- **Returned message:** unchanged.

### 5. `/backlog-review` — the standalone entry point

`/backlog-review [<id>] [full] [--base <ref>] [--review-model … --review-effort … | --review-big … --review-small … --review-small-max-lines …]`
(flag spelling the builder's call; the same flags as orchestrate and execute, §7).

- **Tree:** the current checkout (`git rev-parse --show-toplevel`). **Base:** `--base`, else the remote's default branch, else `main` — execute pr-mode's
  rule.
- **Item:** with `<id>`, the item file found by the backlog tool wherever it is (`open/` or `done/`; an `in-place` execute archives to `done/`), or, in a
  tracker project, a temp snapshot of the issue body alone (`show <id> --json`, its `body`). Pr-mode's `<tmp>/outcome.md` exists only inside an execute
  session, so a standalone tracker review has no `## Outcome`; the dispatch says `outcome: none` and check 4 is skipped (§4). A files item without an
  `## Outcome` section gets the same. Without `<id>`: no item, pure code review.
- **Reports** under `<tmpdir>/backlog-review/<repo key>/<branch>-<n>.md` (+ `.g<k>.md`, manifest beside), never in the repo.
- Runs `references/procedure.md`. Then shows the user: mode (and why, if it fell back to full), the verdict, the resolved finding lines, earlier findings
  resolved / still open, and the report path. Not the report body.
- **Coverage failure** (`verdict: incomplete`): said plainly, with the uncovered files and report paths; no approve or fix is claimed.
- **Refusals before any dispatch**, each said in one sentence and nothing reviewed: a base that does not resolve to a local branch
  (`git rev-parse --verify --quiet refs/heads/<base>`, pr-mode's own check); an `<id>` the backlog tool cannot find; a tracker project whose stack is down
  (the backlog tool's exit `5`) — the sentence adds that `/backlog-review` without an id still works.
- **Offer to fix** (user's decision): when the verdict is `fix` or `merge`'s `minor` count is above zero, and the session can ask (AskUserQuestion available — not a
  headless `claude -p`), offer: fix Critical + Important (Recommended), fix all including Minor, or don't fix. On a fix choice, **this session** — never the
  reviewer — fixes exactly the named findings, reading each at its resolved `path:line`; runs the verification the repo's `CLAUDE.md` names (tests,
  typecheck) and shows the real output; **commits nothing** (same as an `in-place` execute — staging is the user's call); then offers an incremental
  re-review. At most two fix rounds per invocation, matching the flows' budget; after the second, it reports what is still open and stops offering.
- Under an autopilot run, the offer is a gate: take the Recommended option and log it.

### 6. Orchestrate and execute

Both replace their §7 dispatch text with the procedure, parameterised:

- **Orchestrate §7:** tree `"$PWD/.worktrees/<id>"`, base = the run's base, item = the worktree item file (tracker: `<dir>/items/<n>.md`), mode **full**,
  reports `<dir>/reviews/<id>-<k>.g<n>.md` merged to `<dir>/reviews/<id>-<k>.md` (canonical, unchanged), manifest beside, config from the run file.
- **Execute pr-mode §7:** tree `<tree>`, base `<base>`, item as today, mode **full**, reports `<tmp>/review-<k>.g<n>.md` merged to `<tmp>/review-<k>.md`,
  config from the session's flags.
- **Coverage failure.** Orchestrate parks the item with the existing kind — `attention <id> --kind parked --detail "review incomplete — uncovered files
  are listed in the merged review report"`, then `stage <id> parked` — so no new attention kind (the set is closed across `orchestrate.mjs`,
  `shared/types.ts`, the server and the client). The detail is fixed words with no placeholder: file names are session-created text, which SKILL.md's rule
  keeps off a command line, and `<paths>` left the closed placeholder list in `orchestrate-prompts.test.mjs` on purpose. The uncovered list lives in the
  merged report's `## Coverage`. Execute does not push and reports it in §4's failure shape.
- **Empty diff** (§2). Orchestrate parks with `--detail "review not run — the item's committed diff is empty"`, then `stage <id> parked`; execute does not
  push and reports it. Both are failure branches, so in orchestrate they live in `references/check-failures.md` and SKILL.md names that file on the
  observable trigger (`merge`'s `verdict` of `incomplete`, or `scope`'s `"files":0` on an empty diff), per `.claude/rules/skills.md`.
- **`verdict: fix`.** The fix loop as today, except the findings copied verbatim into `<dir>/prompts/<id>-fix-<n>.txt` (orchestrate) or acted on (execute)
  are the merge tool's resolved lines, plus the merged report path.
- **Re-review after a fix loop (user's decision): only the groups whose files the fix changed, plus group 1.** The caller runs `scope --previous
  <first manifest>`, dispatches the groups it marks `rerun: true`, and passes the others' latest reports to `merge` as `--carried`. Groups come from the
  item's first `scope` (never re-partitioned); a fixed file outside that manifest joins group 1. Untouched groups are not re-dispatched, but their Critical/Important findings
  are not carried as open either: like §3's earlier findings, every finding from the previous round is handed to a re-run group (its owner if that group
  re-runs, else group 1) to mark `resolved` or `open`, and `merge` computes the verdict from those marks plus the new findings — never from a carried
  report's verdict line. A finding fixed in another file (a new test) therefore closes, and a correctly fixed item does not burn its second loop. A one-group review re-runs its single group, as today. (This is deliberately not the standalone incremental mode: a gate re-reads
  each touched group's whole files, not just the fix commit's lines.)
- Orchestrate's dispatch text "the four fields its input contract requires and nothing else" is replaced by the procedure. **The `base` pairing test**
  (`skills/backlog/tools/backlog.test.mjs`, "backlog-orchestrate hands the reviewer a base and the reviewer diffs against it") is rewritten in part:
  - kept as is: orchestrate §7 still lists its parameter `` - `base` — this run's base branch ``; the agent still declares `` **`base`** — ``; the agent still
    says `Five fields, always` / `If any of the five is missing` (§4 keeps five required fields); the two `main`-hardcoding negatives;
  - rewritten: `git -C <worktree> diff <base>...<branch>` becomes `git -C <worktree> diff <from> <to>`;
  - added, in `review.test.mjs`: full mode's `from` is the merge base of the given base and HEAD (never `main` when another base is given) — the pairing the
    old diff-string assertion stood for.
- Merge-commit `Reviewed:` line, tracker snapshots and `references/recovery.md` unchanged.

### 7. Reviewer model and effort (user's decisions: configurable from Settings, server-side, overridable per launch)

Today the model is the agent's frontmatter `model: opus` and effort is never set. The frontmatter stays as the fallback; `scope` writes a `model` and
`effort` into each group from a **reviewer config**, and every entry point passes them on each dispatch through the Agent tool's `model` and `effort`.

**The config:**

- `mode`: `same` | `split`.
- `same`: one `{ model, effort }` pair for every group.
- `split`: a `big` pair, a `small` pair, `smallMaxLines` (default **300**). A group at or below `smallMaxLines` uses `small`, above it `big`. **Group 1
  always uses `big`** — it carries the item checks, and on a diff below the grouping threshold it is the only group.
- Models: the Agent tool's `model` values (`opus`, `sonnet`, `haiku`, `fable`) plus "agent default" (send none — the frontmatter's `opus`). Effort: the
  Agent tool's `effort` values (`low`, `medium`, `high`, `xhigh`, `max`) plus "default" (send none). Source: the Agent tool schema of the installed Claude
  Code (checked in the authoring session, 2026-11-12), not the dashboard's lists in `shared/agent.ts`. Fallback: if a dispatch is refused for its `model`
  or `effort`, the caller re-dispatches that group once without the refused field and the merged report says so.
- **An invalid value, per surface** (deliberately not one rule — the model/effort drop rule and merge mode's reject rule differ for stated reasons in
  `orchestrate-args.service.ts`):
  - `POST /api/settings/review` — **400**, nothing written: it is the file's one writer and must never write a config the tool would have to repair.
  - Launch request override — **400**: the sheet offers only the closed values, so a bad value is a client bug, and silently reviewing on a model the user
    did not pick is worse than a refused launch.
  - Trigger flag on a typed `/backlog-review` — `review.mjs scope` exits non-zero naming the flag, before any dispatch.
  - `review.json` as read by `review.mjs` (missing, unparseable or invalid) — the default config, with one warning line on stderr; a review never fails
    because of the settings file.
- **Default config:** `split`; `big` = agent default (Opus) + default effort; `small` = `sonnet` + default effort; 300 lines. A small diff therefore keeps
  exactly today's review.

**Where it lives and how it travels:**

1. **Server-side** `~/.backlog-manager/settings/review.json`, the server its only writer (the watchdog/timezone precedent). `GET` and `POST
   /api/settings/review` in `server/src/settings/`, shaped like `timezone.controller.ts`: GET unguarded; POST behind `SameOriginPostGuard`,
   `@HttpCode(200)`, answering the config it wrote. An existing `review.json` that is unparseable or invalid: GET answers the default config plus
   `"fileError": true`, and the next valid POST replaces the file.
   A new Settings group on the **Shared** page (`SettingsView.tsx`, scope `shared`, beside `TimeZoneGroup`), its own component file. Copy:
   - Group title `Reviewer`, pill `this machine` (the repo's scope pill for host-file settings).
   - Row `Models` — segmented control `Same for all groups` / `Big and small groups`.
   - Same: rows `Model` and `Effort`.
   - Split: rows `Big groups — model`, `Big groups — effort`, `Small groups — model`, `Small groups — effort`, `Small group limit` (number input, hint
     `Groups with at most this many changed lines use the small pair. The first group always uses the big pair.`).
   - Model options `Agent default (Opus)`, `Opus`, `Sonnet`, `Haiku`, `Fable`; effort options `Default`, `Low`, `Medium`, `High`, `XHigh`, `Max`.
   - On `fileError`, a hint under the title: `review.json could not be read — showing defaults. Saving replaces it.`
2. **Launch sheets** — the Orchestrate sheet (`client/src/components/board/orchestrate/`, `useOrchestrateDraft`) and execute's launch sheet for a
   `--finish pr` launch — seed a `Reviewer` picker (the same rows) from it and can override per launch. The launch request (`shared/types.ts`) carries the
   override; the server validates it (400 on any invalid member, §7 above) and appends the flags to the spawned trigger:
   - model and effort values are appended as compile-time literals chosen from the closed lists — no caller character reaches the prompt;
   - `smallMaxLines` is the one caller-supplied number: **proved** (`Number.isInteger`, 1 ≤ n ≤ 10000; else 400) and then formatted, like `base` is proved
     by `resolveBase` rather than clamped;
   - order in the orchestrate trigger: after `ids`, the mode flags and ` --base <ref>` — ids stay first, as `dispatch-watchdog.md` requires;
   - an execute has no composed trigger, only the server-appended finish clause, where flags count only inside the backticks (`pr-mode.md` §1): the
     reviewer flags go inside those backticks after `--base <base>` and after `--auto-merge --fix` when present —
     ``Finish with `--finish pr --base <base> [--auto-merge [--fix]] --review-…`: …`` — and execute's Finish-mode parse accepts them only in `pr` mode (an
     `in-place` execute dispatches no reviewer);
   - an execute or groom dispatch body that spells a `--review-` flag is a **400**, joining that rule file's `--finish` / `--base` / `--auto-merge` /
     `--fix` list, so the reviewer flags reach a prompt only from the validated field.
3. **Trigger flags** on `/backlog-orchestrate`, `/backlog-execute` and `/backlog-review`: present → used; absent → `review.mjs` reads `review.json`;
   missing or invalid file → the default config. So a typed `/backlog-review` honours Settings, and an older board keeps working.
4. **Orchestrate run file**: the driver runs `review.mjs config` with the trigger's reviewer flags and passes its JSON line to `orchestrate.mjs init
   --review-config <json>`, which records it on the run file after checking only that it is a JSON object — `orchestrate.mjs` imports nothing from
   `review.mjs` and reads no `review.json`, so no twin is needed (`.claude/rules/skills.md`: a tool imports nothing from another skill). Every `scope` the
   driver runs then gets the recorded config through `--review-config`, so a `--resume`d driver dispatches with the same models; `scope` validates it. Run
   detail shows it beside the merge mode (my call; the builder places it), as `Reviewer: <model> · <effort>` for `same` and `Reviewer: big <model> ·
   <effort>, small <model> · <effort> up to <n> lines` for `split`, an unset model reading `Agent default` and an unset effort `Default`. A run file
   written before this change has no reviewer config: a `--resume`d driver uses the default config (never the current `review.json`, which may have changed
   since the run began), and Run detail shows `Reviewer: default`.
5. **Launch to another machine.** An override is validated by this server against the closed lists above and travels as trigger flags; the target
   machine's `review.mjs` uses them. With no override, the target machine's own `review.json` applies — the tool runs there.
6. A fix loop's re-review keeps each group's model and effort from the first round.

The plan's UI tasks end with `/ui-verify` (global rule). No mocks: the new rows and picker follow the existing `SettingsRow` and sheet-picker patterns.

### 8. Cost note

Above the threshold a review is N dispatches instead of one; with the default config most non-first groups run on Sonnet. Below it, cost is unchanged
apart from two cheap tool calls. Incremental re-reviews cost less than today's full re-read.

## Acceptance

- `pnpm test:skills` covers `review.mjs`:
  - **scope:** each skip reason; snapshot of a dirty tree includes a modified tracked file, a new untracked file, excludes an ignored file, and leaves the
    real index and working tree byte-identical; clean tree → `to` = HEAD's tree; full `from` = merge base, and with `--base` other than `main` it is that
    base's merge base; no grouping at or below both thresholds, grouping above either; a test/source pair never split; same input → same groups; bucket over
    the cap split; one file or pair over the cap → its own group; empty diff → `"files":0`, no groups; every file skipped → group 1 alone (with an item or an
    open earlier finding) or no group (with neither); per-group model/effort from `same`, from `split` (small, big, group 1 always big), from flags
    overriding the file, from a missing/invalid file → defaults; an invalid flag → non-zero exit naming it; `--previous` keeps the partition, puts a new
    file in group 1, marks `rerun` for group 1 and changed groups only, and hands out the previous open findings.
  - **config:** flags → those; no flags → `review.json`; missing/invalid file → defaults with one stderr warning.
  - **mode selection:** no state → full; all conditions hold → incremental; base ref changed → full, `base changed`; merge-base moved → full, `base moved`;
    recorded HEAD not an ancestor → full, `history rewritten`; snapshot gone → full, `earlier snapshot gone`; `full` forces full; incremental with no change
    → the no-change line, no dispatch.
  - **merge:** coverage complete → empty `uncovered`; missing line, `not reviewed`, or a missing report file → listed; a `--retry` report's coverage counts
    for any file; a `--carried` report counts for coverage while its `fix` verdict and findings are ignored; uncovered → verdict `incomplete` and state file
    untouched; anchors — exact, trimmed, nearest of several, none → kept and `(unanchored)`; de-dup — same resolved `path:line` keeps the highest severity and
    both texts when they differ, identical quoted text on different lines stays two findings, unanchored never merged; earlier finding marked `resolved` →
    closed, `open` → open, unmarked → open; verdict `fix` on a re-run group's fix / new Critical-Important / still-open earlier, `approve` otherwise; `minor`
    count on stdout with no Minor line printed; merged report keeps the `verdict:` line and `## Critical` / `## Important` headings; state file rewritten
    with the HEAD and merge-base commits.
- Jest (`test/`): the settings route reads/writes `review.json` and rejects an invalid config; the launch request's reviewer override is validated and
  turned into trigger flags; the Settings group and sheet picker render and round-trip.
- Existing orchestrate tests pass, the `base` pairing test with exactly the rewrite §6 names and no other existing assertion changed.
- `/ui-verify` on the Settings "Reviewer" group and the two launch-sheet pickers.
- **After merge, `pnpm run plugin:sync` and a Claude Code restart** (the agent and skills load from the installed plugin), a hand run in this repo: a small
  change → one dispatch, full; a second `/backlog-review` after another edit → incremental, earlier findings reported; one above the threshold (synthetic
  branch is fine) → N concurrent dispatches with their configured models; `full` → full; the offer to fix appears and its fix commits nothing. This is the
  plan's last task, not a merge gate; before merge, the tests above are the gate.

## Left to the builder

- Internal structure of `review.mjs`; the repo key and state-file naming; flag spelling.
- Exact lockfile / generated lists; bucketing depth; pairing heuristics beyond the examples.
- Removed-code findings: anchor to nearest surviving line, or resolve against `from`.
- Whether thresholds are also flags.
- Wording of the agent-file, procedure and skill-text edits, within the behaviour above.
- Where Run detail shows the reviewer config.

## Calls made by the author (not decided by the user)

- Deterministic grouping (pairing, then directory); thresholds 12 files / 1200 lines, cap 10 / 800 — starting guesses.
- Group 1 alone does item checks, against the whole branch even in incremental mode.
- One coverage retry, then review failure (orchestrate parks with the existing `parked` kind).
- Unanchored findings kept and marked; any group may raise any-file findings at full severity; merge de-duplicates by anchor.
- The incremental snapshot is a git tree written through a temporary index (loose objects only).
- Orchestrate and execute always review `full` on the first pass; they write the state file so a later `/backlog-review` is incremental from the gate's
  review.
- The standalone fix commits nothing and is capped at two rounds per invocation.
- No board button for `/backlog-review` in this change.
- Incremental mode requires an unchanged merge-base and the last reviewed HEAD as an ancestor; every earlier finding is re-marked by a group, never closed
  by which files changed.
- Invalid reviewer values: 400 at the settings route and launch request, a refusal for a typed flag, defaults for an unreadable `review.json`.
- Settings copy, the Shared page placement and `smallMaxLines` bounds 1–10000.
- End-to-end hand run is post-merge; tests gate the merge.

## Decided by the user

- Carry coverage, anchors and grouping from OCR; not the self-check filter.
- The reviewer stays `agents/backlog-reviewer.md`.
- Re-review after a fix loop in orchestrate/execute: touched groups plus group 1.
- Reviewer model **and effort** configurable as one pair for all groups or big/small pairs with a line threshold; group 1 on the big pair; seeded into the
  launch sheets and overridable per launch; recorded in the run file.
- The config lives server-side (Settings → Shared → Reviewer; the name and page are the author's call), so a typed run honours it.
- Review runnable on its own (`/backlog-review`), e.g. after `/backlog-execute`, covering uncommitted work.
- CodeRabbit-style incremental re-review by default; `full` reviews the whole branch.
- Offer to fix after a standalone review.
