# Tick breaker — Design

Follow-up to `/backlog-tick` (PR #330, spec `2026-10-22-backlog-tick-design.md`). A scheduled tick that keeps failing keeps spending: each failed execute or
groom is a full headless session, and the per-item skip only stops the SAME item from being retried — the next tick picks the next item and fails the same
way when the cause is the environment (a red base branch, a broken toolchain, a lost token). This adds a per-project **failure breaker**: after N failures in
a row, a project's ticks stop until a person resets it. N is set once, on the board's Settings, and the halt and its history are shown on a new
**Runs › Ticks** page.

## Goals

- A project whose last N recorded tick outcomes are all `failed` stops ticking: `tick.mjs decide` answers `idle` with a `halted` reason and starts nothing.
- N is configured on the board (Shared Settings), default 3, range 1–10, global to the machine.
- A person sees which projects are halted, why, and the recent tick history, on Runs › Ticks — and clears a halt there with one Reset.
- The breaker works with the stack down: `decide` reads files only. (A tracker project still answers `idle: stack down` first, as today.)

## Non-goals

- **The usage gate** ("don't tick above 80 % of my plan") — it belongs to the claude-agents-dashboard scheduler, which owns the usage reading
  (`server/lib/usage.ts`) and the spawn. A separate change in that repo.
- **Time-based expiry.** A halt never clears itself. An environment that broke at 02:00 is still broken at 08:00 unless someone looked.
- **Moving `--max-prs`, `--max-plans`, `--lock-ttl`, `--base` to Settings.** They stay `decide` flags, set in the scheduler job's prompt. (My call: they are
  per-job policy, already have a home, and nothing in this change needs them on the board.)
- **Per-project N.** One global number. A per-project override can come later without changing the file's shape much.
- **Cost per tick.** Not recorded today; not added here.
- **Recording `busy`/`idle` verdicts.** Only `record`'s `ok`/`failed` reach `state.json`, as today.

## Anti-goals

- A halt that clears without a person — by time, by restart, by a malformed settings file.
- A stored `halted` flag. The halt is derived from the records every time, like groomed-ness and Board-versus-Archive.
- A second writer under `~/.backlog-manager/tick/`. The server only reads it.
- A Reset that forgets item records. `forget '<id>'` stays the per-item retry; Reset is the per-project one.

## Data

### Existing, unchanged: `~/.backlog-manager/tick/<encodeURIComponent(root)>/state.json`

`{ items: {id → rec}, recent: [{at, id, kind, outcome, reason}, …] }`, `recent` capped at the last 50 (`RECENT_MAX`). Written only by `tick.mjs`
(`recordOutcome`), including the `failed` / `killed at timeout` record `recover` writes for a stale lock that named a unit. **This is the breaker's only input** — no new
log, no new field.

### New: `~/.backlog-manager/settings/tick.json`

```json
{ "haltAfter": 3, "resetAt": { "/abs/path/of/main/checkout": "2026-10-22T08:14:03.000Z" } }
```

- **One writer, the server.** `tick.mjs` reads it; nothing else writes it. `jira.json`'s posture, stricter (a parsed non-object is unreadable here): a file that exists but cannot be read or parsed is
  **never replaced** — both write routes refuse with `409` and a message naming the file, until a person fixes or removes it by hand.
- Lives under `settings/` because that is the one read-write mount the container has (`docker-compose.yml`). One file for both the setting and the resets
  (my call: both have the same writer and the same reader, and `orchestrator-control/` is split per project only because its reader is per run).
- `haltAfter`: integer 1–10. Missing → 3. Out of range → clamped. Non-integer → 3 (the `clampAttempts` rule in `watchdog-config.util.ts`).
- `resetAt`: map of main-checkout absolute path → ISO timestamp. Keyed by the same path `projectDir` encodes, never by display name. A non-string value or a
  value that does not parse as a date is ignored (that project reads as never reset).
