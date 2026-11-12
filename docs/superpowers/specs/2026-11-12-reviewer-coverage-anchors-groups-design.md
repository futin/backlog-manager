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
- **The canonical report path moves.** Orchestrate's merge commit says `Reviewed: <verdict> (reviews/<id>-<k>.md)`; the board and `references/recovery.md`
  read `<dir>/reviews/<id>-<k>.md`. The merged report is written exactly there.
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

`scope --tree <W> --base <B> [--item <path>] [--mode full|incremental] [--state <file>] [--review-config <json>] --out <manifest.json>`

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

Prints one line: `{"mode":…,"files":n,"review":r,"skip":s,"groups":g}`.

### 3. Reviewed-state memory and incremental mode

**State file**, outside the repo: `~/.backlog-manager/reviews/<repo key>/<branch>.json` (repo key and file name the builder's call; a detached HEAD has no
state and always reviews full). It holds the last review's `to` snapshot, `base`, the merged report's path, a timestamp, and the **open findings** — every
Critical/Important from that review, with its anchor, not yet shown resolved.

`merge` writes it at the end of every review, full or incremental. Orchestrate and execute pr-mode reviews write it too (they review `backlog/<id>` and
`execute/<id>` branches, so a later `/backlog-review` on that branch is incremental from the gate's review).

**Mode selection** (in `scope`): `full` when asked; otherwise `incremental` when a state file exists for this branch, its `base` matches, and its snapshot
still resolves in this repo; otherwise `full`, with the reason printed (`no earlier review`, `base changed`, `earlier snapshot gone — history rewritten or
pruned`). An incremental scope with no changes says so and stops without dispatching anyone; the earlier verdict stands.

**Earlier findings in an incremental review.** Each open finding whose anchored file the incremental diff does not touch is **carried forward unchanged and
still open** — no LLM needed. Each open finding whose file the diff does touch goes to the group that owns that file, which marks it `resolved` or `open`
in its report (format §4). The verdict counts every still-open finding: an incremental review returns `approve` only when it finds nothing new at
Critical/Important **and** every earlier one is resolved.

**Item checks in incremental mode.** Group 1's item-level checks (§4) judge the item against the **whole** branch (`<merge-base>` → `to`), not the
increment — whether the change keeps the item's promise is a property of the branch, not of the last commit.

### 4. `review.mjs merge`, anchors, and the agent file

**`merge --manifest <M> --reports <g1.md> … --out <report.md> [--state <file>]`:**

- **Coverage.** Every `review` file must be listed in the `## Coverage` section of its group's report. Prints the uncovered list.
- **Anchors.** Each Critical/Important entry carries `anchor: <path> | <one exact line of code copied from that file in to>`. Resolution against `to`,
  comparing whitespace-trimmed lines: one match → that line; several → nearest to the claimed line; none → keep the claimed line, mark `(unanchored)`. **Never
  dropped or downgraded by resolution.** Findings about removed code anchor to the nearest surviving line and say so (or the builder resolves them against
  `from`; never drop).
- **De-duplication.** Findings sharing an anchor (path + quoted line) collapse to one, keeping the highest severity.
- **Earlier findings.** Carries forward untouched ones; applies the groups' `resolved`/`open` marks to the rest.
- **Verdict.** `fix` if any group says `fix`, any new Critical/Important exists, or any earlier finding is still open; otherwise `approve`.
- **Merged report** at `--out`, in the agent file's report structure, plus: mode (`full`/`incremental`, with `from`/`to`), the groups with their model and
  effort, a `## Earlier findings` section (resolved / still open). Group reports stay on disk beside it.
- **State file** rewritten (§3).
- **Stdout**, the only thing a caller reads into context: `{"verdict":…,"mode":…,"uncovered":[…],"unanchored":n,"stillOpen":n}`, then one line per
  Critical/Important in the agent file's message shape (`path:line — Severity: text`), lines resolved, earlier still-open ones marked `(earlier)`.

**`agents/backlog-reviewer.md` changes:**

- **Inputs.** The diff is given as `from` and `to` (from the manifest) instead of being derived from `base` and `branch`; `base` stays for the item-level
  checks and for orchestrate's tests. `item file path` becomes optional: absent means no item — a pure code review, item checks skipped. New optional
  inputs: `manifest path`; `group` (`<n> of <N>` and its files); `item checks` (`yes` for group 1 only); `earlier findings` (the open findings whose files
  this group owns). A dispatch without `manifest path` behaves exactly as today, so an older caller keeps working.
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
  tracker project, a temp snapshot of the issue body (pr-mode §7's shape). Without `<id>`: no item, pure code review.
- **Reports** under `<tmpdir>/backlog-review/<repo key>/<branch>-<n>.md` (+ `.g<k>.md`, manifest beside), never in the repo.
- Runs `references/procedure.md`. Then shows the user: mode (and why, if it fell back to full), the verdict, the resolved finding lines, earlier findings
  resolved / still open, and the report path. Not the report body.
- **Coverage failure:** said plainly, with the uncovered files and report paths; no verdict is claimed.
- **Offer to fix** (user's decision): when the verdict is `fix` or there are Minor findings, and the session can ask (AskUserQuestion available — not a
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
- **Coverage failure.** Orchestrate parks the item with the existing kind — `attention <id> --kind parked --detail "review incomplete — not covered:
  <paths>"`, then `stage <id> parked` — so no new attention kind (the set is closed across `orchestrate.mjs`, `shared/types.ts`, the server and the
  client). Execute does not push and reports it in §4's failure shape.
- **`verdict: fix`.** The fix loop as today, except the findings copied verbatim into `<dir>/prompts/<id>-fix-<n>.txt` (orchestrate) or acted on (execute)
  are the merge tool's resolved lines, plus the merged report path.
- **Re-review after a fix loop (user's decision): only the groups whose files the fix changed, plus group 1.** Groups come from the item's first `scope`
  (never re-partitioned); a fixed file outside that manifest joins group 1; untouched groups' reports are carried forward into `merge` unchanged and their
  findings still count. A one-group review re-runs its single group, as today. (This is deliberately not the standalone incremental mode: a gate re-reads
  each touched group's whole files, not just the fix commit's lines.)
- Orchestrate's dispatch text "the four fields its input contract requires and nothing else" is replaced by the procedure; the test pinning the `base`
  pairing keeps passing.
- Merge-commit `Reviewed:` line, tracker snapshots and `references/recovery.md` unchanged.

### 7. Reviewer model and effort (user's decisions: configurable from Settings, server-side, overridable per launch)

Today the model is the agent's frontmatter `model: opus` and effort is never set. The frontmatter stays as the fallback; `scope` writes a `model` and
`effort` into each group from a **reviewer config**, and every entry point passes them on each dispatch through the Agent tool's `model` and `effort`.

**The config:**

- `mode`: `same` | `split`.
- `same`: one `{ model, effort }` pair for every group.
- `split`: a `big` pair, a `small` pair, `smallMaxLines` (default **300**). A group at or below `smallMaxLines` uses `small`, above it `big`. **Group 1
  always uses `big`** — it carries the item checks, and on a diff below the grouping threshold it is the only group.
- Models: the Agent tool's (`opus`, `sonnet`, `haiku`, `fable`) plus "agent default" (send none — the frontmatter's `opus`). Effort: `low` … `max` plus
  "default" (send none). An unrecognised value falls through to the default, as dispatch `model`/`effort` already do
  (`server/src/agents/orchestrate-args.service.ts`).
- **Default config:** `split`; `big` = agent default (Opus) + default effort; `small` = `sonnet` + default effort; 300 lines. A small diff therefore keeps
  exactly today's review.

**Where it lives and how it travels:**

1. **Server-side** `~/.backlog-manager/settings/review.json`, the server its only writer (the watchdog/timezone precedent). A new **Settings → "Review"**
   group (`client/src/components/settings/SettingsView.tsx`), marked per-server like the watchdog's: the `same`/`split` switch, then one model + effort row,
   or the big pair, the small pair and the line threshold. Read and written through a settings route under `/api`.
2. **Launch sheets** — the Orchestrate sheet (`client/src/components/board/orchestrate/`, `useOrchestrateDraft`) and execute's launch sheet for a
   `--finish pr` launch — seed a reviewer picker from it and can override per launch. The launch request (`shared/types.ts`) carries the override; the server
   validates it as `resolveMergeMode` validates merge mode and appends compile-time-literal flags to the spawned trigger.
3. **Trigger flags** on `/backlog-orchestrate`, `/backlog-execute` and `/backlog-review`: present → used; absent → `review.mjs` reads `review.json`;
   missing or invalid file → the default config. So a typed `/backlog-review` honours Settings, and an older board keeps working.
4. **Orchestrate run file**: `init` records the effective config, so a `--resume`d driver dispatches with the same models. Run detail shows it beside
   the merge mode (my call; the builder places it).
5. A fix loop's re-review keeps each group's model and effort from the first round.

The plan's UI tasks end with `/ui-verify` (global rule). No mocks: the new rows and picker follow the existing `SettingsRow` and sheet-picker patterns.

### 8. Cost note

Above the threshold a review is N dispatches instead of one; with the default config most non-first groups run on Sonnet. Below it, cost is unchanged
apart from two cheap tool calls. Incremental re-reviews cost less than today's full re-read.

## Acceptance

- `pnpm test:skills` covers `review.mjs`:
  - **scope:** each skip reason; snapshot of a dirty tree includes a modified tracked file, a new untracked file, excludes an ignored file, and leaves the
    real index and working tree byte-identical; clean tree → `to` = HEAD's tree; full `from` = merge base; no grouping at or below both thresholds, grouping
    above either; a test/source pair never split; same input → same groups; bucket over the cap split; per-group model/effort from `same`, from `split`
    (small, big, group 1 always big), from flags overriding the file, from a missing/invalid file → defaults.
  - **mode selection:** no state → full; state + same base + resolvable snapshot → incremental; base changed → full with reason; snapshot gone → full with
    reason; `full` forces full; incremental with no change → stop, no dispatch.
  - **merge:** coverage complete → empty `uncovered`; missing or `not reviewed` → listed; anchors — exact, trimmed, nearest of several, none → kept and
    `(unanchored)`; de-dup keeps highest severity; earlier finding in an untouched file → carried and still open; marked `resolved` → closed; verdict `fix`
    on any group fix / new Critical-Important / still-open earlier, `approve` otherwise; merged report has every section; state file rewritten.
- Jest (`test/`): the settings route reads/writes `review.json` and rejects an invalid config; the launch request's reviewer override is validated and
  turned into trigger flags; the Settings group and sheet picker render and round-trip.
- Existing orchestrate tests pass unchanged, including the `base` pairing test.
- `/ui-verify` on the Settings "Review" group and the two launch-sheet pickers.
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
- End-to-end hand run is post-merge; tests gate the merge.

## Decided by the user

- Carry coverage, anchors and grouping from OCR; not the self-check filter.
- The reviewer stays `agents/backlog-reviewer.md`.
- Re-review after a fix loop in orchestrate/execute: touched groups plus group 1.
- Reviewer model **and effort** configurable as one pair for all groups or big/small pairs with a line threshold; group 1 on the big pair; seeded into the
  launch sheets and overridable per launch; recorded in the run file.
- The config lives server-side (Settings → Review), so a typed run honours it.
- Review runnable on its own (`/backlog-review`), e.g. after `/backlog-execute`, covering uncommitted work.
- CodeRabbit-style incremental re-review by default; `full` reviews the whole branch.
- Offer to fix after a standalone review.
