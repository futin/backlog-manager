---
id: task-11
title: Record tokens spent per item, per phase, from the session transcript
created: 2026-09-04
from: idea-1
updated: 2026-09-05T11:10:53Z
execute-elapsed: 1105
groom-elapsed: 43
groom-tokens: 6527
---

## Goal

Two new accumulating frontmatter counters, `groom-tokens:` and
`execute-tokens:`, written by `backlog.mjs stop` from the calling session's own
transcript — the token-shaped sibling of the `groom-elapsed:`/`execute-elapsed:`
seconds task-1 already accumulates. Elapsed time says how long an item took;
this says roughly how much model work it took, which is the second, independent
read on complexity idea-1 asked for.

Recording only. Nothing renders these numbers — that is idea-3's job. This task
ends at "the number is on disk and reaches `/api/items`".

## Plan

**On the format of this plan.** Behaviour, signatures and exact expected values
below; deliberately **no literal code blocks**, which overrides
`superpowers:writing-plans`' "No Placeholders … code blocks required" rule.
Handed code gets transcribed verbatim, so a bug in the plan becomes a bug in the
branch with nobody positioned to catch it. `## Test cases` is the authoritative
section: implement to make those pass, and disagree with anything here that
conflicts with them. Size budget is soft — a rule below being load-bearing beats
a line count.

Every measurement quoted below was taken on 2026-09-04 against the real
`~/.claude/projects/` on this machine. Re-measure before treating any of it as
still true; do not delete a rule because its number looks arbitrary.

### 1. No hook. The session names its own transcript.

idea-1 assumed this needed the repo's first `hooks/hooks.json`, because "no
environment variable hands a skill its own transcript path". That is no longer
true, and it is the finding that shrinks this task most:

- **`CLAUDE_CODE_SESSION_ID` is present in the environment of every Bash tool
  call** and matches the session's own `--session-id`. Measured: a session
  launched as `claude -p --session-id fcdf6cef-1a63-4f95-82a0-b659a9df4498`
  exported exactly that value, and
  `~/.claude/projects/<slug>/fcdf6cef-1a63-4f95-82a0-b659a9df4498.jsonl`
  existed.
- The idea's dead end, `CLAUDE_CODE_HOST_SESSION_ID`, is a different variable
  and is still the wrong one. Do not use it.
- **The transcript is flushed mid-session, not at exit.** Measured on a live
  session: 317,222 bytes and 14 completed turns on disk while the session was
  still running. So a `stop` that runs *inside* the session it is measuring can
  read that session's own history. This is the whole premise of the task, and it
  holds.

So: **ship no hook, add nothing to `PUBLISHED_PATHS`, and leave the plugin's
publish surface untouched.** idea-1's third open question ("should the hook be
part of this plugin at all, given a hook is a new class of moving part") is
answered by not needing one.

### 2. Resolving the transcript files

Add `transcriptFiles(projectsRoot, sessionId) -> string[]` to `backlog.mjs`,
exported for test. Absolute paths, main transcript first, subagent files after.

- The main transcript is `<projectsRoot>/<someProjectDir>/<sessionId>.jsonl`.
  **Find it by testing each project directory for that filename, never by
  deriving the directory name from cwd.** The slug rule (cwd with separators
  replaced) is undocumented and Claude Code owns it; more importantly a
  `backlog-execute` session runs with cwd inside a per-item *worktree*, whose
  slug is not the main tree's. A scan is slug-rule-free and costs one
  `existsSync` per project directory — measured 77 directories on this machine,
  and `stop` runs once per session, so the cost is irrelevant.
- If the same `<sessionId>.jsonl` appears under more than one project directory,
  return all of them and let the counting sum across them. A session id is a
  uuid, so this should not happen; summing is the answer that cannot silently
  drop history if it does.
