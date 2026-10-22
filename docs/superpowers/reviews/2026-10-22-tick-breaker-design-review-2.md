# Review 2 — `docs/superpowers/specs/2026-10-22-tick-breaker-design.md`

Date: 2026-10-22. Reviewer: fresh subagent (Fable), checklist review, read-only. Doc lines cite the committed spec at `6ed2418` (249 lines). Round 1's report is
`2026-10-22-tick-breaker-design-review-1.md`; its findings are re-reported below only where the fix is wrong or incomplete (none are).

## Verdict: APPROVE WITH FIXES

Every round-1 Critical and Important landed as suggested (C-1 → doc:67–70; I-1 → doc:201–203; I-2 → doc:141–143; I-3 → doc:140, doc:224; I-4 → doc:74–77,
doc:211; I-5 → doc:171; I-6 → doc:163), and so did every Minor except M-11 (the `AppModule` import — builder detail, fine to leave). One new Important: the
band chip the Ticks page is told to copy from the Watchdog page does not do what the spec says it does. The rest is wording and edge cases an implementer
would most likely get right anyway.

## Critical

None.

## Important

- **I-1 — doc:156.** "Right: 'Policy in Settings ›' chip, opening Shared Settings (the Watchdog page's own chip and route)." The Watchdog page's chip is
  `variant="flat"` and INERT — its own comment says so: "Flat and inert: `SettingsView` has no section setter to plumb through for one chip, and the rail is one
  click away" (`client/src/components/runs/WatchdogMonitor.tsx:211–216`). There is no route behind it; the only Settings↔Runs link that exists runs the OTHER
  way (`WatchdogGroup.tsx:262`, `onOpenWatchdog`). An implementer copying "the Watchdog page's own chip" ships a chip that opens nothing, contradicting the
  sentence; one building what the sentence says has to add a section setter through `RunsView` that the spec never mentions and the jsdom list (doc:225–226)
  never tests. → Pick one and say it: either "the same flat, inert chip, `title="Settings › Backlog tick"`" (matches the Watchdog page and needs no plumbing), or
  state that a setter is threaded down to the Ticks page and add the click to the jsdom tests.

## Minor

- **M-1 — doc:39, doc:101–102.** "that call records `failed` and answers `recover`" is true only for a lock with a usable verdict. A stale lock whose verdict is
  unreadable is removed with NO record (`tick.mjs:593–599`, reason `removed an unreadable lock`). doc:89 is right as written; doc:39's "including the … record
  `recover` writes for a stale lock" and doc:101's parenthesis overstate it. One clause: "records `failed` when the lock named a unit".
- **M-2 — doc:132.** "`recent`: the file's `recent`, newest first, unchanged" — the file is oldest-first (`recordOutcome` pushes, `tick-state.mjs:210`; `status`
  reverses it, `tick.mjs:701`), so the GET reverses it too. "unchanged" and "newest first" cannot both hold; say "reversed to newest first, entries unchanged".
- **M-3 — doc:74–77.** The walk rule names three entry kinds but not their precedence: an entry with `outcome: "skipped"` AND `at: "garbage"` — does the
  unparseable `at` stop the walk, or does the unknown outcome skip it? The shared table (doc:210–212) has no such row, so the two copies can diverge on it.
  Say "the `at` test comes first" (safe direction: stop) and add the row.
- **M-4 — doc:117.** `breaker: HALTED — 3 of 3 failures in a row` reads wrong once the streak passes N: "5 of 3 failures in a row". The verdict reason at doc:109
  already has the right shape — `5 failures in a row (halt after 3)`; reuse it.
- **M-5 — doc:127.** "whose name decodes to an absolute path" — `decodeURIComponent` THROWS on a malformed name (`%E0%A4%A`), and one stray directory under the
  tick home would then 500 the whole `GET` and blank every project. Say a name that does not decode is skipped (try/catch), not that it "does not decode".
- **M-6 — doc:138.** "Clamped" for the POST body — under the doc:52 rule a `{}` body or `haltAfter: "7"` silently writes 3. The Select never sends that, but the
  route is reachable by hand; either say the doc:52 rule applies to the body too or answer `400` for a non-integer `haltAfter`.
- **M-7 — doc:67, doc:110.** The `decide` reason `tick.json unreadable — fix or remove it by hand` names no path, while the `409` message (doc:49) and `readState`'s
  own throw (`tick-state.mjs:192`) both name the file. Print the path.
- **M-8 — doc:171.** The empty state is "one sheet" — are the band's sub-line and the three figures still drawn? If not, an unreadable `tick.json` (which halts
  every project, doc:69) is invisible on a Ticks page with no history yet; only the Settings card says so. Say the figures stay, or put the unreadable line in
  the empty-state sheet.
- **M-9 — doc:14.** "The breaker works with the stack down: `decide` reads files only" — true for a files project; a tracker project answers `idle: stack down`
  at step 2 before the breaker is reached (`tick.mjs:361`), so nothing runs either way, but the breaker is not what stopped it. One qualifier.
- **M-10 — doc:111.** "a halted tick spends one tool call and no session" — the TICK session the scheduler spawned is still spent; what it saves is the
  execute/groom session. Say "no execute or groom session".
- **M-11 — doc:92, doc:141.** `resetAt` is stamped by the server's clock (inside the container, in the compose stack) and `at` by `tick.mjs` on the host. On
  Docker Desktop the VM clock can lag the host after a sleep until it resyncs; a `resetAt` a few minutes behind would leave the newest failure "after" the reset
  and the streak uncleared until the next Reset. Worth one sentence (or stamp `resetAt` no earlier than the newest `at` on file for that project).
