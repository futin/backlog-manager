# Orchestrator watchdog — rulings taken during implementation

Companion to
[the design spec](../specs/2026-09-04-orchestrator-watchdog-design.md) and
[the implementation plan](../plans/2026-09-04-orchestrator-watchdog.md).
Branch `feature/orchestrator-watchdog`, nine tasks, `f352587..0c81bda`.

## Why this file exists

The plan was executed subagent-driven: a fresh implementer per task, a
review after each, a whole-branch review at the end. That mode has one
property worth recording — **the controller decides, alone, every time the
plan turns out to be silent, wrong, or self-contradictory.** Twenty-four
such decisions were taken here. Each was made without asking, because a
plan that stops on every ambiguity costs a day and buys nothing.

The spec and the plan say what was *intended*. `CLAUDE.md`, `docs/invariants.md`
and the code comments say what the system *is*. Neither says where those two
diverged, or why. That is what this file is for. Six of these rulings already
have their reasoning committed somewhere durable; the rest had their *effect*
land in code and their *reason* nowhere, which is the gap this closes.

Read it when a rule here looks arbitrary and you are about to "fix" it.
Every entry names what it costs if it was wrong, so a later reader can
overturn one on evidence rather than on taste — which is exactly what
happened to R19 (see the last section, the most instructive entry here).

Not recorded here: the per-task briefs, reports, reviews and re-reviews.
Those were working artefacts under a git-ignored `.superpowers/` workspace
and are gone. The commit history is the record of *what* changed; this file
is the record of *what was decided*.

---

## 1. Plan defects corrected

The plan asserted something the code or the platform contradicts. In each
case the plan lost.

**R12 — session names use a space, not `·` (U+00B7).**
Names are `resume <basename>` and `watchdog resume <basename>`. The
dashboard's `NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/` does not admit
U+00B7, and a name that fails it is not rejected but **silently dropped to
`undefined`**. `orchestrateSessionName`'s own doc comment records that exact
failure happening on 100% of dispatches under an earlier `bl:<project>/<id>`
spelling — which is why every session name in that file is space-separated
today. Spec §3 calls the dashboard's session list "the one durable trail this
design leaves" and has the name carry who asked; a dropped name destroys
both. The plan's intent (distinguish watchdog from board) is preserved
verbatim. *Cost if wrong: a session row reads `resume backlog-manager`, the
same shape its `orchestrate backlog-manager` sibling already has.*
→ `server/src/agents/agents.service.ts`, pinned against `DASHBOARD_NAME_RE`
in `test/agents-prompt.test.ts`.

**R13 — the spec was amended to match R12.**
Spec §3's two `·` occurrences became spaces. The spec is the binding
authority the next task's implementer reads; leaving it contradicting the
code hands that task a defect the plan already caused once. Amending a
design document to record a ruling made against it is the point of having
one. *Cost if wrong: a spec edit to revert.*

**R6 — "last reported `<id>` at `<stage>`" is the LAST qualifying queue item.**
Specifically the last item in queue order whose stage is neither terminal
nor `pending` nor `ungroomed`, with the terminal set sourced from the
existing constant in `shared/types.ts` rather than hand-typed. The plan's
prose called it "the fixture's first non-terminal item" while its expected
value named `task-14 at reviewing` — but the fixture's first non-terminal
item is `task-21 at needs-answers` at index 1, and `task-14` sits at index 5.
The expected value was right and the prose was wrong. Falls back to
"all items at rest" when nothing qualifies. *Cost if wrong: the strip names a
different item than a human would pick when a run has two live-ish items — a
label, not behaviour.*

**R20 — the crashed strip's root is a `<div>` with two sibling buttons.**
Not a `role="button"` span nested inside the outer `<button>`. A button's
content model forbids interactive descendants; `stopPropagation` fixes the
click but not the invalid markup, and jsdom will never fail on it — the
suite was fully green with the invalid nesting in place. The plan offered
both shapes; the first implementer read it as mandating a button root.
*Cost if wrong: the strip's open affordance moves from the root element to an
inner button, which the "click anywhere else opens the drawer" case pins
either way.*
→ `client/src/components/board/RunStrip.tsx`, whose comment records the
content-model rule so a later edit cannot unify the two strip shapes.

**R21 — the "everything before `reconcile` is read-only" claim was false.**
Spec §7 mandated a `SKILL.md` sentence justifying unattended `--resume` on
the grounds that everything before `reconcile`'s verdicts is read-only —
while the same spec section is what inserts a `heartbeat` **write** before
`reconcile`. The claim (safe to enter unattended) is correct and stays; its
reason now names the one write and why it is harmless: the heartbeat stamps
`updatedAt` on a run already `running`, the identical stamp the run's own
loop writes every turn, and `status` gates it so a finished run is never
re-stamped. It stays **one sentence** — `SKILL.md`'s body is re-read on every
one of a run's several hundred turns. Spec §7 was amended alongside it, as
R13 did for §3. *Cost if wrong: one sentence, in two files.*