- **Subagent turns are not in the main transcript.** They live in
  `<projectsRoot>/<projectDir>/<sessionId>/subagents/agent-*.jsonl`, a sibling
  directory beside the main file. Measured: `isSidechain: true` appears on
  **zero** records across all 703 transcripts in all 77 project directories,
  while a subagent file carried 20 such records — so filtering the main file on
  `isSidechain` finds nothing and skipping these files loses every subagent's
  cost. Include them: this repo's own history has a run that spent ~2M tokens on
  reviewer subagents, and a number that excluded them would be worse than no
  number.
- That same `<sessionId>/` directory also holds `tool-results/`. Return only
  `subagents/*.jsonl`; ignore everything else in there.
- `projectsRoot` is `<configDir>/projects`, where `<configDir>` is
  `process.env.CLAUDE_CONFIG_DIR` when set and `~/.claude` otherwise. Measured
  unset on this machine, so the fallback is the live path; honouring the
  variable costs one line and is what makes the CLI test in `## Test cases`
  possible without touching the developer's real transcripts.
- A missing or unreadable root returns `[]`, never throws.

### 3. The counting rule

Add `sumFreshTokens(records, fromMs, toMs) -> number` — pure, no filesystem, no
env, exported for test. It takes already-parsed record objects so the whole rule
is testable against literal fixtures.

Count a record only when it is `type: 'assistant'` and has a `message.usage`
object. Then:

- **Dedupe on `requestId`, falling back to `uuid` when absent.** This is the
  single most important rule here. One API turn is written as **one record per
  content block** — `apiBlockIndex` 0, 1, 2 for `thinking`, `text`, `tool_use` —
  and **each record repeats the same `usage` object verbatim**. Measured: 25 of
  28 turns in one transcript were split this way, all 25 groups carrying
  byte-identical usage, and 2,638 such groups across the 77 project directories.
  A naive per-record sum inflates a typical turn by 2-3x. Dedupe globally across
  every file returned in step 2, using one set — request ids are unique per API
  call, so this is safe across the main file and its subagents alike.
- **The number is `input_tokens + cache_creation_input_tokens + output_tokens`.
  `cache_read_input_tokens` is excluded.** This answers idea-1's first open
  question ("total, or output tokens alone?") and the exclusion is the answer's
  substance, so do not quietly re-add it. Measured on one live session: fresh
  89,210 against cache_read 804,246 — a 9:1 ratio. A raw total is ~90% re-read
  context floor, which scales with turn count and prompt size and is close to
  identical for a trivial item and a hard one; it would swamp the signal the
  number exists to carry. Cache *creation* stays in, because that is new
  material genuinely pulled into context (files read, tool output) and does
  track how much an item demanded. Output stays in as the model's own work.
  Output alone was the other candidate and is rejected: it ignores the reading
  an item required, which for a debugging item is most of the work.
- **Do not add `output_tokens_details.thinking_tokens`** — measured 281 within
  an `output_tokens` of 370, i.e. a subset, so adding it double-counts thinking.
- **Do not sum `usage.iterations[]`** — measured as a per-iteration breakdown
  whose single entry equalled the top-level fields. The top-level is already the
  aggregate.
- **Window:** include a record when its `timestamp` is at or after `fromMs` and
  strictly before `toMs + 1000`. Both `started:` and stop's `stamp` are
  truncated to the second, while record timestamps carry milliseconds, so the
  upper bound has to cover the whole second the stamp names — otherwise the turn
  that issued the `stop` call itself, landing at `…:50.900Z` against a stamp of
  `…:50Z`, falls outside its own window. Lower bound inclusive at the second for
  the mirror-image reason.
- Malformed JSON lines, records with no `timestamp`, and records of every other
  `type` (`user`, `attachment`, `last-prompt`, `custom-title`, `atis-latch`,
  `queue-operation` — all observed) are skipped without throwing. A transcript
  is a log this tool does not own; a shape it has not seen must never fail a
  `stop`.

