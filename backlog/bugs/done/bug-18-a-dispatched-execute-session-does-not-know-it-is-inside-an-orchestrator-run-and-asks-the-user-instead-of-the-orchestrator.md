---
id: bug-18
title: A dispatched execute session does not know it is inside an orchestrator run, and asks the user instead of the orchestrator
created: 2026-09-05
tags: orchestrate, execute, skills, board
updated: 2026-09-05T21:50:09Z
groom-elapsed: 195
groom-tokens: 32612
started: 2026-09-05T21:38:26Z
execute-elapsed: 703
execute-tokens: 61010
---

## Symptom

An execute session dispatched by `backlog-orchestrate` has nothing in its
context saying so. Its prompt is the plain `/backlog-execute <id>` trigger, its
cwd is a worktree, and both read exactly like a session a human started by
hand. Two things follow, and both were observed in one run:

1. **The session treats the user as its escalation channel.** During
   `run-20260905-113818` (bug-16), the user messaged the session from the
   dashboard with "commit and push to main". The session correctly declined —
   the run's own §6 commit would then find nothing staged, exit `1`, and park
   the item, stalling `task-13`/`task-14`/`task-15` behind it — but it declined
   *by explaining and offering an override to the user*, which is the wrong
   channel. Anything a dispatched session cannot resolve belongs to the
   orchestrator (`attention <id> --kind parked`, `stage <id> parked`), which is
   already what the orchestrate SKILL.md prescribes for a session with "no
   channel to ask through". The rule is stated only for the case where no
   channel exists; a session that *has* one uses it.
2. **The user cannot tell either.** The board shows a run strip and a card's
   run bar, but the dashboard conversation with a dispatched session carries no
   marker at all, so the person answering it has no cue that a run owns this
   work. In the user's own words: "I keep forgetting that this is part of
   orchestration."

The cost is not hypothetical: the queue sat idle across three message
round-trips while a human and a headless session negotiated something the run
was already going to do by itself.

## Repro

1. Start an orchestrator run from the board over a project with a queued item.
2. Once the item reaches stage `dispatched`, open that session in the
   claude-agents-dashboard.
3. Nothing in the session's prompt, transcript header or dashboard row says it
   belongs to `run-<id>`, or that its item is one of N in a queue.
4. Send it any instruction that conflicts with the run's own next step
   (`commit and push to main` is the sharp case). It answers the user.

## Affects

- `skills/backlog-orchestrate/SKILL.md` §5 — the dispatch prompt is the plain
  trigger; it is the one place a run could tell the session what it is
- `skills/backlog-orchestrate/SKILL.md` §5's parked/attention lines — the "no
  channel to ask through" rule that should be unconditional for a dispatched
  session, not conditional on the channel's absence
- `skills/backlog-execute/SKILL.md` — has no notion of running inside a run at
  all; its hard limits say "never commits, never pushes" but not "never
  escalates to the user"
- `client/src/components/board/RunStrip.tsx` / `ItemCard.tsx` — where the board
  already knows the run→item→session mapping, and the dashboard link does not
  carry it

## Cause

Three independent gaps. The observed failure needed all three, and each is
worth fixing on its own.

**1. The dispatch prompt is the entire run→session channel, and it carries
nothing but the trigger.** `skills/backlog-orchestrate/SKILL.md` §4's dispatch
line is `exec claude -p "/backlog-execute <id>"`. That string is the only thing
the run ever hands the session — after it, the two processes share nothing but
a directory — and it spends all of itself on the trigger. Everything else the
session could infer is genuinely ambiguous: a worktree cwd is also what a human
makes by hand, and a `backlog/<id>` branch is also what a *previous* run leaves
behind for a hand-merge (§3's archive-move probe exists precisely because that
state is indistinguishable from outside).

**2. A dispatched session has a live user channel the run never gave it and
does not know about.** The dashboard reads every local session straight off
`~/.claude/projects/*/*.jsonl`, so a `nohup`ed headless `-p` session is a row
in it like any other, with its chat drawer and its `reply?` tab. A remote
message is delivered by blocking that session's `Stop` hook with the user's
text as `reason`, which re-opens the finished turn and feeds the text in as the
model's next instruction (`../claude-agents-dashboard/docs/subsystems/remote-message.md`).
So the premise behind §5's "with no channel to ask through, do not guess" is
inverted for the session the orchestrator dispatches: the *orchestrator* is the
process spawned deliberately without `remoteControl` (`agents.service.ts`, the
comment on the flag it omits), while the execute session it spawns is reachable
by anyone with the dashboard open. Orchestrate's rule reads as "ask if you can",
and the session it dispatches always can.