**R23 — the guard invariant carries no count.**
It reads "Every agents POST is guarded by content-type and origin", with any
enumeration confined to a parenthetical. An implementer wrote a
"two → three → four" lineage matching stale prose elsewhere; there are in
fact **five** guarded POSTs (`plan`, `dispatch`, `orchestrate`, `resume`,
`watchdog/config`) and the test enumerates all five, so "four" silently
omitted `plan`. `CLAUDE.md`'s own neighbouring `isAgentAction` invariant
argues that a second hand-maintained copy of a vocabulary is the copy that
goes stale — a number in that sentence is exactly such a copy, and it went
stale inside a single branch. *Cost if wrong: a reader counts the routes
themselves, which is what the test already does.*

## 2. Plan gaps filled

The plan was silent; a decision was still required.

**R9 — spec §2.1's third arming trigger is wired at controller level.**
"A successful `orchestrate()` or `resume()` spawn" arms the sweeper — a
trigger no task in the plan covered. It lives in `AgentsController`, not
`AgentsService`, because `WatchdogService` already injects `AgentsService`
and the reverse is a dependency cycle. *Cost if wrong: a run started by a
non-board client that never reads `/api/orchestrator/runs` goes unwatched
until the next boot — no such client exists, so this is belt-and-braces over
the `observe()` trigger the board's own poll already provides.*

**R2 — `POST /api/agents/watchdog/config` arms AND kicks an immediate tick.**
`arm()` alone is insufficient: it returns early while a timer already
exists, and the case that matters is a watchdog already armed but *disabled*
whose toggle is being flipped on while a run sits crashed. Spec §5.3
requires that flip to act now, not at the next board poll. The tick is
fire-and-forget so the HTTP response is not delayed by a dashboard health
probe or a spawn; `tick()`'s in-flight guard makes the redundant kick safe.
*Cost if wrong: a settings save that should act at once waits up to `tickMs`.*

**R3 — the `idle` event fires on the transition only.**
`tick()` pushes `idle` only when the phase was not already `'idle'`. As
written the plan pushed one per tick, and the bootstrap tick plus a test's
explicit tick produced two — contradicting the plan's own cases demanding
exactly one. This is the same once-per-condition discipline the plan already
required for `exhausted` and `disabled`. *Cost if wrong: a repeated
stand-down is not individually logged; the phase still shows it.*

**R11 — `readWatchdogConfig` warns on valid-but-non-object JSON.**
A file holding `42`, `[]` or `null` degrades to defaults *and* warns,
exactly as unparseable content does. The absent-file case stays silent —
absence is not malformation. Spec §5.2 groups "missing, unreadable or
non-object file" and pins the degrade shape as "a warning, never a 500"; the
plan's sixteen cases simply never reached the non-object case. *Cost if
wrong: one extra warn line for an operator who wrote `[]` into the file.*

**R14 — `POST /api/agents/resume` answers 201, not the plan's 200.**
Nest's POST default, and the identical answer its sibling
`POST /api/agents/orchestrate` already gives; the client's `unwrap` treats
both alike. Consistency with the neighbouring route beats a status number
the plan stated in passing. *Cost if wrong: one status code, visible in the
tests that pin it.*

**R8 — the top grace option is labelled by `formatSpanCompact`.**
`formatSpanCompact` delegates to `formatSpan` at or above an hour, so
`3_600_000` renders `1h 00m`, not the spec's illustrative `60m`. The spec's
ladder text is illustrative, the plan mandates the formatter, and no case
asserts `60m`. One formatter beats a special case. *Cost if wrong: cosmetic
label text on one option.*

**R10 — `annotate()` reading config per entry is not a defect.**
It is plan-mandated, and matches the read-fresh-never-cache posture the
registry and `config.util.ts` already take. Recorded so a reviewer flagging
it as inefficiency is answered once rather than each time. *Cost if wrong: a
few extra small-file reads per runs poll.*

**R1 — the watchdog hook's tests live in a sibling file.**
`test/watchdog-hook.test.tsx`, not a second `describe` inside
`test/watchdog-routes.test.ts`: the plan's own commit block named that path,
and the two need different jest environments (node vs jsdom). *Cost if
wrong: one file to move.*

## 3. Plan requirements restated

The requirement was unachievable as literally written. In each case the
*substance* is still pinned; only the plan's claim about the mechanism was
wrong.

**R15 — a config change cannot shorten an already-pending timer.**
The plan asked a test to prove "config changed between ticks → the new
interval was honoured". A `setTimeout` chain reads its interval at schedule
time, so the reachable property is that the new interval takes effect from
the *next* scheduled tick. The test pins that and says so in a comment.
*Cost if wrong: a `tickMs` reduction takes effect one tick later than a
reader of the plan might expect — inherent to the chain the spec mandates.*

