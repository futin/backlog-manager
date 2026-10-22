# Tick breaker implementation plan — review 1

Plan: `docs/superpowers/plans/2026-10-22-tick-breaker.md` (commit `14797b8`). Spec: `docs/superpowers/specs/2026-10-22-tick-breaker-design.md`.
Reviewer: Fable 5.1, fresh session, code read directly. Every file:line below was checked in the worktree at review time.

## Verdict: APPROVE WITH FIXES

No Critical finding. Built as written the plan ships the spec's behaviour; five Important gaps are in the tests and the harness, not in the design — each
is a place where an implementer would either guess or let a wrong implementation pass green.

## Checklist

1. **Coverage.** Every spec section maps to a task: Data → Tasks 1, 3; Reading when broken → Tasks 2, 4; The breaker + Where `decide` checks it + `status`
   → Tasks 1, 2; Server → Tasks 3, 4; Runs › Ticks → Tasks 5, 6; Settings card → Task 7; Skill → Task 2; Docs and rules → Task 8. Every spec test case
   (spec:209–227) has a task: node streak table → Task 1 (plan:68–80, a superset); `decide` cases → Task 2 (plan:103–113); `status` → Task 2 (plan:114–116);
   server streak table → Task 3; `GET`/`POST` cases → Task 4; jsdom cases → Tasks 6, 7. Two spec statements have no pinning test — see M9, M10.
2. **Values.** Halted reason (plan:32 = spec:109), unreadable reason (plan:27 = spec:67), `status` lines (plan:33–34 = spec:117–118), band/figure/sheet copy
   (plan:229–241 = spec:157–174), Settings copy (plan:265–266 = spec:184–188), headlines (plan:288–289 = spec:198–199) all match byte-for-byte where the spec
   gives a string. Plan:46/181 refines spec:141's "newest `at`" to "newest parseable `at`" — necessary (an unparseable one cannot be compared) and the plan's
   own rule (plan:8) says to flag it in the report; it is flagged here, nothing to change.
3. **Reality.** Every Create target is absent; every Modify target exists. Line anchors checked: `cmdDecide` 341 / `readState` call 389 / `cmdStatus` 694–715
   (plan:94 ✓), SKILL.md `idle`/`busy` bullet at line 46 (plan:95 ✓), `WatchdogStatus` at `shared/types.ts:2146` (plan:128 ✓), `app.module.ts:16` (plan:162
   ✓), `fetchWatchdog` at `client/src/lib/agents.ts:720` (plan:200 ✓), `runs-mode.ts:32–35` (plan:220 ✓), `SideRail.tsx:376–379` (plan:220 ✓),
   `RunsView.tsx:744` (plan:221 ✓), `.watchdog-table` at `styles.css:1986` (plan:223 ✓), `SharedPage` at `SettingsView.tsx:215–231` (plan:258 ✓),
   `SameOriginPostGuard` at `server/src/agents/origin.guard.ts:66` (plan:36 ✓), `listenLoopback` at `test/helpers/app.ts:38` (plan:163 ✓), ten files under
   `.claude/rules/` and "ten path-scoped files" at `CLAUDE.md:82` (plan:279 ✓), `.claude/rules/skills.md` `paths: ["skills/**", "agents/**"]` (plan:282 ✓),
   invariants.md tick-home section at line 191 (plan:280 ✓), `settings/` read-write mount at `docker-compose.yml:178`. No existing `/api/ticks` route or
   `ticks` symbol anywhere in `server/src`, `client/src` or `shared`. One name is slightly off — M1.
4. **Interfaces.** Task 2 consumes Task 1's `readTickSettings`/`streakOf` as spelled. Task 4 consumes Task 3's `TickFileUnreadable`, `readTickFile`,
   `writeTickFile`, `tickHome`, `tickFile` as spelled. Task 5 consumes Task 3's `TicksPayload`/`TickProject`/`TickRecentEntry`; Tasks 6–7 consume Task 5's
   `useTicks`, `sortTickProjects`, `tickActivity`, `ticksLast24h` as spelled. `TickProject.recent` is newest-first on both the producer (plan:139) and the
   consumer (`recent[0].at`, plan:201). The two readers' `ok: false` shapes differ between copies (M6) — deliberate separation, no consumer crosses it.
5. **Order.** No task consumes a later task's output. Task 8's new `.claude/rules/tick.md` glob `server/src/tick/**` must match a *tracked* file
   (`test/claude-rules.test.ts:310–317`); Task 4 commits those files first, so the order holds.
6. **Tests.** Review Focus 1–5 each have a named test (plan:176, 151, 181–182, 244–245, 246/269). Two-key discrimination is present for the file writer
   (plan:150) and the GET (plan:171) but missing for Reset and for `decide`'s `resetAt[root]` lookup — I3. One "kept" assertion has no discriminating fixture
   value — I5. Two existing assertions go red and the plan does not say so — I2. The node harness leaks a fifth outside-the-repo input — I1.
