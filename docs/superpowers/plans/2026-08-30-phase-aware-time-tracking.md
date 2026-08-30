# Phase-aware time tracking (task-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `stop` bills groom time separately from execute time, and every skill-driven touch of an item leaves an `updated:` stamp the board can read.

**Architecture:** Two new frontmatter keys carry the state (`phase:` while work is live, `updated:` always), two carry the accumulated result (`groom-elapsed:`, `execute-elapsed:`, integer seconds). `writeItemFile` is the single place `updated:` is stamped, which is reached only by `start` and `stop` — `moveItem` stays a pure `renameSync` and never rewrites content. The server surfaces the four values; the client formats them.

**Tech Stack:** Node ESM (no deps) for the CLI, node's own test runner for skill tests; NestJS + React + jest for the app.

**Spec:** [docs/superpowers/specs/2026-08-30-board-growth-design.md](../specs/2026-08-30-board-growth-design.md) — section "Time and phase". Backlog item: `backlog/tasks/open/task-1-phase-aware-time-tracking-start-as-elapsed-buckets-updated-stamp.md`.

## Deviation from the writing-plans template — read this first

This plan gives **signatures, behaviour, and exact test cases with literal
expected values. It deliberately does not hand you implementation code**, and
that overrides the skill's "No Placeholders / code blocks required" rule. The
user's CLAUDE.md requires it, for a reason earned twice: handed code gets
transcribed verbatim, so a bug in the plan becomes a bug in the branch with
nobody positioned to catch it — and test scaffolding is the worst offender,
because it reads as boilerplate.

What that means for you, the implementer:

- The **test cases are authoritative**. Every input and every expected output
  below is exact. Write those tests, in the repo's existing style, and make
  them pass.
- The **implementation is yours**. If a described approach is wrong, say so
  and do the better thing — you are reading the actual code and this plan's
  author was reading it from a distance.
- Where a name or a signature is given, it IS binding, because later tasks
  and other files depend on it.

## Global Constraints

- **pnpm only**, pinned by `packageManager`.
- **`status:` in frontmatter stays banned.** `parseFrontmatter` throws on it. `phase:` is not a status and must not become one — it exists only while `started:` does, and `stop` removes both together.
- **`start`/`stop` must round-trip unknown keys and the body byte-for-byte.** Only bytes inside the `---` fence may differ. `from:` and `promoted-to:` are the live examples.
- **`moveItem` stays a `renameSync` that never opens the file.** Do not make it stamp anything.
- **Frontmatter is a scalar line splitter, not YAML.** No nesting, no arrays except `tags`. New keys are kebab-case (`groom-elapsed`), matching `promoted-to`.
- **Timestamps are second-precision UTC with a `Z`** (`2026-08-28T14:03:07Z`), produced by `nowISO()`. Bare `YYYY-MM-DD` values written by older builds stay valid forever and must never be rewritten.
- **Skill tests** live beside the tool (`skills/backlog/tools/backlog.test.mjs`) and run under node's own runner via `pnpm run test:skills`. App tests are flat in `test/`, jest, `pnpm test`.
- **Comments explain *why*, at length.** The existing density is deliberate — match it.
- **`skills/` changes ship only through git.** Editing them changes nothing until committed, pushed, and `pnpm run plugin:sync`.
- Branch before the first commit; `main` is the default branch.

---

### Task 1: `updated:` stamped inside `writeItemFile`

**Files:**
- Modify: `skills/backlog/tools/backlog.mjs:579` (`writeItemFile`)
- Test: `skills/backlog/tools/backlog.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `writeItemFile(absPath, data, body, stamp = nowISO())` — stamps `updated: <stamp>` into `data` before rendering. The fourth parameter exists so tests can pin the value; every production caller omits it.

**Why here and not in the callers:** `writeItemFile` has exactly two callers, `startItem` and `stopItem`, and they are precisely the two operations that should refresh the stamp. Putting it in the shared function means a third caller added later cannot forget it.

**Key ordering matters.** `renderFrontmatter` iterates `Object.entries(data)` in insertion order. A spread preserves an existing key's position and appends a new one. So an item that already has `updated:` keeps it where it was, and one that does not gains it after its last existing key. Neither case may reorder anything else.

- [ ] **Step 1: Write the failing tests**

In `skills/backlog/tools/backlog.test.mjs`, following the existing suite's setup style (temp store, real files):

| Case | Setup | Expected |
|---|---|---|
| stamp added | item with `id`, `title`, `created`; run `start` with pinned stamp `2026-08-30T12:00:00Z` | frontmatter gains `updated: 2026-08-30T12:00:00Z` as the **last** key before the closing `---` |
| stamp replaced in place | item whose frontmatter is `id`, `updated: 2026-01-01T00:00:00Z`, `title`; run `start` | `updated` holds the new value and is still the **second** line, with `title` after it |
| stop stamps too | started item; run `stop` | `updated` present and equal to the pinned stamp |
| unknown keys survive | item carrying `from: idea-3` and `promoted-to: task-9`; run `start` then `stop` | both keys present, unchanged, in their original relative order |
| body byte-identical | item whose body contains a `---` line, trailing whitespace, and a final newline; run `start` then `stop` | the text after the closing fence is byte-for-byte what it was |
| move does not stamp | item with no `updated:`; run `move <id> done` | the moved file still has no `updated:` key and its bytes are unchanged |

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
pnpm run test:skills
```