- `BM_TICK_FILE` overrides the path, for tests (the `BM_WATCHDOG_FILE` / `BM_JIRA_FILE` seam).
- Two concurrent POSTs are read-merge-write with no serialisation, so the later write wins and the earlier one's change can be lost — accepted, the
  `jira.json` precedent (one person, one board).
- The server only ever writes `resetAt` as "now". A hand-edited `resetAt` in the future masks every record until the clock passes it — accepted, a
  hand edit's own consequence.

### Reading `tick.json` when it is broken

| File state | `tick.mjs decide` | Server `GET` | Server `POST`s |
| --- | --- | --- | --- |
| absent | N = 3, no resets | `source: "default"` | write it |
| valid | as written (clamped) | `source: "file"` | merge and write |
| unreadable / not JSON / not an object | `idle`, reason `<path of tick.json> unreadable — fix or remove it by hand`; no unit runs | `source: "unreadable"`, plus the error, `haltAfter: 3` for display | `409`, file untouched |

No unit runs on any project while the file is broken. Falling back to a default N would un-halt a project whose written N was 1 or 2, and dropping the
resets would re-halt one a person just cleared; stopping is the only fallback that is never wrong in the unsafe direction — the `state.json` posture.

## The breaker

**Streak** for a project = walk `recent` newest-first; count entries whose `outcome` is `failed` and whose `at` is later than the project's `resetAt` (if
any); stop at the first `ok`, or the first entry at or before `resetAt`. Entries with an unparseable `at` stop the walk (treated as older than everything); this test comes first, whatever the outcome.
An entry whose `outcome` is neither `ok` nor `failed` neither counts nor stops the walk (none is written today; a future outcome must not silently reset a
streak).

**Halted** = streak ≥ `haltAfter`.

Both are derived on each read, on both sides. `tick.mjs` and the server each carry one copy of the streak function (a skill's `tools/` never imports from
the server — the same boundary that keeps `orchHome()` and `pauseRequestEffective` in two places); the two copies are pinned by the same table of test
cases on each side.

Consequences, all intended:

- `ok` resets the streak. A `failed` groom then an `ok` execute → streak 0.
- Groom and execute failures count together. The breaker is about the project's environment, not the unit kind.
- `recover`'s `killed at timeout` is a `failed` record and counts.
- Lowering N below a project's current streak halts it at the next `decide`; raising N above it un-halts it at the next `decide`. Nothing is written for
  either.
- Reset while a tick is running: the running tick finishes and records; its record is later than `resetAt`, so if it failed the new streak is 1.
- `forget '<id>'` does not touch the streak — it drops `items[id]` and leaves `recent` alone, as today.
- With 50 entries kept and N ≤ 10, the window can never be too short to see a streak.

### Where `decide` checks it

After the lock step (3) and its `recover` branch, before the API reads (the runs and items) and the busy check (4). A stale lock is still recovered while
halted — recovery is cleanup, and it releases the lock — but no unit is chosen. On a tracker project the stack check (2) still comes first, as today.

So the order is: stack down (tracker) → `busy` "another tick" for a held lock → `recover` for a stale one (that call records `failed` when the lock named a unit and answers
`recover`, or `busy` when it loses the claim race — never `idle`) → `idle` halted → API reads → busy → execute/groom. The `recover` record can itself complete a streak; the NEXT `decide` is then
`idle` halted.

`readState` moves up with the check (today it runs after the busy check). An unreadable `state.json` keeps today's behaviour — `readState` throws with the
same message as today and `decide` fails as it does now — just earlier. No unit runs either way, so a broken file can never
un-halt a project. (My call.)

Verdict when halted: `{"verdict":"idle","reason":"halted: 3 failures in a row (halt after 3) — reset on the board, Runs › Ticks", …}`. When `tick.json`
is unreadable the verdict is `idle` with its own reason (the table above), at the same point in the order. `idle` keeps the skill's existing handling: no `record`, final message is the
reason, so a halted tick spends one tool call and no execute or groom session.

`--dry-run` reports the same verdict.

### `tick.mjs status`