7. **Conventions.** No literal code anywhere; signatures, values and cases only. Size notes soft (plan:8). 160-column wrap followed.

## Important

- **[I1] plan:102, 117** — Task 2 says to use "a temp `BM_TICK_FILE`", but the `tick()` harness (`skills/backlog-tick/tools/tick.test.mjs:87–97`) spreads
  `process.env` and pins exactly four outside inputs (`BM_TICK_HOME`, `BM_ORCH_HOME`, `BM_API_PORT`, `PATH` — its header at lines 3–5 says so). After Task 2,
  every one of the ~40 existing cases reads the developer's real `~/.backlog-manager/settings/tick.json`: a real `haltAfter: 1` or an unreadable real file
  turns existing `execute`/`groom` cases `idle`. → State in Step 1 that the harness pins `BM_TICK_FILE` to a per-fixture path under `fx.base` for EVERY case
  (absent by default; a case that wants a file writes it there), and that the harness header's "four things" becomes five.
- **[I2] plan:224, 247** — "extend `test/runs-mode.test.ts` and `test/rail.test.tsx`" undersells it: `test/runs-mode.test.ts:24` asserts
  `RUNS_MODES` `toEqual(['runs', 'watchdog'])` and `test/rail.test.tsx:101–108` asserts the Runs tree's labels `toEqual(['History', 'Watchdog'])`. Both go
  red the moment `'ticks'` is added, so Step 4's "expect PASS" is unreachable without editing them. → Name the two assertions and their new expected values
  (`['runs', 'watchdog', 'ticks']`, `['History', 'Watchdog', 'Ticks']`) in Step 1, so the change is deliberate rather than discovered.
- **[I3] plan:108, 180–182** — per-project logic is exercised with one key. `decide`'s test (plan:108) has `resetAt[root]` later than every record → not
  halted, but no case where `resetAt` holds a LATER time under a *different* root and this project stays halted — an implementation that reads any/the first
  `resetAt` value passes. The Reset test (plan:180–182) asserts A's `streak: 0` but not that B's `streak`, `haltedSince` and `resetAt` are unchanged in the same
  answer — a writer that stamps every key, or a service that zeroes every row, passes. → Add both: a foreign-root `resetAt` in Task 2 (still halted) and a B
  assertion after resetting A in Task 4.
- **[I4] plan:180–182** — spec:142 says Reset "is allowed in every state", and the clock guard reads the project's newest `at` from `state.json`. The plan
  gives no behaviour for a Reset on a directory whose `state.json` is unreadable (the GET lists it with `error`, plan:175) or absent (plan:174): a service
  that reuses a throwing reader answers 500. → State that the newest-`at` read treats an unreadable or absent `state.json` as "no records" (stamp now), and
  add the case: reset a dir with a not-JSON `state.json` → 200, `resetAt[root]` ≈ now, the row still carries `error`.
- **[I5] plan:178, 181** — "keeps the old `resetAt`" (config POST) and "`haltAfter` kept" (reset) have no stated fixture values. With the default `haltAfter`
  3, a `writeTickFile` that drops `haltAfter` is indistinguishable from one that keeps it (absent reads as 3, plan:63). → Give the fixtures discriminating
  values: `haltAfter: 5` plus a two-key `resetAt` before the POSTs, and assert both survive byte-for-byte on the keys not written.

## Minor

- **[M1] plan:251** — `use-runs-mode` names `test/use-runs-mode.test.ts`-style; the file is `test/use-runs-mode.test.tsx`. The jest filter matches either,
  nothing breaks; note only.
- **[M2] plan:250** — "cites the DESIGN.md subsections `WatchdogMonitor.tsx` cites": that file cites §8.4.2 (`WatchdogMonitor.tsx:70, 77, 300, 433`), the
  Watchdog page's own subsection; `.claude/DESIGN.md:278–368` has §8.4.1 History, §8.4.2 Watchdog, §8.4.3 The stage track and no Ticks entry. Spec:177
  sanctions following the Watchdog page, so this is consistent with the spec, but CLAUDE.md's "every component must cite ITS subsection" reads awkwardly for
  a page citing a sibling's. A one-paragraph §8.4.4 (or a line under §8.4 saying Ticks follows §8.4.2) would make the citation true; Task 8 is the place.
- **[M3] plan:227** — the Consumes list omits `Pill` (`client/src/components/ui/Pill.tsx`), which the `halted`/`ticking` pills (plan:235–236) need, and
  `Ledger`, which `WatchdogMonitor.tsx:12, 502` wraps its table in. Harmless, but the list claims to be the parts inventory.