Expect the first five to fail on a missing `updated` key; the sixth should already pass and is a regression guard, not a target.

- [ ] **Step 3: Implement**

Add the parameter and the stamp to `writeItemFile`. Write the comment explaining why the stamp lives here rather than in each caller, and why `move` is deliberately excluded.

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
pnpm run test:skills
```

- [ ] **Step 5: Commit**

```bash
git add skills/backlog/tools/backlog.mjs skills/backlog/tools/backlog.test.mjs
```

Message: `feat(backlog): stamp updated: on every start and stop`. Explain in the body that `move` is excluded on purpose and how coverage survives anyway (the skills always `stop` before `move`).

---

### Task 2: `start --as groom|execute` writes `phase:`

**Files:**
- Modify: `skills/backlog/tools/backlog.mjs:616` (`startItem`), `:739` (`START_STOP_USAGE`), `:954` (the shared start/stop CLI block)
- Test: `skills/backlog/tools/backlog.test.mjs`

**Interfaces:**
- Consumes: `writeItemFile(..., stamp)` from Task 1.
- Produces:
  - `export const PHASES = ['groom', 'execute']` — exported because Task 3 validates against the same list and a second copy would drift.
  - `startItem(backlog, id, stamp = nowISO(), phase = undefined)` — appends the third and fourth parameters, so every existing positional caller and test keeps working.

**Behaviour:**
- With a valid `phase`, write `phase: <value>` alongside `started:`.
- With `phase` undefined, write no `phase` key at all. Older callers keep working and `stop` simply bills nothing for them.
- With an unrecognised `phase`, throw `BacklogError` with exit code 1, before writing anything. The message must name both accepted values — a bare "invalid phase" makes the caller guess.
- The existing refusals are unchanged: done, out-of-scope, and already-started still fail with their current messages.

**CLI:** `start <id> [--as groom|execute]`. `stop` accepts no `--as` — it reads the phase off the file, and a flag there could contradict what is stored. Update `START_STOP_USAGE` to show the flag on the `start` line only.

- [ ] **Step 1: Write the failing tests**

| Case | Command | Expected |
|---|---|---|
| phase written | `start bug-1 --as groom` | exit 0; frontmatter has `started:` and `phase: groom` |
| execute too | `start bug-1 --as execute` | `phase: execute` |
| no flag, no key | `start bug-1` | exit 0; `started:` present; **no** `phase` key anywhere in the fence |
| unknown value refused | `start bug-1 --as reviewing` | exit 1; stderr contains both `groom` and `execute`; the file is byte-for-byte unchanged (no `started:`, no `updated:`) |
| missing value refused | `start bug-1 --as` | exit 1; stderr is the usage text |
| stop rejects the flag | `stop bug-1 --as groom` | exit 1; stderr is the usage text; the file is unchanged |
| double start still refused | `start bug-1 --as groom` twice | second exits 1 with the existing "already in progress (started …)" message naming the stored value |
| usage text | `start` with no id | stderr shows `--as` on the start line and not on the stop line |

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
pnpm run test:skills
```

- [ ] **Step 3: Implement**

