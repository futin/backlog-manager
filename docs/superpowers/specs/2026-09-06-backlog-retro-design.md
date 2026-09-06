# backlog-retro — design

A sixth skill, `backlog-retro`, that sweeps every orchestrator run this
machine has produced and turns the corpus into a report, a set of proposed
backlog items and a record the next sweep is measured against. The numbers
come from a deterministic tool, `skills/backlog-retro/tools/retro.mjs`; the
judgment — what a fix-loop finding was *about*, which findings deserve an
item, what the report should say — stays with the session running the
skill. Nothing here changes `orchestrate.mjs`, the run file, the server or
the board.

Companion to `2026-09-05-orchestrate-question-mode-design.md` and the
watchdog specs in the sense that it is another consumer of the run-state
directory; unlike the server it is not a live reader but a historian.

## Why this exists

On 2026-09-06 the first cross-run sweep was done by hand: 27 runs, 83
items, four projects, 92 headless sessions, 91 reviews. It took a session
about sixty tool calls and three wrong turns to establish that the pipeline
had spent roughly $800, that 18% of it was fix loops, and that nineteen of
the twenty-nine fix verdicts were one of two things the executing session
could have checked itself. It filed seven items (bug-31, bug-32, task-27,
task-28, task-29, idea-8, idea-9). Every one of those findings was sitting
in files the orchestrator already writes; none of them was visible from
any surface the plugin has.

Two things about that sweep argue for a skill rather than a note saying
"do it again sometime":

- **The numbers are recomputable and the judgment is not.** Cost per item,
  stage durations, fix-loop rate, park reasons, context floor and peak are
  arithmetic over `run.json`, the `result` event at the end of each
  `logs/<id>.jsonl`, and the `verdict:` line of each review. Done by hand
  they came out differently on each attempt (two searches returned nothing
  because the transcript directories start with `-`). Done by a tool they
  come out the same every time, and the session's attention goes to the
  part only a session can do: reading a reviewer's Important finding and
  saying whether it was prose drift, a test that could not fail, or a real
  defect.
- **A retro is only useful the second time.** The value of "fix loops are
  31% of items" is the next sweep saying "24%, after task-28 landed". That
  needs a record of what was measured and what was proposed, kept somewhere
  the next sweep can find it and the run state's single writer never
  touches.

`kaizen` was considered as the home for this and rejected: its unit is one
Claude Code transcript, it reads nothing under `~/.backlog-manager`, it is a
global skill that must not learn this plugin's file shapes, and its own
review mode sweeps its lessons log rather than run files. It stays what it
is — the per-session post-mortem, and the sink for this skill's one-line
lesson.

## Non-goals

- **No server endpoint and no Runs-view mode.** The board could one day
  render the newest record; that is a separate design once records exist.
  This skill runs in a session and writes files.
- **No walk over execute transcripts.** The headless logs already carry
  per-message usage and a `result` event with cost; the 2026-09-06 sweep's
  transcript pass added tool-mix detail that changed no conclusion. The one
  transcript the tool may open is the driver's, by the session id the
  run file records, because nothing else measures the orchestrator's own
  spend.
- **No dependency on `kaizen.mjs`** or any skill outside this plugin. The
  plugin has to work on a machine that has only the plugin.
- **No automatic filing.** Candidates are proposed; the person picks;
  capture files. Declined candidates are recorded so they are not proposed
  again.
- **No scheduling and no nudge from `orchestrate.mjs`.** The retro is run
  when someone runs it; the report ends by saying how many runs have landed
  since the previous record.
- **No change to `orchestrate.mjs`, `run.json`, or the sidecar layout.**
  task-27 (usage stamped on the run file) and idea-8 (run-scoped sidecars)
  make the sweep cheaper and more exact; neither is a prerequisite, and the
  tool says which of the two it is working without.
- **No writes anywhere but `~/.backlog-manager/retro/`** (and, through
  `backlog-capture`, the item files that skill already owns).

## 1. Vocabulary

- **sweep** — one execution of `retro.mjs sweep`: every project's run
  state read once, one JSON out.
- **record** — a sweep plus the session's judgments, written by
  `retro.mjs record` to `~/.backlog-manager/retro/<generatedAt>.json` with
  the rendered report beside it as `<generatedAt>.md`. `$BM_RETRO_HOME`
  overrides the directory, for the same reason `$BM_ORCH_HOME` exists.
