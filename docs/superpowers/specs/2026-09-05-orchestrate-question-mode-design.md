# Orchestrate question mode — design

**Status: approved 2026-09-05.**

A run-scoped setting, `questionMode`, that decides one thing: what an
orchestrator run does with an item's open questions when nobody can answer
them. Two values — `park` (today's behaviour: record the questions, skip the
item, keep draining) and `decide` (answer them itself, write the answers into
the item, record what it assumed, and execute). Chosen per launch, defaulted
from Settings, carried spawn → prompt → `init` → run file, exactly like
`mergeMode`.

Alongside it, and only because the same sheet has to grow a control either
way, the Orchestrate sheet becomes three steps — pick items, arrange them,
choose modes — which also gives the run's queue a hand order for the first
time.

## Why this exists

`backlog-orchestrate` SKILL.md §3 already hunts an item for open questions and
already asks them through `AskUserQuestion`, best-effort. What it does when
that ask produces nothing is fixed: `attention --kind needs-answers`,
`stage <id> needs-answers`, skip. That is the right default and it is not the
right *only* option, because "nobody can answer" is not a property of the
question — it is a property of how the run was started.

The observation that produced this design: several headless item sessions in
this repo and in `claude-agents-dashboard` recorded lines of the shape *"
`AskUserQuestion` isn't available in this session, so I'll decide rather than
stall"* and then made design calls on their own. Tracing it found no
instruction in `CLAUDE.md`, in either skill, or in any memory file the session
could reach — worktree sessions get a project memory directory keyed on the
worktree path, and none of the 26 that exist has one. The driver was a
machine-local `UserPromptSubmit` hook that fires on any session whose
permission mode is `auto` and tells it to route every decision through
`AskUserQuestion` and *never end a turn on a prose question*. A board-started
run is spawned `claude -p --permission-mode auto`, where that tool does not
exist. The session was handed a contradiction and resolved it by deciding
silently.

Two problems, and this spec is the second one's answer:

1. **The hook is wrong on every machine**, not just this one — it instructs a
   session to use a tool it may not have. Fixed in §9; it is outside this
   repo and changes nothing about the plugin.
2. **Deciding-instead-of-stalling is a legitimate thing to want**, and it is
   currently unavailable, undeclared, and invisible. A run cannot be told to
   do it, nothing records that it happened, and the archive cannot answer
   "was this item's plan written by a human or filled in by the runner?"

Making it a declared, recorded, per-run choice turns an accident into a
setting.

## The mental model, and where it gets written down

The mode is **not** derived from how the run was started, and it is not a
second way of asking. The ask is unchanged in both modes: `AskUserQuestion`,
once, best-effort. The mode governs the unanswered branch alone.

|             | tool present (harness, interactive terminal) | tool absent (headless `claude -p`) |
| ----------- | ------------------------------------------- | ---------------------------------- |
| `park`      | ask → use the answer                        | `needs-answers` + skip the item    |
| `decide`    | ask → use the answer                        | decide, record, execute            |

The two modes are **identical whenever a human can be reached**. In practice
the tool's absence is the "nobody is watching" signal, so the mode only ever
takes effect in a headless run — which is the only kind of run the sheet can
start, since `POST /api/agents/orchestrate` spawns `claude -p`.

That gives the feature a one-sentence doctrine, and it belongs in four places
because a reader can arrive at any of them first: **want control over a
question, start the run from a harness that has `AskUserQuestion`; start it
from the board and you are choosing between skipping the item and letting the
runner answer.** It goes in the sheet's picker hint, the Settings hint,
SKILL.md §3, and CLAUDE.md's invariants.

## Non-goals

- **No third mode that asks in prose and waits.** A prose question ends the
  turn. In a board-started run that exits the session, `watch` observes it
  die, and the whole run needs `--resume` — so "ask me in prose" is not a
  milder `park`, it is *stop the entire run*, and it is unreachable from the
  one surface that would configure it. SKILL.md gains a prohibition on it
  instead (§5).