Add `PHASES`, extend `startItem`, and parse `--as` in the shared CLI block. Note in a comment why `stop` refuses the flag rather than ignoring it.

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
pnpm run test:skills
```

- [ ] **Step 5: Commit**

`feat(backlog): record which activity holds the in-progress marker`. The body should say why `phase:` is not a status and does not weaken the `status:` ban.

---

### Task 3: `stop` bills elapsed seconds into the two buckets

**Files:**
- Modify: `skills/backlog/tools/backlog.mjs:639` (`stopItem`), `:134` (`README_TEXT`)
- Test: `skills/backlog/tools/backlog.test.mjs`

**Interfaces:**
- Consumes: `PHASES` and the `phase:` key from Task 2; `writeItemFile`'s stamp from Task 1.
- Produces: `stopItem(backlog, id, now = Date.now())` — the third parameter is new, so tests can pin the clock.

**Behaviour, exactly:**

1. Read `phase:` and `started:`.
2. Bill only when `phase` is one of `PHASES` **and** `started` is a full timestamp matching `YYYY-MM-DDTHH:MM:SSZ`. A bare `YYYY-MM-DD` is never billed — UTC midnight is not the hour anyone began work — but is still cleared.
3. Seconds are `Math.max(0, Math.floor((now - Date.parse(started)) / 1000))`. The floor at zero covers clock skew between the machine that stamped and the machine that stops.
4. The target key is `groom-elapsed` for `phase: groom`, `execute-elapsed` for `phase: execute`. The existing value is read as an integer; a missing key counts as 0.
5. An existing bucket value that is not a string of digits is a **refusal**, not a silent reset: throw `BacklogError` code 1 naming the key and the bad value, and write nothing. Overwriting it would destroy a number nobody can recover.
6. Remove `started:` and `phase:` together. Stamp `updated:` (Task 1 does this).
7. The existing "not in progress" refusal for an item with no `started:` is unchanged.

**Also:** extend `README_TEXT` so a newly initialised store documents the new keys. The existing paragraph explains `started:` and the `status:` ban; add the phase and the two buckets to it, in the same voice.

- [ ] **Step 1: Write the failing tests**

All with a pinned `now`. Let `T0 = 2026-08-30T10:00:00Z`.

| Case | Frontmatter before | `now` | Expected after |
|---|---|---|---|
| first groom session | `started: T0`, `phase: groom` | `10:01:30Z` | `groom-elapsed: 90`; no `started`; no `phase` |
| accumulates | `started: T0`, `phase: groom`, `groom-elapsed: 90` | `10:00:30Z` | `groom-elapsed: 120` |
| execute is a separate bucket | `started: T0`, `phase: execute`, `groom-elapsed: 90` | `10:00:10Z` | `execute-elapsed: 10` **and** `groom-elapsed: 90` untouched |
| no phase, no bill | `started: T0` | `10:05:00Z` | no bucket key created; `started` cleared; `updated` stamped |
| legacy bare date | `started: 2026-08-30`, `phase: groom` | `10:05:00Z` | no bucket key created; `started` cleared; `updated` stamped |
| clock skew | `started: T0`, `phase: groom` | `09:59:00Z` | `groom-elapsed: 0`, never a negative |
| sub-second | `started: T0`, `phase: groom` | `10:00:00Z` | `groom-elapsed: 0` |
| corrupt bucket refused | `started: T0`, `phase: groom`, `groom-elapsed: abc` | `10:01:00Z` | exit 1; stderr names `groom-elapsed` and `abc`; file byte-for-byte unchanged |
| negative bucket refused | `started: T0`, `phase: groom`, `groom-elapsed: -5` | `10:01:00Z` | exit 1; file unchanged |
| phase always removed | `started: T0`, `phase: execute` | any | no `phase` key remains |
| not in progress | no `started` | any | exit 1 with the existing message; file unchanged |
| round trip | `started: T0`, `phase: groom`, `from: idea-3`, body with a `---` line | `10:01:00Z` | `from:` present and unchanged; body byte-for-byte identical |

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
pnpm run test:skills
```

- [ ] **Step 3: Implement**