- **M-12 — doc:160.** "last 24 h … counted from every project's `recent`" is bounded by the 50-entry cap per project; at hourly ticks that is 2 days, so it holds,
  but a project ticking more often than every ~29 minutes would undercount. A parenthesis.
- **M-13 — doc:183.** `SharedPage` is laid out as "three cards" with the Watchdog card alone in the left column (`SettingsView.tsx:208–231`); "after the Watchdog
  group" lands the new card under it in that column, which is fine, but the header comment counts cards and will need the word changed. Builder detail.
- **M-14 — doc:163.** "halted first, then by last tick newest first" — say the second key also orders the halted rows among themselves (it reads that way, but the
  sentence can be parsed as two unordered groups).

## Checked and true

- doc:11, doc:79 streak ≥ N and "last N all `failed`" agree. doc:210–212 table recomputed under doc:74–77: `[failed, failed(at:"garbage"), failed]` → 1 (newest
  counts, garbage stops); `[failed, failed(outcome:"skipped"), failed]` → 2 (skipped neither counts nor stops); `resetAt` between 1st and 2nd → 2; all correct.
- doc:36–39 path, shape, `RECENT_MAX = 50`, `recordOutcome` entry fields (`tick-state.mjs:17,207–213`); `recover`'s `killed at timeout` record (`tick.mjs:614`).
- doc:48 `jira.json`: a parsed non-object is NOT unreadable there (`config.util.ts:40`), so "stricter" is right; `409` from both writers (`jira-write.controller.ts:124,204`).
- doc:50 `settings/` is the rw mount under a `:ro` `~/.backlog-manager` (`docker-compose.yml:166,178`); `orchestrator-control/` is per project under it
  (`pause-control.util.ts:91`). doc:145 holds.
- doc:52 `clampAttempts`: non-number / non-integer → default, else clamped (`watchdog-config.util.ts:110–113`). doc:55 `BM_WATCHDOG_FILE` / `BM_JIRA_FILE`
  (`watchdog-config.util.ts:65`, `config.util.ts:53`). doc:137 read fresh, never cached (`watchdog-config.util.ts:33–38`).
- doc:82 `orchHome()` and `pauseRequestEffective` each live in `orchestrate.mjs` (`:267`, `:365`) and the server (`orchestrator.service.ts:23`,
  `pause-control.util.ts:162`).
- doc:93 `forget` drops `items[id]` only (`tick-state.mjs:216–222`). doc:98, doc:105 step order and `readState` after the busy check (`tick.mjs:359–389`).
  doc:113 `--dry-run` takes nothing (`tick.mjs:433`). doc:110 `idle` → no `record`, reason is the final message (`SKILL.md:47`). doc:118 `status --json` is
  `{lock, recent}` (`tick.mjs:703`); the lock carries `host` (`tick-state.mjs:44`, `tick.mjs:709`).
- doc:127 `BM_TICK_HOME` (`tick-lib.mjs:18–20`); `BM_ORCH_HOME` read per call (`orchestrator.service.ts:24`). doc:129 registry entries carry `name` and `path`
  (`registry.service.ts:62`). doc:138 `SameOriginPostGuard` is already imported outside `agents/` (`tracker.controller.ts`, `jira-write.controller.ts`,
  `items.controller.ts`).
- doc:150 `RunsMode = 'runs' | 'watchdog'`, declaration order is render order, labels in `RAIL_SUB_LABEL` (`runs-mode.ts:32–35`, `SideRail.tsx:376–378`).
  doc:152–153 `Band`, `FigureStrip cols={3}`, `Sheet`, `watchdog-table` / `watchdog-kind-{done,bad}` (`WatchdogMonitor.tsx:164,224`, `Figure.tsx:39`,
  `styles.css:1986,2013–2014`); `Figure` has tone `bad` (`Figure.tsx:4`). doc:154 `WATCHDOG_POLL_MS = 5_000`, `WATCHDOG_IDLE_POLL_MS = 15_000`
  (`useWatchdog.ts:25,35`); `useCoalescedFetch({ armed, intervalMs })` (`useCoalescedFetch.ts:23`).
- doc:172–173 the Watchdog sentence's shape (`WatchdogMonitor.tsx:168`). doc:183 `this machine` on Trackers and Claude Agents (`TrackersGroup.tsx:76`,
  `SettingsView.tsx:462`); doc:184–186 `WatchdogGroup` uses `Select`, `saveErrorSlot`, `useWatchdog({ live: false })` (`WatchdogGroup.tsx:160,191,286`).
- doc:201–203 no rules file covers `server/src/tick/` today (`.claude/rules/*.md:2`); `skills.md:19–26` already holds the `tick/` writer rule; the test wants one
  home per anchor, every glob matching a tracked file, every cited anchor resolving to an invariants.md heading (`test/claude-rules.test.ts:292,310,340`);
  CLAUDE.md:82 says "ten path-scoped files" and no test pins the number. CLAUDE.md:47 "the ONLY three" outbound modules — doc:123's "not an outbound-calling
  module" is the right note for the Layout line, as `releases/` has.
- doc:208, doc:218 test placement: `skills/*/tools/*.test.mjs` (`package.json:18`) and `<rootDir>/test/**/*.test.ts(x)` (`jest.config.ts:11`).
- doc:19 `claude-agents-dashboard/server/lib/usage.ts` exists. doc:3 spec `2026-10-22-backlog-tick-design.md` exists.
- Hard rules touched: the server only reads `~/.backlog-manager/tick/` (CLAUDE.md "exactly one writer, `tick.mjs`"); the new POSTs carry the agents guard;
  both routes under `/api`; the Ticks page is switched by the rail tree only; the halt is derived, never stored. No conflict found.
