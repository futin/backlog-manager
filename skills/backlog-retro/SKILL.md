---
name: backlog-retro
description: >
  Sweep every orchestrator run this machine has produced into one report: what the
  pipeline cost, where the time went, how much of it was rework, and what changed since
  the last sweep. Use it for /backlog-retro, retro the orchestrator, how did the runs do,
  sweep the runs, what did the pipeline cost, where is the money going, or how much of our
  spend is fix loops. It proposes backlog items from what it finds and files only the ones
  you pick, then records the sweep so the next one has something to be measured against.
  It reads run state and never writes it, never edits an item and never commits.
  Trigger: /backlog-retro
trigger: /backlog-retro
---

# /backlog-retro — measure the pipeline, then improve it

This skill is the historian of `backlog-orchestrate`. A tool sweeps every run
file, headless session log, reviewer report and verify status on this machine
into one deterministic JSON; you turn that JSON into a report, a short list of
proposed backlog items, and a record the *next* sweep is compared against.

**The tool computes and you judge, and the split is the whole design.** Cost per
merged item, stage durations, fix-loop rate, context floor and peak are
arithmetic — done by hand they came out differently on every attempt, done by
`retro.mjs` they come out the same every time. Whether a reviewer's Important
finding was prose drift, a test that could not fail, or a real defect is not
arithmetic, and no amount of regex will make it so. Your turns go there.

It is **not** `kaizen`. That skill's unit is one Claude Code transcript and it
knows nothing about `~/.backlog-manager`; this one's unit is the whole run
corpus. `kaizen` stays the per-session post-mortem, and it is the sink for the
one lesson line this skill banks at the end (§5).

A retro is only useful the second time. "Fix loops are 38% of dispatched items"
is a number; "31%, after task-28 landed" is a finding. That is what the record
is for, and why `record` refuses to overwrite one.

## 1. Sweep

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-retro/tools/retro.mjs" sweep --json > <scratch>/sweep.json
```

Read that file. **Do not recompute anything it already holds** — every figure in
the report comes out of this JSON, and when a number needs tracing, cite the row
that carries it (`runId`, `itemId`, `file`). `--text` renders the same facts as
tables if you want to eyeball them first; `--project <abs path>` scopes the sweep
to one project.

Exit `0` on any readable run-state home, an empty one included: `runs: []` is an
answer. Exit `1` is a usage error, an unreadable home, or a `--project` this
machine has no run state for.

What it will not tell you, and says so in `caveats[]`: runs from before the
driver lease landed have no measured orchestrator spend (`no-lease`); a machine
with fewer than eight measured sessions gets no fitted rates and therefore no
all-in figure (`rates`); an item two runs dispatched has one transcript with two
possible owners (`collision`); a session still running or killed has no cost
(`killed`); sessions past the long-context tier are priced by a fit that does
not model that tier (`long-context`).

## 2. Label the fix-verdict reviews

For **every** review in `reviews[]` whose `verdict` is `fix` — and only those —
read its `critical` and `important` excerpts and assign exactly one label:

- **`drift`** — another statement of the old contract was left standing. The
  change was right; some other file still describes the world before it.
- **`red-proof`** — a new test that still passes with the change reverted. It
  asserts something that was already true, which is the same as asserting
  nothing.
- **`defect`** — the change itself was wrong.
- **`other`** — anything the three above genuinely do not cover.

Write `<scratch>/labels.json`:

```json
{ "reviews": { "<project>/reviews/<file>": "drift" | "red-proof" | "defect" | "other" },
  "candidates": [ { "title": "…", "kind": "bug" | "task" | "idea", "project": "…",
                    "evidence": "…", "effect": "…",
                    "status": "filed" | "declined" | "deferred", "filedAs": "<id>" } ] }