Extend `stopItem` and `README_TEXT`. Comment why a corrupt bucket refuses rather than resets.

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
pnpm run test:skills
```

- [ ] **Step 5: Commit**

`feat(backlog): bill groom and execute time into separate buckets on stop`.

---

### Task 4: the server surfaces the four values

**Files:**
- Modify: `shared/types.ts` (`BacklogItem`), `server/src/items/scan.util.ts`
- Test: `test/items.test.ts`, `test/parse.test.ts`

**Interfaces:**
- Consumes: the four frontmatter keys from Tasks 1–3.
- Produces, on `BacklogItem`:
  - `updated: string` — verbatim, `''` when absent.
  - `phase: '' | 'groom' | 'execute'` — clamped; anything unrecognised becomes `''`.
  - `groomElapsed: number` — whole seconds, `0` when absent or unparseable.
  - `executeElapsed: number` — same.

Frontmatter keys stay kebab (`groom-elapsed`); the TypeScript fields are camel, matching `projectPath` and the rest of the interface. The mapping happens in the scan, in one place.

**Clamp rather than reject.** A hand-edited `phase: wat` must not 500 the board or drop the item from the index — it renders as a generic in-progress bar. Same for a junk elapsed value: `0`, not a crash. This mirrors how the existing code treats a missing `created`: still renderable.

Accept only a string of digits for the elapsed values. `-5`, `1.5`, `1e3`, `abc`, and `''` all map to `0`. (The CLI refuses to *write* a bad value; this is about what a hand-edited file does to the reader.)

- [ ] **Step 1: Write the failing tests**

| Fixture frontmatter | Expected on the item |
|---|---|
| `phase: groom` | `phase: 'groom'` |
| `phase: execute` | `phase: 'execute'` |
| `phase: wat` | `phase: ''` |
| no `phase` key | `phase: ''` |
| `updated: 2026-08-30T12:00:00Z` | `updated: '2026-08-30T12:00:00Z'` |
| no `updated` key | `updated: ''` |
| `groom-elapsed: 90` | `groomElapsed: 90` |
| `groom-elapsed: -5` | `groomElapsed: 0` |
| `groom-elapsed: 1.5` | `groomElapsed: 0` |
| `groom-elapsed: abc` | `groomElapsed: 0` |
| neither bucket key | both `0` |
| `execute-elapsed: 7` only | `executeElapsed: 7`, `groomElapsed: 0` |

Plus: an item carrying every new key still parses, still reports its section and status from the directory, and `errors` stays empty.

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
pnpm test
```

- [ ] **Step 3: Implement**

Extend the interface with doc comments in the file's existing register — say what each field is and, for `phase`, why it is clamped instead of validated.

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
pnpm test && pnpm run typecheck
```

- [ ] **Step 5: Commit**

`feat(items): surface phase, updated, and the elapsed buckets`.

---

### Task 5: the client says which activity, and shows the accumulated time

**Files:**
- Modify: `client/src/lib/item-progress.ts`, `client/src/lib/item-age.ts`, `client/src/components/board/ItemCard.tsx:70` (the live bar), `client/src/components/board/ItemDrawer.tsx`
- Test: `test/item-progress.test.ts`, `test/item-age.test.ts`, `test/board.test.tsx`, `test/drawer.test.tsx`

**Interfaces:**
- Consumes: `BacklogItem.phase`, `.groomElapsed`, `.executeElapsed` from Task 4.
- Produces:
  - `progressLabel(item: BacklogItem): string` in `item-progress.ts` — `'grooming'`, `'executing'`, or `'in progress'`.
  - `formatSeconds(total: number): string` in `item-age.ts`.

**`formatSeconds`, exactly:**

| Input | Output |
|---|---|
| `0` | `0s` |
| `1` | `1s` |
| `59` | `59s` |
| `60` | `1m` |
| `90` | `1m` |
| `3599` | `59m` |
| `3600` | `1h` |
| `3660` | `1h 1m` |
| `7860` | `2h 11m` |
| `86400` | `24h` |

Minutes and hours floor; the ` 0m` half is omitted when it would be zero. Days are deliberately not a unit — an item with 24h of billed work is worth reading as 24h.

**Live bar:** `ItemCard`'s bar currently reads `in progress`. It reads `progressLabel(item)` instead. The `title` attribute keeps naming the stored `started` value. Nothing else about the bar changes — same amber, same placement, same `elapsed` marker beside it.

**Drawer:** when either bucket is above zero, show them. On any item, done ones included — the accumulated time is history and the drawer is where history belongs. Label them `groomed for` and `worked for`; show only the buckets that are non-zero, and nothing at all when both are.

- [ ] **Step 1: Write the failing tests**

`progressLabel`:

| Item | Expected |
|---|---|
| open, `started` set, `phase: 'groom'` | `grooming` |
| open, `started` set, `phase: 'execute'` | `executing` |
| open, `started` set, `phase: ''` | `in progress` |
| done, `started` set, `phase: 'groom'` | `in progress` — the label is only ever rendered behind `isInProgress`, and it must not claim live grooming for an archived item |

`formatSeconds`: the ten rows above, verbatim.

Board (`board.test.tsx`): a live card whose item has `phase: 'groom'` renders the text `grooming`; one with no phase renders `in progress`.

Drawer (`drawer.test.tsx`): an item with `groomElapsed: 3660` and `executeElapsed: 0` shows `groomed for` and `1h 1m` and does **not** show `worked for`; an item with both zero shows neither; a **done** item with `executeElapsed: 90` still shows `worked for 1m`.

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
pnpm test
```