Reading the files themselves: a synchronous whole-file read plus a line split is
acceptable. Measured largest transcript on disk: 6.2MB. `stopItem` is
synchronous and `stop` runs once, so streaming buys nothing worth an async
refactor here.

### 4. The glue, and where it hooks into `stopItem`

Add `sessionTokensSince(startedISO, stampISO, env = process.env) -> number |
null`: resolve the config dir and session id from `env`, resolve files via step
2, parse and sum via step 3. Returns `null` — never throws, never partially
succeeds — for every failure alike: no `CLAUDE_CODE_SESSION_ID`, no matching
transcript, an unreadable file. `null` means "cannot attribute", which is
different from `0` ("attributed, and it was tiny").

Add `TOKEN_KEYS = { groom: 'groom-tokens', execute: 'execute-tokens' }` beside
the existing `ELAPSED_KEYS`, and for the same stated reason: a lookup keyed by
`PHASES`' own values, so a third phase added without an entry here fails loudly
rather than billing into `undefined-tokens`.

In `stopItem`:

- **Token billing rides the existing billable gate — do not add a second one.**
  The one `if` that already guards elapsed billing (`!abandon`, a recognised
  `phase`, `FULL_TIMESTAMP` matches, `Date.parse` finite) is exactly the right
  condition, because the token window *is* the interval the seconds are computed
  from. If that interval is not billable, neither is the window over it. This
  falls out for free in every case the existing comments already argue: a
  `--abandon` bills no tokens (the interval was not work anyone did, so neither
  were the tokens in it); a plain `start` with no `--as` bills nothing (no phase
  to key either bucket off); a legacy bare-date `started:` bills nothing (UTC
  midnight is not when work began, so the window is fiction); `--keep-started`
  bills tokens exactly as it bills seconds.
- Resolve the count **lazily, inside that branch**, so a non-billable stop never
  touches the filesystem looking for a transcript.
- Write the token key only when the resolved value is a number. `null` writes no
  key at all and does not disturb the elapsed billing beside it — an
  unattributable stop is still a successful stop, exit 0.
- Accumulate exactly like the elapsed buckets, and **reuse the `DIGITS_ONLY`
  refusal verbatim**: a token bucket already holding anything that is not a
  plain unsigned integer throws a code-1 `BacklogError` naming the key and the
  value, and the whole write is skipped. The reasoning in the existing comment
  transfers without change — resetting would silently destroy a real recorded
  total, and nothing about "this was hand-edited" should be allowed to erase it.
- `opts.tokens` is the test seam, mirroring how `stamp` already pins the clock:
  `undefined` means "resolve it yourself", any other value (a number, or `null`)
  is used as given. A real call site never supplies it. This is what lets the
  integration cases in `## Test cases` assert exact literals without building a
  transcript.
- When the stop was billable but the count came back `null`, print one line to
  stderr naming what was missing (the absent environment variable, or the
  session id whose transcript could not be found). Stdout stays exactly as it is
  — the item path, which existing tests assert. This is the
  `linkedWorktreeInfo` "non-fatal stderr note" pattern the repo already uses,
  and it exists for one specific reason: whether an *interactive* session
  exports `CLAUDE_CODE_SESSION_ID` was measured only on a headless `sdk-cli`
  session (see `## Done when`), so the first interactive `stop` after this ships
  either records a number or says why it could not, instead of failing silently
  forever.

No new CLI flag, and no change to the `stop` usage line.

### 5. The test-suite hazard — do not skip this

`run` in `backlog.test.mjs` spawns the real CLI as a child that **inherits the
test process's environment**. Run the suite from inside a Claude Code session
and every fixture `stop --as groom` would resolve the *developer's live
transcript* and bill real tokens into throwaway items — turning several existing
round-trip assertions red for reasons that have nothing to do with the change,
and only when the suite happens to be run from inside a session.