Gains one line after the lock line: `breaker: 1 of 3 failures in a row` or `breaker: HALTED — 5 failures in a row (halt after 3) since <at of the oldest counted>`,
and `(reset <resetAt>)` when one is on file. `status --json` (today `{lock, recent}`) gains
`breaker: { streak, haltAfter, halted, resetAt | null, settings: "default" | "file" | "unreadable" }`. (My call.)

## Server

A new module `server/src/tick/` — not an outbound-calling module. It only reads `~/.backlog-manager/tick/` and reads/writes `settings/tick.json`.

- **`GET /api/ticks`** — read-only, unguarded like the other GETs. Answers:
  - `config`: `{ haltAfter, source: "default" | "file" | "unreadable", error? }`.
  - `projects`: one entry per directory under the tick home (`BM_TICK_HOME`, else `~/.backlog-manager/tick/`, read per request like `BM_ORCH_HOME`) whose
    name decodes to an absolute path (a name `decodeURIComponent` throws on, or one that decodes to a relative path, is skipped): `{ root, name, streak, halted, haltedSince?, resetAt?, lock?, recent, error? }`.
    - `name`: the registry's display name for that root when registered, else the path's basename.
    - `lock`: `{ kind, id, host, at }` from the lock file when one exists — "a tick is running". Stale-or-not is not judged here (the TTL is a job flag the
      server cannot see); `at` is shown and the reader judges.
    - `recent`: the file's `recent` (stored oldest first) reversed to newest first, entries unchanged.
    - `error`: set when `state.json` is unreadable; then `streak`/`halted` are absent, and the row says the file needs fixing by hand (the same message
      `tick.mjs` throws).
    - A directory with no `state.json` yet (a first tick holding the lock) is listed with `recent: []`, streak 0. A root that is gone from disk and the
      registry is still listed, by basename — its history is still true, and Reset still works on it. (My call.)
  - Read fresh on every request, cached nowhere — the `readWatchdogConfig` reasoning.
- **`POST /api/ticks/config`** `{ haltAfter }` — `SameOriginPostGuard` (content-type + origin). `haltAfter` must be an integer (else `400`), then clamped to 1–10, merged over the current file (keeping `resetAt`),
  written atomically (tmp + rename). `400` for a non-object body; `409` when the file is unreadable. Answers the fresh `GET` payload.
- **`POST /api/ticks/reset`** `{ project }` — same guard. `400` for a non-object body or a `project` that is not a string holding an absolute path; `404`
  for a well-formed path with no entry under the tick home (no arbitrary keys in the file). Sets `resetAt[project]` to now — or, if later, the newest `at` in that project's `recent`, so a container clock lagging the host's can never leave the
  newest failure "after" the reset — merged and written atomically. Reset is allowed in every state — halted or not, lock held or not —
  zeroes the streak (every earlier record is now at or before `resetAt`) and touches no lock. A tick running across the Reset records after it, so its
  failure starts a new streak at 1. `409` when the file is unreadable. Answers the fresh `GET` payload. (My call.)

Docker: no change. The tick home is under the read-only `~/.backlog-manager` bind, which the server reads; `settings/` is already read-write.

## Client

### Runs › Ticks (picked mock A)

