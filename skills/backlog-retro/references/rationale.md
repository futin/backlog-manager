# backlog-retro — why it is shaped this way

Kept beside `SKILL.md` rather than inside it so the skill's own text stays
short enough to re-read on every invocation. Nothing here is procedure; it is
the reasoning behind the procedure, plus the baseline the first record is
measured against.

## Why a tool computes and a session labels

On 2026-09-06 the first cross-run sweep was done entirely by hand. It took a
session about sixty tool calls and three wrong turns to establish that the
pipeline had spent roughly $800, that a fifth of it was rework, and that
nineteen of the fix verdicts were one of two things the executing session could
have checked itself. Two of its searches returned nothing because Claude Code's
transcript directories begin with a `-`, which `grep` and `ls` read as an
option.

Both halves of that sentence matter, and they pull in opposite directions:

- **The numbers are recomputable and were computed wrongly.** Cost per item,
  stage durations, fix-loop rate, context floor and peak are arithmetic over
  `run.json`, the `result` event at the end of each `logs/<id>.jsonl`, and the
  `verdict:` line of each review. Done by hand they came out differently on each
  attempt. Done by `retro.mjs` they come out the same every time, which is the
  only property that makes two sweeps comparable at all.
- **The judgment is not recomputable and must not be faked.** Reading a
  reviewer's Important finding and saying whether it was prose drift, a test
  that could not fail, or a real defect is the part of a retro that is worth a
  session's attention. A regex that guessed at it would produce a category
  count that looked exactly as authoritative as the cost figures and would be
  worth nothing.

So the tool never labels, and the skill never recomputes.

## Why the label set is closed, and why a typo is an error

Four labels — `drift`, `red-proof`, `defect`, `other` — and `record` exits `1`
naming the first value outside them.

The point of a label is the *next* sweep. "19 of 27 fix verdicts were drift or
red-proof" is only a finding if the sweep after it can say "11 of 24, after
task-28 landed", and that comparison is arithmetic over the recorded strings. A
single `nit`, `Drift` or `red proof` silently becomes a fifth category that
neither sweep counts and the difference reads as improvement. `other` exists so
there is always a correct answer that is not a new word.

## Why the driver's spend is fitted rather than looked up

Every dispatched `claude -p` session ends its transcript with a `result` event
carrying `total_cost_usd` — the price the CLI actually applied. The
orchestrating session writes nothing about itself at all: its transcript is full
of token counts and contains no cost.

A hard-coded price table would answer that, and would go stale silently the day
pricing moved or the account changed tier. Instead the tool fits four per-token
rates by ordinary least squares over the sessions that *did* report a cost, and
prices the driver with them. It requires at least eight measured sessions, ships
`maxResidualUsd` so a reader can see how well the fit did, and marks every
figure derived from it `estimated: true` in JSON and `est.` in text — every
time it is printed. The tier that applies past ~200k tokens of context is not
modelled and the sweep says so in `caveats[]` rather than quietly absorbing the
error.

## The 2026-09-06 baseline

The figures below are the tool's own, scoped to runs that started at or before
`2026-09-06T21:03:30Z` — the moment of the hand sweep. They are what the first
record's deltas should be read against.

| measure | 2026-09-06 |
|---|---|
| runs | 27 |
| items queued | 83 |
| items dispatched | 66 |
| merged (incl. `branched`) | 59 |
| headless sessions | 92 |
| measured spend | **$540.71** |
| rework spend (`fix` + `retry` sessions) | $114.52 — 21.2% of measured |
| fix loops | 29 loops on 26 of 66 dispatched items (39%) |
| reviews | 91 — 64 `approve`, 27 `fix` |
| first-pass reviews | 63 — 25 came back `fix` (40%) |
| median merged item, wall | 37.4 min (27.5 without a fix loop, 60.4 with) |
| fitted rates | cache read $0.50/M, cache creation $10.00/M, output $24.85/M |
| max fit residual | $8.83, on the one session that crossed the long-context tier |

Two figures the hand sweep reported that this tool deliberately does **not**
reproduce, and why:

- **"≈$800 all-in", of which ≈$249 was orchestrator sessions.** No run at that
  cutoff carried a driver lease — bug-19 introduced it on 2026-09-07 — so every
  pre-lease run reads `no-lease` and its orchestrating session is reported as
  *unmeasured*, not as free. The hand sweep found those transcripts by
  searching; this tool opens exactly one transcript per run, by recorded session
  id, which is what keeps it inside its own "no walk over transcripts" limit.
  The consequence is that the all-in figure only becomes meaningful for runs
  from 2026-09-07 onwards, and the first record is where that starts.
- **"19 of 29 fix verdicts were drift or red-proof."** The tool counts 27
  fix verdicts at that cutoff, not 29; the hand sweep's denominator included
  reviews it could see and this tool attributes outside the window. The 19 is a
  judgment and is not recomputable at all — it is precisely the kind of number
  that only exists because a session sat and read the excerpts, which is why
  §2 of the skill exists and why the record keeps `labels` in its own key.

## What a record costs and buys

One directory (`~/.backlog-manager/retro/`), one `$BM_RETRO_HOME` override, one
refusal to overwrite. In exchange: the run-state directory keeps its single
writer, and a record is evidence rather than a mutable summary. The fix for a
record you disagree with is the next sweep, never an edit to this one.