Neutralise it at the top of the suite, beside the existing
`process.env.BM_REGISTRY_FILE` line and with a comment giving the same shape of
reasoning: delete `CLAUDE_CODE_SESSION_ID` from `process.env`, and point
`CLAUDE_CONFIG_DIR` at a throwaway `mkdtempSync` directory. The tests that
*want* a transcript then opt in explicitly by passing an `env` override to the
spawn, which means `run` needs to accept one (an extra optional argument, or a
sibling helper — either is fine; keep every existing `run(dir, …)` call site
unchanged).

### 6. The server read side

Frontmatter round-trips unknown keys already, so the CLI half needs no parser
change. The server does: `scan.util.ts` maps fields **explicitly**, so without
this the numbers exist on disk and are invisible to every consumer.

- Add `groomTokens` and `executeTokens` to `BacklogItem` in `shared/types.ts`,
  documented in the register the neighbouring fields use, and say plainly in
  those comments what the number excludes and why (cache reads, per step 3) and
  that attribution is whole-session-within-the-window (per step 7) — a reader of
  the type is exactly who must not mistake it for a precise per-item bill.
- Map them in `scan.util.ts` through the existing `parseElapsed`, beside
  `groomElapsed`/`executeElapsed`. It is already the right clamp: `/^\d+$/` or
  `0`, so absent, negative, fractional and non-numeric all read as `0` and a
  hand-edited file cannot 500 a board. Do not write a second parser for it.

No client change. Nothing renders these — that is idea-3.

### 7. The caveat, stated on purpose

The count bills **every token the session spent inside the window**, not the
item alone. Groom item 3, then chat about something unrelated in the same
session, and the chat is counted. idea-1's second open question asked whether
that is good enough; the answer is yes, with the reason worth writing down
because it decides who should trust the number:

- **Under `backlog-orchestrate` it is very nearly exact.** Each item gets its
  own headless `backlog-execute` session, so the window covers that session and
  nothing else. The orchestrator is also the consumer that matters — it is where
  the expensive items are.
- **For hand grooming in a shared terminal it is noisy**, by exactly as much as
  the unrelated work in the window.

There is no tighter mechanism available: nothing in the transcript marks a turn
as being about item X, so `start`/`stop` is already the finest bracket that
exists. Do not invent a heuristic to narrow it. Say what the number is instead —
a rough complexity signal, right for "which items were expensive", wrong for
anything claiming precision — in the `shared/types.ts` comments and in the
invariant.

### 8. Docs

- Extend the `started:`/`phase:` invariant in `CLAUDE.md`: it currently says
  "two permanent, accumulating integer-seconds counters, one per activity". It
  becomes four counters, two per activity, and the bullet should name the cache-
  read exclusion and the whole-session-window caveat as the two things a future
  reader must not re-decide.
- Same treatment in `docs/invariants.md`, in the paragraph beginning "Two skills
  call `start`/`stop`".
- Grep `groom-elapsed` across `skills/` and `docs/` and update **every** place
  that enumerates the two counters — including the `start`/`stop` doc block
  inside `backlog.mjs` itself (around line 348) and `skills/backlog/SKILL.md`.
  An enumeration that still says "two" is the drift that makes the next reader
  distrust the whole file.
- Nothing needs publishing: this changes `skills/backlog/tools/backlog.mjs`,
  which `PUBLISHED_PATHS` already covers. The change reaches an install only
  after commit, push and `pnpm run plugin:sync`, per the existing invariant.

## Test cases

Authoritative. Skill tests go in `skills/backlog/tools/backlog.test.mjs` (node's
test runner); server tests are flat in `test/` under jest.

**`sumFreshTokens` — pure, literal fixture records.** Use a base usage of
`{input_tokens: 2, cache_creation_input_tokens: 38041, cache_read_input_tokens:
37538, output_tokens: 370}` throughout, so the expected fresh total is **38413**
in each of the first four:

1. Three `assistant` records sharing one `requestId`, `apiBlockIndex` 0/1/2,
   content types `thinking`/`text`/`tool_use`, each carrying that identical
   usage, all inside the window → `38413`. (A per-record sum would give 115239 —
   assert the deduped value, not merely "greater than zero".)
