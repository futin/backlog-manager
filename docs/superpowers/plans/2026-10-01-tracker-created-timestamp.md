# Tracker `created` carries the full timestamp — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Override of the writing-plans template, on purpose:** this plan specifies behaviour, signatures and exact test cases — never literal code. Handed code
> gets transcribed verbatim and a plan bug becomes a branch bug (`~/.claude/CLAUDE.md`, Learnings). The test cases are authoritative; disagree with the
> plan where the code says otherwise, and say so in the report.

**Goal:** A tracker item's `created` is GitHub's full `created_at` (`2026-10-01T21:43:23Z`), the same second-precision shape its `updated` and `started`
already carry, so "Newest first" orders same-day issues by time instead of falling back to API order (oldest issue number first).

**Architecture:** One server line stops truncating (`server/src/tracker/map-issue.ts:196`). Every reader of `created` then has to accept two shapes, because a
files item's `created` stays `YYYY-MM-DD` forever (`backlog.mjs new` is NOT changed — decided with the user, 2026-10-01). Two readers break on a timestamp
today and are fixed; the sort comparator already works and gains tests that pin it.

**Tech Stack:** NestJS server, React client (jest + jsdom), `skills/backlog/tools/backlog.mjs` (node --test).

**Spec:** none — the bug and the decision live in this session; this plan is the record. The defect: `client/src/components/board/BoardView.tsx:99` compares
`created` as a string, every same-day tracker item ties at `2026-10-01`, and `Array.prototype.sort` keeps the API order for ties.

## Global Constraints

- Tracker items only. `backlog.mjs new` keeps writing `YYYY-MM-DD`; no files item's frontmatter changes shape.
- Every DERIVED reading of `created` keeps its current value: the card's `oct 1`, `backlog.mjs board`'s `ageDays`. Only the raw value (the item modal's
  `created` fact, the API payload) and the sort gain precision.