- [ ] **Step 3: Implement**

Follow `item-age.ts`'s existing shape: pure functions, null or a safe default rather than `NaN` leaking into the DOM.

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
pnpm test && pnpm run typecheck
```

- [ ] **Step 5: Commit**

`feat(board): name the activity on the live bar and show accumulated time`.

---

### Task 6: skills, invariants, and the publishing step

**Files:**
- Modify: `skills/backlog-groom/SKILL.md` (lines 75, 144, 145, 211, 239, 284, 316), `skills/backlog-execute/SKILL.md`, `CLAUDE.md`, `docs/invariants.md`

**Interfaces:**
- Consumes: the `--as` flag from Task 2.
- Produces: nothing code-facing. This is the task that makes the feature actually reach an installed plugin.

**Prose changes:** every `start <id>` in `backlog-groom` becomes `start <id> --as groom`; every one in `backlog-execute` becomes `--as execute`. `stop <id>` is unchanged everywhere — it takes no flag. Check both files for `start` in running prose as well as in fenced commands; a command block updated while the sentence above it still describes the old form is worse than neither.

**Invariant text.** `CLAUDE.md` currently says **"`started:` is the one lifecycle key allowed in frontmatter, and it is not a status"**. That is no longer true as written. Rewrite it, and the matching passage in `docs/invariants.md`, to cover the new keys: `started:` and `phase:` exist only while work is live and are removed together; `updated:` is stamped by every `start`/`stop`; `groom-elapsed:` and `execute-elapsed:` accumulate and are permanent. The `status:` ban is unaffected and should be restated as still standing.

- [ ] **Step 1: Update the two SKILL.md files**

- [ ] **Step 2: Verify no stale invocation survives**

```bash
grep -rn "backlog.mjs start" skills/
```

Expect every hit to carry an `--as` flag.

- [ ] **Step 3: Update CLAUDE.md and docs/invariants.md**

- [ ] **Step 4: Full green before publishing**

```bash
pnpm test && pnpm run test:skills && pnpm run typecheck
```

- [ ] **Step 5: Commit, then publish**

`docs(skills): pass --as on every start, and revise the frontmatter invariant`.

Editing `skills/` changes nothing until it is committed, pushed, and synced. After the branch is merged:

```bash
pnpm run plugin:sync
```

The sync refuses dirty, unpushed, or behind states by design — if it refuses, the fix is to finish publishing, not to force it.

---

## Self-Review

**Spec coverage.** The spec's "Time and phase" section names five things: `start --as` (Task 2), `phase:` written and removed with `started:` (Tasks 2, 3), the two elapsed buckets in integer seconds (Task 3), `updated:` stamped by `writeItemFile` with `move` excluded (Task 1), and the client saying *grooming* rather than *in progress* (Task 5). Task 4 is the seam between them that the spec assumes rather than states. Task 6 covers the publishing boundary and the invariant text, which the spec does not mention and which would otherwise be forgotten — the feature would work locally and never reach an installed plugin.

**Not in scope, on purpose.** `finished:`, per-item tokens, prune, and the statistics view are all deferred by the spec and filed as separate backlog items. Nothing in this plan should grow toward them.

**Type consistency.** `PHASES` is defined once in Task 2 and consumed by Task 3. The frontmatter keys are kebab (`groom-elapsed`, `execute-elapsed`, `phase`, `updated`) everywhere on disk; the TypeScript fields are camel (`groomElapsed`, `executeElapsed`, `phase`, `updated`) everywhere in the app, mapped in exactly one place in Task 4. `progressLabel` and `formatSeconds` are named identically in their definitions (Task 5) and in their test tables.

**Ordering.** Tasks 1 → 2 → 3 are strictly sequential inside `backlog.mjs`. Task 4 depends on 3. Task 5 depends on 4. Task 6 depends on 2 and should be last, because it is the one that publishes.