2. Same three records with `cache_read_input_tokens` raised to `999999` →
   still `38413`.
3. A single record whose usage adds `output_tokens_details: {thinking_tokens:
   281}` → still `38413`.
4. A single record whose usage adds an `iterations` array with one entry
   repeating all four top-level counts → still `38413`.
5. Two records with distinct `requestId`s, one timestamped one minute before
   `fromMs` and one inside the window → only the inside record's fresh total.
6. One record timestamped in the same second as `toMs` but with milliseconds
   (`…T09:51:50.900Z` against a `toMs` parsed from `…T09:51:50Z`) → counted.
7. One record timestamped exactly at `fromMs` (`…T09:51:50.000Z`) → counted.
8. A mix including `type: 'user'`, `type: 'attachment'`, `type: 'last-prompt'`
   and an `assistant` record with no `message.usage` → those contribute `0`,
   no throw.
9. An input containing one line that is not valid JSON, between two countable
   records → both records counted, no throw. (Assert this at whichever seam
   parses lines; if `sumFreshTokens` takes objects, cover it in the file-reading
   layer instead — but cover it.)
10. A countable record with no `requestId` but a `uuid` → counted exactly once.
11. Empty input → `0`.

**`transcriptFiles` — against a `mkdtempSync` fixture root.**

12. `<root>/proj-a/<sid>.jsonl` exists alongside three other project directories
    that do not contain it → returns exactly that one path.
13. Plus `<root>/proj-a/<sid>/subagents/agent-x.jsonl` and `agent-y.jsonl` →
    returns all three, main transcript first.
14. Plus `<root>/proj-a/<sid>/tool-results/foo.txt` and
    `<root>/proj-a/<sid>/subagents/agent-x.meta.json` → neither appears in the
    result.
15. `<sid>.jsonl` present under both `proj-a` and `proj-b` → both returned.
16. No directory contains `<sid>.jsonl` → `[]`.
17. `projectsRoot` names a path that does not exist → `[]`, no throw.

**`sessionTokensSince` — env-driven glue.**

18. `env` with no `CLAUDE_CODE_SESSION_ID` → `null`.
19. `env` with a session id but no matching transcript → `null`.
20. `env` with `CLAUDE_CONFIG_DIR` pointing at a fixture whose transcript holds
    the deduped three-record group from case 1, window covering it → `38413`.
21. Case 20 with `CLAUDE_CONFIG_DIR` unset and `HOME`-derived root empty →
    `null` (proves the variable is actually consulted, not ignored).
22. Case 20 but the transcript path is a *directory* rather than a file →
    `null`, no throw.

**`stopItem` integration — `opts.tokens` pinned, no filesystem transcript.**

23. `start --as groom`, then `stopItem` with `{tokens: 1234}` → frontmatter
    carries `groom-tokens: 1234`.
24. An item already holding `groom-tokens: 1000`, billable stop with
    `{tokens: 234}` → `groom-tokens: 1234`.
25. `start --as execute`, stop with `{tokens: 500}` → writes `execute-tokens:
    500` and leaves a pre-existing `groom-tokens:` value untouched.
26. `start` with **no** `--as`, stop with `{tokens: 999}` → **no** token key on
    the file at all, and no elapsed key either (same gate).
27. A legacy bare-date `started: 2026-08-30`, stop with `{tokens: 999}` → marker
    cleared, **no** token key and no elapsed billing.
28. `start --as groom`, `stop --abandon` with `{tokens: 999}` → marker cleared,
    `updated:` stamped, **no** token key and no elapsed billing.
29. `start --as groom`, `stop --keep-started` with `{tokens: 777}` →
    `groom-tokens: 777` written, `started:` still present, `phase:` gone.
30. `start --as groom`, billable stop with `{tokens: null}` → exit 0, **no**
    token key, and `groom-elapsed:` still billed as normal.
