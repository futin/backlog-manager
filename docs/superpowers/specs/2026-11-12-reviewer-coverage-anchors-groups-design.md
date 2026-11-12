# backlog-reviewer: file coverage, quoted-code anchors, grouped review of big diffs — design

Date: 2026-11-12. Branch: `feat/reviewer-coverage-anchors-groups`.

## Intent and why

`agents/backlog-reviewer.md` is the only gate between an unattended item branch and the run's base (orchestrate §7), and the review a person trusts on a
`--finish pr` PR (execute `references/pr-mode.md` §7). Today it is one Opus agent that reads `git diff <base>...<branch>` whole and returns a verdict.

The user inspected alibaba/open-code-review (OCR, Apache-2.0, a Go review CLI) and wants three of its engineering ideas carried into this reviewer — not
to fix a known failure, but because they harden the parts a single language-driven agent cannot guarantee by itself:

1. **Deterministic file coverage.** OCR decides in code which files must be reviewed and records each one's outcome, so no file is silently skipped. A single
   agent on a large diff "cuts corners" — reads some files, skims others — and its report gives no way to tell which.
2. **Quoted-code anchors.** OCR's re-location step finds the exact snippet a comment is about, so positions do not drift. Here the reviewer's `path:line` is
   trusted as written, and the fix loop narrow-reads exactly that line (orchestrate §7: "the findings name `file:line`, which is what a narrow read needs").
   A drifted line sends the fixer to the wrong code.
3. **Grouped review of big diffs.** OCR bundles related files and reviews each bundle as an isolated sub-agent, which stays stable on very large change sets.

Explicitly not carried over (the user chose against it): OCR's comment filter / self-verification pass. Also not carried over: OCR's per-language rule docs
— this reviewer already does rule matching better, from the repo's own `CLAUDE.md` invariants and `.claude/rules/*.md` by `paths:`.

## Goals

- Every file the diff touches is either reviewed or skipped for a stated, mechanical reason, and a tool — not the reviewer's own word — proves every
  reviewed file appears in the report.
- Every Critical/Important finding carries the exact code it is about; a tool resolves that quote to the real line, so the `path:line` the fix loop reads is
  correct even when the reviewer miscounted.
- A diff above a size threshold is split into groups of related files, each reviewed by its own `backlog-reviewer` dispatch with a fresh context, and the
  group results merge into one report and one verdict.
- Both callers (orchestrate §7, execute pr-mode §7) get all three through the same tool, so the two never drift.

## Non-goals