- **No answering questions from the Runs UI.** Unchanged from the original
  orchestrate design. An assumed answer is visible; changing it means
  grooming the item.
- **No `questionModeEffective`.** See §1.
- **No new attention kind.** See §6.
- **No drag-and-drop reordering.** See §7.

## 1. Vocabulary

```ts
// shared/types.ts
export type QuestionMode = 'decide' | 'park';
export const QUESTION_MODES: readonly QuestionMode[] = ['decide', 'park'];
```

with `isQuestionMode` in `shared/agent.ts` beside `isMergeMode`, for the same
reason that guard exists rather than a hand-written comparison chain: the
chain is a second copy of the vocabulary and it is the copy that goes stale.

The values name the outcome rather than the posture — `park` in an archived
run file says what happened to the item, where `manual` would require the
reader to already know. UI labels are outcome-worded too ("Decide and
continue" / "Skip the item for me"), the same split `MERGE_MODE_LABELS`
keeps: mechanism-ish values, outcome-ish labels.

**One field, not three.** `mergeMode` has `mergeModeEffective` and
`mergeModeNote` because a classifier denial moves a run from `merge` to
`branch` mid-flight and the archive has to answer "did this run merge, and was
that the plan?". Nothing moves `questionMode`. A second field would record a
divergence that cannot occur, and a reader would spend real time working out
which of the two to trust.

## 2. The path the value travels

### 2.1 Settings

New key `orchestrateDefaultQuestionMode: QuestionMode`, default `'park'`,
clamped in `clampSettings` by `pickOne` against `QUESTION_MODES` — identical
in shape to `orchestrateDefaultMergeMode`, and like it there is no `''`
"CLI default" third state, because the union is already closed and every run
has some behaviour here whether or not anyone chose it.

It seeds the sheet's picker and nothing else. It never reaches the server:
`localStorage` cannot cross into a headless process, which is the whole reason
the value rides the prompt.

### 2.2 The sheet

A fifth picker in step 3 (§7), seeded from the setting, sent on **every**
launch. Inferring an absent field server-side as "the user's default" would
put one decision in two places, and the server cannot read the browser's
setting anyway.

### 2.3 Server validation

`AgentsController.orchestrate` gains `questionMode: body?.questionMode` to its
field-by-field rebuild — unvalidated there, like every neighbour, because the
service is the one place a value is judged.

`AgentsService.resolveQuestionMode` mirrors `resolveMergeMode` exactly:

| input                        | result                       |
| ---------------------------- | ---------------------------- |
| absent / `''`                | `'park'`                     |
| `'park'` / `'decide'`        | that value                   |
| anything else, any type      | **400**, uncoded, value echoed truncated and JSON-quoted |

**400 rather than drop-on-unknown**, unlike `model`/`effort`. Those two drop
because dropping them means "let the CLI decide", which is a coherent thing to
have happen. This value is written verbatim into `run.json` and read out of
the archive months later; silently resolving a typo'd `decide` to `park` would
put a claim in the archive that no caller ever made. Absent is not a bug — it
is every request written before this field existed — and that is exactly the
distinction a 400 preserves and a clamp destroys.

`RUN_IN_PROGRESS_CODE` stays the only machine-readable code this route
returns.

### 2.4 The prompt

```
/backlog-orchestrate [<ids…>] [--merge-mode branch] [--question-mode decide]
```

Composed server-side from compile-time literals selected by guards; no caller
string is ever concatenated in. Ids first, flags after — `orchestrate.mjs`
reads bare tokens as ids, so a flag ahead of them swallows the first id as its
argument.

**`decide` appends the flag; `park` appends nothing.** Inverted from merge
mode (`branch` appends, `merge` is silent) for the same underlying rule both
follow: the default appends nothing, so a default run's prompt stays
byte-identical to what shipped before the field existed. `park` is the
default here; `merge` is the default there.

`--question-mode` goes last, after `--merge-mode`, so every prompt this
endpoint composed before today remains a byte-exact prefix of what it composes
now. Argv order between the two flags is otherwise immaterial.

### 2.5 The run file

`cmdInit` gains `--question-mode <decide|park>`, validated against
`QUESTION_MODES` with the same "unrecognised value is a shape problem with the
call, exit 1, nothing written" posture `--merge-mode` uses, and writes one
field:

```json
{ "questionMode": "park" }
```

`INIT_USAGE` grows the flag. `init` remains the run file's only writer of it —
nothing later moves it.

**Reading a run file that predates the field:** absent means `park`. The
server's `OrchestratorRun` type declares it required and the reader tolerates
absence the way it already tolerates every other field added after a run was
archived; the archive endpoints serve run files verbatim, so this is a display
concern in `RunDetail`, not a migration.

## 3. Where the mode is consulted

**SKILL.md §3 and nowhere else.** The item loop, pre-flight, commit, review,
verify and merge stages are untouched.

The rewritten branch:

- **Answered** (either mode) → unchanged. The existing "Writing an answer into
  the item" path.
- **Not answered, `park`** → unchanged. `mkdir -p <dir>/questions`, write the
  verbatim array, `attention <id> --kind needs-answers --questions-json …`,
  `stage <id> needs-answers`, next item.
- **Not answered, `decide`** → decide each question, write the answers into
  the item body through the **same** existing write path — so the answer rides
  the worktree's commit into `main` and is visible in the diff — then record
  the pairs with `assume` (§4) and continue to dispatch.

Two rules the prose must carry, because both are the kind of thing a run
re-reading SKILL.md on turn 300 will otherwise smooth over:

1. **Never restate an unanswered question in prose**, in either mode. Ending
   the turn kills a headless run. Say so with the reason attached; a bare
   prohibition is what drifts.
2. **A decided answer is an assumption, and is written as one** — the item
   body records what was assumed and that it was the runner that assumed it,
   never phrased as though a human had settled it.

The questions themselves are the union of what §3's hunt reads off the item
and the `questions` array `plan --json`'s gate already returns
(`detectQuestions`: a `TBD`, a `?`-terminated line in the question section, a
`## Done when` naming a command the project cannot run).

## 4. The record

`RunQueueItem` gains:

```ts
assumptions: { question: string; answer: string }[];   // default []
```

Pairs, not bare strings: the archive's job is to answer "what was asked, and
what did the runner decide", and half of that is useless. `attention`'s
`--questions-json` carries bare strings because at that point there is no
answer to carry.

`ArchiveQueueItem` is `Omit<RunQueueItem, 'verification'> & {…}`, so the field
reaches the archive payload with no second declaration — which is the point of
putting it on the queue item rather than inventing a parallel structure.

Written by one new tool command:

```
orchestrate.mjs assume <itemId> --json <file>
```

A file, not inline argv, matching `--questions-json`'s own convention — the
content is prose the run composed, and prose does not go through shell
quoting. Malformed JSON, a non-array, or an entry missing either key is exit
`1`, nothing written, same as every other input-shape failure in the tool —
`1` is that tool's general failure code (26 of its 30 throws), with `3` and
`4` reserved for "no run exists" and "lock held".
Appends rather than replaces, so a second question decided later in the same
item's pre-flight does not erase the first.

Surfaced per item in `RunDrawer` and in `RunDetail`, beside the stage track.
Not in `RunStrip` — the strip states run-level facts.

## 5. Enforcement lives in the tool

**`assume` refuses under `questionMode: 'park'`** — exit `1`, nothing written,
message naming the run's mode.

Exactly the division of labour `stage <id> merged` under branch mode already
keeps, and for the identical reason: SKILL.md is re-read on every one of a
run's several hundred turns and prose drifts across them; a tool refusal does
not. A run told to park an unanswerable item and found writing assumptions
about it is a run whose prose has drifted, and that is precisely the failure
worth making impossible rather than merely discouraged.

The converse is not enforced. `attention --kind needs-answers` stays legal
under `decide` — a question the runner genuinely cannot answer (a plan
referring to a section nobody wrote, an either/or between two products) must
still be able to park its item, and `decide` is permission to answer, not an
obligation to invent.

## 6. Why no attention entry

`ATTENTION_KINDS` stays the closed set of three — `needs-answers`, `parked`,
`fix-exhausted` — because that list means "a human must look at this item"
and `ATTENTION_RUN_STAGES` derives from the same idea. An item whose questions
were answered by the runner and which then passed review, verification and
merge is not waiting on anybody.

This follows the precedent CLAUDE.md already pins for a classifier denial: a
fact worth recording is not automatically an attention entry. The assumptions
live on the queue item, which is where per-item facts about a run belong, and
the answers themselves live in the item file, which outlives the run.

## 7. The sheet becomes three steps

Today `OrchestrateSheet` renders, in one scrolling body: a note, the queue
list with checkboxes, a row of four pickers (permission mode, model, effort,
merge mode), the merge-check hint, an error slot, and the actions. A fifth
picker in that row is the trigger for this restructure, not its justification
— the justification is that Start currently sits below a scroll region whose
length is the size of the project's queue.

| Step        | Content                                                        | Gate                              |
| ----------- | -------------------------------------------------------------- | --------------------------------- |
| 1 · Items   | the existing list, checkboxes, select all / none                | Next disabled while nothing ticked |
| 2 · Order   | the selected rows only, ↑/↓ per row, "reset to natural order"   | always passable                   |
| 3 · Modes   | the five pickers, merge-check hint, error slot, **Start**       | existing 409 handling unchanged   |

Order sits next to the selection it operates on: pick, arrange, configure, go.
Reordering rows that are about to be unticked is wasted work.

### 7.1 Reordering costs nothing below the client

`--ids` is **already** run in the order given. `buildGatedQueue` builds its
working list as `ordered = ids.map(...)`, and `resolveIds` carries the rule
explicitly — *"Order is load bearing: `--ids` runs items IN THE ORDER GIVEN …
so this loop must never reorder what it was handed."* No tool change, no
server change, no wire change. This step is client-only.

### 7.2 Order state

`order: string[] | null` on the sheet; `null` means natural order. Derived
against the live queue every render, the same discipline `selected` already
uses: ids that appear while the sheet is open append at the end, ids that
vanish drop out. A stale id can never reach the request.

### 7.3 Reordering pins membership, and the step says so

Today the request sends `ids` only for a **strict subset** — `narrowed` is a
comparison against the queue, deliberately not a "has the user touched
anything" flag, because select-none-then-select-all must land back on a
full-queue request rather than an explicit list frozen at sheet-open time.

A hand order forces that explicit list even when nothing is deselected, which
reintroduces exactly the snapshot the strict-subset rule avoids: an item
groomed between opening the sheet and clicking Start will not be in the run.
This is unavoidable — choosing an order *is* choosing a membership — so the
request condition becomes `narrowed || order !== null`, and step 2 states the
consequence in words rather than leaving it to be discovered.

### 7.4 `runner-fix:` still jumps the line

A `runner-fix:` item is hoisted to the front of whatever list arrives, above
any hand order, and the partition outranks bugs-then-tasks. That stays.

The sheet **cannot show which item that is**, and must not pretend to: the
queue preview is client-side off `BacklogItem`, which carries no `runnerFix`;
the marker's authority is the blob at `<base>`, not the working copy, so a
server-derived badge would be confidently wrong for an item marked but not yet
committed. Step 2 gets a note saying a runner fix may hoist above the chosen
order — the same posture as the existing "the real run may re-gate an item"
disclaimer, which is honest about the preview being an approximation.

### 7.5 ↑/↓, not drag-and-drop

Keyboard-accessible by construction, testable under jsdom, and consistent with
an app whose every control is a `select` or a `button`. Drag-and-drop is a
substantially larger build whose behaviour the test suite cannot assert, on a
screen that is the last one before a multi-hour unattended operation.

## 8. Settings

A new group, **`Orchestrator · this device`**, placed above the existing
`Orchestrator watchdog · this server`.

- `Default merge mode` **moves into it** out of `Claude Agents · this
  machine`. That group's own comment says a reader arrives there asking "how
  does dispatch behave on this device"; merge mode has never answered that
  question, and with a second orchestrate default landing beside it the
  mismatch stops being cosmetic.
- `Default question mode` joins it, hint carrying the doctrine from the top of
  this document.

`Default model` and `Default effort` stay where they are: they genuinely are
dispatch defaults, and the orchestrate sheet borrowing them is not a reason to
move them.

## 9. The hook (outside this repo)

`~/.claude/hooks/remote-decision.sh` rule 1 becomes conditional:

```
1. Put EVERY decision through the AskUserQuestion tool — approach choices,
   "should I proceed?", scope calls, and questions a skill tells you to ask.
   Never end a turn on a prose question WHILE THAT TOOL IS AVAILABLE.
   If AskUserQuestion is not available in this session, this rule does not
   apply: follow whatever the running skill says to do without a channel,
   and if it says nothing, ask in prose rather than deciding silently.
```

The floor matters as much as the clause. Without it the hook's absence leaves
a session with no instruction at all, which is the state that produced the
original silent deciding.

Recorded here because it is the cause of the investigation, not because this
repo owns it. Nothing in the plugin depends on it, and the skill behaviour
above is correct on a machine that has no such hook.

## 10. Testing

Cases, not code. Every one of these is a behaviour a later reader could
otherwise re-decide.

**Vocabulary** — `isQuestionMode` accepts both members and rejects `'Decide'`,
`''`, `null`, `42`, an object; a `Record<QuestionMode, true>` literal in the
shared suite so the compiler refuses the build the day a third member lands
without anyone classifying it.

**Server resolution** — the table in §2.3, all six rows, including that `42`
and `'Decide'` both 400 while absent and `''` both resolve to `park`. The
lock (`RUN_IN_PROGRESS_CODE`) wins over a malformed `questionMode`, same as it
wins over a malformed `ids`.

**Prompt** — `park` produces a string byte-identical to today's for the same
request; `decide` appends exactly `' --question-mode decide'` and appends it
after `--merge-mode branch` when both are present; no caller-supplied
substring ever appears.

**Tool** — `init --question-mode decide` writes the field; an unrecognised
value exits `1` with nothing written; `assume` appends pairs, rejects a
malformed file with exit `1`, and **refuses under `park` with the run file
unchanged**; `attention --kind needs-answers` still succeeds under `decide`.

**Sheet** — Next is disabled with nothing ticked; an untouched sheet still
sends **no** `ids`; reordering with everything selected sends the full id list
in the chosen order; deselect-all-then-select-all with no reorder returns to
sending no `ids`; the order list drops an id that leaves the queue and appends
one that joins it; `questionMode` is sent on every launch.

**Settings** — the new key clamps an unknown stored value to `park` rather
than to a neighbouring bound; the moved merge-mode row still round-trips.

**Client render** — an item with assumptions shows them in `RunDrawer` and
`RunDetail`; an item without shows nothing rather than an empty section; a run
file with no `questionMode` at all renders as `park`.

## 11. Decisions taken, and what they cost

- **Two values, not a 2×2 of ask-policy and fallback-policy.** The fourth
  combination (ask in prose, then decide anyway) is incoherent, and the third
  meaningful point on the ladder — ask in prose and stop the run — is
  unreachable from the board, which is the only surface that would configure
  it. Cost: someone who genuinely wants a run to halt on a question has to
  start it from a harness rather than tick a box.
- **400 on an invalid value, not a clamp.** Costs a caller a round trip on a
  typo; buys an archive that never contains a mode nobody asked for.
- **Assumptions on the queue item, not in `attention`.** Costs a badge on the
  existing attention surface; keeps `ATTENTION_KINDS` meaning one thing.
- **Reordering pins the queue.** Costs the freshness the strict-subset rule
  was protecting; unavoidable, and now stated on screen instead of
  discovered.
- **The sheet still cannot show a `runner-fix:` hoist.** Costs a surprise when
  the run's first item is not the one at the top of the chosen order; the
  alternative was a badge derived from the wrong bytes.