**R18 — Express rejects a bare string and `null` before the controller runs.**
The plan wanted a uniform `400 { error: 'bad body' }` for `"x"`, `[]` and
`null`. Express's strict JSON parser answers 400 with its own error shape
for two of the three; only `[]` reaches the guard. Split into cases
documenting the real wire behaviour plus unit cases driving the guard
directly. The requirement that matters — a non-object body is refused and
the settings file is left untouched — is fully pinned for all three shapes.
*Cost if wrong: the wire-level error body for `"x"` is Express's, not ours.*

**R4 — the grace test must await its first tick.**
Called back-to-back without awaiting, `tick()`'s in-flight guard makes the
second call a duplicate of the dedup case and it stops testing grace at all.
*Cost if wrong: grace goes untested and only dedup is covered.*

**R5 — the reschedule is measured by spying, not by counting `readFileSync`.**
The plan said "pick one and say which". A spy on
`OrchestratorService.prototype.runs` is deterministic; an fs counter couples
the assertion to how many files the temp run directory happens to hold.
*Cost if wrong: none material.*

**R7 — the fixture wins over the plan's illustrative strings.**
Where any expected substring disagreed with `test/fixtures/orchestrator-run.json`,
the fixture was authoritative and the implementer said so in its report.
*Cost if wrong: a test pinned to a wrong literal, caught by the task review.*

## 4. Escalations and acceptances

**R17 — the jest guard must treat an empty string as absent.**
`test/helpers/env.ts` used `process.env.BM_WATCHDOG ??= 'off'`, and `??=`
does not assign over an empty string — so `BM_WATCHDOG=` in a developer's
shell would leave the sweeper **armed in every jest suite**, pointed at the
real `~/.backlog-manager/orchestrator`. That directory was confirmed to hold
a live heartbeating run during this branch. A reviewer classified it a
residual; it was escalated to a fix, because the guard's whole purpose is
that a test run can never spawn a real agent session, and a guard with a
bypass a plausible shell state triggers is not a guard. *Cost if wrong: one
slightly stricter env check.*

**R16 — an implementer's unrequested test case was accepted.**
Its own mutation check showed spec §2.2's step-3-before-step-4 ordering (set
`exhausted` before the grace check) was unpinned — swapping the steps left
all twenty-two planned cases green. Unpinned, that ordering means the
strip's Resume control appears one grace window late. A case pinning a spec
rule the plan forgot is coverage, not scope creep. *Cost if wrong: one extra
test.*

**R22 — an invariant and the test enforcing it land together.**
`watchdog/config` was added to `test/agents-origin-guard.test.ts`'s
parametrized enumeration in the same commit that rewrote `CLAUDE.md`'s guard
invariant. Shipping the sentence while the enumeration covered fewer routes
would document a guarantee nothing checks. *Cost if wrong: one array entry
in a task whose brief did not name that file.*

## 5. The one ruling that was overturned

This pair is the most useful thing in this file, because it shows a class of
error that per-task review structurally cannot catch.

**R19 (superseded) — "a board Resume click and a sweeper spawn can never both fire."**
The reasoning: spec §6.1 renders the board's Resume control only when
`watchdog.exhausted` or `!watchdog.enabled`, and those are exactly the two
states in which the sweeper's tick stands down without spawning. A task
reviewer traced it against the real tick code and confirmed it. It was true
of every task, read one at a time.

**R24 — it was wrong, and `exhausted` is now derived rather than stored.**
`entry.exhausted` was **stored** once and never cleared, while the tick
**re-derived** `attempts >= maxAttempts` from config read fresh every tick.
Raising "Give up after" in Settings — precisely the action the strip's own
"exhausted after N — resume by hand" text invites — restarted the sweeper
while the payload still reported `exhausted: true`, leaving the Resume
button rendered. Two concurrent `--resume` sessions on one `run.json`.

No per-task review could see this: one task owned the storing, another owned
the deriving, and each was correct in isolation. Only the whole-branch review,
reading them together, found it.

The fix is the repo's own posture stated twice already in `CLAUDE.md` —
*Groomed is derived*, *Board-versus-Archive is derived*, both "never stored".
`watchdogExhausted(attempts, maxAttempts)` in `shared/agent.ts` is now the
single derivation, read by the sweeper's `visit()` and by `annotate()` alike,
so the two agree by construction rather than by coincidence. A stored flag
whose input is re-read on a schedule is the bug class, not just this bug.
*Cost if wrong: the sweeper's stand-down and the board's control could
disagree again — which is the bug this fixed.*

The coupling itself is now pinned by `test/watchdog-coupling.test.tsx`,
which drives both halves from one table: widening the strip's render
condition reddens it, and so does restoring the sticky flag. Before that
test existed, both mutations left the entire suite green.