```

The keys of `reviews` are exactly the `file` values the sweep printed.
`candidates` is filled in §4. The label set is **closed** — it is exactly
`drift | red-proof | defect | other` — and `record` refuses anything outside it,
so a typo can never become a fifth category the next sweep dutifully counts.

## 3. Write the report

Markdown, in this fixed section order so two reports diff cleanly:

1. **Headline** — spend, cost per merged item, rework share, context re-read,
   median item wall.
2. **Where the money went** — by actor (execute / fix / retry / driver), by
   token type, by project, bugs versus tasks.
3. **Where the time went** — by stage, queue wait reported separately and never
   summed into pipeline time, then outcomes.
4. **The fix loop** — verdict counts, your labels from §2, what a loop costs,
   the resume tax.
5. **Defects and gaps found** — each with the evidence rows it rests on.
6. **Decisions that are not defects** — things that look wrong and are not.
7. **Method and caveats** — `caveats[]` verbatim.
8. **Deltas since the previous record**, or `first record — no previous sweep`.

Numbers come from the JSON; the prose is yours. **Every estimated figure is
marked estimated every time it is printed** — the driver's spend and anything
all-in are fitted, not billed, and a reader who cannot tell the fitted third of
the bill from the billed two thirds is being misled by the report.

Write it into the session's scratch directory. `record` (§5) is what copies it
beside the record; this skill never writes under the retro home itself. If an
Artifact tool is available, publish the same content as a page too — that is a
convenience, and the Markdown beside the record is the copy of record.

## 4. Propose, then file what was picked

Draft candidates from §3's defects and gaps. A finding earns a candidate only if
it has **at least two occurrences**, or **one occurrence of a correctness or
security class**. Drop any whose title `previous.candidates` already shows as
`filed` or `declined` — the record exists so the same thing is not proposed
every month.

Put them to the person in **one** multi-select `AskUserQuestion`, each option
carrying its evidence and its expected effect. Then, for each picked candidate,
follow `backlog-capture`'s procedure verbatim — `init`, then `new` → write, one
item at a time — **in the target project's root**:

- **Pipeline candidates** — anything about the orchestrator, the skills, the
  reviewer or the tools — go to the registered project whose path holds
  `skills/backlog-orchestrate/tools/orchestrate.mjs`.
- **A candidate about one project's own code** — a flaky test, a build that
  leaves ignored output — goes to that project.

Record every candidate's status in `labels.json`: what you filed is `filed` with
its `filedAs` id, what was not picked is `declined`. When `AskUserQuestion` is
not available in the session, **propose in prose and file nothing** — filing is
the person's call, not a default.

## 5. Record, and bank one lesson

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-retro/tools/retro.mjs" record \
  --sweep <scratch>/sweep.json --labels <scratch>/labels.json --report <scratch>/report.md
```

Exit `2` means a record for this sweep already exists: nothing was written, and
the fix is a **new sweep**, never an edit. Exit `1` names the first label or
status outside its closed set.

Then, if `~/.claude/session-analytics-log.md` exists, append **one** line — one
per sweep, never one per project, so kaizen's cross-project count is not
inflated by a sweep that spans four — in kaizen's own grammar:

```
- <YYYY-MM-DD> [backlog-manager] <session-id>: retro over <n> runs, <m> items, <k> projects (≈$<spend>; <fix-loop share> rework). Lesson: <one takeaway>.
```

`<session-id>` is the short prefix of `$CLAUDE_CODE_SESSION_ID`. Append with a
shell redirect and `grep` the line back to prove it landed. **If the file does
not exist, skip this silently** — the sink is optional, the record is not.

`retro.mjs last` prints the newest record's path, or exits `3` when there is
none yet.

## Hard limits

- **Never writes under the run-state home or `~/.backlog-manager/settings`.**
  `run.json` keeps its one writer (`orchestrate.mjs`) and the registry keeps
  its one (`backlog.mjs`). `retro.mjs record` is the only writer of
  `~/.backlog-manager/retro/`, and `sweep` opens that directory read-only.
- **Never edits an item, never moves one, never commits.** Filing goes through
  `backlog-capture`, which owns item files.
- **Never reads an execute transcript.** The headless logs already carry the
  cost. The one Claude Code transcript this skill may open is a run's driver,
  by the session id the run file recorded.
- **Never files without a pick.** Unpicked is `declined`, and it is recorded.
- **Reports an estimated figure as estimated every time it prints it.**
- **Never overwrites a record.** A record is evidence; a wrong one is
  superseded by the next sweep, not corrected in place.

## Next

`references/rationale.md` beside this file holds the 2026-09-06 baseline the
first record is measured against, and why the label set is closed.