- **[M4] plan:263** — `saveErrorSlot` is typed `(field: keyof WatchdogConfig | null)` (`WatchdogGroup.tsx:160`); it is not reusable for a `haltAfter` field.
  "Its `saveErrorSlot` pattern" is right; say "a one-field local equivalent" so nobody tries to import it.
- **[M5] plan:270** — `test/settings-view.test.tsx` stubs `fetch` for the Shared page's existing reads (its lines 29–40, 133); `TickGroup` adds a
  `GET /api/ticks` on mount that the stub does not answer. The "renders only the host-backed cards on Shared" case (`settings-view.test.tsx:214–220`) still
  passes on titles, but the unanswered fetch surfaces as an `act()`/unhandled-rejection warning. Say the stub gains a `/api/ticks` answer.
- **[M6] plan:62 vs 144** — Task 1's failure shape is `{ ok: false, file, error }`, Task 3's `{ ok: false; error }`. Task 4 needs the file name for the 409
  message (plan:185) and `config.error` (plan:177); `tickFile()` gives it, so nothing is blocked. Either align the shapes or say the controller calls
  `tickFile()` for the message.
- **[M7] plan:110** — "a held fresh lock and streak 3 → `busy`" passes before Task 2 is implemented (today's order already answers `busy` at
  `tick.mjs:367`). Fine as an order pin; it just is not one of the cases Step 2 expects to FAIL.
- **[M8] plan:46, 181** — the "newest parseable `at`" refinement of spec:141 (see Checklist 2) — the spec wins per plan:8, but here the refinement is the
  only implementable reading; the implementer's report should say so, as the plan asks.
- **[M9] spec:14 / plan:103–116** — no Task 2 case with a TRACKER project at streak ≥ N and the stack down → `idle` `stack down` (not `halted`). The order
  is already pinned by the existing tracker cases at `tick.test.mjs:346+` and the plan's Step 3 placement, so this is a nice-to-have pin.
- **[M10] spec:143 / plan:180–182** — "touches no lock": no Task 4 case asserts the `lock` file is byte-identical after a Reset on a dir holding one.
  One `readFileSync` before/after would pin it.
- **[M11] plan:174** — the stored lock also carries `base` (`tick-state.mjs:44`; `tick.mjs:436`); the GET's `{ kind, id, host, at }` drops it on purpose
  (spec:130). Worth one clause in Task 4 so the omission is not read as an oversight.
- **[M12] plan:94** — anchors are accurate today (`cmdDecide` 341, `readState` 389, `cmdStatus` 694–715); the "~" hedge is appropriate since Task 2 itself
  moves them.

## What I checked and found sound (no finding)

- The streak rule (plan:29) matches spec:74–77 clause by clause, including "unparseable `at` is tested first, whatever the outcome" and "other outcomes
  neither count nor stop". The table at plan:68–80 is a strict superset of spec:211–213 (adds the at-or-before equality case and the `resetAt: "garbage"`
  case).
- `clampHaltAfter` (plan:64) is the `clampAttempts` rule at `server/src/orchestrator/watchdog-config.util.ts:110–113` (non-integer → default, else clamp),
  as spec:52 asks; the POST's 400 for a non-integer (plan:23, 178) is the spec's own stricter body rule (spec:138).
- `jira.json`'s 409 posture (spec:48) is real: `server/src/jira/jira-write.controller.ts:124, 204`.
- tmp + rename is the repo's write shape (`watchdog-config.util.ts:245–247`); the no-`.tmp`-left test (plan:151) pins the half of Review Focus 2 a test can
  reach.
- The `recover`-then-halt sequence (plan:111) is reachable with the existing fixtures: `recover` records `failed` through `recordOutcome` (`tick.mjs:614`)
  and the stale-lock cases at `tick.test.mjs:695–760` already drive it on a files project.
- `useCoalescedFetch(task, { armed, intervalMs })` (`client/src/hooks/useCoalescedFetch.ts:23`) takes exactly the two options plan:206 names;
  `useWatchdog({ live })` (`useWatchdog.ts:107`) is the `live: false` precedent plan:206 and spec:187 cite.
- `SettingsGroup`'s `scope="this machine"` is what Trackers and Claude Agents use (`TrackersGroup.tsx:76`, `SettingsView.tsx:462`), as plan:265 and
  spec:184 say.
- `RAIL_SUB_LABEL: Record<RunsMode, string>` (`SideRail.tsx:376`) makes the `ticks: 'Ticks'` entry a type error if forgotten — the plan's Task 6 file list is
  complete for the type change (no other exhaustive `Record<RunsMode, …>` exists in `client/src`).
- Server reads of the tick home per request mirror `orchHome()` (`server/src/orchestrator/orchestrator.service.ts:24`), as spec:127 asks; no server code
  path writes under it in the plan.