- **deltas** — the sweep's headline measures compared against the newest
  record, when one exists.
- **candidate** — a proposed backlog item: a kind, a title, the evidence,
  the expected effect, and after the question a status.
- **label** — the session's reading of one fix-verdict review, from the
  closed set `drift` (another statement of the old contract was left
  standing), `red-proof` (a new test that still passes with the change
  reverted), `defect` (the change itself was wrong), `other`.
- **driver** — the orchestrating session of a run, as distinct from the
  execute sessions it dispatches and the reviewer subagents it launches.

## 2. The tool — `skills/backlog-retro/tools/retro.mjs`

Plain node, ESM, zero dependencies, invoked from anywhere: it needs no git
root and no project cwd, because its subject is every project at once. It
carries its own copies of `orchHome()` and `projectDir()` — the run-state
path functions `orchestrate.mjs` and `orchestrator.service.ts` each already
duplicate, for the reason CLAUDE.md gives: one skill's `tools/` may never
import another's, and the server may not import the `.mjs`. It reads
`~/.backlog-manager/registry.json` (`$BM_REGISTRY_FILE`) once, read-only,
to print project names beside paths; a run-state directory whose project is
not registered is still swept, labelled by its decoded path.

### 2.1 `sweep`

```
retro.mjs sweep [--json | --text] [--project <abs path>] [--home <dir>]
```

Reads, for every `<orchHome>/<encoded project>/`:

- **run files** — `run.json` and every `runs/*.json`. Per run: id,
  project, status, `startedAt`, `updatedAt`, `mergeMode`,
  `mergeModeEffective`, `questionMode`, `driver` (when present), attention
  entries verbatim. Per queue item: id, title, final stage, `fixLoops`,
  `note`, `permissionMode`, the `verification` array reduced to
  `{cmd, ok}` pairs plus, for each failing entry, the failing test names
  and error lines extracted from its tail with ANSI stripped, and **stage
  durations**: `stageAt` entries sorted by timestamp, consecutive pairs
  differenced, `fixing` its own stage, `pending` reported separately as
  queue wait and never summed into pipeline time. `usage` entries
  (task-27) copied verbatim when present.