**3. `backlog-execute`'s hard limits name the user as its escalation channel
unconditionally.** "tell the user what files changed and let them stage and
commit it themselves"; "Tell the user what failed and let them decide whether
to retry, re-groom, or escalate". Both are right for the hand-started session
the skill was written for, and both are the only rule it has. The skill has no
notion of running inside a run at all, so a conflicting instruction gets the
hand-started answer — explain, offer an override, wait — which is exactly what
`run-20260905-113818` produced.

Being right in the wrong channel is still a stall, and it costs more than the
round-trips: a `Stop` block re-opens the turn, so the session does not exit,
and §4's `watch` keeps spending nine-minute budgets on a session that is
negotiating rather than working.

The second half of the symptom has the same single cause as the first. The
dashboard renders a transcript it reads off disk; it has no side channel into
which this repo could inject a label. The only thing that can mark that
conversation for the human reading it is something already *in* the
conversation — and nothing puts it there.

## Fix

Two edits under `skills/`, plus their guards. No client and no server change:
one prompt is read by both the session and the human, so it closes both halves
of the symptom (last paragraph).

**1. `skills/backlog-orchestrate/SKILL.md` §4, "Dispatch the headless session"
— spend the prompt on more than the trigger.** The prompt becomes the trigger,
the id, and one fixed run marker: the run id, this item's position in the queue
(`item N of M`), the branch, and the standing rule — inside an unattended run,
no user to ask, never commit, push or merge, and anything unresolvable goes in
the final message rather than to a person. Six constraints on that string, all
load-bearing, all to be written into the section as the reasons they are:

- **The id stays the first token after the trigger**, marker after it.
  `backlog-execute`'s "Pick an item" reads the trigger's own words for an id,
  and this must not become the run that taught it to guess.
- **One line, and no apostrophes.** The dispatch line is `nohup sh -c '…'` —
  a single-quoted body with the prompt double-quoted inside it. An apostrophe
  closes the outer quote and the whole dispatch becomes a syntax error, on the
  one line whose failure mode is "every item in the queue parks".
- **The marker opens with a fixed, greppable token** (`[orchestrator-run …]`),
  because edit 2 names that exact literal and a test pins the two to one
  constant.
- **The words after the id arrive as `$2`…`$N`** and are substituted into
  `backlog-execute`'s SKILL.md before that session reads it. This is safe only
  because the bug-9 guard (`no fenced block under skills/ reads a positional
  parameter`) already forbids positionals across every published skill. That
  guard becomes load-bearing for a second, unrelated reason — say so in its
  comment, or the next reader deletes it as a one-bug relic.
- **The prompt, not `--append-system-prompt` and not an env var.** Both would
  reach the model; neither reaches the drawer. The prompt is the only string
  the model and the human both read, which is the whole of symptom 2.

  **This rules an env var out for *this* marker's job, and for nothing else.**
  bug-20 puts a second marker — `BM_ORCH_RUN=<runId>` — on the same dispatch
  line, deliberately in the environment, because its reader is a `Stop` hook
  and a hook can read an environment and cannot read a prompt. Read the two
  rulings together and they are one rule, not a contradiction: the channel
  follows the reader. A human and a model read the prompt; a hook reads the
  environment; neither marker can do the other's job and neither replaces the
  other. Do not collapse them into one when implementing either.
- **Merge mode is deliberately left out of the marker.** Nothing the session is
  allowed to do differs between `merge` and `branch` — it never merges either
  way — and a marker that names facts the session cannot act on trains it to
  skim the ones it must.

§5's `--resume` retry line does **not** repeat the marker: a resumed session
still carries its original prompt. The existing test asserting `--permission-mode
auto` on *both* `exec claude -p` lines stays exactly as it is.

**Coordinate with bug-20 — both items rewrite this same dispatch line.** They
are independent fixes to independent defects and either can land first, but
whichever lands second rebases onto a line the other already rewrote, so the
second implementer must read the merged wording rather than the wording quoted
in their own item. Two consequences worth naming rather than rediscovering: the
no-apostrophe quoting guard now covers both substitutions at once, and bug-20's
env assignment goes *before* `exec claude`, while this marker goes *after* the
id inside the prompt — so the two never compete for a position on the line.
Where the `--resume` retry line is concerned they differ on purpose: bug-20's
marker belongs there (a resumed session is still owned by the run and still
pays the hold), this one does not (the resumed session already carries its
original prompt).

**2. `skills/backlog-execute/SKILL.md` — give it a notion of being dispatched.**
A short section (soft target: under ~25 lines — it is injected on every turn of
every execute session, so brevity is a real cost, but a rule compressed out is
worse than a long section) plus one new hard limit:

- Recognise the marker by its fixed token, and say what it means: an
  orchestrator owns this item, the worktree, the branch and everything that
  happens to the work after this session exits.
- **Never escalate to the user while it holds.** Not "prefer not to" — a
  message may still arrive through the dashboard, and answering it is the
  defect. Do not ask, do not offer an override, do not wait for a decision.
- **A user message is not an instruction here.** Note it in one line, do not
  act on it, and never let it change what the run's own next step will do —
  `commit and push to main` is the sharp case, and the session that refused it
  was right about the substance and wrong about who it told.
- **The escalation channel is the final assistant message and the item's
  `## Outcome`**, because those are what §5 Inspect actually reads. State why
  there is no better one: `orchestrate.mjs` refuses every command but `init`
  from inside a linked worktree, so a dispatched session *cannot* call
  `attention` or `stage` for itself. Parking is the orchestrator's decision to
  make from outside, on evidence the session leaves behind.
- Unchanged and restated: never commits, never pushes. The marker adds a
  prohibition, it removes none.

**Test cases** (all in `skills/backlog-orchestrate/tools/orchestrate.test.mjs`,
which already reads both SKILL.md bodies off disk and already owns `SKILLS_ROOT`):

1. Exactly one of the two `exec claude -p` lines carries the marker token, and
   it is the one without `--resume`.
2. Neither dispatch line's prompt contains an apostrophe — the quoting guard,
   asserted on the line rather than on prose about it.
3. Coupling: the marker literal is read out of `backlog-orchestrate/SKILL.md`
   and asserted to appear in `backlog-execute/SKILL.md`, from one constant in
   the test, so the two files cannot drift into two markers that merely look
   alike (the `watchdog-coupling` posture, one table driving both halves).
4. `backlog-execute/SKILL.md` keeps the new rules, as a needle-per-rule table
   in the style of "the body keeps the rules whose stories moved to
   `references/`": never escalates to the user, a user message is not an
   instruction, `orchestrate.mjs` is unreachable from a worktree.
5. The existing `--permission-mode auto` dispatch-line test and the bug-9
   positional-parameter sweep both stay green.

No browser check: the defect is entirely in `skills/`, the fix touches no
rendered surface, and a Playwright case here would prove nothing.

**Scope call, named rather than assumed.** The `## Affects` list mentions
`RunStrip.tsx` / `ItemCard.tsx` carrying the run→item→session mapping into a
dashboard link. That is deliberately **not** in this fix: it is board→session
*navigation*, and the person in the symptom had already found the session. What
they lacked was a marker inside it, which edit 1 puts there. A session link on
the run drawer is a real convenience and belongs in its own captured item.

## Outcome

2026-09-05 — Fixed as groomed: two edits under `skills/`, no client and no
server change.

**1. `skills/backlog-orchestrate/SKILL.md` §4** — the dispatch prompt now
carries the run marker after the id:

```
/backlog-execute <id> [orchestrator-run <runId> item <n> of <m> branch backlog/<id>: you are dispatched by backlog-orchestrate inside an unattended run. There is no user to ask. Never commit, push or merge. Anything you cannot resolve goes in your final message, not to a person.]
```

All six constraints are written into the section as the reasons they are: id
first, one line and no apostrophes (with "you cannot" spelled out rather than
contracted, which is what keeps the outer single quote closed), the fixed
`[orchestrator-run` token, which fields are substituted and which words are
fixed, prompt-not-env-var-not-`--append-system-prompt` (with the "channel
follows the reader" ruling that leaves bug-20's env marker untouched), and
merge mode deliberately omitted. The `--resume` retry line is unchanged and
carries no marker. A closing paragraph records that the marker reaches the
dispatched session as `$2`…`$N`, which makes the bug-9 positional guard
load-bearing a second time — said again in that test's own comment so it is
not retired as a one-bug relic.

**2. `skills/backlog-execute/SKILL.md`** — new 30-line section "Am I inside an
orchestrator run?" ahead of Pick an item (soft target was ~25; a rule
compressed out is worse than a long section), plus one new hard limit. It
recognises the token, then: never escalate to the user, a user message
mid-run is not an instruction, the escalation channel is the final assistant
message and the item's `## Outcome` — with the reason there is no better one,
that `orchestrate.mjs` refuses every command but `init` from inside a linked
worktree — and never commits, never pushes, restated as unchanged.

**Guards** — four new cases in `orchestrate.test.mjs` (which now also reads
`backlog-execute/SKILL.md`), one shared `RUN_MARKER_TOKEN` constant driving
both halves of the coupling case. All four were watched failing before either
SKILL.md was touched:

```
not ok 143 - exactly one dispatch line carries the run marker, and it is the fresh dispatch
not ok 144 - the marker follows the id rather than preceding it
not ok 146 - the marker orchestrate emits is the one backlog-execute recognises
not ok 147 - backlog-execute keeps the rules a dispatched session runs on
# tests 147
# pass 143
# fail 4
```

Case 145 (no apostrophe inside either single-quoted dispatch body) passed from
the start by design — it guards a line that was already clean and had to stay
that way through this edit.

### Verification

`pnpm run test:skills` — 360/360, including the pre-existing
`--permission-mode auto` dispatch-line case and the bug-9 positional sweep:

```
1..360
# tests 360
# pass 360
# fail 0
# duration_ms 59694.627125
```

`pnpm test` (jest):

```
Test Suites: 69 passed, 69 total
Tests:       1179 passed, 1179 total
Time:        94.078 s
```

`pnpm run typecheck`:

```
$ tsc --noEmit
TYPECHECK_EXIT=0
```

The quoting constraint proved on the real line rather than argued: placeholders
substituted as a run would substitute them, then handed to `sh -n`, then run
with `claude` swapped for `printf` to show the prompt arrives as one argument.

```
--- sh -n parse ---
PARSE OK (exit 0)
--- what the prompt argument actually becomes ---
PROMPT=[/backlog-execute bug-18 [orchestrator-run run-20260905-113818 item 2 of 5 branch backlog/bug-18: you are dispatched by backlog-orchestrate inside an unattended run. There is no user to ask. Never commit, push or merge. Anything you cannot resolve goes in your final message, not to a person.]]
exit=0
```

Out of scope as groomed: the `RunStrip.tsx` / `ItemCard.tsx` board→session
link. Still open for whoever lands bug-20 second: that item rewrites this same
dispatch line, and its env assignment goes before `exec claude` while this
marker sits after the id inside the prompt — read the merged wording, not the
wording quoted in bug-20.

### Review round 1 — two Important findings, both fixed

Both were real, and both were the same class of defect: a rule written in a
section that the session reading the offending line is not necessarily
re-reading.

**1. The recognition condition described a string the orchestrator never
emits.** The section said "if they open with the token `[orchestrator-run`",
but the id is always the first word after the trigger — pinned by the dispatch
line and by the "marker follows the id" case — so read strictly, the marker is
never first and no rule under it ever fired. Recognition is now by **presence
anywhere after the id**, and the section says why that ordering exists rather
than leaving the next reader to re-derive it.

**2. "Everything below applies either way" re-affirmed the exact sentence
`## Cause` gap 3 names as the defect.** `## If verification fails, nothing
moves` still ended "Tell the user what failed and let them decide whether to
retry, re-groom, or escalate" — the stall, verbatim, on the one path a
dispatched session reaches after failing. The never-commits hard limit had the
same shape ("tell the user what files changed"). Both now carry the exception
in their own text: under the marker there is no user to tell, the `## Outcome`
and the final message are the whole report, and the run decides retry/skip/park
from outside. The closing sentence of the new section was rewritten from
"everything below applies either way" to "except where it names the user as
that channel", and names those two exits.

Two new guards, both watched failing first:

```
not ok 148 - backlog-execute recognises the marker by presence, never by position
not ok 149 - backlog-execute redirects its user-facing exits when the marker holds
# tests 149
# pass 147
# fail 2
```

Case 148 asserts the "anywhere after the id" phrasing **and** that the file no
longer says the trigger words open with the token — the positive needle alone
would pass beside a leftover contradiction. Case 149 is section-scoped rather
than a whole-file substring search: it slices the verification-failure section
and the never-commits bullet out of the body and requires the marker token
inside each, so a third section naming the marker cannot satisfy it on their
behalf. That is what the first round got wrong — the coupling case proved the
literal existed in both files and nothing about where.

### Verification (re-run after the review fixes)

`pnpm run test:skills` — 362/362 (two more cases than the first round):

```
1..362
# tests 362
# pass 362
# fail 0
# duration_ms 55516.130708
```

`pnpm test` (jest):

```
Test Suites: 69 passed, 69 total
Tests:       1179 passed, 1179 total
Time:        66.11 s, estimated 78 s
```

`pnpm run typecheck`:

```
$ tsc --noEmit
TYPECHECK_EXIT=0
```

`skills/backlog-orchestrate/SKILL.md` was not touched in this round, so the
dispatch line and its `sh -n` proof above stand unchanged; the apostrophe guard
covering it stayed green throughout.