A third Runs page. `RunsMode` gains `'ticks'` (`lib/runs-mode.ts`, after `'watchdog'`); the rail's Runs tree gains a **Ticks** row; switched by the tree
only, never an in-page control (the existing invariant). Built from the Watchdog page's parts: `Band`, a 3-figure strip, `Sheet`s, the
`watchdog-table` / `watchdog-kind-*` table styles. Polls `GET /api/ticks` through `useCoalescedFetch` every 15 s while the page is mounted (my call:
ticks are hourly; the Watchdog hook's armed 5 s buys nothing here, and 15 s is its idle cadence).

- **Band:** "Runs · Ticks". Sub-line: "`<h>` halted · `<p>` with tick history" (halted part omitted at 0). Right: "Policy in Settings ›" chip — flat and inert like the
  Watchdog page's (`WatchdogMonitor.tsx`: no section setter reaches the Runs pages), title `Settings › Backlog tick`.
- **Figures:**
  - *breaker* — "`<h>` halted" (bad ink when > 0, else "none halted"); line: the halted projects' names, or "after `<N>` failures in a row".
  - *last 24 h* — "`<n>` ticks"; line: "`<ok>` ok · `<failed>` failed", counted from every project's `recent` with `at` in the last 24 h (bounded by the 50-entry cap; hourly ticks keep two days).
  - *policy* — "halt after `<N>` failures", "history on `<p>` projects"; line: "a reset clears the count, not the item records". When `source` is
    `unreadable`, the line instead says `tick.json` cannot be read and the board is showing the default.
- **Projects sheet:** one row per project, halted first, then (halted rows among themselves too) by last tick newest first, then projects with `recent: []`, then unreadable ones last;
  ties by name.
  - Halted: bad tint, pill "halted", "`<streak>` failures in a row since `<time>` · last: `<reason>` on `<id>`", and a **Reset** button
    (`POST /api/ticks/reset`; disabled while in flight; an error shows inline under the row).
  - Not halted: pill "ticking" when a lock is present, else no pill; "last tick `<time>` · `<kind>` `<id>` → `<outcome>` · `<streak>` failures in a row".
  - Unreadable `state.json`: muted row, the error text, no Reset.
- **Activity sheet:** every project's `recent` merged newest first, at most 50 rows. Columns: time / outcome (`✓ ok` done-kind, `✕ failed` bad-kind) /
  project / did (`groom` | `execute`) / item / what happened (`reason`). No "skipped" or "halted" rows — those are not records (mock A showed both; dropped).
- **Empty state:** `projects` is empty (a lock-only project with `recent: []` is not empty — it draws a row with the "ticking" pill) → the band and the three figures stay (so an unreadable `tick.json` still shows), and the sheets give way to one: "No project has ticked yet. A tick starts from a scheduled job running `/backlog-tick`."
- **API unreachable:** the Watchdog page's pattern — band stays, one sheet: "Could not reach the tick history — `<error>`. This page will fill in once
  the API answers `GET /api/ticks` again."

This text is the whole visual contract; mock A was a throwaway screenshot over the live app and is not in the repo. Anything it does not say (pill
tints, column widths, the below-700 px rail) follows the Watchdog page and its DESIGN.md §8 citations.

Differences from mock A, called out: no cost anywhere; no "skipped"/"halted" activity rows; the policy figure drops "lock expires 180m" (the server cannot
see the job's flag) and says "history on" instead of "ticks on".

### Shared Settings — "Backlog tick" card

On the **Shared** page (the page is the scope: this is a machine-wide file), scope label "this machine" (as Trackers and Claude Agents), after the Watchdog group. One control: **Halt after
`<N>` failures in a row**, a Select of 1–10 (not a number input — the Watchdog group uses Selects so a silently clamped or half-typed value is never
saved), saved on change through `POST /api/ticks/config`, with the Watchdog group's save-error slot for a refused write. It reads through the same hook as
the Ticks page, one-shot (`live: false`, the `useWatchdog` pattern: Settings is nothing live), and redraws from the POST's answer. (My call.) A one-line hint under it: "A halted project stops ticking until reset on Runs › Ticks." When `source` is `unreadable`, the control is disabled and
the hint names the file and says to fix or remove it by hand.

## Skill

`skills/backlog-tick/SKILL.md`: the `idle` branch's wording covers `halted` (no behaviour change — `idle` already means "do not record, report the
reason"). One line in the skill's notes: a halted project is reset on the board, not by `forget`.

## Docs and rules

- CLAUDE.md: the Layout line for `server/src/` gains `tick/`; two new invariant headlines —
  - **`~/.backlog-manager/settings/tick.json` has exactly one writer, the server, and a file that cannot be read is never replaced.**
  - **A tick halt is derived from `state.json`'s `recent` and the reset time, never stored, and only a person's Reset clears it.**
- `docs/subsystems/invariants.md`: the reasoning for both; the existing "`~/.backlog-manager/tick/` has exactly one writer" entry gains that the server
  reads it.
- `.claude/rules/`: a new `.claude/rules/tick.md` (`paths: ["server/src/tick/**"]`) is the home of the `tick.json` headline's mechanism; the
  halt-derivation headline's goes in `.claude/rules/skills.md`. One home per anchor (`test/claude-rules.test.ts`); CLAUDE.md's "ten path-scoped files"
  becomes eleven.
- `docs/subsystems/api.md` (three routes), `board.md` (the page, the card), `skills.md` (the breaker in `decide`, the `status` line).

## Tests

Node (beside the tool), `skills/backlog-tick/tools/`:

- Streak table: `[]` → 0; `[failed]` → 1; `[failed, failed, ok]` (oldest→newest) → 0; `[ok, failed, failed]` → 2; three `failed` with `resetAt` between the
  1st and 2nd → 2; `resetAt` after all → 0; `[failed, failed(at: "garbage"), failed]` → 1; `[failed, failed(outcome: "skipped"), failed]` → 2; `[failed, (outcome: "skipped", at: "garbage"), failed]` → 1; mixed
  groom/execute failures count together.
- `decide` halts at streak = N and not at N−1; N read from `tick.json`; absent file → 3; malformed file → `idle` with the unreadable reason even at streak
  0; out-of-range 0 → 1, 42 → 10; a stale lock while halted is still recovered (verdict `recover`), and the next `decide` is `idle` halted.
- Lowering N in the file halts without any new record; a `resetAt` later than the last failure un-halts.
- `status` prints the breaker line in both states.

Jest (`test/`, flat):

- The server's streak function against the same table.
- `GET /api/ticks`: two projects (one halted, one not), distinct roots and distinct recents, so a swapped or unscoped read fails; an unreadable `state.json`
  row; a lock present; a registered name vs basename fallback; `source` in all three states.
- `POST /api/ticks/config`: clamps 0 → 1 and 42 → 10; `"7"` and `2.5` → `400`; keeps `resetAt`; `409` and file byte-identical when unreadable; guard refuses a cross-origin POST and a non-JSON body.
- `POST /api/ticks/reset`: non-object body and relative or non-string `project` `400`; unknown project `404`; known project writes `resetAt`, keeps `haltAfter`; a `recent` whose newest `at` is ahead of the server clock stamps that `at`; `409` when unreadable.
- jsdom: the Ticks page renders halted-first order, the Reset click posts the right root and redraws from the answer, the empty state, the unreachable
  state; the rail tree shows Ticks and switches to it; the Settings card saves and disables on `unreadable`.

## Left to the builder

- Component and file names inside `server/src/tick/` and `client/src/components/runs/`.
- Exact poll hook shape, as long as it follows `useCoalescedFetch`'s one-in-flight rule.
- Whether the Activity table shares a component with the Watchdog page's or copies its markup.
- Where in the `.claude/rules/` files the bullets go, within the `test/claude-rules.test.ts` constraints.

## Calls I made (check these)

- One `tick.json` for both `haltAfter` and the resets, not a separate control directory.
- `recent` is the only input; no new log file; streak derived, never stored.
- Groom and execute failures share one streak; `recover`'s timeout record counts.
- The breaker check sits after the lock/recover step, before the API reads.
- The existing `decide` flags stay flags.
- Activity shows recorded outcomes only; no cost, no skipped/halted rows.
- Ticks page polls every 15 s; the rail row is always drawn, with an empty state.
- Reset of an unknown project is `404`; allowed in every other state, zeroes the streak, never touches a lock.
- An unreadable `tick.json` stops every project's ticks (no default-N fallback).
- Unreadable `state.json` keeps today's throw, just earlier in `decide`.
- `status --json` gains a `breaker` object.
- The Settings control is a Select, read one-shot through the Ticks page's hook.
- A tick dir with no `state.json` lists as empty history; a vanished root still lists, by basename.