- **logs** — every `logs/*.jsonl`. The file name classifies the session:
  `<id>.jsonl` execute, `<id>-fix-<n>.jsonl` fix loop `n`,
  `<id>-retry-<n>.jsonl` retry `n`. From the last `type: "result"` event:
  `total_cost_usd`, `num_turns`, `duration_ms`, the four token counts,
  `permission_denials` count, `is_error`, and a `terminated` field that is
  `spend-limit` when `is_error` and the result text names a spend limit,
  `error` for any other `is_error`, else `ok`. From every `assistant`
  event's `usage`: context per message (`cache_read + cache_creation +
  input`), reduced to `floor` (the smallest of the first three), `peak`,
  `messages`. A log with no `result` event is reported with
  `result: null` and counted as killed. A log whose item has a `usage`
  entry for the same `sessionId` is cross-checked, not re-derived: the run
  file wins on disagreement and the tool notes the mismatch.
- **reviews** — every `reviews/*.md`: the item id and pass number from the
  file name, the `verdict:` line, and the text of the `## Critical` and
  `## Important` sections verbatim (a section that reads `None.` is
  reported as empty). No categorisation happens here; that is §3.2.
- **verify** — `verify/<id>.status` when present.
- **driver** — when a run file carries `driver.sessionId`, the tool looks
  for `~/.claude/projects/<key>/<sessionId>.jsonl`, where `<key>` is the
  project path with every `/` and `.` replaced by `-` (Claude Code's own
  project directory key, observed on this machine as
  `-Users-andrejajevtic-Documents-custom-projects-backlog-manager` and
  `…--worktrees-bug-26`). From it: turns (assistant messages carrying
  usage), context per turn, totals of the four token counts, and the
  subagent count and token sum from the task-notification lines the
  transcript holds (each carries the agent's exact `<subagent_tokens>`
  figure; an agent with no notification counts as unmeasured, never as
  zero). Absent or unreadable → `driver: null` with `reason`
  (`no-lease`, `not-found`, `unreadable`). Every run before bug-19's lease
  reads `no-lease`, and the report says so once rather than per run.

**Joins.** Logs and reviews attach to items by `(project, itemId)`. Until
idea-8 lands the sidecar directories are flat and a later run's files
replace an earlier run's, so when an item was dispatched in more than one
run the tool attaches the log to the **latest** run that dispatched it and
lists the collision under `caveats`. When `usage` entries exist the join is
by `sessionId` instead and the caveat disappears for that item.

**Rates.** Dollar figures exist only where `total_cost_usd` was recorded.
For anything measured in tokens alone — the driver — the tool fits
per-token rates by ordinary least squares over the measured sessions
(regressors: cache read, cache creation, output, input; sessions with a
positive cost only), solving the four normal equations directly. It
requires at least eight measured sessions, else `rates: null` and the
driver stays in tokens. The fit ships with `maxResidualUsd` and every
figure priced with it carries `estimated: true`. The 2026-09-06 fit gave
cache read $0.50/M, cache creation $10.0/M, output $24.8/M, max residual
$8.83 on the one session that crossed the long-context tier; the tool does
not model that tier and says so in `caveats`.

**Output** (`--json`, the default) is one `RetroSweep` object:

- `generatedAt`, `home`, `projects[]` (`{path, name, runs, items}`),
- `runs[]`, `items[]`, `sessions[]`, `reviews[]` as above, each row keyed
  so the skill can cite it (`runId`, `itemId`, `file`),
- `totals` — runs, items by final stage, sessions by kind and
  `terminated`, measured cost, estimated driver cost, merged count, cost
  per merged item (measured and all-in), pipeline minutes by stage, queue
  wait, fix loops (count, items affected, direct cost, minutes),
  verdicts (approve / fix by pass), context (`floor`, `peak` medians by
  project), first-verify failures with their extracted test names,
- `previous` — `null`, or the newest record's `generatedAt` and, for each
  headline measure above, `{then, now, delta}`, plus the record's
  candidates so the skill can skip declined ones and check filed ones.
  This is the one place `sweep` opens the retro home, and it opens it
  read-only; `record` stays that directory's only writer,
- `caveats[]` — the join collision list, `no-lease` count, the rate-fit
  note, killed sessions.

`--text` prints the same facts as tables for a person; `--project` limits
the sweep to one registered path. Exit `0` on any readable home, an empty
one included (`runs: []` is an answer); `1` for a usage error or an
unreadable home.

### 2.2 `record`

```
retro.mjs record --sweep <sweep.json> --labels <labels.json> --report <report.md> [--home <dir>]
```

Writes `<retroHome>/<generatedAt>.json` — the sweep verbatim under `sweep`,
the labels file under `labels`, the session id under `recordedBy`
(`CLAUDE_CODE_SESSION_ID`, or `unknown`) — and copies the report to
`<generatedAt>.md` beside it. **This command is the only writer of that
directory**, and it refuses to overwrite: an existing `<generatedAt>.json`
is exit `2`, nothing written, because a record is evidence and the fix for
a wrong one is a new sweep, not an edit. `1` for a missing or unparsable
input. The labels file is the skill's, shape in §3.2; the tool validates
that every label is one of the four and every candidate status one of
`filed | declined | deferred`, and refuses (`1`) otherwise, so a typo cannot
become a category the next sweep counts.

### 2.3 `last`

```
retro.mjs last [--home <dir>]
```

Prints the newest record's path, or exits `3` with a one-line note when
there is none yet — the same "nothing exists" code `orchestrate.mjs status`
uses, for the same reason.

## 3. The skill — `skills/backlog-retro/SKILL.md`

Trigger `/backlog-retro`. Runs from any directory. The body is the
procedure below and the hard limits; the measurement rationale lives in
`references/rationale.md` beside it, so the skill's own text stays short
enough to re-read.

### 3.1 Sweep

Run `sweep --json` into the session's scratch directory and read it. Do not
recompute anything the JSON already holds; when a number in the report has
to be traced, cite the row (`runId`, `itemId`, `file`) the JSON carries.

### 3.2 Label

For every review in `reviews[]` whose verdict is `fix`, read the Critical
and Important excerpts and assign one label from §1. Write
`labels.json`:

```
{ "reviews": { "<project>/reviews/<file>": "drift" | "red-proof" | "defect" | "other", … },
  "candidates": [ { "title", "kind": "bug" | "task" | "idea", "project", "evidence", "effect",
                    "status": "filed" | "declined" | "deferred", "filedAs"?: "<id>" }, … ] }
```

`candidates` is filled in §3.4; the labels are the session's reading and
the one place judgment enters the record, which is why the record keeps
them separate from the sweep.

### 3.3 Report

Write a Markdown report in this fixed order, so two reports diff cleanly:
headline (spend, per merged item, rework share, context re-read, median
item wall); where the money went (by actor, by token type, by project,
bugs versus tasks); where the time went (by stage, queue wait separately,
outcomes); the fix loop (verdict counts, labels, cost of a loop, the resume
tax); defects and gaps found, each with its evidence rows; decisions that
are not defects; method and caveats (`caveats[]` verbatim, every
`estimated` figure marked); deltas since the previous record, or "first
record" when `previous` is null. Numbers come from the JSON; prose is the
session's. Write it into the session's scratch directory — `record` (§3.5)
is what copies it beside the record, so the skill itself never writes
under the retro home. When an Artifact tool is available, publish the same
content as a page as well — that is a convenience, and the Markdown beside
the record is the copy of record.

### 3.4 Propose, then file what was picked

Draft candidates from the report's defects and gaps: only findings with at
least two occurrences or one occurrence of a correctness or security
class, and none that `previous.candidates` shows as `filed` or `declined`
for the same title. Put them to the person in **one** multi-select
`AskUserQuestion`, each option carrying evidence and expected effect. For
every picked candidate, follow `backlog-capture`'s procedure verbatim
(`init`, then `new` → write → `new` → write, one at a time) in the target
project's root: pipeline candidates — anything about the orchestrator,
the skills, the reviewer, the tool — go to the registered project whose
path holds `skills/backlog-orchestrate/tools/orchestrate.mjs`; a candidate
about one project's own code (a flaky test, a build that leaves ignored
output) goes to that project. Record every candidate's status; unpicked
ones are `declined`. When `AskUserQuestion` is unavailable, propose in
prose and file nothing — filing is the person's call.

### 3.5 Record and bank

Run `record` with the sweep, the labels and the report. Then, if
`~/.claude/session-analytics-log.md` exists, append **one** line in
kaizen's lesson grammar, tagged `[backlog-manager]` — one line per sweep,
not per project, so kaizen's cross-project count is not inflated by a
sweep that spans four — using a shell append and grepping it back. The
line's shape is kaizen's:

```
- <YYYY-MM-DD> [backlog-manager] <session-id>: retro over <n> runs, <m> items, <k> projects (≈$<spend>; <fix-loop share> rework). Lesson: <one takeaway>.
```

with `<session-id>` the short prefix of `CLAUDE_CODE_SESSION_ID`. If the
file does not exist, skip silently: the sink is optional, the record is
not.

### 3.6 Hard limits

- Never writes under `<orchHome>` or `~/.backlog-manager/settings`, never
  edits an item, never moves one, never commits.
- Never reads an execute transcript; the one transcript it may open is the
  driver's, by recorded session id.
- Never files without a pick.
- Reports an `estimated` figure as estimated every time it prints it.

## 4. Documents

- `CLAUDE.md` Layout: the skill list gains `backlog-retro`, one sentence
  each for the tool and the skill, with the pointer to this spec.
- `CLAUDE.md` Invariants, one new bullet: **`~/.backlog-manager/retro/`
  has exactly one writer, `retro.mjs record`, and `backlog-retro` never
  writes under the run-state directory** — the same relationship
  `registry.json` and `run.json` each have with their writer, stated for
  the third directory under `~/.backlog-manager` that a tool owns.
- `README.md`: the skill count and list (task-24 is rewriting that file;
  whichever lands second carries the sixth skill).
- `skills/backlog-retro/references/rationale.md`: the 2026-09-06 sweep's
  headline numbers as the baseline the first record will be compared
  against, and the reasons for the closed label set.

## 5. Testing

`skills/backlog-retro/tools/retro.test.mjs`, under node's own runner so
`pnpm run test:skills` picks it up by glob. Fixtures are built in a tmp
directory per test, never read from the real home. The implementation
plan specifies behaviour and expected values for these, not code:

- **sweep, two projects, three runs** (one current, one archived, one in a
  second project): every run and item appears once; project names come
  from a fixture registry; an unregistered project is swept and labelled
  by path.
- **stage durations**: an item with `pending → preflight → dispatched →
  inspecting → reviewing → fixing → verifying → merging → merged` yields
  eight spans with `fixing` its own and `pending` under queue wait only.
- **sessions**: an execute log with a `result` event yields cost, turns,
  tokens, `terminated: ok`, floor and peak from the assistant usages; a
  `-fix-1` log is kind `fix` loop 1; a log with no `result` is
  `result: null` and counted killed; a result whose text names a spend
  limit is `terminated: spend-limit`.
- **usage precedence**: an item carrying a task-27 `usage` entry is joined
  by `sessionId`, the log's figures are cross-checked, a disagreement is
  noted and the run file's value kept.
- **collision caveat**: an item dispatched in two runs attaches its log to
  the later run and appears in `caveats`.
- **reviews**: `verdict: fix` with Critical `None.` and an Important
  paragraph yields an empty Critical excerpt and the paragraph verbatim;
  pass number parsed from `<id>-2.md`.
- **driver**: a run with `driver.sessionId` and a fixture transcript at the
  derived key yields turns and token totals; without the file,
  `driver: null, reason: not-found`; without the lease, `no-lease`.
- **rates**: eight synthetic sessions priced from known rates are fitted
  back to within 1e-6 per token; seven sessions yield `rates: null` and an
  unpriced driver.
- **deltas**: with a fixture record in the retro home, `previous` carries
  `then / now / delta` for each headline measure and the record's
  candidates; without one, `previous: null`.
- **record**: writes `<generatedAt>.json` and `.md`, refuses a second write
  with exit `2` and identical bytes, refuses a label outside the four or a
  status outside the three with exit `1` and nothing written.
- **last**: prints the newest path; exit `3` on an empty home.
- **exit codes**: unreadable home `1`; empty home `0` with `runs: []`.

Skill prose has no runner; the checks that stand in: the SKILL.md carries
the five steps and six limits above; `CLAUDE.md` names the skill and the
invariant; `pnpm test` unchanged and green.

## 6. Sequencing

Delivered as one backlog task whose Plan points at this document's
implementation plan, groomed after the current run ends and queued through
the orchestrator like any other item. It has no dependency on task-27 or
idea-8: the tool is specified to work with or without either, and the
first record is more useful taken *before* they land, so their effect
shows in the second. It should land after or beside task-24 so README's
skill list is edited once. Publishing is the usual: commit, push,
`pnpm run plugin:sync`, new skill visible on the next restart.

## 7. Decisions taken, and what they cost

- **Tool computes, skill judges.** Costs a second copy of two path
  functions and a JSON contract to keep. Buys numbers that are the same on
  every run and a session that spends its turns on the labels and the
  prose, not on `grep`.
- **Run-state directory required, driver transcript optional.** Costs a
  `driver: null` branch and a `no-lease` caveat for every run before
  2026-09-06. Buys a plugin that measures on any machine it is installed
  on and never depends on a personal skill.
- **Rates fitted, not hard-coded.** Costs an `estimated` flag the report
  must carry and a minimum of eight measured sessions. Buys a figure that
  follows the pricing the CLI actually applied rather than a table that
  goes stale.
- **Labels by the session, closed set, validated by the tool.** Costs one
  judgment pass per retro. Buys categories a later sweep can compare and a
  typo that cannot become a fifth category.
- **Propose, pick, file.** Costs one question per retro. Buys a board that
  holds what a person chose to hold, and a record of what was declined so
  it is not asked again.
- **Own directory, own single writer, refuses overwrite.** Costs a new
  path under `~/.backlog-manager` and a `$BM_RETRO_HOME` override. Buys
  the run-state directory keeping its one writer, and records that are
  evidence rather than a mutable summary.
- **One kaizen line per sweep.** Costs nothing. Buys an honest
  cross-project count in the one log that promotes rules on it.