31. An item holding `groom-tokens: 12x`, billable stop with `{tokens: 5}` →
    code-1 `BacklogError` naming the key and the value `12x`, and the file
    byte-for-byte unchanged (including `started:` still present — the whole
    write is skipped, exactly as the elapsed refusal already behaves).
32. Round-trip: an item with an unknown key such as `from:` plus a body
    containing its own `---` line, through `start --as groom` then a stop that
    writes a token key → body byte-for-byte identical and the unknown keys in
    their original relative order. (Mirror the two existing round-trip tests
    rather than writing a new style of assertion.)

**CLI end-to-end — the one test that proves env → file → frontmatter.**

33. Build a fixture config dir containing `projects/<slug>/<sid>.jsonl` whose
    records fall inside the window, spawn `start --as groom` and then `stop`
    with `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_SESSION_ID` set in the child's
    env → exit 0, item path on stdout, and `groom-tokens:` equal to the
    fixture's fresh total. Note the window: stamp the fixture records inside a
    generous range around "now" (or pin both stamps through the seams the tool
    already exposes) rather than hard-coding a date that ages out of the window.
34. Same spawn with `CLAUDE_CODE_SESSION_ID` absent from the child env → exit
    0, item path on stdout unchanged, no token key, and exactly one stderr line
    naming the missing variable.
35. Regression: with the ambient neutralisation from plan step 5 in place, every
    pre-existing `start`/`stop` test passes unchanged and no fixture item gains
    a token key. Run the whole skill suite from inside a Claude Code session to
    confirm — that is the environment the hazard only appears in.

**Server.**

36. `parseElapsed`-backed mapping: an item file with `groom-tokens: 4200` and
    `execute-tokens: 7` scans to `groomTokens: 4200`, `executeTokens: 7`.
37. Absent keys → `0` for both. Values `-5`, `4.2` and `abc` → `0`, and the item
    is still present in the scan result (not dropped, not an error).
38. `GET /api/items` for a fixture project carries both fields on every item.

**No browser test case, deliberately.** Nothing in this task renders, so there
is no page to open and no element to assert; the observable surface is the
frontmatter and the `/api/items` payload, both covered above. Do not invent a
Playwright check to satisfy the shape of a task file — the rendering work is
idea-3's, and its browser check belongs there.

## Done when

- `pnpm run test:skills`, `pnpm test` and `pnpm run typecheck` all pass, and
  `pnpm test` was run at least once from inside a Claude Code session (case 35).
- A real `start --as groom` / `stop` pair in this repo writes a plausible
  `groom-tokens:` value — same order of magnitude as the fresh total the
  transcript actually holds, not a 2-3x multiple of it (which is what a missed
  `requestId` dedupe looks like, and it is easy to miss because the number is
  still "plausible" in isolation).
- **The interactive-session question is settled in writing.** Every measurement
  behind this task came from a headless `sdk-cli` session; whether an
  interactive session exports `CLAUDE_CODE_SESSION_ID` was never observed. Run
  one `stop` from an ordinary interactive session and record the answer — in the
  item's `## Outcome` if it works, and as a new bug citing this task if the
  stderr note from plan step 4 fires instead. Do not close this task on the
  headless evidence alone.
- The counters are documented in `CLAUDE.md`, `docs/invariants.md` and
  `shared/types.ts`, and no enumeration anywhere still claims there are two.
- No `hooks/` directory, and `PUBLISHED_PATHS` unchanged.

## Outcome