- Calendar readings stay UTC (the locale/UTC rules in `client/src/lib/item-age.ts`'s comments): a timestamp formats as its UTC date, never local.
- New prose wraps at 160 columns; match the surrounding comment density (comments explain _why_).
- `skills/` edits change nothing live until commit → push → `pnpm run plugin:sync` (CLAUDE.md invariant).

## Review Focus

1. **A timestamp with a non-`Z` offset** (`2026-10-01T23:30:00-02:00`) — the card must print the UTC date (`oct 2`), not the string's date part. GitHub always
   sends `Z`, but `created` is typed `string` and the formatter must not split on `T` and trust the left half. Pinned in Task 1.
2. **One column mixing a tracker project and a files project on the same day** — lexicographic order puts `2026-10-01T08:00:00Z` above `2026-10-01` under
   Newest first. Acceptable, and pinned so nobody "fixes" it by accident. Pinned in Task 2.
3. **`ageDays` in a tracker project's `backlog.mjs board`** — today a timestamp makes `Date.parse` NaN: `--json` serialises `ageDays` as `null` and the text
   board prints `NaNd` (`backlog.mjs:2417`, `:2431`). Pinned in Task 4.
4. **Unparseable `created`** — formatter still passes it through verbatim, `ageDays` still does whatever it does today for garbage (not changed here).
   Pinned in Task 1.
5. **Project sort's secondary key** uses the same `created` comparison — same-day tracker items inside one project order newest first. Pinned in Task 2.

---

### Task 1: `formatCreated` accepts both shapes

**Files:**
- Modify: `client/src/lib/item-age.ts` (`formatCreated`, ~line 107, and its header comment)
- Test: `test/item-age.test.ts` (`describe('formatCreated')`, ~line 117)

**Interfaces:** Signature unchanged: `formatCreated(created: string, now?: number): string`.

**Behaviour:** A `YYYY-MM-DD` value parses exactly as today (UTC midnight). Anything else goes to `Date.parse` as-is. The output is built from the UTC
month/day/year of the parsed instant, so both shapes go through the same formatting path. Unparseable → returned verbatim; `''` → `''`. Reuse the file's
existing `DATE_ONLY` regex — do not add a second one.

- [ ] **Step 1: Write the failing tests** — add to `describe('formatCreated')`, each passing an explicit `now` the way the existing cases do:
  - `'2026-10-01T21:43:23Z'`, now in 2026 → `'oct 1'`
  - `'2026-12-31T23:59:59Z'`, now in 2027 → `"dec 31 '26"`
  - `'2026-10-01T23:30:00-02:00'`, now in 2026 → `'oct 2'` (UTC date, Review Focus 1)
  - `'2026-10-01T25:00:00Z'` → returned verbatim
  - existing date-only and verbatim cases stay green, unchanged
- [ ] **Step 2: Run** `pnpm exec jest --runInBand test/item-age.test.ts` — the timestamp cases FAIL (they come back verbatim today).
- [ ] **Step 3: Implement** the behaviour above; update the header comment to say `created` has two shapes and why (tracker vs files), in the style of the
  `DATE_ONLY` comment above it.
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** — `fix(board): format a timestamped created date`

### Task 2: Pin the sort over timestamped `created`

**Files:**
- Modify: `client/src/components/board/BoardView.tsx` (comment above `COMPARATORS`, ~line 84 — it says backlog.mjs writes fixed-width `YYYY-MM-DD`; that is
  no longer the whole truth)
- Test: `test/board.test.tsx` (the sort tests near line 638; reuse the per-test item fixture the comment at ~line 227 describes)

**Behaviour:** The comparator code is expected NOT to need changing: ISO-8601 `Z` timestamps sort lexicographically in chronological order, and a timestamp
sorts above the bare date of the same day. If a test below fails for a reason other than the comparator, stop and report — do not rewrite the comparator to
`Date.parse` without saying why.

Fixture dates must be relative to the clock (`daysAgoStamp` / `daysAgoDate` from `test/helpers/dates.ts`) — `test/fixture-clock.test.ts` rejects absolute
`created` literals in `test/*.test.tsx`. Two same-day stamps can be built from one `daysAgoStamp(1)` value by swapping its time-of-day part.

- [ ] **Step 1: Write the tests** under Newest first (the default sort):
  - two tracker bugs, same day, `T08:00:00Z` (#164) and `T21:00:00Z` (#170), API order #164 then #170 → column shows #170 first. This pins the fixed
    state; the red for the actual defect is Task 3's mapper test, since this fixture hands the board stamps directly
  - a tracker bug at `<day>T08:00:00Z` and a files bug at `<day>` in the same column → tracker bug first (Review Focus 2)
  - Project sort, two same-day tracker bugs in one project, API order oldest first → newest first (Review Focus 5)
- [ ] **Step 2: Run** `pnpm exec jest --runInBand test/board.test.tsx` — expected PASS already (the comparator is correct; the fixture is new). If any FAILS,
  report it before Task 3.
- [ ] **Step 3: Update the `COMPARATORS` comment**: two shapes now, why string comparison still orders them, and that a same-day files item sorts below a
  timestamped one.
- [ ] **Step 4: Commit** — `test(board): pin newest-first over timestamped created`

### Task 3: The mapper keeps `created_at` verbatim

**Files:**
- Modify: `server/src/tracker/map-issue.ts:192-196` (the field and its comment)
- Modify: `shared/types.ts:70` (`created`'s doc comment — "YYYY-MM-DD from frontmatter" becomes: a date for a files item, a second-precision UTC stamp for a
  tracker item, `''` when absent)
- Test: `test/tracker-map.test.ts` (fixture expectation at ~line 50; the case at ~line 219)

**Interfaces:** Produces: `BacklogItem.created` is `issue.created_at` verbatim for every tracker item. Tasks 1, 2 and 4 are its readers and land FIRST on
purpose: every reader accepts the new shape before the producer emits it, so no intermediate commit breaks the board.

- [ ] **Step 1: Change the tests first** — the case at ~219 is renamed to say both stamps are kept verbatim, and asserts `created` is
  `'2026-09-01T23:59:59Z'`; the expected item at ~50 becomes `'2026-09-01T10:11:12Z'`.
- [ ] **Step 2: Run** `pnpm exec jest --runInBand test/tracker-map.test.ts` — FAIL.
- [ ] **Step 3: Implement** — drop the `.slice(0, 10)`; rewrite the comment to say why the full stamp (the sort; the same shape as `updated`), and that the
  card's date and the CLI's `ageDays` derive from it.
- [ ] **Step 4: Run** `pnpm run test:jest` — PASS, apart from the two WSL supertest-bind cases if this runs on that kernel (known environmental red). Any
  other tracker suite asserting a date-only `created` gets updated to the stamp, and listed in the report.
- [ ] **Step 5: Commit** — `fix(tracker): keep an issue's full created_at`

### Task 4: `backlog.mjs board` ages a timestamped `created`

**Files:**
- Modify: `skills/backlog/tools/backlog.mjs` (`ageDaysSince`, ~line 2088)
- Test: `skills/backlog/tools/backlog.test.mjs` (beside `API mode: board reads /api/items once…`, ~line 3972)

**Behaviour:** `ageDaysSince` takes either shape. A date-only value behaves exactly as today. A timestamp is aged by its UTC calendar day, the same way a date
is: a stamp at 23:59Z yesterday is `1`, never `0`. Same convention as the client's `daysSince`, so the CLI and the board agree on which day an item was
created. Never NaN for a parseable stamp.

- [ ] **Step 1: Write the failing tests** — API mode, `board --json`, using `withApi` / `apiItem` / `trackerFixture` as the neighbouring tests do:
  - an item whose `created` is a full UTC stamp 7 days before now → `ageDays === 7`
  - an item created today at `<today UTC>T00:00:00Z` → `ageDays === 0` (midnight, not "now minus an hour", which crosses UTC midnight once a day)
  - an item created 7 days ago at `<that UTC date>T23:30:00-02:00` → `ageDays === 6`: the instant is 01:30Z the next day, so a `created.slice(0, 10)`
    implementation fails here (Global Constraints, UTC rule)
  - the text `board` (no `--json`) prints `7d` for the 7-days-ago `Z` item, not `NaNd`
  - the files-mode `ageDays` tests at ~449/461 stay green, unchanged
- [ ] **Step 2: Run** `node --test skills/backlog/tools/backlog.test.mjs` — the new cases FAIL (`ageDays` is `null`).
- [ ] **Step 3: Implement**, with a comment saying why two shapes reach this function (API mode carries the tracker stamp).
- [ ] **Step 4: Run** `pnpm test` (both runners) — PASS, same WSL caveat as Task 3.
- [ ] **Step 5: Commit** — `fix(backlog): age a timestamped created in API mode`

### Task 5: Docs and live check

**Files:**
- Modify: `docs/subsystems/invariants.md:1032` — "`created` is a `YYYY-MM-DD` date" is now true for files items only; qualify it (the fixture rule itself is
  unchanged: files fixtures still use `daysAgoDate`).
- Modify: `test/helpers/dates.ts:14-15` and `:26` — the comments say `created` is a date; qualify to "a files item's `created`" (the helpers themselves do
  not change).
- Modify: `docs/superpowers/specs/2026-09-17-tracker-backed-backlog-design.md:193` ("`created_at`, date part") — historical record: add a dated amendment
  line, do not rewrite the row.
- (Already checked in review, no action: `docs/subsystems/board.md:79` already says "stamps"; `.claude/rules/tracker.md` says nothing about `created`'s shape.)

- [ ] **Step 1: Edit the docs** above; run `pnpm exec jest --runInBand test/fixture-clock.test.ts` after touching `test/helpers/dates.ts`.
- [ ] **Step 2: Live check** — with the stack up (restart the api service so the mapper reloads), `curl -s localhost:4322/api/items` shows a tracker item's
  `created` as a full stamp; on the board, under Newest first and the default `open` status filter, claude-agents-dashboard's Ideas column shows #169
  above #165 above #164 (#170 is `done`, so it only shows under `All`), and the item modal's `created` fact shows the full stamp.
- [ ] **Step 3: Commit** — `docs: tracker created is a timestamp`
- [ ] **Step 4: Publish** — the `skills/` change needs push + `pnpm run plugin:sync`. Ask the user before pushing.