- No self-check / finding filter (user's call).
- No LLM in grouping or anchoring. Both are deterministic code, unit-tested.
- No change to severity definitions, the mechanical verdict rule, the fix-loop budget (two), or who commits. (The reviewer model does change — §5.)
- No change to what the reviewer checks or its order (correctness, invariants, tests, Outcome lines).
- No new language rule docs.

## Anti-goals — failures even if it "works"

- **The orchestrator's context fills with review prose.** The output contract (verdict + one line per Critical/Important) is the reason the agent file exists;
  N group reviewers must each still return only that, and the merge tool must print a compact result, not report bodies.
- **The canonical report path moves.** The merge commit's `Reviewed: <verdict> (reviews/<id>-<k>.md)` line, the board, and `references/recovery.md` read
  `<dir>/reviews/<id>-<k>.md`. The merged report is written exactly there.
- **Grouping loses cross-file review.** A rename that missed a call site in another group, or an invariant broken across two files, must still be catchable.
  Every group reviewer sees the full file list and may read any file in the worktree; only its findings are scoped.
- **A small diff gets slower or costlier.** Below the threshold there is exactly one reviewer dispatch, as today.
- **A coverage gap is billed to the executor.** A file the reviewer failed to cover is a review failure, not a defect in the item's code, and must never
  spend one of the item's two fix loops.

## Constraints

- `agents/` and `skills/` reach a running Claude Code only after commit, push and `pnpm run plugin:sync` (CLAUDE.md invariant). `agents` is already in
  `PUBLISHED_PATHS`.
- The reviewer has no `Write`/`Edit` tool and writes only its report via a heredoc. That stays.
- A sub-agent cannot dispatch sub-agents, so grouping is done by the **caller** (orchestrate / execute), never by the reviewer.
- Node tools live beside the skill and their tests are `skills/*/tools/*.test.mjs` (flat — the glob does not descend). Run with `pnpm test:skills`.
- New prose wraps at 160 columns (repo convention).

## Design

### Overview

```
caller (orchestrate §7 / execute pr-mode §7)
  1. review-tool scope   → manifest: every file, review|skip+reason; groups (1 below threshold)
  2. dispatch one backlog-reviewer per group, all in ONE message      → each writes <base>.g<n>.md
  3. review-tool merge   → coverage check, anchor resolution, merged <id>-<k>.md, compact JSON result
  4. uncovered files?    → one re-dispatch for just those files, then merge again
     still uncovered     → review failure (see "Coverage failure"), never a fix loop
  5. verdict from merge  → approve: continue as today; fix: fix loop with the merge's resolved finding lines
```

### 1. The review tool

One new node script, used by both callers. My call on its home: `skills/backlog/tools/review.mjs`, since `backlog` is the shared skill both callers already
depend on; the builder may place it elsewhere if a shared location fits better, as long as both callers call the same file. Three subcommands.

**`scope --worktree <W> --base <B> --branch <BR> --out <manifest.json>`**

Reads `git -C <W> diff --numstat <B>...<BR>` (three dots, the given base — same reasons as the agent file's "The diff under review") and
`--name-status` for renames/deletes. Writes the manifest and prints a one-line summary (`{"files":n,"review":r,"skip":s,"groups":g}`).

Per file: `path`, `oldPath` (renames), `status`, `added`, `deleted`, `decision` (`review` | `skip`), `reason` (skips only). Skip reasons, a closed set:

- `lockfile` — `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, and peers the builder finds worth listing.
- `generated` — under `dist/` or another build-output directory the repo ignores for review.
- `binary` — numstat reports `-`.
- `deleted` — the file no longer exists on the branch (its removal is still visible in the diff for any reviewer who needs it as context).
- `item` — the item's own markdown file (its lifecycle move); the reviewer already reads it as the contract.

Everything else is `review`. Exact lists are the builder's call; the reason set is closed so the merge tool and tests can rely on it.

**Grouping.** If the reviewable files exceed a file-count or changed-line threshold, partition them; otherwise one group holding all of them. Starting values,
soft and constants in the tool: group when more than **12** reviewable files or more than **1200** changed lines; cap each group at **10** files or
**800** changed lines. Deterministic, in this order:

1. Pair each test file with the source it tests when a pairing is evident from names (`foo.test.mjs` ↔ `foo.mjs`, `x.spec.ts` ↔ `x.ts`, `test/x.test.ts` ↔
   the one `x.ts` the diff touches). A pair is never split.
2. Bucket by directory prefix (the builder picks the depth that keeps `server/src/<module>/`, `client/src/<area>/`, `skills/<skill>/` together).
3. Split a bucket over the cap; fold a bucket of one file into its nearest sibling bucket while the cap allows.
4. Order groups and files within them stably (by path), so the same diff always yields the same groups.

Each group has a `label` (its common prefix) and its `files`.

**`merge --manifest <M> --reports <g1.md> [<g2.md> …] --worktree <W> --branch <BR> --out <id>-<k>.md`**

- **Coverage.** Every `review` file must appear in exactly the `## Coverage` section of the report for the group that owns it (format below). Prints the
  uncovered list.
- **Anchors.** For every Critical/Important entry, resolve its anchor (below) and rewrite its `path:line` to the resolved line.
- **Verdict.** `fix` if any group report says `verdict: fix` or any resolved Critical/Important exists; otherwise `approve`. (The groups' verdicts already
  follow mechanically from their findings; the merge recomputes rather than trusts.)
- **Merged report** at `--out`: the agent file's report structure, one `## What I reviewed` listing the groups and reports merged, findings concatenated per
  severity with resolved lines, `## Coverage` combined, `## Checked and clean` concatenated. Group reports stay on disk beside it as evidence.
- **Stdout**, compact and the only thing the caller reads into context: `{"verdict":…,"uncovered":[…],"unanchored":n}` on the first line, then one line per
  Critical/Important finding in the agent file's message shape (`path:line — Severity: text`), lines already resolved.

**`anchor`** need not be a separate subcommand; it is the resolution step `merge` runs. Expose it separately only if a test or a caller needs it.

### 2. Anchor resolution

Each Critical/Important entry in a report carries one line:

```
anchor: <path> | <one exact line of code copied from that file on the branch>
```

Resolution, against the file at `<BR>` (`git -C <W> show <BR>:<path>`): compare after trimming leading/trailing whitespace. One match → that line. Several
→ the one nearest the line the reviewer claimed. None → keep the claimed line and mark the finding `(unanchored)` in both the merged report and the stdout
line. **A finding is never dropped or downgraded by resolution** — a wrong position is a navigation problem, not evidence the finding is wrong.

A finding about code the diff removed has no line on the branch; the reviewer anchors it to the nearest surviving line around the removal and says so in
the text. The builder may instead resolve against `<B>` for such findings if that proves cleaner; either way, never drop.

### 3. Agent file changes (`agents/backlog-reviewer.md`)

**New optional dispatch inputs** (the five required fields are unchanged; a dispatch without these reviews the whole diff, exactly as today, so an older
caller keeps working):

- `manifest path` — the scope manifest. With it, the reviewer reviews every `review` file of its group and treats `skip` files as context only.
- `group` — `<n> of <N>` and the group's file list. Its `## Coverage` duty is those files only. It may — and for cross-file questions should — read any
  file in the worktree and the full manifest, and **it may raise a finding at full severity about any file**: another group's file, a file the diff never
  touched (a missed call site), the item file, or `CLAUDE.md`. Severity follows the defect, never which group spotted it — a Critical demoted to Minor
  because it sat in a sibling group would merge unattended. The merge tool de-duplicates findings that share an anchor (same path and quoted line), keeping
  the highest severity.
- `item checks` — `yes` for exactly one group (group 1), `no` for the rest. Only the `yes` reviewer judges the diff against the item's `## Plan` /
  `## Fix` as a whole, the `## Test cases` coverage, and the `Contract sweep:` / `Red proof:` lines (checks 1's "does what the item promised", 3's
  test-case coverage, and 4). Every group still does correctness, invariants and test adequacy for its own files.

**Report additions:**

- A `## Coverage` section, one line per `review` file of its group: `- <path> — clean`, `- <path> — findings`, or `- <path> — not reviewed: <reason>`.
  Honest `not reviewed` is allowed and is exactly what the merge treats as uncovered.
- Every Critical/Important entry carries an `anchor:` line (format above). Minor entries may.

**Returned message:** unchanged — verdict line plus one line per Critical/Important. The caller uses the merge tool's lines, not these, for the fix loop.

The diff command stays `git -C <worktree> diff <base>...<branch>`, narrowed with `-- <group files>` when a group is given.

### 4. Caller changes

Both orchestrate `SKILL.md` §7 and execute `references/pr-mode.md` §7:

- Run `scope` first. Group report paths: orchestrate `<dir>/reviews/<id>-<k>.g<n>.md`, execute `<tmp>/review-<k>.g<n>.md`; the manifest beside them
  (`<id>-<k>.manifest.json` / `review-<k>.manifest.json`). All outside the repo, as today's report path is.
- Dispatch one reviewer per group **in a single message** so they run concurrently, each with the five required fields (report path = its group path) plus
  the three optional ones. One group → one dispatch, `group` = `1 of 1`, `item checks: yes`.
- Run `merge` with `--out` = the canonical path (`<dir>/reviews/<id>-<k>.md` / `<tmp>/review-<k>.md`). Read only its stdout.
- **Uncovered files** → one more reviewer dispatch with `group` = just those files (`item checks: no`), report `…g<N+1>.md`, then `merge` again with every
  report.
- **Coverage failure** — still uncovered after that one retry: this is a review failure, not a `fix` verdict, and it never spends a fix loop. Orchestrate
  parks the item with the existing kind — `attention <id> --kind parked --detail "review incomplete — not covered: <paths>"`, then `stage <id> parked` —
  so no new attention kind is needed (the set is closed across `orchestrate.mjs`, `shared/types.ts`, the server and the client). Execute does not push and
  reports it in §4's failure shape, naming the uncovered files and the report paths.
- **`verdict: fix`** → the fix loop as today, except the "findings, verbatim" copied into `<dir>/prompts/<id>-fix-<n>.txt` (orchestrate) or acted on
  (execute) are the merge tool's resolved lines, plus the merged report path. Unanchored findings go through as they are, marked.
- **Re-review after a fix loop (user's decision): only the groups whose files the fix changed, plus group 1.** The caller takes the fix commit's changed
  files (`git -C <W> diff --name-only <pre-fix sha> <BR>`), re-dispatches every group owning one of them, and always re-dispatches group 1 (`item checks:
  yes` — it re-reads the Outcome lines and the new `### Fix loop <n>` record). Groups are those of the **first** `scope` of this item, so loop 2 never
  re-partitions; a fix that touches a file outside the manifest adds it to group 1. `merge` takes the new group reports plus the untouched groups' reports
  from the previous round, carried forward unchanged, and writes `<id>-<k+1>.md`. A carried-forward report's findings still count toward the verdict. A
  one-group review simply re-runs its single group, as today.
- The orchestrate dispatch text "the four fields its input contract requires and nothing else" is updated to name the optional fields; the existing test that
  pins the `base` pairing keeps passing.
- Merge-commit `Reviewed:` line and tracker snapshot handling are unchanged — they already point at `<id>-<k>.md`.

### 5. Reviewer model per group (user's decision: size rule plus an override)

Today the model is fixed by the agent file's frontmatter, `model: opus`. That frontmatter stays as the default; the choice moves into the manifest and the
caller passes it on each dispatch through the Agent tool's `model` parameter.

- **Size rule, in `scope`.** Each group gets a `model` field. Group 1 is always `opus`: it carries the item-level checks, and on a diff below the grouping
  threshold it is the only group, so **a small diff keeps exactly today's Opus review**. Every other group is `sonnet` when its changed lines are at or
  below a threshold (starting value **300**, a soft constant), `opus` above it.
- **Override.** A `--review-model <opus|sonnet>` flag forces one model for every group. My call on where it lives: a trigger flag on
  `/backlog-orchestrate` (recorded in the run file like the run's other launch choices, so a `--resume`d driver uses the same model) and on `/backlog-execute`
  (session-scoped). `scope` takes it as `--model <m>` and writes it into every group. No board UI in this change; a Settings default and a launch-sheet
  picker are a follow-up.
- A fix loop's re-review uses the same per-group models as the first round (groups come from the first `scope`).
- The merged report's `## What I reviewed` names each group's model, so a reader can weigh a Sonnet-reviewed group accordingly.

### 6. Cost note

Above the threshold a review becomes N Opus dispatches instead of one. That is accepted for big diffs (OCR's own numbers show the isolated-context approach
costs fewer tokens overall than one agent wading through a large diff, but that is their benchmark, not ours). Below it, cost is unchanged apart from two
cheap tool calls.

## Acceptance

- `pnpm test:skills` covers the tool: skip classification for each closed reason; no grouping at or below both thresholds; grouping above either; a
  test/source pair never split; identical input → identical groups; a bucket over the cap split; coverage — every review file covered → empty `uncovered`,
  one missing or `not reviewed` → listed; anchor — exact match, whitespace-trimmed match, nearest of several, no match → kept and `(unanchored)`;
  verdict — any group `fix` → `fix`, all approve with no Critical/Important → `approve`; merged report written at `--out` with every severity section.
- The existing orchestrate tests pass unchanged, including the `base` pairing test.
- A hand run on a real item branch in this repo (one small, one above the threshold — a synthetic branch is fine) shows: one dispatch for the small one; N
  concurrent dispatches for the big one; merged report at the canonical path; stdout of the merge is the only review text the caller read. The agent loads
  from the installed plugin, so this run happens **after** merge, `pnpm run plugin:sync` and a Claude Code restart — it is the plan's last task, not a merge
  gate. Before merge, the tool tests above are the gate.

## Left to the builder

- The tool's file location (within the "both callers call the same file" rule) and its internal structure.
- Exact lockfile / generated lists; directory depth for bucketing; exact pairing heuristics beyond the examples.
- Whether removed-code findings resolve against the base or anchor to the nearest surviving line.
- Whether threshold values are flags as well as constants.
- Wording of the agent-file and skill-text edits, within the behaviour above.

## Calls made by the author (not decided by the user)

- Grouping is deterministic (no LLM), by test/source pairing then directory.
- Group 1 alone does the item-level checks.
- One coverage retry, then review failure — never a fix loop.
- Unanchored findings are kept and marked, never dropped.
- Small diffs also go through `scope` + `merge` (one uniform path), with the group report at `.g1.md` and the merged one at the canonical path.
- Threshold numbers (12 files / 1200 lines; cap 10 files / 800 lines) are starting guesses.
- Any group may raise Critical/Important about any file; merge de-duplicates by anchor.
- A coverage failure parks the item with the existing `parked` attention kind.
- The end-to-end hand run is post-merge (after plugin sync and restart); the tool tests gate the merge.

- The model override is a trigger flag (run-file recorded for orchestrate), not a board setting; Sonnet threshold 300 changed lines is a starting guess.

Decided by the user: scope (coverage, anchors, grouping; no self-check filter); the reviewer stays `agents/backlog-reviewer.md`; re-review after a fix
covers touched groups plus group 1; the reviewer model is chosen per group by a size rule, with an override that forces one model.