2026-09-04 — Implemented as planned, with no hook and no change to the plugin's
publish surface. `backlog.mjs` gained `transcriptFiles`, `sumFreshTokens` and
`sessionTokensSince` (all exported for test) plus `TOKEN_KEYS`, and `stopItem`
now bills `groom-tokens:`/`execute-tokens:` off the existing billable gate,
lazily and with `opts.tokens` as the test seam. The server maps both keys
through the existing `parseElapsed` into `BacklogItem.groomTokens` /
`executeTokens`. Every `## Test cases` case is covered: 35 new skill tests
(node's runner) and the server assertions folded into `test/items.test.ts`'s
existing scan case rather than new fixture files, so the project open-counts
assertion stayed true.

**All three verification commands, run fresh at the end:**

```
=== pnpm run test:skills ===
1..343
# tests 343
# pass 343
# fail 0
# duration_ms 52175.776625
=== pnpm test ===
Test Suites: 57 passed, 57 total
Tests:       952 passed, 952 total
Time:        46.97 s
=== pnpm run typecheck ===
$ tsc --noEmit
typecheck exit: 0
```

`pnpm test` and `pnpm run test:skills` were both run from inside a Claude Code
session with `CLAUDE_CODE_SESSION_ID` live in the environment — the one
environment plan step 5's hazard appears in. Green with the neutralisation in
place; no fixture item gained a token key.

**The tests were mutation-checked**, because the implementation was written
before them and a suite that has never been red proves nothing. Re-adding
`cache_read_input_tokens` to the total: 12 failures. Removing the `requestId`
dedupe: 6 failures. Restored: 197/197 (the skill file's own count at the time).

**A real `start --as groom` / `stop` pair**, run against a scratch git repo with
this session's actual environment and actual transcript, wrote:

```
started: 2026-09-04T21:06:04Z
phase: groom
---
groom-elapsed: 8
groom-tokens: 893
```

Cross-checked against the transcript by a separate ad-hoc counter over the same
window: one API turn, split across two records (`apiBlockIndex` 0 and 1) with
byte-identical usage. Deduped fresh total **893** — exactly what the CLI wrote —
against a naive per-record sum of **1786**, and a `cache_read_input_tokens` of
**150,223** on each record. So both of the rules the plan called load-bearing are
demonstrably active on real data: the number is not the 2x a missed dedupe
produces, and it is not the ~151k a raw total would have been for one turn.

**Not settled, and deliberately left open: the interactive-session question.**
This session's `CLAUDE_CODE_ENTRYPOINT` is `sdk-cli`, so every measurement above
is still headless evidence, exactly as the plan's `## Done when` warned. What is
now true is that a headless `stop` records a correct number, and that an
environment without `CLAUDE_CODE_SESSION_ID` exits 0 and prints one stderr line
saying so rather than failing silently — so whoever runs the first interactive
`stop` will get an unambiguous answer either way. Per `## Done when`, this task
should not be closed on headless evidence alone.

**Docs.** The counter enumeration was updated in `CLAUDE.md` (four counters, two
per activity, plus the two facts a later reader must not re-decide),
`docs/invariants.md` (a new run of paragraphs covering the transcript
resolution, the three counting rules with their measurements, the attribution
caveat and the no-key-for-null rule), `shared/types.ts`, the README `init`
writes, `skills/backlog-execute/SKILL.md`, `skills/backlog-groom/SKILL.md` and
`skills/backlog-orchestrate/references/recovery.md` (the last two because their
`--abandon` reasoning now covers tokens too). `skills/backlog/SKILL.md` turned
out to enumerate nothing — it is the read-only board skill and never named the
buckets. The dated plan and spec files under `docs/superpowers/` were left
alone on purpose: they record what task-1 was asked to build in August, and
editing them would falsify that record rather than fix drift.

No `hooks/` directory exists and `PUBLISHED_PATHS` is unchanged
(`['skills', '.claude-plugin', 'agents']`).

**Why this item's own frontmatter has `execute-elapsed:` but no
`execute-tokens:`.** The execute session's `start`/`stop` pair ran the
INSTALLED plugin copy (`~/.claude/plugins/cache/.../0.1.1`), which predates this
change — an install is a copy of the pushed HEAD, never the working tree, per
the existing publish invariant. The absence is that invariant working, not a
missed write. This item will gain a token count on the first `start`/`stop` pair
run after this branch is merged, pushed and `pnpm run plugin:sync`ed.

### 2026-09-05 — the interactive-session question, settled

Both open steps are now closed, in order.

**1. Published.** The branch merged as `28b8d21`, `main` is level with
`origin/main`, and `pnpm run plugin:sync` has run: the installed copy
(`~/.claude/plugins/cache/backlog-manager-marketplace/backlog-manager/0.1.1/skills/backlog/tools/backlog.mjs`)
carries `sumFreshTokens`, and the marketplace clone sits at the same HEAD as the
repo. So the publish-boundary note above — accurate on 2026-09-04 — no longer
describes the installed state.

**2. `CLAUDE_CODE_SESSION_ID` is exported outside headless too.** Measured in a
Claude Code session whose `CLAUDE_CODE_ENTRYPOINT` is `claude-desktop` — not
`sdk-cli`, not `claude -p`, not board-spawned. The `start --as groom` / `stop`
pair below was run through the **installed** CLI, from the repo root, in that
session's own environment, so it exercises the whole published path rather than
the working tree:

```
started: 2026-09-05T11:10:10Z
phase: groom
---
groom-elapsed: 43
groom-tokens: 6527
```

The stderr note from plan step 4 did **not** fire, which is the unambiguous
signal `## Done when` asked for: the variable is present, the transcript was
resolved by directory scan (one file, the main transcript, flushed live
mid-session at 160KB), and a real number was billed. A separate read-only probe
of `sessionTokensSince` over a 20-minute window in the same session returned
`63569`, so the mechanism is not merely non-null — it tracks the session's
actual fresh spend at the right order of magnitude.

**Cross-checked by an independent counter over the same window**
(`2026-09-05T11:10:10Z` → `11:10:53Z`), the way the 2026-09-04 entry checked
the headless number — because a plausible figure is exactly what a missed
dedupe also produces:

```
records in window      : 6
distinct request ids   : 3
deduped fresh total    : 6527    ← what the CLI wrote
naive per-record sum   : 13054   ← what a missed requestId dedupe writes
cache_read in window   : 676452  ← what a raw total would have written
```

Both rules the plan called load-bearing are therefore active on real
*interactive* data, not just headless: the number is not the 2x, and it is not
the ~104x a raw total would have made of the same 43 seconds. That last ratio
is worth keeping in view — it is the step-3 measurement (9:1 fresh-to-cache-read
on a headless session) restated for a desktop session with a large resident
context, and it runs the other way, harder. The exclusion matters more here,
not less.

**What this does and does not prove.** It proves the variable is not
`-p`-only, and that the mid-session transcript flush the whole task rests on
holds outside a headless run. It does *not* separately cover the terminal TUI
(`CLAUDE_CODE_ENTRYPOINT=cli`), which was not measured. That gap is deliberately
not treated as blocking: the entrypoint values are set by the harness, not by
the skill, and a session that somehow lacks the variable exits 0 with one
stderr line saying so — so the failure mode is self-reporting rather than
silent, which was the point of building the note in the first place.

**One drift found and fixed while verifying.**
`server/src/items/parse.util.ts`'s `parseElapsed` doc comment still described
itself as the parser for `groom-elapsed` / `execute-elapsed` alone, though
`scan.util.ts` had been routing the two token keys through it since this task
landed. Plan step 8's sweep was scoped to `skills/` and `docs/`, which is
exactly why `server/` escaped it — worth recording, because the next
enumeration-widening task will want a wider grep than that one used. The
comment now names all four counters and says why one parser serves both.

**Verification re-run fresh on 2026-09-05**, after the watchdog and merge-mode
branches merged on top of this work:

```
pnpm run test:skills  → 343/343 pass, 0 fail
pnpm test             → 67 suites, 1126/1126 pass
pnpm run typecheck    → exit 0
```

The jest count grew from 952 to 1126 with those later branches; the skill count
is unchanged at 343, and nothing in this task's own surface regressed.
